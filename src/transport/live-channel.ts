import { setTimeout, clearTimeout } from 'node:timers';
import type { WebSocket } from 'ws';
import type { Principal, Replay, Snapshot } from '../session/contracts';
import type { SessionService } from '../session/service';
import type { SessionWakeups } from './wakeups';

export type LiveOptions = { wakeups: SessionWakeups; pollIntervalMs?: number };
export function liveChannel(socket: WebSocket, options: LiveOptions, service: SessionService,
  verify: () => Promise<Principal>, enqueue: (work: () => Promise<void>) => Promise<void>,
  fail: (error: unknown) => void, send: (value: unknown) => boolean) {
  const interval = options.pollIntervalMs ?? 1000;
  let binding: { sessionId: string; sequence: number } | undefined;
  let stopped = false, queued = false, dirty = false, timer: ReturnType<typeof setTimeout> | undefined;
  function wake() {
    if (stopped || !binding || socket.readyState !== 1) return;
    if (queued) { dirty = true; return; }
    queued = true;
    void enqueue(async () => {
      dirty = false;
      if (stopped || !binding || socket.readyState !== 1) return;
      try {
        const principal = await verify(), current = binding;
        const replay = await service.snapshot(principal, current.sessionId, current.sequence);
        if (stopped || socket.readyState !== 1) return;
        if (replay.snapshot.sequence <= current.sequence && !replay.requiresSnapshot) return;
        // Old-generation/old-controller replay is state recovery, never playable live work.
        const currentEvents = replay.events.filter(event => event.snapshot.sessionRevision === replay.snapshot.sessionRevision);
        const needsSnapshot = replay.requiresSnapshot || currentEvents.length !== replay.events.length;
        const value: Replay = { snapshot: replay.snapshot, events: needsSnapshot ? [] : currentEvents, requiresSnapshot: needsSnapshot };
        if (send({ ok: true, profile: 'internal-test-v1', type: 'events', value })) binding.sequence = replay.snapshot.sequence;
      } catch (error) { fail(error); }
    }).finally(() => { queued = false; if (dirty) wake(); });
  }
  const unsubscribe = options.wakeups.subscribe(wake);
  function schedule() {
    if (stopped) return;
    timer = setTimeout(() => { wake(); schedule(); }, interval); timer.unref();
  }
  schedule();
  return {
    bind(snapshot: Snapshot) { binding = { sessionId: snapshot.sessionId, sequence: snapshot.sequence }; },
    stop() { stopped = true; unsubscribe(); if (timer) clearTimeout(timer); },
  };
}
