import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function seal(value: string, hexKey: string, purpose: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(hexKey, 'hex'), iv);
  cipher.setAAD(Buffer.from(purpose));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(b => b.toString('base64url')).join('.');
}
export function unseal(value: string, hexKey: string, purpose: string): string {
  const pieces = value.split('.');
  if (pieces.length !== 3) throw new Error('Invalid sealed value');
  const [iv, tag, encrypted] = pieces.map(p => Buffer.from(p, 'base64url'));
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(hexKey, 'hex'), iv!);
  cipher.setAAD(Buffer.from(purpose));
  cipher.setAuthTag(tag!);
  return Buffer.concat([cipher.update(encrypted!), cipher.final()]).toString('utf8');
}
