/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionService } from '../session/service';
import { MemorySessionStore } from '../session/memory-store';
import { ClientPlaybackGuard } from '../session/playback-guard';
import { SessionError, unavailableDialogue, unavailableSpeech } from '../session/contracts';
import type { Authorization, Principal, SessionEvent, SessionMode, TestPolicy } from '../session/contracts';
import type { SpeechSegment } from '../protocol/therapist';

const mode: SessionMode = { input: 'text', visual: 'hidden' };
const principal: Principal = { accountId: 'synthetic-account', clientId: 'client-a', connectionId: 'connection-a' };
const readiness = { inputReady: true, outputReady: true, providerReady: true, avatarReady: false };
const policy: TestPolicy = { profile: 'internal-test-v1', timing: 'absolute-deadline', reservationMs: 10_000,
  readinessMs: 1000, maxActiveSessions: 1, maxEventsPerSession: 8, maxUtteranceChars: 2000 };
const speech = (id = 'synthetic-segment'): SpeechSegment => ({ id, text: '[Synthetic fixture only]', durationMs: 1000,
  visemes: [{ viseme: 'X', startMs: 0, endMs: 1000, intensity: 0 }], gestures: [] });
const code = (value: string) => (error: unknown) => error instanceof SessionError && error.code === value;
async function fixture(credits = 2) {
  let time = 1000, serial = 0;
  const store = new MemorySessionStore();
  const service = new SessionService(store, policy, () => time, () => `synthetic-${++serial}`);
  await service.seedTestAccount(principal.accountId, credits);
  const start = await service.start(principal, 'start', mode);
  const sessionId = start.snapshot.sessionId;
  return { store, service, sessionId, start, advance: (ms: number) => { time += ms; }, now: () => time,
    restart: () => new SessionService(store, policy, () => time, () => `synthetic-${++serial}`) };
}
async function active() {
  const f = await fixture();
  const ready = await f.service.ready(principal, f.sessionId, readiness);
  const admitted = await f.service.confirm(principal, f.sessionId, 'confirm', ready.snapshot.sessionRevision, mode);
  return { ...f, admitted };
}
async function response(f: Awaited<ReturnType<typeof active>>, utteranceId = 'utterance-a') {
  return (await f.service.commitUtterance(principal, f.sessionId, utteranceId, utteranceId, '[Synthetic input]')).authorization!;
}
async function mediaEvent(f: Awaited<ReturnType<typeof active>>, target: Authorization, segment = speech()): Promise<SessionEvent> {
  const before = (await f.service.snapshot(principal, f.sessionId)).snapshot.sequence;
  await f.service.publishSpeech(f.sessionId, target, 0, segment);
  const replay = await f.service.snapshot(principal, f.sessionId, before);
  return replay.events.find(e => e.type === 'speech.ready')!;
}

