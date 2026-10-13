import assert from 'node:assert/strict';
import { test } from 'node:test';
import { URLSearchParams } from 'node:url';
import { createDatabaseProbe } from '../database/connection';
import { createServer } from '../transport/server';
import { MemorySessionStore } from '../session/memory-store';
import { SessionService } from '../session/service';
import { decodeDashboardRange } from '../dashboard/service';
import type { DashboardReader, DashboardTotals } from '../dashboard/contracts';

const end = new Date().toISOString(), start = new Date(Date.parse(end) - 86400_000).toISOString();
const range = { start, end, timezone: 'America/Chicago' };
const url = `/v1/dashboard?${new URLSearchParams(range)}`;
async function fixture(reader?: DashboardReader) {
  const service = new SessionService(new MemorySessionStore(), { profile: 'internal-test-v1', timing: 'absolute-deadline',
    reservationMs: 10_000, readinessMs: 1000, maxActiveSessions: 1, maxEventsPerSession: 8, maxUtteranceChars: 2000 });
  const app = await createServer({ service, database: createDatabaseProbe(), dashboard: reader ? {
    reader, localAggregates: true, allowedOrigins: ['http://127.0.0.1:5173'],
  } : undefined });
  return app;
}
const totals: DashboardTotals = { capturedAt: end, completed: 2, avgDuration: 7.5, activeSessions: 1, preparingSessions: 0, overdueSessions: 1 };
test('dashboard default fails closed; explicit aggregate mode matches nullable frontend fields and excludes IDs', async t => {
  const closed = await fixture(); t.after(() => closed.close());
  const unavailable = await closed.inject(url); assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json().error, 'dashboard_access_unconfigured');
  const app = await fixture({ async readDashboard(actual) { assert.deepEqual(actual, range); return totals; } }); t.after(() => app.close());
  const response = await app.inject(url), value = response.json();
  assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(value.version, 1); assert.deepEqual(value.range, range); assert.equal(value.completed, 2); assert.equal(value.avgDuration, 7.5);
  for (const key of ['connected', 'reconnecting', 'peak', 'peakAt', 'voiceP95', 'failedPercent', 'spend', 'capacity', 'avgAnswers', 'queueDepth', 'queueOldest', 'forecast', 'concurrency', 'sessions']) assert.equal(value[key], null);
  assert.deepEqual(value.diagnostics, { activeSessions: 1, preparingSessions: 0, overdueSessions: 1 });
  assert.equal(value.health.find((h: { name: string }) => h.name === 'Voice service').status, 'Unknown');
  assert.equal(response.body.includes('accountId'), false); assert.equal(response.body.includes('sessionId'), false);
});
test('dashboard restricts browser origin, rejects query credentials and does not expose storage errors', async t => {
  const app = await fixture({ async readDashboard() { throw new Error('private database connection credential'); } }); t.after(() => app.close());
  const denied = await app.inject({ url, headers: { origin: 'https://untrusted.example' } });
  assert.equal(denied.statusCode, 403); assert.equal(denied.headers['access-control-allow-origin'], undefined);
  assert.equal((await app.inject(`${url}&token=secret`)).statusCode, 400);
  const failed = await app.inject({ url, headers: { origin: 'http://127.0.0.1:5173' } });
  assert.equal(failed.statusCode, 503); assert.equal(failed.headers['access-control-allow-origin'], 'http://127.0.0.1:5173');
  assert.deepEqual(failed.json(), { ok: false, error: 'dashboard_storage_unavailable' });
});
test('dashboard accepts explicit UTC instants across DST without reinterpreting the date range', () => {
  const dst = { start: '2026-03-08T06:00:00.000Z', end: '2026-03-09T05:00:00.000Z', timezone: 'America/Chicago' };
  assert.deepEqual(decodeDashboardRange(dst), dst);
  for (const bad of [
    {}, { ...range, start: '2026-02-30T00:00:00.000Z' }, { ...range, end: start },
    { ...range, start: end, end: start }, { ...range, timezone: 'Invalid/Zone' }, { ...range, timezone: '+01:00' },
    { ...range, start: [start, start] }, { ...range, end: new Date(Date.now() + 86400_000).toISOString() },
    { ...range, start: new Date(Date.parse(end) - 368 * 86400_000).toISOString() },
  ]) assert.throws(() => decodeDashboardRange(bad), /invalid_input/);
});
