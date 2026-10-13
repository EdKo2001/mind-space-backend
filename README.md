# MindSpace backend

Standalone TypeScript backend for MindSpace. Approved stack: Node.js 24, Fastify, PostgreSQL, WebSocket and Docker Compose. Remote: [EdKo2001/mind-space-backend](https://github.com/EdKo2001/mind-space-backend).

## Run with Docker

```bash
docker compose up --build -d
curl http://127.0.0.1:3001/health
curl http://127.0.0.1:3001/ready
```

Compose runs the API and PostgreSQL 18. API access is published on localhost; PostgreSQL stays on the Compose network. The database volume persists. `docker compose down` stops this project without deleting that volume; do not add `-v` unless deleting the database is intended. `API_PORT` can change the localhost port.

The Docker build runs typecheck, lint, unit/transport tests and a real localhost HTTP smoke check. The runtime image uses Node 24 and runs as the node user. Compose's database credentials are explicitly local development values, not production configuration. No runtime accounts are seeded; no raw transcript, speech, notes or audio is stored.

On this Mac the Docker CLI is installed at `/Applications/Docker.app/Contents/Resources/bin/docker`; use that absolute path if `docker` is not on PATH.

## Run with npm

```bash
npm ci
npm run check
npm test
npm run smoke
npm run dev
```

`npm run dev` builds and starts the process; it does not watch files. `npm start` runs an existing build and optionally loads `.env`. See `.env.example`. `DATABASE_URL` enables the durable PostgreSQL metadata store and applies checksum-verified additive migrations. A configured database failure stops startup rather than falling back to memory. Without a database, the internal server is transient and dashboard access remains unavailable.

## Current API boundary

| Route | Behavior |
| --- | --- |
| `GET /health` | Process liveness; actual200 while running. |
| `GET /ready` | Reports actual connection/store availability and returns503 while identity/dialogue/speech remain unconfigured. |
| `GET /v1/dashboard` | Version1 data matching the standalone operations dashboard. Compose enables local redacted aggregates; npm access is disabled by default. See [dashboard API](docs/dashboard-api.md). |
| `POST /v1/session/commands` | Version1 command dispatcher behind a replaceable identity verifier. |
| `WS /v1/session/channel` | Authenticated command/reply and background state channel with explicit snapshot/event replay. PostgreSQL wakeups and bounded fallback reads recover changes. See [session channel](docs/session-channel.md). |

Session routes require a Bearer header. Missing identity gives401; supplying a credential while the identity adapter is unconfigured gives503. There is no built-in development password/login/token and no automatic test-account creation. Identity, inference and voice adapters remain unavailable until connected. Session/account/controller identity comes from the verifier, never command fields or query tokens. Test fixtures inject synthetic identities solely into isolated tests.

Commands include Start, read-only Start lookup, Confirm, preparation Cancel, Reconnect, Snapshot, committed Utterance, targeted response Cancel and End. Lookup recovers an existing verified account/client's session ID after a lost first reply; explicit Reconnect still grants controller authority. Readiness, credit grants, revocation, coordinator recovery and media publication remain trusted internal operations. Unknown/malformed fields, altered retries, unowned sessions and stale controllers are rejected. HTTP/WS input is bounded; WebSocket commands are serialized per connection and identity is rechecked for every command.

## Session foundation

`src/session/service.ts` owns admission/test-credit ledger, fixed 45/10-minute fixture durations, expiry, authoritative timing, response-generation fences, controller rebinding and bounded event replay. `MemorySessionStore` isolates transactions and rejects asynchronous work inside them. It is test-only: process exit loses state. Coordinator-replacement tests do not establish crash/database durability.

`PostgresSessionStore` persists session metadata, command deduplication, append-only accounting, fingerprints and event outbox atomically. Per-account transaction locks allow unrelated accounts to progress; schema/recovery use a separate global lock. Expiry maintenance reconciles due accounts without invalidating live response authorization. Reclaimable outbox publication now revalidates state and atomically emits empty PostgreSQL wakeups. Dedicated listeners reconnect, and bound WebSocket clients receive only reverified owned state, with snapshot recovery for missed/obsolete events. Publication/socket enqueue does not establish client receipt or playback. The database rejects private speech publication until content-storage policy is configured. Real PostgreSQL tests include an actual worker SIGKILL after activation and restart/retry without a second debit.

The dashboard reports recorded session completions, backend elapsed minutes, current lifecycle diagnostics and actual API/database health. Voice timings, provider cost, failures, capacity, presence/history and inference queue data remain explicitly null. It returns no session identifiers or private content. Run `npm run smoke:dashboard` against Compose; optionally pass the separate dashboard's `src/data/client.ts` using `-- --client=/absolute/path` to verify real adapter compatibility.

`src/session/playback-guard.ts` is a portable guard for future mobile integration, not another player or animation loop. Local stop suppression survives reconstructed guards/reconnect. Terminal state, deadline, wrong controller or generation prevents playback. State replay alone never plays or automatically resumes audio.

`src/session/commands.ts` and `wire.ts` validate command/snapshot/event objects. `src/protocol/therapist.ts` is generated from the existing mobile speech contract with actual emotion IDs, removing renderer imports. Its provenance is in `references/mobile-contract.json`. Standalone build/tests require no mobile checkout. When upstream changes, regenerate rather than hand-edit:

```bash
npm run sync:contract -- /path/to/MindSpace
npm run sync:contract -- /path/to/MindSpace --check
```

Publishing speech checks metadata, order and authorization; it does not establish actual audio byte integrity, alignment, content safety or audible delivery. Internal segment IDs await an authenticated media adapter; model/client URLs cannot authorize audio downloads.

## Acceptance limits and next connections

The internal profile uses explicit synthetic credits and an absolute deadline. This is not approval of paid disconnect/pause/outage/compensation rules or production one-time trial eligibility. PostgreSQL retains operational IDs/fingerprints and state metadata; real-user identity/providers remain unconfigured. Content retention/consent and production admin access still need decisions.

Next: verified user/admin identity, measured connection presence/history, provider adapters and app playback acknowledgments, output validation/media alignment, then the existing mobile coordinator. Provider URLs/credentials, retention, billing, appointments, notes/history and production policy remain unconfigured. Transport/database tests are distinct from native speech/performance acceptance.

Evidence and current status: [CURRENT_ACCEPTANCE_LEDGER.md](CURRENT_ACCEPTANCE_LEDGER.md). Architectural workflow: [ARCHITECTURE.md](ARCHITECTURE.md). Historical pre-extraction notes remain labeled in `references/initial-foundation-notes.md`.

## PostgreSQL demo preview

The user-authorized DB demo is separate from operational aggregates. Run `docker compose exec -T api node dist/dashboard/seed-demo.js` after Compose starts, then `npm run dev:db-demo` in the standalone dashboard. Open http://127.0.0.1:5175. Data is fetched from PostgreSQL via `/v1/dashboard/demo` and visibly labeled synthetic. See [dashboard API](docs/dashboard-api.md) for units, isolation and rerun behavior. The demo schema persists in the existing volume; provider endpoints remain deferred.
