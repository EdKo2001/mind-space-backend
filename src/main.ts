import { MemorySessionStore } from './session/memory-store';
import { SessionService } from './session/service';
import { createDatabaseProbe } from './database/connection';
import { createServer } from './transport/server';

async function main() {
  const port = Number(process.env.PORT ?? 3001);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const service = new SessionService(new MemorySessionStore(), {
    profile: 'internal-test-v1', timing: 'absolute-deadline', reservationMs: 10_000, readinessMs: 1000,
    maxActiveSessions: 1, maxEventsPerSession: 64, maxUtteranceChars: 2000,
  });
  // No accounts are seeded, identity/provider adapters are unavailable by default.
  const app = await createServer({ service, database: createDatabaseProbe(process.env.DATABASE_URL) });
  const address = await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
  console.log(`MindSpace internal backend listening at ${address}; connected services unavailable`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close().catch(() => { process.exitCode = 1; }); });
}
void main().catch(() => { console.error('Backend startup failed; check local configuration'); process.exitCode = 1; });
