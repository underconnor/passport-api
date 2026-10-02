import { HttpException } from '@nestjs/common';
import { createHash, createHmac } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { policyTransaction, serializable } from './database';
import { refreshDiscordSubject } from './discord-policy';
import { readGoogleSheet, RosterEntry, SheetsConfig, sheetsConfig, validateSnapshotChange } from './integrations/sheets';
import { observedOperation } from './observability';

const currentSnapshotId = 'current';
const defaultMaxAgeMs = 15 * 60 * 1000;
export type RosterSnapshotInput = { entries: RosterEntry[]; fetchedAt: Date; sourceKey: string };
export type RosterSyncOptions = { allowedServerIds: string[]; maxAgeMs?: number; expectedApprovalDigest?: string; authorize?: (tx: Prisma.TransactionClient) => Promise<void> };
export type RosterRisk = 'empty_roster' | 'mass_revocation' | 'source_changed';
export type RosterPreview = { digest: string; total: number; active: number; previousTotal: number; risks: RosterRisk[]; fetchedAt: string; expiresAt: string; databaseChanged: false };
export type RosterSyncSummary = Omit<RosterPreview, 'databaseChanged'> & { databaseChanged: true; updatedSubjects: number; changedPolicies: number };
export class RosterSyncError extends Error {
  constructor(readonly code: 'configuration_error' | 'read_failed' | 'invalid_snapshot' | 'stale_snapshot' | 'outdated_snapshot' | 'approval_required' | 'approval_mismatch' | 'sync_busy' | 'apply_failed', readonly preview?: RosterPreview) { super(code); }
}

function canonicalEntries(entries: RosterEntry[]) {
  return entries.map(entry => ({ studentKey: entry.studentKey, status: entry.status, roleLabel: entry.roleLabel, serverIds: [...entry.serverIds].sort() })).sort((a, b) => a.studentKey.localeCompare(b.studentKey));
}
export function rosterDigest(input: Pick<RosterSnapshotInput, 'entries' | 'sourceKey'>) {
  return createHash('sha256').update(JSON.stringify({ sourceKey: input.sourceKey, entries: canonicalEntries(input.entries) })).digest('hex');
}
export function rosterSourceKey(config: SheetsConfig) {
  const source = config.accessMode === 'service-account' ? [config.accessMode, config.spreadsheetId, config.range] : [config.accessMode, config.spreadsheetId, config.tab, config.studentColumn, config.academicStatusColumn, config.studentHeader, config.academicStatusHeader, [...config.activeAcademicStatuses].sort(), [...config.defaultServerIds].sort(), config.roleLabel];
  return createHmac('sha256', config.matchingSecret).update(JSON.stringify(source)).digest('hex');
}
function validateInput(input: RosterSnapshotInput, options: RosterSyncOptions, now: Date) {
  const maxAgeMs = options.maxAgeMs ?? defaultMaxAgeMs;
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 60000 || maxAgeMs > 86400000 || !/^[a-f0-9]{64}$/.test(input.sourceKey) || !Array.isArray(input.entries) || input.entries.length > 5000 || !Number.isFinite(input.fetchedAt.getTime())) throw new RosterSyncError('invalid_snapshot');
  const keys = new Set<string>();
  for (const entry of input.entries) {
    if (!/^[a-f0-9]{64}$/.test(entry.studentKey) || keys.has(entry.studentKey) || !['active', 'inactive', 'suspended'].includes(entry.status) || typeof entry.roleLabel !== 'string' || entry.roleLabel.length > 24 || /[\x00-\x1f<>§]/.test(entry.roleLabel) || !Array.isArray(entry.serverIds) || entry.serverIds.some(id => !options.allowedServerIds.includes(id)) || new Set(entry.serverIds).size !== entry.serverIds.length || (entry.status !== 'active' && entry.serverIds.length)) throw new RosterSyncError('invalid_snapshot');
    keys.add(entry.studentKey);
  }
  const expiresAt = new Date(input.fetchedAt.getTime() + maxAgeMs);
  if (input.fetchedAt.getTime() > now.getTime() + 5000 || expiresAt <= now) throw new RosterSyncError('stale_snapshot');
  return expiresAt;
}
async function previewInTransaction(tx: Prisma.TransactionClient, input: RosterSnapshotInput, options: RosterSyncOptions, now: Date): Promise<RosterPreview> {
  const expiresAt = validateInput(input, options, now);
  const previous = await tx.rosterSnapshot.findUnique({ where: { id: currentSnapshotId }, include: { entries: true } });
  if (previous && input.fetchedAt <= previous.fetchedAt) throw new RosterSyncError('outdated_snapshot');
  const risks: RosterRisk[] = [];
  if (!input.entries.length) risks.push('empty_roster');
  if (previous && previous.sourceKey !== input.sourceKey) risks.push('source_changed');
  if (previous) {
    try { validateSnapshotChange(previous.entries as RosterEntry[], input.entries); }
    catch { risks.push('mass_revocation'); }
  }
  return { digest: rosterDigest(input), total: input.entries.length, active: input.entries.filter(entry => entry.status === 'active').length, previousTotal: previous?.entryCount ?? 0, risks, fetchedAt: input.fetchedAt.toISOString(), expiresAt: expiresAt.toISOString(), databaseChanged: false };
}
export function previewRosterSnapshot(db: PrismaClient, input: RosterSnapshotInput, options: RosterSyncOptions, now = new Date()): Promise<RosterPreview> {
  return serializable(db, tx => previewInTransaction(tx, input, options, now));
}

