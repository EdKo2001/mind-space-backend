# Operations dashboard API

`GET http://127.0.0.1:3001/v1/dashboard?start=<ISO UTC>&end=<ISO UTC>&timezone=<IANA zone>`

This version-1 contract matches the separate dashboard's `src/data/client.ts` adapter in the “Dashboard & Analytics” chat, `01a13248-0fe1-7503-90cc-3e789a2fb95d`. Backend data is distinct from the dashboard's illustrative mock fixtures.

## Local use

Compose explicitly enables `DASHBOARD_LOCAL_AGGREGATES=1` and publishes port3001 on loopback. The default npm server has dashboard access disabled. For npm, configure PostgreSQL and enable that flag explicitly; preserve loopback binding. Allowed browser origins are `http://127.0.0.1:5173` and `http://localhost:5173` in Compose, with exact origin matching. Responses use `Cache-Control: no-store`. This is a redacted local-development endpoint, not a production administrator authentication mechanism. Session command authentication remains required and unavailable until the identity adapter is configured.

When the dashboard is connected later, its existing adapter accepts:

```dotenv
VITE_DASHBOARD_API_URL=http://127.0.0.1:3001/v1/dashboard
```

No tokens belong in this variable. No frontend files were changed to enable it during this backend checkpoint.

The frontend resolves Today, 7/30/90/360-day and custom ranges to UTC instants using the selected timezone. The API echoes those exact instants, without resolving local midnight/DST again. Range membership is `[start,end)`. Instants must be canonical UTC ISO strings with milliseconds; the range is positive and bounded to367 elapsed days to allow366 calendar days across DST. The end may be at most60 seconds ahead of server time for clock skew. Future data is never projected. Unknown query keys, duplicate parameters, invalid dates/zones and query credentials return400.

## Response and measurement definitions

`version: 1`, `profile: "internal-test-v1"`, `scope: "local-aggregate"`, `capturedAt`, `range` and all fields below are returned. The PostgreSQL timestamp and read model come from one SQL statement snapshot. Totals include only records in this internal schema; they do not represent production customers or historical activity outside this store. A visible alert explains this scope to the dashboard.

| Field | Current source and unit |
| --- | --- |
| `completed` | Number of activated sessions whose first stored `ended` observation falls inside the selected range. Its timestamp is PostgreSQL transaction time from the terminal outbox row, not an audio or precise commit timestamp. Includes user end, expiry and revocation; canceled/expired preparations are excluded. Genuine zero means no recorded completions in this store/range. This does not measure successfully delivered AI conversations. |
| `avgDuration` | Mean backend elapsed minutes for those completions: activation to first terminal database observation, capped at the fixed session deadline. Null when there are no valid durations. It is not audible time, billing compensation or a disconnect-pause policy. Invalid/skewed negative durations are excluded. |
| `diagnostics.activeSessions` | Current allowed-account sessions in active lifecycle with a future deadline. This is separate from connected clients. |
| `diagnostics.preparingSessions` | Current allowed-account preparations with a future reservation deadline. |
| `diagnostics.overdueSessions` | Allowed-account preparations/active sessions awaiting expiry reconciliation. They are excluded from the two live counts. |
| `health` | API gateway and PostgreSQL are Operational only after the read succeeds. AI, Voice and Queue are Unknown while unconfigured. A storage failure returns503, not a fabricated healthy snapshot. |
| `connected`, `reconnecting` | Null until session connection/presence instrumentation and its definitions are configured. A lifecycle record does not prove presence. |
| `concurrency`, `peak`, `peakAt` | Null until measured connection history exists. Missing history is never filled with synthetic zeroes or curves. |
| `voiceP95` | Null. Required future unit: seconds from app-observed turn end to first audible reply; server generation completion is insufficient. |
| `failedPercent` | Null until provider outcomes and the request denominator exist. |
| `spend`, `forecast` | Null until actual attributed provider costs/currency and forecast policy exist. |
| `capacity` | Null until global capacity is configured. The per-account test session limit is not global capacity. |
| `avgAnswers` | Null until delivered/played answer measurements exist. Accepted input or generated text does not prove delivery. |
| `queueDepth`, `queueOldest` | Null until an inference queue exists. The session event outbox is not that queue. |
| `sessions` | Null in local aggregate mode. No account/session/controller identifiers, platform guesses, text, audio, notes or provider credentials are returned. The current frontend rows require platform and latency, which are not measured yet. |
| `comparisons` | All six headline keys return null `previous` and a reason label; no historical baseline is invented. |
| `unavailable` | Field-specific explanations for absent measurements, for future UI support. The current frontend parser tolerates these extra metadata fields. |

Numeric `null` means unavailable and remains distinct from0. `avgDuration` and `completed` cover the selected historical range; lifecycle diagnostics are current regardless of that range. No fixture accounts or sessions are seeded into the runtime database. Reporting currently uses retained terminal outbox metadata; no cleanup is enabled. Before introducing an outbox retention/cleanup policy, preserve reporting facts separately or explicitly expose the resulting coverage gaps.

## Errors

| Status | Meaning |
| --- | --- |
| 400 | `invalid_input`: unsupported/malformed query. |
| 403 | `forbidden`: browser origin outside the configured local list. |
| 503 | `dashboard_access_unconfigured`: local aggregates not explicitly enabled or durable store absent. |
| 503 | `dashboard_storage_unavailable`: durable read failed; no database details are returned. |

## Verification

```bash
npm run check
npm test
npm run smoke
docker compose --profile test run --build --rm tests
docker compose up --build -d --wait
npm run smoke:dashboard
```

Optionally verify through the actual separate dashboard adapter, without changing it:

```bash
npm run smoke:dashboard -- --client=/absolute/path/to/mindspace-dashboard/src/data/client.ts
```

The live check records redacted evidence in `evidence/dashboard-smoke.json`. It exercises real HTTP, exact requested-range echo, allowed/denied origin behavior, malformed query rejection, durable-store availability and optional frontend parsing. PostgreSQL integration tests use isolated disposable fixture schemas and verify shared state, completion boundaries, units, unknown values, migration continuity and process-kill durability. Frontend wiring, production admin identity, provider metrics and native playback remain pending.