test('double start, confirm retries and different payloads cannot double charge', async () => {
  const f = await fixture(1);
  const retries = await Promise.all(Array.from({ length: 10 }, () => f.service.start(principal, 'start', mode)));
  assert.ok(retries.every(r => r.snapshot.sessionId === f.sessionId));
  assert.equal((await f.service.testBalance(principal.accountId)).credits, 0);
  assert.equal(f.start.snapshot.startedAt, null);
  await assert.rejects(f.service.start(principal, 'start', { ...mode, visual: 'visible' }), code('idempotency_conflict'));
  const ready = await f.service.ready(principal, f.sessionId, readiness);
  const admits = await Promise.all(Array.from({ length: 10 }, () => f.service.confirm(principal, f.sessionId, 'confirm', ready.snapshot.sessionRevision, mode)));
  assert.ok(admits.every(r => r.snapshot.accounting === 'consumed'));
  assert.equal(admits[0].snapshot.endsAt! - admits[0].snapshot.startedAt!, 45 * 60_000);
  assert.equal((await f.service.testBalance(principal.accountId)).credits, 0);
});
test('two devices compete for one test session without losing extra credit', async () => {
  const f = await fixture(2);
  await assert.rejects(f.service.start({ ...principal, clientId: 'device-b' }, 'start-b', mode), code('session_conflict'));
  assert.equal((await f.service.testBalance(principal.accountId)).credits, 1);
});
test('trial duration is separately ten minutes under internal test credits', async () => {
  const f = await fixture(); await f.service.cancelPreparation(principal, f.sessionId, 'release');
  const start = await f.service.start(principal, 'trial', mode, 'trial');
  const ready = await f.service.ready(principal, start.snapshot.sessionId, readiness);
  const result = await f.service.confirm(principal, start.snapshot.sessionId, 'trial-confirm', ready.snapshot.sessionRevision, mode);
  assert.equal(result.snapshot.endsAt! - result.snapshot.startedAt!, 10 * 60_000);
});
test('denied input, missing provider and visible-avatar failure cannot start time', async () => {
  const f = await fixture();
  for (const missing of ['inputReady', 'outputReady', 'providerReady'] as const) {
    const ready = await f.service.ready(principal, f.sessionId, { ...readiness, [missing]: false });
    await assert.rejects(f.service.confirm(principal, f.sessionId, missing, ready.snapshot.sessionRevision, mode), code('not_ready'));
  }
  await f.service.cancelPreparation(principal, f.sessionId, 'cancel');
  const visible = { ...mode, visual: 'visible' as const };
  const start = await f.service.start(principal, 'visible', visible);
  const ready = await f.service.ready(principal, start.snapshot.sessionId, readiness);
  await assert.rejects(f.service.confirm(principal, start.snapshot.sessionId, 'confirm-visible', ready.snapshot.sessionRevision, visible), code('not_ready'));
});
test('stale revision, changed visual mode and readiness expiry reject confirmation', async () => {
  const f = await fixture();
  const first = await f.service.ready(principal, f.sessionId, readiness);
  const second = await f.service.ready(principal, f.sessionId, readiness);
  await assert.rejects(f.service.confirm(principal, f.sessionId, 'stale', first.snapshot.sessionRevision, mode), code('stale_ready'));
  await assert.rejects(f.service.confirm(principal, f.sessionId, 'mode', second.snapshot.sessionRevision, { ...mode, visual: 'visible' }), code('stale_ready'));
  f.advance(policy.readinessMs);
  await assert.rejects(f.service.confirm(principal, f.sessionId, 'expired', second.snapshot.sessionRevision, mode), code('not_ready'));
});
test('confirm winning against preparation cancel retains consumed accounting', async () => {
  const f = await fixture(); const ready = await f.service.ready(principal, f.sessionId, readiness);
  const [confirm, cancel] = await Promise.all([
    f.service.confirm(principal, f.sessionId, 'confirm', ready.snapshot.sessionRevision, mode),
    f.service.cancelPreparation(principal, f.sessionId, 'cancel'),
  ]);
  assert.equal(confirm.outcome, 'activated'); assert.equal(cancel.outcome, 'already_active');
  assert.equal(cancel.snapshot.accounting, 'consumed');
  assert.equal((await f.service.testBalance(principal.accountId)).credits, 1);
});
test('cancel winning against confirmation releases exactly once', async () => {
  const f = await fixture(); const ready = await f.service.ready(principal, f.sessionId, readiness);
  const [cancel, confirm] = await Promise.all([
    f.service.cancelPreparation(principal, f.sessionId, 'cancel'),
    f.service.confirm(principal, f.sessionId, 'confirm', ready.snapshot.sessionRevision, mode),
  ]);
  assert.equal(cancel.snapshot.accounting, 'released'); assert.equal(confirm.outcome, 'released');
  await f.service.cancelPreparation(principal, f.sessionId, 'cancel-again');
  assert.equal((await f.service.testBalance(principal.accountId)).credits, 2);
});
test('expired reservation cannot activate without running a cleanup job', async () => {
  const f = await fixture(); const ready = await f.service.ready(principal, f.sessionId, readiness);
  f.advance(policy.reservationMs);
  const confirm = await f.service.confirm(principal, f.sessionId, 'late', ready.snapshot.sessionRevision, mode);
  assert.equal(confirm.snapshot.lifecycle, 'expired'); assert.equal(confirm.snapshot.accounting, 'released');
  assert.equal((await f.service.testBalance(principal.accountId)).credits, 2);
});
test('lost activation reply can be queried and retried after controller reconnect', async () => {
  const f = await fixture(); const ready = await f.service.ready(principal, f.sessionId, readiness);
  const initial = await f.service.confirm(principal, f.sessionId, 'confirm', ready.snapshot.sessionRevision, mode);
  const next = { ...principal, connectionId: 'connection-b' };
  await f.service.reconnect(next, f.sessionId, 'reconnect', principal.connectionId);
  const repeated = await f.service.confirm(next, f.sessionId, 'confirm', ready.snapshot.sessionRevision, mode);
  assert.equal(repeated.snapshot.startedAt, initial.snapshot.startedAt);
  assert.equal(repeated.snapshot.endsAt, initial.snapshot.endsAt);
  assert.equal((await f.service.testBalance(principal.accountId)).credits, 1);
});
test('rebind rejects old connections, other devices and competing connection claims', async () => {
  const f = await active(); const next = { ...principal, connectionId: 'connection-b' };
  await f.service.reconnect(next, f.sessionId, 'reconnect', principal.connectionId);
  await assert.rejects(f.service.snapshot(principal, f.sessionId), code('controller_conflict'));
  await assert.rejects(f.service.end(principal, f.sessionId, 'old-end'), code('controller_conflict'));
  await assert.rejects(f.service.reconnect({ ...next, clientId: 'client-b' }, f.sessionId, 'takeover', next.connectionId), code('controller_conflict'));
  await assert.rejects(f.service.reconnect({ ...principal, connectionId: 'connection-c' }, f.sessionId, 'competing', principal.connectionId), code('controller_conflict'));
});
test('superseded controllers cannot recover state through old Start or Reconnect retries', async () => {
  const f = await active(), next = { ...principal, connectionId: 'connection-b' }, third = { ...principal, connectionId: 'connection-c' };
  await f.service.reconnect(next, f.sessionId, 'rebind-b', principal.connectionId);
  await assert.rejects(f.service.start(principal, 'start', mode), code('controller_conflict'));
  const validRetry = await f.service.start(next, 'start', mode);
  assert.equal(validRetry.snapshot.controller.connectionId, next.connectionId);
  await f.service.reconnect(third, f.sessionId, 'rebind-c', next.connectionId);
  await assert.rejects(f.service.reconnect(next, f.sessionId, 'rebind-b', principal.connectionId), code('controller_conflict'));
  assert.equal((await f.service.start(third, 'start', mode)).snapshot.endsAt, f.admitted.snapshot.endsAt);
  assert.deepEqual((await f.service.testLedger(principal.accountId)).map(entry => entry.effect), ['reserved', 'consumed']);
});
test('lost Start reply is discovered without control, then explicitly rebound without duplicate accounting', async () => {
  const f = await fixture(), fresh = { ...principal, connectionId: 'fresh-connection' };
  assert.deepEqual(await f.service.lookupStart(fresh, 'start'), { protocolVersion: 1, sessionId: f.sessionId });
  await assert.rejects(f.service.start(fresh, 'start', mode), code('controller_conflict'));
  await assert.rejects(f.service.snapshot(fresh, f.sessionId), code('controller_conflict'));
  assert.equal((await f.service.snapshot(principal, f.sessionId)).snapshot.controller.connectionId, principal.connectionId);
  assert.equal((await f.service.testBalance(principal.accountId)).credits, 1);
  await f.service.reconnect(fresh, f.sessionId, 'recover-binding', principal.connectionId);
  const ready = await f.service.ready(fresh, f.sessionId, readiness);
  const admitted = await f.service.confirm(fresh, f.sessionId, 'confirm', ready.snapshot.sessionRevision, mode);
  assert.equal((await f.service.start(fresh, 'start', mode)).snapshot.endsAt, admitted.snapshot.endsAt);
  assert.deepEqual((await f.service.testLedger(principal.accountId)).map(entry => entry.effect), ['reserved', 'consumed']);
  await assert.rejects(f.service.snapshot(principal, f.sessionId), code('controller_conflict'));
  assert.deepEqual(await f.service.lookupStart(principal, 'start'), { protocolVersion: 1, sessionId: f.sessionId });
  await assert.rejects(f.service.reconnect(principal, f.sessionId, 'old-claim', principal.connectionId), code('controller_conflict'));
});
test('Start lookup is scoped to verified account/client and cannot disclose current authorization or binding', async () => {
  const f = await active(); await response(f);
  await f.service.seedTestAccount('synthetic-other', 1);
  for (const other of [{ ...principal, accountId: 'synthetic-other' }, { ...principal, clientId: 'different-client' }]) {
    await assert.rejects(f.service.lookupStart(other, 'start'), code('not_found'));
    await assert.rejects(f.service.lookupStart(other, 'missing'), code('not_found'));
  }
  assert.deepEqual(Object.keys(await f.service.lookupStart({ ...principal, connectionId: 'fresh' }, 'start')).sort(), ['protocolVersion', 'sessionId']);
  await f.service.revokeTestAccount(principal.accountId);
  await assert.rejects(f.service.lookupStart(principal, 'start'), code('no_access'));
});
test('Start discovery reconciles an expired reservation without restarting it or charging', async () => {
  const f = await fixture(), fresh = { ...principal, connectionId: 'fresh' };
  f.advance(policy.reservationMs);
  const reference = await f.service.lookupStart(fresh, 'start'); assert.equal(reference.sessionId, f.sessionId);
  const state = (await f.service.snapshot(principal, f.sessionId)).snapshot;
  assert.equal(state.lifecycle, 'expired'); assert.equal(state.startedAt, null);
  assert.equal((await f.service.testBalance(principal.accountId)).credits, 2);
  assert.deepEqual((await f.service.testLedger(principal.accountId)).map(entry => entry.effect), ['reserved', 'released']);
});
test('unowned or nonexistent sessions have the same error and isolated test balance', async () => {
  const f = await active(); const stranger = { ...principal, accountId: 'stranger' };
  await assert.rejects(f.service.snapshot(stranger, f.sessionId), code('not_found'));
  await assert.rejects(f.service.snapshot(stranger, 'absent'), code('not_found'));
  assert.equal((await f.service.testBalance(principal.accountId)).credits, 1);
});
test('duplicate utterance is immutable and never authorizes a second generation', async () => {
  const f = await active(); const a = await response(f);
  const repeat = await f.service.commitUtterance(principal, f.sessionId, 'other-command', a.utteranceId, '[Synthetic input]');
  assert.deepEqual(repeat.authorization, a);
  await assert.rejects(f.service.commitUtterance(principal, f.sessionId, 'changed-command', a.utteranceId, 'Changed fixture'), code('idempotency_conflict'));
  const current = (await f.service.snapshot(principal, f.sessionId)).snapshot;
  assert.equal(current.generation, a.generation);
});
test('targeted cancel and duplicates cannot cancel a newer response', async () => {
  const f = await active(), a = await response(f), b = await response(f, 'utterance-b');
  const delayed = await f.service.cancelResponse(principal, f.sessionId, 'cancel-a', a);
  assert.equal(delayed.outcome, 'not_current'); assert.deepEqual(delayed.snapshot.authorization, b);
  const canceled = await f.service.cancelResponse(principal, f.sessionId, 'cancel-b', b);
  const repeat = await f.service.cancelResponse(principal, f.sessionId, 'cancel-b', b);
  assert.equal(repeat.snapshot.generation, canceled.snapshot.generation);
  await assert.rejects(f.service.publishSpeech(f.sessionId, a, 0, speech()), code('stale_response'));
  await assert.rejects(f.service.publishSpeech(f.sessionId, b, 0, speech()), code('stale_response'));
});
test('immutable segments require ordered identity and correct speech duration', async () => {
  const f = await active(), a = await response(f), s = speech();
  await assert.rejects(f.service.publishSpeech(f.sessionId, a, 1, s), code('segment_order'));
  assert.equal((await f.service.publishSpeech(f.sessionId, a, 0, s)).outcome, 'published');
  assert.equal((await f.service.publishSpeech(f.sessionId, a, 0, s)).outcome, 'duplicate');
  await assert.rejects(f.service.publishSpeech(f.sessionId, a, 0, { ...s, text: 'changed' }), code('segment_conflict'));
  await assert.rejects(f.service.publishSpeech(f.sessionId, a, 1, { ...speech('bad-cues'), durationMs: 500 }), /Speech cue exceeds duration/);
  await assert.rejects(f.service.publishSpeech(f.sessionId, a, 1, { ...speech('url'), audioUrl: 'https://example.com/private' }), code('invalid_input'));
});
test('expiry on late publication commits terminal reconciliation even when publication is rejected', async () => {
  const f = await active(), a = await response(f); f.advance(45 * 60_000);
  await assert.rejects(f.service.publishSpeech(f.sessionId, a, 0, speech()), code('not_active'));
  const stored = await f.store.transaction(state => state.sessions.get(f.sessionId)!.snapshot);
  assert.equal(stored.lifecycle, 'ended'); assert.equal(stored.authorization, null);
  assert.equal((await f.service.testBalance(principal.accountId)).credits, 1);
});
test('terminal state and revocation fence late work; media is removed from replay', async () => {
  const f = await active(), a = await response(f);
  await mediaEvent(f, a); await f.service.revokeTestAccount(principal.accountId);
  await assert.rejects(f.service.publishSpeech(f.sessionId, a, 1, speech('late')), code('not_active'));
  const replay = await f.service.snapshot(principal, f.sessionId, 0);
  assert.equal(replay.snapshot.lifecycle, 'ended'); assert.equal(replay.snapshot.authorization, null);
  assert.equal(replay.events.filter(e => e.speech).length, 0);
  await assert.rejects(f.service.start(principal, 'after-revoke', mode), code('no_access'));
});
test('coordinator replacement recovers preparation and invalidates unowned old response work', async () => {
  const f = await fixture(); f.advance(policy.reservationMs); const restarted = f.restart(); await restarted.recover();
  assert.equal((await restarted.snapshot(principal, f.sessionId)).snapshot.lifecycle, 'expired');
  assert.equal((await restarted.testBalance(principal.accountId)).credits, 2);
  const live = await active(), a = await response(live), replacement = live.restart(); await replacement.recover();
  const snapshot = (await replacement.snapshot(principal, live.sessionId)).snapshot;
  assert.equal(snapshot.endsAt, live.admitted.snapshot.endsAt); assert.equal(snapshot.authorization, null);
  assert.ok(snapshot.generation > a.generation);
  await assert.rejects(replacement.publishSpeech(live.sessionId, a, 0, speech()), code('stale_response'));
});
test('consistent replay cursor and bounded retention require snapshot for expired gaps', async () => {
  const f = await active();
  const cursor = (await f.service.snapshot(principal, f.sessionId)).snapshot.sequence;
  await response(f);
  const replay = await f.service.snapshot(principal, f.sessionId, cursor);
  assert.equal(replay.requiresSnapshot, false);
  assert.equal(replay.events.at(-1)!.snapshot.sequence, replay.snapshot.sequence);
  for (let i = 0; i < 12; i++) await response(f, `utterance-${i}`);
  const old = await f.service.snapshot(principal, f.sessionId, cursor);
  assert.equal(old.requiresSnapshot, true); assert.deepEqual(old.events, []);
  const future = await f.service.snapshot(principal, f.sessionId, old.snapshot.sequence + 1);
  assert.equal(future.requiresSnapshot, true);
});
test('speech arriving after local stop and lost cancellation never resumes after reconnect', async () => {
  const f = await active(), a = await response(f), event = await mediaEvent(f, a);
  const guard = new ClientPlaybackGuard(f.sessionId, principal.clientId, principal.connectionId);
  guard.applySnapshot(event.snapshot); assert.deepEqual(guard.stopLocally(), a);
  const exported = guard.exportSuppression();
  const next = { ...principal, connectionId: 'connection-b' };
  await f.service.reconnect(next, f.sessionId, 'reconnect', principal.connectionId);
  const snapshot = (await f.service.snapshot(next, f.sessionId)).snapshot;
  const restored = new ClientPlaybackGuard(f.sessionId, next.clientId, next.connectionId, exported);
  restored.applySnapshot(snapshot);
  assert.equal(restored.canPlay(a, f.now()), false); assert.equal(restored.acceptSpeech(event, f.now()), null);
});
test('older terminal events cannot reopen playback; unrelated revision does not invalidate current media', async () => {
  const f = await active(), a = await response(f), event = await mediaEvent(f, a);
  const next = { ...principal, connectionId: 'connection-b' };
  const guard = new ClientPlaybackGuard(f.sessionId, principal.clientId, principal.connectionId);
  guard.applySnapshot(event.snapshot);
  await f.service.reconnect(next, f.sessionId, 'reconnect', principal.connectionId);
  const current = (await f.service.snapshot(next, f.sessionId)).snapshot;
  guard.rebindConnection(next.connectionId); guard.applySnapshot(current);
  assert.deepEqual(guard.acceptSpeech(event, f.now()), event.speech);
  assert.equal(guard.acceptSpeech(event, f.now()), null);
  await f.service.end(next, f.sessionId, 'end'); guard.applySnapshot((await f.service.snapshot(next, f.sessionId)).snapshot);
  assert.equal(guard.applySnapshot(event.snapshot), false); assert.equal(guard.canPlay(a, f.now()), false);
});
test('local playback gate respects deadline, connection and current generation before each play', async () => {
  const f = await active(), a = await response(f), event = await mediaEvent(f, a);
  const wrong = new ClientPlaybackGuard(f.sessionId, principal.clientId, 'other-connection');
  wrong.applySnapshot(event.snapshot); assert.equal(wrong.canPlay(a, f.now()), false);
  const guard = new ClientPlaybackGuard(f.sessionId, principal.clientId, principal.connectionId);
  guard.applySnapshot(event.snapshot); assert.equal(guard.canPlay(a, event.snapshot.endsAt!), false);
  await response(f, 'utterance-b'); guard.applySnapshot((await f.service.snapshot(principal, f.sessionId)).snapshot);
  assert.equal(guard.acceptSpeech(event, f.now()), null);
});
test('transaction errors roll back draft state and snapshots cannot mutate stored records', async () => {
  const f = await active();
  await assert.rejects(f.store.transaction(state => { state.accounts.get(principal.accountId)!.credits = 999; throw new Error('fixture rollback'); }), /fixture rollback/);
  assert.equal((await f.service.testBalance(principal.accountId)).credits, 1);
  const { snapshot } = await f.service.snapshot(principal, f.sessionId); snapshot.endsAt = 0;
  assert.notEqual((await f.service.snapshot(principal, f.sessionId)).snapshot.endsAt, 0);
  const held: { account?: { credits: number } } = {};
  await f.store.transaction(state => { held.account = state.accounts.get(principal.accountId)!; });
  held.account!.credits = 999;
  assert.equal((await f.service.testBalance(principal.accountId)).credits, 1);
});
test('unconfigured provider ports fail explicitly without fabricated dialogue or speech', async () => {
  const authorization = { generation: 1, responseId: 'fixture', utteranceId: 'fixture' };
  const signal = new AbortController().signal;
  await assert.rejects(unavailableDialogue.generate({ sessionId: 'fixture', authorization, text: '[synthetic]', signal }), code('provider_unavailable'));
  await assert.rejects(unavailableSpeech.synthesize({ sessionId: 'fixture', authorization, validatedText: '[synthetic]', signal }), code('provider_unavailable'));
});

