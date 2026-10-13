import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createServer } from '../transport/server';
import { SessionWakeups } from '../transport/wakeups';
import { AuthenticationError } from '../transport/auth';
import { createDatabaseProbe } from '../database/connection';
import { MemorySessionStore } from '../session/memory-store';
import { SessionService } from '../session/service';
import type { Principal } from '../session/contracts';
import { ClientPlaybackGuard } from '../session/playback-guard';

const principal = { accountId: 'synthetic-live-user', clientId: 'synthetic-client', connectionId: 'synthetic-connection' };
const mode = { input: 'text' as const, visual: 'hidden' as const };
const readiness = { inputReady: true, outputReady: true, providerReady: true, avatarReady: false };
async function fixture(t: TestContext, interval = 10_000, history = 2) {
  let valid = true;
  let verifiedIdentity: unknown = { ...principal };
  const store = new MemorySessionStore(), service = new SessionService(store, { profile: 'internal-test-v1', timing: 'absolute-deadline',
    reservationMs: 60_000, readinessMs: 10_000, maxActiveSessions: 1, maxEventsPerSession: history, maxUtteranceChars: 2000 });
  await service.seedTestAccount(principal.accountId, 2);
  const start = await service.start(principal, 'start', mode), sessionId = start.snapshot.sessionId;
  const ready = await service.ready(principal, sessionId, readiness);
  await service.confirm(principal, sessionId, 'confirm', ready.snapshot.sessionRevision, mode);
  const wakeups = new SessionWakeups();
  const app = await createServer({ service, database: createDatabaseProbe(), live: { wakeups, pollIntervalMs: interval }, identity: {
    async verify(authorization) {
      if (!valid || authorization !== 'Bearer synthetic-test-token') throw new AuthenticationError('unauthenticated');
      return verifiedIdentity as Principal;
    },
  } });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const socket = new WebSocket(`${address.replace('http:', 'ws:')}/v1/session/channel`, { headers: { authorization: 'Bearer synthetic-test-token' } });
  socket.on('error', () => {});
  t.after(async () => { socket.terminate(); await app.close(); });
  await once(socket, 'open', { signal: AbortSignal.timeout(2000) });
  const snapshot = once(socket, 'message', { signal: AbortSignal.timeout(2000) });
  socket.send(JSON.stringify({ protocolVersion: 1, type: 'session.snapshot', commandId: 'snapshot', sessionId }));
  await snapshot;
  return { app, socket, service, store, wakeups, sessionId, revoke: () => { valid = false; }, setIdentity: (value: unknown) => { verifiedIdentity = value; } };
}
async function message(socket: WebSocket) { const [bytes] = await once(socket, 'message', { signal: AbortSignal.timeout(2000) }); return JSON.parse(bytes.toString()); }
test('real WebSocket gets background state changes without sending another command; wakeups deduplicate', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const authorized = await f.service.commitUtterance(principal, f.sessionId, 'input', 'utterance', 'Synthetic content');
  const received = message(f.socket); f.wakeups.wake(); f.wakeups.wake();
  const live = await received;
  assert.equal(live.type, 'events'); assert.equal(live.value.snapshot.authorization.responseId, authorized.authorization!.responseId);
  assert.equal(live.value.events[0].type, 'response.authorized');
  let repeated = 0; f.socket.on('message', () => { repeated++; });
  f.wakeups.wake(); await delay(30); assert.equal(repeated, 0);
});
test('live terminal recovery never pushes older authorized work after a replay gap', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  await f.service.commitUtterance(principal, f.sessionId, 'a', 'a', 'Synthetic first');
  await f.service.commitUtterance(principal, f.sessionId, 'b', 'b', 'Synthetic second');
  await f.service.end(principal, f.sessionId, 'end');
  const received = message(f.socket); f.wakeups.wake(); const live = await received;
  assert.equal(live.value.snapshot.lifecycle, 'ended'); assert.equal(live.value.snapshot.authorization, null);
  assert.equal(live.value.requiresSnapshot, true); assert.deepEqual(live.value.events, []);
});
test('live push revalidates identity and controller and cannot leak an unrelated account', { timeout: 5000 }, async t => {
  const f = await fixture(t), other = { ...principal, accountId: 'synthetic-other-account' };
  await f.service.seedTestAccount(other.accountId, 1); await f.service.start(other, 'other', mode);
  let pushes = 0; f.socket.on('message', () => { pushes++; });
  f.wakeups.wake(); await delay(30); assert.equal(pushes, 0);
  f.revoke(); const received = message(f.socket), closed = once(f.socket, 'close');
  f.wakeups.wake(); assert.deepEqual(await received, { ok: false, error: 'unauthenticated' }); await closed;
});
test('controller replacement fences an idle old channel without another old-client command', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  await f.service.reconnect({ ...principal, connectionId: 'synthetic-new-connection' }, f.sessionId, 'rebind', principal.connectionId);
  const received = message(f.socket), closed = once(f.socket, 'close'); f.wakeups.wake();
  assert.deepEqual(await received, { ok: false, error: 'controller_conflict' }); await closed;
});
test('live polling recovers missing notification; shutdown releases an open socket', { timeout: 5000 }, async t => {
  const f = await fixture(t, 20);
  const received = message(f.socket); await f.service.end(principal, f.sessionId, 'end');
  assert.equal((await received).value.snapshot.lifecycle, 'ended');
  const closed = once(f.socket, 'close'); await f.app.close(); await closed;
  assert.notEqual(f.socket.readyState, WebSocket.OPEN);
});
test('live protocol correlates successful and rejected commands independently from unsolicited events', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const failed = message(f.socket);
  f.socket.send(JSON.stringify({ protocolVersion: 1, type: 'session.snapshot', sessionId: 'unowned', commandId: 'request-failed' }));
  assert.deepEqual(await failed, { ok: false, error: 'not_found', commandId: 'request-failed' });
  const result = message(f.socket);
  f.socket.send(JSON.stringify({ protocolVersion: 1, type: 'session.snapshot', sessionId: f.sessionId, commandId: 'request-success' }));
  assert.equal((await result).commandId, 'request-success');
  const update = message(f.socket); await f.service.end(principal, f.sessionId, 'internal-end'); f.wakeups.wake();
  const live = await update; assert.equal(live.type, 'events'); assert.equal(live.commandId, undefined);
});
test('live replay retains current speech across an unrelated revision', { timeout: 5000 }, async t => {
  const f = await fixture(t), response = await f.service.commitUtterance(principal, f.sessionId, 'input', 'utterance', 'Synthetic input');
  const authorization = message(f.socket); f.wakeups.wake(); await authorization;
  await f.service.publishSpeech(f.sessionId, response.authorization!, 0, { id: 'synthetic-segment', text: 'Synthetic fixture', durationMs: 1000, visemes: [], gestures: [] });
  // A same-controller rebind advances revision without invalidating this response/media.
  await f.service.reconnect(principal, f.sessionId, 'same-binding', principal.connectionId);
  const received = message(f.socket); f.wakeups.wake(); const live = await received;
  assert.equal(live.value.requiresSnapshot, false);
  assert.ok(live.value.events.some((event: { type: string }) => event.type === 'speech.ready'));
  assert.equal(live.value.snapshot.authorization.responseId, response.authorization!.responseId);
  const guard = new ClientPlaybackGuard(f.sessionId, principal.clientId, principal.connectionId);
  guard.applySnapshot(live.value.snapshot);
  assert.equal(guard.acceptSpeech(live.value.events.find((event: { type: string }) => event.type === 'speech.ready'), Date.now())?.id, 'synthetic-segment');
});
test('authoritative replay snapshot fences old generations and preserves local stop suppression', { timeout: 5000 }, async t => {
  const f = await fixture(t, 10_000, 8);
  const a = await f.service.commitUtterance(principal, f.sessionId, 'a', 'a', 'Synthetic first');
  await f.service.publishSpeech(f.sessionId, a.authorization!, 0, { id: 'synthetic-a', text: 'Synthetic fixture', durationMs: 1000, visemes: [], gestures: [] });
  const b = await f.service.commitUtterance(principal, f.sessionId, 'b', 'b', 'Synthetic second');
  await f.service.publishSpeech(f.sessionId, b.authorization!, 0, { id: 'synthetic-b', text: 'Synthetic fixture', durationMs: 1000, visemes: [], gestures: [] });
  await f.service.reconnect(principal, f.sessionId, 'unrelated', principal.connectionId);
  const received = message(f.socket); f.wakeups.wake(); const live = await received;
  assert.equal(live.value.requiresSnapshot, false);
  const guard = new ClientPlaybackGuard(f.sessionId, principal.clientId, principal.connectionId);
  guard.applySnapshot(live.value.snapshot);
  const accepted = live.value.events.map((event: Parameters<ClientPlaybackGuard['acceptSpeech']>[0]) => guard.acceptSpeech(event, Date.now())).filter(Boolean);
  assert.deepEqual(accepted.map((speech: { id: string }) => speech.id), ['synthetic-b']);
  guard.stopLocally();
  for (const event of live.value.events) assert.equal(guard.acceptSpeech(event, Date.now()), null);
});
test('malformed reverified identity fails closed before live state delivery', { timeout: 5000 }, async t => {
  const f = await fixture(t); f.setIdentity({ ...principal, connectionId: undefined });
  const received = message(f.socket), closed = once(f.socket, 'close'); f.wakeups.wake();
  assert.deepEqual(await received, { ok: false, error: 'identity_unavailable' }); await closed;
});
