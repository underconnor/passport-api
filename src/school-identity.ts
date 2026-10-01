import { seal, unseal } from './sealed';

export const semesterExpiryPolicyVersion = 1;
const koreaOffset = 9 * 60 * 60 * 1000;

/** Exclusive boundary: the next March 1 or September 1 at 00:00 in Korea. */
export function semesterVerificationExpiry(verifiedAt: Date): Date {
  if (!Number.isFinite(verifiedAt.getTime())) throw new Error('Invalid verification date');
  const koreaYear = new Date(verifiedAt.getTime() + koreaOffset).getUTCFullYear();
  for (const [year, month] of [[koreaYear, 2], [koreaYear, 8], [koreaYear + 1, 2]] as const) {
    const boundary = Date.UTC(year, month, 1) - koreaOffset;
    if (boundary > verifiedAt.getTime()) return new Date(boundary);
  }
  throw new Error('No semester boundary');
}

/** Existing expired or missing verification must never be revived by a migration. */
export function migratedVerificationExpiry(verifiedAt: Date | null, previous: Date | null, now: Date): Date | null {
  if (!verifiedAt || !previous) return previous;
  const boundary = semesterVerificationExpiry(verifiedAt);
  return previous > now ? boundary : new Date(Math.min(previous.getTime(), boundary.getTime()));
}

export function sealStudentId(studentId: string, universityKey: string, encryptionKey: string): string {
  if (!/^\d{8,10}$/.test(studentId)) throw new Error('Invalid verified student identifier');
  return seal(studentId, encryptionKey, `student-id:${universityKey}`);
}

/** Call only after owner-session or explicit administrator authorization. */
export function verifiedStudentId(subject: { identityProvider: string; universityKey: string; studentIdCiphertext: string | null }, encryptionKey: string): string | null {
  if (subject.identityProvider !== 'usaint' || !subject.studentIdCiphertext) return null;
  // A damaged value or a mismatched key must not expose data or break sign-in.
  try {
    const value = unseal(subject.studentIdCiphertext, encryptionKey, `student-id:${subject.universityKey}`);
    return /^\d{8,10}$/.test(value) ? value : null;
  } catch { return null; }
}
