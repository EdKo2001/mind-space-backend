# MindSpace backend

Standalone TypeScript backend for MindSpace. Approved stack: Node.js 24, Fastify, PostgreSQL, WebSocket and Docker Compose. Remote: [EdKo2001/mind-space-backend](https://github.com/EdKo2001/mind-space-backend).

## Run with Docker

```bash
docker compose up --build -d
curl http://127.0.0.1:3001/health
curl http://127.0.0.1:3001/ready
```

Compose runs the API and PostgreSQL 18. API access is published on localhost; PostgreSQL stays on the Compose network. The database volume persists. `docker compose down` stops this project without deleting that volume; do not add `-v` unless deleting the database is intended. `API_PORT` can change the localhost port.

The Docker build runs typecheck, lint, all tests and a real localhost HTTP smoke check. The runtime image uses Node 24 and runs as the node user. Compose's database credentials are explicitly local development values, not production configuration. No user content is seeded or stored in PostgreSQL by this checkpoint.

On this Mac the Docker CLI is installed at `/Applications/Docker.app/Contents/Resources/bin/docker`; use that absolute path if `docker` is not on PATH.

## Run with npm

```bash
npm ci
npm run check
npm test
npm run smoke
npm run dev
```

`npm run dev` builds and starts the process; it does not watch files. `npm start` runs an existing build and optionally loads `.env`. See `.env.example`. A PostgreSQL connection can be supplied as `DATABASE_URL`, but it currently provides a connection check only, not session persistence.

## Current API boundary

| Route | Behavior |
| --- | --- |
| `GET /health` | Process liveness; actual200 while running. |
| `GET /ready` | Reports unavailable integrations and returns 503. Database connection can be reachable while the durable session store remains unavailable. |
| `POST /v1/session/commands` | Version1 command dispatcher behind a replaceable identity verifier. |
| `WS /v1/session/channel` | Authenticated JSON command/reply channel with explicit snapshot/event replay. Background live-event push is not connected yet. |

Session routes require a Bearer header. Missing identity gives401; supplying a credential while the identity adapter is unconfigured gives503. There is no built-in development password/login/token and no automatic test-account creation. Identity, inference and voice adapters remain unavailable until connected. Session/account/controller identity comes from the verifier, never command fields or query tokens. Test fixtures inject synthetic identities solely into isolated tests.

Commands include Start, Confirm, preparation Cancel, Reconnect, Snapshot, committed Utterance, targeted response Cancel and End. Readiness, credit grants, revocation, recovery and media publication remain trusted internal operations. Unknown/malformed fields, altered retries, unowned sessions and stale controllers are rejected. HTTP/WS input is bounded; WebSocket commands are serialized per connection and identity is rechecked for every command.

## Session foundation

`src/session/service.ts` owns admission/test-credit ledger, fixed 45/10-minute fixture durations, expiry, authoritative timing, response-generation fences, controller rebinding and bounded event replay. `MemorySessionStore` isolates transactions and rejects asynchronous work inside them. It is test-only: process exit loses state. Coordinator-replacement tests do not establish crash/database durability.

`src/session/playback-guard.ts` is a portable guard for future mobile integration, not another player or animation loop. Local stop suppression survives reconstructed guards/reconnect. Terminal state, deadline, wrong controller or generation prevents playback. State replay alone never plays or automatically resumes audio.

`src/session/commands.ts` and `wire.ts` validate command/snapshot/event objects. `src/protocol/therapist.ts` is generated from the existing mobile speech contract with actual emotion IDs, removing renderer imports. Its provenance is in `references/mobile-contract.json`. Standalone build/tests require no mobile checkout. When upstream changes, regenerate rather than hand-edit:

```bash
npm run sync:contract -- /path/to/MindSpace
npm run sync:contract -- /path/to/MindSpace --check
```

Publishing speech checks metadata, order and authorization; it does not establish actual audio byte integrity, alignment, content safety or audible delivery. Internal segment IDs await an authenticated media adapter; model/client URLs cannot authorize audio downloads.

## Acceptance limits and next connections

The internal profile uses explicit synthetic credits and an absolute deadline. This is not approval of paid disconnect/pause/outage/compensation rules or production one-time trial eligibility. It retains IDs/fingerprints and synthetic speech in memory; no new sensitive persistence or telemetry is enabled.

Next: durable PostgreSQL session/ledger/outbox transactions, a verified identity adapter, provider adapters with output validation and media alignment, live-event delivery, then the existing mobile coordinator. Provider URLs/credentials, retention, billing, appointments, notes/history and production policy remain unconfigured. Database connectivity is distinct from durable-store correctness, and transport tests are distinct from native speech/performance acceptance.

Evidence and current status: [CURRENT_ACCEPTANCE_LEDGER.md](CURRENT_ACCEPTANCE_LEDGER.md). Architectural workflow: [ARCHITECTURE.md](ARCHITECTURE.md). Historical pre-extraction notes remain labeled in `references/initial-foundation-notes.md`.
