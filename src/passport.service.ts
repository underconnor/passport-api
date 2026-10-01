import { Injectable, UnauthorizedException, ForbiddenException, NotFoundException, ConflictException, GoneException, ServiceUnavailableException, BadRequestException } from '@nestjs/common';
import { PrismaClient, Prisma, WebSession, Subject, LinkSession } from '@prisma/client';
import { Request, Response } from 'express';
import { parse as parseCookie, serialize } from 'cookie';
import { Config, configFromEnv } from './config';
import { hash, opaqueToken, equal, csrf } from './security';
import { policyTransaction, serializable } from './database';
import { startMembershipSync } from './membership-sync';
import { permittedServers, seedServerRegistry } from './registry';
import { ConsentInput, privacyNotice, recordConsent, requireConsent } from './privacy';
import { minecraftSkin } from './integrations/minecraft-skin';
import { discordConnection } from './discord-policy';

type Context = { session: WebSession & { subject: Subject | null }; token: string };
const sessionLifetime = 8 * 60 * 60 * 1000;
@Injectable()
export class PassportService {
  readonly config: Config = configFromEnv();
  readonly db = new PrismaClient({ datasources: { db: { url: this.config.databaseUrl } } });
  private cleanupTimer?: NodeJS.Timeout;
  membership!: ReturnType<typeof startMembershipSync>;
  async onModuleInit() {
    await this.db.$connect();
    await seedServerRegistry(this.db, this.config.servers);
    this.membership = startMembershipSync(this.db);
    this.cleanupTimer = setInterval(() => { void this.cleanup().catch(() => {}); }, 60000);
    this.cleanupTimer.unref();
  }
  async onModuleDestroy() { clearInterval(this.cleanupTimer); this.membership?.stop(); await this.db.$disconnect(); }
  async cleanup() {
    const now = new Date();
    await this.db.universityAuthRequest.deleteMany({ where: { expiresAt: { lte: now } } });
    await this.db.consumedUniversityToken.deleteMany({ where: { expiresAt: { lte: now } } });
    await this.db.webSession.deleteMany({ where: { expiresAt: { lte: now } } });
    await this.db.discordLinkSession.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } } });
    await this.db.linkSession.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } } });
    await this.db.policyEvent.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) } } });
    await this.db.auditEvent.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000) } } });
  }
  cookieName(req: Request) {
    const audience = this.host(req) === new URL(this.config.webOrigin).host ? 'portal' : 'admin';
    return `${this.config.production ? '__Host-' : ''}passport_${audience}_session`;
  }
  host(req: Request) {
    const host = req.headers.host?.toLowerCase();
    if (!host || !this.config.origins.some(o => new URL(o).host === host)) throw new ForbiddenException({ code: 'invalid_host' });
    return host;
  }
  checkOrigin(req: Request) {
    const host = this.host(req);
    const origin = req.headers.origin;
    if (!origin || !this.config.origins.includes(origin) || new URL(origin).host !== host) throw new ForbiddenException({ code: 'invalid_origin' });
  }
  service(req: Request) {
    const value = req.headers.authorization;
    if (!value?.startsWith('Bearer ') || !equal(value.slice(7), this.config.serviceToken)) throw new UnauthorizedException({ code: 'service_unauthorized' });
  }
  async context(req: Request, authenticated = false): Promise<Context> {
    const host = this.host(req);
    const token = parseCookie(req.headers.cookie ?? '')[this.cookieName(req)];
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new UnauthorizedException({ code: 'session_required' });
    const session = await this.db.webSession.findUnique({ where: { tokenHash: hash(token) }, include: { subject: true } });
    if (!session || session.expiresAt <= new Date() || session.audienceHost !== host || (authenticated && !session.subject)) throw new UnauthorizedException({ code: 'session_required' });
    return { session, token };
  }
  async mutation(req: Request, authenticated = true) {
    this.checkOrigin(req);
    const context = await this.context(req, authenticated);
    const submitted = req.headers['x-csrf-token'];
    if (typeof submitted !== 'string' || !equal(submitted, csrf(this.config.sessionSecret, context.token))) throw new ForbiddenException({ code: 'csrf_invalid' });
    return context;
  }
  setCookie(req: Request, res: Response, token: string, maxAge: number) {
    const host = this.host(req);
    const secure = this.config.origins.some(o => new URL(o).host === host && o.startsWith('https://'));
    res.appendHeader('Set-Cookie', serialize(this.cookieName(req), token, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge }));
  }
  async session(req: Request, res: Response) {
    let context: Context;
    try { context = await this.context(req); }
    catch (error) {
      if (!(error instanceof UnauthorizedException)) throw error;
      const token = opaqueToken();
      const session = await this.db.webSession.create({ data: { tokenHash: hash(token), audienceHost: this.host(req), expiresAt: new Date(Date.now() + sessionLifetime) }, include: { subject: true } });
      this.setCookie(req, res, token, sessionLifetime / 1000);
      context = { session, token };
    }
    return { authenticated: Boolean(context.session.subject), csrfToken: csrf(this.config.sessionSecret, context.token), authMode: this.config.authMode, features: { discordLinking: Boolean(this.config.discord) } };
  }
  async developmentLogin(req: Request, res: Response, identity: 'member' | 'outsider') {
    if (this.config.authMode !== 'development' || this.config.production) throw new NotFoundException({ code: 'development_auth_disabled' });
    const context = await this.mutation(req, false);
    const subject = await this.db.subject.findUnique({ where: { universityKey: `development:${identity}` } });
    if (!subject || subject.identityProvider !== 'development') throw new ServiceUnavailableException({ code: 'development_fixtures_missing' });
    const token = opaqueToken();
    await serializable(this.db, async tx => {
      const removed = await tx.webSession.deleteMany({ where: { id: context.session.id, tokenHash: hash(context.token), expiresAt: { gt: new Date() } } });
      if (removed.count !== 1) throw new UnauthorizedException({ code: 'session_required' });
      await tx.webSession.create({ data: { tokenHash: hash(token), subjectId: subject.id, audienceHost: this.host(req), expiresAt: new Date(Date.now() + sessionLifetime) } });
      await tx.auditEvent.create({ data: { action: 'development.login', subjectId: subject.id } });
    });
    this.setCookie(req, res, token, sessionLifetime / 1000);
    return this.profile(subject, token);
  }
  async profile(subject: Subject, token: string) {
    const [minecraft, consent, discord] = await Promise.all([this.db.minecraftIdentity.findUnique({ where: { subjectId: subject.id } }), this.db.consentReceipt.findFirst({ where: { subjectId: subject.id, version: privacyNotice.version }, orderBy: { acceptedAt: 'desc' }, select: { acceptedAt: true } }), this.db.discordIdentity.findUnique({ where: { subjectId: subject.id }, include: { roles: true } })]);
    return { id: subject.id, displayName: subject.displayName, identityProvider: subject.identityProvider, department: subject.department, academicStatus: subject.academicStatus, universityVerifiedAt: subject.universityVerifiedAt?.toISOString() ?? null, universityVerifiedUntil: subject.universityVerifiedUntil?.toISOString() ?? null, accessSuspended: subject.accessSuspended, membership: { status: subject.membershipStatus, effectiveStatus: this.accessStatus(subject), roleLabel: subject.roleLabel, verifiedUntil: subject.verifiedUntil.toISOString() }, minecraft: minecraft ? { uuid: minecraft.uuid, name: minecraft.name } : null, discordConnection: discordConnection(discord, this.config.discord), privacyConsent: { version: privacyNotice.version, accepted: Boolean(consent), acceptedAt: consent?.acceptedAt.toISOString() ?? null }, discordReference: subject.discordId ? { id: subject.discordId, verificationStatus: 'self_reported', updatedAt: subject.discordUpdatedAt!.toISOString() } : null, csrfToken: csrf(this.config.sessionSecret, token) };
  }
  async me(req: Request) { const c = await this.context(req, true); return this.profile(c.session.subject!, c.token); }
  async myMinecraftSkin(req: Request) {
    const c = await this.context(req, true);
    const identity = await this.db.minecraftIdentity.findUnique({ where: { subjectId: c.session.subjectId! }, select: { uuid: true } });
    return identity ? minecraftSkin(identity.uuid) : { dataUrl: null, model: null };
  }
  async linkMinecraftSkin(req: Request, id: string, token: string) {
    const link = await this.inspectLink(req, id, token);
    return minecraftSkin(link.minecraftUuid);
  }
  async logout(req: Request, res: Response) {
    const c = await this.mutation(req);
    await this.db.webSession.deleteMany({ where: { id: c.session.id } });
    this.setCookie(req, res, '', 0);
  }
  async discord(req: Request) {
    await this.mutation(req);
    throw new ForbiddenException({ code: 'discord_admin_contact_required' });
  }
  async myServers(req: Request) {
    const c = await this.context(req, true);
    const s = c.session.subject!;
    const records = await this.db.serverRecord.findMany({ orderBy: { id: 'asc' } });
    return { servers: permittedServers(s, records, this.accessStatus(s) === 'active').map(({ id, label, sensitive }) => ({ id, label, sensitive })) };
  }
  accessStatus(subject: Pick<Subject, 'accessSuspended' | 'membershipStatus' | 'verifiedUntil' | 'identityProvider' | 'universityVerifiedUntil'>, now = new Date()) {
    if (subject.accessSuspended || subject.membershipStatus === 'suspended') return 'suspended';
    if (subject.membershipStatus !== 'active') return 'revoked';
    if (subject.verifiedUntil <= now || (subject.identityProvider === 'usaint' && (!subject.universityVerifiedUntil || subject.universityVerifiedUntil <= now))) return 'stale';
    return 'active';
  }
  async createLink(req: Request, input: { minecraftUuid: string; minecraftName: string; gameSessionId: string }) {
    this.service(req);
    const token = opaqueToken();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const link = await serializable(this.db, async tx => {
      await tx.minecraftIdentity.upsert({ where: { uuid: input.minecraftUuid }, update: { name: input.minecraftName }, create: { uuid: input.minecraftUuid, name: input.minecraftName } });
      const existing = await tx.minecraftIdentity.findUniqueOrThrow({ where: { uuid: input.minecraftUuid } });
      if (existing.subjectId) throw new ConflictException({ code: 'minecraft_already_linked' });
      await tx.linkSession.updateMany({ where: { minecraftUuid: input.minecraftUuid, status: 'pending' }, data: { status: 'cancelled' } });
      return tx.linkSession.create({ data: { tokenHash: hash(token), minecraftUuid: input.minecraftUuid, minecraftName: input.minecraftName, gameSessionHash: hash(input.gameSessionId), expiresAt } });
    });
    return { id: link.id, url: `${this.config.webOrigin}/link/${link.id}#token=${token}`, expiresAt: expiresAt.toISOString() };
  }
  ensurePending(link: LinkSession | null): asserts link is LinkSession {
    if (!link) throw new NotFoundException({ code: 'link_not_found' });
    if (link.expiresAt <= new Date()) throw new GoneException({ code: 'link_expired' });
    if (link.status !== 'pending') throw new ConflictException({ code: 'link_consumed' });
  }
  async inspectLink(req: Request, id: string, token: string) {
    await this.mutation(req, false);
    const link = await this.db.linkSession.findUnique({ where: { id } });
    if (!link || !equal(link.tokenHash, hash(token))) throw new NotFoundException({ code: 'link_not_found' });
    if (link.expiresAt <= new Date()) throw new GoneException({ code: 'link_expired' });
    if (!['pending', 'linked'].includes(link.status)) throw new ConflictException({ code: 'link_consumed' });
    return { id: link.id, minecraftName: link.minecraftName, minecraftUuid: link.minecraftUuid, status: link.status, expiresAt: link.expiresAt.toISOString(), webConfirmed: Boolean(link.webConfirmedAt), gameConfirmed: Boolean(link.gameConfirmedAt) };
  }
  async inspectGameLink(req: Request, id: string, input: { minecraftUuid: string; gameSessionId: string }) {
    this.service(req);
    return serializable(this.db, async tx => {
      const link = await tx.linkSession.findUnique({ where: { id } });
      if (!link) throw new NotFoundException({ code: 'link_not_found' });
      if (link.minecraftUuid !== input.minecraftUuid || !equal(link.gameSessionHash, hash(input.gameSessionId))) throw new ForbiddenException({ code: 'game_session_mismatch' });
      if (link.expiresAt <= new Date()) throw new GoneException({ code: 'link_expired' });
      if (!['pending', 'linked'].includes(link.status)) throw new ConflictException({ code: 'link_consumed' });
      if (link.status === 'linked') {
        const identity = await tx.minecraftIdentity.findUnique({ where: { uuid: link.minecraftUuid }, select: { subjectId: true } });
        if (!link.subjectId || identity?.subjectId !== link.subjectId) throw new ConflictException({ code: 'link_consumed' });
      }
      return { id: link.id, status: link.status, expiresAt: link.expiresAt.toISOString(), webConfirmed: Boolean(link.webConfirmedAt), gameConfirmed: Boolean(link.gameConfirmedAt) };
    });
  }
  // Both callers enter policyTransaction before reading or updating the link.
  async finishLink(tx: Prisma.TransactionClient, link: LinkSession) {
    if (!link.gameConfirmedAt || !link.webConfirmedAt) return link;
    if (!link.subjectId || !link.webSessionId) throw new UnauthorizedException({ code: 'confirming_session_expired' });
    const session = await tx.webSession.findUnique({ where: { id: link.webSessionId } });
    const subject = await tx.subject.findUnique({ where: { id: link.subjectId } });
    if (!session || session.expiresAt <= new Date() || session.subjectId !== link.subjectId) throw new UnauthorizedException({ code: 'confirming_session_expired' });
    if (!subject || this.accessStatus(subject) !== 'active') throw new ForbiddenException({ code: 'membership_required' });
    const consent = await tx.consentReceipt.findFirst({ where: { subjectId: subject.id, source: 'minecraft_link', contextId: link.id, version: privacyNotice.version }, select: { id: true } });
    if (!consent) throw new ForbiddenException({ code: 'consent_required' });
    const previous = await tx.minecraftIdentity.findUnique({ where: { subjectId: subject.id } });
    if (previous && previous.uuid !== link.minecraftUuid) throw new ConflictException({ code: 'subject_already_linked' });
    const updated = await tx.minecraftIdentity.updateMany({ where: { uuid: link.minecraftUuid, subjectId: null }, data: { subjectId: subject.id, policyVersion: { increment: 1 }, policyFingerprint: '' } });
    if (updated.count !== 1) throw new ConflictException({ code: 'minecraft_already_linked' });
    const identity = await tx.minecraftIdentity.findUniqueOrThrow({ where: { uuid: link.minecraftUuid } });
    await tx.policyEvent.create({ data: { minecraftUuid: identity.uuid, policyVersion: identity.policyVersion } });
    await tx.auditEvent.create({ data: { action: 'minecraft.linked', subjectId: subject.id, objectId: link.id } });
    return tx.linkSession.update({ where: { id: link.id }, data: { status: 'linked', completedAt: new Date() } });
  }
  summary(link: LinkSession) { return { id: link.id, status: link.status, expiresAt: link.expiresAt.toISOString() }; }
  async confirmWebLink(tx: Prisma.TransactionClient, id: string, token: string, subjectId: string, webSessionId: string, consent: { version: string; acceptedAt: Date }) {
      const found = await tx.linkSession.findUnique({ where: { id } });
      if (!found || !equal(found.tokenHash, hash(token))) throw new NotFoundException({ code: 'link_not_found' });
      this.ensurePending(found);
      if (found.webConfirmedAt) throw new ConflictException({ code: 'web_confirmation_consumed' });
      const subject = await tx.subject.findUniqueOrThrow({ where: { id: subjectId } });
      if (this.accessStatus(subject) !== 'active') throw new ForbiddenException({ code: 'membership_required' });
      await recordConsent(tx, subject.id, 'minecraft_link', id, consent);
      const claimed = await tx.linkSession.update({ where: { id }, data: { subjectId: subject.id, webSessionId, webConfirmedAt: new Date() } });
      return this.finishLink(tx, claimed);
  }
  async webConfirm(req: Request, id: string, token: string, input?: ConsentInput) {
    const c = await this.mutation(req);
    const consent = requireConsent(input);
    const link = await policyTransaction(this.db, tx => this.confirmWebLink(tx, id, token, c.session.subjectId!, c.session.id, consent));
    return this.summary(link);
  }
  async gameConfirm(req: Request, id: string, input: { minecraftUuid: string; gameSessionId: string }) {
    this.service(req);
    const link = await policyTransaction(this.db, async tx => {
      const found = await tx.linkSession.findUnique({ where: { id } });
      this.ensurePending(found);
      if (found.minecraftUuid !== input.minecraftUuid || !equal(found.gameSessionHash, hash(input.gameSessionId))) throw new ForbiddenException({ code: 'game_session_mismatch' });
      if (found.gameConfirmedAt) throw new ConflictException({ code: 'game_confirmation_consumed' });
      return this.finishLink(tx, await tx.linkSession.update({ where: { id }, data: { gameConfirmedAt: new Date() } }));
    });
    return this.summary(link);
  }
  async cancelLink(req: Request, id: string, input: { minecraftUuid: string; gameSessionId: string }) {
    this.service(req);
    await serializable(this.db, async tx => {
      const link = await tx.linkSession.findUnique({ where: { id } });
      if (!link) throw new NotFoundException({ code: 'link_not_found' });
      if (link.minecraftUuid !== input.minecraftUuid || !equal(link.gameSessionHash, hash(input.gameSessionId))) throw new ForbiddenException({ code: 'game_session_mismatch' });
      if (link.status === 'linked') throw new ConflictException({ code: 'link_consumed' });
      await tx.linkSession.update({ where: { id }, data: { status: 'cancelled' } });
    });
  }
  async policy(req: Request, uuid: string) {
    this.service(req);
    return policyTransaction(this.db, async tx => {
      const now = new Date();
      const identity = await tx.minecraftIdentity.upsert({ where: { uuid }, update: {}, create: { uuid, name: '' }, include: { subject: true } });
      const subject = identity.subject;
      const status = !subject ? 'unlinked' : this.accessStatus(subject, now);
      const records = await tx.serverRecord.findMany({ orderBy: { id: 'asc' } });
      const allowedServerIds = subject ? permittedServers(subject, records, status === 'active').map(server => server.id) : [];
      const display = { roleLabel: status === 'active' ? subject!.roleLabel.slice(0, 24) : '', displayName: subject ? subject.displayName.slice(0, 40) : identity.name };
      const fingerprint = hash(JSON.stringify({ subjectId: subject?.id ?? null, status, allowedServerIds, display }));
      let policyVersion = identity.policyVersion;
      if (identity.policyFingerprint !== fingerprint) {
        const changed = await tx.minecraftIdentity.update({ where: { uuid }, data: { policyFingerprint: fingerprint, ...(identity.policyFingerprint ? { policyVersion: { increment: 1 } } : {}) } });
        policyVersion = changed.policyVersion;
        if (identity.policyFingerprint) await tx.policyEvent.create({ data: { minecraftUuid: uuid, policyVersion } });
      }
      const expires = status === 'active' ? Math.min(now.getTime() + 60000, subject!.verifiedUntil.getTime(), subject!.identityProvider === 'usaint' ? subject!.universityVerifiedUntil!.getTime() : Infinity) : now.getTime() + 60000;
      return { contractVersion: '0.1.0-draft', subjectId: subject?.id ?? null, minecraftUuid: uuid, status, allowedServerIds, display, policyVersion, issuedAt: now.toISOString(), expiresAt: new Date(expires).toISOString() };
    });
  }
  async policyEvents(req: Request, after?: string) {
    this.service(req);
    if (after !== undefined && (typeof after !== 'string' || !/^\d{1,19}$/.test(after) || BigInt(after) > 9223372036854775807n)) throw new BadRequestException({ code: 'invalid_cursor' });
    return serializable(this.db, async tx => {
      const last = await tx.policyEvent.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
      const first = await tx.policyEvent.findFirst({ orderBy: { id: 'asc' }, select: { id: true } });
      const latest = last?.id ?? 0n;
      const cursor = after === undefined ? null : BigInt(after);
      if (cursor === null || cursor > latest || (first && cursor < first.id - 1n)) return { cursor: latest.toString(), reset: true, events: [] };
      const rows = await tx.policyEvent.findMany({ where: { id: { gt: cursor } }, orderBy: { id: 'asc' }, take: 500, select: { id: true, minecraftUuid: true, policyVersion: true } });
      return { cursor: (rows.at(-1)?.id ?? cursor).toString(), reset: false, events: rows.map(row => ({ ...row, id: row.id.toString() })) };
    });
  }
}
