import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Pool } from 'pg';
import { reconcileDueAccounts, startMaintenance } from '../database/maintenance';
import { PostgresSessionStore } from '../database/postgres-store';
import { SessionService } from '../session/service';
import { SessionError } from '../session/contracts';
import type { Result } from '../session/contracts';
import { migrationSql } from '../database/migrations';
import { dashboardSnapshot } from '../dashboard/service';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for real PostgreSQL integration tests; no simulated pass');
const policy = { profile: 'internal-test-v1' as const, timing: 'absolute-deadline' as const, reservationMs: 10_000,
  readinessMs: 1000, maxActiveSessions: 1, maxEventsPerSession: 8, maxUtteranceChars: 2000 };
const principal = { accountId: 'synthetic-account', clientId: 'synthetic-client', connectionId: 'synthetic-connection' };
const mode = { input: 'text' as const, visual: 'hidden' as const };
const readiness = { inputReady: true, outputReady: true, providerReady: true, avatarReady: false };
const errorCode = (code: string) => (error: unknown) => error instanceof SessionError && error.code === code;
async function fixture(t: TestContext) {
  const schemaName = `ms_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString }), a = PostgresSessionStore.connect(connectionString!, schemaName), b = PostgresSessionStore.connect(connectionString!, schemaName);
  t.after(async () => {
    await a.close(); await b.close();
    // Generated ms_test namespace contains only fixtures owned by this test; never drop application schema/volume.
    await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`); await admin.end();
  });
  await Promise.all([a.initialize(), b.initialize()]);
  let clock = Date.now();
  const serviceA = new SessionService(a, policy, () => clock), serviceB = new SessionService(b, policy, () => clock);
  await serviceA.seedTestAccount(principal.accountId, 2);
  return { a, b, serviceA, serviceB, admin, schema: a.schema, schemaName, advance(ms: number) { clock += ms; } };
}
async function active(f: Awaited<ReturnType<typeof fixture>>) {
  const started = await f.serviceA.start(principal, 'start', mode), sessionId = started.snapshot.sessionId;
  const ready = await f.serviceA.ready(principal, sessionId, readiness);
  const admitted = await f.serviceA.confirm(principal, sessionId, 'confirm', ready.snapshot.sessionRevision, mode);
  return { sessionId, ready, admitted };
}

test('real PostgreSQL upgrades an existing version-1 schema without changing data or its checksum', async t => {
  const f = await fixture(t);
  // Disposable fixture only: rebuild migration tracking to emulate the already-deployed v1 checkpoint.
  await f.admin.query(`DELETE FROM ${f.schema}.migrations WHERE version=2`);
  const original = (await f.admin.query(`SELECT checksum FROM ${f.schema}.migrations WHERE version=1`)).rows[0].checksum;
  assert.equal(original, createHash('sha256').update(migrationSql(f.schema)).digest('hex'));
  await Promise.all([f.a.initialize(), f.b.initialize()]);
  assert.equal((await f.serviceA.testBalance(principal.accountId)).credits, 2);
  assert.deepEqual((await f.admin.query(`SELECT version FROM ${f.schema}.migrations ORDER BY version`)).rows.map(row => row.version), [1, 2]);
  assert.equal((await f.admin.query(`SELECT checksum FROM ${f.schema}.migrations WHERE version=1`)).rows[0].checksum, original);
});

