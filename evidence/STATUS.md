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

## Database demo daily peaks correction

- Expanded real PostgreSQL regression reproduced31 dates versus721 hourly results before the SQL correction. Multi-day requests now select one peak per IANA-zone date with actual timestamps; single calendar days retain hourly samples, including23/25-hour Chicago DST days. Both use `[start,end)`.
- Check/66 tests/HTTP smoke/Docker build/27 real database tests PASS. Live frontend adapter smoke and browser confirmed Today17 hourly points,7-day7 peaks and30-day30 peaks. `dashboard-daily-peaks.png` is the current rendered multi-day view; preceding screenshots record the earlier hourly implementation.
- Provider identity/AI/voice/media/native and production policies remain pending; full backend goal is not claimed complete by this chart correction.

## Connected-session prerequisite audit

`connection-readiness.json` records current health200/readiness503, unauthenticated401 and unconfigured identity503, migrations1+2,0 runtime accounts,66 demo rows/721 samples and0 test schemas. The local DB demo is verified; a connected authenticated AI/voice/avatar session remains blocked on the user-deferred identity/provider inputs and temporary-media policy. Fixture transport/cancellation tests and synthetic voice metrics do not prove audible delivery or latency targets. The broader goal is not complete.
