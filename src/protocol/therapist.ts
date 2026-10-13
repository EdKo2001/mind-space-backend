// Generated from the MindSpace mobile contract. Run npm run sync:contract; do not edit.

export const emotionIds = ["neutral","listening","empathetic","warm_smile","concerned","thoughtful","encouraging","serious","happy","sad","surprised","curious","understanding","reassuring","confused","compassionate","optimistic","reflective","disappointed","calm"] as const;
export type Emotion = typeof emotionIds[number];
export const gestures = ['none', 'small_nod', 'double_nod', 'head_tilt_left', 'head_tilt_right', 'look_down', 'open_hand', 'explain', 'posture_shift'] as const;
export type Gesture = typeof gestures[number];
export type AvatarState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'interrupted';
export type AvatarEmotion = { type: Emotion; intensity: number; transitionMs: number; durationMs?: number };
export type VisemeCue = { viseme: string; startMs: number; endMs: number; intensity: number };
export type GestureCue = { type: Gesture; startMs: number; durationMs: number; intensity: number };
export type SpeechEmotionCue = { startMs: number; emotion: Omit<AvatarEmotion, 'durationMs'> };
export type SpeechPreferences = {
  targetWpm: number; speedRange: { min: number; max: number }; voiceStyle: string; emotion: Emotion;
  emotionIntensity: number; pauseProfile: 'natural'; allowInterruptions: boolean;
  breathing: 'none' | 'subtle'; prosodyVariation: number;
};
export type SpeechSegment = { id: string; text: string; audioUrl?: string; durationMs: number; visemes: readonly VisemeCue[]; gestures: readonly GestureCue[]; emotions?: readonly SpeechEmotionCue[]; speechPreferences?: SpeechPreferences };
export type TherapistResponse = { responseId: string; sessionId: string; avatarId: string; state: AvatarState; emotion: AvatarEmotion; speech?: SpeechSegment };
export type AudioChunk = { speechId: string; chunkId: string; audioUrl?: string; startMs: number; durationMs: number; final: boolean };
type Envelope<T extends string, P, R extends boolean = false> = {
  eventId: string; sessionId: string; sequence: number; timestamp: number; type: T; payload: P;
} & (R extends true ? { responseId: string } : { responseId?: never });
export type TherapistEvent =
  | Envelope<'session.started', { avatarId: string }>
  | Envelope<'user.speech_started', { utteranceId: string }>
  | Envelope<'user.speech_ended', { utteranceId: string; text: string }>
  | Envelope<'therapist.thinking', { avatarId: string }, true>
  | Envelope<'therapist.emotion', { emotion: AvatarEmotion }, true>
  | Envelope<'therapist.speech_started', { speech: SpeechSegment }, true>
  | Envelope<'therapist.audio_chunk', AudioChunk, true>
  | Envelope<'therapist.viseme_cue', { speechId: string; cue: VisemeCue }, true>
  | Envelope<'therapist.gesture', { speechId?: string; cue: GestureCue }, true>
  | Envelope<'therapist.speech_ended', { speechId: string }, true>
  | Envelope<'therapist.interrupted', { reason: string }, true>
  | Envelope<'session.ended', { reason: string }>;
