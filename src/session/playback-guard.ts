import type { SpeechSegment } from '../protocol/therapist';
import { normalizeSpeech } from '../protocol/therapist';
import { protocolVersion, SessionError } from './contracts';
import { decodeEvent, decodeSnapshot } from './wire';
import type { Authorization, SessionEvent, Snapshot } from './contracts';

export type SuppressionState = { sessionId: string; targets: Authorization[] };
const same = (a: Authorization | null | undefined, b: Authorization | null | undefined) =>
  !!a && !!b && a.generation === b.generation && a.responseId === b.responseId && a.utteranceId === b.utteranceId;
const key = (a: Authorization) => `${a.generation}:${a.responseId}`;

/** Portable playback admission guard; no player, storage, network or animation controller. */
export class ClientPlaybackGuard {
  private snapshot: Snapshot | null = null;
  private suppressed = new Map<string, Authorization>();
  private accepted = new Map<string, string>();
  private nextIndex = 0;
  constructor(private readonly sessionId: string, private readonly clientId: string, private connectionId: string,
    recovered?: SuppressionState) {
    if (recovered) {
      if (recovered.sessionId !== sessionId) throw new SessionError('invalid_input');
      for (const target of recovered.targets) this.suppressed.set(key(target), { ...target });
    }
  }
  applySnapshot(snapshot: Snapshot): boolean {
    snapshot = decodeSnapshot(snapshot);
    if (snapshot.protocolVersion !== protocolVersion || snapshot.sessionId !== this.sessionId) throw new SessionError('invalid_input');
    if (![snapshot.sessionRevision, snapshot.sequence, snapshot.generation].every(x => Number.isSafeInteger(x) && x >= 0)) throw new SessionError('invalid_input');
    if (snapshot.authorization && snapshot.authorization.generation !== snapshot.generation) throw new SessionError('invalid_input');
    if (this.snapshot && (snapshot.sessionRevision < this.snapshot.sessionRevision || snapshot.sequence < this.snapshot.sequence
      || snapshot.generation < this.snapshot.generation)) return false;
    if (this.snapshot && !['preparing', 'active'].includes(this.snapshot.lifecycle) && snapshot.lifecycle !== this.snapshot.lifecycle) return false;
    if (!same(snapshot.authorization, this.snapshot?.authorization)) { this.accepted.clear(); this.nextIndex = 0; }
    this.snapshot = structuredClone(snapshot); return true;
  }
  rebindConnection(connectionId: string) { this.connectionId = connectionId; }
  stopLocally(): Authorization | null {
    const target = this.snapshot?.authorization;
    if (!target) return null;
    this.suppressed.set(key(target), { ...target });
    this.accepted.clear(); return { ...target };
  }
  /** Caller may persist only this minimal metadata after selecting a retention/recovery policy. */
  exportSuppression(): SuppressionState { return { sessionId: this.sessionId, targets: [...this.suppressed.values()].map(x => ({ ...x })) }; }
  canPlay(target: Authorization, now: number): boolean {
    const s = this.snapshot;
    return Number.isFinite(now) && !!s && s.lifecycle === 'active' && s.accounting === 'consumed'
      && s.startedAt !== null && s.endsAt !== null && now >= s.startedAt && now < s.endsAt
      && s.controller.clientId === this.clientId && s.controller.connectionId === this.connectionId
      && same(target, s.authorization) && !this.suppressed.has(key(target));
  }
  /** State replay alone never calls this method or instructs a player to resume. */
  acceptSpeech(event: SessionEvent, now: number): SpeechSegment | null {
    event = decodeEvent(event);
    if (event.protocolVersion !== protocolVersion || event.sessionId !== this.sessionId || event.type !== 'speech.ready'
      || !event.authorization || !event.speech || !this.canPlay(event.authorization, now)) return null;
    if (!this.snapshot || event.snapshot.sessionRevision > this.snapshot.sessionRevision || event.sequence > this.snapshot.sequence) return null;
    if (event.segmentIndex !== this.nextIndex) return null;
    const speech = normalizeSpeech(event.speech);
    const identity = `${event.authorization.generation}:${speech.id}`;
    const signature = JSON.stringify(speech), previous = this.accepted.get(identity);
    if (previous) {
      if (previous !== signature) throw new SessionError('segment_conflict');
      return null;
    }
    this.accepted.set(identity, signature); this.nextIndex++;
    return speech;
  }
}
