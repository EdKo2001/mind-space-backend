/// <reference types="node" />
import { createHash, randomUUID } from 'node:crypto';
import { normalizeSpeech } from '../protocol/therapist';
import type { SpeechSegment } from '../protocol/therapist';
import { protocolVersion, SessionError } from './contracts';
import type { Authorization, DatabaseState, Principal, Readiness, Replay, Result, ResultCode,
  SessionEvent, SessionMode, SessionStore, Snapshot, StoredSession, TestPolicy } from './contracts';

function id(value: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new SessionError('invalid_input');
  return value;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
function fingerprint(value: unknown) { return createHash('sha256').update(canonical(value)).digest('hex'); }
function validateMode(mode: SessionMode) {
  if (!mode || !['text', 'voice'].includes(mode.input) || !['visible', 'hidden'].includes(mode.visual)) throw new SessionError('invalid_input');
}
function positive(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) throw new SessionError('invalid_input');
}

/** Framework-neutral local domain service. Ports are ready for future identity/database/endpoint adapters. */
export class SessionService {
  readonly policy: Readonly<TestPolicy>;
  constructor(private readonly store: SessionStore, policy: TestPolicy,
    private readonly clock: () => number = Date.now, private readonly newId: () => string = randomUUID) {
    if (policy.profile !== 'internal-test-v1' || policy.timing !== 'absolute-deadline') throw new SessionError('invalid_input');
    for (const value of [policy.reservationMs, policy.readinessMs, policy.maxActiveSessions, policy.maxEventsPerSession, policy.maxUtteranceChars]) positive(value);
    this.policy = Object.freeze({ ...policy });
  }
  private now() {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new SessionError('invalid_input');
    return value;
  }
  private async transaction<T>(operation: (state: DatabaseState, now: number) => T): Promise<T> {
    const result = await this.store.transaction(state => {
      const now = this.now();
      for (const session of state.sessions.values()) this.reconcile(state, session, now);
      const baseline = structuredClone(state);
      try { return { value: operation(state, now), error: null }; }
      catch (error) {
        if (!(error instanceof SessionError)) throw error;
        // Preserve expiry/revocation reconciliation while rolling back the rejected command.
        state.accounts = baseline.accounts; state.sessions = baseline.sessions; state.commands = baseline.commands; state.ledger = baseline.ledger;
        return { value: undefined, error: error.code };
      }
    });
    if (result.error) throw new SessionError(result.error);
    return result.value as T;
  }
  private principal(p: Principal) { id(p.accountId); id(p.clientId); id(p.connectionId); }
  private owned(state: DatabaseState, p: Principal, sessionId: string, now: number) {
    this.principal(p); id(sessionId);
    const session = state.sessions.get(sessionId);
    if (!session || session.accountId !== p.accountId) throw new SessionError('not_found');
    this.reconcile(state, session, now);
    return session;
  }
  private controller(session: StoredSession, p: Principal) {
    if (session.snapshot.controller.clientId !== p.clientId || session.snapshot.controller.connectionId !== p.connectionId) throw new SessionError('controller_conflict');
  }
  private event(session: StoredSession, type: SessionEvent['type'], extras: Partial<SessionEvent> = {}) {
    session.snapshot.sequence++;
    const event: SessionEvent = { ...extras, type, protocolVersion, eventId: this.newId(), sessionId: session.snapshot.sessionId,
      sequence: session.snapshot.sequence, snapshot: structuredClone(session.snapshot) };
    session.events.push(event);
    if (session.events.length > this.policy.maxEventsPerSession) session.events.shift();
  }
  private change(session: StoredSession, type: SessionEvent['type'] = 'session.changed') {
    session.snapshot.sessionRevision++;
    this.event(session, type);
  }
  private invalidate(session: StoredSession) {
    if (session.snapshot.authorization) { session.snapshot.generation++; session.snapshot.authorization = null; }
  }
  private terminate(state: DatabaseState, session: StoredSession, lifecycle: 'ended' | 'canceled' | 'expired') {
    const s = session.snapshot;
    if (s.lifecycle !== 'active' && s.lifecycle !== 'preparing') return;
    if (s.accounting === 'reserved') {
      const account = state.accounts.get(session.accountId);
      if (!account) throw new SessionError('no_access');
      account.credits++; this.ledger(state, session, 'released', 1); s.accounting = 'released';
    }
    this.invalidate(session); s.lifecycle = lifecycle; s.readyUntil = null;
    // Remove private media payloads from replay at terminal state. Accounting/IDs remain test metadata.
    session.events = []; session.segments.clear(); session.utterances.clear();
    this.change(session);
  }
  private reconcile(state: DatabaseState, session: StoredSession, now: number) {
    const s = session.snapshot;
    if (!state.accounts.get(session.accountId)?.allowed) this.terminate(state, session, s.lifecycle === 'preparing' ? 'canceled' : 'ended');
    else if (s.lifecycle === 'preparing' && now >= s.reservationExpiresAt) this.terminate(state, session, 'expired');
    else if (s.lifecycle === 'active' && s.endsAt !== null && now >= s.endsAt) this.terminate(state, session, 'ended');
  }
  private command(state: DatabaseState, p: Principal, operation: string, commandId: string, payload: unknown,
    session: StoredSession | null, apply: () => Result): Result {
    id(commandId);
    const key = JSON.stringify([p.accountId, p.clientId, operation, session?.snapshot.sessionId ?? null, commandId]);
    const hash = fingerprint(payload), previous = state.commands.get(key);
    if (previous) {
      if (previous.fingerprint !== hash) throw new SessionError('idempotency_conflict');
      const current = state.sessions.get(previous.sessionId)!;
      return { outcome: previous.outcome, snapshot: current.snapshot, authorization: previous.authorization };
    }
    const result = apply();
    state.commands.set(key, { fingerprint: hash, outcome: result.outcome, sessionId: result.snapshot.sessionId, authorization: result.authorization });
    return result;
  }
  private ledger(state: DatabaseState, session: StoredSession, effect: 'reserved' | 'consumed' | 'released', availableDelta: number) {
    state.ledger.push({ entryId: `${session.snapshot.sessionId}:${effect}`, accountId: session.accountId,
      sessionId: session.snapshot.sessionId, effect, availableDelta, recordedAt: this.now() });
  }
  async testLedger(accountId: string) {
    id(accountId);
    return this.transaction(state => state.ledger.filter(entry => entry.accountId === accountId));
  }
  private result(session: StoredSession, outcome: ResultCode, authorization?: Authorization): Result {
    return { outcome, snapshot: session.snapshot, ...(authorization ? { authorization } : {}) };
  }
  /** Explicit synthetic grant, not a purchase/refill endpoint. Refuses replacement of an existing account. */
  async seedTestAccount(accountId: string, credits: number) {
    id(accountId); if (!Number.isSafeInteger(credits) || credits < 0) throw new SessionError('invalid_input');
    return this.transaction(state => {
      if (state.accounts.has(accountId)) throw new SessionError('idempotency_conflict');
      state.accounts.set(accountId, { allowed: true, credits });
    });
  }
  async testBalance(accountId: string) {
    return this.transaction(state => {
      const account = state.accounts.get(id(accountId));
      if (!account) throw new SessionError('no_access');
      return account;
    });
  }
  async start(p: Principal, commandId: string, mode: SessionMode, kind: 'paid' | 'trial' = 'paid') {
    this.principal(p); validateMode(mode);
    if (!['paid', 'trial'].includes(kind)) throw new SessionError('invalid_input');
    return this.transaction((state, now) => {
      for (const session of state.sessions.values()) if (session.accountId === p.accountId) this.reconcile(state, session, now);
      if (!state.accounts.get(p.accountId)?.allowed) throw new SessionError('no_access');
      return this.command(state, p, 'start', commandId, { mode, kind }, null, () => {
        const active = [...state.sessions.values()].filter(s => s.accountId === p.accountId && ['active', 'preparing'].includes(s.snapshot.lifecycle));
        if (active.length >= this.policy.maxActiveSessions) throw new SessionError('session_conflict');
        const account = state.accounts.get(p.accountId)!;
        if (account.credits < 1) throw new SessionError('no_credit');
        account.credits--;
        const sessionId = this.newId();
        if (state.sessions.has(sessionId)) throw new SessionError('idempotency_conflict');
        const snapshot: Snapshot = { protocolVersion, sessionId, sessionRevision: 0, sequence: 0, lifecycle: 'preparing', mode: { ...mode },
          generation: 0, authorization: null, controller: { clientId: p.clientId, connectionId: p.connectionId },
          reservationExpiresAt: now + this.policy.reservationMs, readyUntil: null, startedAt: null, endsAt: null,
          accounting: 'reserved', profile: 'internal-test-v1' };
        const session: StoredSession = { accountId: p.accountId, snapshot, durationMs: (kind === 'paid' ? 45 : 10) * 60_000,
          events: [], utterances: new Map(), segments: new Map(), nextSegmentIndex: 0 };
        state.sessions.set(sessionId, session); this.ledger(state, session, 'reserved', -1); this.change(session);
        return this.result(session, 'created');
      });
    });
  }
  /** Readiness must come from the eventual trusted adapter; these flags are only observations. */
  async ready(p: Principal, sessionId: string, readiness: Readiness) {
    if (!readiness || [readiness.inputReady, readiness.outputReady, readiness.providerReady, readiness.avatarReady].some(v => typeof v !== 'boolean')) throw new SessionError('invalid_input');
    return this.transaction((state, now) => {
      const session = this.owned(state, p, sessionId, now); this.controller(session, p);
      if (session.snapshot.lifecycle !== 'preparing') return this.result(session, session.snapshot.lifecycle === 'active' ? 'already_active' : 'released');
      const valid = readiness.inputReady && readiness.outputReady && readiness.providerReady && (session.snapshot.mode.visual === 'hidden' || readiness.avatarReady);
      session.snapshot.readyUntil = valid ? Math.min(now + this.policy.readinessMs, session.snapshot.reservationExpiresAt) : null;
      this.change(session); return this.result(session, valid ? 'ready' : 'awaiting_readiness');
    });
  }
  async confirm(p: Principal, sessionId: string, commandId: string, revision: number, mode: SessionMode) {
    validateMode(mode); positive(revision);
    return this.transaction((state, now) => {
      const session = this.owned(state, p, sessionId, now); this.controller(session, p);
      return this.command(state, p, 'confirm', commandId, { revision, mode }, session, () => {
        const s = session.snapshot;
        if (s.lifecycle === 'active') return this.result(session, 'already_active');
        if (s.lifecycle !== 'preparing') return this.result(session, 'released');
        if (revision !== s.sessionRevision || canonical(mode) !== canonical(s.mode)) throw new SessionError('stale_ready');
        if (s.readyUntil === null || now >= s.readyUntil) throw new SessionError('not_ready');
        this.ledger(state, session, 'consumed', 0); s.accounting = 'consumed'; s.lifecycle = 'active'; s.startedAt = now; s.endsAt = now + session.durationMs; s.readyUntil = null;
        this.change(session); return this.result(session, 'activated');
      });
    });
  }
  async cancelPreparation(p: Principal, sessionId: string, commandId: string) {
    return this.transaction((state, now) => {
      const session = this.owned(state, p, sessionId, now); this.controller(session, p);
      return this.command(state, p, 'cancel-preparation', commandId, {}, session, () => {
        if (session.snapshot.lifecycle === 'active') return this.result(session, 'already_active');
        this.terminate(state, session, 'canceled'); return this.result(session, 'released');
      });
    });
  }
  async reconnect(p: Principal, sessionId: string, commandId: string, expectedConnectionId: string) {
    id(expectedConnectionId);
    return this.transaction((state, now) => {
      const session = this.owned(state, p, sessionId, now);
      if (session.snapshot.controller.clientId !== p.clientId) throw new SessionError('controller_conflict');
      return this.command(state, p, 'reconnect', commandId, { expectedConnectionId, connectionId: p.connectionId }, session, () => {
        if (session.snapshot.controller.connectionId !== expectedConnectionId) throw new SessionError('controller_conflict');
        session.snapshot.controller = { clientId: p.clientId, connectionId: p.connectionId };
        this.change(session); return this.result(session, 'rebound');
      });
    });
  }
  async snapshot(p: Principal, sessionId: string, afterSequence?: number): Promise<Replay> {
    if (afterSequence !== undefined && (!Number.isSafeInteger(afterSequence) || afterSequence < 0)) throw new SessionError('invalid_input');
    return this.transaction((state, now) => {
      const session = this.owned(state, p, sessionId, now); this.controller(session, p);
      const first = session.events[0]?.sequence ?? session.snapshot.sequence + 1;
      const requiresSnapshot = afterSequence === undefined || afterSequence > session.snapshot.sequence || afterSequence < first - 1;
      return { snapshot: session.snapshot, events: requiresSnapshot ? [] : session.events.filter(e => e.sequence > afterSequence!), requiresSnapshot };
    });
  }
  private active(session: StoredSession) {
    if (session.snapshot.lifecycle !== 'active') throw new SessionError('not_active');
  }
  async commitUtterance(p: Principal, sessionId: string, commandId: string, utteranceId: string, transcript: string) {
    id(utteranceId);
    if (typeof transcript !== 'string' || !transcript.trim() || transcript.length > this.policy.maxUtteranceChars) throw new SessionError('invalid_input');
    return this.transaction((state, now) => {
      const session = this.owned(state, p, sessionId, now); this.controller(session, p);
      return this.command(state, p, 'utterance', commandId, { utteranceId, transcript }, session, () => {
        this.active(session);
        const hash = fingerprint(transcript), previous = session.utterances.get(utteranceId);
        if (previous) {
          if (previous.fingerprint !== hash) throw new SessionError('idempotency_conflict');
          return this.result(session, 'duplicate', previous.authorization);
        }
        const authorization = { generation: ++session.snapshot.generation, responseId: this.newId(), utteranceId };
        session.snapshot.authorization = authorization; session.nextSegmentIndex = 0;
        // No raw transcript retained by this foundation. Future context storage needs a retention policy.
        session.utterances.set(utteranceId, { fingerprint: hash, authorization });
        this.change(session, 'response.authorized'); return this.result(session, 'authorized', authorization);
      });
    });
  }
  async cancelResponse(p: Principal, sessionId: string, commandId: string, target: Authorization) {
    this.validateAuthorization(target);
    return this.transaction((state, now) => {
      const session = this.owned(state, p, sessionId, now); this.controller(session, p);
      return this.command(state, p, 'cancel-response', commandId, target, session, () => {
        const current = session.snapshot.authorization;
        if (!current || canonical(current) !== canonical(target)) return this.result(session, 'not_current');
        this.invalidate(session); this.change(session, 'response.canceled'); return this.result(session, 'canceled');
      });
    });
  }
  private validateAuthorization(auth: Authorization) {
    if (!auth) throw new SessionError('invalid_input');
    positive(auth.generation); id(auth.responseId); id(auth.utteranceId);
  }
  /** Called by trusted media workers only; no model/client URLs are accepted as authority. */
  async publishSpeech(sessionId: string, target: Authorization, segmentIndex: number, rawSpeech: SpeechSegment) {
    id(sessionId); this.validateAuthorization(target);
    if (!Number.isSafeInteger(segmentIndex) || segmentIndex < 0) throw new SessionError('invalid_input');
    const speech = normalizeSpeech(rawSpeech);
    // media references remain internal asset IDs until an authenticated media adapter is connected.
    if (speech.audioUrl !== undefined || !speech.id.trim()) throw new SessionError('invalid_input');
    return this.transaction((state, now) => {
      const session = state.sessions.get(sessionId);
      if (!session) throw new SessionError('not_found');
      this.reconcile(state, session, now); this.active(session);
      if (canonical(target) !== canonical(session.snapshot.authorization)) throw new SessionError('stale_response');
      const hash = fingerprint({ speech, target, segmentIndex }), previous = session.segments.get(speech.id);
      if (previous) {
        if (previous.fingerprint !== hash) throw new SessionError('segment_conflict');
        return this.result(session, 'duplicate');
      }
      if (segmentIndex !== session.nextSegmentIndex) throw new SessionError('segment_order');
      session.segments.set(speech.id, { fingerprint: hash, generation: target.generation, segmentIndex });
      session.nextSegmentIndex++;
      this.event(session, 'speech.ready', { speech, segmentIndex, authorization: target });
      return this.result(session, 'published');
    });
  }
  async end(p: Principal, sessionId: string, commandId: string) {
    return this.transaction((state, now) => {
      const session = this.owned(state, p, sessionId, now); this.controller(session, p);
      return this.command(state, p, 'end', commandId, {}, session, () => {
        this.terminate(state, session, session.snapshot.lifecycle === 'preparing' ? 'canceled' : 'ended');
        return this.result(session, 'ended');
      });
    });
  }
  async revokeTestAccount(accountId: string) {
    id(accountId);
    return this.transaction((state, now) => {
      const account = state.accounts.get(accountId);
      if (!account) throw new SessionError('no_access');
      account.allowed = false;
      for (const session of state.sessions.values()) if (session.accountId === accountId) this.reconcile(state, session, now);
    });
  }
  async recover() {
    return this.transaction((state, now) => {
      for (const session of state.sessions.values()) {
        this.reconcile(state, session, now);
        // New coordinator cannot prove exclusive ownership of old provider work.
        if (session.snapshot.authorization) { this.invalidate(session); this.change(session, 'response.canceled'); }
      }
    });
  }
}