export type MockScenario = {
  id: string; label: string; userText: string; text: string; emotion: Emotion | string; intensity: number;
  gesture: Gesture | string; durationMs: number; audioFile?: string; visemes: readonly VisemeCue[];
  gestures: readonly (Omit<GestureCue, 'type'> & { type: string })[];
  emotions?: readonly SpeechEmotionCue[];
  speechPreferences?: SpeechPreferences;
  responseDelayMs?: number;
};
export type SessionContext = { sessionId: string; avatarId: string; timestamp?: number };
export type ScheduledEvent = { offsetMs: number; event: TherapistEvent };

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected event object');
  return value as Record<string, unknown>;
}
export function text(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error(`Invalid ${field}`);
  return value;
}
export function number(value: unknown, field: string, minimum = 0, maximum = Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`Invalid ${field}`);
  return value;
}
export function clampIntensity(value: unknown) {
  return Math.min(1, Math.max(0, number(value, 'intensity', -Infinity)));
}
export function normalizeEmotion(value: unknown): AvatarEmotion {
  const data = record(value), id = text(data.type, 'emotion type');
  const result: AvatarEmotion = { type: emotionIds.includes(id as Emotion) ? id as Emotion : 'neutral',
    intensity: clampIntensity(data.intensity), transitionMs: Math.min(10_000, number(data.transitionMs, 'transition milliseconds')) };
  if (data.durationMs !== undefined) result.durationMs = number(data.durationMs, 'emotion duration milliseconds', 0, 120_000);
  return result;
}
export function normalizeViseme(value: unknown): VisemeCue {
  const data = record(value), startMs = number(data.startMs, 'viseme start milliseconds'), endMs = number(data.endMs, 'viseme end milliseconds');
  if (endMs <= startMs) throw new Error('Viseme end must follow start');
  return { viseme: text(data.viseme, 'viseme'), startMs, endMs, intensity: clampIntensity(data.intensity) };
}
export function normalizeGesture(value: unknown): GestureCue {
  const data = record(value), id = text(data.type, 'gesture type');
  return { type: gestures.includes(id as Gesture) ? id as Gesture : 'none', startMs: number(data.startMs, 'gesture start milliseconds'),
    durationMs: number(data.durationMs, 'gesture duration milliseconds', 1, 30_000), intensity: clampIntensity(data.intensity) };
}
/** Preferences express intent; only a provider adapter can report actual support. */
export function normalizeSpeechPreferences(value: unknown): SpeechPreferences {
  const data = record(value), range = record(data.speedRange);
  const min = number(range.min, 'minimum WPM', 80, 240), max = number(range.max, 'maximum WPM', min, 240);
  const emotion = normalizeEmotion({ type: data.emotion, intensity: data.emotionIntensity, transitionMs: 0 });
  if (typeof data.allowInterruptions !== 'boolean' || data.pauseProfile !== 'natural' || !['none', 'subtle'].includes(String(data.breathing))) throw new Error('Invalid speech preferences');
  return { targetWpm: number(data.targetWpm, 'target WPM', min, max), speedRange: { min, max },
    voiceStyle: text(data.voiceStyle, 'voice style'), emotion: emotion.type, emotionIntensity: emotion.intensity,
    pauseProfile: 'natural', allowInterruptions: data.allowInterruptions, breathing: data.breathing as SpeechPreferences['breathing'], prosodyVariation: clampIntensity(data.prosodyVariation) };
}
export function normalizeSpeech(value: unknown): SpeechSegment {
  const data = record(value);
  if (!Array.isArray(data.visemes) || !Array.isArray(data.gestures)) throw new Error('Speech cue arrays required');
  const speech: SpeechSegment = { id: text(data.id, 'speech id'), text: text(data.text, 'speech text', true),
    durationMs: number(data.durationMs, 'speech duration milliseconds', 1, 120_000), visemes: data.visemes.map(normalizeViseme), gestures: data.gestures.map(normalizeGesture) };
  if (data.audioUrl !== undefined) speech.audioUrl = text(data.audioUrl, 'audio reference');
  if (data.speechPreferences !== undefined) speech.speechPreferences = normalizeSpeechPreferences(data.speechPreferences);
  if (data.emotions !== undefined) {
    if (!Array.isArray(data.emotions) || data.emotions.length > 64) throw new Error('Invalid speech emotion track');
    let previous = -1;
    speech.emotions = data.emotions.map(value => {
      const cue = record(value), startMs = number(cue.startMs, 'emotion start milliseconds', 0, speech.durationMs - 1);
      const emotion = normalizeEmotion(cue.emotion);
      if (startMs <= previous || emotion.durationMs !== undefined) throw new Error('Emotion track needs ordered starts without local duration');
      previous = startMs;
      return { startMs, emotion };
    });
  }
  if (speech.visemes.some(cue => cue.endMs > speech.durationMs) || speech.gestures.some(cue => cue.startMs + cue.durationMs > speech.durationMs)) throw new Error('Speech cue exceeds duration');
  return speech;
}
/** Runtime validation for decoded WebSocket JSON as well as local fixtures. */
export function parseTherapistEvent(value: unknown): TherapistEvent {
  const data = record(value), type = text(data.type, 'event type'), payload = record(data.payload);
  const sequence = number(data.sequence, 'sequence');
  if (!Number.isSafeInteger(sequence)) throw new Error('Sequence must be a safe integer');
  const base = { eventId: text(data.eventId, 'event id'), sessionId: text(data.sessionId, 'session id'), sequence,
    timestamp: number(data.timestamp, 'timestamp milliseconds'), type };
  const response = type.startsWith('therapist.') ? { responseId: text(data.responseId, 'response id') } : {};
  let normalized: unknown;
  switch (type) {
    case 'session.started': normalized = { avatarId: text(payload.avatarId, 'avatar id') }; break;
    case 'user.speech_started': normalized = { utteranceId: text(payload.utteranceId, 'utterance id') }; break;
    case 'user.speech_ended': normalized = { utteranceId: text(payload.utteranceId, 'utterance id'), text: text(payload.text, 'user text', true) }; break;
    case 'therapist.thinking': normalized = { avatarId: text(payload.avatarId, 'avatar id') }; break;
    case 'therapist.emotion': normalized = { emotion: normalizeEmotion(payload.emotion) }; break;
    case 'therapist.speech_started': normalized = { speech: normalizeSpeech(payload.speech) }; break;
    case 'therapist.audio_chunk':
      if (typeof payload.final !== 'boolean') throw new Error('Audio final flag required');
      normalized = { speechId: text(payload.speechId, 'speech id'), chunkId: text(payload.chunkId, 'chunk id'),
        startMs: number(payload.startMs, 'chunk start milliseconds'), durationMs: number(payload.durationMs, 'chunk duration milliseconds', 1), final: payload.final,
        ...(payload.audioUrl === undefined ? {} : { audioUrl: text(payload.audioUrl, 'chunk audio reference') }) }; break;
    case 'therapist.viseme_cue': normalized = { speechId: text(payload.speechId, 'speech id'), cue: normalizeViseme(payload.cue) }; break;
    case 'therapist.gesture': normalized = { ...(payload.speechId === undefined ? {} : { speechId: text(payload.speechId, 'speech id') }), cue: normalizeGesture(payload.cue) }; break;
    case 'therapist.speech_ended': normalized = { speechId: text(payload.speechId, 'speech id') }; break;
    case 'therapist.interrupted': case 'session.ended': normalized = { reason: text(payload.reason, 'end reason') }; break;
    default: throw new Error(`Unsupported event: ${type}`);
  }
  return { ...base, ...response, payload: normalized } as TherapistEvent;
}
