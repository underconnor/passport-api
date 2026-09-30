import { createHmac } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';

export type RosterEntry = { studentKey: string; status: 'active' | 'inactive' | 'suspended'; roleLabel: string; serverIds: string[] };
type SheetsBase = { spreadsheetId: string; matchingSecret: string; allowedServerIds: string[] };
export type SheetsConfig = SheetsBase & ({ accessMode: 'service-account'; range: string; credentialsFile: string } | { accessMode: 'public-query'; tab: string; studentColumn: string; academicStatusColumn: string; studentHeader: string; academicStatusHeader: string; activeAcademicStatuses: string[]; defaultServerIds: string[]; roleLabel: string });
export function sheetsConfig(env = process.env): SheetsConfig {
  const spreadsheetId = env.SHEETS_SPREADSHEET_ID;
  const matchingSecret = env.ROSTER_MATCHING_SECRET;
  if (!spreadsheetId || !/^[A-Za-z0-9_-]{10,200}$/.test(spreadsheetId) || !matchingSecret || matchingSecret.length < 32) throw new Error('Sheets integration is not configured');
  const registry = JSON.parse(env.SERVER_REGISTRY_JSON ?? '[{"id":"lobby"},{"id":"survival"}]') as { id: string }[];
  if (!Array.isArray(registry) || registry.length > 64 || registry.some(s => !/^[a-z][a-z0-9_-]{0,63}$/.test(s.id)) || new Set(registry.map(s => s.id)).size !== registry.length) throw new Error('Invalid server registry');
  const base = { spreadsheetId, matchingSecret, allowedServerIds: registry.map(s => s.id) };
  if (env.SHEETS_ACCESS_MODE === 'public-query') {
    const tab = env.SHEETS_TAB;
    const studentColumn = env.SHEETS_STUDENT_ID_COLUMN ?? 'B';
    const academicStatusColumn = env.SHEETS_ACADEMIC_STATUS_COLUMN ?? 'E';
    const studentHeader = env.SHEETS_STUDENT_ID_HEADER ?? '학번';
    const academicStatusHeader = env.SHEETS_ACADEMIC_STATUS_HEADER;
    const activeAcademicStatuses: unknown = JSON.parse(env.ROSTER_ACTIVE_ACADEMIC_STATUSES_JSON ?? 'null');
    const defaultServerIds: unknown = JSON.parse(env.ROSTER_DEFAULT_SERVER_IDS_JSON ?? 'null');
    const roleLabel = env.ROSTER_ROLE_LABEL ?? '회원';
    if (!tab || tab.length > 100 || /[\x00-\x1f]/.test(tab) || !/^[A-Z]{1,3}$/.test(studentColumn) || !/^[A-Z]{1,3}$/.test(academicStatusColumn) || studentColumn === academicStatusColumn || !studentHeader || !academicStatusHeader || studentHeader.length > 100 || academicStatusHeader.length > 100 || !Array.isArray(activeAcademicStatuses) || !activeAcademicStatuses.length || activeAcademicStatuses.some(v => typeof v !== 'string' || !v.trim() || v.length > 32) || !Array.isArray(defaultServerIds) || defaultServerIds.some(id => !base.allowedServerIds.includes(id)) || new Set(defaultServerIds).size !== defaultServerIds.length || roleLabel.length > 24 || /[\x00-\x1f<>§]/.test(roleLabel)) throw new Error('Invalid public roster mapping');
    return { ...base, accessMode: 'public-query', tab, studentColumn, academicStatusColumn, studentHeader, academicStatusHeader, activeAcademicStatuses, defaultServerIds, roleLabel };
  }
  const range = env.SHEETS_RANGE;
  const credentialsFile = env.GOOGLE_APPLICATION_CREDENTIALS;
  if ((env.SHEETS_ACCESS_MODE && env.SHEETS_ACCESS_MODE !== 'service-account') || !range || range.length > 200 || !credentialsFile) throw new Error('Sheets integration is not configured');
  return { ...base, accessMode: 'service-account', range, credentialsFile };
}
export function studentKey(studentId: string, secret: string) {
  if (!/^\d{8,10}$/.test(studentId) || secret.length < 32) throw new Error('Invalid student identifier or matching secret');
  return createHmac('sha256', secret).update(`usaint-student:${studentId}`).digest('hex');
}
export function parseRoster(values: unknown, config: Pick<SheetsConfig, 'matchingSecret' | 'allowedServerIds'>, options: { allowEmpty?: boolean } = {}): RosterEntry[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 5001 || !Array.isArray(values[0])) throw new Error('Roster must have a header and at most 5000 rows');
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
  if (!entries.length && !options.allowEmpty) throw new Error('Empty roster snapshot rejected');
  return entries;
}
export function validateSnapshotChange(previous: RosterEntry[], next: RosterEntry[]) {
  if (!previous.length) return;
  const after = new Map(next.map(entry => [entry.studentKey, entry]));
  const revoked = previous.filter(entry => {
    const replacement = after.get(entry.studentKey);
    return entry.status === 'active' && (!replacement || replacement.status !== 'active' || entry.serverIds.some(id => !replacement.serverIds.includes(id)));
  }).length;
  const activeBefore = previous.filter(entry => entry.status === 'active').length;
  if (activeBefore && revoked / activeBefore > 0.2) throw new Error('More than 20% of active memberships would be revoked; manual review required');
}
export async function readGoogleSheet(config: SheetsConfig, options: { allowEmpty?: boolean } = {}): Promise<RosterEntry[]> {
  if (config.accessMode === 'public-query') return readPublicRoster(config, options);
  const auth = new GoogleAuth({ keyFile: config.credentialsFile, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  const client = await auth.getClient();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.spreadsheetId)}/values/${encodeURIComponent(config.range)}`;
  try {
    const response = await client.request<{ values?: unknown }>({ url, method: 'GET', params: { majorDimension: 'ROWS', valueRenderOption: 'FORMATTED_VALUE' }, timeout: 10000, retry: false, maxContentLength: 2 * 1024 * 1024 });
    return parseRoster(response.data.values, config, options);
  } catch {
    // Google transport errors may contain Authorization/config and raw member cells; never rethrow them to logs.
    throw new Error('Google Sheets read or roster validation failed');
  }
}

/** Strict RFC 4180 subset; quoted commas/newlines and doubled quotes are supported. */
export function parseCsv(source: string): string[][] {
  if (Buffer.byteLength(source) > 2 * 1024 * 1024) throw new Error('CSV exceeds size limit');
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false; let closed = false;
  const pushCell = () => { row.push(cell); cell = ''; closed = false; if (row.length > 2) throw new Error('CSV must contain exactly two selected columns'); };
  const pushRow = () => { pushCell(); rows.push(row); row = []; if (rows.length > 5001) throw new Error('CSV exceeds row limit'); };
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quoted) {
      if (char === '"') { if (source[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } } else cell += char;
    } else if (char === '"') { if (cell || closed) throw new Error('Invalid CSV quoting'); quoted = true; }
    else if (char === ',') pushCell();
    else if (char === '\n' || char === '\r') { if (char === '\r' && source[i + 1] === '\n') i++; pushRow(); }
    else { if (closed) throw new Error('Invalid CSV delimiter'); cell += char; }
  }
  if (quoted) throw new Error('Unterminated CSV field');
  if (cell || closed || row.length) pushRow();
  return rows;
}
export function parseClubRosterCsv(source: string, config: Extract<SheetsConfig, { accessMode: 'public-query' }>, options: { allowEmpty?: boolean } = {}) {
  const rows = parseCsv(source.replace(/^\uFEFF/, ''));
  const header = rows[0];
  if (!header || header.length !== 2 || header[0]?.trim() !== config.studentHeader || header[1]?.trim() !== config.academicStatusHeader) throw new Error('Roster headers do not match configured mapping');
  const canonical: string[][] = [['student_id', 'status', 'role_label', 'server_ids']];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.every(cell => !cell.trim())) continue;
    if (row.length !== 2 || !config.activeAcademicStatuses.includes(row[1]!.trim())) throw new Error(`Unrecognized academic status in roster row ${i + 1}`);
    canonical.push([row[0]!.trim(), 'active', config.roleLabel, config.defaultServerIds.join(',')]);
  }
  return parseRoster(canonical, config, options);
}
export function publicRosterUrl(config: Extract<SheetsConfig, { accessMode: 'public-query' }>) {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${encodeURIComponent(config.spreadsheetId)}/gviz/tq`);
  url.searchParams.set('tqx', 'out:csv'); url.searchParams.set('sheet', config.tab); url.searchParams.set('headers', '1');
  // Only student ID and enrollment status are requested; names, phone numbers and notes stay at Google.
  url.searchParams.set('tq', `select ${config.studentColumn},${config.academicStatusColumn}`);
  return url;
}
async function readPublicRoster(config: Extract<SheetsConfig, { accessMode: 'public-query' }>, options: { allowEmpty?: boolean }) {
  try {
    const response = await fetch(publicRosterUrl(config), { signal: AbortSignal.timeout(10000), redirect: 'error', headers: { Accept: 'text/csv', 'Cache-Control': 'no-cache' } });
    if (!response.ok || !response.headers.get('content-type')?.toLowerCase().includes('text/csv') || !response.body) throw new Error();
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 2 * 1024 * 1024) throw new Error(); chunks.push(part.value); }
    } finally { await reader.cancel(); }
    return parseClubRosterCsv(Buffer.concat(chunks).toString('utf8'), config, options);
  } catch { throw new Error('Google Sheets read or roster validation failed'); }
}
