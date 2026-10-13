import { setTimeout, clearTimeout } from 'node:timers';
import type { PostgresSessionStore } from './postgres-store';
import type { SessionService } from '../session/service';

export async function reconcileDueAccounts(service: SessionService, store: PostgresSessionStore, now = Date.now(), limit = 100) {
  const accounts = await store.dueAccounts(now, limit);
  for (const accountId of accounts) await service.reconcileAccount(accountId);
  return accounts.length;
}
/** Internal-profile metadata timer; provider/slow-job work never executes here. */
export function startMaintenance(service: SessionService, store: PostgresSessionStore, intervalMs = 1000) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error('Invalid maintenance interval');
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, active = Promise.resolve();
  function schedule() {
    if (stopped) return;
    timer = setTimeout(() => {
      active = reconcileDueAccounts(service, store).then(() => {}, () => {
        console.error('Session expiry maintenance unavailable; will retry');
      }).finally(schedule);
    }, intervalMs);
    timer.unref();
  }
  schedule();
  return { async stop() { stopped = true; if (timer) clearTimeout(timer); await active; } };
}
