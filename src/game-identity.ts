import { managedGameActive } from './managed-development';
import { gameAdministrator } from './admin-permissions';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Prisma, Subject, PlayerPresence } from '@prisma/client';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import type { PassportService } from './passport.service';
import { policyTransaction } from './database';
import { privacyNotice, requireConsent, recordConsent, type ConsentInput } from './privacy';
import { refreshDiscordSubject } from './discord-policy';
import { universityName } from './integrations/usaint';

export async function gameConsent(tx: Prisma.TransactionClient, subjectId: string) {
  const managed = await tx.developmentMinecraftAccount.findUnique({ where: { subjectId }, include: { subject: { select: { identityProvider: true, accessSuspended: true, membershipStatus: true } } } });
  if (managed) return managedGameActive({ ...managed.subject, developmentAccount: managed });
  return Boolean(await tx.consentReceipt.findFirst({ where: { subjectId, version: { in: ['2026-10-01.4', privacyNotice.version] } }, select: { id: true } }));
}
export function gameName(name: string) { try { return universityName(name, false); } catch { return ''; } }
export function schoolActive(subject: Subject, now = new Date()) { return subject.identityProvider === 'usaint' && !subject.accessSuspended && subject.membershipStatus !== 'suspended' && Boolean(subject.universityVerifiedUntil && subject.universityVerifiedUntil > now); }
export function presenceDto(presence: PlayerPresence | null | undefined, servers: { id: string; label: string }[], now = new Date()) {
  const server = presence ? servers.find(row => row.id === presence.serverId) : null;
  const online = Boolean(presence && server && presence.expiresAt > now);
  return { online, serverId: online ? server!.id : null, serverLabel: online ? server!.label : null, lastSeenAt: server && presence ? presence.observedAt.toISOString() : null };
}
export async function renewPrivacyConsent(p: PassportService, req: Request, input: ConsentInput) {
  const context = await p.mutation(req), consent = requireConsent(input), subjectId = context.session.subjectId!;
  return policyTransaction(p.db, async tx => {
    if (!await tx.consentReceipt.findFirst({ where: { subjectId, version: privacyNotice.version }, select: { id: true } })) await recordConsent(tx, subjectId, 'privacy_renewal', randomUUID(), consent);
    await refreshDiscordSubject(tx, subjectId);
    const identity = await tx.minecraftIdentity.findUnique({ where: { subjectId } });
    if (identity) { const changed = await tx.minecraftIdentity.update({ where: { uuid: identity.uuid }, data: { policyVersion: { increment: 1 }, policyFingerprint: '' } }); await tx.policyEvent.create({ data: { minecraftUuid: changed.uuid, policyVersion: changed.policyVersion } }); }
    return { updated: true };
  });
}
export async function playerLookup(p: PassportService, req: Request, query: string) {
  p.service(req);
  const contains = { contains: query, mode: 'insensitive' as const };
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query);
  const identities = await p.db.minecraftIdentity.findMany({ where: { subjectId: { not: null }, OR: [{ name: contains }, { subject: { displayName: contains } }, ...(isUuid ? [{ uuid: query.toLowerCase() }] : [])] }, include: { subject: { include: { administrator: true, developmentAccount: true } } }, orderBy: [{ name: 'asc' }, { uuid: 'asc' }], take: 20 });
  const now = new Date();
  const players = await Promise.all(identities.map(async identity => {
    const subject = identity.subject!, consent = await gameConsent(p.db, subject.id), active = schoolActive(subject, now) || managedGameActive(subject);
    const presence = await p.db.playerPresence.findUnique({ where: { minecraftUuid: identity.uuid } });
    const online = Boolean(presence && presence.expiresAt > now);
    return { minecraftUuid: identity.uuid, minecraftName: identity.name, displayName: consent && active ? gameName(subject.displayName) : '', member: consent && active && subject.membershipStatus === 'active' && subject.verifiedUntil > now, admissionYear: consent && active ? subject.admissionYear : null, administrator: Boolean(schoolActive(subject, now) && gameAdministrator(subject.administrator)), online, serverId: online ? presence!.serverId : null, lastSeenAt: presence?.observedAt.toISOString() ?? null };
  }));
  return { players };
}
export async function reportPresence(p: PassportService, req: Request, input: { serverId: string; observedAt: string; players: string[] }) {
  p.service(req);
  const observedAt = new Date(input.observedAt), now = new Date();
  if (observedAt.getTime() < now.getTime() - 30_000 || observedAt.getTime() > now.getTime() + 10_000) throw new BadRequestException({ code: 'presence_observation_expired' });
  const expiresAt = new Date(observedAt.getTime() + 90_000);
  return policyTransaction(p.db, async tx => {
    const server = await tx.serverRecord.findUnique({ where: { id: input.serverId } });
    if (!server?.enabled) throw new ForbiddenException({ code: 'server_not_enabled' });
    const identities = await tx.minecraftIdentity.findMany({ where: { uuid: { in: input.players }, subjectId: { not: null } }, include: { subject: { include: { developmentAccount: true, discordIdentity: { select: { subjectId: true } } } } } });
    const allowed = [];
    for (const identity of identities) if (identity.subject && p.gameServers(identity.subject, [server], now).length && await gameConsent(tx, identity.subject.id)) allowed.push(identity);
    await tx.playerPresence.deleteMany({ where: { serverId: input.serverId, observedAt: { lte: observedAt }, minecraftUuid: { notIn: allowed.map(identity => identity.uuid) } } });
    for (const identity of allowed) {
      const previous = await tx.playerPresence.findUnique({ where: { minecraftUuid: identity.uuid } });
      if (!previous || previous.observedAt < observedAt) await tx.playerPresence.upsert({ where: { minecraftUuid: identity.uuid }, create: { minecraftUuid: identity.uuid, serverId: input.serverId, observedAt, expiresAt }, update: { serverId: input.serverId, observedAt, expiresAt } });
    }
    return { received: allowed.length, expiresAt: expiresAt.toISOString() };
  });
}
