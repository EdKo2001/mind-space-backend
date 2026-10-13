# Backend acceptance ledger

October 13, 2026. Standalone extraction, command transport and Docker foundation verified.

## Completed before extraction

The original mobile-workspace domain foundation passed26 backend tests,61 avatar/session regression tests, lint/typecheck and web export. Source engine/test files moved into src/session and src/__tests__; the mobile backend command forwards here. Those original results do not establish this standalone checkpoint's acceptance.

## Approved decisions

The user supplied EdKo2001/mind-space-backend and approved TypeScript, Node 24, Fastify, PostgreSQL and WebSocket. The user later explicitly enabled Docker for containerization. AI/voice/provider endpoints remain deferred. Existing provisional admission/timing/retention/commercial rules have not become production policy through stack approval.

## Current boundary

No production identity, durable session database, inference/voice, billing, appointments, history persistence, telemetry or mobile transport is connected. In-memory fixture tests are synthetic. Deployment/native/production acceptance remains open.


## October 13 standalone server and Docker checkpoint

- Session engine/tests moved from the mobile workspace; no duplicate active backend remains there. Generated mobile speech contract is self-contained with provenance. Added strict command/snapshot/event decoders and dispatcher, Fastify HTTP/WS boundary, explicit unavailable identity adapter, PostgreSQL connection probe and local smoke command.
- Docker Compose now runs API + PostgreSQL 18 with a persistent project-scoped volume and localhost API mapping. Docker build runs typecheck/lint,44 tests and actual localhost HTTP smoke; all PASS. Runtime uses Node 24.21.0, PostgreSQL 18.6; both containers healthy.
- Actual host→container checks: health200; ready503 with databaseConnection reachable and durable store/identity/dialogue/speech unavailable; command without auth401; WebSocket upgrade without auth401. Evidence: evidence/container-smoke.json. Database connectivity is verified, session durability is not.
- Local npm check,44 tests, smoke and mobile contract --check PASS. HTTP/WS tests use synthetic injected identities; runtime has no seeded account or credential accepted by default. Wire replay is request/reply, not background push.
- Mobile lint/typecheck and16-route export PASS after extraction. Doctor20/21 retains existing Expo57.0.27/router57.0.25 versus57.0.28/57.0.26 patch drift; no mobile dependency/renderer/UI changes.
- Pending: durable PostgreSQL session/ledger/outbox adapter and migrations, real identity/providers, media byte/alignment verification, live event publisher, mobile wiring, production timing/retention/billing decisions. No real-user conversation, native/device, audible-latency or production acceptance. The internal profile is synthetic domain behavior only.
- Services remain running under Compose project mindspace-backend; volume preserved. npm development mode remains available.
