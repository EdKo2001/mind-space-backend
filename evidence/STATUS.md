# Backend and dashboard data evidence

October13,2026.

- Current check,66 unit/transport tests and smoke PASS.
- Current Docker build: check +66 tests + real localhost smoke PASS.
- 27 real PostgreSQL integration tests PASS, no skips. Includes actual child-process SIGKILL and durable activation/accounting retry, concurrency/isolation, expiry, private-content rejection, outbox reclaim/stale guards, migration continuity and dashboard aggregation boundaries/units. Live metadata delivery adds separate-store worker/API/real-WebSocket transport, actual empty notification payload, failed publication rollback, listener termination/reconnection and resource closure. Authority corrections cover stale-controller retry, invalid scope and verifier data, preserved current older-revision media, old-generation suppression and local stop. Lost Start reply discovery is tested via real HTTP after a committed Start/actual worker SIGKILL, followed by explicit rebind/activation with one debit; account/client scope and read-only behavior are verified.
- Compose runtime: API and PostgreSQL containers healthy. Node24.21.0/PostgreSQL18.6.
- `dashboard-smoke.json`: real dashboard HTTP200 accepted by the separate frontend's actual adapter, exact UTC range echo, allowed local origin/no-store; malformed query400 and denied origin403. Durable store is available; readiness503 correctly reports missing identity/dialogue/speech. Current runtime data has0 seeded accounts; migrations1+2 are applied; disposable test schemas were removed.
- `live-session-checkpoint.json`: current runtime health200/ready503/unauthenticated command401, one dedicated LISTEN connection, migrations1+2,0 seeded accounts/fixture schemas, validation counts and explicit synthetic-identity/provider/mobile boundaries. Background state packets require a verified identity; no runtime test credential is enabled.
- `container-smoke.json` is historical foundation evidence: health200, ready503 with PostgreSQL reachable but durable store then unavailable, unauthenticated command401 and WebSocket upgrade401. The newer dashboard evidence supersedes its storage-readiness result.
- Test identities/content exist only in isolated fixtures. Runtime identity/providers remain unavailable. Null voice/cost/presence/chart measurements are not zeros. The separate synthetic DB demo is connected to the frontend as described below. Production admin authentication, live AI/voice, deployment and native/device acceptance remain unclaimed.

## PostgreSQL demo checkpoint

- `dashboard-db-demo.json`: actual dashboard HTTP adapter accepted real PostgreSQL-backed Today/7/30-day requests. All session/cost/latency/history values are seeded synthetic fixtures, explicitly labeled.66 rows/721 samples;6 frozen current session rows.
- PostgreSQL integration includes idempotent seed, HTTP/CORS, empty historical range, database update reflected on next HTTP read and operational endpoint isolation.
- Actual dashboard browser proved SQL answers14→77→restored14 after Refresh; search/status/detail/reporting-period interactions and1440×900/375×667 layouts inspected. Screenshot evidence lives in the standalone dashboard `evidence/db-demo/`.
- Temporary Docker read-only storage error recovered with volume-preserving desktop restart. All27 actual PostgreSQL tests passed after recovery in the built API container.
- Current authoritative runtime accounts0, migrations1+2; no real-user/provider/mobile integration. Earlier live-session-checkpoint.json records the preceding session milestone (65+26); this checkpoint adds one test in each suite.
