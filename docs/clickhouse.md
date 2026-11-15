# ClickHouse storage

By default Spanscope keeps the newest 10,000 spans in memory, and loses them
on restart. With `STORAGE=clickhouse` it stores spans in
[ClickHouse](https://clickhouse.com), a column-oriented database built for
large volumes of append-only event data, and runs the dashboard's analytics as
SQL inside it.

| | In memory (default) | ClickHouse |
|---|---|---|
| History | Newest 10,000 spans | Everything for `CLICKHOUSE_TTL_DAYS` (default 30) |
| Survives restarts | No | Yes |
| Analytics run in | JavaScript, scanning every held span | ClickHouse SQL |
| Needs | Nothing | A ClickHouse server (Docker locally) |
| Used by the public demo | Yes | No (Render's free plan can't run it) |

Both backends return identical numbers for the same spans; an integration test
checks this in CI against a real ClickHouse.

## Run it locally

You need [Docker Desktop](https://www.docker.com/products/docker-desktop/).
Open it once and wait until it shows **Engine running**.

1. Start ClickHouse (from the repository root):

   ```bash
   docker compose up -d
   ```

   The first run downloads the `clickhouse/clickhouse-server:24.8` image
   (a few hundred MB). `docker compose ps` should show it as `healthy`.

2. Start Spanscope against it:

   ```bash
   cd dashboard && STORAGE=clickhouse npm run serve
   ```

   On first start it creates the `spanscope` database and `spans` table and
   loads an hour of demo spans. Later starts find the data and skip the demo
   seed:

   ```text
   [spanscope] storage: ClickHouse at http://localhost:8123 (database "spanscope")
   [spanscope] 1360 spans already stored; skipping demo seed
   ```

3. Open http://localhost:8011. The footer shows **Storage: ClickHouse**, and
   `http://localhost:8011/healthz` reports `"storage":"clickhouse"`.

`docker-compose.yml` is for local development only: the ClickHouse `default`
user has no password, so the port is bound to `127.0.0.1`.

## Stop, pause and delete

| Command (from the repository root) | Effect |
|---|---|
| `docker compose stop` / `docker compose up -d` | Stop and start ClickHouse; data is kept |
| `docker compose pause` / `docker compose unpause` | Freeze and resume it; memory stays reserved |
| `docker compose down` | Remove the container; data is kept in the `clickhouse-data` volume |
| `docker compose down -v` | Remove the container **and delete all stored spans** |

While ClickHouse is stopped, a running Spanscope server answers `/healthz` with
`503`, ingest with `503 storage_unavailable`, and the web app shows "Can't
reach the server". It recovers on its own once ClickHouse is back.

## Query the data with SQL

Open a SQL shell:

```bash
docker compose exec clickhouse clickhouse-client
```

Per-model health, the same numbers as the Models page:

```sql
SELECT model,
       count()                                         AS requests,
       countIf(status = 'ERROR')                       AS errors,
       round(100 * errors / requests, 1)               AS error_pct,
       round(quantileExactInclusive(0.95)(latency_ms)) AS p95_ms,
       round(sum(cost_usd), 2)                         AS cost_usd
FROM spanscope.spans
GROUP BY model
ORDER BY cost_usd DESC;
```

After **Simulate an incident**, the affected model stands out. On a test run:

```text
┌─model─────────────┬─requests─┬─errors─┬─error_pct─┬─p95_ms─┬─cost_usd─┐
│ claude-opus-4-7   │      241 │      8 │       3.3 │   2517 │    16.95 │
│ gpt-5.4           │      393 │     72 │      18.3 │   7226 │     6.56 │
│ claude-3-5-sonnet │      241 │      7 │       2.9 │   2467 │     3.39 │
│ gemini-2-5-pro    │      243 │      7 │       2.9 │   2560 │     1.27 │
│ gpt-4o-mini       │      247 │      7 │       2.8 │   2503 │     0.15 │
└───────────────────┴──────────┴────────┴───────────┴────────┴──────────┘
```

Errors per minute for the last hour:

```sql
SELECT toStartOfMinute(toDateTime(intDiv(end_ms, 1000))) AS minute,
       count() AS requests,
       countIf(status = 'ERROR') AS errors
FROM spanscope.spans
WHERE end_ms > (toUnixTimestamp(now()) - 3600) * 1000
GROUP BY minute
ORDER BY minute;
```

Storage used and compression:

```sql
SELECT sum(rows) AS rows,
       formatReadableSize(sum(data_compressed_bytes))   AS on_disk,
       formatReadableSize(sum(data_uncompressed_bytes)) AS raw,
       round(sum(data_uncompressed_bytes) / sum(data_compressed_bytes), 1) AS ratio
FROM system.parts
WHERE database = 'spanscope' AND table = 'spans' AND active;
```

About 1,400 spans took 127 KiB instead of 479 KiB (3.8×) in testing; the ratio
improves as data grows.

## Table design

```sql
CREATE TABLE spanscope.spans (
  trace_id String, span_id String, parent_span_id String,
  name LowCardinality(String), status LowCardinality(String),
  system LowCardinality(String), model LowCardinality(String),
  start_ns Int64, end_ns Int64, end_ms Int64,
  latency_ms Float64, input_tokens UInt64, output_tokens UInt64, cost_usd Float64,
  attributes String CODEC(ZSTD(3)),
  INDEX idx_trace trace_id TYPE bloom_filter GRANULARITY 4
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(toDateTime(intDiv(end_ms, 1000)))
ORDER BY (end_ms, model)
TTL toDateTime(intDiv(end_ms, 1000)) + INTERVAL 30 DAY
```

- **Sorted by end time**, because every dashboard query is a time range.
- **Partitioned by day**, so expiring old data drops whole partitions.
- **TTL** deletes spans after `CLICKHOUSE_TTL_DAYS`. Spans already older than
  that are counted as **rejected** at ingest rather than silently dropped.
- **Model, latency and cost** are computed once at ingest and stored as
  columns; the full attribute map is kept as compressed JSON for the detail
  panel.
- **`LowCardinality`** for repetitive strings, and a **bloom filter** so trace
  ID lookups don't scan everything.
- Percentiles use `quantileExactInclusive`, which interpolates exactly like the
  in-memory backend.

The code is in [`dashboard/src/clickhouse.ts`](../dashboard/src/clickhouse.ts).
It talks to ClickHouse's HTTP interface with plain `fetch` (no driver
dependency) and sends every user-supplied value as a bound query parameter
(`{q:String}`), never as SQL text.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `STORAGE` | `memory` | Set to `clickhouse` |
| `CLICKHOUSE_URL` | `http://localhost:8123` | HTTP interface |
| `CLICKHOUSE_USER` | `default` | User |
| `CLICKHOUSE_PASSWORD` | empty | Password |
| `CLICKHOUSE_DATABASE` | `spanscope` | Created if missing; letters, digits and `_` only |
| `CLICKHOUSE_TTL_DAYS` | `30` | Retention |

For a hosted ClickHouse (for example ClickHouse Cloud), set the URL, user and
password; use an `https://` URL.

## Tests

```bash
cd dashboard
CLICKHOUSE_TEST_URL=http://localhost:8123 npx tsx --test tests/clickhouse.integration.test.ts
```

These tests create a throwaway database, feed identical spans to the
ClickHouse and in-memory backends, check that the overview, roll-ups, span
search and trace lookups match, and drop the database afterwards. Without
`CLICKHOUSE_TEST_URL` they are skipped. CI runs them on every push against a
ClickHouse service container, followed by a smoke test of the server in
ClickHouse mode.

## Notes

- The `accepted` and `rejected` counters in `/healthz` count what the current
  server process received since it started; `held` is the total stored.
- The demo's background traffic (`LIVE_TRAFFIC_PER_MIN`) also writes to
  ClickHouse when it's enabled.
