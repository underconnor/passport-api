import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
export const opaqueToken = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const equal = (left: string, right: string) => timingSafeEqual(Buffer.from(hash(left)), Buffer.from(hash(right)));
export const csrf = (secret: string, sessionToken: string) => createHmac('sha256', secret).update(`csrf:${sessionToken}`).digest('base64url');
export const uuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).transform(s => s.toLowerCase());
export const gameIdentitySchema = z.object({ minecraftUuid: uuidSchema, gameSessionId: z.string().min(16).max(128) }).strict();
export const createLinkSchema = gameIdentitySchema.extend({ minecraftName: z.string().regex(/^[A-Za-z0-9_]{1,16}$/) });
export const linkTokenSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
export const developmentIdentitySchema = z.object({ identity: z.enum(['member', 'outsider']) }).strict();
export const discordSchema = z.object({ id: z.string().regex(/^[1-9][0-9]{0,19}$/).refine(s => /^[1-9][0-9]{0,19}$/.test(s) && BigInt(s) <= 18446744073709551615n) }).strict();
export const universityStartSchema = z.object({ link: z.object({ id: uuidSchema, token: linkTokenSchema.shape.token }).strict().optional() }).strict();
export const universityCallbackSchema = z.object({ sToken: z.string().min(16).max(8192), sIdno: z.string().regex(/^\d{8,10}$/) });
export const enrollmentSchema = z.object({ bootstrapToken: z.string().min(43).max(128) }).strict();
export const mfaSchema = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
export const accessSchema = z.object({ suspended: z.boolean(), restricted: z.boolean(), serverIds: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).max(64) }).strict();
export const rosterSyncSchema = z.object({ expectedApprovalDigest: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
export const serverIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const serverLabelSchema = z.string().trim().min(1).max(80).refine(value => !/[\x00-\x1f\x7f]/.test(value));
export const serverHeartbeatSchema = z.object({ source: z.enum(['velocity', 'paper']), servers: z.array(z.object({ id: serverIdSchema, label: serverLabelSchema }).strict()).max(64).refine(servers => new Set(servers.map(server => server.id)).size === servers.length) }).strict();
export const serverSettingsSchema = z.object({ label: serverLabelSchema, sensitive: z.boolean(), enabled: z.boolean(), accessMode: z.enum(['roster', 'members', 'selected']), allowedSubjectIds: z.array(uuidSchema).max(5000).refine(ids => new Set(ids).size === ids.length), expectedUpdatedAt: z.string().datetime({ offset: true }) }).strict();
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new BadRequestException({ code: 'invalid_request', message: 'Request has invalid fields' });
  return result.data;
}