test('real PostgreSQL dashboard reads shared state, completion window boundaries and elapsed minutes without fake presence', async t => {
  const f = await fixture(t), end = new Date(Date.now() + 1000).toISOString();
  const range = { start: new Date(Date.parse(end) - 3600_000).toISOString(), end, timezone: 'America/Chicago' };
  const empty = await dashboardSnapshot(f.b, range);
  assert.equal(empty.completed, 0); assert.equal(empty.avgDuration, null); assert.equal(empty.connected, null); assert.equal(empty.sessions, null);
  f.advance(-30 * 60_000);
  const { sessionId, admitted } = await active(f);
  assert.equal((await f.b.readDashboard(range)).activeSessions, 1);
  f.advance(5 * 60_000);
  await f.serviceA.end(principal, sessionId, 'end');
  const completedAt = new Date(admitted.snapshot.startedAt! + 5 * 60_000).toISOString();
  await f.admin.query(`UPDATE ${f.schema}.outbox SET created_at=$1 WHERE payload->'snapshot'->>'lifecycle'='ended'`, [completedAt]);
  const measured = await dashboardSnapshot(f.b, range);
  assert.equal(measured.completed, 1); assert.equal(measured.avgDuration, 5); assert.equal(measured.diagnostics.activeSessions, 0);
  const exactEnd = await f.b.readDashboard({ ...range, end: completedAt }); assert.equal(exactEnd.completed, 0);
  const exactStart = await f.b.readDashboard({ ...range, start: completedAt }); assert.equal(exactStart.completed, 1);
  await f.serviceA.end(principal, sessionId, 'retry-end');
  assert.equal((await f.b.readDashboard(range)).completed, 1);
  const response = JSON.stringify(measured); assert.equal(response.includes(sessionId), false); assert.equal(response.includes(principal.accountId), false);
});

