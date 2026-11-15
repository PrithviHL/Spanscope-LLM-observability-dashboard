# LLM Observability & Eval Dashboard

Self-hosted observability platform for production LLM applications.

## Quick start (what's runnable in this repo)

| Path | What it is | Run |
|---|---|---|
| `code/ts/` | Hono ingest server + web app: accepts GenAI spans (flat JSON or OTLP/HTTP JSON at `/v1/traces`), 10k ring buffer, live overview charts, per-model table, trace explorer, test-data tools | `cd code/ts && npm install && npm run serve`, then open http://localhost:8011 |
| `code/main.py` | Stdlib Python pipeline: tail sampler, eval spans (faithfulness / toxicity / PII), PSI drift, alerter, with an injected PII regression | `python3 code/main.py` |

Requires Node.js 20+ and Python 3.9+. Tests: `cd code/ts && npm run typecheck && npm test`.

The sections below describe the full target architecture (ClickHouse, Postgres,
Next.js, Alertmanager); those pieces are not implemented in this repo yet. The
in-memory store above stands in for them.

## What it does
- Ingests OpenTelemetry GenAI spans from OpenAI, Anthropic, Google GenAI, LangChain, LlamaIndex, and vLLM
- Stores spans in ClickHouse for columnar analytics; metadata in Postgres
- Runs scheduled eval jobs (DeepEval, RAGAS, custom LLM-judge) over sampled traces
- Detects prompt-distribution drift via PSI / KL divergence on embeddings
- Alerts via Prometheus Alertmanager → Slack / PagerDuty
- Dashboard: Next.js 15 + Recharts (cost/user, latency, toxicity trends, drift)

## Stack
| Layer | Technology |
|---|---|
| Ingest | OpenTelemetry SDK + GenAI semconv, OTLP HTTP |
| Collector | OTel Collector with tail-sampling |
| Storage | ClickHouse (spans), Postgres (metadata), S3 (archive) |
| Evals | DeepEval, RAGAS 0.2, custom LLM-judge |
| Drift | sentence-transformers + PSI/KL weekly job |
| Alerting | Prometheus Alertmanager → Slack / PagerDuty |
| UI | Next.js 15 App Router + Recharts |
