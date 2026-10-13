import { setTimeout, clearTimeout } from 'node:timers';
import type { PostgresSessionStore } from './postgres-store';
import type { SessionWakeups } from '../transport/wakeups';

/** Publication is a database wakeup, not a claim that a client received or played anything. */
export async function drainMetadataOutbox(store: PostgresSessionStore, rounds = 8) {
  let published = 0, superseded = 0;
  for (let i = 0; i < rounds; i++) {
    const batch = await store.claimOutbox(32, 10_000);
    if (!batch.length) break;
    for (const claim of batch) {
      const result = await store.publishOutboxWakeup(claim.event.eventId, claim.claimToken);
      if (result === 'published') published++;
      if (result === 'superseded') superseded++;
    }
  }
  return { published, superseded };
}

/** LISTEN on a dedicated connection; reconnect and bounded durable draining are serial. */
export async function startDatabaseEvents(store: PostgresSessionStore, wakeups: SessionWakeups, intervalMs = 1000) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error('Invalid event interval');
  let listener = await store.listenWakeups(() => wakeups.wake());
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, active = Promise.resolve();
  function schedule() {
    if (stopped) return;
    timer = setTimeout(() => {
      active = (async () => {
        if (!listener.healthy()) {
          await listener.stop(); listener = await store.listenWakeups(() => wakeups.wake());
          wakeups.wake(); // Catch up after the committed LISTEN; notifications are not durable replay.
        }
        await drainMetadataOutbox(store);
      })().catch(() => { console.error('Session event publication unavailable; will retry'); }).finally(schedule);
    }, intervalMs);
    timer.unref();
  }
  wakeups.wake(); schedule();
  return { async stop() { stopped = true; if (timer) clearTimeout(timer); await active; await listener.stop(); } };
}
