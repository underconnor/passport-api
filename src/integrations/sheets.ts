import { createHmac } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';

export type RosterEntry = { studentKey: string; status: 'active' | 'inactive' | 'suspended'; roleLabel: string; serverIds: string[] };
export type SheetsConfig = { spreadsheetId: string; range: string; credentialsFile: string; matchingSecret: string; allowedServerIds: string[] };
export function sheetsConfig(env = process.env): SheetsConfig {
  const spreadsheetId = env.SHEETS_SPREADSHEET_ID;
  const range = env.SHEETS_RANGE;
  const credentialsFile = env.GOOGLE_APPLICATION_CREDENTIALS;
  const matchingSecret = env.ROSTER_MATCHING_SECRET;
  if (!spreadsheetId || !/^[A-Za-z0-9_-]{10,200}$/.test(spreadsheetId) || !range || range.length > 200 || !credentialsFile || !matchingSecret || matchingSecret.length < 32) throw new Error('Sheets integration is not configured');
  const registry = JSON.parse(env.SERVER_REGISTRY_JSON ?? '[{"id":"lobby"},{"id":"survival"}]') as { id: string }[];
  if (!Array.isArray(registry) || registry.some(s => !/^[a-z][a-z0-9_-]{0,63}$/.test(s.id))) throw new Error('Invalid server registry');
  return { spreadsheetId, range, credentialsFile, matchingSecret, allowedServerIds: registry.map(s => s.id) };
}
export function studentKey(studentId: string, secret: string) {
  if (!/^\d{8,10}$/.test(studentId) || secret.length < 32) throw new Error('Invalid student identifier or matching secret');
  return createHmac('sha256', secret).update(`usaint-student:${studentId}`).digest('hex');
}
export function parseRoster(values: unknown, config: Pick<SheetsConfig, 'matchingSecret' | 'allowedServerIds'>): RosterEntry[] {
  if (!Array.isArray(values) || values.length < 2 || values.length > 5001 || !Array.isArray(values[0])) throw new Error('Roster must have a header and 1–5000 rows');
  const expected = ['student_id', 'status', 'role_label', 'server_ids'];
  const header = values[0].map((v: unknown) => typeof v === 'string' ? v.trim() : '');
  if (header.length !== expected.length || header.some((value: string, index: number) => value !== expected[index])) throw new Error('Roster columns do not match the required four-column view');
  const entries: RosterEntry[] = [];
  const seen = new Set<string>();
  for (let index = 1; index < values.length; index++) {
    const row = values[index];
    if (!Array.isArray(row) || row.length > 4 || row.some((cell: unknown) => typeof cell !== 'string')) throw new Error(`Invalid roster row ${index + 1}`);
    if (row.every((cell: string) => !cell.trim())) continue;
    const [studentId = '', status = '', roleLabel = '', scopes = ''] = row.map((cell: string) => cell.trim());
    if (!/^\d{8,10}$/.test(studentId) || !['active', 'inactive', 'suspended'].includes(status) || roleLabel.length > 24 || /[\x00-\x1f<>§]/.test(roleLabel)) throw new Error(`Invalid roster row ${index + 1}`);
    const serverIds = scopes ? scopes.split(',').map((s: string) => s.trim()) : [];
    if (serverIds.some((id: string) => !config.allowedServerIds.includes(id)) || new Set(serverIds).size !== serverIds.length || (status !== 'active' && serverIds.length)) throw new Error(`Invalid server scope in row ${index + 1}`);
    const key = studentKey(studentId, config.matchingSecret);
    if (seen.has(key)) throw new Error(`Duplicate student identifier in row ${index + 1}`);
    seen.add(key);
    entries.push({ studentKey: key, status: status as RosterEntry['status'], roleLabel, serverIds });
  }
  if (!entries.length) throw new Error('Empty roster snapshot rejected');
  return entries;
}
export function validateSnapshotChange(previous: RosterEntry[], next: RosterEntry[]) {
  if (!previous.length) return;
  const after = new Map(next.map(entry => [entry.studentKey, entry]));
  const revoked = previous.filter(entry => entry.status === 'active' && (!after.has(entry.studentKey) || after.get(entry.studentKey)!.status !== 'active')).length;
  const activeBefore = previous.filter(entry => entry.status === 'active').length;
  if (activeBefore && revoked / activeBefore > 0.2) throw new Error('More than 20% of active memberships would be revoked; manual review required');
}
export async function readGoogleSheet(config: SheetsConfig): Promise<RosterEntry[]> {
  const auth = new GoogleAuth({ keyFile: config.credentialsFile, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  const client = await auth.getClient();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.spreadsheetId)}/values/${encodeURIComponent(config.range)}`;
  try {
    const response = await client.request<{ values?: unknown }>({ url, method: 'GET', params: { majorDimension: 'ROWS', valueRenderOption: 'FORMATTED_VALUE' }, timeout: 10000, retry: false, maxContentLength: 2 * 1024 * 1024 });
    return parseRoster(response.data.values, config);
  } catch {
    // Google transport errors may contain Authorization/config and raw member cells; never rethrow them to logs.
    throw new Error('Google Sheets read or roster validation failed');
  }
}
