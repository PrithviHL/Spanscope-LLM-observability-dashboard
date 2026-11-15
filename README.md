# LLM Observability & Eval Dashboard

Self-hosted observability for LLM applications. It ingests OpenTelemetry GenAI
spans, shows latency, errors and cost per model in a live web app, and includes
a reference pipeline for tail sampling, evals, drift detection and alerting.

[![CI](https://github.com/PrithviHL/llm-observability-dashboard/actions/workflows/ci.yml/badge.svg)](https://github.com/PrithviHL/llm-observability-dashboard/actions/workflows/ci.yml)

**[▶ Live demo](https://llm-observability-dashboard-mthw.onrender.com/)**: runs on
Render's free plan, so the first visit may take up to a minute while it wakes.

## What's inside

| Directory | What it is | Stack |
|---|---|---|
| [`dashboard/`](dashboard/) | Ingest server (flat JSON and OTLP/HTTP JSON), in-memory span store, JSON API and web app with overview charts, model table, trace explorer and test-data tools | Node.js 20+, TypeScript, Hono |
| [`pipeline/`](pipeline/) | Tail sampler, eval spans (faithfulness, toxicity, PII), PSI drift detector and alerting, with a demo that catches an injected PII leak | Python 3.9+, standard library only |
| [`docs/`](docs/) | Architecture, API reference and the original design brief | Markdown |

## Deploy a public demo

The repo includes a [Render](https://render.com) Blueprint ([`render.yaml`](render.yaml)).
In Render, choose **New → Blueprint**, select this repository and deploy. It runs
the web app in public demo mode: clearing data is disabled, ingest is rate
limited per visitor, and a trickle of synthetic traffic keeps the charts live.
On the free plan the service sleeps after 15 minutes idle and takes about a
minute to wake.

## Quick start

**Web app** (needs Node.js 20 or newer):

```bash
cd dashboard
npm install
npm run serve
```

Open http://localhost:8011. It starts with an hour of synthetic traffic. To
send your own, use the **Send data** page or point an OpenTelemetry SDK at
`http://localhost:8011/v1/traces` with `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json`.

**Pipeline demo** (needs Python 3.9 or newer, no packages):

```bash
cd pipeline
python3 -m llm_obs
```

## Development

Run every check before opening a pull request. CI runs the same commands.

```bash
cd dashboard && npm run check
```

```bash
cd pipeline && python3 -m unittest discover -s tests
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, conventions and the release
process.

## Documentation

- [Architecture](docs/architecture.md): how the pieces fit, and how they map to
  the target production stack
- [HTTP API](docs/api.md): every endpoint, payload and status code
- [Dashboard README](dashboard/README.md): configuration, scripts, source layout
- [Pipeline README](pipeline/README.md): demo options and modules
- [Design brief](docs/design/capstone-spec.md) and
  [assessment rubric](docs/design/assessment-rubric.md): the original target
  specification
- [Changelog](CHANGELOG.md)

## Project status

This is a working prototype. The ingest server, web app and pipeline run and
are tested. The production pieces from the design brief are not built yet:
ClickHouse/Postgres storage, model-based eval jobs, Alertmanager integration,
and a link between the dashboard and the pipeline.
[docs/architecture.md](docs/architecture.md#target-production-architecture)
shows what is a stand-in and what's next.

Spans live in memory only, and the server has no authentication. Run it on
localhost or a trusted network.
