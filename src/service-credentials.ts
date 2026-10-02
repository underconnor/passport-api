import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { ServiceCredential } from '@prisma/client';
import type { Request } from 'express';
import { z } from 'zod';
import type { PassportService } from './passport.service';
import { adminContext, requireAdminTransaction } from './admin';
import { policyTransaction } from './database';
import { equal, hash, opaqueToken, serverIdSchema } from './security';

export const credentialScopes = [
  'game:policy', 'game:events', 'game:link', 'game:registry', 'game:heartbeat',
  'game:presence', 'game:stats:write', 'game:stats:read', 'game:players',
  'discord:link', 'discord:config', 'discord:roles', 'discord:nicknames',
] as const;
export const credentialSchema = z.object({
  serviceId: z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/),
  audience: z.enum(['minecraft', 'discord']),
  scopes: z.array(z.enum(credentialScopes)).min(1).max(credentialScopes.length).refine(v => new Set(v).size === v.length),
  serverIds: z.array(z.union([serverIdSchema, z.literal('*')])).max(64).refine(v => new Set(v).size === v.length && (!v.includes('*') || v.length === 1)),
  expiresAt: z.string().datetime({ offset: true }),
}).strict().superRefine((v, c) => {
  if (v.scopes.some(s => v.audience === 'minecraft' ? !s.startsWith('game:') : !s.startsWith('discord:')))
    c.addIssue({ code: 'custom', message: 'Audience and scopes must match' });
  if (v.audience === 'discord' ? v.serverIds.length !== 0 : v.serverIds.length === 0)
    c.addIssue({ code: 'custom', message: 'Server scope is required only for Minecraft' });
  // Network-wide lookup, registry and login are proxy duties. A scoped
  // Paper key must never gain these capabilities by naming a single backend.
  if (v.scopes.some(s => ['game:link', 'game:registry', 'game:players', 'game:stats:read'].includes(s)) && !v.serverIds.includes('*'))
    c.addIssue({ code: 'custom', message: 'Network scopes require all-server scope' });
});

type Permission = { audience: 'minecraft' | 'discord'; scope: typeof credentialScopes[number]; serverIds?: string[] };
const authenticated = new WeakMap<Request, ServiceCredential>();
const uuidPart = '[0-9a-fA-F-]{36}';
function permission(req: Request): Permission | null {
  const route = `${req.method} ${req.path}`;
  const game = (scope: Permission['scope'], serverIds?: string[]): Permission => ({ audience: 'minecraft', scope, serverIds });
  if (new RegExp(`^GET /v1/minecraft/policies/${uuidPart}$`).test(route)) return game('game:policy');
  if (route === 'GET /v1/minecraft/events') return game('game:events');
  if (route === 'GET /v1/minecraft/servers') return game('game:registry');
  if (route === 'GET /v1/minecraft/players') return game('game:players');
  if (new RegExp(`^GET /v1/minecraft/players/${uuidPart}/stats$`).test(route)) return game('game:stats:read');
  if (route === 'POST /v1/minecraft/presence') return game('game:presence', [req.body?.serverId]);
  if (route === 'POST /v1/minecraft/stats/batches') return game('game:stats:write', [req.body?.serverId]);
  if (route === 'POST /v1/minecraft/servers/heartbeat') {
    if (!['paper', 'velocity'].includes(req.body?.source) || !Array.isArray(req.body?.servers)) return null;
    return game('game:heartbeat', req.body.servers.map((s: { id?: string } | null) => s?.id));
  }
  if (route === 'POST /v1/link-sessions' || new RegExp(`^(POST /v1/link-sessions/${uuidPart}/game-(inspect|confirm)|DELETE /v1/link-sessions/${uuidPart})$`).test(route)) return game('game:link');
  if (route === 'POST /v1/discord/link-sessions') return { audience: 'discord', scope: 'discord:link' };
  if (route === 'GET /v2/discord/config') return { audience: 'discord', scope: 'discord:config' };
  if (/^POST \/v[12]\/discord\/roles\/(claim|[0-9a-fA-F-]{36}\/ack)$/.test(route)) return { audience: 'discord', scope: 'discord:roles' };
  if (/^POST \/v2\/discord\/nicknames\/(claim|[0-9a-fA-F-]{36}\/ack)$/.test(route)) return { audience: 'discord', scope: 'discord:nicknames' };
  return null;
}

