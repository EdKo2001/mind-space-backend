# MindSpace backend

Read README.md, ARCHITECTURE.md and CURRENT_ACCEPTANCE_LEDGER.md before substantial changes. Preserve completed behavior and unrelated work.

## Confirmed stack and scope

- TypeScript, Node.js 24, Fastify, PostgreSQL, WebSocket and Node's test runner.
- Latest user decision authorizes Docker/Compose for API and PostgreSQL. Preserve database volumes; no destructive cleanup. npm scripts also remain usable.
- Origin is https://github.com/EdKo2001/mind-space-backend.git. The mobile app has its own repository; do not change its remote or restore a duplicate backend there.
- Latest user Git instruction: push validated work directly to main. Do not create pull requests unless the user changes this instruction. Preserve history; do not force-push.
- Provider endpoints will be connected later. Keep unconfigured identity/inference/voice/billing adapters visibly unavailable; never fabricate successful AI, microphone, authentication, purchase or delivery results.
- Keep provider credentials behind the backend. Do not add private transcript/notes/audio storage or telemetry without a defined consent/retention policy.
- One modular backend plus separate execution for slow jobs; preserve generation/revision/sequence and conditional admission/controller invariants in ARCHITECTURE.md. No service proliferation or unapproved billing/retention policy.
- Paid duration stays 45 minutes and trial stays 10 minutes. Internal test profile is not production paid-time/outage/compensation/one-time-trial policy.
- Reuse the generated mobile speech contract; do not hand-edit src/protocol/therapist.ts. Sync through scripts/sync-mobile-contract.cjs and retain its provenance. Backend build/tests must work without the mobile checkout.
- No physical phone operations. The app's renderer/player/coordinator remain app-owned and unconnected here.

## Validation

Run npm run check, npm test and npm run smoke before declaring a backend milestone complete. Verify changed transports through actual HTTP/WebSocket tests; use a real configured PostgreSQL for durable-storage claims. Update the ledger with test totals, commands, evidence and pending connections. No simulated database or authentication success claims.

## Docker shutdown at handoff

- When finishing, pausing or stopping backend work, stop the task-owned Compose containers and quit Docker Desktop to release RAM. Leave them running only when the human explicitly requests it for that handoff; an earlier leave-running request is not a permanent exemption.
- Check ownership first. Preserve unrelated/shared Docker work; if another active task needs the engine, stop only this task's containers and report why Docker Desktop remains running.
- Preserve database volumes, seed data and source files. Use `docker compose stop`; never delete volumes or prune data as shutdown cleanup. Verify owned containers have stopped and Docker Desktop has quit. If Docker is already stopped, do not start it just to check or clean up.
