import { MemorySessionStore } from './session/memory-store';
import { SessionService } from './session/service';
import { startMaintenance } from './database/maintenance';
import { startDatabaseEvents } from './database/events';
import { SessionWakeups } from './transport/wakeups';
import { PostgresSessionStore } from './database/postgres-store';
import { createDatabaseProbe } from './database/connection';
import { createServer } from './transport/server';

async function main() {
  const port = Number(process.env.PORT ?? 3001);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const storage = process.env.DATABASE_URL ? PostgresSessionStore.connect(process.env.DATABASE_URL) : undefined;
  if (storage) {
    try { await storage.initialize(); } catch (error) { await storage.close(); throw error; }
  }
  const service = new SessionService(storage ?? new MemorySessionStore(), {
    profile: 'internal-test-v1', timing: 'absolute-deadline', reservationMs: 10_000, readinessMs: 1000,
    maxActiveSessions: 1, maxEventsPerSession: 64, maxUtteranceChars: 2000,
  });
  // No accounts are seeded, identity/provider adapters are unavailable by default.
  const localDashboard = process.env.DASHBOARD_LOCAL_AGGREGATES;
  if (localDashboard && localDashboard !== '1') { await storage?.close(); throw new Error('Invalid dashboard mode'); }
  const database = createDatabaseProbe(process.env.DATABASE_URL);
  const wakeups = new SessionWakeups();
  const app = await createServer({ service, database, storage,
    live: storage ? { wakeups } : undefined,
    dashboard: localDashboard === '1' && storage ? { reader: storage, localAggregates: true,
      allowedOrigins: (process.env.DASHBOARD_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean) } : undefined,
  }).catch(async error => { await database.close(); await storage?.close(); throw error; });
  let maintenance: ReturnType<typeof startMaintenance> | undefined;
  let events: Awaited<ReturnType<typeof startDatabaseEvents>> | undefined;
  app.addHook('preClose', async () => { await maintenance?.stop(); await events?.stop(); });
  let address: string;
  try {
    events = storage ? await startDatabaseEvents(storage, wakeups) : undefined;
    address = await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
  } catch (error) { await app.close(); throw error; }
  maintenance = storage ? startMaintenance(service, storage) : undefined;
  console.log(`MindSpace internal backend listening at ${address}; connected services unavailable`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close().catch(() => { process.exitCode = 1; }); });
}
void main().catch(() => { console.error('Backend startup failed; check local configuration'); process.exitCode = 1; });
