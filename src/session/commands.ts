import { SessionError, protocolVersion } from './contracts';
import type { Authorization, Principal, Replay, Result, SessionMode, StartReference } from './contracts';
import type { SessionService } from './service';

export type CommandLimits = { maxTranscriptChars: number };
type Base<T extends string> = { protocolVersion: 1; type: T; commandId: string };
type InSession<T extends string> = Base<T> & { sessionId: string };
export type SessionCommand =
  | Base<'session.start'> & { mode: SessionMode; kind: 'paid' | 'trial' }
  | Base<'session.lookup_start'> & { startCommandId: string }
  | InSession<'session.confirm'> & { revision: number; mode: SessionMode }
  | InSession<'session.cancel_preparation'>
  | InSession<'session.reconnect'> & { expectedConnectionId: string }
  | InSession<'session.snapshot'> & { afterSequence?: number }
  | InSession<'session.utterance'> & { utteranceId: string; transcript: string }
  | InSession<'response.cancel'> & { target: Authorization }
  | InSession<'session.end'>;

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SessionError('invalid_input');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new SessionError('invalid_input');
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some(property => !('value' in property))) throw new SessionError('invalid_input');
  return value as Record<string, unknown>;
}
export function fields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some(key => !allowed.has(key)) || required.some(key => !Object.hasOwn(value, key))) throw new SessionError('invalid_input');
}
export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new SessionError('invalid_input');
  return value;
}
export function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new SessionError('invalid_input');
  return value;
}
export function decodeMode(value: unknown): SessionMode {
  const mode = object(value); fields(mode, ['input', 'visual']);
  if ((mode.input !== 'text' && mode.input !== 'voice') || (mode.visual !== 'visible' && mode.visual !== 'hidden')) throw new SessionError('invalid_input');
  return { input: mode.input, visual: mode.visual };
}
export function decodeAuthorization(value: unknown): Authorization {
  const target = object(value); fields(target, ['generation', 'responseId', 'utteranceId']);
  return { generation: integer(target.generation, 1), responseId: identifier(target.responseId), utteranceId: identifier(target.utteranceId) };
}

/** Accepts a decoded JSON object. Identity, readiness and internal actions are deliberately excluded. */
export function decodeCommand(raw: unknown, limits: CommandLimits): SessionCommand {
  integer(limits.maxTranscriptChars, 1);
  const data = object(raw);
  if (data.protocolVersion !== protocolVersion) throw new SessionError('invalid_input');
  const commandId = identifier(data.commandId);
  const base = ['protocolVersion', 'type', 'commandId'];
  if (data.type === 'session.start') {
    fields(data, [...base, 'mode', 'kind']);
    if (data.kind !== 'paid' && data.kind !== 'trial') throw new SessionError('invalid_input');
    return { protocolVersion, type: data.type, commandId, mode: decodeMode(data.mode), kind: data.kind };
  }
  if (data.type === 'session.lookup_start') {
    fields(data, [...base, 'startCommandId']);
    return { protocolVersion, type: data.type, commandId, startCommandId: identifier(data.startCommandId) };
  }
  const sessionId = identifier(data.sessionId), required = [...base, 'sessionId'];
  const envelope = { protocolVersion, commandId, sessionId };
  switch (data.type) {
    case 'session.confirm':
      fields(data, [...required, 'revision', 'mode']);
      return { ...envelope, type: data.type, revision: integer(data.revision, 1), mode: decodeMode(data.mode) };
    case 'session.cancel_preparation': case 'session.end':
      fields(data, required); return { ...envelope, type: data.type };
    case 'session.reconnect':
      fields(data, [...required, 'expectedConnectionId']);
      return { ...envelope, type: data.type, expectedConnectionId: identifier(data.expectedConnectionId) };
    case 'session.snapshot':
      fields(data, required, ['afterSequence']);
      return { ...envelope, type: data.type, ...(Object.hasOwn(data, 'afterSequence') ? { afterSequence: integer(data.afterSequence) } : {}) };
    case 'session.utterance':
      fields(data, [...required, 'utteranceId', 'transcript']);
      if (typeof data.transcript !== 'string' || !data.transcript.trim() || data.transcript.length > limits.maxTranscriptChars) throw new SessionError('invalid_input');
      return { ...envelope, type: data.type, utteranceId: identifier(data.utteranceId), transcript: data.transcript };
    case 'response.cancel':
      fields(data, [...required, 'target']);
      return { ...envelope, type: data.type, target: decodeAuthorization(data.target) };
    default: throw new SessionError('invalid_input');
  }
}

type CommandValue = { type: 'result'; value: Result } | { type: 'snapshot'; value: Replay } | { type: 'start_reference'; value: StartReference };
export type CommandResponse = CommandValue & { commandId: string };
/** Correlation wraps only validated commands; the error boundary never reflects malformed input. */
export class CommandFailure extends Error {
  constructor(readonly commandId: string, readonly reason: unknown) { super('Command failed'); }
}
/** The principal must be verified by the future connection boundary; JSON cannot supply it. */
export async function dispatchCommand(service: SessionService, principal: Principal, raw: unknown): Promise<CommandResponse> {
  const command = decodeCommand(raw, { maxTranscriptChars: service.policy.maxUtteranceChars });
  try { return { ...await executeCommand(service, principal, command), commandId: command.commandId }; }
  catch (error) { throw new CommandFailure(command.commandId, error); }
}
async function executeCommand(service: SessionService, principal: Principal, command: SessionCommand): Promise<CommandValue> {
  switch (command.type) {
    case 'session.lookup_start': return { type: 'start_reference', value: await service.lookupStart(principal, command.startCommandId) };
    case 'session.start': return { type: 'result', value: await service.start(principal, command.commandId, command.mode, command.kind) };
    case 'session.confirm': return { type: 'result', value: await service.confirm(principal, command.sessionId, command.commandId, command.revision, command.mode) };
    case 'session.cancel_preparation': return { type: 'result', value: await service.cancelPreparation(principal, command.sessionId, command.commandId) };
    case 'session.reconnect': return { type: 'result', value: await service.reconnect(principal, command.sessionId, command.commandId, command.expectedConnectionId) };
    case 'session.snapshot': return { type: 'snapshot', value: await service.snapshot(principal, command.sessionId, command.afterSequence) };
    case 'session.utterance': return { type: 'result', value: await service.commitUtterance(principal, command.sessionId, command.commandId, command.utteranceId, command.transcript) };
    case 'response.cancel': return { type: 'result', value: await service.cancelResponse(principal, command.sessionId, command.commandId, command.target) };
    case 'session.end': return { type: 'result', value: await service.end(principal, command.sessionId, command.commandId) };
  }
}
