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
  assert.equal(value.sessions.length,6); assert.equal(value.concurrency.length,721); assert.equal(typeof value.failedPercent,'number');
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
});
