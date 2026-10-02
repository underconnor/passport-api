import { HttpException } from '@nestjs/common';
import type { Request } from 'express';
import { performance } from 'node:perf_hooks';
import { adminContext } from './admin';
import { USAINT_PARSER_VERSION } from './integrations/usaint';
import type { PassportService } from './passport.service';

export const observedOperations = ['university', 'roster_sync', 'policy', 'events'] as const;
export type ObservedOperation = typeof observedOperations[number];
type Outcome = 'success' | 'rejected' | 'failure';
const durationBoundsMs = [25, 100, 500, 2000, 10000] as const;
const safeCodes = new Set(['ok', 'rejected', 'invalid_callback', 'parser_changed', 'unavailable', 'busy', 'configuration_error', 'read_failed', 'invalid_snapshot', 'stale_snapshot', 'outdated_snapshot', 'approval_required', 'approval_mismatch', 'sync_busy', 'apply_failed', 'request_rejected', 'service_unauthorized', 'invalid_cursor', 'internal_error']);
const expectedCodes = new Set(['rejected', 'invalid_callback', 'approval_required', 'approval_mismatch', 'outdated_snapshot', 'sync_busy', 'request_rejected', 'service_unauthorized', 'invalid_cursor']);
const increment = (value: number, amount = 1) => Math.min(Number.MAX_SAFE_INTEGER, value + amount);

function classification(error: unknown): { outcome: Outcome; code: string } {
  if (error === undefined) return { outcome: 'success', code: 'ok' };
  let code: unknown;
  let clientError = false;
  try {
    if (error instanceof HttpException) {
      clientError = error.getStatus() >= 400 && error.getStatus() < 500;
      const response = error.getResponse();
      code = typeof response === 'object' && response ? (response as { code?: unknown }).code : undefined;
    } else if (error && typeof error === 'object') code = (error as { code?: unknown }).code;
  } catch { /* Error accessors must never interfere with the original operation. */ }
  const safeCode = typeof code === 'string' && safeCodes.has(code) ? code : clientError ? 'request_rejected' : 'internal_error';
  return { code: safeCode, outcome: clientError || expectedCodes.has(safeCode) ? 'rejected' : 'failure' };
}

function emptyOperation() {
  return { total: 0, success: 0, rejected: 0, failure: 0, codes: {} as Record<string, number>, duration: { count: 0, sumMs: 0, maxMs: 0, buckets: Array<number>(durationBoundsMs.length + 1).fill(0) }, lastSuccessAt: null as string | null, lastFailureAt: null as string | null };
}

/** Fixed operation/code lists bound cardinality. No request, error text or identity is retained. */
export class OperationMetrics {
  readonly startedAt = new Date().toISOString();
  private readonly values = Object.fromEntries(observedOperations.map(operation => [operation, emptyOperation()])) as Record<ObservedOperation, ReturnType<typeof emptyOperation>>;

  record(operation: ObservedOperation, elapsedMs: number, error?: unknown) {
    if (!observedOperations.includes(operation)) return;
    const value = this.values[operation], { outcome, code } = classification(error);
    const duration = Number.isFinite(elapsedMs) ? Math.max(0, Math.min(180000, Math.round(elapsedMs))) : 0;
    value.total = increment(value.total); value[outcome] = increment(value[outcome]);
    value.codes[code] = increment(value.codes[code] ?? 0);
    value.duration.count = increment(value.duration.count);
    value.duration.sumMs = increment(value.duration.sumMs, duration);
    value.duration.maxMs = Math.max(value.duration.maxMs, duration);
    const match = durationBoundsMs.findIndex(bound => duration <= bound);
    const bucket = match < 0 ? durationBoundsMs.length : match;
    value.duration.buckets[bucket] = increment(value.duration.buckets[bucket]!);
    if (outcome === 'success') value.lastSuccessAt = new Date().toISOString();
    if (outcome === 'failure') value.lastFailureAt = new Date().toISOString();
  }

  snapshot() {
    return { window: 'process' as const, startedAt: this.startedAt, observedAt: new Date().toISOString(), parserVersion: USAINT_PARSER_VERSION, durationBoundsMs: [...durationBoundsMs], operations: structuredClone(this.values) };
  }
}

export const operationMetrics = new OperationMetrics();
export async function observedOperation<T>(operation: ObservedOperation, run: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    const result = await run();
    try { operationMetrics.record(operation, performance.now() - start); } catch { /* Observability never changes authentication results. */ }
    return result;
  } catch (error) {
    try { operationMetrics.record(operation, performance.now() - start, error === undefined ? { code: 'internal_error' } : error); } catch { /* Preserve the exact original failure. */ }
    throw error;
  }
}

export async function adminObservability(p: PassportService, req: Request) {
  await adminContext(p, req);
  const now = new Date();
  const roster = await p.db.rosterSnapshot.findUnique({ where: { id: 'current' }, select: { fetchedAt: true, expiresAt: true } });
  const sync = p.membership.status();
  return { ...operationMetrics.snapshot(), roster: { enabled: sync.enabled, running: sync.running, lastSuccessAt: sync.lastSuccessAt, lastError: sync.lastError && safeCodes.has(sync.lastError) ? sync.lastError : sync.lastError ? 'internal_error' : null, fetchedAt: roster?.fetchedAt.toISOString() ?? null, expiresAt: roster?.expiresAt.toISOString() ?? null, fresh: Boolean(roster && roster.expiresAt > now && roster.fetchedAt <= now) } };
}
