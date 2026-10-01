import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Request } from 'express';
import type { Config } from './config';
import type { PassportService } from './passport.service';
import { adminContext } from './admin';
import { discordService } from './discord';
import { policyTransaction } from './database';
import { managementConsent, projectDiscordIdentity, refreshDiscordSubject } from './discord-policy';
import { hash, equal, opaqueToken } from './security';
import { ConsentInput, recordConsent, requireConsent } from './privacy';

export type DiscordSettingsInput = { memberRoleId: string | null; currentSemester: string | null; semesterRoles: { semester: string; roleId: string }[]; nicknameEnabled: boolean; expectedRevision: string };
export type DiscordClaimInput = { contractVersion: 2; guildId: string; settingsRevision: string; limit: number };
export type DiscordAckInput = { contractVersion: 2; leaseToken: string; version: string; outcome: 'applied' | 'retry' | 'member_absent' | 'configuration_error' | 'not_manageable' };
export async function seedDiscordSettings(db: PrismaClient, config: Config['discord']) {
  if (!config) return;
  await policyTransaction(db, async tx => { await tx.discordGuildSettings.upsert({ where: { guildId: config.guildId }, update: {}, create: { guildId: config.guildId, verificationRoleId: config.roleId } }); });
}
async function settingsFor(tx: Prisma.TransactionClient, config: NonNullable<Config['discord']>) {
  const row = await tx.discordGuildSettings.findUnique({ where: { guildId: config.guildId }, include: { semesterRoles: { orderBy: { semester: 'asc' } } } });
  if (!row || row.verificationRoleId !== config.roleId) throw new ServiceUnavailableException({ code: 'discord_config_mismatch' });
  return row;
}
function settingsDto(row: Awaited<ReturnType<typeof settingsFor>>) {
  return { guildId: row.guildId, verificationRoleId: row.verificationRoleId, memberRoleId: row.memberRoleId, currentSemester: row.currentSemester, nicknameEnabled: row.nicknameEnabled, semesterRoles: row.semesterRoles.map(({ semester, roleId }) => ({ semester, roleId })), revision: row.revision.toString() };
}
function configured(p: PassportService) {
  if (!p.config.discord) throw new ServiceUnavailableException({ code: 'discord_not_configured' });
  return p.config.discord;
}
export async function adminDiscord(p: PassportService, req: Request) {
  await adminContext(p, req);
  if (!p.config.discord) return { configured: false, settings: null, status: { linked: 0, roles: { pending: 0, failed: 0 }, nicknames: { pending: 0, failed: 0 } } };
  const config = p.config.discord, row = await settingsFor(p.db, config);
  const roles = await p.db.discordRoleState.findMany({ where: { guildId: config.guildId } });
  const nicknames = await p.db.discordNicknameState.findMany({ where: { guildId: config.guildId } });
  return { configured: true, settings: settingsDto(row), status: { linked: await p.db.discordIdentity.count({ where: { guildId: config.guildId, subjectId: { not: null } } }),
    roles: { pending: roles.filter(r => !r.lastError && (r.appliedVersion !== r.version || r.appliedDesired !== r.desired)).length, failed: roles.filter(r => r.lastError).length },
    nicknames: { pending: nicknames.filter(r => !r.lastError && (r.appliedVersion !== r.version || r.appliedNickname !== r.nickname)).length, failed: nicknames.filter(r => r.lastError).length } } };
}
async function reconcile(tx: Prisma.TransactionClient, guildId: string, now: Date) {
  // Include previously authenticated subjects without a Discord link when recording current-term evidence.
  for (const subject of await tx.subject.findMany({ where: { identityProvider: 'usaint' }, select: { id: true } })) await refreshDiscordSubject(tx, subject.id, now);
  for (const identity of await tx.discordIdentity.findMany({ where: { guildId, subjectId: null }, select: { discordUserId: true } })) await projectDiscordIdentity(tx, identity.discordUserId, now);
  await tx.discordRoleState.updateMany({ where: { guildId }, data: { nextAttemptAt: now } });
  await tx.discordNicknameState.updateMany({ where: { guildId }, data: { nextAttemptAt: now } });
}
export async function updateDiscordSettings(p: PassportService, req: Request, input: DiscordSettingsInput) {
  const actor = await adminContext(p, req, true), config = configured(p);
  return policyTransaction(p.db, async tx => {
    const current = await settingsFor(tx, config);
    if (current.revision.toString() !== input.expectedRevision) throw new ConflictException({ code: 'discord_settings_changed' });
    const plans = [{ roleId: current.verificationRoleId, kind: 'verification', semester: null }, ...(input.memberRoleId ? [{ roleId: input.memberRoleId, kind: 'member', semester: null }] : []), ...input.semesterRoles.map(r => ({ ...r, kind: 'semester' }))];
    if (plans.some(r => r.roleId === config.guildId) || new Set(plans.map(r => r.roleId)).size !== plans.length || (input.currentSemester && !input.semesterRoles.some(r => r.semester === input.currentSemester))) throw new BadRequestException({ code: 'discord_settings_invalid' });
    const previousRoles = await tx.discordRoleState.findMany({ where: { guildId: config.guildId }, distinct: ['roleId', 'kind', 'semester'], select: { roleId: true, kind: true, semester: true } });
    if (new Set([...previousRoles.map(r => r.roleId), ...plans.map(r => r.roleId)]).size > 256) throw new ConflictException({ code: 'discord_role_limit' });
    if (plans.some(plan => previousRoles.some(old => old.roleId === plan.roleId && (old.kind !== plan.kind || old.semester !== plan.semester)))) throw new BadRequestException({ code: 'discord_role_conflict' });
    await tx.discordSemesterRole.deleteMany({ where: { guildId: config.guildId } });
    if (input.semesterRoles.length) await tx.discordSemesterRole.createMany({ data: input.semesterRoles.map(r => ({ ...r, guildId: config.guildId })) });
    await tx.discordGuildSettings.update({ where: { guildId: config.guildId }, data: { memberRoleId: input.memberRoleId, currentSemester: input.currentSemester, nicknameEnabled: input.nicknameEnabled, revision: { increment: 1 } } });
    await reconcile(tx, config.guildId, new Date());
    const updated = await settingsFor(tx, config);
    await tx.auditEvent.create({ data: { action: 'admin.discord_settings_changed', actorSubjectId: actor.session.subjectId, objectId: config.guildId, details: { before: settingsDto(current), after: settingsDto(updated) } } });
    return { settings: settingsDto(updated) };
  });
}
export async function reconcileDiscord(p: PassportService, req: Request, expectedRevision: string) {
  const actor = await adminContext(p, req, true), config = configured(p);
  return policyTransaction(p.db, async tx => {
    if ((await settingsFor(tx, config)).revision.toString() !== expectedRevision) throw new ConflictException({ code: 'discord_settings_changed' });
    await reconcile(tx, config.guildId, new Date());
    await tx.auditEvent.create({ data: { action: 'admin.discord_reconcile_requested', actorSubjectId: actor.session.subjectId, objectId: config.guildId } });
    return { queued: true };
  });
}
export async function renewDiscordConsent(p: PassportService, req: Request, input: ConsentInput) {
  const context = await p.mutation(req), consent = requireConsent(input);
  return policyTransaction(p.db, async tx => {
    const identity = await tx.discordIdentity.findUnique({ where: { subjectId: context.session.subjectId! } });
    if (!identity) throw new NotFoundException({ code: 'discord_not_linked' });
    if (!await managementConsent(tx, context.session.subjectId!)) await recordConsent(tx, context.session.subjectId!, 'discord_link', randomUUID(), consent);
    await refreshDiscordSubject(tx, context.session.subjectId!);
    return { updated: true };
  });
}
export async function discordBotConfig(p: PassportService, req: Request) {
  const config = discordService(p, req), row = await settingsFor(p.db, config);
  const previous = await p.db.discordRoleState.findMany({ where: { guildId: config.guildId }, distinct: ['roleId'], select: { roleId: true } });
  return { contractVersion: 2, settingsRevision: row.revision.toString(), guildId: config.guildId, nicknameEnabled: row.nicknameEnabled,
    managedRoleIds: [...new Set([row.verificationRoleId, ...(row.memberRoleId ? [row.memberRoleId] : []), ...row.semesterRoles.map(r => r.roleId), ...previous.map(r => r.roleId)])].sort() };
}
async function claimContext(p: PassportService, req: Request, input: DiscordClaimInput, tx: Prisma.TransactionClient) {
  const config = discordService(p, req);
  if (input.guildId !== config.guildId) throw new ForbiddenException({ code: 'discord_guild_mismatch' });
  if ((await settingsFor(tx, config)).revision.toString() !== input.settingsRevision) throw new ConflictException({ code: 'discord_settings_changed' });
  return config;
}
function removalPending(row: { appliedDesired: boolean | null; appliedVersion: bigint | null; version: bigint; leaseUntil: Date | null }, now: Date) {
  return row.appliedDesired !== false || row.appliedVersion !== row.version || Boolean(row.leaseUntil && row.leaseUntil > now);
}
export async function claimDiscordV2(p: PassportService, req: Request, input: DiscordClaimInput, nickname: boolean) {
  discordService(p, req);
  return policyTransaction(p.db, async tx => {
    const config = await claimContext(p, req, input, tx), now = new Date(), jobs: unknown[] = [];
    const available = { OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] };
    const candidates = nickname ? await tx.discordNicknameState.findMany({ where: { guildId: config.guildId, AND: [available, { OR: [{ nextAttemptAt: { lte: now } }, { nickname: { not: null }, validUntil: { lte: now } }] }] }, orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }], take: 100 }) : await tx.discordRoleState.findMany({ where: { guildId: config.guildId, AND: [available, { OR: [{ nextAttemptAt: { lte: now } }, { desired: true, validUntil: { lte: now } }] }] }, orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }], take: 100 });
    const blockedIds = new Set<string>();
    if (!nickname && candidates.length) {
      const key = (row: { discordUserId: string; kind: string; semester: string | null }) => `${row.discordUserId}:${row.kind}:${row.semester ?? ''}`;
      const unresolved = await tx.discordRoleState.findMany({ where: { guildId: config.guildId, discordUserId: { in: [...new Set(candidates.map(row => row.discordUserId))] }, desired: false }, select: { discordUserId: true, kind: true, semester: true, appliedDesired: true, appliedVersion: true, version: true, leaseUntil: true } });
      const handoffs = new Set(unresolved.filter(row => removalPending(row, now)).map(key));
      for (const candidate of candidates) if ('desired' in candidate && candidate.desired && candidate.validUntil && candidate.validUntil > now && handoffs.has(key(candidate))) blockedIds.add(candidate.id);
      if (blockedIds.size) await tx.discordRoleState.updateMany({ where: { id: { in: [...blockedIds] } }, data: { nextAttemptAt: new Date(now.getTime() + 5000) } });
    }
    for (const candidate of candidates) {
      if (blockedIds.has(candidate.id)) continue;
      await projectDiscordIdentity(tx, candidate.discordUserId, now);
      const current = nickname ? await tx.discordNicknameState.findUniqueOrThrow({ where: { id: candidate.id } }) : await tx.discordRoleState.findUniqueOrThrow({ where: { id: candidate.id } });
      if (!nickname && 'desired' in current && current.desired && (await tx.discordRoleState.findMany({ where: { discordUserId: current.discordUserId, guildId: current.guildId, kind: current.kind, semester: current.semester, desired: false }, select: { appliedDesired: true, appliedVersion: true, version: true, leaseUntil: true } })).some(row => removalPending(row, now))) {
        // Rotate blocked handoffs out of the bounded candidate window; completed revocations
        // share the same fair queue as grants, so periodic cleanup cannot starve users.
        await tx.discordRoleState.update({ where: { id: current.id }, data: { nextAttemptAt: new Date(now.getTime() + 5000) } });
        continue;
      }
      const grant = 'desired' in current ? current.desired : current.nickname !== null;
      const expiresAt = new Date(Math.min(now.getTime() + 60000, grant && current.validUntil ? current.validUntil.getTime() : Infinity)), leaseToken = opaqueToken();
      const data = { leaseHash: hash(leaseToken), leaseUntil: expiresAt };
      if (nickname) await tx.discordNicknameState.update({ where: { id: current.id }, data }); else await tx.discordRoleState.update({ where: { id: current.id }, data });
      jobs.push({ id: current.id, leaseToken, guildId: current.guildId, discordUserId: current.discordUserId, version: current.version.toString(), expiresAt: expiresAt.toISOString(),
        ...('desired' in current ? { roleId: current.roleId, desired: current.desired, kind: current.kind, semester: current.semester } : { nickname: current.nickname }) });
      if (jobs.length === input.limit) break;
    }
    return { contractVersion: 2, jobs };
  });
}
export async function ackDiscordNickname(p: PassportService, req: Request, id: string, input: DiscordAckInput) {
  const config = discordService(p, req);
  const success = await policyTransaction(p.db, async tx => {
    const stored = await tx.discordNicknameState.findUnique({ where: { id } }), now = new Date();
    if (!stored || stored.guildId !== config.guildId) throw new NotFoundException({ code: 'discord_nickname_not_found' });
    if (!stored.leaseHash || !equal(stored.leaseHash, hash(input.leaseToken)) || !stored.leaseUntil || stored.leaseUntil <= now) return false;
    await projectDiscordIdentity(tx, stored.discordUserId, now);
    const current = await tx.discordNicknameState.findUniqueOrThrow({ where: { id } });
    if (current.version.toString() !== input.version) { await tx.discordNicknameState.update({ where: { id }, data: { leaseHash: null, leaseUntil: null, nextAttemptAt: now } }); return false; }
    const applied = input.outcome === 'applied' || (input.outcome === 'member_absent' && current.nickname === null), attempts = applied ? 0 : Math.min(current.attempts + 1, 16);
    const delay = applied || input.outcome === 'member_absent' ? 60000 : ['configuration_error', 'not_manageable'].includes(input.outcome) ? 300000 : Math.min(5000 * 2 ** (attempts - 1), 300000);
    await tx.discordNicknameState.update({ where: { id }, data: { leaseHash: null, leaseUntil: null, nextAttemptAt: new Date(now.getTime() + delay), attempts, lastError: applied ? null : input.outcome, ...(applied ? { appliedNickname: current.nickname, appliedVersion: current.version, appliedAt: now } : {}) } });
    return true;
  });
  if (!success) throw new ConflictException({ code: 'discord_lease_stale' });
}
