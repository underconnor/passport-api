import { load } from 'cheerio';
import { CookieJar } from 'tough-cookie';

const SCHOOL_ORIGIN = 'https://saint.ssu.ac.kr';
const PORTAL_URL = `${SCHOOL_ORIGIN}/irj/portal`;
const EXCHANGE_URL = `${SCHOOL_ORIGIN}/webSSO/sso.jsp`;
const STUDENT_URL = `${SCHOOL_ORIGIN}/webSSUMain/main_student.jsp`;
const LOGIN_URL = 'https://smartid.ssu.ac.kr/Symtra_sso/smln.asp';
const ALLOWED_PATHS = new Set(['/irj/portal', '/webSSO/sso.jsp', '/webSSUMain/main_student.jsp']);
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const USAINT_PARSER_VERSION = 'ssu-main-student-v1';

export type AcademicStatus = 'ENROLLED' | 'LEAVE_OF_ABSENCE' | 'GRADUATED' | 'COMPLETED' | 'WITHDRAWN' | 'UNKNOWN';
export interface UniversityIdentity {
  provider: 'ssu-usaint';
  studentNumber: string;
  name: string;
  department: string;
  academicStatus: AcademicStatus;
  courseLabel: string;
  parserVersion: typeof USAINT_PARSER_VERSION;
  verifiedAt: Date;
}
export type UniversityVerificationErrorCode = 'invalid_callback' | 'rejected' | 'parser_changed' | 'unavailable' | 'busy';
export class UniversityVerificationError extends Error {
  constructor(readonly code: UniversityVerificationErrorCode) {
    // Never attach fetch errors, response HTML, credentials, or school URLs as a cause.
    super(`University verification ${code}`);
    this.name = 'UniversityVerificationError';
  }
}
export interface UniversityCallback { sToken: string; sIdno: string }
type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export function buildUniversityLoginUrl(callbackUrl: string): string {
  let callback: URL;
  try { callback = new URL(callbackUrl); } catch { throw new UniversityVerificationError('invalid_callback'); }
  // The caller supplies a configured, same-site callback containing a browser-bound nonce.
  // There is deliberately no HTTP development exception for school bearer credentials.
  if (callback.protocol !== 'https:' || callback.username || callback.password || callback.hash || callback.search || callback.port || !/^\/v1\/auth\/university\/callback\/[A-Za-z0-9_-]{32,128}$/.test(callback.pathname)) {
    throw new UniversityVerificationError('invalid_callback');
  }
  const url = new URL(LOGIN_URL);
  url.searchParams.set('apiReturnUrl', callback.toString());
  return url.toString();
}

function callbackIsValid(input: UniversityCallback): boolean {
  // RFC 6265 cookie-octet: reject whitespace, quotes, separators, backslashes and control bytes.
  return typeof input?.sIdno === 'string' && /^\d{8,10}$/.test(input.sIdno)
    && typeof input?.sToken === 'string' && /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]{16,4096}$/.test(input.sToken);
}
function normalize(value: string) { return value.replace(/\s+/gu, ' ').trim(); }
function checkedText(value: string, max: number): string {
  const normalized = normalize(value);
  if (!normalized || normalized.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f<>]/u.test(normalized)) throw new UniversityVerificationError('parser_changed');
  return normalized;
}
function academicStatus(label: string): AcademicStatus {
  const status = label.match(/(?:^|\s)(재학|휴학|졸업|수료|자퇴|제적)$/u)?.[1];
  switch (status) {
    case '재학': return 'ENROLLED';
    case '휴학': return 'LEAVE_OF_ABSENCE';
    case '졸업': return 'GRADUATED';
    case '수료': return 'COMPLETED';
    case '자퇴': case '제적': return 'WITHDRAWN';
    default: return 'UNKNOWN';
  }
}

/** Parse only the authenticated portal's summary; never substitute the callback's asserted ID. */
export function parseStudentPortal(html: string, expectedStudentNumber: string, verifiedAt = new Date()): UniversityIdentity {
  if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > MAX_RESPONSE_BYTES || !/^\d{8,10}$/.test(expectedStudentNumber)) throw new UniversityVerificationError('parser_changed');
  const $ = load(html);
  $('script, style, template, noscript').remove();
  const nameBoxes = $('.main_box09');
  const infoBoxes = $('.main_box09_con');
  if (nameBoxes.length !== 1 || infoBoxes.length !== 1) throw new UniversityVerificationError('parser_changed');
  const nameNode = nameBoxes.first().find('span').first();
  if (!nameNode.length) throw new UniversityVerificationError('parser_changed');
  const name = checkedText(nameNode.text().replace(/님\s*$/u, ''), 80);
  const values = new Map<string, string>();
  const wanted = new Set(['학번', '소속', '과정/학기']);
  for (const item of infoBoxes.first().find('li').toArray()) {
    const labels = $(item).find('dt');
    if (labels.length !== 1) throw new UniversityVerificationError('parser_changed');
    const key = normalize(labels.text());
    if (!wanted.has(key)) continue;
    const cells = $(item).find('strong');
    if (cells.length !== 1 || values.has(key)) throw new UniversityVerificationError('parser_changed');
    values.set(key, checkedText(cells.text(), key === '학번' ? 10 : 120));
  }
  const studentNumber = values.get('학번');
  const department = values.get('소속');
  const courseLabel = values.get('과정/학기');
  if (!studentNumber || !/^\d{8,10}$/.test(studentNumber) || !department || !courseLabel) throw new UniversityVerificationError('parser_changed');
  if (studentNumber !== expectedStudentNumber) throw new UniversityVerificationError('rejected');
  return { provider: 'ssu-usaint', studentNumber, name, department, academicStatus: academicStatus(courseLabel), courseLabel, parserVersion: USAINT_PARSER_VERSION, verifiedAt };
}