/** Nest guard runs after JSON parsing, before any controller mutation. */
export async function authorizeServiceCredential(p: PassportService, req: Request): Promise<boolean> {
  const bearer = req.headers.authorization;
  if (!bearer?.startsWith('Bearer psk_')) return true;
  const token = bearer.slice(7), match = /^psk_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(match[1]!)) throw new UnauthorizedException({ code: 'service_unauthorized' });
  const row = await p.db.serviceCredential.findUnique({ where: { id: match[1]! } });
  if (!row || row.revokedAt || row.expiresAt <= new Date() || !equal(row.tokenHash, hash(token))) throw new UnauthorizedException({ code: 'service_unauthorized' });
  const required = permission(req);
  if (!required || row.audience !== required.audience || !row.scopes.includes(required.scope)) throw new ForbiddenException({ code: 'service_scope_denied' });
  if (required.serverIds && (required.serverIds.some(id => typeof id !== 'string' || !serverIdSchema.safeParse(id).success || (!row.serverIds.includes('*') && !row.serverIds.includes(id))) ||
      (req.body?.source === 'velocity' && !row.serverIds.includes('*')))) throw new ForbiddenException({ code: 'service_server_denied' });
  authenticated.set(req, row);
  return true;
}

export function hasServiceCredential(req: Request, audience: 'minecraft' | 'discord') {
  return authenticated.get(req)?.audience === audience;
}

function publicCredential(row: ServiceCredential) {
  return { id: row.id, serviceId: row.serviceId, audience: row.audience, scopes: row.scopes,
    serverIds: row.serverIds, expiresAt: row.expiresAt.toISOString(), revokedAt: row.revokedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString() };
}

export async function listCredentials(p: PassportService, req: Request) {
  await adminContext(p, req, false, 'manageOperators');
  const rows = await p.db.serviceCredential.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
  return { credentials: rows.map(publicCredential), legacyEnabled: p.config.legacyServiceAuthEnabled };
}

export async function createCredential(p: PassportService, req: Request, input: z.infer<typeof credentialSchema>) {
  const actor = await adminContext(p, req, true, 'manageOperators');
  const expiresAt = new Date(input.expiresAt), now = Date.now();
  if (expiresAt.getTime() < now + 60_000 || expiresAt.getTime() > now + 366 * 86400_000) throw new ForbiddenException({ code: 'credential_expiry_invalid' });
  const id = randomUUID(), token = `psk_${id}.${opaqueToken()}`;
  return policyTransaction(p.db, async tx => {
    await requireAdminTransaction(p, tx, actor, 'manageOperators');
    if (await tx.serviceCredential.count({ where: { revokedAt: null, expiresAt: { gt: new Date() } } }) >= 100) throw new ConflictException({ code: 'credential_limit' });
    if (!input.serverIds.includes('*') && input.serverIds.length !== await tx.serverRecord.count({ where: { id: { in: input.serverIds } } })) throw new NotFoundException({ code: 'server_not_found' });
    const row = await tx.serviceCredential.create({ data: { ...input, id, tokenHash: hash(token), expiresAt } });
    await tx.auditEvent.create({ data: { action: 'admin.service_credential_created', actorSubjectId: actor.session.subjectId, objectId: id,
      details: { serviceId: row.serviceId, audience: row.audience, scopes: row.scopes, serverIds: row.serverIds, expiresAt: row.expiresAt.toISOString() } } });
    return { credential: publicCredential(row), token };
  });
}

export async function revokeCredential(p: PassportService, req: Request, id: string) {
  const actor = await adminContext(p, req, true, 'manageOperators');
  return policyTransaction(p.db, async tx => {
    await requireAdminTransaction(p, tx, actor, 'manageOperators');
    const row = await tx.serviceCredential.findUnique({ where: { id } });
    if (!row) throw new NotFoundException({ code: 'credential_not_found' });
    if (!row.revokedAt) {
      await tx.serviceCredential.update({ where: { id }, data: { revokedAt: new Date() } });
      await tx.auditEvent.create({ data: { action: 'admin.service_credential_revoked', actorSubjectId: actor.session.subjectId, objectId: id } });
    }
    return { revoked: true };
  });
}
