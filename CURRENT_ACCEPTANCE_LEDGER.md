# Backend acceptance ledger

October 13, 2026. Standalone foundation, durable PostgreSQL metadata and local dashboard data verified.

## Completed before extraction

The original mobile-workspace domain foundation passed26 backend tests,61 avatar/session regression tests, lint/typecheck and web export. Source engine/test files moved into src/session and src/__tests__; the mobile backend command forwards here. Those original results do not establish this standalone checkpoint's acceptance.

## Approved decisions

The user supplied EdKo2001/mind-space-backend and approved TypeScript, Node 24, Fastify, PostgreSQL and WebSocket. The user later explicitly enabled Docker for containerization. AI/voice/provider endpoints remain deferred. Existing provisional admission/timing/retention/commercial rules have not become production policy through stack approval.

## Current boundary

Durable internal session metadata and redacted local dashboard aggregates are connected. Production identity/admin access, inference/voice, billing, appointments, sensitive history, measured presence/voice/cost telemetry and mobile transport remain unconnected. Fixture identities are synthetic. Deployment/native/production acceptance remains open.


## October 13 standalone server and Docker checkpoint

- Session engine/tests moved from the mobile workspace; no duplicate active backend remains there. Generated mobile speech contract is self-contained with provenance. Added strict command/snapshot/event decoders and dispatcher, Fastify HTTP/WS boundary, explicit unavailable identity adapter, PostgreSQL connection probe and local smoke command.
- Docker Compose now runs API + PostgreSQL 18 with a persistent project-scoped volume and localhost API mapping. Docker build runs typecheck/lint,44 tests and actual localhost HTTP smoke; all PASS. Runtime uses Node 24.21.0, PostgreSQL 18.6; both containers healthy.
- Actual host→container checks: health200; ready503 with databaseConnection reachable and durable store/identity/dialogue/speech unavailable; command without auth401; WebSocket upgrade without auth401. Evidence: evidence/container-smoke.json. Database connectivity is verified, session durability is not.
- Local npm check,44 tests, smoke and mobile contract --check PASS. HTTP/WS tests use synthetic injected identities; runtime has no seeded account or credential accepted by default. Wire replay is request/reply, not background push.
- Mobile lint/typecheck and16-route export PASS after extraction. Doctor20/21 retains existing Expo57.0.27/router57.0.25 versus57.0.28/57.0.26 patch drift; no mobile dependency/renderer/UI changes.
- Pending: durable PostgreSQL session/ledger/outbox adapter and migrations, real identity/providers, media byte/alignment verification, live event publisher, mobile wiring, production timing/retention/billing decisions. No real-user conversation, native/device, audible-latency or production acceptance. The internal profile is synthetic domain behavior only.
- Services remain running under Compose project mindspace-backend; volume preserved. npm development mode remains available.

## October 13 durable store and dashboard data checkpoint

- Added PostgreSQL session/command/ledger/fingerprint/event/outbox storage. State and accounting commit atomically under account-scoped locks; immutable accounting and command outcomes are enforced in SQL. Startup applies checksum-verified additive migrations; runtime migrated from version1 to2 without changing version1 SQL or deleting data. A configured storage failure never falls back to memory.
- Expiry maintenance releases abandoned reservations and terminates elapsed sessions across workers while preserving live response authority. Outbox leases/reclaim and state revalidation are implemented; external/live publication is still pending. Private speech persistence is rejected as `content_storage_unconfigured`; raw transcripts/audio/notes are not stored.
- Added `GET /v1/dashboard` matching the actual version1 adapter in chat “Dashboard & Analytics” (`01a13248-0fe1-7503-90cc-3e789a2fb95d`). The frontend supplies UTC start/end and IANA timezone; the backend echoes the exact range. Completed sessions/backend elapsed minutes and current lifecycle diagnostics come from PostgreSQL; health reflects real reads. Unknown voice/cost/presence/chart/queue metrics remain null, with explanations. No session/account/controller IDs are returned.
- Compose explicitly enables the localhost aggregate endpoint with exact local browser origins and no-store responses. npm access is disabled by default. This development mode is not production admin authentication. Dashboard/mobile files were not edited or connected during this checkpoint.
- Validation PASS: local check,47 unit/transport tests and actual HTTP smoke; Docker rebuild repeats check+47 tests+smoke.18 real PostgreSQL integration tests pass, no skips, including actual worker SIGKILL after committed activation, retry without second debit, concurrent admission, isolation/rollback, private-content rejection, lease reclaim, stale publication, expiry and dashboard window/unit checks.
- Live host→container dashboard HTTP200 parsed successfully through the separate dashboard's actual `requestDashboard` function. Exact range/CORS/no-store checks PASS; query credentials400 and denied origin403. `/ready` remains503 because identity/dialogue/speech are unavailable, with durableSessionStore available. Evidence: `evidence/dashboard-smoke.json`; contract and handoff: `docs/dashboard-api.md`.
- Real runtime SQL inspection: migrations1+2 applied;0 runtime accounts seeded;0 disposable `ms_test_*` schemas remain. Persistent Compose database volume preserved. Current zero completions is an actual empty internal store, not mock customer data.
- Remaining: frontend activation of its existing API adapter, production admin/user identity, presence/history measurement and approved presence rules, provider usage/outcome/voice acknowledgments, media retention/alignment, live publication/mobile integration and production policy. No public deployment, real AI/voice, audible performance, billing or device acceptance claimed.
