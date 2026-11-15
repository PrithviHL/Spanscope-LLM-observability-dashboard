# Spanscope dashboard: ingest server and web app (TypeScript)

A [Hono](https://hono.dev) server on Node.js that accepts OpenTelemetry GenAI
spans, keeps the newest 10,000 in memory, and serves a live web app and JSON
API for latency, errors and cost per model.

## Requirements

- Node.js 20 or newer (22 recommended; see the repo's `.nvmrc`)

## Quick start

```bash
cd dashboard
npm install
npm run serve
```

Open http://localhost:8011. The server seeds 1,200 synthetic spans spread over
the last hour. The last 15% have a deliberate latency regression, so the latency
chart has something to show.

## Scripts

| Command                           | What it does                                                   |
| --------------------------------- | -------------------------------------------------------------- |
| `npm run serve`                   | Seed demo data and start the web app and ingest server         |
| `npm run dev`                     | Same, restarting on source changes                             |
| `npm start`                       | Seed demo data, print a per-model roll-up and exit (no server) |
| `npm test`                        | Run the test suite (`node:test` via `tsx`)                     |
| `npm run typecheck`               | Type-check with `tsc`                                          |
| `npm run lint` / `lint:fix`       | ESLint (TypeScript + browser JS)                               |
| `npm run format` / `format:check` | Prettier                                                       |
| `npm run check`                   | Everything CI runs: typecheck, lint, format check and tests    |

## Configuration

| Variable                    | Default                 | Meaning                                                       |
| --------------------------- | ----------------------- | ------------------------------------------------------------- |
| `PORT`                      | `8011`                  | HTTP port                                                     |
| `HOST`                      | `localhost`             | Interface to bind; use `0.0.0.0` to accept remote connections |
| `SEED_SPANS`                | `1200`                  | Synthetic spans to load on start-up; `0` starts empty         |
| `BUFFER_CAPACITY`           | `10000`                 | Spans held in memory; the oldest are evicted first            |
| `DEMO_MODE`                 | unset                   | `1` disables clearing spans (`DELETE /api/spans` returns 403) |
| `LIVE_TRAFFIC_PER_MIN`      | `0`                     | Synthetic spans generated per minute in the background        |
| `INGEST_RATE_LIMIT_PER_MIN` | `0`                     | Ingest requests per client IP per minute; `0` means no limit  |
| `SERVE`                     | unset                   | `1` is the same as passing `--serve`                          |
| `STORAGE`                   | `memory`                | `memory` or `clickhouse` (see below)                          |
| `CLICKHOUSE_URL`            | `http://localhost:8123` | ClickHouse HTTP interface                                     |
| `CLICKHOUSE_USER`           | `default`               | ClickHouse user                                               |
| `CLICKHOUSE_PASSWORD`       | empty                   | ClickHouse password                                           |
| `CLICKHOUSE_DATABASE`       | `spanscope`             | Database, created if missing                                  |
| `CLICKHOUSE_TTL_DAYS`       | `30`                    | ClickHouse deletes spans older than this                      |
| `GITHUB_CLIENT_ID`          | unset                   | GitHub OAuth app client ID; enables sign-in (see below)       |
| `GITHUB_CLIENT_SECRET`      | unset                   | GitHub OAuth app client secret                                |
| `SESSION_SECRET`            | unset                   | 32+ random characters; signs sessions and ingest keys         |
| `PUBLIC_URL`                | from request            | Public origin for the OAuth callback, e.g. `https://x.com`    |

Invalid values stop the server at start-up with a clear message, for example
`PORT must be an integer >= 1, got "abc"`.

## ClickHouse storage (optional)

By default spans live in memory. To keep them across restarts and query them
with SQL:

```bash
docker compose up -d          # from the repository root
```

```bash
cd dashboard && STORAGE=clickhouse npm run serve
```

The [ClickHouse guide](../docs/clickhouse.md) covers setup, stopping and
deleting data, example SQL queries, the table design and the integration
tests.

## Sign in with GitHub (optional)

Off unless `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `SESSION_SECRET` are
set. When on, viewing stays public, but simulating incidents, sending data and
clearing need a signed-in user or a personal ingest key. It's stateless (signed
cookies and keys, no user database). The public demo leaves it off on purpose.
Setup is in the [deployment guide](../docs/deployment.md#sign-in-with-github-optional);
endpoints and ingest keys are in the [API reference](../docs/api.md#sign-in-optional).

## Web app

| Page      | What it shows                                                                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview  | Requests, error rate, spend and p95 latency for 15 min / 1 h / 6 h / 24 h; charts for requests and errors over time, p50/p95 latency, and cost by model |
| Models    | Sortable per-model table: spans, errors, tokens, cost, p50/p95/p99, list price                                                                          |
| Traces    | Newest spans, filterable by model, status and ID; a detail panel with trace waterfall and raw attributes                                                |
| Send data | Send one test span, generate random traffic, copy OTLP settings for a real app, clear all spans                                                         |

The app is plain HTML, CSS and ES modules in `public/`. It needs no build step
and refreshes every 5 seconds.

## Sending real data

Point any OpenTelemetry SDK at the server with the OTLP/HTTP **JSON** exporter
(protobuf is not supported):

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:8011/v1/traces
OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json
```

Spans need `gen_ai.system` and `gen_ai.request.model` attributes; anything else
is rejected and counted. See [`docs/api.md`](../docs/api.md) for every endpoint.

## Source layout

| Path                      | Responsibility                                                           |
| ------------------------- | ------------------------------------------------------------------------ |
| `src/index.ts`            | Entry point: load config, seed data, start the server, shut down cleanly |
| `src/config.ts`           | CLI flag and environment variable parsing with validation                |
| `src/server.ts`           | HTTP routes: ingest, web app assets, JSON API, health                    |
| `src/normalise.ts`        | Validate and normalise one incoming span                                 |
| `src/otlp.ts`             | Flatten OTLP/HTTP JSON export requests into spans                        |
| `src/auth.ts`             | Optional GitHub sign-in: OAuth flow, signed sessions and ingest keys     |
| `src/repository.ts`       | `SpanRepository` interface and the in-memory `MemoryRepository`          |
| `src/clickhouse.ts`       | Optional ClickHouse backend: HTTP client, schema, SQL queries            |
| `src/store.ts`            | `ObservabilityStore` (ingest, counters, snapshot, clear), payload parser |
| `src/ring-buffer.ts`      | Fixed-capacity FIFO buffer                                               |
| `src/analytics.ts`        | Summaries, time buckets and span queries for `/api/*`                    |
| `src/rollup.ts`           | Percentiles and per-model roll-ups                                       |
| `src/pricing.ts`          | Per-model list prices and cost and latency helpers                       |
| `src/synthetic.ts`        | Demo traffic generator                                                   |
| `src/legacy-dashboard.ts` | Server-rendered table at `/dashboard`                                    |
| `src/types.ts`            | Shared types                                                             |
| `public/`                 | Web app (`index.html`, `app.js`, `charts.js`, `styles.css`)              |
| `tests/`                  | Unit, HTTP and (optional) ClickHouse integration tests                   |

## Limitations

- With the default `memory` storage, spans are lost on restart. Use
  `STORAGE=clickhouse` to persist them.
- Without the GitHub settings there is no sign-in, so anyone who can reach the
  server can send data. Keep `HOST=localhost` unless the network is trusted, or
  enable sign-in.
- Costs are estimates from the list prices in `src/pricing.ts`. Unknown models show $0.
