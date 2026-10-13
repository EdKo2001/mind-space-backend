import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Pool } from 'pg';
import type { PoolClient, Notification } from 'pg';
import { SessionError } from '../session/contracts';
import type { CommandRecord, DatabaseState, SessionEvent, SessionStore, StoredSession, TestLedgerEntry, TransactionScope } from '../session/contracts';
import { decodeSnapshot, decodeEvent } from '../session/wire';
import { migrations, migrationVersion } from './migrations';
import type { DatabaseProbe } from './connection';
import type { DashboardRange, DashboardReader, DashboardTotals } from '../dashboard/contracts';

export type ClaimedEvent = { event: SessionEvent; claimToken: string };
const empty = (): DatabaseState => ({ accounts: new Map(), sessions: new Map(), commands: new Map(), ledger: [] });
function safeNumber(value: unknown) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('Invalid persisted integer');
  return number;
}
/** Internal-profile metadata store. Private speech payloads are deliberately not persisted. */
export class PostgresSessionStore implements SessionStore, DatabaseProbe, DashboardReader {
  readonly schema: string;
  private readonly namespace: string;
  private readonly wakeupChannel: string;
  private readonly listeners = new Set<{ stop(): Promise<void> }>();
  private closing: Promise<void> | undefined;
  constructor(private readonly pool: Pool, schema = 'mindspace_backend') {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid schema name');
    this.schema = `"${schema}"`; this.namespace = `mindspace:${schema}`;
    this.wakeupChannel = `ms_events_${createHash('sha256').update(this.namespace).digest('hex').slice(0,24)}`;
  }
  static connect(connectionString: string, schema?: string) {
    const url = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Invalid PostgreSQL configuration');
    const pool = new Pool({ connectionString, max: 8, connectionTimeoutMillis: 2000, statement_timeout: 10_000, idleTimeoutMillis: 10_000 });
    pool.on('error', () => {});
    return new PostgresSessionStore(pool, schema);
  }
  private async globalLock(client: PoolClient, exclusive: boolean) {
    await client.query(`SELECT ${exclusive ? 'pg_advisory_xact_lock' : 'pg_advisory_xact_lock_shared'}(hashtextextended($1,0))`, [`${this.namespace}:global`]);
  }
  async initialize() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN'); await this.globalLock(client, true);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${this.schema}.migrations(version integer PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT NOW())`);
      const versions = await client.query(`SELECT version,checksum FROM ${this.schema}.migrations ORDER BY version`);
      if (versions.rows.some(row => row.version > migrationVersion)) throw new Error('Database schema is newer than this application');
      for (const { version, sql } of migrations(this.schema)) {
        const checksum = createHash('sha256').update(sql).digest('hex');
        const previous = versions.rows.find(row => row.version === version);
        if (previous && previous.checksum !== checksum) throw new Error('Applied migration checksum differs');
        if (!previous) {
          if (versions.rows.some(row => row.version > version)) throw new Error('Database migration history has a gap');
          await client.query(sql);
          await client.query(`INSERT INTO ${this.schema}.migrations(version,checksum) VALUES($1,$2)`, [version, checksum]);
        }
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async check() {
    try {
      const result = await this.pool.query(`SELECT version FROM ${this.schema}.migrations WHERE version=$1`, [migrationVersion]);
      return result.rowCount === 1;
    } catch { return false; }
  }
  close() {
    this.closing ??= (async () => { await Promise.allSettled([...this.listeners].map(listener => listener.stop())); await this.pool.end(); })();
    return this.closing;
  }
  async listenWakeups(wake: () => void) {
    const client = await this.pool.connect();
    const channel = this.wakeupChannel;
    let healthy = true, released = false;
    const onNotification = (notice: Notification) => { if (healthy && notice.channel === this.wakeupChannel) wake(); };
    function release() {
      healthy = false;
      if (!released) { released = true; client.removeListener('notification', onNotification); client.release(true); }
    }
    client.on('error', release); client.on('end', release); client.on('notification', onNotification);
    try { await client.query(`LISTEN ${this.wakeupChannel}`); }
    catch (error) { release(); throw error; }
    let stopping: Promise<void> | undefined;
    const listener = { healthy: () => healthy, stop: (): Promise<void> => {
      stopping ??= (async () => {
        try { if (healthy) await client.query(`UNLISTEN ${channel}`); }
        finally { release(); this.listeners.delete(listener); }
      })(); return stopping;
    } };
    this.listeners.add(listener); return listener;
  }
  /** Atomic claim/state verification + NOTIFY + outbox completion. Payload is deliberately empty. */
  async publishOutboxWakeup(eventId: string, claimToken: string): Promise<'published' | 'superseded' | 'not_current'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN'); await this.globalLock(client, false);
      const owner = await client.query(`SELECT s.account_id FROM ${this.schema}.outbox o JOIN ${this.schema}.sessions s USING(session_id) WHERE o.event_id=$1`, [eventId]);
      if (!owner.rows.length) { await client.query('COMMIT'); return 'not_current'; }
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${this.namespace}:account:${owner.rows[0].account_id}`]);
      const result = await client.query(`SELECT o.payload,s.snapshot,a.allowed,EXTRACT(EPOCH FROM clock_timestamp())*1000 AS now_ms
        FROM ${this.schema}.outbox o JOIN ${this.schema}.sessions s USING(session_id) JOIN ${this.schema}.accounts a ON a.account_id=s.account_id
        WHERE o.event_id=$1 AND o.claim_token=$2 AND o.claim_until>clock_timestamp() AND o.delivered_at IS NULL FOR UPDATE OF o`, [eventId, claimToken]);
      const row = result.rows[0];
      if (!row) { await client.query('COMMIT'); return 'not_current'; }
      const event = decodeEvent(row.payload), snapshot = decodeSnapshot(row.snapshot), now = Number(row.now_ms);
      const superseded = event.snapshot.sessionRevision !== snapshot.sessionRevision;
      if (!superseded && ((snapshot.lifecycle === 'active' && (!row.allowed || snapshot.endsAt! <= now))
        || (snapshot.lifecycle === 'preparing' && (!row.allowed || snapshot.reservationExpiresAt <= now)))) {
        await client.query('COMMIT'); return 'not_current';
      }
      await client.query(`UPDATE ${this.schema}.outbox SET delivered_at=clock_timestamp(),claim_token=NULL,claim_until=NULL,completion=$2 WHERE event_id=$1`, [eventId, superseded ? 'superseded' : 'published']);
      if (!superseded) await client.query('SELECT pg_notify($1,$2)', [this.wakeupChannel, '']);
      await client.query('COMMIT'); return superseded ? 'superseded' : 'published';
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  /** One SQL snapshot. Completion time is the first committed terminal outbox observation, not audio delivery. */
  async readDashboard(range: DashboardRange): Promise<DashboardTotals> {
    const result = await this.pool.query(`WITH terminal AS (
      SELECT DISTINCT ON(session_id) session_id,created_at,payload->'snapshot' AS snapshot FROM ${this.schema}.outbox
      WHERE payload->'snapshot'->>'lifecycle'='ended' AND payload->'snapshot'->>'accounting'='consumed'
      ORDER BY session_id,created_at
    ), completed AS (
      SELECT * FROM terminal WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
    ), current AS (
      SELECT s.snapshot FROM ${this.schema}.sessions s JOIN ${this.schema}.accounts a USING(account_id) WHERE a.allowed
    ) SELECT statement_timestamp() AS captured_at,
      (SELECT COUNT(*) FROM completed) AS completed,
      (SELECT AVG((LEAST(EXTRACT(EPOCH FROM created_at)*1000,(snapshot->>'endsAt')::bigint)-(snapshot->>'startedAt')::bigint)/60000.0)
       FROM completed WHERE snapshot->>'startedAt' IS NOT NULL AND snapshot->>'endsAt' IS NOT NULL
       AND LEAST(EXTRACT(EPOCH FROM created_at)*1000,(snapshot->>'endsAt')::bigint) >= (snapshot->>'startedAt')::bigint) AS avg_duration,
      (SELECT COUNT(*) FROM current WHERE snapshot->>'lifecycle'='active' AND (snapshot->>'endsAt')::bigint > EXTRACT(EPOCH FROM statement_timestamp())*1000) AS active,
      (SELECT COUNT(*) FROM current WHERE snapshot->>'lifecycle'='preparing' AND (snapshot->>'reservationExpiresAt')::bigint > EXTRACT(EPOCH FROM statement_timestamp())*1000) AS preparing,
      (SELECT COUNT(*) FROM current WHERE (snapshot->>'lifecycle'='active' AND (snapshot->>'endsAt')::bigint <= EXTRACT(EPOCH FROM statement_timestamp())*1000)
        OR (snapshot->>'lifecycle'='preparing' AND (snapshot->>'reservationExpiresAt')::bigint <= EXTRACT(EPOCH FROM statement_timestamp())*1000)) AS overdue`, [range.start, range.end]);
    const row = result.rows[0], avgDuration = row.avg_duration === null ? null : Number(row.avg_duration);
    if (avgDuration !== null && (!Number.isFinite(avgDuration) || avgDuration < 0)) throw new Error('Invalid dashboard duration');
    return { capturedAt: row.captured_at.toISOString(), completed: safeNumber(row.completed), avgDuration,
      activeSessions: safeNumber(row.active), preparingSessions: safeNumber(row.preparing), overdueSessions: safeNumber(row.overdue) };
  }
  async transaction<T>(operation: (state: DatabaseState) => T, scope: TransactionScope = { all: true }): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN'); await this.globalLock(client, 'all' in scope);
      let accountId: string | undefined;
      if ('accountId' in scope) accountId = scope.accountId;
      else if ('sessionId' in scope) {
        const owner = await client.query(`SELECT account_id FROM ${this.schema}.sessions WHERE session_id=$1`, [scope.sessionId]);
        accountId = owner.rows[0]?.account_id;
        if (!accountId) throw new SessionError('not_found');
      }
      if (accountId !== undefined) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${this.namespace}:account:${accountId}`]);
      const before = await this.load(client, accountId), state = structuredClone(before);
      const result = operation(state);
      if (result instanceof Promise) throw new Error('Session transactions cannot wait on asynchronous work');
      const detached = structuredClone(result);
      await this.persist(client, before, state, accountId);
      await client.query('COMMIT'); return detached;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  private async load(client: PoolClient, accountId?: string): Promise<DatabaseState> {
    const state = empty(), filter = accountId === undefined ? '' : ' WHERE account_id=$1', values = accountId === undefined ? [] : [accountId];
    const accounts = await client.query(`SELECT account_id,allowed,available_credits FROM ${this.schema}.accounts${filter}`, values);
    for (const row of accounts.rows) state.accounts.set(row.account_id, { allowed: row.allowed, credits: safeNumber(row.available_credits) });
    const sessions = await client.query(`SELECT * FROM ${this.schema}.sessions${filter}`, values);
    for (const row of sessions.rows) state.sessions.set(row.session_id, { accountId: row.account_id, snapshot: decodeSnapshot(row.snapshot),
      durationMs: safeNumber(row.duration_ms), nextSegmentIndex: safeNumber(row.next_segment_index), events: [], utterances: new Map(), segments: new Map() });
    const commands = await client.query(`SELECT command_key,record FROM ${this.schema}.commands${filter}`, values);
    for (const row of commands.rows) state.commands.set(row.command_key, row.record as CommandRecord);
    const ledger = await client.query(`SELECT * FROM ${this.schema}.ledger${filter} ORDER BY ledger_offset`, values);
    state.ledger = ledger.rows.map(row => ({ entryId: row.entry_id, accountId: row.account_id, sessionId: row.session_id,
      effect: row.effect, availableDelta: safeNumber(row.available_delta), recordedAt: safeNumber(row.recorded_at) } as TestLedgerEntry));
    const sessionIds = [...state.sessions.keys()];
    if (sessionIds.length) {
      const events = await client.query(`SELECT session_id,payload FROM ${this.schema}.events WHERE session_id=ANY($1::text[]) ORDER BY sequence`, [sessionIds]);
      for (const row of events.rows) state.sessions.get(row.session_id)!.events.push(decodeEvent(row.payload));
      const utterances = await client.query(`SELECT * FROM ${this.schema}.utterances WHERE session_id=ANY($1::text[])`, [sessionIds]);
      for (const row of utterances.rows) state.sessions.get(row.session_id)!.utterances.set(row.utterance_id, { fingerprint: row.fingerprint, authorization: row.response_authorization });
      const segments = await client.query(`SELECT * FROM ${this.schema}.segments WHERE session_id=ANY($1::text[])`, [sessionIds]);
      for (const row of segments.rows) state.sessions.get(row.session_id)!.segments.set(row.segment_id, row.metadata);
    }
    return state;
  }
  private async persist(client: PoolClient, before: DatabaseState, state: DatabaseState, accountId?: string) {
    for (const [key, account] of state.accounts) {
      if (accountId !== undefined && key !== accountId) throw new Error('Storage scope violation');
      if (!isDeepStrictEqual(account, before.accounts.get(key))) await client.query(
        `INSERT INTO ${this.schema}.accounts(account_id,allowed,available_credits) VALUES($1,$2,$3) ON CONFLICT(account_id) DO UPDATE SET allowed=EXCLUDED.allowed,available_credits=EXCLUDED.available_credits`,
        [key, account.allowed, account.credits]);
    }
    for (const key of before.accounts.keys()) if (!state.accounts.has(key)) throw new Error('Account deletion is not implemented');
    for (const [key, session] of state.sessions) {
      if (accountId !== undefined && session.accountId !== accountId) throw new Error('Storage scope violation');
      const previous = before.sessions.get(key);
      if (previous && previous.accountId !== session.accountId) throw new Error('Session owner is immutable');
      if (session.snapshot.sessionId !== key) throw new Error('Session identity is immutable');
      decodeSnapshot(session.snapshot);
      if (session.events.some(event => event.type === 'speech.ready' || event.speech)) throw new SessionError('content_storage_unconfigured');
      if (!previous || !isDeepStrictEqual([session.snapshot, session.durationMs, session.nextSegmentIndex], [previous.snapshot, previous.durationMs, previous.nextSegmentIndex])) {
        await client.query(`INSERT INTO ${this.schema}.sessions(session_id,account_id,snapshot,duration_ms,next_segment_index) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(session_id) DO UPDATE SET snapshot=EXCLUDED.snapshot,duration_ms=EXCLUDED.duration_ms,next_segment_index=EXCLUDED.next_segment_index`,
          [key, session.accountId, session.snapshot, session.durationMs, session.nextSegmentIndex]);
      }
      await this.persistChildren(client, session, previous);
    }
    for (const key of before.sessions.keys()) if (!state.sessions.has(key)) throw new Error('Session deletion is not implemented');
    for (const [key, record] of before.commands) if (!isDeepStrictEqual(record, state.commands.get(key))) throw new Error('Command outcome is immutable');
    for (const [key, record] of state.commands) if (!before.commands.has(key)) {
      const owner = state.sessions.get(record.sessionId)?.accountId;
      if (!owner) throw new Error('Command session missing');
      await client.query(`INSERT INTO ${this.schema}.commands(command_key,account_id,session_id,record) VALUES($1,$2,$3,$4)`, [key, owner, record.sessionId, record]);
    }
    const priorLedger = new Map(before.ledger.map(entry => [entry.entryId, entry]));
    const finalLedger = new Map(state.ledger.map(entry => [entry.entryId, entry]));
    if (finalLedger.size !== state.ledger.length) throw new Error('Duplicate ledger identity');
    for (const [key, entry] of priorLedger) if (!isDeepStrictEqual(entry, finalLedger.get(key))) throw new Error('Ledger entry is immutable');
    for (const entry of state.ledger) if (!priorLedger.has(entry.entryId)) await client.query(
      `INSERT INTO ${this.schema}.ledger(entry_id,account_id,session_id,effect,available_delta,recorded_at) VALUES($1,$2,$3,$4,$5,$6)`,
      [entry.entryId, entry.accountId, entry.sessionId, entry.effect, entry.availableDelta, entry.recordedAt]);
  }
  private async persistChildren(client: PoolClient, session: StoredSession, previous?: StoredSession) {
    const sessionId = session.snapshot.sessionId;
    const oldEvents = new Map(previous?.events.map(event => [event.eventId, event]) ?? []);
    const ids = session.events.map(event => event.eventId);
    await client.query(`DELETE FROM ${this.schema}.events WHERE session_id=$1 AND NOT(event_id=ANY($2::text[]))`, [sessionId, ids]);
    for (const event of session.events) {
      if (oldEvents.has(event.eventId)) {
        if (!isDeepStrictEqual(event, oldEvents.get(event.eventId))) throw new Error('Event payload is immutable');
        continue;
      }
      decodeEvent(event);
      await client.query(`INSERT INTO ${this.schema}.events(event_id,session_id,sequence,payload) VALUES($1,$2,$3,$4)`, [event.eventId, sessionId, event.sequence, event]);
      await client.query(`INSERT INTO ${this.schema}.outbox(event_id,session_id,sequence,payload) VALUES($1,$2,$3,$4)`, [event.eventId, sessionId, event.sequence, event]);
    }
    // Terminal/revoked state replaces any undelivered obsolete state notices.
    if (!['preparing', 'active'].includes(session.snapshot.lifecycle)) await client.query(
      `DELETE FROM ${this.schema}.outbox WHERE session_id=$1 AND sequence<$2 AND delivered_at IS NULL`, [sessionId, session.snapshot.sequence]);
    for (const [table, records, beforeRecords] of [
      ['utterances', session.utterances, previous?.utterances], ['segments', session.segments, previous?.segments],
    ] as const) {
      const keys = [...records.keys()], keyColumn = table === 'utterances' ? 'utterance_id' : 'segment_id';
      await client.query(`DELETE FROM ${this.schema}.${table} WHERE session_id=$1 AND NOT(${keyColumn}=ANY($2::text[]))`, [sessionId, keys]);
      for (const [key, metadata] of records) {
        if (beforeRecords?.has(key)) {
          if (!isDeepStrictEqual(metadata, beforeRecords.get(key))) throw new Error('Input/media identity is immutable');
          continue;
        }
        if (table === 'utterances') {
          const entry = metadata as StoredSession['utterances'] extends Map<string, infer Value> ? Value : never;
          await client.query(`INSERT INTO ${this.schema}.utterances(session_id,utterance_id,fingerprint,response_authorization) VALUES($1,$2,$3,$4)`, [sessionId, key, entry.fingerprint, entry.authorization]);
        } else await client.query(`INSERT INTO ${this.schema}.segments(session_id,segment_id,metadata) VALUES($1,$2,$3)`, [sessionId, key, metadata]);
      }
    }
  }
  async dueAccounts(now: number, limit = 100): Promise<string[]> {
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid expiry scan');
    const result = await this.pool.query(`SELECT DISTINCT account_id FROM ${this.schema}.sessions
      WHERE (snapshot->>'lifecycle'='preparing' AND (snapshot->>'reservationExpiresAt')::bigint<=$1)
      OR (snapshot->>'lifecycle'='active' AND (snapshot->>'endsAt')::bigint<=$1) ORDER BY account_id LIMIT $2`, [now, limit]);
    return result.rows.map(row => row.account_id);
  }
  async claimOutbox(limit: number, leaseMs: number): Promise<ClaimedEvent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new Error('Invalid outbox claim');
    const token = randomUUID();
    const result = await this.pool.query(`WITH candidates AS (
      SELECT o.event_id FROM ${this.schema}.outbox o
      WHERE o.delivered_at IS NULL AND (o.claim_until IS NULL OR o.claim_until<=NOW())
      AND NOT EXISTS (SELECT 1 FROM ${this.schema}.outbox prior WHERE prior.session_id=o.session_id AND prior.sequence<o.sequence AND prior.delivered_at IS NULL)
      ORDER BY o.created_at,o.sequence LIMIT $1 FOR UPDATE OF o SKIP LOCKED
    ) UPDATE ${this.schema}.outbox o SET claim_token=$2,claim_until=NOW()+$3*INTERVAL '1 millisecond'
      FROM candidates c WHERE o.event_id=c.event_id RETURNING o.payload`, [limit, token, leaseMs]);
    return result.rows.map(row => ({ event: decodeEvent(row.payload), claimToken: token }));
  }
  /** Revalidate state immediately before any external publication; claiming does not grant permanent authority. */
  async readClaimedEvent(eventId: string, claimToken: string): Promise<SessionEvent | null> {
    const result = await this.pool.query(`SELECT o.payload,s.snapshot,a.allowed FROM ${this.schema}.outbox o
      JOIN ${this.schema}.sessions s ON s.session_id=o.session_id JOIN ${this.schema}.accounts a ON a.account_id=s.account_id
      WHERE o.event_id=$1 AND o.claim_token=$2 AND o.claim_until>NOW() AND o.delivered_at IS NULL`, [eventId, claimToken]);
    const row = result.rows[0];
    if (!row) return null;
    const event = decodeEvent(row.payload), snapshot = decodeSnapshot(row.snapshot);
    if (event.snapshot.sessionRevision !== snapshot.sessionRevision) return null;
    if (snapshot.lifecycle === 'preparing' && (!row.allowed || snapshot.reservationExpiresAt <= Date.now())) return null;
    if (snapshot.lifecycle === 'active' && (!row.allowed || snapshot.endsAt! <= Date.now())) return null;
    return event;
  }
  async acknowledgeOutbox(eventId: string, claimToken: string) {
    const result = await this.pool.query(`UPDATE ${this.schema}.outbox o SET delivered_at=NOW(),claim_token=NULL,claim_until=NULL,completion='published'
      FROM ${this.schema}.sessions s WHERE o.session_id=s.session_id
      AND o.event_id=$1 AND o.claim_token=$2 AND o.claim_until>NOW() AND o.delivered_at IS NULL
      AND o.payload->'snapshot'->>'sessionRevision'=s.snapshot->>'sessionRevision'`, [eventId, claimToken]);
    return result.rowCount === 1;
  }
  async discardSupersededOutbox(eventId: string, claimToken: string) {
    const result = await this.pool.query(`UPDATE ${this.schema}.outbox o SET delivered_at=NOW(),claim_token=NULL,claim_until=NULL,completion='superseded'
      FROM ${this.schema}.sessions s WHERE o.session_id=s.session_id
      AND o.event_id=$1 AND o.claim_token=$2 AND o.claim_until>NOW() AND o.delivered_at IS NULL
      AND o.payload->'snapshot'->>'sessionRevision'<>s.snapshot->>'sessionRevision'`, [eventId, claimToken]);
    return result.rowCount === 1;
  }
}
