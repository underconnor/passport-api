import { readGoogleSheet, sheetsConfig } from './integrations/sheets';
async function main() {
  const entries = await readGoogleSheet(sheetsConfig());
  console.log(JSON.stringify({ status: 'validated_only', total: entries.length, active: entries.filter(e => e.status === 'active').length, databaseChanged: false }));
}
main().catch(() => { console.error('Sheets validation failed or integration is unconfigured; no membership was changed.'); process.exitCode = 1; });
