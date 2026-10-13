import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeCommand, dispatchCommand } from '../session/commands';
import { decodeEvent, decodeSnapshot } from '../session/wire';
import { SessionError } from '../session/contracts';
import { MemorySessionStore } from '../session/memory-store';
import { SessionService } from '../session/service';

const mode = { input: 'text', visual: 'hidden' };
const limits = { maxTranscriptChars: 20 };
const base = { protocolVersion: 1, commandId: 'synthetic-command' };
const envelope = { ...base, sessionId: 'synthetic-session' };
const invalid = (error: unknown) => error instanceof SessionError && error.code === 'invalid_input';
const commands = [
  { ...base, type: 'session.start', mode, kind: 'paid' },
  { ...envelope, type: 'session.confirm', mode, revision: 1 },
  { ...envelope, type: 'session.cancel_preparation' },
  { ...envelope, type: 'session.reconnect', expectedConnectionId: 'previous-connection' },
  { ...envelope, type: 'session.snapshot', afterSequence: 0 },
  { ...envelope, type: 'session.utterance', utteranceId: 'synthetic-utterance', transcript: 'Synthetic input' },
  { ...envelope, type: 'response.cancel', target: { generation: 1, responseId: 'synthetic-response', utteranceId: 'synthetic-utterance' } },
  { ...envelope, type: 'session.end' },
];
for (const command of commands) test(`command wire roundtrip: ${command.type}`, () => {
  assert.deepEqual(decodeCommand(JSON.parse(JSON.stringify(command)), limits), command);
});
test('command decoder excludes client/account identity and internal readiness/media/credit operations', () => {
  for (const raw of [
    { ...commands[0], accountId: 'forged' }, { ...commands[0], clientId: 'forged' },
    { ...commands[0], mode: { ...mode, accountId: 'forged' } },
    { ...envelope, type: 'session.ready', readiness: true }, { ...envelope, type: 'speech.publish' },
    { ...envelope, type: 'account.seed', credits: 999 },
  ]) assert.throws(() => decodeCommand(raw, limits), invalid);
});
test('command decoder rejects malformed versions, identifiers, objects and transcript boundaries', () => {
  for (const raw of [null, [], 'text', new Date(), { ...commands[0], protocolVersion: 2 }, { ...commands[0], commandId: ' ' },
    { ...commands[0], commandId: 'x'.repeat(129) }, { ...commands[1], revision: NaN },
    { ...commands[4], afterSequence: -1 }, { ...commands[5], transcript: 'x'.repeat(21) },
    { ...commands[5], transcript: ' ' }, { ...commands[6], target: { generation: 0, responseId: 'r', utteranceId: 'u' } },
  ]) assert.throws(() => decodeCommand(raw, limits), invalid);
  let invoked = false;
  const getter = Object.defineProperty({}, 'type', { get() { invoked = true; return 'session.start'; } });
  assert.throws(() => decodeCommand(getter, limits), invalid); assert.equal(invoked, false);
  assert.throws(() => decodeCommand(JSON.parse('{"__proto__":{},"protocolVersion":1,"commandId":"x","type":"session.start","mode":{"input":"text","visual":"hidden"},"kind":"paid"}'), limits), invalid);
});
test('dispatcher uses separate trusted identity, immutable commands and valid snapshots/events', async () => {
  const store = new MemorySessionStore(), principal = { accountId: 'synthetic', clientId: 'synthetic', connectionId: 'synthetic' };
  const service = new SessionService(store, { profile: 'internal-test-v1', timing: 'absolute-deadline', reservationMs: 10_000,
    readinessMs: 1000, maxActiveSessions: 1, maxEventsPerSession: 8, maxUtteranceChars: limits.maxTranscriptChars }, () => 1000);
  await service.seedTestAccount(principal.accountId, 1);
  const started = await dispatchCommand(service, principal, commands[0]);
  assert.equal(started.type, 'result'); if (started.type !== 'result') return;
  const snapshot = started.value.snapshot;
  assert.deepEqual(decodeSnapshot(JSON.parse(JSON.stringify(snapshot))), snapshot);
  for (const broken of [{ ...snapshot, accounting: 'consumed' }, { ...snapshot, startedAt: 0 }, { ...snapshot, profile: 'production' },
    { ...snapshot, authorization: { generation: 1, responseId: 'r', utteranceId: 'u' } },
  ]) assert.throws(() => decodeSnapshot(broken), invalid);
  const ready = await service.ready(principal, snapshot.sessionId, { inputReady: true, outputReady: true, providerReady: true, avatarReady: false });
  const active = await dispatchCommand(service, principal, { ...commands[1], sessionId: snapshot.sessionId, revision: ready.snapshot.sessionRevision });
  assert.equal(active.type, 'result'); if (active.type !== 'result') return;
  const validActive = active.value.snapshot;
  assert.deepEqual(decodeSnapshot(validActive), validActive);
  assert.throws(() => decodeSnapshot({ ...validActive, endsAt: validActive.startedAt }), invalid);
  const committed = await dispatchCommand(service, principal, { ...commands[5], sessionId: snapshot.sessionId });
  if (committed.type !== 'result') return;
  const auth = committed.value.authorization!;
  const before = committed.value.snapshot.sequence;
  await service.publishSpeech(snapshot.sessionId, auth, 0, { id: 'synthetic-segment', text: 'Synthetic audio fixture metadata', durationMs: 1000, visemes: [], gestures: [] });
  const replay = await service.snapshot(principal, snapshot.sessionId, before);
  for (const event of replay.events) assert.deepEqual(decodeEvent(JSON.parse(JSON.stringify(event))), event);
  const media = replay.events[0];
  assert.throws(() => decodeEvent({ ...media, sequence: media.sequence + 1 }), invalid);
  assert.throws(() => decodeEvent({ ...media, authorization: { ...auth, generation: auth.generation + 1 } }), invalid);
  assert.throws(() => decodeEvent({ ...media, speech: { ...media.speech, audioUrl: 'https://example.com/untrusted' } }), invalid);
});
