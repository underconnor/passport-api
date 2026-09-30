import { ConflictException, ForbiddenException, GoneException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { PassportService } from './passport.service';
import { SsuSaintAdapter, buildUniversityLoginUrl } from './integrations/usaint';
import { studentKey } from './integrations/sheets';
import { membershipForStudent } from './membership-sync';
import { hash, opaqueToken, equal } from './security';
import { seal, unseal } from './sealed';
import { policyTransaction, serializable } from './database';

export type UniversityStartInput = { link?: { id: string; token: string } };
export const universityAdapter = new SsuSaintAdapter();

export async function startUniversity(p: PassportService, req: Request, input: UniversityStartInput) {
  const context = await p.mutation(req, false);
  if (p.config.authMode !== 'university') throw new ServiceUnavailableException({ code: 'university_provider_not_configured' });
  let returnContext: string | null = null;
  if (input.link) {
    const link = await p.db.linkSession.findUnique({ where: { id: input.link.id } });
    p.ensurePending(link);
    if (!equal(link.tokenHash, hash(input.link.token))) throw new ForbiddenException({ code: 'invalid_link' });
    returnContext = seal(JSON.stringify(input.link), p.config.encryptionKey, 'university-return');
  }
  const state = opaqueToken();
  await serializable(p.db, async tx => {
    await tx.universityAuthRequest.deleteMany({ where: { webSessionId: context.session.id } });
    await tx.universityAuthRequest.create({ data: { stateHash: hash(state), webSessionId: context.session.id, returnContext, expiresAt: new Date(Date.now() + 5 * 60_000) } });
  });
  const origin = p.config.origins.find(origin => new URL(origin).host === p.host(req))!;
  return { url: buildUniversityLoginUrl(`${origin}/v1/auth/university/callback/${state}`), expiresIn: 300 };
}

export async function finishUniversity(p: PassportService, req: Request, res: Response, state: string, input: { sToken: string; sIdno: string }) {
  if (p.config.authMode !== 'university') throw new ServiceUnavailableException({ code: 'university_provider_not_configured' });
  const context = await p.context(req);
  const attempt = await serializable(p.db, async tx => {
    const attempt = await tx.universityAuthRequest.findUnique({ where: { stateHash: hash(state) } });
    if (!attempt || attempt.webSessionId !== context.session.id) throw new ForbiddenException({ code: 'university_state_invalid' });
    if (attempt.expiresAt <= new Date()) throw new GoneException({ code: 'university_request_expired' });
    if (attempt.status !== 'pending') throw new ConflictException({ code: 'university_request_consumed' });
    return tx.universityAuthRequest.update({ where: { id: attempt.id }, data: { status: 'processing' } });
  });
  try {
    const identity = await universityAdapter.verify(input);
    const key = studentKey(identity.studentNumber, p.config.matchingSecret);
    const token = opaqueToken();
    const tokenHash = hash(`ssu-token:${input.sToken}`);
    await policyTransaction(p.db, async tx => {
      const current = await tx.universityAuthRequest.findUnique({ where: { id: attempt.id } });
      const session = await tx.webSession.findUnique({ where: { id: context.session.id } });
      if (!current || current.status !== 'processing' || current.expiresAt <= new Date() || !session || session.expiresAt <= new Date()) throw new UnauthorizedException({ code: 'university_request_expired' });
      const consumed = await tx.consumedUniversityToken.findUnique({ where: { tokenHash } });
      if (consumed && consumed.expiresAt > new Date()) throw new ConflictException({ code: 'university_token_consumed' });
      const membership = await membershipForStudent(tx, key);
      const now = new Date();
      const data = { displayName: identity.name, identityProvider: 'usaint', department: identity.department, academicStatus: identity.academicStatus, universityVerifiedAt: now, universityVerifiedUntil: new Date(now.getTime() + 180 * 86_400_000), ...membership };
      const subject = await tx.subject.upsert({ where: { universityKey: key }, create: { universityKey: key, ...data }, update: data });
      const minecraft = await tx.minecraftIdentity.findUnique({ where: { subjectId: subject.id } });
      if (minecraft) {
        const changed = await tx.minecraftIdentity.update({ where: { uuid: minecraft.uuid }, data: { policyVersion: { increment: 1 }, policyFingerprint: '' } });
        await tx.policyEvent.create({ data: { minecraftUuid: changed.uuid, policyVersion: changed.policyVersion } });
      }
      await tx.consumedUniversityToken.upsert({ where: { tokenHash }, create: { tokenHash, expiresAt: new Date(now.getTime() + 24 * 60 * 60_000) }, update: { expiresAt: new Date(now.getTime() + 24 * 60 * 60_000) } });
      await tx.webSession.delete({ where: { id: context.session.id } });
      await tx.webSession.create({ data: { tokenHash: hash(token), subjectId: subject.id, audienceHost: session.audienceHost, expiresAt: new Date(now.getTime() + 8 * 60 * 60_000) } });
      await tx.auditEvent.create({ data: { action: 'university.login', subjectId: subject.id } });
    });
    p.setCookie(req, res, token, 8 * 60 * 60);
    if (attempt.returnContext) {
      const link = JSON.parse(unseal(attempt.returnContext, p.config.encryptionKey, 'university-return')) as { id: string; token: string };
      return `/link/${encodeURIComponent(link.id)}#token=${encodeURIComponent(link.token)}`;
    }
    return '/';
  } catch (error) {
    await p.db.universityAuthRequest.updateMany({ where: { id: attempt.id, status: 'processing' }, data: { status: 'failed' } });
    throw error;
  }
}
