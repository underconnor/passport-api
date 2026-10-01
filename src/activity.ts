import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';
import type { PassportService } from './passport.service';
import { policyTransaction, serializable } from './database';
import { adminContext } from './admin';
import { gameConsent, presenceDto } from './game-identity';
import { hash } from './security';

export const counterNames = ['playSeconds', 'blocksBroken', 'blocksPlaced', 'damageTakenMilli', 'deaths', 'mobKills', 'playerKills', 'distanceCm'] as const;
export type Counters = Record<typeof counterNames[number], number>;
export type ActivityRecord = Counters & { minecraftUuid: string; epoch: string };
export type ActivityBatch = { id: string; serverId: string; records: ActivityRecord[] };
const empty = (): Counters => ({ playSeconds: 0, blocksBroken: 0, blocksPlaced: 0, damageTakenMilli: 0, deaths: 0, mobKills: 0, playerKills: 0, distanceCm: 0 });
export async function collectActivity(p: PassportService, req: Request, input: ActivityBatch) {
  p.service(req);
  // Sorting makes immutable retry equality independent of transport property order.
  const digest = hash(JSON.stringify([input.serverId, [...input.records].sort((a, b) => a.minecraftUuid.localeCompare(b.minecraftUuid)).map(row => [row.minecraftUuid, row.epoch, ...counterNames.map(key => row[key])])]));
  return policyTransaction(p.db, async tx => {
    const previous = await tx.activityBatch.findUnique({ where: { id: input.id } });
    if (previous) {
      // Old Paper can retry a six-counter batch persisted before this additive rollout.
      const legacyDigest = input.records.every(row => row.playerKills === 0 && row.distanceCm === 0)
        ? hash(JSON.stringify([input.serverId, [...input.records].sort((a, b) => a.minecraftUuid.localeCompare(b.minecraftUuid)).map(row => [row.minecraftUuid, row.epoch, ...counterNames.slice(0, 6).map(key => row[key])])])) : null;
      if (previous.digest !== digest && previous.digest !== legacyDigest) throw new ConflictException({ code: 'statistics_batch_conflict' });
      return { accepted: true, duplicate: true, received: previous.received, ignored: previous.ignored };
    }
    const now = new Date();
    const server = await tx.serverRecord.findUnique({ where: { id: input.serverId } });
    if (!server?.enabled) throw new ConflictException({ code: 'server_not_enabled' });
    let received = 0;
    for (const row of input.records) {
      const identity = await tx.minecraftIdentity.findUnique({ where: { uuid: row.minecraftUuid }, include: { subject: true } });
      if (!identity?.subject || identity.telemetryEpoch !== row.epoch || !await gameConsent(tx, identity.subject.id) || !p.gameServers(identity.subject, [server], now).length) continue;
      const generation = await tx.activityGeneration.upsert({ where: { epoch: row.epoch }, create: { epoch: row.epoch, subjectId: identity.subject.id, minecraftUuid: row.minecraftUuid }, update: {} });
      if (generation.subjectId !== identity.subject.id || generation.minecraftUuid !== row.minecraftUuid) continue;
      const counters = Object.fromEntries(counterNames.map(key => [key, BigInt(row[key])])) as Record<typeof counterNames[number], bigint>;
      const increments = Object.fromEntries(counterNames.map(key => [key, { increment: counters[key] }]));
      await tx.activityTotal.upsert({ where: { epoch_serverId: { epoch: row.epoch, serverId: input.serverId } }, create: { epoch: row.epoch, serverId: input.serverId, ...counters }, update: increments });
      received++;
    }
    const ignored = input.records.length - received;
    await tx.activityBatch.create({ data: { id: input.id, digest, received, ignored } });
    return { accepted: true, duplicate: false, received, ignored };
  });
}
export async function statistics(p: PassportService, req: Request, kind: 'me' | 'admin' | 'member' | 'minecraft', id?: string) {
  let subjectId: string | undefined;
  if (kind === 'me') subjectId = (await p.context(req, true)).session.subjectId!;
  if (kind === 'admin' || kind === 'member') { await adminContext(p, req); if (kind === 'member') { if (!await p.db.subject.findUnique({ where: { id } })) throw new NotFoundException({ code: 'subject_not_found' }); subjectId = id; } }
  if (kind === 'minecraft') { p.service(req); const identity = await p.db.minecraftIdentity.findUnique({ where: { uuid: id } }); if (!identity?.subjectId) throw new NotFoundException({ code: 'minecraft_not_linked' }); subjectId = identity.subjectId; }
  return serializable(p.db, async tx => {
    const grouped = await tx.activityTotal.groupBy({ by: ['serverId'], where: subjectId ? { generation: { subjectId } } : {}, _sum: { playSeconds: true, blocksBroken: true, blocksPlaced: true, damageTakenMilli: true, deaths: true, mobKills: true, playerKills: true, distanceCm: true }, orderBy: { serverId: 'asc' } });
    const totals = empty();
    const rows = grouped.map(row => {
      const counters = empty();
      for (const key of counterNames) { const value = Number(row._sum[key] ?? 0n); if (!Number.isSafeInteger(value) || value < 0) throw new ServiceUnavailableException({ code: 'statistics_overflow' }); counters[key] = value; totals[key] += value; }
      return { serverId: row.serverId, ...counters };
    });
    if (Object.values(totals).some(value => !Number.isSafeInteger(value))) throw new ServiceUnavailableException({ code: 'statistics_overflow' });
    let records = await tx.serverRecord.findMany({ orderBy: { id: 'asc' } });
    if (kind === 'me' || kind === 'minecraft') { const subject = await tx.subject.findUnique({ where: { id: subjectId } }); records = subject ? p.gameServers(subject, records) : []; }
    const playerCount = subjectId ? undefined : (await tx.activityGeneration.findMany({ distinct: ['subjectId'], select: { subjectId: true } })).length;
    const identity = subjectId ? await tx.minecraftIdentity.findUnique({ where: { subjectId }, select: { uuid: true } }) : null;
    const now = new Date();
    const presences = await tx.playerPresence.findMany({ where: subjectId ? { minecraftUuid: identity?.uuid ?? '00000000-0000-0000-0000-000000000000' } : { expiresAt: { gt: now } } });
    const visible = presences.filter(row => row.expiresAt > now && records.some(server => server.id === row.serverId));
    const servers = records.map(server => ({ serverId: server.id, label: server.label, ...(rows.find(row => row.serverId === server.id) ?? empty()), onlinePlayerCount: visible.filter(row => row.serverId === server.id).length }));
    return { available: true, totals, servers, ...(playerCount === undefined ? { presence: presenceDto(presences[0], records, now) } : { playerCount, onlinePlayerCount: visible.length }) };
  });
}
