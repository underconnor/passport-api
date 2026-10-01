import type { Config } from './config';
import type { DiscordIdentity, DiscordRoleState, Prisma, Subject, DiscordGuildSettings } from '@prisma/client';
import { privacyNotice } from './privacy';
import { universityName } from './integrations/usaint';

export function discordEntitlement(subject: Subject | null, now = new Date()) {
  const validUntil = subject?.universityVerifiedUntil ?? null;
  return { desired: Boolean(subject && subject.identityProvider === 'usaint' && !subject.accessSuspended && subject.membershipStatus !== 'suspended' && validUntil && validUntil > now), validUntil };
}
export function discordMemberEntitlement(subject: Subject | null, now = new Date()) {
  const school = discordEntitlement(subject, now);
  const validUntil = school.validUntil && subject ? new Date(Math.min(school.validUntil.getTime(), subject.verifiedUntil.getTime())) : null;
  return { desired: Boolean(school.desired && subject?.membershipStatus === 'active' && validUntil && validUntil > now), validUntil };
}
export function discordNickname(name: string, minecraftName?: string) {
  let realName: string;
  try { realName = universityName(name, false); } catch { return null; }
  const game = minecraftName && /^[A-Za-z0-9_]{1,16}$/.test(minecraftName) ? minecraftName : '';
  const suffix = game ? ` / ${game}` : '';
  const real = Array.from(realName).slice(0, 32 - Array.from(suffix).length).join('');
  return real ? `${real}${suffix}` : null;
}
export async function managementConsent(tx: Prisma.TransactionClient, subjectId: string) {
  return Boolean(await tx.consentReceipt.findFirst({ where: { subjectId, version: privacyNotice.version }, select: { id: true } }));
}
async function recordSemester(tx: Prisma.TransactionClient, subject: Subject, settings: DiscordGuildSettings, consent: boolean, now: Date) {
  if (!consent || !settings.currentSemester || subject.identityProvider !== 'usaint' || subject.membershipStatus !== 'active' || subject.verifiedUntil <= now) return;
  const saved = await tx.membershipSemester.createMany({ data: [{ subjectId: subject.id, guildId: settings.guildId, semester: settings.currentSemester }], skipDuplicates: true });
  if (saved.count) await tx.auditEvent.create({ data: { action: 'discord.semester_recorded', subjectId: subject.id, objectId: settings.currentSemester } });
}

