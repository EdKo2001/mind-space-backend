import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createServer } from '../transport/server';
import { AuthenticationError } from '../transport/auth';
import { createDatabaseProbe } from '../database/connection';
import { SessionService } from '../session/service';
import { MemorySessionStore } from '../session/memory-store';
import type { Principal } from '../session/contracts';

const principal = { accountId: 'synthetic-http-user', clientId: 'synthetic-client', connectionId: 'synthetic-connection' };
const start = { protocolVersion: 1, commandId: 'synthetic-start', type: 'session.start', mode: { input: 'text', visual: 'hidden' }, kind: 'paid' };
const headers = { authorization: 'Bearer synthetic-test-token' };
async function fixture() {
  let validIdentity = true;
  const service = new SessionService(new MemorySessionStore(), { profile: 'internal-test-v1', timing: 'absolute-deadline',
    reservationMs: 10_000, readinessMs: 1000, maxActiveSessions: 1, maxEventsPerSession: 8, maxUtteranceChars: 2000 });
  await service.seedTestAccount(principal.accountId, 1);
  const app = await createServer({ service, database: createDatabaseProbe(), identity: {
    async verify(authorization) {
      if (!validIdentity || authorization !== headers.authorization) throw new AuthenticationError('unauthenticated');
      return { ...principal };
    },
  } });
  await app.ready();
  return { app, service, revoke: () => { validIdentity = false; } };
}
test('health is live while readiness accurately reports missing services', async t => {
  const { app } = await fixture(); t.after(() => app.close());
  assert.equal((await app.inject('/health')).statusCode, 200);
  const ready = await app.inject('/ready'); assert.equal(ready.statusCode, 503);
  assert.equal(ready.json().components.databaseConnection, 'unavailable');
  assert.equal(ready.json().components.durableSessionStore, 'unavailable');
});
test('missing, invalid and unconfigured identity cannot admit a session', async t => {
  const { app, service } = await fixture(); t.after(() => app.close());
  assert.equal((await app.inject({ method: 'POST', url: '/v1/session/commands', payload: start })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/session/commands', headers: { authorization: 'Bearer wrong' }, payload: start })).statusCode, 401);
  assert.equal((await service.testBalance(principal.accountId)).credits, 1);
  const unconfigured = await createServer({ service, database: createDatabaseProbe() }); t.after(() => unconfigured.close());
  const unavailable = await unconfigured.inject({ method: 'POST', url: '/v1/session/commands', headers, payload: start });
  assert.equal(unavailable.statusCode, 503); assert.equal(unavailable.json().error, 'identity_unavailable');
});
test('HTTP command adapter rejects forged identity, changed retry and excessive bodies', async t => {
  const { app } = await fixture(); t.after(() => app.close());
  const request = (payload: unknown) => app.inject({ method: 'POST', url: '/v1/session/commands', headers, payload: JSON.stringify(payload) });
  // Fastify injection needs a declared JSON media type for raw-string payloads.
  const json = (payload: unknown) => app.inject({ method: 'POST', url: '/v1/session/commands', headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
  assert.equal((await json({ ...start, accountId: 'forged' })).statusCode, 400);
  const first = await json(start), retry = await json(start);
  assert.equal(first.statusCode, 200); assert.equal(retry.json().value.snapshot.sessionId, first.json().value.snapshot.sessionId);
  assert.equal((await json({ ...start, mode: { input: 'voice', visual: 'hidden' } })).statusCode, 409);
  assert.equal((await json({ ...start, extra: 'x'.repeat(20_000) })).statusCode, 413);
  assert.equal((await request({})).statusCode, 415); // No handler sees a raw unsupported media type.
  assert.equal((await app.inject({ method: 'POST', url: '/v1/session/commands?token=forbidden', headers, payload: start })).statusCode, 400);
});
test('HTTP malformed JSON returns a typed failure without parser details', async t => {
  const { app } = await fixture(); t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/v1/session/commands', headers: { ...headers, 'content-type': 'application/json' }, payload: '{' });
  assert.equal(response.statusCode, 400); assert.deepEqual(response.json(), { ok: false, error: 'invalid_input' });
});
test('WebSocket rejects unauthenticated handshake; authenticates and orders commands with replay', { timeout: 5000 }, async t => {
  const { app } = await fixture();
  await assert.rejects(app.injectWS('/v1/session/channel'), /401/);
  const socket = await app.injectWS('/v1/session/channel', { headers }); t.after(async () => { socket.terminate(); await app.close(); });
  const firstMessage = once(socket, 'message', { signal: AbortSignal.timeout(2000) });
  socket.send(JSON.stringify(start)); const [firstBytes] = await firstMessage;
  const first = JSON.parse(firstBytes.toString()); assert.equal(first.ok, true);
  const id = first.value.snapshot.sessionId;
  const replayMessage = once(socket, 'message', { signal: AbortSignal.timeout(2000) });
  socket.send(JSON.stringify({ protocolVersion: 1, commandId: 'snapshot', type: 'session.snapshot', sessionId: id, afterSequence: 0 }));
  const [replayBytes] = await replayMessage; const replay = JSON.parse(replayBytes.toString());
  assert.equal(replay.value.snapshot.sequence, replay.value.events.at(-1).sequence);
  const malformedMessage = once(socket, 'message', { signal: AbortSignal.timeout(2000) });
  socket.send('{'); const [malformed] = await malformedMessage;
  assert.deepEqual(JSON.parse(malformed.toString()), { ok: false, error: 'invalid_input' });
});
test('WebSocket identity is checked again after the upgrade', { timeout: 5000 }, async t => {
  const { app, revoke, service } = await fixture();
  const socket = await app.injectWS('/v1/session/channel', { headers }); t.after(async () => { socket.terminate(); await app.close(); }); revoke();
  const message = once(socket, 'message', { signal: AbortSignal.timeout(2000) });
  socket.send(JSON.stringify(start)); const [bytes] = await message;
  assert.deepEqual(JSON.parse(bytes.toString()), { ok: false, error: 'unauthenticated' });
  assert.equal((await service.testBalance(principal.accountId)).credits, 1);
});
test('PostgreSQL port is explicitly unconfigured and rejects incompatible URL schemes', async () => {
  const probe = createDatabaseProbe(); assert.equal(await probe.check(), false); await probe.close();
  assert.throws(() => createDatabaseProbe('https://example.com'), /Invalid PostgreSQL configuration/);
});
test('malformed verifier results cannot authorize HTTP commands or WebSocket handshakes', async t => {
  const { app, service } = await fixture(); t.after(() => app.close());
  const accessor = Object.defineProperty({ ...principal }, 'connectionId', { enumerable: true, get() { return principal.connectionId; } });
  for (const malformed of [null, {}, { ...principal, accountId: undefined }, { ...principal, clientId: ' ' },
    { ...principal, connectionId: 'x'.repeat(129) }, { ...principal, extra: 'unexpected' }, Object.assign([], principal), accessor]) {
    const invalid = await createServer({ service, database: createDatabaseProbe(), identity: { async verify() { return malformed as Principal; } } });
    try {
      const result = await invalid.inject({ method: 'POST', url: '/v1/session/commands', headers, payload: start });
      assert.equal(result.statusCode, 503); assert.deepEqual(result.json(), { ok: false, error: 'identity_unavailable' });
      await assert.rejects(invalid.injectWS('/v1/session/channel', { headers }), /503/);
    } finally { await invalid.close(); }
  }
  assert.equal((await service.testBalance(principal.accountId)).credits, 1);
});
test('HTTP Start lookup is correlated and reveals only the existing verified-client session ID', async t => {
  const { app, service } = await fixture(); t.after(() => app.close());
  const started = await app.inject({ method: 'POST', url: '/v1/session/commands', headers, payload: start });
  const sessionId = started.json().value.snapshot.sessionId;
  const lookup = { protocolVersion: 1, type: 'session.lookup_start', commandId: 'discover', startCommandId: start.commandId };
  const recovered = await app.inject({ method: 'POST', url: '/v1/session/commands', headers, payload: lookup });
  assert.equal(recovered.statusCode, 200);
  assert.deepEqual(recovered.json(), { ok: true, profile: 'internal-test-v1', commandId: 'discover', type: 'start_reference', value: { protocolVersion: 1, sessionId } });
  assert.equal((await app.inject({ method: 'POST', url: '/v1/session/commands', headers, payload: { ...lookup, accountId: 'forged' } })).statusCode, 400);
  assert.equal((await service.testBalance(principal.accountId)).credits, 0);
});
