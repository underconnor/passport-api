import { PrismaClient } from '@prisma/client';
import { migrateSchoolVerificationExpiry } from './school-expiry';

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--apply', '--dry-run'].includes(arg)) || args.length > 1) throw new Error('Use --dry-run (default) or --apply');
  const db = new PrismaClient();
  try { console.log(JSON.stringify(await migrateSchoolVerificationExpiry(db, args[0] === '--apply'))); }
  finally { await db.$disconnect(); }
}
void main().catch(() => { console.error('School expiry migration failed; no identity values are logged.'); process.exitCode = 1; });
