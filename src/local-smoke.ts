import assert from 'node:assert/strict';
import { MemorySessionStore } from './session/memory-store';
import { SessionService } from './session/service';
import { createDatabaseProbe } from './database/connection';
import { createServer } from './transport/server';

async function smoke() {
  const service = new SessionService(new MemorySessionStore(), {
    profile: 'internal-test-v1', timing: 'absolute-deadline', reservationMs: 10_000, readinessMs: 1000,
    maxActiveSessions: 1, maxEventsPerSession: 8, maxUtteranceChars: 2000,
  });
  const app = await createServer({ service, database: createDatabaseProbe() });
  try {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    assert.equal((await fetch(`${address}/health`)).status, 200);
    assert.equal((await fetch(`${address}/ready`)).status, 503);
    const result = await fetch(`${address}/v1/session/commands`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(result.status, 401);
    console.log('Live localhost HTTP smoke PASS: health200, readiness503, unauthenticated command401. No external services used.');
  } finally { await app.close(); }
}
void smoke().catch(() => { console.error('Local smoke failed'); process.exitCode = 1; });
