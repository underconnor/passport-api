const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const request = require('supertest');
const raw = process.env.TEST_DATABASE_URL;
if (!raw || !new URL(raw).pathname.endsWith('_test')) throw new Error('Dedicated _test database required');
const url = new URL(raw); url.searchParams.set('schema', 'manual_test');
Object.assign(process.env, { DATABASE_URL: url.href, NODE_ENV: 'production', PASSPORT_AUTH_MODE: 'university', WEB_ORIGIN: 'https://portal.example.test', ADMIN_ORIGIN: 'https://admin.example.test', API_SERVICE_TOKEN: 'manual-service-'.repeat(4), PASSPORT_DISCORD_SERVICE_TOKEN: 'manual-discord-'.repeat(4), DISCORD_GUILD_ID: '100000000000000001', DISCORD_MEMBER_ROLE_ID: '100000000000000002', SESSION_SECRET: 'manual-session-'.repeat(4), ROSTER_MATCHING_SECRET: 'manual-roster-'.repeat(4), DATA_ENCRYPTION_KEY: 'ab'.repeat(32), ADMIN_MFA_REQUIRED: 'false', SHEETS_SYNC_ENABLED: 'false' });
const { createApp } = require('../dist/app'), { PassportService } = require('../dist/passport.service');
const { hash, csrf } = require('../dist/security');
const { normalizeNotionUrl, manualSettingsSchema } = require('../dist/manual');
let app, p, db, http, owner;
const page = '0123456789abcdef0123456789abcdef';
const source = `https://passport-fixture.notion.site/Guide-${page}`;
const embedded = `https://passport-fixture.notion.site/ebd/${page}`;
async function actor(role = 'owner', host = 'admin.example.test') {
  const subject = await db.subject.create({ data: { universityKey: randomUUID(), displayName: 'Synthetic administrator', identityProvider: 'usaint', universityVerifiedUntil: new Date(Date.now() + 3600000), verifiedUntil: new Date(Date.now() + 3600000) } });
  if (role) await db.administrator.create({ data: { subjectId: subject.id, enabled: true, role, totpSecret: '' } });
  const token = randomBytes(32).toString('base64url');
  await db.webSession.create({ data: { subjectId: subject.id, tokenHash: hash(token), audienceHost: host, expiresAt: new Date(Date.now() + 3600000) } });
  return { subject, host, token, cookie: `__Host-passport_${host.startsWith('admin') ? 'admin' : 'portal'}_session=${token}`, csrf: csrf(p.config.sessionSecret, token) };
}
function browser(r, user = owner, mutation = false) { r = r.set('Host', user.host).set('Cookie', user.cookie); return mutation ? r.set('Origin', `https://${user.host}`).set('X-CSRF-Token', user.csrf) : r; }
function put(input, user = owner, status = 200) { return browser(request(http).put('/v1/admin/manual'), user, true).send(input).expect(status); }
const input = (changes = {}) => ({ title: 'Passport 매뉴얼', notionUrl: source, embedUrl: embedded, expectedRevision: 0, ...changes });
beforeEach(async () => {
  app = await createApp(); p = app.get(PassportService); db = p.db; http = app.getHttpServer();
  await db.$executeRawUnsafe('TRUNCATE TABLE "Subject", "MinecraftIdentity", "AuditEvent", "ManualSettings" RESTART IDENTITY CASCADE');
  owner = await actor();
});
afterEach(async () => { await app.close(); });

test('Notion registration validates host/protocol/page and only preserves a valid database view', () => {
  assert.equal(normalizeNotionUrl(`${source}?pvs=4&token=secret#private`), source);
  assert.equal(normalizeNotionUrl(`https://passport-fixture.notion.site/?v=${page}`), `https://passport-fixture.notion.site/?v=${page}`);
  assert.equal(normalizeNotionUrl(`https://www.notion.so/Guide-${page}`), `https://www.notion.so/Guide-${page}`);
  assert.equal(normalizeNotionUrl(`https://passport-fixture.notion.site/이용안내-${page}`), new URL(`https://passport-fixture.notion.site/이용안내-${page}`).toString());
  for (const value of ['http://passport-fixture.notion.site/manual', 'javascript:alert(1)', 'https://notion.site.evil.test/manual', 'https://evilnotion.site/manual', 'https://passport-fixture.notion.site:8443/manual', 'https://user:secret@passport-fixture.notion.site/manual', 'https://127.0.0.1/manual', 'https://notion.so/login?redirect=secret', 'https://passport-fixture.notion.site/a/b', 'https://passport-fixture.notion.site\\@evil.test/manual']) assert.equal(normalizeNotionUrl(value), null, value);
  for (const changes of [{ embedUrl: 'https://evil.test/ebd/' + page }, { embedUrl: `https://other.notion.site/ebd/${page}` }, { embedUrl: `https://passport-fixture.notion.site/ebd/${'f'.repeat(32)}` }, { notionUrl: null }, { notionUrl: `https://notion.so/${page}` }, { embedUrl: `<iframe src="${embedded}"></iframe>` }, { title: 'bad\nname' }, { expectedRevision: -1 }, { unexpected: true }]) assert.equal(manualSettingsSchema.safeParse(input(changes)).success, false);
  assert.equal(manualSettingsSchema.safeParse(input({ notionUrl: 'https://passport-fixture.notion.site/manual' })).success, true);
});

