const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ForbiddenException, ServiceUnavailableException } = require('@nestjs/common');
const { OperationMetrics, operationMetrics, observedOperation } = require('../dist/observability');
const { UniversityVerificationError, USAINT_PARSER_VERSION } = require('../dist/integrations/usaint');

test('fixed metrics distinguish normal rejection, parser changes and provider outage without identity labels', () => {
  const metrics = new OperationMetrics();
  metrics.record('university', 26);
  metrics.record('university', 800, new UniversityVerificationError('parser_changed'));
  metrics.record('university', 3000, new UniversityVerificationError('unavailable'));
  metrics.record('university', 20, new UniversityVerificationError('rejected'));
  metrics.record('policy', 25, new ForbiddenException({ code: 'member_not_allowed', name: 'Synthetic private name', studentId: '11111111', url: '/private?token=supersecret' }));
  metrics.record('events', 20001, new Error('secret school HTML token UUID IP 127.0.0.1'));
  metrics.record('roster_sync', 600, { code: 'approval_required', preview: { studentId: '11111111' } });
  const result = metrics.snapshot();
  assert.equal(result.window, 'process'); assert.equal(result.parserVersion, USAINT_PARSER_VERSION);
  assert.deepEqual(Object.keys(result.operations), ['university', 'roster_sync', 'policy', 'events']);
  const school = result.operations.university;
  assert.equal(school.total, 4); assert.equal(school.success, 1); assert.equal(school.failure, 2); assert.equal(school.rejected, 1);
  assert.deepEqual(school.codes, { ok: 1, parser_changed: 1, unavailable: 1, rejected: 1 });
  assert.deepEqual(school.duration.buckets, [1, 1, 0, 1, 1, 0]); assert.equal(school.duration.sumMs, 3846);
  assert.ok(school.lastSuccessAt); assert.ok(school.lastFailureAt);
  assert.equal(result.operations.policy.rejected, 1); assert.equal(result.operations.events.failure, 1); assert.equal(result.operations.roster_sync.rejected, 1);
  for (const value of ['Synthetic private name', '11111111', 'supersecret', 'secret school HTML', '127.0.0.1', 'member_not_allowed', 'studentId', 'url', 'preview']) assert.ok(!JSON.stringify(result).includes(value), value);
});

test('label cardinality remains bounded and snapshots cannot mutate internal observations', () => {
  const metrics = new OperationMetrics();
  for (let i = 0; i < 10000; i++) metrics.record('events', i, { code: `user-controlled-${i}` });
  metrics.record('unlisted-operation', 1); metrics.record('policy', Infinity); metrics.record('policy', -2);
  const first = metrics.snapshot(); assert.deepEqual(first.operations.events.codes, { internal_error: 10000 });
  assert.equal(Object.keys(first.operations).length, 4); assert.equal(first.operations.policy.duration.sumMs, 0);
  first.operations.events.codes.internal_error = -1; first.operations.policy.total = -1;
  const second = metrics.snapshot(); assert.equal(second.operations.events.codes.internal_error, 10000); assert.equal(second.operations.policy.total, 2);
  const getterError = {}; Object.defineProperty(getterError, 'code', { get() { throw new Error('private data'); } });
  assert.doesNotThrow(() => metrics.record('policy', 1, getterError));
});

test('metric recorder failures preserve exact successful values and original operation errors', async () => {
  const record = operationMetrics.record;
  operationMetrics.record = () => { throw new Error('metrics unavailable'); };
  try {
    const allowed = { allowed: true }; assert.equal(await observedOperation('policy', async () => allowed), allowed);
    const rejected = new ForbiddenException({ code: 'blocked' });
    await assert.rejects(() => observedOperation('policy', async () => { throw rejected; }), error => error === rejected);
    const down = new ServiceUnavailableException({ code: 'unavailable' });
    await assert.rejects(() => observedOperation('events', async () => { throw down; }), error => error === down);
  } finally { operationMetrics.record = record; }
});

test('a new process metric window starts empty and never affects saved roster freshness or authority', () => {
  const old = new OperationMetrics(); old.record('university', 1);
  const restarted = new OperationMetrics().snapshot();
  assert.equal(restarted.operations.university.total, 0); assert.equal(restarted.operations.university.lastSuccessAt, null); assert.equal(restarted.operations.university.lastFailureAt, null);
  assert.equal('subjects' in restarted, false); assert.equal('policies' in restarted, false);
});
