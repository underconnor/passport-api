import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PrismaClient, ServerRecord, Subject } from '@prisma/client';
import type { Request } from 'express';
import type { ServerDefinition } from './config';
import type { PassportService } from './passport.service';
import { adminContext, requireAdminTransaction, protectAdministratorTarget } from './admin';
import { policyTransaction } from './database';

export type HeartbeatInput = { source: 'velocity' | 'paper'; servers: { id: string; label: string }[] };
export type ServerSettings = { commandName?: string; statisticsEnabled?: boolean; label: string; sensitive: boolean; enabled: boolean; accessMode: 'roster' | 'members' | 'selected' | 'university'; allowedSubjectIds: string[]; expectedUpdatedAt: string };
export type ScopeSubject = Pick<Subject, 'id' | 'allowedServerIds' | 'scopeRestricted' | 'scopeLimit' | 'accessSuspended' | 'membershipStatus' | 'verifiedUntil' | 'identityProvider' | 'universityVerifiedUntil'>;
type ScopeOptions = { now?: Date; allowDevelopment?: boolean; applyPersonalLimit?: boolean };
const maxServers = 64;

/** This is shared by policy, portal listings and the administrator's eligibility view. */
export function permittedServers(subject: ScopeSubject, servers: ServerRecord[], { now = new Date(), allowDevelopment = false, applyPersonalLimit = true }: ScopeOptions = {}) {
  const university = subject.identityProvider === 'usaint' && Boolean(subject.universityVerifiedUntil && subject.universityVerifiedUntil > now);
  const development = allowDevelopment && subject.identityProvider === 'development';
  if (subject.accessSuspended || subject.membershipStatus === 'suspended' || (!university && !development)) return [];
  const member = subject.membershipStatus === 'active' && subject.verifiedUntil > now;
  return servers.filter(server => server.enabled
    && (server.accessMode === 'university' ? university : member && (
      server.accessMode === 'roster' ? subject.allowedServerIds.includes(server.id)
        : server.accessMode === 'members' ? true
          : server.accessMode === 'selected' && server.allowedSubjectIds.includes(subject.id)))
    && (!applyPersonalLimit || !subject.scopeRestricted || subject.scopeLimit.includes(server.id)));
}

export function serverDto(server: ServerRecord, now = new Date()) {
  const fresh = (seen: Date | null) => Boolean(seen && seen <= now && now.getTime() - seen.getTime() < 90_000);
  return { statisticsEnabled: server.statisticsEnabled, id: server.id, commandName: server.commandName, label: server.label, sensitive: server.sensitive, enabled: server.enabled, accessMode: server.accessMode, allowedSubjectIds: server.allowedSubjectIds, paperSeenAt: server.paperSeenAt?.toISOString() ?? null, proxySeenAt: server.proxySeenAt?.toISOString() ?? null, online: fresh(server.paperSeenAt), proxyAvailable: fresh(server.proxySeenAt), createdAt: server.createdAt.toISOString(), updatedAt: server.updatedAt.toISOString() };
}

export async function seedServerRegistry(db: PrismaClient, configured: ServerDefinition[]) {
  await policyTransaction(db, async tx => {
    if (await tx.serverRecord.count() !== 0) return;
    await tx.serverRecord.createMany({ data: configured.map(server => ({ id: server.id, commandName: server.id, label: server.label, sensitive: server.sensitive ?? false, enabled: true, statisticsEnabled: server.id !== 'ssu_lobby', accessMode: 'roster' })) });
  });
}

export async function heartbeatServers(p: PassportService, req: Request, input: HeartbeatInput) {
  p.service(req);
  return policyTransaction(p.db, async tx => {
    const existing = await tx.serverRecord.findMany({ select: { id: true, commandName: true } });
    const ids = new Set(existing.map(server => server.id));
    const newServers = input.servers.filter(server => !ids.has(server.id));
    if (ids.size + newServers.length > maxServers) throw new ConflictException({ code: 'registry_full' });
    // A new immutable ID must not take another server's administrator-selected command.
    if (newServers.some(server => existing.some(other => other.commandName === server.id))) throw new ConflictException({ code: 'server_command_conflict' });
    const seen = input.source === 'paper' ? { paperSeenAt: new Date() } : { proxySeenAt: new Date() };
    for (const server of input.servers) {
      if (ids.has(server.id)) await tx.serverRecord.update({ where: { id: server.id }, data: seen });
      else await tx.serverRecord.create({ data: { id: server.id, commandName: server.id, label: server.label, enabled: false, statisticsEnabled: server.id !== 'ssu_lobby', accessMode: 'roster', ...seen } });
    }
    return { received: input.servers.length, registered: newServers.length };
  });
}

export async function adminServers(p: PassportService, req: Request) {
  await adminContext(p, req);
  const now = new Date();
  return { servers: (await p.db.serverRecord.findMany({ orderBy: { id: 'asc' } })).map(server => serverDto(server, now)) };
}

export async function setServerSettings(p: PassportService, req: Request, id: string, input: ServerSettings) {
  const actor = await adminContext(p, req, true);
  return policyTransaction(p.db, async tx => {
    await requireAdminTransaction(p, tx, actor);
    const previous = await tx.serverRecord.findUnique({ where: { id } });
    if (!previous) throw new NotFoundException({ code: 'server_not_found' });
    if (previous.updatedAt.getTime() !== new Date(input.expectedUpdatedAt).getTime()) throw new ConflictException({ code: 'server_changed' });
    if (input.allowedSubjectIds.length && await tx.subject.count({ where: { id: { in: input.allowedSubjectIds }, identityProvider: 'usaint' } }) !== input.allowedSubjectIds.length) throw new ForbiddenException({ code: 'invalid_selected_subjects' });
    const { expectedUpdatedAt: _expected, ...requested } = input;
    const settings = { ...requested, commandName: input.commandName ?? previous.commandName };
    // Keep command names unique across both administrator names and legacy immutable IDs.
    if (await tx.serverRecord.findFirst({ where: { id: { not: id }, OR: [{ commandName: settings.commandName }, { id: settings.commandName }] }, select: { id: true } })) throw new ConflictException({ code: 'server_command_conflict' });
    const updatedAt = new Date(Math.max(Date.now(), previous.updatedAt.getTime() + 1));
    const updated = await tx.serverRecord.update({ where: { id }, data: { ...settings, updatedAt } });
    // A registry change can affect every linked member, including explicit per-user limits.
    const identities = await tx.minecraftIdentity.findMany({ where: { subjectId: { not: null } }, select: { uuid: true } });
    for (const identity of identities) {
      const changed = await tx.minecraftIdentity.update({ where: { uuid: identity.uuid }, data: { policyVersion: { increment: 1 }, policyFingerprint: '', ...(settings.statisticsEnabled !== undefined && settings.statisticsEnabled !== previous.statisticsEnabled ? { telemetryEpoch: randomUUID() } : {}) } });
      await tx.policyEvent.create({ data: { minecraftUuid: changed.uuid, policyVersion: changed.policyVersion } });
    }
    const before = { commandName: previous.commandName, statisticsEnabled: previous.statisticsEnabled, label: previous.label, sensitive: previous.sensitive, enabled: previous.enabled, accessMode: previous.accessMode, allowedSubjectIds: previous.allowedSubjectIds };
    await tx.auditEvent.create({ data: { action: 'admin.server_updated', actorSubjectId: actor.session.subjectId, objectId: id, details: { before, after: settings } } });
    return { server: serverDto(updated) };
  });
}
