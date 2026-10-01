import 'reflect-metadata';
import { Body, Controller, Delete, Get, HttpCode, HttpException, Module, Param, Post, Put, Query, Req, Res, ServiceUnavailableException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import { PassportService } from './passport.service';
import { accessSchema, createLinkSchema, developmentIdentitySchema, discordSchema, enrollmentSchema, gameIdentitySchema, linkTokenSchema, mfaSchema, parse, rosterSyncSchema, serverHeartbeatSchema, serverIdSchema, serverSettingsSchema, universityCallbackSchema, universityStartSchema, uuidSchema } from './security';
import { startUniversity, finishUniversity } from './university-auth';
import { adminAudit, adminContext, adminMembers, adminOverview, adminStatus, beginEnrollment, setMemberAccess, unlinkMember, verifyAdminMfa } from './admin';
import { RosterSyncError } from './membership-sync';
import { UniversityVerificationError } from './integrations/usaint';
import { adminServers, heartbeatServers, setServerSettings } from './registry';

@Controller()
class PassportController {
  constructor(private readonly passport: PassportService) {}
  @Get('healthz') async health() { await this.passport.db.$queryRaw`SELECT 1`; return { status: 'ok', authMode: this.passport.config.authMode }; }
  @Get('v1/auth/session') session(@Req() req: Request, @Res({ passthrough: true }) res: Response) { return this.passport.session(req, res); }
  @Post('v1/auth/development') @HttpCode(200) development(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: unknown) { return this.passport.developmentLogin(req, res, parse(developmentIdentitySchema, body).identity); }
  @Post('v1/auth/university/start') @HttpCode(200) universityStart(@Req() req: Request, @Body() body: unknown) { return startUniversity(this.passport, req, parse(universityStartSchema, body)); }
  @Get('v1/auth/university/callback') universityCallback() { throw new ServiceUnavailableException({ code: 'university_provider_not_configured' }); }
  @Get('v1/auth/university/callback/:state') async universityReturn(@Req() req: Request, @Res() res: Response, @Param('state') state: string, @Query() query: unknown) {
    try {
      if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new Error('invalid_state');
      const target = await finishUniversity(this.passport, req, res, state, parse(universityCallbackSchema, query));
      res.redirect(303, target);
    } catch (error) {
      const code = error instanceof UniversityVerificationError ? `university_${error.code}` : error instanceof HttpException ? (error.getResponse() as { code?: string }).code : 'university_verification_failed';
      const safeCode = code && /^[a-z_]{1,64}$/.test(code) ? code : 'university_verification_failed';
      res.redirect(303, `/?auth_error=${safeCode}`);
    }
  }
  @Post('v1/auth/logout') @HttpCode(204) logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) { return this.passport.logout(req, res); }
  @Get('v1/me') me(@Req() req: Request) { return this.passport.me(req); }
  @Get('v1/me/servers') servers(@Req() req: Request) { return this.passport.myServers(req); }
  @Put('v1/me/discord-id') discord(@Req() req: Request, @Body() body: unknown) { return this.passport.discord(req, parse(discordSchema, body).id); }
  @Delete('v1/me/discord-id') @HttpCode(204) async removeDiscord(@Req() req: Request) { await this.passport.discord(req, null); }
  @Post('v1/link-sessions') createLink(@Req() req: Request, @Body() body: unknown) { return this.passport.createLink(req, parse(createLinkSchema, body)); }
  @Post('v1/link-sessions/:id/inspect') @HttpCode(200) inspect(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return this.passport.inspectLink(req, parse(uuidSchema, id), parse(linkTokenSchema, body).token); }
  @Post('v1/link-sessions/:id/game-inspect') @HttpCode(200) gameInspect(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return this.passport.inspectGameLink(req, parse(uuidSchema, id), parse(gameIdentitySchema, body)); }
  @Post('v1/link-sessions/:id/web-confirm') @HttpCode(200) webConfirm(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return this.passport.webConfirm(req, parse(uuidSchema, id), parse(linkTokenSchema, body).token); }
  @Post('v1/link-sessions/:id/game-confirm') @HttpCode(200) gameConfirm(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return this.passport.gameConfirm(req, parse(uuidSchema, id), parse(gameIdentitySchema, body)); }
  @Delete('v1/link-sessions/:id') @HttpCode(204) cancel(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return this.passport.cancelLink(req, parse(uuidSchema, id), parse(gameIdentitySchema, body)); }
  @Get('v1/minecraft/policies/:uuid') policy(@Req() req: Request, @Param('uuid') uuid: string) { return this.passport.policy(req, parse(uuidSchema, uuid)); }
  @Get('v1/minecraft/servers') async registry(@Req() req: Request) { this.passport.service(req); return { servers: await this.passport.db.serverRecord.findMany({ where: { enabled: true }, orderBy: { id: 'asc' }, select: { id: true, label: true, sensitive: true } }) }; }
  @Post('v1/minecraft/servers/heartbeat') @HttpCode(200) heartbeat(@Req() req: Request, @Body() body: unknown) { return heartbeatServers(this.passport, req, parse(serverHeartbeatSchema, body)); }
  @Get('v1/minecraft/events') events(@Req() req: Request, @Query('after') after?: string) { return this.passport.policyEvents(req, after); }
  @Get('v1/admin/session') adminSession(@Req() req: Request) { return adminStatus(this.passport, req); }
  @Post('v1/admin/enrollment') @HttpCode(200) enroll(@Req() req: Request, @Body() body: unknown) { return beginEnrollment(this.passport, req, parse(enrollmentSchema, body).bootstrapToken); }
  @Post('v1/admin/mfa') @HttpCode(200) mfa(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: unknown) { return verifyAdminMfa(this.passport, req, res, parse(mfaSchema, body).code); }
  @Get('v1/admin/overview') admin(@Req() req: Request) { return adminOverview(this.passport, req); }
  @Get('v1/admin/members') members(@Req() req: Request, @Query('cursor') cursor?: string) { return adminMembers(this.passport, req, cursor ? parse(uuidSchema, cursor) : undefined); }
  @Get('v1/admin/servers') adminServers(@Req() req: Request) { return adminServers(this.passport, req); }
  @Put('v1/admin/servers/:id') serverSettings(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return setServerSettings(this.passport, req, parse(serverIdSchema, id), parse(serverSettingsSchema, body)); }
  @Put('v1/admin/members/:id/access') access(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return setMemberAccess(this.passport, req, parse(uuidSchema, id), parse(accessSchema, body)); }
  @Delete('v1/admin/members/:id/minecraft') unlink(@Req() req: Request, @Param('id') id: string) { return unlinkMember(this.passport, req, parse(uuidSchema, id)); }
  @Get('v1/admin/audit') audit(@Req() req: Request) { return adminAudit(this.passport, req); }
  @Post('v1/admin/roster/preview') @HttpCode(200) async rosterPreview(@Req() req: Request) { await adminContext(this.passport, req, true); return this.passport.membership.preview(); }
  @Post('v1/admin/roster/sync') @HttpCode(200) async rosterSync(@Req() req: Request, @Body() body: unknown) {
    const c = await adminContext(this.passport, req, true); const input = parse(rosterSyncSchema, body);
    const result = input.expectedApprovalDigest ? await this.passport.membership.approve(input.expectedApprovalDigest) : await this.passport.membership.sync();
    await this.passport.db.auditEvent.create({ data: { action: 'admin.roster_sync', actorSubjectId: c.session.subjectId, objectId: result.digest } });
    return result;
  }
}
@Module({ controllers: [PassportController], providers: [PassportService] })
class PassportModule {}
export async function createApp() {
  const app = await NestFactory.create(PassportModule, { logger: ['error', 'warn'], bodyParser: true });
  // Enable only with a fixed, private proxy chain. Staging has Caddy -> nginx -> API.
  app.getHttpAdapter().getInstance().set('trust proxy', app.get(PassportService).config.trustProxyHops);
  app.use(helmet({ contentSecurityPolicy: false }));
  // Bounded single-instance limiter; deployment currently uses one API replica.
  const buckets = new Map<string, { count: number; expires: number }>();
  app.use((req: Request, res: Response, next: NextFunction) => {
    const limited = req.path.startsWith('/v1/auth/') || req.path === '/v1/admin/mfa' || req.path === '/v1/admin/enrollment' || (req.path === '/v1/link-sessions' && req.method === 'POST');
    if (!limited) return next();
    const now = Date.now();
    for (const [key, value] of buckets) if (value.expires <= now) buckets.delete(key);
    const bucketPath = req.path.startsWith('/v1/auth/university/callback/') ? '/v1/auth/university/callback' : req.path;
    const key = `${req.ip}:${bucketPath}`;
    const bucket = buckets.get(key) ?? { count: 0, expires: now + 60000 };
    const limit = req.path === '/v1/admin/mfa' ? 10 : req.path === '/v1/admin/enrollment' ? 5 : req.path.includes('/university/') || req.path === '/v1/auth/development' ? 20 : 120;
    if (bucket.count >= limit || (buckets.size >= 10000 && !buckets.has(key))) {
      res.setHeader('Retry-After', '60'); return res.status(429).json({ code: 'rate_limited' });
    }
    bucket.count++; buckets.set(key, bucket); next();
  });
  // No request URLs, cookies, bodies or university inputs are logged.
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); next();
  });
  app.useGlobalFilters({ catch(error: unknown, host) {
    const response = host.switchToHttp().getResponse<Response>();
    if (error instanceof RosterSyncError) response.status(error.code.startsWith('approval') ? 409 : 503).json({ code: error.code, ...(error.preview ? { preview: error.preview } : {}) });
    else if (error instanceof UniversityVerificationError) response.status(503).json({ code: `university_${error.code}` });
    else if (error instanceof HttpException) response.status(error.getStatus()).json(error.getResponse());
    else response.status(503).json({ code: 'temporarily_unavailable' });
  } });
  app.enableShutdownHooks();
  await app.init();
  return app;
}
