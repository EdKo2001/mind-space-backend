import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { URLSearchParams } from 'node:url';
import { test } from 'node:test';
import { Pool } from 'pg';
import { DashboardDemo } from '../dashboard/demo';
import { createServer } from '../transport/server';
import { createDatabaseProbe } from '../database/connection';
import { MemorySessionStore } from '../session/memory-store';
import { SessionService } from '../session/service';

if (!process.env.DATABASE_URL) throw new Error('Real PostgreSQL is required');
test('PostgreSQL demo seed is idempotent; real HTTP reads scoped totals and subsequent database changes', async t => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const schema = `ms_demo_test_${randomUUID().replaceAll('-','')}`;
  const demo = new DashboardDemo(pool, schema);
  t.after(async () => { await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await demo.close(); });
  const now = new Date();
  await demo.seed(now); await demo.seed(now);
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM "${schema}".sessions`)).rows[0].n,66);
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM "${schema}".samples`)).rows[0].n,721);
  const range = { start: new Date(now.getTime()-31*86400_000).toISOString(), end: now.toISOString(), timezone: 'America/Chicago' };
  const service = new SessionService(new MemorySessionStore(), { profile: 'internal-test-v1', timing: 'absolute-deadline',
    reservationMs: 10_000, readinessMs: 1000, maxActiveSessions: 1, maxEventsPerSession: 8, maxUtteranceChars: 2000 });
  const app = await createServer({ service, database: createDatabaseProbe(), dashboard: {
    reader: { async readDashboard() { return { capturedAt: now.toISOString(), completed: 0, avgDuration: null, activeSessions: 0, preparingSessions: 0, overdueSessions: 0 }; } },
    localAggregates: true, allowedOrigins: ['http://127.0.0.1:5175'], demo,
  } });
  t.after(() => app.close());
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address(); assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/v1/dashboard/demo?${new URLSearchParams(range)}`;
  const response = await fetch(url, { headers: { Origin: 'http://127.0.0.1:5175' } });
  assert.equal(response.status,200); assert.equal(response.headers.get('access-control-allow-origin'),'http://127.0.0.1:5175');
  const value = await response.json() as Awaited<ReturnType<DashboardDemo['readDemo']>>;
  assert.equal(value.synthetic,true); assert.equal(value.completed,60); assert.equal(value.connected,4); assert.equal(value.reconnecting,2);
  assert.equal(value.sessions.length,6); assert.equal(typeof value.failedPercent,'number');
  const calendarDate = (at: string, timezone: string) => new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(at));
  assert.equal(new Set(value.concurrency.map(point => calendarDate(point.at, range.timezone))).size,value.concurrency.length,
    'multi-day charts must return one peak per selected-zone calendar date, not hourly points');
  const expectedPeaks = await pool.query(`SELECT MAX(count)::int AS count FROM "${schema}".samples
    WHERE at >= $1 AND at < $2 GROUP BY (at AT TIME ZONE $3)::date ORDER BY (at AT TIME ZONE $3)::date`,
  [range.start,range.end,range.timezone]);
  assert.deepEqual(value.concurrency.map(point => point.count),expectedPeaks.rows.map(row => row.count));
  const today = { ...range, start: new Date(now.getTime()-5*3600_000).toISOString() };
  // A bounded within-day interval must retain every actual hourly sample.
  today.timezone = 'UTC';
  today.start = new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate())).toISOString();
  const intraday = await demo.readDemo(today);
  const hourlyCount = await pool.query(`SELECT COUNT(*)::int AS n FROM "${schema}".samples WHERE at >= $1 AND at < $2`,[today.start,today.end]);
  assert.equal(intraday.concurrency.length,hourlyCount.rows[0].n);
  assert.equal(value.queueDepth,null); assert.equal(value.health.find(h => h.name === 'Voice service')?.status,'Unknown');
  await pool.query(`UPDATE "${schema}".sessions SET answers=77 WHERE id='DEMO-061'`);
  const updated = await (await fetch(url)).json() as typeof value;
  assert.equal(updated.sessions.find(s => s.id === 'DEMO-061')?.answers,77);
  const oldRange = { ...range, start: new Date(now.getTime()-60*86400_000).toISOString(), end: new Date(now.getTime()-40*86400_000).toISOString() };
  const empty = await demo.readDemo(oldRange); assert.equal(empty.completed,0); assert.equal(empty.voiceP95,null); assert.equal(empty.spend,null); assert.deepEqual(empty.concurrency,[]);
  assert.equal((await fetch(url, { headers: { Origin: 'https://untrusted.example' } })).status,403);
  assert.equal((await fetch(`${url}&token=secret`)).status,400);
  const real = await (await fetch(url.replace('/demo?','?'))).json() as { sessions: unknown; connected: unknown };
  assert.equal(real.sessions,null); assert.equal(real.connected,null);
  // A historical 23-hour Chicago DST day is intraday despite touching two UTC dates.
  await demo.seed(new Date('2026-03-09T05:00:00.000Z'));
  const dstRange = { start: '2026-03-08T06:00:00.000Z', end: '2026-03-09T05:00:00.000Z', timezone: 'America/Chicago' };
  const dst = await demo.readDemo(dstRange);
  assert.equal(dst.concurrency.length,23);
  const longDst = { ...dstRange, start: '2026-03-07T06:00:00.000Z' };
  const dailyDst = await demo.readDemo(longDst);
  assert.equal(dailyDst.concurrency.length,2);
  assert.deepEqual(dailyDst.concurrency.map(point => calendarDate(point.at,longDst.timezone)),['2026-03-07','2026-03-08']);
  const utc = await demo.readDemo({ ...longDst, timezone: 'UTC' });
  assert.equal(utc.concurrency.length,3);
  assert.deepEqual(utc.concurrency.map(point => calendarDate(point.at,'UTC')),['2026-03-07','2026-03-08','2026-03-09']);
  await demo.seed(new Date('2025-11-03T06:00:00.000Z'));
  const fall = await demo.readDemo({ start: '2025-11-02T05:00:00.000Z', end: '2025-11-03T06:00:00.000Z', timezone: 'America/Chicago' });
  assert.equal(fall.concurrency.length,25);
  assert(fall.concurrency.every(point => calendarDate(point.at,'America/Chicago') === '2025-11-02'));
});
