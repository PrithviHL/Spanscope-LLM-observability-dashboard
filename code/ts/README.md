# LLM observability dashboard (TypeScript skeleton)

Multi-file TypeScript skeleton for the LLM observability dashboard capstone.
A Hono server accepts OpenTelemetry GenAI spans, holds them in a 10k ring
buffer, and renders p50/p95/p99 latency and per-model cost.

## Layout

- `src/index.ts` — entry point, seeds synthetic spans and optionally serves HTTP.
- `src/server.ts` — Hono routes for `/trace`, `/v1/traces` (OTLP/HTTP JSON), `/`, `/dashboard`, `/dashboard.json`, `/healthz`. Request bodies are capped at 5 MB.
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

Then open http://localhost:8011/dashboard (auto-refreshes every 5s).

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
