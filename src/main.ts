import { createApp } from './app';
import { PassportService } from './passport.service';
async function main() {
  const app = await createApp();
  const config = app.get(PassportService).config;
  await app.listen(config.port, config.bindHost);
  console.log(`Passport API listening on ${config.bindHost}:${config.port} (${config.authMode})`);
}
main().catch(() => { console.error('Passport startup failed. Check required configuration and database connectivity.'); process.exitCode = 1; });
