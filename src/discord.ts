import { ConflictException, ForbiddenException, GoneException, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { Prisma, type DiscordLinkSession } from '@prisma/client';
import type { Request } from 'express';
import type { PassportService } from './passport.service';
import { adminContext } from './admin';
import { policyTransaction } from './database';
import { discordEntitlement, refreshDiscordRole } from './discord-policy';
import { equal, hash, opaqueToken } from './security';
import { ConsentInput, recordConsent, requireConsent } from './privacy';

async function discordConflict<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const target = Array.isArray(error.meta?.target) ? error.meta.target.join(',') : '';
      if (target === 'interactionHash') throw new ConflictException({ code: 'discord_interaction_consumed' });
      if (target === 'subjectId,version,source,contextId') throw new ConflictException({ code: 'discord_link_consumed' });
      if (target === 'subjectId' || target === 'discordUserId') throw new ConflictException({ code: 'discord_already_linked' });
    }
    throw error;
  }
}
export function discordService(p: PassportService, req: Request) {
  const config = p.config.discord;
  if (!config) throw new ServiceUnavailableException({ code: 'discord_not_configured' });
  const bearer = req.headers.authorization;
  if (!bearer?.startsWith('Bearer ') || !equal(bearer.slice(7), config.serviceToken)) throw new UnauthorizedException({ code: 'discord_service_unauthorized' });
  return config;
}
function configuredGuild(p: PassportService, guildId: string) {
  if (!p.config.discord) throw new ServiceUnavailableException({ code: 'discord_not_configured' });
  if (guildId !== p.config.discord.guildId) throw new ForbiddenException({ code: 'discord_guild_mismatch' });
  return p.config.discord;
}
export function discordLinkState(link: DiscordLinkSession | null, token: string, pending = false) {
  if (!link || !equal(link.tokenHash, hash(token))) throw new NotFoundException({ code: 'discord_link_not_found' });
  if (link.expiresAt <= new Date()) throw new GoneException({ code: 'discord_link_expired' });
  if (link.status === 'cancelled' || (pending && link.status !== 'pending')) throw new ConflictException({ code: 'discord_link_consumed' });
  return link;
}
const summary = (link: DiscordLinkSession) => ({ id: link.id, status: link.status, expiresAt: link.expiresAt.toISOString() });

export async function createDiscordLink(p: PassportService, req: Request, input: { discordUserId: string; guildId: string; discordUsername: string; discordDisplayName?: string; interactionId: string }) {
  discordService(p, req); configuredGuild(p, input.guildId);
  const token = opaqueToken();
  const link = await discordConflict(() => policyTransaction(p.db, async tx => {
    if (await tx.discordLinkSession.findUnique({ where: { interactionHash: hash(input.interactionId) } })) throw new ConflictException({ code: 'discord_interaction_consumed' });
    if ((await tx.discordIdentity.findUnique({ where: { discordUserId: input.discordUserId } }))?.subjectId) throw new ConflictException({ code: 'discord_already_linked' });
    await tx.discordLinkSession.updateMany({ where: { discordUserId: input.discordUserId, guildId: input.guildId, status: 'pending' }, data: { status: 'cancelled' } });
    return tx.discordLinkSession.create({ data: { tokenHash: hash(token), interactionHash: hash(input.interactionId), discordUserId: input.discordUserId, guildId: input.guildId, username: input.discordUsername, displayName: input.discordDisplayName ?? input.discordUsername, expiresAt: new Date(Date.now() + 300000) } });
  }));
  return { id: link.id, url: `${p.config.webOrigin}/discord/link/${link.id}#token=${token}`, expiresAt: link.expiresAt.toISOString() };
}

export async function inspectDiscordLink(p: PassportService, req: Request, id: string, token: string) {
  await p.mutation(req, false);
  const link = discordLinkState(await p.db.discordLinkSession.findUnique({ where: { id } }), token);
  configuredGuild(p, link.guildId);
  if (link.status === 'linked') {
    const identity = await p.db.discordIdentity.findUnique({ where: { discordUserId: link.discordUserId } });
    if (!link.subjectId || identity?.subjectId !== link.subjectId) throw new ConflictException({ code: 'discord_link_consumed' });
  }
  return { ...summary(link), discordId: link.discordUserId, username: link.username, displayName: link.displayName };
}

