# Live session channel

`WS /v1/session/channel` requires the verified Bearer identity boundary. The default runtime still cannot authenticate a user: missing identity returns401 and the unconfigured verifier returns503. Tests inject labeled synthetic identities; no test login/token/account is installed in the server.

With PostgreSQL configured, the channel now delivers background session state after a successful owned-session command. The mobile app remains unconnected. No inference, voice, audio capture or audible playback is implied by a delivered state packet.

## Envelopes and correlation

| Packet | Fields |
| --- | --- |
| Successful command | `ok:true`, `profile:internal-test-v1`, validated `commandId`, `type:result` or `type:snapshot`, `value`. Existing Result/Replay and version1 snapshots/events are reused. |
| Validated command failure | `ok:false`, typed `error`, validated `commandId`. Internal exceptions become `internal_error`; no database details are returned. |
| Malformed input/identity failure | `ok:false`, typed `error`; no unvalidated command ID is reflected. Identity failure closes the socket. |
| Unsolicited update | `ok:true`, `profile:internal-test-v1`, `type:events`, `value:{snapshot,events,requiresSnapshot}`. It has no `commandId`. |

Clients distinguish unsolicited updates by type and correlate command replies by commandId; the next received message is not necessarily a reply. HTTP command success/failure uses the same correlation fields. These are additive fields on the initial protocol; the contained snapshot/event protocolVersion remains1.

Every successful WebSocket command binds the channel to the returned owned session/controller and advances its local enqueue cursor. A reconnecting client must issue Reconnect/Snapshot with its own last accepted sequence; this server-side cursor is not a playback or delivery acknowledgment. Each background read re-verifies identity and exact account/client/connection identity, then applies the existing domain controller, deadline, revocation and ownership checks. Verifier results are validated as bounded plain identity records before HTTP, WebSocket handshake/commands or live reads reach storage. Duplicate Start/Reconnect results also require the current controller; an old recorded command does not restore superseded authority.

Unrelated-account updates never yield their identifiers/state to a channel. Controller replacement fences the old idle channel without requiring another old-client command. Identity/control failures send a typed failure and close; storage failure closes without fabricated state. Open sockets are terminated and queued work drains before storage shutdown.

## Durable publication and recovery

The domain transaction already stores session changes and outbox rows atomically. A bounded serial worker claims at most32 heads per batch, for up to8 rounds per cycle. PostgreSQL publication takes the account lock, rechecks lease/state/deadline, and commits an empty NOTIFY and outbox completion together. A failed transaction retains the pending event. Superseded revisions are marked separately. Empty wakeups contain no session/account/controller IDs, conversation content, media or credentials.

Each API instance holds a dedicated LISTEN connection for its schema's notification channel. On a wakeup, its bound sockets fetch current owned state from PostgreSQL; no notification payload grants authorization. The listener reconnects after connection loss. A one-second read fallback catches missed notifications/replay gaps and detects idle identity/controller changes. This is state-recovery polling, not a presence heartbeat or a paid-session pause policy.

Notifications are hints: offline listeners can miss them, so durable snapshots/events and explicit reconnect remain the recovery authority. PostgreSQL delivers NOTIFY only after commit; LISTEN is committed before catch-up reads. See [PostgreSQL18 NOTIFY](https://www.postgresql.org/docs/18/sql-notify.html) and [LISTEN](https://www.postgresql.org/docs/18/sql-listen.html).

The live sender coalesces wakeups behind the same serial command queue. It preserves the immutable replay journal: an older originating revision alone does not invalidate current authorized media. Apply the authoritative packet snapshot first, then pass media candidates through the existing ClientPlaybackGuard, which rejects superseded generations, expired/terminal state, wrong current controllers and locally suppressed responses. Older event snapshots cannot roll back the packet snapshot. Retention gaps return empty events/`requiresSnapshot:true`; receiving replay never commands playback or automatic resume. Input queue capacity remains8 commands; queued output is bounded to64KiB, with1013 on excess. Recovery uses a fresh snapshot instead of accepting unbounded backlogs.

Outbox `completion:published` means the database wakeup transaction committed. Socket enqueue means bytes were offered to the connection. Neither proves receipt, playback position or that the person heard anything; neither changes credit accounting. No exactly-once client delivery claim is made. The inference queue and provider execution remain separate and unconfigured.

## Evidence and remaining work

Real localhost WebSocket tests cover spontaneous state delivery, duplicate wakeups, cancellation/terminal replay, identity revocation, unowned state, stale controllers, notification-loss polling, request correlation and shutdown. Real PostgreSQL tests cover separate-worker/API-store delivery, empty notification payloads, lease/revision fencing, failed publication rollback, listener termination/reconnection and listener resource closure. No runtime sample accounts are seeded; fixture schemas are disposable and isolated.

Identity/provider/media adapters, client playback acknowledgments, approved content retention, mobile integration and native latency/synchronization acceptance remain pending. Voice targets require actual client audio evidence after those connections exist.
