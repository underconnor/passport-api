import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes: Buffer) {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
function decode(secret: string) {
  let bits = 0, value = 0; const bytes: number[] = [];
  for (const char of secret) {
    const digit = alphabet.indexOf(char); if (digit < 0) throw new Error('Invalid TOTP secret');
    value = (value << 5) | digit; bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}
export const newTotpSecret = () => base32(randomBytes(20));
export function totpAt(secret: string, step: number) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}
export function verifyTotp(secret: string, code: string, lastStep: bigint, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 30000);
  for (const step of [current, current - 1, current + 1]) {
    if (step >= 0 && BigInt(step) > lastStep && timingSafeEqual(Buffer.from(totpAt(secret, step)), Buffer.from(code))) return step;
  }
  return null;
}