/** Called under the policy writer lock; evidence survives leaving and relinking. */
export async function refreshDiscordSubject(tx: Prisma.TransactionClient, subjectId: string, now = new Date()) {
  const subject = await tx.subject.findUnique({ where: { id: subjectId } });
  if (!subject) return;
  const consent = await managementConsent(tx, subjectId);
  for (const settings of await tx.discordGuildSettings.findMany()) await recordSemester(tx, subject, settings, consent, now);
  const identity = await tx.discordIdentity.findUnique({ where: { subjectId } });
  if (identity) await projectDiscordIdentity(tx, identity.discordUserId, now);
}
export async function projectDiscordIdentity(tx: Prisma.TransactionClient, discordUserId: string, now = new Date()) {
  const identity = await tx.discordIdentity.findUnique({ where: { discordUserId }, include: { subject: { include: { minecraft: true } }, roles: true, nicknames: true } });
  if (!identity) return;
  const settings = await tx.discordGuildSettings.findUnique({ where: { guildId: identity.guildId }, include: { semesterRoles: true } });
  if (!settings) return;
  const subject = identity.subject, consent = subject ? await managementConsent(tx, subject.id) : false;
  if (subject) await recordSemester(tx, subject, settings, consent, now);
  const school = discordEntitlement(subject, now), member = discordMemberEntitlement(subject, now);
  const history = subject ? await tx.membershipSemester.findMany({ where: { subjectId: subject.id, guildId: identity.guildId } }) : [];
  const plans = new Map<string, { kind: string; semester: string | null; desired: boolean; validUntil: Date | null }>();
  plans.set(settings.verificationRoleId, { kind: 'verification', semester: null, ...school });
  if (settings.memberRoleId) plans.set(settings.memberRoleId, { kind: 'member', semester: null, ...member, desired: consent && member.desired });
  for (const mapping of settings.semesterRoles) if (history.some(row => row.semester === mapping.semester)) plans.set(mapping.roleId, { kind: 'semester', semester: mapping.semester, ...school, desired: consent && school.desired });
  for (const existing of identity.roles) if (!plans.has(existing.roleId)) plans.set(existing.roleId, { kind: existing.kind, semester: existing.semester, desired: false, validUntil: null });
  for (const [roleId, plan] of plans) {
    const existing = identity.roles.find(row => row.guildId === identity.guildId && row.roleId === roleId);
    if (!existing) await tx.discordRoleState.create({ data: { discordUserId, guildId: identity.guildId, roleId, ...plan } });
    else await tx.discordRoleState.update({ where: { id: existing.id }, data: { desired: plan.desired, validUntil: plan.validUntil,
      ...(existing.desired !== plan.desired ? { version: { increment: 1 }, nextAttemptAt: now, attempts: 0, lastError: null } : {}),
    } });
  }
  const nickname = consent && settings.nicknameEnabled && school.desired && subject ? discordNickname(subject.displayName, subject.minecraft?.name) : null;
  const existing = identity.nicknames.find(row => row.guildId === identity.guildId);
  if (!existing && nickname !== null) await tx.discordNicknameState.create({ data: { discordUserId, guildId: identity.guildId, nickname, validUntil: school.validUntil } });
  else if (existing) await tx.discordNicknameState.update({ where: { id: existing.id }, data: { nickname, validUntil: nickname ? school.validUntil : null,
    ...(existing.nickname !== nickname ? { version: { increment: 1 }, nextAttemptAt: now, attempts: 0, lastError: null } : {}),
  } });
}
export async function refreshDiscordRole(tx: Prisma.TransactionClient, role: DiscordRoleState, _subject: Subject | null, now = new Date()) {
  await projectDiscordIdentity(tx, role.discordUserId, now);
  return tx.discordRoleState.findUniqueOrThrow({ where: { id: role.id } });
}
export function roleStatus(role?: DiscordRoleState) {
  const applied = role && role.appliedVersion === role.version && role.appliedDesired === role.desired;
  return { status: role?.lastError ? 'failed' : applied ? role!.desired ? 'granted' : 'revoked' : 'pending', updatedAt: role?.appliedAt?.toISOString() ?? null, lastError: role?.lastError ?? null };
}
export function discordConnection(identity: (DiscordIdentity & { roles: DiscordRoleState[] }) | null, config?: Config['discord']) {
  if (!identity?.subjectId) return null;
  const role = config ? identity.roles.find(row => row.guildId === config.guildId && row.roleId === config.roleId) : identity.roles.length === 1 ? identity.roles[0] : undefined;
  const status = roleStatus(role);
  return { discordId: identity.discordUserId, username: identity.username, displayName: identity.displayName, linkedAt: identity.verifiedAt.toISOString(), roleStatus: status.status, roleUpdatedAt: status.updatedAt };
}
export async function discordProfile(tx: Prisma.TransactionClient, identity: (DiscordIdentity & { roles: DiscordRoleState[] }) | null, config?: Config['discord']) {
  const base = discordConnection(identity, config);
  if (!base || !identity?.subjectId) return null;
  const settings = await tx.discordGuildSettings.findUnique({ where: { guildId: identity.guildId }, include: { semesterRoles: true } });
  const history = await tx.membershipSemester.findMany({ where: { subjectId: identity.subjectId, guildId: identity.guildId }, orderBy: { semester: 'asc' } });
  const nickname = await tx.discordNicknameState.findUnique({ where: { discordUserId_guildId: { discordUserId: identity.discordUserId, guildId: identity.guildId } } });
  const applied = nickname && nickname.appliedVersion === nickname.version && nickname.appliedNickname === nickname.nickname;
  const roles = identity.roles.filter(role => role.guildId === identity.guildId);
  return { ...base, managementConsentRequired: !await managementConsent(tx, identity.subjectId), membershipSemesters: history.map(row => row.semester),
    roles: { verification: roleStatus(roles.find(role => role.roleId === settings?.verificationRoleId)), member: settings?.memberRoleId ? roleStatus(roles.find(role => role.roleId === settings.memberRoleId)) : null,
      semesters: roles.filter(role => role.kind === 'semester' && settings?.semesterRoles.some(mapping => mapping.roleId === role.roleId && mapping.semester === role.semester)).map(role => ({ semester: role.semester!, ...roleStatus(role) })) },
    nickname: nickname ? { desired: nickname.nickname, status: nickname.lastError ? 'failed' : applied ? !settings?.nicknameEnabled && nickname.nickname === null ? 'disabled' : 'applied' : 'pending', updatedAt: nickname.appliedAt?.toISOString() ?? null, lastError: nickname.lastError } : null };
}