async function readHtml(response: Response): Promise<string> {
  if (response.status !== 200 || !/^text\/html(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel();
    throw new UniversityVerificationError(response.status >= 500 || response.status === 429 ? 'unavailable' : 'rejected');
  }
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > MAX_RESPONSE_BYTES || !response.body) {
    await response.body?.cancel();
    throw new UniversityVerificationError('unavailable');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new UniversityVerificationError('unavailable'); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  // Both public endpoints declare UTF-8. Reject an unexpected encoding rather than misread identity.
  const charset = response.headers.get('content-type')?.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1];
  if (charset && !/^utf-?8$/i.test(charset)) throw new UniversityVerificationError('parser_changed');
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

export class SsuSaintAdapter {
  private active = 0;
  private readonly fetch: Fetch;
  private readonly timeoutMs: number;
  private readonly maxConcurrent: number;
  constructor(options: { fetch?: Fetch; timeoutMs?: number; maxConcurrent?: number } = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.maxConcurrent = options.maxConcurrent ?? 4;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000 || !Number.isInteger(this.maxConcurrent) || this.maxConcurrent < 1 || this.maxConcurrent > 20) throw new Error('Invalid university transport bounds');
  }
  async verify(input: UniversityCallback): Promise<UniversityIdentity> {
    if (!callbackIsValid(input)) throw new UniversityVerificationError('invalid_callback');
    if (this.active >= this.maxConcurrent) throw new UniversityVerificationError('busy');
    this.active++;
    const jar = new CookieJar(); // Isolated for this verification; never serialized or shared.
    const signal = AbortSignal.timeout(this.timeoutMs);
    const request = async (initial: string | URL): Promise<Response> => {
      let url = new URL(initial);
      for (let redirects = 0; redirects <= 2; redirects++) {
        if (url.origin !== SCHOOL_ORIGIN || url.username || url.password || url.hash || !ALLOWED_PATHS.has(url.pathname)) throw new UniversityVerificationError('rejected');
        const cookie = await jar.getCookieString(url.href);
        const response = await this.fetch(url, {
          method: 'GET', redirect: 'manual', signal,
          headers: { Accept: 'text/html', 'User-Agent': 'Passport/0.1 (SSU membership verification)', ...(cookie ? { Cookie: cookie } : {}) },
        });
        for (const header of response.headers.getSetCookie()) await jar.setCookie(header, url.href, { ignoreError: true });
        if (![301, 302, 303, 307, 308].includes(response.status)) return response;
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirects === 2) throw new UniversityVerificationError('rejected');
        url = new URL(location, url);
      }
      throw new UniversityVerificationError('rejected');
    };
    try {
      // The anonymous portal supplies the WAF/load-balancer cookies required for token exchange.
      await readHtml(await request(PORTAL_URL));
      await jar.setCookie(`sToken=${input.sToken}; Secure; Path=/`, SCHOOL_ORIGIN);
      await jar.setCookie(`sIdno=${input.sIdno}; Secure; Path=/`, SCHOOL_ORIGIN);
      const exchange = new URL(EXCHANGE_URL);
      exchange.searchParams.set('sToken', input.sToken);
      exchange.searchParams.set('sIdno', input.sIdno);
      await readHtml(await request(exchange));
      const authenticated = (await jar.getCookies(STUDENT_URL)).some(cookie => cookie.key === 'MYSAPSSO2' && cookie.value.length > 0);
      if (!authenticated) throw new UniversityVerificationError('rejected');
      return parseStudentPortal(await readHtml(await request(STUDENT_URL)), input.sIdno);
    } catch (error) {
      // Native fetch/cookie/parser errors can retain the credential-bearing URL or raw input.
      if (error instanceof UniversityVerificationError) throw error;
      throw new UniversityVerificationError('unavailable');
    } finally {
      this.active--;
      await jar.removeAllCookies();
    }
  }
}
