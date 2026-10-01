import { BadRequestException, ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import type { PassportService } from './passport.service';
import { adminContext, protectAdministratorTarget, requireAdminTransaction } from './admin';
import { counterNames, emptyCounters } from './activity';
import { policyTransaction } from './database';
import { gameConsent } from './game-identity';
import { hash } from './security';

export type ResetScope = { scope: 'subject'; subjectId: string } | { scope: 'server'; serverId: string } | { scope: 'all' };
export type ResetInput = ResetScope & { expectedRevision: string; confirmation: string };
const RESET_CONFIRMATION = '통계 초기화';
const MAX_RESET_SUBJECTS = 5000, MAX_RESET_ROWS = 50000;
const revision = (subject: { id: string; statisticsEnabled: boolean; statisticsRevision: number }) => hash(JSON.stringify([subject.id, subject.statisticsEnabled, subject.statisticsRevision]));

async function rotate(tx: Prisma.TransactionClient, subjectId?: string) {
  const identities = await tx.minecraftIdentity.findMany({ where: subjectId ? { subjectId } : { subjectId: { not: null } }, select: { uuid: true } });
  for (const identity of identities) {
    const changed = await tx.minecraftIdentity.update({ where: { uuid: identity.uuid }, data: { telemetryEpoch: randomUUID(), policyVersion: { increment: 1 }, policyFingerprint: '' } });
    await tx.policyEvent.create({ data: { minecraftUuid: changed.uuid, policyVersion: changed.policyVersion } });
  }
}

export async function statisticsSettings(p: PassportService, req: Request, input?: { enabled: boolean; expectedRevision: string }) {
  const context = input ? await p.mutation(req) : await p.context(req, true);
  return policyTransaction(p.db, async tx => {
    const session = await tx.webSession.findUnique({ where: { id: context.session.id }, include: { subject: true } });
    if (!session?.subject || session.expiresAt <= new Date() || session.tokenHash !== hash(context.token) || session.subjectId !== context.session.subjectId) throw new UnauthorizedException({ code: 'session_required' });
    let subject = session.subject;
    if (input) {
      if (input.expectedRevision !== revision(subject)) throw new ConflictException({ code: 'statistics_settings_changed' });
      if (subject.statisticsEnabled !== input.enabled) {
        subject = await tx.subject.update({ where: { id: subject.id }, data: { statisticsEnabled: input.enabled, statisticsRevision: { increment: 1 } } });
        await rotate(tx, subject.id);
        await tx.auditEvent.create({ data: { action: 'subject.statistics_collection_updated', subjectId: subject.id, actorSubjectId: subject.id, details: { enabled: input.enabled } } });
      }
    }
    return { enabled: subject.statisticsEnabled, revision: revision(subject), consentGranted: await gameConsent(tx, subject.id) };
  });
}

async function resetPreview(tx: Prisma.TransactionClient, scope: ResetScope, actorSubjectId: string) {
  if (scope.scope === 'subject' && !await tx.subject.findUnique({ where: { id: scope.subjectId }, select: { id: true } })) throw new NotFoundException({ code: 'subject_not_found' });
  if (scope.scope === 'server' && !await tx.serverRecord.findUnique({ where: { id: scope.serverId }, select: { id: true } })) throw new NotFoundException({ code: 'server_not_found' });
  const where: Prisma.ActivityTotalWhereInput = scope.scope === 'subject' ? { generation: { subjectId: scope.subjectId } } : scope.scope === 'server' ? { serverId: scope.serverId } : {};
  const records = await tx.activityTotal.findMany({ where, include: { generation: { select: { subjectId: true } } }, orderBy: [{ epoch: 'asc' }, { serverId: 'asc' }], take: MAX_RESET_ROWS + 1 });
  const subjects = [...new Set(records.map(row => row.generation.subjectId))];
  if (subjects.length > MAX_RESET_SUBJECTS || records.length > MAX_RESET_ROWS) throw new ConflictException({ code: 'statistics_reset_too_large' });
  // Reset is not an alternative way for an operator to erase administrator data.
  const protectedTarget = await tx.administrator.findFirst({ where: { subjectId: { in: subjects }, enabled: true, revokedAt: null }, select: { subjectId: true } });
  if (protectedTarget) await protectAdministratorTarget(tx, actorSubjectId, protectedTarget.subjectId);
  if (scope.scope === 'subject') await protectAdministratorTarget(tx, actorSubjectId, scope.subjectId);
  const identities = await tx.minecraftIdentity.findMany({ where: scope.scope === 'subject' ? { subjectId: scope.subjectId } : { subjectId: { not: null } }, select: { uuid: true, telemetryEpoch: true }, orderBy: { uuid: 'asc' } });
  const resetCount = await tx.auditEvent.count({ where: { action: 'admin.statistics_reset' } });
  const totals = emptyCounters();
  for (const row of records) for (const key of counterNames) {
    totals[key] += Number(row[key]);
    if (!Number.isSafeInteger(totals[key]) || totals[key] < 0) throw new ConflictException({ code: 'statistics_overflow' });
  }
  // Counter increments remain allowed after preview; a changed target generation
  // or epoch requires a new preview. Execution clears through its commit time.
  const expectedRevision = hash(JSON.stringify([actorSubjectId, scope, resetCount, identities, records.map(row => [row.epoch, row.serverId, row.generation.subjectId])]));
  return { where, preview: { ...scope, affectedSubjects: subjects.length, rows: records.length, totals, expectedRevision, confirmation: RESET_CONFIRMATION } };
}

export async function previewStatisticsReset(p: PassportService, req: Request, scope: ResetScope) {
  const actor = await adminContext(p, req, true);
  return policyTransaction(p.db, async tx => {
    await requireAdminTransaction(p, tx, actor);
    return (await resetPreview(tx, scope, actor.session.subjectId!)).preview;
  });
}

export async function resetStatistics(p: PassportService, req: Request, input: ResetInput) {
  const actor = await adminContext(p, req, true);
  if (input.confirmation !== RESET_CONFIRMATION) throw new BadRequestException({ code: 'confirmation_mismatch' });
  const scope: ResetScope = input.scope === 'subject' ? { scope: 'subject', subjectId: input.subjectId } : input.scope === 'server' ? { scope: 'server', serverId: input.serverId } : { scope: 'all' };
  return policyTransaction(p.db, async tx => {
    await requireAdminTransaction(p, tx, actor);
    const { where, preview } = await resetPreview(tx, scope, actor.session.subjectId!);
    if (preview.expectedRevision !== input.expectedRevision) throw new ConflictException({ code: 'statistics_reset_changed' });
    await tx.activityTotal.deleteMany({ where });
    // All linked epochs rotate for a server/all reset, including players who only
    // have offline queued batches and have never uploaded a generation yet.
    await rotate(tx, scope.scope === 'subject' ? scope.subjectId : undefined);
    await tx.auditEvent.create({ data: { action: 'admin.statistics_reset', actorSubjectId: actor.session.subjectId, ...(scope.scope === 'subject' ? { subjectId: scope.subjectId } : {}), details: { ...scope, affectedSubjects: preview.affectedSubjects, rows: preview.rows, totals: preview.totals } } });
    return { reset: true, affectedSubjects: preview.affectedSubjects, rows: preview.rows };
  });
}
