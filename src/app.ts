import 'reflect-metadata';
import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, HttpException, Module, Param, Post, Put, Req, Res, ServiceUnavailableException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import { PassportService } from './passport.service';
import { createLinkSchema, developmentIdentitySchema, discordSchema, gameIdentitySchema, linkTokenSchema, parse, uuidSchema } from './security';

@Controller()
class PassportController {
  constructor(private readonly passport: PassportService) {}
  @Get('healthz') async health() { await this.passport.db.$queryRaw`SELECT 1`; return { status: 'ok', authMode: this.passport.config.authMode }; }
  @Get('v1/auth/session') session(@Req() req: Request, @Res({ passthrough: true }) res: Response) { return this.passport.session(req, res); }
  @Post('v1/auth/development') @HttpCode(200) development(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: unknown) { return this.passport.developmentLogin(req, res, parse(developmentIdentitySchema, body).identity); }
  @Post('v1/auth/university/start') async universityStart(@Req() req: Request) { await this.passport.mutation(req, false); throw new ServiceUnavailableException({ code: 'university_provider_not_configured', message: 'Real university verification is not enabled' }); }
  @Get('v1/auth/university/callback') universityCallback() { throw new ServiceUnavailableException({ code: 'university_provider_not_configured' }); }
  @Post('v1/auth/logout') @HttpCode(204) logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) { return this.passport.logout(req, res); }
  @Get('v1/me') me(@Req() req: Request) { return this.passport.me(req); }
  @Get('v1/me/servers') servers(@Req() req: Request) { return this.passport.myServers(req); }
  @Put('v1/me/discord-id') discord(@Req() req: Request, @Body() body: unknown) { return this.passport.discord(req, parse(discordSchema, body).id); }
  @Delete('v1/me/discord-id') @HttpCode(204) async removeDiscord(@Req() req: Request) { await this.passport.discord(req, null); }
  @Post('v1/link-sessions') createLink(@Req() req: Request, @Body() body: unknown) { return this.passport.createLink(req, parse(createLinkSchema, body)); }
  @Post('v1/link-sessions/:id/inspect') @HttpCode(200) inspect(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return this.passport.inspectLink(req, parse(uuidSchema, id), parse(linkTokenSchema, body).token); }
  @Post('v1/link-sessions/:id/web-confirm') @HttpCode(200) webConfirm(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return this.passport.webConfirm(req, parse(uuidSchema, id), parse(linkTokenSchema, body).token); }
  @Post('v1/link-sessions/:id/game-confirm') @HttpCode(200) gameConfirm(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return this.passport.gameConfirm(req, parse(uuidSchema, id), parse(gameIdentitySchema, body)); }
  @Delete('v1/link-sessions/:id') @HttpCode(204) cancel(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return this.passport.cancelLink(req, parse(uuidSchema, id), parse(gameIdentitySchema, body)); }
  @Get('v1/minecraft/policies/:uuid') policy(@Req() req: Request, @Param('uuid') uuid: string) { return this.passport.policy(req, parse(uuidSchema, uuid)); }
  @Get('v1/minecraft/servers') registry(@Req() req: Request) { this.passport.service(req); return { servers: this.passport.config.servers }; }
  @Get('v1/admin/overview') async admin(@Req() req: Request) { await this.passport.context(req, true); throw new ForbiddenException({ code: 'admin_unavailable', message: 'Admin enrollment and MFA are not configured' }); }
}
@Module({ controllers: [PassportController], providers: [PassportService] })
class PassportModule {}
export async function createApp() {
  const app = await NestFactory.create(PassportModule, { logger: ['error', 'warn'], bodyParser: true });
  app.use(helmet({ contentSecurityPolicy: false }));
  // Single-instance development guard. A shared gateway limiter is required before public multi-replica rollout.
  const buckets = new Map<string, { count: number; expires: number }>();
  app.use((req: Request, res: Response, next: NextFunction) => {
    const limited = req.path === '/v1/auth/session' || req.path === '/v1/auth/development' || (req.path === '/v1/link-sessions' && req.method === 'POST');
    if (!limited) return next();
    const now = Date.now();
    for (const [key, value] of buckets) if (value.expires <= now) buckets.delete(key);
    const key = `${req.ip}:${req.path}`;
    const bucket = buckets.get(key) ?? { count: 0, expires: now + 60000 };
    const limit = req.path === '/v1/auth/development' ? 20 : 120;
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
    if (error instanceof HttpException) response.status(error.getStatus()).json(error.getResponse());
    else response.status(503).json({ code: 'temporarily_unavailable' });
  } });
  app.enableShutdownHooks();
  await app.init();
  return app;
}
