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
export const consentSchema = z.object({ accepted: z.boolean(), version: z.string().min(1).max(64) }).strict();
export const webLinkConfirmSchema = linkTokenSchema.extend({ consent: consentSchema.optional() });
export const developmentIdentitySchema = z.object({ identity: z.enum(['member', 'outsider']) }).strict();
export const discordSchema = z.object({ id: z.string().regex(/^[1-9][0-9]{0,19}$/).refine(s => /^[1-9][0-9]{0,19}$/.test(s) && BigInt(s) <= 18446744073709551615n) }).strict();
export const universityLinkContextSchema = z.object({ id: uuidSchema, token: linkTokenSchema.shape.token }).strict();
export const universityReturnContextSchema = universityLinkContextSchema.extend({ kind: z.literal('discord').optional() });
export const universityStartSchema = z.object({ link: universityLinkContextSchema.optional(), discordLink: universityLinkContextSchema.optional(), consent: consentSchema.optional() }).strict().refine(value => !(value.link && value.discordLink));
const snowflakeSchema = discordSchema.shape.id;
const discordNameSchema = z.string().trim().min(1).max(80).refine(value => !/[\x00-\x1f\x7f]/.test(value));
export const createDiscordLinkSchema = z.object({ discordUserId: snowflakeSchema, guildId: snowflakeSchema, discordUsername: discordNameSchema, discordDisplayName: discordNameSchema.optional(), interactionId: snowflakeSchema }).strict();
export const discordRoleClaimSchema = z.object({ guildId: snowflakeSchema, limit: z.number().int().min(1).max(20) }).strict();
export const discordRoleAckSchema = z.object({ leaseToken: linkTokenSchema.shape.token, version: z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value => BigInt(value) <= 9223372036854775807n), outcome: z.enum(['applied','retry','member_absent','configuration_error']) }).strict();
const discordSemesterSchema = z.string().regex(/^\d{2}-[12]$/);
export const discordSettingsSchema = z.object({ memberRoleId: snowflakeSchema.nullable(), currentSemester: discordSemesterSchema.nullable(), semesterRoles: z.array(z.object({ semester: discordSemesterSchema, roleId: snowflakeSchema }).strict()).max(40).refine(rows => new Set(rows.map(r => r.semester)).size === rows.length), nicknameEnabled: z.boolean(), expectedRevision: discordRoleAckSchema.shape.version }).strict();
export const discordReconcileSchema = z.object({ expectedRevision: discordRoleAckSchema.shape.version }).strict();
export const discordV2ClaimSchema = discordRoleClaimSchema.extend({ contractVersion: z.literal(2), settingsRevision: discordRoleAckSchema.shape.version }).strict();
export const discordV2RoleAckSchema = discordRoleAckSchema.extend({ contractVersion: z.literal(2) }).strict();
export const discordNicknameAckSchema = discordRoleAckSchema.extend({ contractVersion: z.literal(2), outcome: z.enum(['applied','retry','member_absent','configuration_error','not_manageable']) }).strict();
export const discordConsentSchema = z.object({ consent: consentSchema }).strict();
export const universityCallbackSchema = z.object({ sToken: z.string().min(16).max(8192), sIdno: z.string().regex(/^\d{8,10}$/) });
export const enrollmentSchema = z.object({ bootstrapToken: z.string().min(43).max(128) }).strict();
export const mfaSchema = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
export const accessSchema = z.object({ suspended: z.boolean(), restricted: z.boolean(), serverIds: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).max(64) }).strict();
export const rosterSyncSchema = z.object({ expectedApprovalDigest: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
export const serverIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const serverCommandNameSchema = z.string().transform(value => value.normalize('NFC').toLowerCase()).pipe(z.string().min(1).max(64).regex(/^[a-z0-9가-힣_-]+$/));
const serverLabelSchema = z.string().trim().min(1).max(80).refine(value => !/[\x00-\x1f\x7f]/.test(value));
export const serverHeartbeatSchema = z.object({ source: z.enum(['velocity', 'paper']), servers: z.array(z.object({ id: serverIdSchema, label: serverLabelSchema }).strict()).max(64).refine(servers => new Set(servers.map(server => server.id)).size === servers.length) }).strict();
export const serverSettingsSchema = z.object({ commandName: serverCommandNameSchema.optional(), discordRequirement: z.enum(['any', 'linked', 'unlinked']).optional(), statisticsEnabled: z.boolean().optional(), label: serverLabelSchema, sensitive: z.boolean(), enabled: z.boolean(), accessMode: z.enum(['members', 'selected', 'university', 'staff']), allowedSubjectIds: z.array(uuidSchema).max(5000).refine(ids => new Set(ids).size === ids.length), expectedUpdatedAt: z.string().datetime({ offset: true }) }).strict();
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new BadRequestException({ code: 'invalid_request', message: 'Request has invalid fields' });
  return result.data;
}

const memberIdsSchema = z.string().max(1849).transform(value => value.split(',')).pipe(z.array(uuidSchema).min(1).max(50).refine(ids => new Set(ids).size === ids.length));
export const memberQuerySchema = z.object({ ids: memberIdsSchema.optional(), q: z.string().trim().max(128).default(''), membership: z.enum(['all','active','inactive','suspended']).default('all'), sort: z.enum(['name','newest','oldest']).default('name'), limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().max(1024).optional() }).strict();
export const deleteMemberSchema = z.object({ expectedRevision: z.string().regex(/^[a-f0-9]{64}$/), confirmation: z.string().min(1).max(120) }).strict();
export const playerQuerySchema = z.object({ query: z.string().trim().min(1).max(128) }).strict();
export const presenceSchema = z.object({ serverId: serverIdSchema, observedAt: z.string().datetime({ offset: true }), players: z.array(uuidSchema).max(500).refine(ids => new Set(ids).size === ids.length) }).strict();
const counterSchema = z.number().int().min(0).max(2147483647);
export const activityBatchSchema = z.object({ id: uuidSchema, serverId: serverIdSchema, records: z.array(z.object({ minecraftUuid: uuidSchema, epoch: uuidSchema, playSeconds: counterSchema, blocksBroken: counterSchema, blocksPlaced: counterSchema, damageTakenMilli: counterSchema, deaths: counterSchema, mobKills: counterSchema, playerKills: counterSchema.default(0), distanceCm: counterSchema.default(0) }).strict()).min(1).max(100).refine(rows => new Set(rows.map(row => row.minecraftUuid)).size === rows.length) }).strict();

export const adminRoleSchema = z.enum(['owner', 'operator', 'viewer']);
export const operatorInvitationSchema = z.object({ subjectId: uuidSchema, role: adminRoleSchema }).strict();
export const operatorRoleSchema = z.object({ role: adminRoleSchema }).strict();
export const emptyMutationSchema = z.object({}).strict();

export const statisticsResetScopeSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('subject'), subjectId: uuidSchema }).strict(),
  z.object({ scope: z.literal('server'), serverId: serverIdSchema }).strict(),
  z.object({ scope: z.literal('all') }).strict(),
]);
const resetConfirmation = { expectedRevision: z.string().regex(/^[a-f0-9]{64}$/), confirmation: z.string().max(100) };
export const statisticsResetSchema = z.discriminatedUnion('scope', [statisticsResetScopeSchema.options[0].extend(resetConfirmation), statisticsResetScopeSchema.options[1].extend(resetConfirmation), statisticsResetScopeSchema.options[2].extend(resetConfirmation)]);

const statisticsDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
const statisticsPeriodFields = { from: statisticsDateSchema.optional(), to: statisticsDateSchema.optional() };
const validStatisticsPeriod = (value: { from?: string; to?: string }) => (!value.from && !value.to) || Boolean(value.from && value.to && value.from <= value.to && Date.parse(value.to) - Date.parse(value.from) <= 365 * 86400000);
const statisticsMembershipSchema = z.enum(['all', 'active']).default('all');
export const statisticsQuerySchema = z.object(statisticsPeriodFields).strict().refine(validStatisticsPeriod);
export const adminStatisticsQuerySchema = z.object({ ...statisticsPeriodFields, membership: statisticsMembershipSchema }).strict().refine(validStatisticsPeriod);
export const statisticsExportSchema = z.object({ ...statisticsPeriodFields, membership: statisticsMembershipSchema, serverId: serverIdSchema.optional(), subjectId: uuidSchema.optional() }).strict().refine(validStatisticsPeriod);
