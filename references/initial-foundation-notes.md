# Historical pre-extraction notes

This is the original foundation scope from the mobile workspace. Relative paths and commands below describe that earlier checkout. Use the standalone README.md and ledger for current instructions.

# Local backend session foundation

The first backend slice implements admission, test-credit accounting, timing, response authorization, reconnect and playback admission. It is framework-neutral TypeScript with no HTTP/WebSocket listener, provider credentials or external endpoints. The mobile demo is not wired to it.

Run from the repository root:

```bash
npm run test:backend
npm run check
```

## Implemented boundaries

- `session/service.ts`: short serialized domain operations for Start, readiness, Confirm, preparation Cancel, Reconnect, Snapshot/replay, committed utterance, targeted response Cancel, speech publication, End and test-account revocation/recovery.
- `session/contracts.ts`: version 1 snapshots/events, trusted principal, explicit internal policy, store and inference/speech ports. Unconnected providers throw `provider_unavailable`; no generated reply/audio is simulated.
- `session/memory-store.ts`: isolated transaction snapshots with rollback and detached results. This is a synthetic-test adapter, not a database or production persistence system.
- `session/playback-guard.ts`: portable guard for future transport integration. Local suppression survives reconstructed guards/reconnect; state replay alone never starts playback. Reuse the existing player/coordinator when wiring it; this guard does not own another player or animation loop.
- `__tests__/session.test.ts`: synthetic executable scenarios including both activation/cancel orderings, expiry without cleanup, lost activation reply, duplicate commands, immutable inputs/media, targeted late cancellation, controller conflicts, revocation, bounded replay and local stop after lost cancellation.

The speech payload uses the existing `SpeechSegment` and `normalizeSpeech` validator. New session envelopes supplement the existing therapist event contract; they are not yet mapped into the renderer coordinator. Publishing speech validates metadata/order/authorization, not actual audio bytes, alignment or provider content safety. `speech.ready` in a test names an immutable synthetic segment; it makes no delivery or audible-playback claim.

## Internal test profile

Every service instance requires an explicit `internal-test-v1` policy. Tests configure preparation/readiness expiry, account concurrency, event replay length and input bounds. These fixture values are not approved production policies.

Test accounts are seeded explicitly with synthetic credits. A reservation reduces available credits; activation records one consumption; canceled/expired preparation releases once. Detached append-only test ledger entries describe each effect. Trial mode exercises a ten-minute duration with the same internal test-credit mechanism; it does not implement production one-time trial eligibility. Paid-duration fixtures use 45 minutes. The internal profile uses an absolute deadline without pausing on disconnect; paid-time pause/outage/compensation rules remain unselected.

No client request body can create a trusted principal or mark a provider ready through an endpoint here: there are no endpoints. A future adapter must verify identity and obtain fresh readiness observations before calling these ports. `seedTestAccount`, `testBalance`, `testLedger`, `revokeTestAccount`, `recover` and media publication are internal functions, not public actions. Account concurrency is enforced; global provider capacity reservation is not implemented.

Command identities are scoped to account/client/operation/session; fingerprints bind canonical payload meaning. Reconnect uses conditional controller rebinding, so an old connection cannot command the current binding. Generation numbers fence canceled/replaced response work; revisions version authoritative state and sequence orders events. A current response's valid media is not rejected solely because an unrelated state update advanced revision.

## Storage and recovery limits

The memory adapter serializes work within one instance and commits expiry/revocation reconciliation even when a later domain command is rejected. Provider work never runs in its transaction callback. Concurrent-process/database isolation remains untested and requires a durable adapter.

Coordinator replacement tests reuse the same memory store and invalidate outstanding authorizations. A process exit loses all state; these tests are not crash-durability proof. State plus event publication is atomic only inside this adapter; there is no network outbox publisher or worker yet.

The foundation retains no raw committed transcript. It retains IDs and SHA-256 payload fingerprints in memory for retry checks; hashing is not an anonymity guarantee. Speech fixtures and bounded replay payloads are also in memory, and terminal state clears speech replay. Account/session/command/ledger metadata is not globally bounded or cleaned up here. Do not use the memory adapter for live users; durable retention, media cleanup and pending-command storage require explicit policy.

`exportSuppression()` produces minimal local cancellation metadata; it performs no disk write. The app still stores no additional sensitive content or telemetry. Account deletion, conversation history, billing verification, subscriptions, appointments and reminders are not implemented by this slice.

## Endpoint connection later

1. Connect a verified identity boundary; never trust account/controller identifiers from request bodies.
2. Replace the memory store with short durable transactions that atomically save state, ledger and outbox events; apply the same race tests to that adapter.
3. Add runtime validation/authentication for command/event envelopes and a feature-owned transport bridge to the existing session coordinator. Persist local pending cancellations only after recovery/retention policy is chosen.
4. Connect inference and speech ports behind schema/content checks, capacity claims and bounded cancellation-aware execution. Validate private audio bytes/duration/alignment before publication and resolve internal segment IDs through an authorized media adapter.
5. Implement provider cancellation, controller/replay delivery and lifecycle timing on the actual connection. Gate actual playback against local suppression again immediately before playing; receipt or replay does not mean resume.

Connected dialogue, microphone input, audio synthesis/playback, spoken turn detection and native lifecycle/latency acceptance remain future work. This slice demonstrates local domain behavior, not production authentication, database durability, paid-session acceptance or human avatar realism.

Architecture reference: [backend workflow](../BACKEND_WORKFLOW.md).