test('test ledger records each accounting transition once across retries', async () => {
  const f = await active();
  await f.service.cancelPreparation(principal, f.sessionId, 'cancel-after-active');
  await f.service.end(principal, f.sessionId, 'end'); await f.service.end(principal, f.sessionId, 'end');
  const ledger = await f.service.testLedger(principal.accountId);
  assert.deepEqual(ledger.map(x => [x.effect, x.availableDelta]), [['reserved', -1], ['consumed', 0]]);
  assert.equal(new Set(ledger.map(x => x.entryId)).size, ledger.length);
  ledger[0].availableDelta = 123;
  assert.equal((await f.service.testLedger(principal.accountId))[0].availableDelta, -1);
});
test('failed preparations have reservation/release ledger effects and no consumption', async () => {
  const f = await fixture(); await f.service.cancelPreparation(principal, f.sessionId, 'cancel');
  await f.service.cancelPreparation(principal, f.sessionId, 'cancel-again');
  assert.deepEqual((await f.service.testLedger(principal.accountId)).map(x => x.effect), ['reserved', 'released']);
});
test('malformed readiness and invalid policy values fail before activation', async () => {
  const f = await fixture();
  await assert.rejects(f.service.ready(principal, f.sessionId, {} as typeof readiness), code('invalid_input'));
  assert.throws(() => new SessionService(f.store, { ...policy, readinessMs: NaN }), code('invalid_input'));
  const waiting = await f.service.ready(principal, f.sessionId, { ...readiness, providerReady: false });
  assert.equal(waiting.outcome, 'awaiting_readiness'); assert.equal(waiting.snapshot.readyUntil, null);
});
