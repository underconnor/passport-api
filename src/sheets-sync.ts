import { PrismaClient } from '@prisma/client';
import { previewRosterSync, RosterSyncError, runRosterSync } from './membership-sync';

async function main() {
  const [command = 'preview', approval] = process.argv.slice(2);
  if (!['preview', 'apply'].includes(command) || (approval && !/^[a-f0-9]{64}$/.test(approval)) || process.argv.length > 4) throw new RosterSyncError('configuration_error');
  const db = new PrismaClient();
  try {
    const result = command === 'preview' ? await previewRosterSync(db) : await runRosterSync(db, process.env, { expectedApprovalDigest: approval });
    console.log(JSON.stringify(result));
  } finally { await db.$disconnect(); }
}
main().catch(error => {
  console.error(JSON.stringify({ error: error instanceof RosterSyncError ? error.code : 'apply_failed', ...(error instanceof RosterSyncError && error.preview ? { preview: error.preview } : {}) }));
  process.exitCode = 1;
});