test('real PostgreSQL concurrent initialization, repeated admission and two-store account locking', async t => {
  const f = await fixture(t); assert.equal(await f.a.check(), true);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? f.serviceA : f.serviceB).start(principal, 'same-start', mode)));
  const sessionId = results[0].snapshot.sessionId;
  assert.ok(results.every(x => x.snapshot.sessionId === sessionId));
  assert.equal((await f.serviceB.testBalance(principal.accountId)).credits, 1);
  await assert.rejects(f.serviceB.start({ ...principal, clientId: 'second-device' }, 'other-start', mode), errorCode('session_conflict'));
  const ready = await f.serviceA.ready(principal, sessionId, readiness);
  const activations = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? f.serviceA : f.serviceB).confirm(principal, sessionId, 'same-confirm', ready.snapshot.sessionRevision, mode)));
  assert.ok(activations.every(x => x.snapshot.endsAt === activations[0].snapshot.endsAt));
  const ledger = await f.serviceB.testLedger(principal.accountId);
  assert.deepEqual(ledger.map(x => x.effect), ['reserved', 'consumed']);
  assert.equal((await f.admin.query(`SELECT COUNT(*) FROM ${f.schema}.migrations`)).rows[0].count, '2');
});
test('real PostgreSQL activation/cancel race has one accounting winner', async t => {
  const f = await fixture(t), start = await f.serviceA.start(principal, 'start', mode);
  const ready = await f.serviceA.ready(principal, start.snapshot.sessionId, readiness);
  const results = await Promise.all([
    f.serviceA.confirm(principal, start.snapshot.sessionId, 'confirm', ready.snapshot.sessionRevision, mode),
    f.serviceB.cancelPreparation(principal, start.snapshot.sessionId, 'cancel'),
  ]);
  const state = (await f.serviceB.snapshot(principal, start.snapshot.sessionId)).snapshot;
  assert.ok(state.lifecycle === 'active' || state.lifecycle === 'canceled');
  const effects = (await f.serviceA.testLedger(principal.accountId)).map(x => x.effect);
  assert.deepEqual(effects, state.lifecycle === 'active' ? ['reserved', 'consumed'] : ['reserved', 'released']);
  assert.ok(results.every(x => x.snapshot.accounting === state.accounting));
});
test('real PostgreSQL expiry is committed despite rejected late work and recovery preserves deadline', async t => {
  const f = await fixture(t), { sessionId, admitted } = await active(f);
  const authorized = await f.serviceA.commitUtterance(principal, sessionId, 'utterance', 'synthetic-utterance', 'Synthetic input');
  await f.serviceB.recover();
  const restored = (await f.serviceB.snapshot(principal, sessionId)).snapshot;
  assert.equal(restored.endsAt, admitted.snapshot.endsAt); assert.equal(restored.authorization, null);
  assert.ok(restored.generation > authorized.authorization!.generation);
  f.advance(45 * 60_000);
  await assert.rejects(f.serviceA.commitUtterance(principal, sessionId, 'late', 'late', 'Synthetic late input'), errorCode('not_active'));
  const stored = await f.admin.query(`SELECT snapshot FROM ${f.schema}.sessions WHERE session_id=$1`, [sessionId]);
  assert.equal(stored.rows[0].snapshot.lifecycle, 'ended');
  assert.equal((await f.serviceB.testBalance(principal.accountId)).credits, 1);
});
test('real PostgreSQL schema protects immutable ledger/command data and rejects partial writes', async t => {
  const f = await fixture(t), { sessionId } = await active(f);
  await assert.rejects(f.admin.query(`UPDATE ${f.schema}.ledger SET available_delta=available_delta`), /Immutable accounting/);
  await assert.rejects(f.admin.query(`DELETE FROM ${f.schema}.commands`), /Immutable accounting/);
  const eventsBefore = (await f.admin.query(`SELECT COUNT(*) FROM ${f.schema}.outbox`)).rows[0].count;
  await assert.rejects(f.a.transaction(state => {
    state.accounts.get(principal.accountId)!.credits = 999;
    const entry = state.ledger[0]; entry.availableDelta = 123;
  }, { accountId: principal.accountId }), /Ledger entry is immutable/);
  assert.equal((await f.serviceB.testBalance(principal.accountId)).credits, 1);
  assert.equal((await f.admin.query(`SELECT COUNT(*) FROM ${f.schema}.outbox`)).rows[0].count, eventsBefore);
  assert.equal((await f.serviceB.snapshot(principal, sessionId)).snapshot.lifecycle, 'active');
});
test('real PostgreSQL account scopes do not permit cross-account writes', async t => {
  const f = await fixture(t);
  await assert.rejects(f.a.transaction(state => { state.accounts.set('wrong-account', { allowed: true, credits: 99 }); }, { accountId: principal.accountId }), /Storage scope violation/);
  assert.equal((await f.admin.query(`SELECT COUNT(*) FROM ${f.schema}.accounts`)).rows[0].count, '1');
});
test('real PostgreSQL rejects private speech persistence and stores only transcript fingerprints', async t => {
  const f = await fixture(t), { sessionId } = await active(f), privateMarker = 'SYNTHETIC_PRIVATE_CONTENT_MARKER';
  const response = await f.serviceA.commitUtterance(principal, sessionId, 'input', 'utterance', privateMarker);
  await assert.rejects(f.serviceA.publishSpeech(sessionId, response.authorization!, 0, { id: 'media', text: privateMarker, durationMs: 1000, visemes: [], gestures: [] }), errorCode('content_storage_unconfigured'));
  const content = await f.admin.query(`SELECT row_to_json(c)::text AS value FROM ${f.schema}.commands c UNION ALL SELECT row_to_json(u)::text FROM ${f.schema}.utterances u UNION ALL SELECT payload::text FROM ${f.schema}.outbox`);
  assert.ok(content.rows.every(row => !row.value.includes(privateMarker)));
  assert.equal((await f.admin.query(`SELECT COUNT(*) FROM ${f.schema}.segments`)).rows[0].count, '0');
  assert.equal((await f.serviceB.snapshot(principal, sessionId)).snapshot.authorization!.responseId, response.authorization!.responseId);
});
test('real PostgreSQL outbox reclaims expired leases without duplicate claim ownership', async t => {
  const f = await fixture(t); await f.serviceA.start(principal, 'start', mode);
  const [one, two] = await Promise.all([f.a.claimOutbox(10, 10_000), f.b.claimOutbox(10, 10_000)]);
  assert.equal(one.length + two.length, 1);
  const claimed = one[0] ?? two[0];
  await f.admin.query(`UPDATE ${f.schema}.outbox SET claim_until=NOW()-INTERVAL '1 second' WHERE event_id=$1`, [claimed.event.eventId]);
  assert.equal(await f.a.acknowledgeOutbox(claimed.event.eventId, claimed.claimToken), false);
  const retry = (await f.b.claimOutbox(10, 10_000))[0]; assert.equal(retry.event.eventId, claimed.event.eventId);
  assert.notEqual(retry.claimToken, claimed.claimToken);
  assert.equal(await f.a.acknowledgeOutbox(claimed.event.eventId, claimed.claimToken), false);
  assert.equal(await f.b.acknowledgeOutbox(retry.event.eventId, retry.claimToken), true);
  assert.deepEqual(await f.a.claimOutbox(10, 10_000), []);
});
test('real PostgreSQL terminal state removes obsolete undelivered events without changing accounting', async t => {
  const f = await fixture(t), { sessionId } = await active(f);
  await f.serviceA.end(principal, sessionId, 'end');
  const events = await f.b.claimOutbox(10, 1000);
  assert.equal(events.length, 1); assert.equal(events[0].event.snapshot.lifecycle, 'ended');
  assert.deepEqual((await f.serviceB.testLedger(principal.accountId)).map(x => x.effect), ['reserved', 'consumed']);
});
test('committed PostgreSQL activation survives an actual worker SIGKILL and is not charged twice', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const child = fork(join(__dirname, 'postgres-child.js'), [], { env: { ...process.env, DATABASE_URL: connectionString, TEST_SCHEMA: f.schemaName }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const [raw] = await once(child, 'message', { signal: AbortSignal.timeout(10_000) });
  assert.equal(raw.error, undefined);
  const result = raw as Result, exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const actor = { accountId: 'synthetic-crash-account', clientId: 'synthetic-client', connectionId: 'synthetic-connection' };
  const state = (await f.serviceB.snapshot(actor, result.snapshot.sessionId)).snapshot;
  assert.equal(state.endsAt, result.snapshot.endsAt); assert.equal(state.startedAt, result.snapshot.startedAt);
  const retry = await f.serviceB.start(actor, 'synthetic-start', mode);
  assert.equal(retry.snapshot.sessionId, state.sessionId); assert.equal(retry.snapshot.accounting, 'consumed');
  assert.deepEqual((await f.serviceB.testLedger(actor.accountId)).map(x => x.effect), ['reserved', 'consumed']);
});

test('real PostgreSQL account locks permit unrelated accounts to progress independently', { timeout: 10_000 }, async t => {
  const f = await fixture(t), second = { ...principal, accountId: 'synthetic-independent-account' };
  await f.serviceA.seedTestAccount(second.accountId, 1);
  const blocker = await f.admin.connect();
  await blocker.query('BEGIN');
  await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`mindspace:${f.schemaName}:account:${principal.accountId}`]);
  const waiting = f.serviceA.start(principal, 'blocked-start', mode);
  try {
    const independent = await f.serviceB.start(second, 'independent-start', mode);
    assert.equal(independent.outcome, 'created');
  } finally { await blocker.query('ROLLBACK'); blocker.release(); }
  assert.equal((await waiting).outcome, 'created');
});
test('real PostgreSQL rejects asynchronous callbacks without partial account changes', async t => {
  const f = await fixture(t);
  await assert.rejects(f.a.transaction(async state => {
    state.accounts.get(principal.accountId)!.credits = 999;
  }, { accountId: principal.accountId }), /cannot wait on asynchronous work/);
  assert.equal((await f.serviceB.testBalance(principal.accountId)).credits, 2);
});


