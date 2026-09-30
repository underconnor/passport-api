const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SsuSaintAdapter, parseStudentPortal, buildUniversityLoginUrl, UniversityVerificationError } = require('../dist/integrations/usaint');

// Hand-authored HTML representing public selectors; no real student record or token is retained.
const fixture = ({ id = '99990001', name = '파서검증님', department = '소프트웨어학부', status = '학사과정 재학', extra = '' } = {}) => `<!doctype html><html><body>
<div class="main_box09"><h2><span>${name}</span></h2><div class="main_box09_con"><ul>
<li><dt>학번</dt><dd><strong>${id}</strong></dd></li><li><dt>소속</dt><dd><strong>${department}</strong></dd></li>
<li><dt>과정/학기</dt><dd><strong>${status}</strong></dd></li>${extra}</ul></div></div></body></html>`;
const callback = { sToken: 'test-only-opaque-token-123456789', sIdno: '99990001' };
const htmlResponse = (body = '<html></html>', cookies = []) => {
  const headers = new Headers({ 'content-type': 'text/html; charset=UTF-8' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(body, { headers });
};
const assertCode = (code) => (error) => error instanceof UniversityVerificationError && error.code === code && !error.cause;
const mockSchool = (options = {}) => {
  const calls = [];
  return { calls, fetch: async (url, init) => {
    calls.push({ url: new URL(url), init });
    if (url.pathname === '/irj/portal') return htmlResponse('anonymous portal', ['WAF=waf-test-only; Path=/; Secure']);
    if (url.pathname === '/webSSO/sso.jsp') return options.exchange?.(url, init) ?? htmlResponse('<script>location.href = "/irj/portal";</script>', ['MYSAPSSO2=synthetic-session; Path=/; Secure; HttpOnly']);
    if (url.pathname === '/webSSUMain/main_student.jsp') return options.student?.(url, init) ?? htmlResponse(fixture());
    throw new Error('Unexpected school request');
  } };
};

test('login URL embeds only the configured HTTPS callback and path nonce', () => {
  const callbackUrl = `https://passport.example/v1/auth/university/callback/${'n'.repeat(43)}`;
  const login = new URL(buildUniversityLoginUrl(callbackUrl));
  assert.equal(login.origin, 'https://smartid.ssu.ac.kr');
  assert.equal(login.pathname, '/Symtra_sso/smln.asp');
  assert.equal(login.searchParams.get('apiReturnUrl'), callbackUrl);
  for (const value of [callbackUrl.replace('https:', 'http:'), callbackUrl + '?redirect=bad', callbackUrl + '#bad', 'https://user:password@passport.example/v1/auth/university/callback/' + 'n'.repeat(43), 'https://passport.example/anything']) {
    assert.throws(() => buildUniversityLoginUrl(value), assertCode('invalid_callback'));
  }
});
test('portal parser reads the school-rendered identifier and minimum identity fields', () => {
  const verifiedAt = new Date('2026-09-30T00:00:00Z');
  const identity = parseStudentPortal(fixture({ extra: '<li><dt>이메일</dt><dd><strong>not-collected@example.invalid</strong></dd></li>' }), callback.sIdno, verifiedAt);
  assert.deepEqual(identity, { provider: 'ssu-usaint', studentNumber: callback.sIdno, name: '파서검증', department: '소프트웨어학부', academicStatus: 'ENROLLED', courseLabel: '학사과정 재학', parserVersion: 'ssu-main-student-v1', verifiedAt });
  assert.ok(!JSON.stringify(identity).includes('not-collected'));
});
test('parser permits other departments and preserves unknown academic labels without inventing status', () => {
  assert.equal(parseStudentPortal(fixture({ department: '철학과', status: '새과정 확인필요' }), callback.sIdno).academicStatus, 'UNKNOWN');
  for (const [label, expected] of [['휴학', 'LEAVE_OF_ABSENCE'], ['졸업', 'GRADUATED'], ['수료', 'COMPLETED'], ['자퇴', 'WITHDRAWN'], ['제적', 'WITHDRAWN']]) {
    assert.equal(parseStudentPortal(fixture({ status: `학사과정 ${label}` }), callback.sIdno).academicStatus, expected);
  }
});
test('parser rejects missing, duplicate, malformed or asserted-only student numbers', () => {
  for (const html of [fixture({ id: '' }), fixture({ id: 'not-a-student' }), fixture().replace('<dt>학번</dt>', '<dt>누락</dt>'), fixture({ extra: '<li><dt>학번</dt><dd><strong>99990001</strong></dd></li>' }), fixture().replace('main_box09_con', 'changed-selector'), fixture() + fixture(), '<html><input type="password" name="pwd"></html>']) {
    assert.throws(() => parseStudentPortal(html, callback.sIdno), assertCode('parser_changed'));
  }
  assert.throws(() => parseStudentPortal(fixture({ id: '99990002' }), callback.sIdno), assertCode('rejected'));
});
test('verification preserves isolated WAF/SAP cookies and validates both exchange and portal identity', async () => {
  const school = mockSchool();
  const identity = await new SsuSaintAdapter({ fetch: school.fetch }).verify(callback);
  assert.equal(identity.studentNumber, callback.sIdno);
  assert.equal(school.calls.length, 3);
  const exchange = school.calls[1];
  assert.equal(exchange.url.searchParams.get('sToken'), callback.sToken);
  assert.match(exchange.init.headers.Cookie, /WAF=waf-test-only/);
  assert.match(exchange.init.headers.Cookie, /sIdno=99990001/);
  assert.match(school.calls[2].init.headers.Cookie, /MYSAPSSO2=synthetic-session/);
  for (const call of school.calls) {
    assert.equal(call.url.origin, 'https://saint.ssu.ac.kr');
    assert.equal(call.init.redirect, 'manual');
    assert.ok(call.init.signal);
  }
});
test('a second verification gets a fresh cookie jar', async () => {
  const school = mockSchool();
  const adapter = new SsuSaintAdapter({ fetch: school.fetch });
  await adapter.verify(callback); await adapter.verify(callback);
  assert.equal(school.calls[0].init.headers.Cookie, undefined);
  assert.equal(school.calls[3].init.headers.Cookie, undefined);
});
test('missing/expired SAP session is rejected before portal parsing', async () => {
  for (const cookies of [[], ['MYSAPSSO2=; Path=/; Max-Age=0'], ['MYSAPSSO2=synthetic; Domain=attacker.invalid; Path=/'], ['MYSAPSSO2=synthetic; Path=/unrelated']]) {
    const school = mockSchool({ exchange: () => htmlResponse('successful-looking response', cookies) });
    await assert.rejects(new SsuSaintAdapter({ fetch: school.fetch }).verify(callback), assertCode('rejected'));
    assert.equal(school.calls.length, 2);
  }
});
test('valid SAP cookie never bypasses a portal identifier mismatch', async () => {
  const school = mockSchool({ student: () => htmlResponse(fixture({ id: '99990002' })) });
  await assert.rejects(new SsuSaintAdapter({ fetch: school.fetch }).verify(callback), assertCode('rejected'));
});
test('redirects cannot send bearer credentials or cookies outside exact school endpoints', async () => {
  for (const location of ['https://attacker.invalid/steal', 'http://saint.ssu.ac.kr/webSSUMain/main_student.jsp', 'https://saint.ssu.ac.kr:8443/irj/portal', '/unreviewed-endpoint', 'https://user@saint.ssu.ac.kr/irj/portal']) {
    const school = mockSchool({ exchange: () => new Response('', { status: 302, headers: { location } }) });
    await assert.rejects(new SsuSaintAdapter({ fetch: school.fetch }).verify(callback), assertCode('rejected'));
    assert.equal(school.calls.length, 2);
  }
});
test('redirect loops are bounded', async () => {
  const school = mockSchool({ exchange: () => new Response('', { status: 302, headers: { location: '/webSSO/sso.jsp' } }) });
  await assert.rejects(new SsuSaintAdapter({ fetch: school.fetch }).verify(callback), assertCode('rejected'));
  assert.equal(school.calls.length, 4);
});
test('invalid callback strings cannot reach the network or become header injection', async () => {
  const school = mockSchool(); const adapter = new SsuSaintAdapter({ fetch: school.fetch });
  for (const bad of [{ ...callback, sIdno: '123' }, { ...callback, sToken: 'short' }, { ...callback, sToken: callback.sToken + '; other=1' }, { ...callback, sToken: callback.sToken + '\r\nHeader: test' }, { ...callback, sToken: 't'.repeat(4097) }]) {
    await assert.rejects(adapter.verify(bad), assertCode('invalid_callback'));
  }
  assert.equal(school.calls.length, 0);
});
test('school network failures never retain credentials or fetch error causes', async () => {
  const adapter = new SsuSaintAdapter({ fetch: async () => { throw new Error(`transport leak ${callback.sToken}`); } });
  await assert.rejects(adapter.verify(callback), error => assertCode('unavailable')(error) && !String(error.stack).includes(callback.sToken));
});
test('oversized, non-HTML and non-UTF8 responses fail closed', async () => {
  const bodies = [
    () => new Response('x', { headers: { 'content-type': 'text/html', 'content-length': String(2 * 1024 * 1024 + 1) } }),
    () => htmlResponse('x'.repeat(2 * 1024 * 1024 + 1)),
    () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
    () => new Response('x', { headers: { 'content-type': 'text/html; charset=euc-kr' } }),
    () => new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'text/html; charset=utf-8' } }),
  ];
  for (const response of bodies) await assert.rejects(new SsuSaintAdapter({ fetch: async () => response() }).verify(callback), error => error instanceof UniversityVerificationError);
});
test('concurrency bound sheds excess verification and releases the slot after failure', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const adapter = new SsuSaintAdapter({ maxConcurrent: 1, fetch: async () => { await gate; throw new Error('expected'); } });
  const first = adapter.verify(callback);
  await assert.rejects(adapter.verify(callback), assertCode('busy'));
  release();
  await assert.rejects(first, assertCode('unavailable'));
  await assert.rejects(adapter.verify(callback), assertCode('unavailable'));
});
test('deadline aborts school transport without retaining a credential-bearing error', async () => {
  const adapter = new SsuSaintAdapter({ timeoutMs: 15, fetch: async (_url, init) => new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => reject(new Error('Deadline not applied')), 1000);
    const aborted = () => { clearTimeout(keepAlive); reject(init.signal.reason); };
    if (init.signal.aborted) aborted();
    else init.signal.addEventListener('abort', aborted, { once: true });
  }) });
  await assert.rejects(adapter.verify(callback), assertCode('unavailable'));
});
