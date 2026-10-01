import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { createHmac, randomUUID } from 'node:crypto';
import type { Prisma, Subject, MinecraftIdentity, DiscordIdentity, Administrator } from '@prisma/client';
import type { Request } from 'express';
import type { PassportService } from './passport.service';
import { adminContext } from './admin';
import { policyTransaction } from './database';
import { discordProfile, projectDiscordIdentity } from './discord-policy';
import { studentKey } from './integrations/sheets';
import { presenceDto } from './game-identity';
import { equal, hash } from './security';
import { verifiedStudentId } from './school-identity';

type Account = Subject & { minecraft: MinecraftIdentity | null; discordIdentity: DiscordIdentity | null; administrator: Administrator | null };
export type MemberQuery = { q: string; membership: 'all' | 'active' | 'inactive' | 'suspended'; sort: 'name' | 'newest' | 'oldest'; limit: number; cursor?: string };
export function accountRevision(account: Account) {
  return hash(JSON.stringify({ id: account.id, displayName: account.displayName, department: account.department, admissionYear: account.admissionYear, identityProvider: account.identityProvider, universityVerifiedUntil: account.universityVerifiedUntil, membershipStatus: account.membershipStatus, roleLabel: account.roleLabel, allowedServerIds: account.allowedServerIds, accessSuspended: account.accessSuspended, scopeRestricted: account.scopeRestricted, scopeLimit: account.scopeLimit, minecraft: account.minecraft && [account.minecraft.uuid, account.minecraft.name, account.minecraft.subjectId, account.minecraft.telemetryEpoch], discord: account.discordIdentity && [account.discordIdentity.discordUserId, account.discordIdentity.subjectId, account.discordIdentity.verifiedAt], administrator: account.administrator?.enabled ?? false }));
}
function cursorSignature(secret: string, payload: string) { return createHmac('sha256', secret).update(`members:${payload}`).digest('base64url'); }
function queryKey(input: MemberQuery) { return hash(JSON.stringify([input.q, input.membership, input.sort, input.limit])); }
function cursorOffset(input: MemberQuery, secret: string) {
  if (!input.cursor) return 0;
  const [payload, signature, extra] = input.cursor.split('.');
  if (!payload || !signature || extra || !equal(signature, cursorSignature(secret, payload))) throw new BadRequestException({ code: 'invalid_cursor' });
  try { const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); if (parsed.key === queryKey(input) && Number.isSafeInteger(parsed.offset) && parsed.offset >= 0 && parsed.offset <= 1_000_000 && parsed.expires > Date.now()) return parsed.offset as number; } catch {}
  throw new BadRequestException({ code: 'invalid_cursor' });
}
function nextCursor(input: MemberQuery, offset: number, secret: string) { const payload = Buffer.from(JSON.stringify({ key: queryKey(input), offset, expires: Date.now() + 30 * 60_000 })).toString('base64url'); return `${payload}.${cursorSignature(secret, payload)}`; }
export async function adminMembers(p: PassportService, req: Request, input: MemberQuery) {
  await adminContext(p, req);
  const offset = cursorOffset(input, p.config.sessionSecret), now = new Date();
  const filters: Prisma.SubjectWhereInput[] = [{ identityProvider: 'usaint' }];
  const active: Prisma.SubjectWhereInput = { membershipStatus: 'active', verifiedUntil: { gt: now }, accessSuspended: false };
  const suspended: Prisma.SubjectWhereInput = { OR: [{ accessSuspended: true }, { membershipStatus: 'suspended' }] };
  if (input.membership === 'active') filters.push(active);
  if (input.membership === 'suspended') filters.push(suspended);
  if (input.membership === 'inactive') filters.push({ NOT: { OR: [active, suspended] } });
  if (input.q) {
    const contains = { contains: input.q, mode: 'insensitive' as const };
    const alternatives: Prisma.SubjectWhereInput[] = [{ displayName: contains }, { minecraft: { name: contains } }, { discordId: contains }, { discordIdentity: { OR: [{ discordUserId: contains }, { username: contains }, { displayName: contains }] } }];
    if (/^\d{8,10}$/.test(input.q)) alternatives.push({ universityKey: studentKey(input.q, p.config.matchingSecret) });
    filters.push({ OR: alternatives });
  }
  const where = { AND: filters };
  const orderBy: Prisma.SubjectOrderByWithRelationInput[] = input.sort === 'name' ? [{ displayName: 'asc' }, { id: 'asc' }] : [{ createdAt: input.sort === 'newest' ? 'desc' : 'asc' }, { id: 'asc' }];
  const [rows, total, servers] = await p.db.$transaction([
    p.db.subject.findMany({ where, orderBy, skip: offset, take: input.limit + 1, include: { minecraft: true, administrator: true, discordIdentity: { include: { roles: true } } } }), p.db.subject.count({ where }), p.db.serverRecord.findMany({ orderBy: { id: 'asc' } }),
  ]);
  const presences = await p.db.playerPresence.findMany({ where: { minecraftUuid: { in: rows.flatMap(row => row.minecraft ? [row.minecraft.uuid] : []) } } });
  const members = await Promise.all(rows.slice(0, input.limit).map(async account => ({
    id: account.id, displayName: account.displayName, department: account.department, studentId: verifiedStudentId(account, p.config.encryptionKey), admissionYear: account.admissionYear, membershipStatus: account.membershipStatus, roleLabel: account.roleLabel, verifiedUntil: account.verifiedUntil, universityVerifiedUntil: account.universityVerifiedUntil, allowedServerIds: account.allowedServerIds, accessSuspended: account.accessSuspended, scopeRestricted: account.scopeRestricted, scopeLimit: account.scopeLimit, discordId: account.discordId, minecraft: account.minecraft ? { uuid: account.minecraft.uuid, name: account.minecraft.name } : null,
    presence: presenceDto(presences.find(row => row.minecraftUuid === account.minecraft?.uuid), servers, now), createdAt: account.createdAt, revision: accountRevision(account), administrator: account.administrator?.enabled ?? false,
    discordConnection: await discordProfile(p.db, account.discordIdentity, p.config.discord), eligibleServerIds: p.gameServers({ ...account, accessSuspended: false }, servers, now, false).map(server => server.id),
  })));
  return { members, total, nextCursor: rows.length > input.limit ? nextCursor(input, offset + input.limit, p.config.sessionSecret) : null };
}
export async function deleteMember(p: PassportService, req: Request, id: string, input: { expectedRevision: string; confirmation: string }) {
  const actor = await adminContext(p, req, true);
  return eraseSubject(p, id, input, actor.session.subjectId!);
}
/** Shared operator entry point. Null actor is a distinct operator audit action, never an impersonated administrator. */
export async function eraseSubject(p: PassportService, id: string, input: { expectedRevision: string; confirmation: string }, actorSubjectId: string | null) {
  return policyTransaction(p.db, async tx => {
    const account = await tx.subject.findUnique({ where: { id }, include: { minecraft: true, discordIdentity: true, administrator: true } });
    if (!account || account.identityProvider !== 'usaint') throw new NotFoundException({ code: 'subject_not_found' });
    if (actorSubjectId === id) throw new ConflictException({ code: 'cannot_delete_self' });
    if (actorSubjectId && !(await tx.administrator.findUnique({ where: { subjectId: actorSubjectId } }))?.enabled) throw new ForbiddenException({ code: 'admin_required' });
    if (account.administrator?.enabled && await tx.administrator.count({ where: { enabled: true } }) <= 1) throw new ConflictException({ code: 'last_administrator' });
    if (!equal(input.expectedRevision, accountRevision(account))) throw new ConflictException({ code: 'subject_changed' });
    if (input.confirmation !== account.displayName) throw new BadRequestException({ code: 'confirmation_mismatch' });
    if (account.discordIdentity) {
      await tx.discordIdentity.update({ where: { discordUserId: account.discordIdentity.discordUserId }, data: { subjectId: null, username: '', displayName: '', eraseWhenRevoked: true } });
      await projectDiscordIdentity(tx, account.discordIdentity.discordUserId);
    }
    if (account.minecraft) {
      // Keep only the UUID watermark: deleting the row would let stale cached policy versions become current again.
      const changed = await tx.minecraftIdentity.update({ where: { uuid: account.minecraft.uuid }, data: { subjectId: null, name: '', policyVersion: { increment: 1 }, policyFingerprint: '', telemetryEpoch: randomUUID() } });
      await tx.policyEvent.create({ data: { minecraftUuid: changed.uuid, policyVersion: changed.policyVersion } });
      await tx.playerPresence.deleteMany({ where: { minecraftUuid: changed.uuid } });
    }
    await tx.linkSession.deleteMany({ where: { OR: [{ subjectId: id }, ...(account.minecraft ? [{ minecraftUuid: account.minecraft.uuid }] : [])] } });
    await tx.discordLinkSession.deleteMany({ where: { OR: [{ subjectId: id }, ...(account.discordIdentity ? [{ discordUserId: account.discordIdentity.discordUserId }] : [])] } });
    // Remove references from selected-server access lists while preserving the source roster.
    for (const server of await tx.serverRecord.findMany({ where: { allowedSubjectIds: { has: id } } })) await tx.serverRecord.update({ where: { id: server.id }, data: { allowedSubjectIds: server.allowedSubjectIds.filter(value => value !== id), updatedAt: new Date(Math.max(Date.now(), server.updatedAt.getTime() + 1)) } });
    await tx.auditEvent.deleteMany({ where: { OR: [{ subjectId: id }, { actorSubjectId: id }, ...(account.minecraft ? [{ objectId: account.minecraft.uuid }] : []), ...(account.discordIdentity ? [{ objectId: account.discordIdentity.discordUserId }] : [])] } });
    await tx.subject.delete({ where: { id } });
    await tx.auditEvent.create({ data: { action: actorSubjectId ? 'admin.subject_deleted' : 'ops.subject_deleted', actorSubjectId, details: { minecraftUnlinked: Boolean(account.minecraft), discordRevocationPending: Boolean(account.discordIdentity), rosterPreserved: true, statisticsErased: true } } });
    return { deleted: true, discordRevocationPending: Boolean(account.discordIdentity) };
  });
}
export async function purgeRevokedDeletedAccounts(p: PassportService) {
  await policyTransaction(p.db, async tx => {
    const rows = await tx.discordIdentity.findMany({ where: { subjectId: null, eraseWhenRevoked: true }, include: { roles: true, nicknames: true }, take: 100 });
    const now = new Date();
    for (const row of rows) {
      if (row.roles.every(role => !role.desired && role.appliedDesired === false && role.appliedVersion === role.version && (!role.leaseUntil || role.leaseUntil <= now)) && row.nicknames.every(nick => nick.nickname === null && nick.appliedNickname === null && nick.appliedVersion === nick.version && (!nick.leaseUntil || nick.leaseUntil <= now))) await tx.discordIdentity.delete({ where: { discordUserId: row.discordUserId } });
    }
  });
}
