# LLM observability dashboard (TypeScript skeleton)

Multi-file TypeScript skeleton for the LLM observability dashboard capstone.
A Hono server accepts OpenTelemetry GenAI spans, holds them in a 10k ring
buffer, and renders p50/p95/p99 latency and per-model cost.

## Layout

- `src/index.ts` — entry point, seeds synthetic spans and optionally serves HTTP.
- `src/server.ts` — Hono routes: ingest (`/trace`, `/v1/traces` OTLP/HTTP JSON), the web app (`/`, `/assets/*`), the JSON API (`/api/*`), plus `/dashboard`, `/dashboard.json`, `/healthz`. Request bodies are capped at 5 MB.
- `src/analytics.ts` — summaries, time buckets and span queries behind `/api/*`.
- `public/` — the web app (`index.html`, `app.js`, `charts.js`, `styles.css`).
- `src/spans.ts` — `RingBuffer` and `ObservabilityStore` (10k spans by default).
- `src/rollup.ts` — `percentile` and `rollUpByModel`.
- `src/pricing.ts` — 2026 per-model prices and cost helpers.
- `src/types.ts` — shared types.
- `tests/*.test.ts` — `node --test` style tests via `tsx`.

## Install

```bash
npm install
```

## Run

```bash
npm start         # seeds 1200 synthetic spans and prints the rollup
npm run serve     # also serves the HTTP ingest + dashboard on PORT (default 8011)
```

Then open **http://localhost:8011** for the web app (the old one-table view is still at `/dashboard`).

## Web app

A dependency-free single-page app in `public/` (served by the same Hono server, no build step;
edits show up on browser reload). It refreshes every 5 seconds and has light and dark themes.

- **Overview**: requests, error rate, spend and p95 latency for the last 15 min / 1 h / 6 h / 24 h,
  with charts for requests and errors over time, p50/p95 latency, and cost by model.
- **Models**: sortable per-model table (spans, errors, tokens, cost, p50/p95/p99, list price).
  Click a row to see that model's traces.
- **Traces**: newest spans first, filterable by model, status and ID. Click one for its details,
  trace waterfall and raw attributes.
- **Send data**: send a single test span, generate random traffic, copy the OTLP settings
  for a real app, or clear all spans.

The 1,200 sample spans are spread over the last hour, and the final 15% carry a latency
regression so there's something to spot on the latency chart.

### API used by the web app

| Method | Path                                                   | Returns                                        |
| ------ | ------------------------------------------------------ | ---------------------------------------------- |
| GET    | `/api/overview?window=15m\|1h\|6h\|24h`                | summary, 60 time buckets, per-model roll-ups   |
| GET    | `/api/models`                                          | per-model roll-ups with error rate and pricing |
| GET    | `/api/spans?model=&status=OK\|ERROR&q=&limit=&offset=` | `{ total, items }`, newest first               |
| GET    | `/api/traces/:traceId`                                 | every held span in that trace                  |
| DELETE | `/api/spans`                                           | clears the store and counters                  |

## Send spans

Flat GenAI span(s), single object or array:

```bash
curl -XPOST localhost:8011/trace -H 'content-type: application/json' \
  -d '{"start_time_unix_nano":0,"end_time_unix_nano":900000000,"attributes":{"gen_ai.system":"openai","gen_ai.request.model":"gpt-4o-mini","gen_ai.usage.input_tokens":120,"gen_ai.usage.output_tokens":40}}'
```

From a real OpenTelemetry SDK, point the OTLP/HTTP **JSON** exporter at the server
(protobuf encoding is not supported):

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:8011/v1/traces
OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json
```

## Verify

```bash
npm run typecheck
npm test
```

## Spec references

- Source lesson: `phases/19-capstone-projects/11-llm-observability-dashboard/docs/en.md`
- [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
