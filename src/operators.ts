import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma, type OperatorInvitation, type Subject } from '@prisma/client';
import type { Request } from 'express';
import type { PassportService } from './passport.service';
import { adminContext, requireAdminTransaction, schoolContext } from './admin';
import { adminPermissions, type AdminRole } from './admin-permissions';
import { policyTransaction } from './database';
import { verifiedStudentId } from './school-identity';
import { hash } from './security';

const invitationLifetime = 24 * 60 * 60_000;
function invitationDto(row: OperatorInvitation & { subject: Subject }, now = new Date()) {
  return { id: row.id, subjectId: row.subjectId, displayName: row.subject.displayName, role: row.role, status: row.status === 'pending' && row.expiresAt <= now ? 'expired' : row.status, expiresAt: row.expiresAt.toISOString(), createdAt: row.createdAt.toISOString() };
}
function schoolVerified(subject: Subject | null, now: Date) { return Boolean(subject?.identityProvider === 'usaint' && subject.universityVerifiedUntil && subject.universityVerifiedUntil > now); }
async function invalidateGamePolicy(tx: Prisma.TransactionClient, subjectId: string) {
  const identity = await tx.minecraftIdentity.findUnique({ where: { subjectId } });
  if (!identity) return;
  const changed = await tx.minecraftIdentity.update({ where: { uuid: identity.uuid }, data: { policyVersion: { increment: 1 }, policyFingerprint: '' } });
  await tx.policyEvent.create({ data: { minecraftUuid: changed.uuid, policyVersion: changed.policyVersion } });
}
async function invalidateAuthority(p: PassportService, tx: Prisma.TransactionClient, subjectId: string, keepSessionId?: string) {
  await tx.webSession.deleteMany({ where: { subjectId, audienceHost: new URL(p.config.adminOrigin).host, ...(keepSessionId ? { id: { not: keepSessionId } } : {}) } });
  await tx.webSession.updateMany({ where: { subjectId }, data: { mfaVerifiedUntil: null } });
  await invalidateGamePolicy(tx, subjectId);
}
export async function listOperators(p: PassportService, req: Request) {
  await adminContext(p, req, false, 'manageOperators');
  const [operators, invitations] = await p.db.$transaction([
    p.db.administrator.findMany({ include: { subject: true }, orderBy: [{ createdAt: 'asc' }, { subjectId: 'asc' }] }),
    p.db.operatorInvitation.findMany({ include: { subject: true }, orderBy: { createdAt: 'desc' }, take: 100 }),
  ]);
  return { operators: operators.map(row => ({ subjectId: row.subjectId, displayName: row.subject.displayName, studentId: verifiedStudentId(row.subject, p.config.encryptionKey), role: row.role, enabled: adminPermissions(row).read, createdAt: row.createdAt.toISOString() })), invitations: invitations.map(row => invitationDto(row)) };
}
export async function inviteOperator(p: PassportService, req: Request, input: { subjectId: string; role: AdminRole }) {
  const actor = await adminContext(p, req, true, 'manageOperators');
  return policyTransaction(p.db, async tx => {
    await requireAdminTransaction(p, tx, actor, 'manageOperators');
    if (input.subjectId === actor.session.subjectId) throw new ConflictException({ code: 'self_admin_change_forbidden' });
    const now = new Date(), subject = await tx.subject.findUnique({ where: { id: input.subjectId }, include: { administrator: true } });
    if (!schoolVerified(subject, now)) throw new ForbiddenException({ code: 'target_university_login_required' });
    if (adminPermissions(subject!.administrator).read) throw new ConflictException({ code: 'operator_already_enrolled' });
    await tx.operatorInvitation.updateMany({ where: { subjectId: input.subjectId, status: 'pending', expiresAt: { lte: now } }, data: { status: 'revoked', revokedAt: now } });
    if (await tx.operatorInvitation.findFirst({ where: { subjectId: input.subjectId, status: 'pending' } })) throw new ConflictException({ code: 'invitation_pending' });
    const invitation = await tx.operatorInvitation.create({ data: { ...input, issuerSubjectId: actor.session.subjectId!, expiresAt: new Date(now.getTime() + invitationLifetime) }, include: { subject: true } });
    await tx.auditEvent.create({ data: { action: 'admin.operator_invited', subjectId: input.subjectId, actorSubjectId: actor.session.subjectId, objectId: invitation.id, details: { role: input.role, expiresAt: invitation.expiresAt.toISOString() } } });
    return { invitation: invitationDto(invitation) };
  }).catch(error => {
    // A concurrent SERIALIZABLE snapshot can encounter the partial unique index before a retry.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException({ code: 'invitation_pending' });
    throw error;
  });
}
export async function pendingOperatorInvitations(p: PassportService, req: Request) {
  const c = await schoolContext(p, req);
  const invitations = await p.db.operatorInvitation.findMany({ where: { subjectId: c.session.subjectId!, status: 'pending', expiresAt: { gt: new Date() }, issuer: { administrator: { enabled: true, role: 'owner', revokedAt: null } } }, include: { subject: true }, orderBy: { createdAt: 'desc' } });
  return { invitations: invitations.map(row => invitationDto(row)) };
}
export async function acceptOperatorInvitation(p: PassportService, req: Request, id: string) {
  const c = await schoolContext(p, req, true);
  // Multi-operator TOTP seed enrollment/recovery needs its own reviewed flow. Never bypass configured MFA.
  if (p.config.adminMfaRequired) throw new ForbiddenException({ code: 'mfa_enrollment_unavailable' });
  return policyTransaction(p.db, async tx => {
    const session = await tx.webSession.findUnique({ where: { id: c.session.id }, include: { subject: true } }), now = new Date();
    if (!session || session.tokenHash !== hash(c.token) || session.expiresAt <= now || !schoolVerified(session.subject, now)) throw new ForbiddenException({ code: 'university_login_required' });
    const invitation = await tx.operatorInvitation.findUnique({ where: { id } });
    if (!invitation || invitation.subjectId !== session.subjectId) throw new NotFoundException({ code: 'invitation_not_found' });
    if (invitation.status !== 'pending') throw new ConflictException({ code: 'invitation_unavailable' });
    if (invitation.expiresAt <= now) throw new ConflictException({ code: 'invitation_expired' });
    const issuer = await tx.administrator.findUnique({ where: { subjectId: invitation.issuerSubjectId }, include: { subject: true } });
    if (!adminPermissions(issuer).manageOperators || !schoolVerified(issuer?.subject ?? null, now)) throw new ConflictException({ code: 'invitation_unavailable' });
    if (adminPermissions(await tx.administrator.findUnique({ where: { subjectId: invitation.subjectId } })).read) throw new ConflictException({ code: 'operator_already_enrolled' });
    await tx.operatorInvitation.update({ where: { id }, data: { status: 'accepted', acceptedAt: now } });
    await tx.administrator.upsert({ where: { subjectId: invitation.subjectId }, create: { subjectId: invitation.subjectId, role: invitation.role, enabled: true, totpSecret: '' }, update: { role: invitation.role, enabled: true, revokedAt: null, totpSecret: '', lastTotpStep: -1, failedAttempts: 0, lockedUntil: null } });
    await invalidateAuthority(p, tx, invitation.subjectId, session.id);
    await tx.auditEvent.create({ data: { action: 'admin.operator_invitation_accepted', subjectId: invitation.subjectId, actorSubjectId: invitation.subjectId, objectId: id, details: { role: invitation.role, issuerSubjectId: invitation.issuerSubjectId } } });
    return { accepted: true, role: invitation.role };
  });
}
export async function cancelOperatorInvitation(p: PassportService, req: Request, id: string) {
  const actor = await adminContext(p, req, true, 'manageOperators');
  return policyTransaction(p.db, async tx => {
    await requireAdminTransaction(p, tx, actor, 'manageOperators');
    const invitation = await tx.operatorInvitation.findUnique({ where: { id } });
    if (!invitation) throw new NotFoundException({ code: 'invitation_not_found' });
    if (invitation.status !== 'pending') throw new ConflictException({ code: 'invitation_unavailable' });
    await tx.operatorInvitation.update({ where: { id }, data: { status: 'revoked', revokedAt: new Date() } });
    await tx.auditEvent.create({ data: { action: 'admin.operator_invitation_revoked', subjectId: invitation.subjectId, actorSubjectId: actor.session.subjectId, objectId: id } });
    return { revoked: true };
  });
}
export async function changeOperator(p: PassportService, req: Request, subjectId: string, role: AdminRole | null) {
  const actor = await adminContext(p, req, true, 'manageOperators');
  return policyTransaction(p.db, async tx => {
    await requireAdminTransaction(p, tx, actor, 'manageOperators');
    if (subjectId === actor.session.subjectId) throw new ConflictException({ code: 'self_admin_change_forbidden' });
    const target = await tx.administrator.findUnique({ where: { subjectId } });
    if (!adminPermissions(target).read) throw new NotFoundException({ code: 'operator_not_found' });
    if (target!.role === 'owner' && role !== 'owner' && await tx.administrator.count({ where: { enabled: true, revokedAt: null, role: 'owner' } }) <= 1) throw new ConflictException({ code: 'last_owner' });
    if (role === target!.role) return { updated: true };
    await tx.administrator.update({ where: { subjectId }, data: role ? { role } : { enabled: false, revokedAt: new Date(), totpSecret: '', lastTotpStep: -1 } });
    if (role !== 'owner') await tx.operatorInvitation.updateMany({ where: { issuerSubjectId: subjectId, status: 'pending' }, data: { status: 'revoked', revokedAt: new Date() } });
    await invalidateAuthority(p, tx, subjectId);
    await tx.auditEvent.create({ data: { action: role ? 'admin.operator_role_changed' : 'admin.operator_revoked', subjectId, actorSubjectId: actor.session.subjectId, details: { previousRole: target!.role, role } } });
    return role ? { updated: true } : { revoked: true };
  });
}
