import type { SpeechSegment } from '../protocol/therapist';

export const protocolVersion = 1 as const;
export type SessionMode = { input: 'text' | 'voice'; visual: 'visible' | 'hidden' };
/** Supplied by a future verified identity boundary, never decoded from an untrusted request body. */
export type Principal = { accountId: string; clientId: string; connectionId: string };
export type Lifecycle = 'preparing' | 'active' | 'ended' | 'canceled' | 'expired';
export type Authorization = { generation: number; responseId: string; utteranceId: string };
export type Snapshot = {
  protocolVersion: typeof protocolVersion; sessionId: string; sessionRevision: number; sequence: number;
  lifecycle: Lifecycle; mode: SessionMode; generation: number; authorization: Authorization | null;
  controller: { clientId: string; connectionId: string }; reservationExpiresAt: number;
  readyUntil: number | null; startedAt: number | null; endsAt: number | null;
  accounting: 'reserved' | 'consumed' | 'released'; profile: 'internal-test-v1';
};
export type SessionEvent = {
  protocolVersion: typeof protocolVersion; eventId: string; sessionId: string;
  sequence: number; snapshot: Snapshot;
  type: 'session.changed' | 'response.authorized' | 'response.canceled' | 'speech.ready';
  speech?: SpeechSegment; segmentIndex?: number; authorization?: Authorization;
};
export type ResultCode = 'created' | 'ready' | 'awaiting_readiness' | 'activated' | 'already_active' | 'released' | 'ended'
  | 'rebound' | 'authorized' | 'canceled' | 'not_current' | 'published' | 'duplicate';
export type Result = { outcome: ResultCode; snapshot: Snapshot; authorization?: Authorization };
export type ErrorCode = 'invalid_input' | 'not_found' | 'forbidden' | 'controller_conflict' | 'idempotency_conflict'
  | 'no_access' | 'no_credit' | 'session_conflict' | 'not_ready' | 'stale_ready' | 'not_active'
  | 'stale_response' | 'segment_conflict' | 'segment_order' | 'provider_unavailable' | 'capacity_unavailable';
export class SessionError extends Error {
  constructor(readonly code: ErrorCode) { super(code); this.name = 'SessionError'; }
}
export type TestPolicy = {
  profile: 'internal-test-v1'; reservationMs: number; readinessMs: number;
  maxActiveSessions: number; maxEventsPerSession: number; maxUtteranceChars: number;
  /** Explicit test-only absolute deadline; production disconnect/pause policy is undecided. */
  timing: 'absolute-deadline';
};
export type Account = { allowed: boolean; credits: number };
export type TestLedgerEntry = { entryId: string; accountId: string; sessionId: string;
  effect: 'reserved' | 'consumed' | 'released'; availableDelta: number; recordedAt: number };
export type StoredSession = {
  accountId: string; snapshot: Snapshot; durationMs: number; events: SessionEvent[];
  utterances: Map<string, { fingerprint: string; authorization: Authorization }>;
  segments: Map<string, { fingerprint: string; generation: number; segmentIndex: number }>;
  nextSegmentIndex: number;
};
export type CommandRecord = { fingerprint: string; outcome: ResultCode; sessionId: string; authorization?: Authorization };
export type DatabaseState = {
  accounts: Map<string, Account>; sessions: Map<string, StoredSession>; commands: Map<string, CommandRecord>; ledger: TestLedgerEntry[];
};
/** Callback must be synchronous: no provider/client/network waits inside a transaction. */
export interface SessionStore { transaction<T>(operation: (state: DatabaseState) => T): Promise<T> }
export type Readiness = { inputReady: boolean; outputReady: boolean; providerReady: boolean; avatarReady: boolean };
export type Replay = { snapshot: Snapshot; events: SessionEvent[]; requiresSnapshot: boolean };

export interface DialogueAdapter {
  generate(input: { sessionId: string; authorization: Authorization; text: string; signal: AbortSignal }): Promise<unknown>;
}
export interface SpeechAdapter {
  synthesize(input: { sessionId: string; authorization: Authorization; validatedText: string; signal: AbortSignal }): Promise<SpeechSegment>;
}
export const unavailableDialogue: DialogueAdapter = {
  async generate() { throw new SessionError('provider_unavailable'); },
};
export const unavailableSpeech: SpeechAdapter = {
  async synthesize() { throw new SessionError('provider_unavailable'); },
};