async function confirmDiscordLinkInTransaction(p: PassportService, tx: Prisma.TransactionClient, id: string, token: string, subjectId: string, webSessionId: string, consent: { version: string; acceptedAt: Date }) {
  const link = discordLinkState(await tx.discordLinkSession.findUnique({ where: { id } }), token, true);
  const config = configuredGuild(p, link.guildId);
  const session = await tx.webSession.findUnique({ where: { id: webSessionId } });
  if (!session || session.subjectId !== subjectId || session.expiresAt <= new Date()) throw new UnauthorizedException({ code: 'confirming_session_expired' });
  const subject = await tx.subject.findUnique({ where: { id: subjectId } });
  const entitlement = discordEntitlement(subject);
  if (!entitlement.desired) throw new ForbiddenException({ code: 'membership_required' });
  const existingUser = await tx.discordIdentity.findUnique({ where: { discordUserId: link.discordUserId } });
  const existingSubject = await tx.discordIdentity.findUnique({ where: { subjectId } });
  if (existingUser?.subjectId || existingSubject) throw new ConflictException({ code: 'discord_already_linked' });
  const now = new Date();
  await recordConsent(tx, subjectId, 'discord_link', id, consent);
  const data = { guildId: link.guildId, username: link.username, displayName: link.displayName, subjectId, verifiedAt: now };
  await tx.discordIdentity.upsert({ where: { discordUserId: link.discordUserId }, create: { discordUserId: link.discordUserId, ...data }, update: data });
  await tx.discordRoleState.upsert({ where: { discordUserId_guildId_roleId: { discordUserId: link.discordUserId, guildId: link.guildId, roleId: config.roleId } }, create: { discordUserId: link.discordUserId, guildId: link.guildId, roleId: config.roleId, ...entitlement }, update: { ...entitlement, version: { increment: 1 }, nextAttemptAt: now, attempts: 0, lastError: null } });
  const completed = await tx.discordLinkSession.update({ where: { id }, data: { status: 'linked', subjectId, completedAt: now } });
  await tx.auditEvent.create({ data: { action: 'discord.linked', subjectId, objectId: link.id } });
  return summary(completed);
}
export function confirmDiscordLink(p: PassportService, tx: Prisma.TransactionClient, id: string, token: string, subjectId: string, webSessionId: string, consent: { version: string; acceptedAt: Date }) {
  return discordConflict(() => confirmDiscordLinkInTransaction(p, tx, id, token, subjectId, webSessionId, consent));
}
export async function webConfirmDiscord(p: PassportService, req: Request, id: string, token: string, input?: ConsentInput) {
  const c = await p.mutation(req);
  const consent = requireConsent(input);
  return policyTransaction(p.db, tx => confirmDiscordLink(p, tx, id, token, c.session.subjectId!, c.session.id, consent));
}

export async function unlinkDiscord(p: PassportService, req: Request, subjectId: string) {
  const actor = await adminContext(p, req, true);
  return policyTransaction(p.db, async tx => {
    const subject = await tx.subject.findUnique({ where: { id: subjectId } });
    if (!subject) throw new NotFoundException({ code: 'member_not_found' });
    const identity = await tx.discordIdentity.findUnique({ where: { subjectId }, include: { roles: true } });
    if (identity) {
      await tx.discordIdentity.update({ where: { discordUserId: identity.discordUserId }, data: { subjectId: null } });
      for (const role of identity.roles) await refreshDiscordRole(tx, role, null);
      await tx.discordLinkSession.updateMany({ where: { discordUserId: identity.discordUserId, status: 'pending' }, data: { status: 'cancelled' } });
    }
    await tx.subject.update({ where: { id: subjectId }, data: { discordId: null, discordUpdatedAt: null } });
    await tx.auditEvent.create({ data: { action: 'admin.discord_unlinked', subjectId, actorSubjectId: actor.session.subjectId } });
    return { unlinked: true };
  });
}

export async function claimDiscordRoles(p: PassportService, req: Request, input: { guildId: string; limit: number }) {
  discordService(p, req); configuredGuild(p, input.guildId);
  return policyTransaction(p.db, async tx => {
    const now = new Date();
    const candidates = await tx.discordRoleState.findMany({ where: { guildId: input.guildId, AND: [ { OR: [{ nextAttemptAt: { lte: now } }, { desired: true, validUntil: { lte: now } }] }, { OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] } ] }, orderBy: { nextAttemptAt: 'asc' }, take: input.limit, include: { identity: { include: { subject: true } } } });
    const jobs = [];
    for (const candidate of candidates) {
      const role = await refreshDiscordRole(tx, candidate, candidate.identity.subject, now);
      const leaseToken = opaqueToken();
      const expiresAt = new Date(Math.min(now.getTime() + 60000, role.desired && role.validUntil ? role.validUntil.getTime() : Infinity));
      await tx.discordRoleState.update({ where: { id: role.id }, data: { leaseHash: hash(leaseToken), leaseUntil: expiresAt } });
      jobs.push({ id: role.id, leaseToken, guildId: role.guildId, discordUserId: role.discordUserId, roleId: role.roleId, desired: role.desired, version: role.version.toString(), expiresAt: expiresAt.toISOString() });
    }
    return { jobs };
  });
}

export async function ackDiscordRole(p: PassportService, req: Request, id: string, input: { leaseToken: string; version: string; outcome: 'applied' | 'retry' | 'member_absent' | 'configuration_error' }) {
  const config = discordService(p, req);
  const result = await policyTransaction(p.db, async tx => {
    const current = await tx.discordRoleState.findUnique({ where: { id }, include: { identity: { include: { subject: true } } } });
    if (!current || current.guildId !== config.guildId) throw new NotFoundException({ code: 'discord_role_not_found' });
    const now = new Date();
    if (!current.leaseHash || !equal(current.leaseHash, hash(input.leaseToken)) || !current.leaseUntil || current.leaseUntil <= now) return false;
    const role = await refreshDiscordRole(tx, current, current.identity.subject, now);
    if (role.version.toString() !== input.version) {
      await tx.discordRoleState.update({ where: { id }, data: { leaseHash: null, leaseUntil: null, nextAttemptAt: now } });
      return false;
    }
    const absentRevocation = input.outcome === 'member_absent' && !role.desired;
    const applied = input.outcome === 'applied' || absentRevocation;
    const attempts = applied ? 0 : Math.min(role.attempts + 1, 16);
    const delay = applied || input.outcome === 'member_absent' ? 60000 : input.outcome === 'configuration_error' ? 300000 : Math.min(5000 * 2 ** (attempts - 1), 300000);
    await tx.discordRoleState.update({ where: { id }, data: { leaseHash: null, leaseUntil: null, nextAttemptAt: new Date(now.getTime() + delay), attempts, lastError: applied ? null : input.outcome, ...(applied ? { appliedDesired: role.desired, appliedVersion: role.version, appliedAt: now } : {}) } });
    return true;
  });
  if (!result) throw new ConflictException({ code: 'discord_lease_stale' });
}
