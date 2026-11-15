# HTTP API reference

The dashboard server listens on `http://localhost:8011` by default. All request
and response bodies are JSON unless noted otherwise.

## Ingest

### `POST /trace` and `POST /v1/traces`

Both paths accept the same payloads:

- **A flat span**, or an array of flat spans:

  ```json
  {
    "trace_id": "5b8efff798038103d269b633813fc60c",
    "span_id": "eee19b7ec3c1b174",
    "parent_span_id": "a1b2c3d4e5f60718",
    "name": "chat gpt-4o-mini",
    "start_time_unix_nano": 1731000000000000000,
    "end_time_unix_nano": 1731000000900000000,
    "status": "OK",
    "attributes": {
      "gen_ai.system": "openai",
      "gen_ai.request.model": "gpt-4o-mini",
      "gen_ai.usage.input_tokens": 120,
      "gen_ai.usage.output_tokens": 40
    }
  }
  ```

- **An OTLP/HTTP JSON export request** (`{"resourceSpans": [...]}`), which is
  what OpenTelemetry SDKs send. Resource attributes are merged into each span.
  `status.code` of `2` (or `"STATUS_CODE_ERROR"`) marks the span as an error.

**Validation.** A span is rejected and counted under `rejected` if any of these
is true:

- `gen_ai.system` or `gen_ai.request.model` is missing or not a string
- the timestamps are not numbers, or the end is before the start

Timestamps are optional. A span with neither timestamp is stamped with the
time it was received; with only one, the other is set to the same value (zero
latency). With `STORAGE=clickhouse`, spans that ended more than
`CLICKHOUSE_TTL_DAYS` ago are also rejected, because ClickHouse would expire
them immediately.
- a token count is negative or not a whole number

IDs that aren't valid hex are replaced with random ones. A non-string
`gen_ai.response.model` is dropped, and `gen_ai.operation.name` defaults to
`chat`.

| Status | Body |
|---|---|
| `202` | `{"status": "accepted", "counters": {"accepted", "rejected", "held"}}` |
| `400` | `{"error": "bad_request", "message": "..."}`: the body is not valid JSON |
| `401` | `{"error": "unauthorized", ...}`: sign-in is enabled and the request has no valid session or ingest key |
| `413` | `{"error": "payload_too_large"}`: the body is over 5 MB |
| `503` | `{"error": "storage_unavailable", ...}`: the storage backend (ClickHouse) rejected the write or is unreachable |
| `429` | `{"error": "rate_limited", ...}`: more than `INGEST_RATE_LIMIT_PER_MIN` requests from this IP in the last minute |

Protobuf-encoded OTLP is not supported.

## Web app API

### `GET /api/overview?window=15m|1h|6h|24h`

Metrics for spans that ended inside the window (default `1h`).

```json
{
  "nowMs": 1800000000000,
  "windowMs": 3600000,
  "counters": { "accepted": 1200, "rejected": 0, "held": 1200 },
  "summary": {
    "spans": 1200, "errors": 36, "errorRate": 0.03, "costUsd": 26.04,
    "inputTokens": 2597800, "outputTokens": 600386,
    "p50LatencyMs": 1360.5, "p95LatencyMs": 2522.15
  },
  "series": [
    { "t": 1799996400000, "count": 20, "errors": 1, "costUsd": 0.43,
      "p50LatencyMs": 1300, "p95LatencyMs": 2100 }
  ],
  "models": [ { "model": "gpt-4o-mini", "count": 240, "...": "see /api/models" } ]
}
```

`series` always has 60 equal-width buckets covering the window, including empty
ones. `t` is the bucket start in Unix milliseconds.

### `GET /api/models`

Per-model roll-ups across every span held in memory.

```json
{
  "models": [
    {
      "model": "claude-opus-4-7", "count": 240, "errors": 8, "errorRate": 0.0333,
      "inputTokens": 519040, "outputTokens": 121468, "costUsd": 16.88,
      "p50LatencyMs": 1283, "p95LatencyMs": 2103, "p99LatencyMs": 2184,
      "price": { "input": 15, "output": 75 }
    }
  ],
  "pricing": { "gpt-4o-mini": { "input": 0.15, "output": 0.6 } }
}
```

`price` is USD per million tokens, or `null` for models that aren't in the price
list.

### `GET /api/spans`

Spans held in memory, newest first.

| Query | Meaning |
|---|---|
| `model` | exact model name |
| `status` | `OK` or `ERROR` |
| `q` | substring of the trace ID or span ID, or of the name (case-insensitive) |
| `limit` | 1–500, default 50 |
| `offset` | default 0 |

Returns `{ "total": 1388, "items": [span, ...] }`. Each item is the stored span
plus `model`, `latency_ms` and `cost_usd`.

### `GET /api/traces/:traceId`

Every held span with that trace ID, in start-time order: `{ "trace_id", "spans": [...] }`.
Returns `404 {"error": "not_found"}` if none are held.

### `DELETE /api/spans`

Deletes every held span and resets the counters. This can't be undone. Returns
`{"status": "cleared", "counters": {...}}`. With `DEMO_MODE=1` it returns
`403 {"error": "forbidden"}` instead.

### `GET /api/config`

`{ "demo": true | false, "storage": "memory" | "clickhouse" }`, so the web app
can hide controls the server refuses and show which storage is in use.

## Sign-in (optional)

Enabled when `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `SESSION_SECRET` are
set. Reads (`GET`) stay public. Writes (`POST /trace`, `POST /v1/traces`,
`DELETE /api/spans`) then need either a signed-in browser session or an ingest
key, and otherwise return:

```json
401 { "error": "unauthorized", "message": "...", "login": "/auth/github/login" }
```

| Method | Path | What it does |
|---|---|---|
| GET | `/auth/github/login?next=/#/send` | Redirects to GitHub. `next` must be a relative path; anything else becomes `/` |
| GET | `/auth/github/callback` | GitHub returns here; checks the signed `state`, sets the session cookie, redirects to `next` |
| POST | `/auth/logout` | Clears the session cookie (`204`) |
| GET | `/api/me` | `{ "authEnabled": bool, "user": { id, login, name, avatar } \| null }` |
| POST | `/api/keys` | Signed-in users only: `201 { "key": "ssk_…", "expiresAt": "…" }` |

**Ingest keys** let apps send data without a browser session. Send the key as
`Authorization: Bearer ssk_…`, or with OpenTelemetry:

```bash
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20ssk_…
```

Keys are valid for 90 days. Sessions last 7 days. Both are HMAC-signed with
`SESSION_SECRET` and aren't stored anywhere, so changing `SESSION_SECRET` signs
everyone out and revokes every key. No GitHub scopes are requested, and the
GitHub access token is discarded after reading the public profile.

`GET /api/me` always exists; with sign-in off it returns
`{ "authEnabled": false, "user": null }`.

## Other endpoints

| Method | Path | Returns |
|---|---|---|
| GET | `/` | the web app |
| GET | `/assets/{index.html,app.js,charts.js,styles.css}` | web app files; anything else is `404` |
| GET | `/dashboard` | server-rendered HTML table, no JavaScript needed |
| GET | `/dashboard.json` | `{ counters, models }` across all held spans |
| GET | `/healthz` | `{ "status": "ok", "storage", counters }`, for liveness probes; `503` with `"status": "error"` if the storage backend is unreachable |
