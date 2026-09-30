const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { policyTransaction } = require('../dist/database');
const { PassportService } = require('../dist/passport.service');

const raw = process.env.TEST_DATABASE_URL;
if (!raw || !new URL(raw).pathname.endsWith('_test')) throw new Error('Dedicated _test database required');
const database = new URL(raw);
database.searchParams.set('schema', 'policy_order_test');
database.searchParams.set('connection_limit', '1');
const firstDb = new PrismaClient({ datasources: { db: { url: database.href } } });
const secondDb = new PrismaClient({ datasources: { db: { url: database.href } } });
const observer = new PrismaClient({ datasources: { db: { url: database.href } } });
const feed = cursor => PassportService.prototype.policyEvents.call({ service() {}, db: observer }, {}, cursor);
function latch() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function waitForBlockedWriter() {
  const deadline = Date.now() + 3000;
  do {
    const [row] = await observer.$queryRaw`
      SELECT count(*)::int AS waiting FROM pg_locks
      WHERE locktype = 'advisory' AND classid = 1346458451::oid
        AND objid = 1347374153::oid AND NOT granted
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
    if (row.waiting > 0) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.fail('second policy writer did not wait for the transaction advisory lock');
}
before(async () => { await Promise.all([firstDb.$connect(), secondDb.$connect(), observer.$connect()]); });
after(async () => { await Promise.all([firstDb.$disconnect(), secondDb.$disconnect(), observer.$disconnect()]); });
beforeEach(async () => { await observer.$executeRawUnsafe('TRUNCATE TABLE "PolicyEvent" RESTART IDENTITY'); });

test('policy event IDs cannot commit ahead of an earlier held writer', { timeout: 15000 }, async () => {
  const firstReady = latch(), releaseFirst = latch(), secondReady = latch(), releaseSecond = latch();
  let secondEntered = false;
  const first = policyTransaction(firstDb, async tx => {
    const event = await tx.policyEvent.create({ data: { minecraftUuid: randomUUID(), policyVersion: 2 } });
    firstReady.resolve(event);
    await releaseFirst.promise;
    return event;
  });
  let second;
  try {
    const firstEvent = await firstReady.promise;
    second = policyTransaction(secondDb, async tx => {
      secondEntered = true;
      const event = await tx.policyEvent.create({ data: { minecraftUuid: randomUUID(), policyVersion: 3 } });
      secondReady.resolve(event);
      await releaseSecond.promise;
      return event;
    });
    await waitForBlockedWriter();
    assert.equal(secondEntered, false, 'lock precedes all callback row access and ID allocation');
    assert.deepEqual((await feed('0')).events, [], 'uncommitted policy events stay invisible');
    releaseFirst.resolve();
    await first;
    const secondEvent = await secondReady.promise;
    const batch = await feed('0');
    assert.deepEqual(batch.events.map(event => event.id), [firstEvent.id.toString()]);
    assert.equal(batch.cursor, firstEvent.id.toString());
    releaseSecond.resolve();
    await second;
    const next = await feed(batch.cursor);
    assert.deepEqual(next.events.map(event => event.id), [secondEvent.id.toString()]);
    assert.ok(secondEvent.id > firstEvent.id);
  } finally {
    releaseFirst.resolve(); releaseSecond.resolve();
    await Promise.allSettled([first, ...(second ? [second] : [])]);
  }
});

test('rollback releases the policy lock and a sequence gap does not lose later events', { timeout: 15000 }, async () => {
  const firstReady = latch(), releaseFirst = latch();
  const rollback = new Error('synthetic policy transaction rollback');
  const first = policyTransaction(firstDb, async tx => {
    await tx.policyEvent.create({ data: { minecraftUuid: randomUUID(), policyVersion: 2 } });
    firstReady.resolve();
    await releaseFirst.promise;
    throw rollback;
  }).catch(error => error);
  let secondEntered = false;
  let second;
  try {
    await firstReady.promise;
    second = policyTransaction(secondDb, async tx => {
      secondEntered = true;
      return tx.policyEvent.create({ data: { minecraftUuid: randomUUID(), policyVersion: 3 } });
    });
    await waitForBlockedWriter();
    assert.equal(secondEntered, false);
    releaseFirst.resolve();
    assert.equal(await first, rollback);
    const committed = await second;
    assert.equal(secondEntered, true, 'rollback must release the transaction lock');
    assert.equal(await observer.policyEvent.count(), 1);
    const reset = await feed('0');
    assert.equal(reset.reset, true, 'a rolled-back sequence gap safely resets consumers');
    assert.equal(reset.cursor, committed.id.toString());
    const later = await policyTransaction(firstDb, tx => tx.policyEvent.create({ data: { minecraftUuid: randomUUID(), policyVersion: 4 } }));
    assert.deepEqual((await feed(reset.cursor)).events.map(event => event.id), [later.id.toString()]);
  } finally {
    releaseFirst.resolve();
    await Promise.allSettled([first, ...(second ? [second] : [])]);
  }
});
