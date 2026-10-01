import type { PrismaClient } from '@prisma/client';
import { policyTransaction } from './database';
import { refreshDiscordSubject } from './discord-policy';
import { migratedVerificationExpiry, semesterExpiryPolicyVersion } from './school-identity';

/** Idempotent, restart-safe conversion. Each account and its projections commit together. */
export async function migrateSchoolVerificationExpiry(db: PrismaClient, apply: boolean, now = new Date()) {
  const candidates = await db.subject.findMany({ where: { identityProvider: 'usaint', universityExpiryPolicyVersion: { lt: semesterExpiryPolicyVersion } }, select: { id: true } });
  const result = { candidates: candidates.length, changed: 0, marked: 0, expiredPreserved: 0, applied: apply };
  for (const candidate of candidates) {
    const outcome = await policyTransaction(db, async tx => {
      const subject = await tx.subject.findUnique({ where: { id: candidate.id } });
      if (!subject || subject.universityExpiryPolicyVersion >= semesterExpiryPolicyVersion) return;
      const until = migratedVerificationExpiry(subject.universityVerifiedAt, subject.universityVerifiedUntil, now);
      const changed = until?.getTime() !== subject.universityVerifiedUntil?.getTime();
      const outcome = { changed, expiredPreserved: Boolean(subject.universityVerifiedUntil && subject.universityVerifiedUntil <= now) };
      if (!apply) return outcome;
      await tx.subject.update({ where: { id: subject.id }, data: { universityVerifiedUntil: until, universityExpiryPolicyVersion: semesterExpiryPolicyVersion } });
      if (!changed) return outcome;
      await refreshDiscordSubject(tx, subject.id, now);
      const minecraft = await tx.minecraftIdentity.findUnique({ where: { subjectId: subject.id } });
      if (minecraft) {
        const updated = await tx.minecraftIdentity.update({ where: { uuid: minecraft.uuid }, data: { policyVersion: { increment: 1 }, policyFingerprint: '' } });
        await tx.policyEvent.create({ data: { minecraftUuid: updated.uuid, policyVersion: updated.policyVersion } });
      }
      await tx.auditEvent.create({ data: { action: 'university.semester_expiry_migrated', subjectId: subject.id } });
      return outcome;
    });
    if (outcome) { result.marked++; if (outcome.changed) result.changed++; if (outcome.expiredPreserved) result.expiredPreserved++; }
  }
  return result;
}
