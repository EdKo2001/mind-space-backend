# Backend and dashboard data evidence

October13,2026.

- Current local check,47 unit/transport tests and smoke PASS.
- Current Docker build: check +47 tests + real localhost smoke PASS.
- 18 real PostgreSQL integration tests PASS, no skips. Includes actual child-process SIGKILL and durable activation/accounting retry, concurrency/isolation, expiry, private-content rejection, outbox reclaim/stale guards, migration continuity and dashboard aggregation boundaries/units.
- Compose runtime: API and PostgreSQL containers healthy. Node24.21.0/PostgreSQL18.6.
- `dashboard-smoke.json`: real dashboard HTTP200 accepted by the separate frontend's actual adapter, exact UTC range echo, allowed local origin/no-store; malformed query400 and denied origin403. Durable store is available; readiness503 correctly reports missing identity/dialogue/speech. Current runtime data has0 seeded accounts; migrations1+2 are applied; disposable test schemas were removed.
- `container-smoke.json` is historical foundation evidence: health200, ready503 with PostgreSQL reachable but durable store then unavailable, unauthenticated command401 and WebSocket upgrade401. The newer dashboard evidence supersedes its storage-readiness result.
- Test identities/content exist only in isolated fixtures. Runtime identity/providers remain unavailable. Null voice/cost/presence/chart measurements are not zeros. No frontend UI connection, production admin authentication, live AI/voice, deployment or native/device acceptance claimed.