/** This is the sole roster mutation: snapshot, subjects, audit, and policy outbox commit together. */
export function applyRosterSnapshot(db: PrismaClient, input: RosterSnapshotInput, options: RosterSyncOptions, now = new Date()): Promise<RosterSyncSummary> {
  return policyTransaction(db, async tx => {
    await options.authorize?.(tx);
    const preview = await previewInTransaction(tx, input, options, now);
    if (options.expectedApprovalDigest && options.expectedApprovalDigest !== preview.digest) throw new RosterSyncError('approval_mismatch', preview);
    if (preview.risks.length && options.expectedApprovalDigest !== preview.digest) throw new RosterSyncError('approval_required', preview);
    const expiresAt = new Date(preview.expiresAt);
    await tx.rosterSnapshot.upsert({ where: { id: currentSnapshotId }, create: { id: currentSnapshotId, sourceKey: input.sourceKey, digest: preview.digest, fetchedAt: input.fetchedAt, expiresAt, entryCount: input.entries.length }, update: { sourceKey: input.sourceKey, digest: preview.digest, fetchedAt: input.fetchedAt, expiresAt, entryCount: input.entries.length } });
    await tx.rosterMembership.deleteMany({ where: { snapshotId: currentSnapshotId } });
    if (input.entries.length) await tx.rosterMembership.createMany({ data: canonicalEntries(input.entries).map(entry => ({ ...entry, snapshotId: currentSnapshotId })) });
    const byStudent = new Map(input.entries.map(entry => [entry.studentKey, entry]));
    const subjects = await tx.subject.findMany({ where: { identityProvider: 'usaint' }, include: { minecraft: true } });
    let changedPolicies = 0;
    for (const subject of subjects) {
      const entry = byStudent.get(subject.universityKey);
      const membershipStatus = entry?.status ?? 'inactive';
      const roleLabel = membershipStatus === 'active' ? entry!.roleLabel : '';
      const allowedServerIds = membershipStatus === 'active' ? [...entry!.serverIds].sort() : [];
      const changed = subject.membershipStatus !== membershipStatus || subject.roleLabel !== roleLabel || JSON.stringify([...subject.allowedServerIds].sort()) !== JSON.stringify(allowedServerIds) || (membershipStatus === 'active' && subject.verifiedUntil <= now);
      await tx.subject.update({ where: { id: subject.id }, data: { membershipStatus, roleLabel, allowedServerIds, verifiedUntil: expiresAt } });
      await refreshDiscordSubject(tx, subject.id, now);
      if (changed) {
        await tx.auditEvent.create({ data: { action: 'membership.snapshot_changed', subjectId: subject.id, objectId: preview.digest } });
        if (subject.minecraft) {
          const identity = await tx.minecraftIdentity.update({ where: { uuid: subject.minecraft.uuid }, data: { policyVersion: { increment: 1 }, policyFingerprint: '' } });
          await tx.policyEvent.create({ data: { minecraftUuid: identity.uuid, policyVersion: identity.policyVersion } });
          changedPolicies++;
        }
      }
    }
    await tx.auditEvent.create({ data: { action: preview.risks.length ? 'roster.snapshot_approved' : 'roster.snapshot_applied', objectId: preview.digest } });
    return { ...preview, databaseChanged: true, updatedSubjects: subjects.length, changedPolicies };
  });
}

