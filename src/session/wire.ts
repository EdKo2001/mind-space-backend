import { normalizeSpeech } from '../protocol/therapist';
import { SessionError, protocolVersion } from './contracts';
import type { Lifecycle, SessionEvent, Snapshot } from './contracts';
import { decodeAuthorization, decodeMode, fields, identifier, integer, object } from './commands';

function nullableTime(value: unknown) { return value === null ? null : integer(value); }
export function decodeSnapshot(raw: unknown): Snapshot {
  const data = object(raw);
  fields(data, ['protocolVersion', 'sessionId', 'sessionRevision', 'sequence', 'lifecycle', 'mode', 'generation', 'authorization',
    'controller', 'reservationExpiresAt', 'readyUntil', 'startedAt', 'endsAt', 'accounting', 'profile']);
  if (data.protocolVersion !== protocolVersion || data.profile !== 'internal-test-v1'
    || !['preparing', 'active', 'ended', 'canceled', 'expired'].includes(String(data.lifecycle))
    || !['reserved', 'consumed', 'released'].includes(String(data.accounting))) throw new SessionError('invalid_input');
  const controller = object(data.controller); fields(controller, ['clientId', 'connectionId']);
  const snapshot: Snapshot = {
    protocolVersion, profile: 'internal-test-v1', sessionId: identifier(data.sessionId), sessionRevision: integer(data.sessionRevision, 1),
    sequence: integer(data.sequence, 1), lifecycle: data.lifecycle as Lifecycle, mode: decodeMode(data.mode), generation: integer(data.generation),
    authorization: data.authorization === null ? null : decodeAuthorization(data.authorization),
    controller: { clientId: identifier(controller.clientId), connectionId: identifier(controller.connectionId) },
    reservationExpiresAt: integer(data.reservationExpiresAt), readyUntil: nullableTime(data.readyUntil),
    startedAt: nullableTime(data.startedAt), endsAt: nullableTime(data.endsAt), accounting: data.accounting as Snapshot['accounting'],
  };
  const s = snapshot;
  if (s.authorization && (s.lifecycle !== 'active' || s.authorization.generation !== s.generation)) throw new SessionError('invalid_input');
  if (s.lifecycle === 'preparing') {
    if (s.accounting !== 'reserved' || s.startedAt !== null || s.endsAt !== null || s.authorization !== null
      || (s.readyUntil !== null && s.readyUntil > s.reservationExpiresAt)) throw new SessionError('invalid_input');
  } else if (s.lifecycle === 'active' || s.lifecycle === 'ended') {
    if (s.accounting !== 'consumed' || s.startedAt === null || s.endsAt === null || s.endsAt <= s.startedAt || s.readyUntil !== null) throw new SessionError('invalid_input');
  } else if (s.accounting !== 'released' || s.startedAt !== null || s.endsAt !== null || s.readyUntil !== null) throw new SessionError('invalid_input');
  return snapshot;
}
export function decodeEvent(raw: unknown): SessionEvent {
  const data = object(raw);
  const media = data.type === 'speech.ready';
  fields(data, ['protocolVersion', 'eventId', 'sessionId', 'sequence', 'snapshot', 'type'], media ? ['speech', 'segmentIndex', 'authorization'] : []);
  if (data.protocolVersion !== protocolVersion || !['session.changed', 'response.authorized', 'response.canceled', 'speech.ready'].includes(String(data.type))) throw new SessionError('invalid_input');
  const snapshot = decodeSnapshot(data.snapshot), sequence = integer(data.sequence, 1), sessionId = identifier(data.sessionId);
  if (snapshot.sessionId !== sessionId || snapshot.sequence !== sequence) throw new SessionError('invalid_input');
  const event: SessionEvent = { protocolVersion, eventId: identifier(data.eventId), sessionId, sequence, snapshot, type: data.type as SessionEvent['type'] };
  if (media) {
    const authorization = decodeAuthorization(data.authorization);
    if (!snapshot.authorization || authorization.responseId !== snapshot.authorization.responseId || authorization.generation !== snapshot.generation
      || authorization.utteranceId !== snapshot.authorization.utteranceId) throw new SessionError('invalid_input');
    try { event.speech = normalizeSpeech(data.speech); } catch { throw new SessionError('invalid_input'); }
    if (event.speech.audioUrl !== undefined) throw new SessionError('invalid_input');
    event.authorization = authorization; event.segmentIndex = integer(data.segmentIndex);
  } else if (data.type === 'response.authorized' && !snapshot.authorization) throw new SessionError('invalid_input');
  else if (data.type === 'response.canceled' && snapshot.authorization !== null) throw new SessionError('invalid_input');
  return event;
}
