import { PostgresSessionStore } from '../database/postgres-store';
import { SessionService } from '../session/service';

async function main() {
  const store = PostgresSessionStore.connect(process.env.DATABASE_URL!, process.env.TEST_SCHEMA!);
  const service = new SessionService(store, { profile: 'internal-test-v1', timing: 'absolute-deadline', reservationMs: 60_000,
    readinessMs: 10_000, maxActiveSessions: 1, maxEventsPerSession: 8, maxUtteranceChars: 2000 });
  const principal = { accountId: 'synthetic-crash-account', clientId: 'synthetic-client', connectionId: 'synthetic-connection' };
  await service.seedTestAccount(principal.accountId, 1);
  const started = await service.start(principal, 'synthetic-start', { input: 'text', visual: 'hidden' });
  const ready = await service.ready(principal, started.snapshot.sessionId, { inputReady: true, outputReady: true, providerReady: true, avatarReady: false });
  const admitted = await service.confirm(principal, started.snapshot.sessionId, 'synthetic-confirm', ready.snapshot.sessionRevision, { input: 'text', visual: 'hidden' });
  process.send?.(admitted);
  // Parent deliberately SIGKILLs this synthetic worker after the committed activation is reported.
  await new Promise(() => {});
}
void main().catch(() => { process.exitCode = 1; process.send?.({ error: 'child_failure' }); });
