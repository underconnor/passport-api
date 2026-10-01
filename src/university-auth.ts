import { ConflictException, ForbiddenException, GoneException, HttpException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { PassportService } from './passport.service';
import { SsuSaintAdapter, buildUniversityLoginUrl } from './integrations/usaint';
import { studentKey } from './integrations/sheets';
import { membershipForStudent } from './membership-sync';
import { hash, opaqueToken, equal, parse, universityReturnContextSchema } from './security';
import { seal, unseal } from './sealed';
import { policyTransaction, serializable } from './database';
import { ConsentInput, privacyNotice, recordConsent, requireConsent } from './privacy';
import { confirmDiscordLink, discordLinkState } from './discord';
import { refreshDiscordSubject } from './discord-policy';

export type UniversityStartInput = { link?: { id: string; token: string }; discordLink?: { id: string; token: string }; consent?: ConsentInput };
export const universityAdapter = new SsuSaintAdapter();

export async function startUniversity(p: PassportService, req: Request, input: UniversityStartInput) {
  const context = await p.mutation(req, false);
  if (p.config.authMode !== 'university') throw new ServiceUnavailableException({ code: 'university_provider_not_configured' });
  const portal = context.session.audienceHost === new URL(p.config.webOrigin).host;
  const consent = portal ? requireConsent(input.consent) : null;
  let returnContext: string | null = null;
  if (input.link) {
    if (!portal) throw new ForbiddenException({ code: 'invalid_link' });
    const link = await p.db.linkSession.findUnique({ where: { id: input.link.id } });
    p.ensurePending(link);
    if (!equal(link.tokenHash, hash(input.link.token))) throw new ForbiddenException({ code: 'invalid_link' });
    returnContext = seal(JSON.stringify(input.link), p.config.encryptionKey, 'university-return');
  }
  if (input.discordLink) {
    if (!portal) throw new ForbiddenException({ code: 'invalid_link' });
    const link = discordLinkState(await p.db.discordLinkSession.findUnique({ where: { id: input.discordLink.id } }), input.discordLink.token, true);
    if (!p.config.discord || link.guildId !== p.config.discord.guildId) throw new ForbiddenException({ code: 'discord_guild_mismatch' });
    returnContext = seal(JSON.stringify({ ...input.discordLink, kind: 'discord' }), p.config.encryptionKey, 'university-return');
  }
  const state = opaqueToken();
  await serializable(p.db, async tx => {
    await tx.universityAuthRequest.deleteMany({ where: { webSessionId: context.session.id } });
    await tx.universityAuthRequest.create({ data: { stateHash: hash(state), webSessionId: context.session.id, returnContext, consentVersion: consent?.version ?? null, consentAcceptedAt: consent?.acceptedAt ?? null, expiresAt: new Date(Date.now() + 5 * 60_000) } });
  });
  const origin = p.config.origins.find(origin => new URL(origin).host === p.host(req))!;
  return { url: buildUniversityLoginUrl(`${origin}/v1/auth/university/callback/${state}`), expiresIn: 300 };
}

export async function finishUniversity(p: PassportService, req: Request, res: Response, state: string, input: { sToken: string; sIdno: string }) {
  if (p.config.authMode !== 'university') throw new ServiceUnavailableException({ code: 'university_provider_not_configured' });
  const context = await p.context(req);
  const portal = context.session.audienceHost === new URL(p.config.webOrigin).host;
  const attempt = await serializable(p.db, async tx => {
    const attempt = await tx.universityAuthRequest.findUnique({ where: { stateHash: hash(state) } });
    if (!attempt || attempt.webSessionId !== context.session.id) throw new ForbiddenException({ code: 'university_state_invalid' });
    if (attempt.expiresAt <= new Date()) throw new GoneException({ code: 'university_request_expired' });
    if (attempt.status !== 'pending') throw new ConflictException({ code: 'university_request_consumed' });
    if (portal) requireConsent(attempt.consentAcceptedAt && attempt.consentVersion ? { accepted: true, version: attempt.consentVersion } : undefined);
    return tx.universityAuthRequest.update({ where: { id: attempt.id }, data: { status: 'processing' } });
  });
  try {
    const identity = await universityAdapter.verify(input);
    const key = studentKey(identity.studentNumber, p.config.matchingSecret);
    const token = opaqueToken();
    const tokenHash = hash(`ssu-token:${input.sToken}`);
    const authenticated = await policyTransaction(p.db, async tx => {
      const current = await tx.universityAuthRequest.findUnique({ where: { id: attempt.id } });
      const session = await tx.webSession.findUnique({ where: { id: context.session.id } });
      if (!current || current.status !== 'processing' || current.expiresAt <= new Date() || !session || session.expiresAt <= new Date()) throw new UnauthorizedException({ code: 'university_request_expired' });
      if (portal) requireConsent(current.consentAcceptedAt && current.consentVersion ? { accepted: true, version: current.consentVersion } : undefined);
      const consumed = await tx.consumedUniversityToken.findUnique({ where: { tokenHash } });
      if (consumed && consumed.expiresAt > new Date()) throw new ConflictException({ code: 'university_token_consumed' });
      const membership = await membershipForStudent(tx, key);
      const now = new Date();
      const data = { displayName: identity.name, identityProvider: 'usaint', department: identity.department, academicStatus: identity.academicStatus, admissionYear: /^(19|20)\d{6}$/.test(identity.studentNumber) ? identity.studentNumber.slice(2, 4) : null, universityVerifiedAt: now, universityVerifiedUntil: new Date(now.getTime() + 180 * 86_400_000), ...membership };
      const subject = await tx.subject.upsert({ where: { universityKey: key }, create: { universityKey: key, ...data }, update: data });
      if (portal) await recordConsent(tx, subject.id, 'portal_login', attempt.id, { version: current.consentVersion!, acceptedAt: current.consentAcceptedAt! });
      await refreshDiscordSubject(tx, subject.id, now);
      const minecraft = await tx.minecraftIdentity.findUnique({ where: { subjectId: subject.id } });
      if (minecraft) {
        const changed = await tx.minecraftIdentity.update({ where: { uuid: minecraft.uuid }, data: { policyVersion: { increment: 1 }, policyFingerprint: '' } });
        await tx.policyEvent.create({ data: { minecraftUuid: changed.uuid, policyVersion: changed.policyVersion } });
      }
      await tx.consumedUniversityToken.upsert({ where: { tokenHash }, create: { tokenHash, expiresAt: new Date(now.getTime() + 24 * 60 * 60_000) }, update: { expiresAt: new Date(now.getTime() + 24 * 60 * 60_000) } });
      await tx.webSession.delete({ where: { id: context.session.id } });
      const newSession = await tx.webSession.create({ data: { tokenHash: hash(token), subjectId: subject.id, audienceHost: session.audienceHost, expiresAt: new Date(now.getTime() + 8 * 60 * 60_000) } });
      await tx.auditEvent.create({ data: { action: 'university.login', subjectId: subject.id } });
      return { subjectId: subject.id, webSessionId: newSession.id };
    });
    p.setCookie(req, res, token, 8 * 60 * 60);
    if (attempt.returnContext) {
      let link: { id: string; token: string; kind?: 'discord' };
      try { link = parse(universityReturnContextSchema, JSON.parse(unseal(attempt.returnContext, p.config.encryptionKey, 'university-return'))); }
      catch { return '/?link_error=link_confirmation_failed'; }
      let failure: string | null = null;
      // School login has already committed. A stale or cancelled game attempt
      // rolls back only this second transaction, preserving the new school session.
      try {
        if (!portal || !attempt.consentAcceptedAt || attempt.consentVersion !== privacyNotice.version) throw new ConflictException({ code: 'consent_version_mismatch' });
        const consent = { version: attempt.consentVersion!, acceptedAt: attempt.consentAcceptedAt! };
        await policyTransaction(p.db, async tx => {
          if (link.kind === 'discord') await confirmDiscordLink(p, tx, link.id, link.token, authenticated.subjectId, authenticated.webSessionId, consent);
          else await p.confirmWebLink(tx, link.id, link.token, authenticated.subjectId, authenticated.webSessionId, consent);
        });
      } catch (error) {
        const code = error instanceof HttpException ? (error.getResponse() as { code?: string }).code : undefined;
        const safe = new Set(['link_expired', 'link_consumed', 'link_not_found', 'web_confirmation_consumed', 'membership_required', 'school_verification_required', 'subject_already_linked', 'confirming_session_expired', 'consent_version_mismatch', 'discord_link_expired', 'discord_link_consumed', 'discord_link_not_found', 'discord_already_linked', 'discord_guild_mismatch']);
        failure = code && safe.has(code) ? code : link.kind === 'discord' ? 'discord_link_confirmation_failed' : 'link_confirmation_failed';
      }
      return `${link.kind === 'discord' ? '/discord' : ''}/link/${encodeURIComponent(link.id)}${failure ? `?${link.kind === 'discord' ? 'discord_link_error' : 'link_error'}=${failure}` : ''}#token=${encodeURIComponent(link.token)}`;
    }
    return '/';
  } catch (error) {
    await p.db.universityAuthRequest.updateMany({ where: { id: attempt.id, status: 'processing' }, data: { status: 'failed' } });
    throw error;
  }
}