test('real PostgreSQL a claimed event loses publication authority after a newer state update', async t => {
  const f = await fixture(t), started = await f.serviceA.start(principal, 'start', mode);
  const claim = (await f.a.claimOutbox(10, 10_000))[0];
  assert.equal((await f.a.readClaimedEvent(claim.event.eventId, claim.claimToken))!.eventId, claim.event.eventId);
  await f.serviceB.ready(principal, started.snapshot.sessionId, readiness);
  assert.equal(await f.a.readClaimedEvent(claim.event.eventId, claim.claimToken), null);
  assert.equal(await f.a.acknowledgeOutbox(claim.event.eventId, claim.claimToken), false);
  assert.equal(await f.a.discardSupersededOutbox(claim.event.eventId, claim.claimToken), true);
  const next = (await f.b.claimOutbox(10, 10_000))[0];
  assert.ok(next.event.sequence > claim.event.sequence);
  await f.serviceA.revokeTestAccount(principal.accountId);
  assert.equal(await f.b.readClaimedEvent(next.event.eventId, next.claimToken), null);
  assert.equal(await f.b.acknowledgeOutbox(next.event.eventId, next.claimToken), false);
});


test('real PostgreSQL expiry maintenance releases abandoned preparation once across workers', async t => {
  const f = await fixture(t), start = await f.serviceA.start(principal, 'start', mode);
  f.advance(policy.reservationMs);
  await Promise.all([reconcileDueAccounts(f.serviceA, f.a, Date.now()+policy.reservationMs), reconcileDueAccounts(f.serviceB, f.b, Date.now()+policy.reservationMs)]);
  assert.equal((await f.serviceB.snapshot(principal, start.snapshot.sessionId)).snapshot.lifecycle, 'expired');
  assert.deepEqual((await f.serviceA.testLedger(principal.accountId)).map(x => x.effect), ['reserved', 'released']);
  assert.deepEqual(await f.a.dueAccounts(Date.now()+policy.reservationMs), []);
});
test('real PostgreSQL maintenance leaves live response authority intact', async t => {
  const f = await fixture(t), { sessionId } = await active(f);
  const authorized = await f.serviceA.commitUtterance(principal, sessionId, 'input', 'utterance', 'Synthetic input');
  await reconcileDueAccounts(f.serviceB, f.b);
  await f.serviceB.reconcileAccount(principal.accountId);
  assert.deepEqual((await f.serviceA.snapshot(principal, sessionId)).snapshot.authorization, authorized.authorization);
});
test('real PostgreSQL scheduled maintenance runs and shuts down without discarding state', { timeout: 5000 }, async t => {
  const f = await fixture(t), start = await f.serviceA.start(principal, 'start', mode);
  await f.admin.query(`UPDATE ${f.schema}.sessions SET snapshot=jsonb_set(snapshot,'{reservationExpiresAt}',to_jsonb((EXTRACT(EPOCH FROM NOW())*1000)::bigint-1)) WHERE session_id=$1`, [start.snapshot.sessionId]);
  f.advance(policy.reservationMs);
  const worker = startMaintenance(f.serviceB, f.b, 10); t.after(() => worker.stop());
  const began = Date.now();
  while ((await f.admin.query(`SELECT snapshot->>'lifecycle' AS lifecycle FROM ${f.schema}.sessions WHERE session_id=$1`, [start.snapshot.sessionId])).rows[0].lifecycle !== 'expired') {
    if (Date.now()-began>2000) throw new Error('Maintenance did not expire the fixture');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await worker.stop();
  assert.equal((await f.serviceA.testBalance(principal.accountId)).credits, 2);
});


test('real PostgreSQL a published event identity cannot be reused with changed snapshot content', async t => {
  const f = await fixture(t), { sessionId } = await active(f);
  const original = (await f.serviceA.snapshot(principal, sessionId, 0)).events;
  await assert.rejects(f.a.transaction(state => {
    state.sessions.get(sessionId)!.events[0].snapshot.controller.connectionId = 'synthetic-forged-history';
  }, { accountId: principal.accountId }), /Event payload is immutable/);
  assert.deepEqual((await f.serviceB.snapshot(principal, sessionId, 0)).events, original);
});