/** Called inside the school-login transaction; registration cannot bypass missing/stale membership. */
export async function membershipForStudent(tx: Prisma.TransactionClient, key: string, now = new Date()) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new RosterSyncError('invalid_snapshot');
  const entry = await tx.rosterMembership.findUnique({ where: { studentKey: key }, include: { snapshot: true } });
  if (!entry) return { membershipStatus: 'inactive', roleLabel: '', allowedServerIds: [] as string[], verifiedUntil: new Date(0) };
  const active = entry.status === 'active' && entry.snapshot.expiresAt > now;
  return { membershipStatus: entry.status, roleLabel: active ? entry.roleLabel : '', allowedServerIds: active ? entry.serverIds : [], verifiedUntil: entry.snapshot.expiresAt };
}

function integrationConfig(env: NodeJS.ProcessEnv) {
  try {
    const config = sheetsConfig(env);
    const maxAgeSeconds = Number(env.ROSTER_MAX_AGE_SECONDS ?? 900);
    const intervalSeconds = Number(env.SHEETS_SYNC_INTERVAL_SECONDS ?? 60);
    if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 60 || maxAgeSeconds > 86400 || !Number.isInteger(intervalSeconds) || intervalSeconds < 10 || intervalSeconds * 2 > maxAgeSeconds) throw new Error();
    return { config, options: { allowedServerIds: config.allowedServerIds, maxAgeMs: maxAgeSeconds * 1000 }, intervalMs: intervalSeconds * 1000 };
  } catch { throw new RosterSyncError('configuration_error'); }
}
async function readSnapshot(config: SheetsConfig): Promise<RosterSnapshotInput> {
  // Capture request start, not completion: delayed responses must never overwrite newer snapshots.
  const fetchedAt = new Date();
  try { return { entries: await readGoogleSheet(config, { allowEmpty: true }), fetchedAt, sourceKey: rosterSourceKey(config) }; }
  catch { throw new RosterSyncError('read_failed'); }
}
export async function previewRosterSync(db: PrismaClient, env: NodeJS.ProcessEnv = process.env) {
  const { config, options } = integrationConfig(env);
  return previewRosterSnapshot(db, await readSnapshot(config), options);
}
export async function runRosterSync(db: PrismaClient, env: NodeJS.ProcessEnv = process.env, approval: { expectedApprovalDigest?: string; authorize?: RosterSyncOptions['authorize'] } = {}) {
  return observedOperation('roster_sync', async () => {
    const { config, options } = integrationConfig(env);
    return applyRosterSnapshot(db, await readSnapshot(config), { ...options, ...approval });
  });
}

export function startMembershipSync(db: PrismaClient, env: NodeJS.ProcessEnv = process.env) {
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let lastSuccessAt: string | null = null;
  let lastError: string | null = null;
  let enabled = false;
  const sync = async (expectedApprovalDigest?: string, authorize?: RosterSyncOptions['authorize']) => {
    if (running) throw new RosterSyncError('sync_busy');
    running = true;
    try {
      const result = await runRosterSync(db, env, { expectedApprovalDigest, authorize });
      lastSuccessAt = new Date().toISOString(); lastError = null;
      return result;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      lastError = error instanceof RosterSyncError ? error.code : 'apply_failed';
      // Never propagate database/Google errors carrying source configuration or member rows.
      throw error instanceof RosterSyncError ? error : new RosterSyncError('apply_failed');
    } finally { running = false; }
  };
  if (env.SHEETS_SYNC_ENABLED === 'true') {
    try {
      const { intervalMs } = integrationConfig(env);
      enabled = true;
      void sync().catch(() => {});
      timer = setInterval(() => { void sync().catch(() => {}); }, intervalMs);
      timer.unref();
    } catch { lastError = 'configuration_error'; }
  }
  return { stop: () => { clearInterval(timer); }, sync, preview: () => previewRosterSync(db, env), approve: (digest: string, authorize?: RosterSyncOptions['authorize']) => sync(digest, authorize), status: () => ({ enabled, running, lastSuccessAt, lastError }) };
}
