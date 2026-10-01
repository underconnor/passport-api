import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { PassportService } from './passport.service';
import { equal, opaqueToken, hash, csrf } from './security';
import { policyTransaction, serializable } from './database';
import { newTotpSecret, verifyTotp } from './totp';
import { seal, unseal } from './sealed';
import { discordProfile, refreshDiscordSubject } from './discord-policy';

function adminHost(p: PassportService, req: Request) {
  if (!p.config.adminOrigin || p.host(req) !== new URL(p.config.adminOrigin).host) throw new ForbiddenException({ code: 'admin_host_required' });
}
async function schoolContext(p: PassportService, req: Request, mutation = false) {
  adminHost(p, req);
  const c = mutation ? await p.mutation(req) : await p.context(req, true);
  if (c.session.subject!.identityProvider !== 'usaint' || !c.session.subject!.universityVerifiedUntil || c.session.subject!.universityVerifiedUntil <= new Date()) throw new ForbiddenException({ code: 'university_login_required' });
  return c;
}
export async function adminContext(p: PassportService, req: Request, mutation = false) {
  const c = await schoolContext(p, req, mutation);
  const admin = await p.db.administrator.findUnique({ where: { subjectId: c.session.subjectId! } });
  if (!admin?.enabled) throw new ForbiddenException({ code: 'admin_required' });
  if (p.config.adminMfaRequired && (!admin.totpSecret || !c.session.mfaVerifiedUntil || c.session.mfaVerifiedUntil <= new Date())) throw new ForbiddenException({ code: 'mfa_required' });
  return c;
}
export async function adminStatus(p: PassportService, req: Request) {
  adminHost(p, req);
  const c = await p.context(req);
  const subject = c.session.subject;
  const admin = subject ? await p.db.administrator.findUnique({ where: { subjectId: subject.id } }) : null;
  const schoolValid = Boolean(subject?.identityProvider === 'usaint' && subject.universityVerifiedUntil && subject.universityVerifiedUntil > new Date());
  const mfaVerified = Boolean(schoolValid && admin?.enabled && admin.totpSecret && c.session.mfaVerifiedUntil && c.session.mfaVerifiedUntil > new Date());
  return { authenticated: Boolean(subject), schoolVerified: schoolValid, displayName: subject?.displayName ?? null, enrolled: Boolean(admin?.enabled), enrollmentPending: Boolean(admin && (!admin.enabled || (p.config.adminMfaRequired && !admin.totpSecret))), bootstrapAvailable: Boolean(p.config.adminBootstrapToken) && await p.db.administrator.count() === 0, mfaRequired: p.config.adminMfaRequired, authorized: Boolean(schoolValid && admin?.enabled && (!p.config.adminMfaRequired || mfaVerified)), mfaVerified, mfaVerifiedUntil: c.session.mfaVerifiedUntil?.toISOString() ?? null };
}
export async function beginEnrollment(p: PassportService, req: Request, bootstrapToken: string) {
  const c = await schoolContext(p, req, true);
  if (!p.config.adminBootstrapToken || !equal(bootstrapToken, p.config.adminBootstrapToken)) throw new ForbiddenException({ code: 'bootstrap_invalid' });
  const subjectId = c.session.subjectId!;
  const secret = p.config.adminMfaRequired ? newTotpSecret() : null;
  await serializable(p.db, async tx => {
    const first = await tx.administrator.findFirst();
    const reenrollingWithoutSecret = Boolean(p.config.adminMfaRequired && first?.subjectId === subjectId && first.enabled && !first.totpSecret);
    if (first && (first.subjectId !== subjectId || (first.enabled && !reenrollingWithoutSecret))) throw new ConflictException({ code: 'admin_enrollment_closed' });
    const sealedSecret = secret ? seal(secret, p.config.encryptionKey, `totp:${subjectId}`) : '';
    await tx.administrator.upsert({ where: { subjectId }, create: { subjectId, totpSecret: sealedSecret, enabled: !p.config.adminMfaRequired }, update: { ...(secret ? { totpSecret: sealedSecret } : { enabled: true }), failedAttempts: 0, lockedUntil: null } });
    await tx.auditEvent.create({ data: { action: p.config.adminMfaRequired ? 'admin.enrollment_started' : 'admin.enrolled', subjectId, actorSubjectId: subjectId, details: { mfaRequired: p.config.adminMfaRequired } } });
  });
  if (!secret) return { enrolled: true, mfaRequired: false };
  const label = encodeURIComponent(`Passport:${c.session.subject!.displayName}`);
  return { mfaRequired: true, secret, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=Passport&algorithm=SHA1&digits=6&period=30` };
}
export async function verifyAdminMfa(p: PassportService, req: Request, res: Response, code: string) {
  const c = await schoolContext(p, req, true);
  const token = opaqueToken();
  const result = await serializable(p.db, async tx => {
    const admin = await tx.administrator.findUnique({ where: { subjectId: c.session.subjectId! } });
    if (!admin) return { error: 'admin_required' };
    if (!admin.totpSecret) return { error: 'mfa_not_enrolled' };
    if (admin.lockedUntil && admin.lockedUntil > new Date()) return { error: 'mfa_locked' };
    const step = verifyTotp(unseal(admin.totpSecret, p.config.encryptionKey, `totp:${admin.subjectId}`), code, admin.lastTotpStep);
    if (step === null) {
      const attempts = admin.failedAttempts + 1;
      await tx.administrator.update({ where: { subjectId: admin.subjectId }, data: { failedAttempts: attempts, lockedUntil: attempts >= 5 ? new Date(Date.now() + 15 * 60_000) : null } });
      return { error: 'mfa_invalid' };
    }
    const until = new Date(Date.now() + 15 * 60_000);
    await tx.administrator.update({ where: { subjectId: admin.subjectId }, data: { enabled: true, lastTotpStep: BigInt(step), failedAttempts: 0, lockedUntil: null } });
    await tx.webSession.update({ where: { id: c.session.id }, data: { mfaVerifiedUntil: until, tokenHash: hash(token) } });
    await tx.auditEvent.create({ data: { action: admin.enabled ? 'admin.mfa_verified' : 'admin.enrolled', subjectId: admin.subjectId, actorSubjectId: admin.subjectId } });
    return { mfaVerifiedUntil: until.toISOString() };
  });
  if ('error' in result) throw new ForbiddenException({ code: result.error });
  p.setCookie(req, res, token, Math.max(1, Math.floor((c.session.expiresAt.getTime() - Date.now()) / 1000)));
  return { ...result, csrfToken: csrf(p.config.sessionSecret, token) };
}
export async function adminOverview(p: PassportService, req: Request) {
  await adminContext(p, req);
  const [subjects, linked, suspended, snapshot] = await Promise.all([
    p.db.subject.count({ where: { identityProvider: 'usaint' } }), p.db.minecraftIdentity.count({ where: { subjectId: { not: null } } }), p.db.subject.count({ where: { accessSuspended: true } }), p.db.rosterSnapshot.findUnique({ where: { id: 'current' }, select: { entryCount: true, fetchedAt: true, expiresAt: true } })
  ]);
  const servers = await p.db.serverRecord.findMany({ orderBy: { id: 'asc' }, select: { id: true, label: true, sensitive: true, enabled: true } });
  return { subjects, linked, suspended, snapshot, sync: p.membership.status(), servers };
}
export async function adminMembers(p: PassportService, req: Request, cursor?: string) {
  await adminContext(p, req);
  const rows = await p.db.subject.findMany({ where: { identityProvider: 'usaint' }, orderBy: { id: 'asc' }, take: 51, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select: { id: true, identityProvider: true, displayName: true, department: true, membershipStatus: true, roleLabel: true, verifiedUntil: true, universityVerifiedUntil: true, allowedServerIds: true, accessSuspended: true, scopeRestricted: true, scopeLimit: true, discordId: true, discordIdentity: { include: { roles: true } }, minecraft: { select: { uuid: true, name: true } } } });
  const servers = await p.db.serverRecord.findMany({ orderBy: { id: 'asc' } });
  return { members: await Promise.all(rows.slice(0, 50).map(async ({ identityProvider, discordIdentity, ...subject }) => ({ ...subject, discordConnection: await discordProfile(p.db, discordIdentity, p.config.discord), eligibleServerIds: p.gameServers({ ...subject, identityProvider, accessSuspended: false }, servers, new Date(), false).map(server => server.id) }))), nextCursor: rows.length > 50 ? rows[49]!.id : null };
}
export async function setMemberAccess(p: PassportService, req: Request, id: string, input: { suspended: boolean; restricted: boolean; serverIds: string[] }) {
  const actor = await adminContext(p, req, true);
  if (new Set(input.serverIds).size !== input.serverIds.length) throw new ForbiddenException({ code: 'invalid_server_scope' });
  return policyTransaction(p.db, async tx => {
    const current = await tx.subject.findUnique({ where: { id }, include: { minecraft: true } });
    if (!current || current.identityProvider !== 'usaint') throw new NotFoundException({ code: 'subject_not_found' });
    const records = await tx.serverRecord.findMany({ orderBy: { id: 'asc' } });
    const eligible = p.gameServers({ ...current, accessSuspended: false }, records, new Date(), false).map(server => server.id);
    if (input.serverIds.some(serverId => !eligible.includes(serverId))) throw new ForbiddenException({ code: 'invalid_server_scope' });
    await tx.subject.update({ where: { id }, data: { accessSuspended: input.suspended, scopeRestricted: input.restricted, scopeLimit: input.restricted ? input.serverIds : [] } });
    await refreshDiscordSubject(tx, id);
    if (current.minecraft) {
      const changed = await tx.minecraftIdentity.update({ where: { uuid: current.minecraft.uuid }, data: { policyVersion: { increment: 1 }, policyFingerprint: '' } });
      await tx.policyEvent.create({ data: { minecraftUuid: changed.uuid, policyVersion: changed.policyVersion } });
    }
    await tx.auditEvent.create({ data: { action: 'admin.access_changed', subjectId: id, actorSubjectId: actor.session.subjectId, details: { before: { suspended: current.accessSuspended, restricted: current.scopeRestricted, serverIds: current.scopeLimit }, after: input } } });
    return { updated: true };
  });
}
export async function unlinkMember(p: PassportService, req: Request, id: string) {
  const actor = await adminContext(p, req, true);
  return policyTransaction(p.db, async tx => {
    const minecraft = await tx.minecraftIdentity.findUnique({ where: { subjectId: id } });
    if (!minecraft) throw new NotFoundException({ code: 'minecraft_not_linked' });
    const changed = await tx.minecraftIdentity.update({ where: { uuid: minecraft.uuid }, data: { subjectId: null, policyVersion: { increment: 1 }, policyFingerprint: '' } });
    await refreshDiscordSubject(tx, id);
    await tx.linkSession.updateMany({ where: { minecraftUuid: minecraft.uuid, status: 'pending' }, data: { status: 'cancelled' } });
    await tx.policyEvent.create({ data: { minecraftUuid: changed.uuid, policyVersion: changed.policyVersion } });
    await tx.auditEvent.create({ data: { action: 'admin.minecraft_unlinked', subjectId: id, objectId: minecraft.uuid, actorSubjectId: actor.session.subjectId } });
    return { unlinked: true };
  });
}
export async function adminAudit(p: PassportService, req: Request) {
  await adminContext(p, req);
  return { events: await p.db.auditEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, action: true, subjectId: true, actorSubjectId: true, objectId: true, details: true, createdAt: true } }) };
}
