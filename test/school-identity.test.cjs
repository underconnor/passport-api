const { test } = require('node:test');
const assert = require('node:assert/strict');
const { semesterVerificationExpiry, migratedVerificationExpiry, sealStudentId, verifiedStudentId } = require('../dist/school-identity');

test('school verification ends at the next semester boundary in Korea, including leap years', () => {
  for (const [verified, expected] of [
    ['2026-10-01T10:00:00Z', '2027-02-28T15:00:00.000Z'],
    ['2026-05-01T10:00:00Z', '2026-08-31T15:00:00.000Z'],
    ['2027-10-01T10:00:00Z', '2028-02-29T15:00:00.000Z'],
    ['2026-02-28T14:59:59.999Z', '2026-02-28T15:00:00.000Z'],
    ['2026-02-28T15:00:00.000Z', '2026-08-31T15:00:00.000Z'],
    ['2026-08-31T14:59:59.999Z', '2026-08-31T15:00:00.000Z'],
    ['2026-08-31T15:00:00.000Z', '2027-02-28T15:00:00.000Z'],
    ['2026-12-31T15:00:00.000Z', '2027-02-28T15:00:00.000Z'],
  ]) assert.equal(semesterVerificationExpiry(new Date(verified)).toISOString(), expected);
  assert.throws(() => semesterVerificationExpiry(new Date('invalid')));
});

test('calendar expiry conversion preserves missing verification and cannot revive an expired account', () => {
  const verified = new Date('2026-10-01T00:00:00Z'), now = new Date('2026-11-01T00:00:00Z');
  assert.equal(migratedVerificationExpiry(verified, null, now), null);
  const previous = new Date('2026-10-15T00:00:00Z');
  assert.equal(migratedVerificationExpiry(verified, previous, now).getTime(), previous.getTime());
  assert.equal(migratedVerificationExpiry(verified, now, now).getTime(), now.getTime());
  assert.equal(migratedVerificationExpiry(null, previous, now).getTime(), previous.getTime());
  assert.equal(migratedVerificationExpiry(new Date('2026-08-01T00:00:00Z'), new Date('2027-01-01T00:00:00Z'), now).toISOString(), '2026-08-31T15:00:00.000Z');
  assert.equal(migratedVerificationExpiry(verified, new Date('2027-03-30T00:00:00Z'), now).toISOString(), '2027-02-28T15:00:00.000Z');
});

test('student ID ciphertext is randomized, account-bound and fails closed for tampering or wrong keys', () => {
  const key = 'ab'.repeat(32), studentId = '99990001', universityKey = 'synthetic-account-key';
  const ciphertext = sealStudentId(studentId, universityKey, key);
  const subject = { identityProvider: 'usaint', universityKey, studentIdCiphertext: ciphertext };
  assert.ok(!ciphertext.includes(studentId));
  assert.notEqual(ciphertext, sealStudentId(studentId, universityKey, key));
  assert.equal(verifiedStudentId(subject, key), studentId);
  assert.equal(verifiedStudentId({ ...subject, universityKey: 'another-account' }, key), null);
  assert.equal(verifiedStudentId(subject, 'cd'.repeat(32)), null);
  assert.equal(verifiedStudentId({ ...subject, studentIdCiphertext: ciphertext.slice(0, -2) + 'AA' }, key), null);
  assert.equal(verifiedStudentId({ ...subject, identityProvider: 'development' }, key), null);
  assert.equal(verifiedStudentId({ ...subject, studentIdCiphertext: null }, key), null);
  assert.throws(() => sealStudentId('bad identifier', universityKey, key));
});
