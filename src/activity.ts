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
export type StatisticsPeriod = { from?: string; to?: string };
const sums = { playSeconds: true, blocksBroken: true, blocksPlaced: true, damageTakenMilli: true, deaths: true, mobKills: true, playerKills: true, distanceCm: true } as const;
export const koreaDate = (now: Date) => new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
export function counterNumber(value: bigint | number | null): number { const result = Number(value ?? 0); if (!Number.isSafeInteger(result) || result < 0) throw new ServiceUnavailableException({ code: 'statistics_overflow' }); return result; }
export const emptyCounters = (): Counters => ({ playSeconds: 0, blocksBroken: 0, blocksPlaced: 0, damageTakenMilli: 0, deaths: 0, mobKills: 0, playerKills: 0, distanceCm: 0 });
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
      if (!server.statisticsEnabled || !identity?.subject || identity.telemetryEpoch !== row.epoch || !await gameConsent(tx, identity.subject.id) || !p.gameServers(identity.subject, [server], now).length) continue;
      const generation = await tx.activityGeneration.upsert({ where: { epoch: row.epoch }, create: { epoch: row.epoch, subjectId: identity.subject.id, minecraftUuid: row.minecraftUuid }, update: {} });
      if (generation.subjectId !== identity.subject.id || generation.minecraftUuid !== row.minecraftUuid) continue;
      const counters = Object.fromEntries(counterNames.map(key => [key, BigInt(row[key])])) as Record<typeof counterNames[number], bigint>;
      const increments = Object.fromEntries(counterNames.map(key => [key, { increment: counters[key] }]));
      await tx.activityTotal.upsert({ where: { epoch_serverId: { epoch: row.epoch, serverId: input.serverId } }, create: { epoch: row.epoch, serverId: input.serverId, ...counters, firstCollectedAt: now, lastCollectedAt: now }, update: { ...increments, lastCollectedAt: now } });
      await tx.activityTotal.updateMany({ where: { epoch: row.epoch, serverId: input.serverId, firstCollectedAt: null }, data: { firstCollectedAt: now } });
      const date = new Date(koreaDate(now));
      await tx.activityDaily.upsert({ where: { epoch_serverId_date: { epoch: row.epoch, serverId: input.serverId, date } }, create: { epoch: row.epoch, serverId: input.serverId, date, ...counters, firstCollectedAt: now, lastCollectedAt: now }, update: { ...increments, lastCollectedAt: now } });
      received++;
    }
    const ignored = input.records.length - received;
    await tx.activityBatch.create({ data: { id: input.id, digest, received, ignored } });
    return { accepted: true, duplicate: false, received, ignored };
  });
}
export async function statistics(p: PassportService, req: Request, kind: 'me' | 'admin' | 'member' | 'minecraft', id?: string, period: StatisticsPeriod = {}) {
  let subjectId: string | undefined;
  if (kind === 'me') subjectId = (await p.context(req, true)).session.subjectId!;
  if (kind === 'admin' || kind === 'member') { await adminContext(p, req); if (kind === 'member') { if (!await p.db.subject.findUnique({ where: { id } })) throw new NotFoundException({ code: 'subject_not_found' }); subjectId = id; } }
  if (kind === 'minecraft') { p.service(req); const identity = await p.db.minecraftIdentity.findUnique({ where: { uuid: id } }); if (!identity?.subjectId) throw new NotFoundException({ code: 'minecraft_not_linked' }); subjectId = identity.subjectId; }
  return serializable(p.db, async tx => {
    let records = await tx.serverRecord.findMany({ orderBy: { id: 'asc' } });
    if (kind === 'me' || kind === 'minecraft') { const subject = await tx.subject.findUnique({ where: { id: subjectId } }); records = subject ? p.gameServers(subject, records) : []; }
    const presenceServers = records;
    const excludedServerIds = records.filter(server => !server.statisticsEnabled).map(server => server.id);
    records = records.filter(server => server.statisticsEnabled);
    const includedIds = records.map(server => server.id);
    const where = { serverId: { in: includedIds }, ...(subjectId ? { generation: { subjectId } } : {}) };
    const date = period.from && period.to ? { gte: new Date(period.from), lte: new Date(period.to) } : undefined;
    const grouped = date
      ? await tx.activityDaily.groupBy({ by: ['serverId'], where: { ...where, date }, _sum: sums, _min: { firstCollectedAt: true }, _max: { lastCollectedAt: true }, orderBy: { serverId: 'asc' } })
      : await tx.activityTotal.groupBy({ by: ['serverId'], where, _sum: sums, _min: { firstCollectedAt: true }, _max: { lastCollectedAt: true }, orderBy: { serverId: 'asc' } });
    const totals = emptyCounters();
    const rows = grouped.map(row => {
      const counters = emptyCounters();
      for (const key of counterNames) { counters[key] = counterNumber(row._sum[key]); totals[key] = counterNumber(totals[key] + counters[key]); }
      return { serverId: row.serverId, ...counters, firstCollectedAt: row._min.firstCollectedAt?.toISOString() ?? null, lastCollectedAt: row._max.lastCollectedAt?.toISOString() ?? null };
    });
    const playerCount = subjectId ? undefined : (await tx.activityGeneration.findMany({ where: date ? { daily: { some: { serverId: { in: includedIds }, date } } } : { totals: { some: { serverId: { in: includedIds } } } }, distinct: ['subjectId'], select: { subjectId: true } })).length;
    const identity = subjectId ? await tx.minecraftIdentity.findUnique({ where: { subjectId }, select: { uuid: true } }) : null;
    const now = new Date();
    const presences = await tx.playerPresence.findMany({ where: subjectId ? { minecraftUuid: identity?.uuid ?? '00000000-0000-0000-0000-000000000000' } : { expiresAt: { gt: now } } });
    const visible = presences.filter(row => row.expiresAt > now && presenceServers.some(server => server.id === row.serverId));
    const servers = records.map(server => ({ serverId: server.id, label: server.label, collectionEnabled: true, ...(rows.find(row => row.serverId === server.id) ?? { ...emptyCounters(), firstCollectedAt: null, lastCollectedAt: null }), onlinePlayerCount: visible.filter(row => row.serverId === server.id).length }));
    const subject = subjectId ? await tx.subject.findUnique({ where: { id: subjectId } }) : null;
    const consentGranted = subjectId ? await gameConsent(tx, subjectId) : null;
    const effective = subject ? Boolean(consentGranted) && p.gameServers(subject, records).length > 0 : null;
    const collection = { effective, enabled: subject ? true : null, managedBy: 'administrator', consentGranted, excludedServerIds, historyRetained: true };
    // Cumulative queries keep their full history; the accompanying trend is bounded to 30 days.
    const trendDate = date ?? { gte: new Date(koreaDate(new Date(now.getTime() - 29 * 86400000))), lte: new Date(koreaDate(now)) };
    const dailyRows = await tx.activityDaily.groupBy({ by: ['date', 'serverId'], where: { ...where, date: trendDate }, _sum: sums, orderBy: [{ date: 'asc' }, { serverId: 'asc' }] });
    const daily = dailyRows.map(row => ({ date: row.date.toISOString().slice(0, 10), serverId: row.serverId, ...Object.fromEntries(counterNames.map(key => [key, counterNumber(row._sum[key])])) }));
    const history = await tx.statisticsHistory.findUnique({ where: { id: 'main' } });
    const firstDates = rows.flatMap(row => row.firstCollectedAt ? [row.firstCollectedAt] : []).sort();
    const lastDates = rows.flatMap(row => row.lastCollectedAt ? [row.lastCollectedAt] : []).sort();
    return { available: true, totals, servers, collection, daily, firstCollectedAt: firstDates[0] ?? null, lastCollectedAt: lastDates.at(-1) ?? null, period: { from: period.from ?? null, to: period.to ?? null, availableFrom: history?.availableFrom.toISOString() ?? null, timezone: 'Asia/Seoul', basis: 'receivedAt' }, ...(playerCount === undefined ? { presence: presenceDto(presences[0], presenceServers, now) } : { playerCount, onlinePlayerCount: visible.length }) };
  });
}
