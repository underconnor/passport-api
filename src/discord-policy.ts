import type { Config } from './config';
import type { DiscordIdentity, DiscordRoleState, Prisma, Subject } from '@prisma/client';

export function discordEntitlement(subject: Subject | null, now = new Date()) {
  const validUntil = subject?.universityVerifiedUntil && subject.verifiedUntil
    ? new Date(Math.min(subject.universityVerifiedUntil.getTime(), subject.verifiedUntil.getTime())) : null;
  return { desired: Boolean(subject && subject.identityProvider === 'usaint' && subject.membershipStatus === 'active' && !subject.accessSuspended && validUntil && validUntil > now), validUntil };
}

/** Called in the same policy transaction as the membership/administrator write. */
export async function refreshDiscordSubject(tx: Prisma.TransactionClient, subjectId: string, now = new Date()) {
  const identity = await tx.discordIdentity.findUnique({ where: { subjectId }, include: { subject: true, roles: true } });
  if (!identity) return;
  for (const role of identity.roles) await refreshDiscordRole(tx, role, identity.subject, now);
}

export async function refreshDiscordRole(tx: Prisma.TransactionClient, role: DiscordRoleState, subject: Subject | null, now = new Date()) {
  const next = discordEntitlement(subject, now);
  const changed = next.desired !== role.desired;
  // Keep an in-flight lease: a second worker must not race an older Discord REST write.
  return tx.discordRoleState.update({ where: { id: role.id }, data: {
    ...next, ...(changed ? { version: { increment: 1 }, nextAttemptAt: now, attempts: 0, lastError: null } : {}),
  } });
}

export function discordConnection(identity: (DiscordIdentity & { roles: DiscordRoleState[] }) | null, config?: Config['discord']) {
  if (!identity?.subjectId) return null;
  const role = config ? identity.roles.find(row => row.guildId === config.guildId && row.roleId === config.roleId) : identity.roles.length === 1 ? identity.roles[0] : undefined;
  const applied = role && role.appliedVersion === role.version && role.appliedDesired === role.desired;
  const roleStatus = role?.lastError ? 'failed' : applied ? role.desired ? 'granted' : 'revoked' : 'pending';
  return { discordId: identity.discordUserId, username: identity.username, displayName: identity.displayName, linkedAt: identity.verifiedAt.toISOString(), roleStatus, roleUpdatedAt: role?.appliedAt?.toISOString() ?? null };
}
