import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Request } from 'express';
import { Prisma } from '@prisma/client';
import type { DevelopmentMinecraftAccount, Subject, MinecraftIdentity, ServerRecord, PlayerPresence } from '@prisma/client';
import type { PassportService } from './passport.service';
import { adminContext, requireAdminTransaction } from './admin';
import { policyTransaction } from './database';
import { presenceDto } from './game-identity';
import { managedDevelopmentName, managedDevelopmentProvider } from './managed-development';
import { resolveMinecraftProfile } from './integrations/minecraft-profile';

export const createDevelopmentAccountSchema = z.object({ minecraftName: z.string().trim().regex(/^[A-Za-z0-9_]{1,16}$/), member: z.boolean(), discordLinked: z.boolean() }).strict();
export const updateDevelopmentAccountSchema = z.object({ member: z.boolean(), discordLinked: z.boolean(), enabled: z.boolean(), expectedRevision: z.number().int().positive().max(2147483646) }).strict();
export const deleteDevelopmentAccountSchema = z.object({ expectedRevision: z.number().int().positive().max(2147483646) }).strict();
type Account = DevelopmentMinecraftAccount & { subject: Subject & { minecraft: MinecraftIdentity | null } };
const include = { subject: { include: { minecraft: true } } } as const;
function dto(p: PassportService, row: Account, servers: ServerRecord[], presence?: PlayerPresence | null) {
  if (!row.subject.minecraft) throw new ServiceUnavailableException({ code: 'development_account_unavailable' });
  return { id: row.subjectId, minecraft: { uuid: row.subject.minecraft.uuid, name: row.subject.minecraft.name }, displayName: managedDevelopmentName, member: row.subject.membershipStatus === 'active', discordLinked: row.discordLinked, enabled: row.enabled, revision: row.revision, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), allowedServerIds: p.gameServers({ ...row.subject, developmentAccount: row, discordIdentity: null }, servers).map(server => server.id), presence: presenceDto(presence, servers) };
}
async function invalidate(tx: Prisma.TransactionClient, identity: MinecraftIdentity) {
  const changed = await tx.minecraftIdentity.update({ where: { uuid: identity.uuid }, data: { policyVersion: { increment: 1 }, policyFingerprint: '', telemetryEpoch: randomUUID() } });
  await tx.policyEvent.create({ data: { minecraftUuid: changed.uuid, policyVersion: changed.policyVersion } });
  await tx.playerPresence.deleteMany({ where: { minecraftUuid: changed.uuid } });
}
export async function developmentAccounts(p: PassportService, req: Request) {
  await adminContext(p, req);
  return policyTransaction(p.db, async tx => {
    const [accounts, servers, presences] = await Promise.all([tx.developmentMinecraftAccount.findMany({ include, orderBy: [{ createdAt: 'desc' }, { subjectId: 'asc' }], take: 100 }), tx.serverRecord.findMany({ orderBy: { id: 'asc' } }), tx.playerPresence.findMany()]);
    return { accounts: accounts.map(row => dto(p, row, servers, presences.find(presence => presence.minecraftUuid === row.subject.minecraft?.uuid))) };
  });
}
export async function createDevelopmentAccount(p: PassportService, req: Request, input: z.infer<typeof createDevelopmentAccountSchema>) {
  const actor = await adminContext(p, req, true);
  const profile = await resolveMinecraftProfile(input.minecraftName);
  return policyTransaction(p.db, async tx => {
    await requireAdminTransaction(p, tx, actor);
    const existing = await tx.minecraftIdentity.findUnique({ where: { uuid: profile.uuid } });
    if (existing?.subjectId) throw new ConflictException({ code: 'minecraft_already_linked' });
    if (await tx.developmentMinecraftAccount.count() >= 100) throw new ConflictException({ code: 'development_account_limit' });
    const subject = await tx.subject.create({ data: { universityKey: `${managedDevelopmentProvider}:${randomUUID()}`, identityProvider: managedDevelopmentProvider, displayName: managedDevelopmentName, membershipStatus: input.member ? 'active' : 'inactive', roleLabel: input.member ? '회원' : '', verifiedUntil: new Date('9999-01-01T00:00:00Z'), statisticsEnabled: false, developmentAccount: { create: { discordLinked: input.discordLinked } } } });
    const identity = await tx.minecraftIdentity.upsert({ where: { uuid: profile.uuid }, create: { uuid: profile.uuid, name: profile.name, subjectId: subject.id }, update: { name: profile.name, subjectId: subject.id } });
    await invalidate(tx, identity);
    // Pending school-link tokens must not claim this UUID after administrator registration.
    await tx.linkSession.updateMany({ where: { minecraftUuid: profile.uuid, status: 'pending' }, data: { status: 'cancelled' } });
    await tx.auditEvent.create({ data: { action: 'admin.development_account_created', actorSubjectId: actor.session.subjectId, subjectId: subject.id, objectId: profile.uuid, details: { member: input.member, discordLinked: input.discordLinked, enabled: true } } });
    const account = await tx.developmentMinecraftAccount.findUniqueOrThrow({ where: { subjectId: subject.id }, include });
    return { account: dto(p, account, await tx.serverRecord.findMany({ orderBy: { id: 'asc' } })) };
  }).catch(error => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException({ code: 'minecraft_already_linked' });
    throw error;
  });
}
export async function updateDevelopmentAccount(p: PassportService, req: Request, id: string, input: z.infer<typeof updateDevelopmentAccountSchema>) {
  const actor = await adminContext(p, req, true);
  return policyTransaction(p.db, async tx => {
    await requireAdminTransaction(p, tx, actor);
    const current = await tx.developmentMinecraftAccount.findUnique({ where: { subjectId: id }, include });
    if (!current || current.subject.identityProvider !== managedDevelopmentProvider || !current.subject.minecraft) throw new NotFoundException({ code: 'development_account_not_found' });
    if (current.revision !== input.expectedRevision) throw new ConflictException({ code: 'development_account_changed' });
    await tx.subject.update({ where: { id }, data: { membershipStatus: input.member ? 'active' : 'inactive', roleLabel: input.member ? '회원' : '', accessSuspended: !input.enabled } });
    const account = await tx.developmentMinecraftAccount.update({ where: { subjectId: id }, data: { enabled: input.enabled, discordLinked: input.discordLinked, revision: { increment: 1 } }, include });
    await invalidate(tx, current.subject.minecraft);
    await tx.auditEvent.create({ data: { action: 'admin.development_account_updated', actorSubjectId: actor.session.subjectId, subjectId: id, objectId: current.subject.minecraft.uuid, details: { before: { member: current.subject.membershipStatus === 'active', discordLinked: current.discordLinked, enabled: current.enabled }, after: { member: input.member, discordLinked: input.discordLinked, enabled: input.enabled } } } });
    return { account: dto(p, account, await tx.serverRecord.findMany({ orderBy: { id: 'asc' } })) };
  });
}
export async function deleteDevelopmentAccount(p: PassportService, req: Request, id: string, input: z.infer<typeof deleteDevelopmentAccountSchema>) {
  const actor = await adminContext(p, req, true);
  return policyTransaction(p.db, async tx => {
    await requireAdminTransaction(p, tx, actor);
    const account = await tx.developmentMinecraftAccount.findUnique({ where: { subjectId: id }, include });
    if (!account || account.subject.identityProvider !== managedDevelopmentProvider) throw new NotFoundException({ code: 'development_account_not_found' });
    if (account.revision !== input.expectedRevision) throw new ConflictException({ code: 'development_account_changed' });
    if (account.subject.minecraft) {
      await invalidate(tx, account.subject.minecraft);
      await tx.minecraftIdentity.update({ where: { uuid: account.subject.minecraft.uuid }, data: { subjectId: null, name: '' } });
      await tx.linkSession.deleteMany({ where: { minecraftUuid: account.subject.minecraft.uuid } });
    }
    for (const server of await tx.serverRecord.findMany({ where: { allowedSubjectIds: { has: id } } })) await tx.serverRecord.update({ where: { id: server.id }, data: { allowedSubjectIds: server.allowedSubjectIds.filter(value => value !== id), updatedAt: new Date(Math.max(Date.now(), server.updatedAt.getTime() + 1)) } });
    await tx.subject.delete({ where: { id } });
    await tx.auditEvent.create({ data: { action: 'admin.development_account_deleted', actorSubjectId: actor.session.subjectId, objectId: id } });
    return { deleted: true };
  });
}