test('public manual starts unconfigured and exposes only saved display fields', async () => {
  assert.deepEqual((await request(http).get('/v1/manual').expect(200)).body, { title: '매뉴얼', notionUrl: null, embedUrl: null, configured: false, updatedAt: null });
  const initial = (await browser(request(http).get('/v1/admin/manual')).expect(200)).body; assert.equal(initial.revision, 0);
  const saved = (await put(input())).body; assert.equal(saved.revision, 1); assert.equal(saved.configured, true);
  const publicResult = await request(http).get('/v1/manual').expect(200); assert.equal(publicResult.headers['cache-control'], 'no-store');
  assert.deepEqual(publicResult.body, { title: saved.title, notionUrl: source, embedUrl: embedded, configured: true, updatedAt: saved.updatedAt });
  assert.equal('revision' in publicResult.body, false);
  const audit = await db.auditEvent.findFirst({ where: { action: 'admin.manual_updated' } }); assert.deepEqual(audit.details, { revision: 1, configured: true, embedded: true });
  for (const privateValue of [owner.token, source, embedded, owner.subject.universityKey]) assert.ok(!JSON.stringify(audit).includes(privateValue));
});

test('only current writable administrators with CSRF on admin origin can change the manual', async () => {
  await request(http).get('/v1/admin/manual').set('Host', 'admin.example.test').expect(401);
  await request(http).put('/v1/admin/manual').set('Host', 'admin.example.test').set('Origin', 'https://admin.example.test').set('Authorization', `Bearer ${p.config.serviceToken}`).send(input()).expect(401);
  await browser(request(http).put('/v1/admin/manual')).send(input()).expect(403);
  const viewer = await actor('viewer'); await browser(request(http).get('/v1/admin/manual'), viewer).expect(200); await put(input(), viewer, 403);
  await put(input(), await actor(null), 403); await put(input(), await actor('owner', 'portal.example.test'), 403);
  const operator = await actor('operator'); await put(input(), operator); await db.administrator.update({ where: { subjectId: operator.subject.id }, data: { enabled: false, revokedAt: new Date() } });
  await put(input({ expectedRevision: 1 }), operator, 403); assert.equal((await db.manualSettings.findUnique({ where: { id: 'main' } })).revision, 1);
});

test('concurrent manual changes require fresh revision; removing the manual clears the embed too', async () => {
  const responses = await Promise.all([browser(request(http).put('/v1/admin/manual'), owner, true).send(input()), browser(request(http).put('/v1/admin/manual'), owner, true).send(input({ title: 'Second manual' }))]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]); assert.equal(await db.auditEvent.count({ where: { action: 'admin.manual_updated' } }), 1);
  await put(input(), owner, 409); await put(input({ expectedRevision: 1, notionUrl: null, embedUrl: null }));
  const cleared = (await request(http).get('/v1/manual').expect(200)).body; assert.equal(cleared.configured, false); assert.equal(cleared.notionUrl, null); assert.equal(cleared.embedUrl, null);
  await put(input({ expectedRevision: 2, notionUrl: 'https://passport-fixture.notion.site/manual', embedUrl: undefined }));
  assert.equal((await request(http).get('/v1/manual').expect(200)).body.embedUrl, null);
});

test('observation endpoint requires administrator school session and reports only bounded counters and roster freshness', async () => {
  await request(http).get('/v1/admin/observability').set('Host', 'admin.example.test').expect(401);
  await request(http).get('/v1/admin/observability').set('Host', 'admin.example.test').set('Authorization', `Bearer ${p.config.serviceToken}`).expect(401);
  const plain = await actor(null); await browser(request(http).get('/v1/admin/observability'), plain).expect(403);
  const viewer = await actor('viewer');
  const fresh = new Date(Date.now() + 3600000);
  await db.rosterSnapshot.upsert({ where: { id: 'current' }, create: { id: 'current', sourceKey: 'private-sheet-source', digest: 'private-roster-digest', entryCount: 0, fetchedAt: new Date(), expiresAt: fresh }, update: { fetchedAt: new Date(), expiresAt: fresh } });
  await request(http).get('/v1/minecraft/events').set('Authorization', `Bearer ${p.config.serviceToken}`).expect(200);
  await request(http).get('/v1/minecraft/events').set('Authorization', 'Bearer invalid-secret').expect(401);
  const response = await browser(request(http).get('/v1/admin/observability'), viewer).expect(200);
  assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.body.window, 'process'); assert.equal(response.body.roster.fresh, true);
  assert.ok(response.body.operations.events.success >= 1); assert.ok(response.body.operations.events.rejected >= 1);
  for (const value of [viewer.token, owner.token, 'private-sheet-source', 'private-roster-digest', 'invalid-secret', viewer.subject.universityKey, 'sourceKey', 'entryCount']) assert.ok(!JSON.stringify(response.body).includes(value));
  await db.rosterSnapshot.update({ where: { id: 'current' }, data: { expiresAt: new Date(0) } });
  assert.equal((await browser(request(http).get('/v1/admin/observability')).expect(200)).body.roster.fresh, false);
});
