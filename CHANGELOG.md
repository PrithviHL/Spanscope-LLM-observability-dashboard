# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-11-14

### Added

- **Web app** at `/`: an overview with KPIs and charts for requests/errors,
  p50/p95 latency and cost by model (15 min to 24 h windows); a sortable models
  table; a trace explorer with filters, pagination and a detail panel with
  waterfall; and a Send data page with a test-span form, traffic generator, OTLP
  setup snippets and a reset button. Light and dark themes, live refresh every
  5 seconds.
- **JSON API**: `GET /api/overview`, `/api/models`, `/api/spans`,
  `/api/traces/:id`, and `DELETE /api/spans`.
- **OTLP/HTTP JSON ingest** on `POST /v1/traces` (also accepted on `/trace`),
  so OpenTelemetry SDKs can export straight to the server.
- Runtime configuration through `PORT`, `HOST`, `SEED_SPANS`, `BUFFER_CAPACITY`
  and `--serve`, with validation. Graceful shutdown on SIGINT and SIGTERM.
- `llm_obs` Python package with a `python -m llm_obs` CLI (`--traces`,
  `--leak-rate`, `--sample-rate`, `--seed`).
- Tests: 31 TypeScript tests and 15 Python tests.
- Tooling: ESLint, Prettier, `npm run check`, GitHub Actions CI (Node 20/22,
  Python 3.9/3.12), `.editorconfig`, `.nvmrc`, pull request template.
- Documentation: architecture, HTTP API reference, contributing guide and this
  changelog.

### Changed

- New repository layout: `code/ts` → `dashboard/`, `code/main.py` →
  `pipeline/`, the design brief and rubric → `docs/design/`, the diagram →
  `docs/assets/`.
- Dashboard source split into focused modules (`normalise`, `otlp`,
  `ring-buffer`, `store`, `config`, `synthetic`, `legacy-dashboard`).
- Demo spans are spread over the last hour, with a latency regression in the
  final 15%.
- `@hono/node-server` upgraded to v2. Node.js 20 or newer is required.

### Fixed

- A span with a non-string `gen_ai.response.model` made `/dashboard` return 500
  until the span was evicted.
- Ingest mutated the caller's attribute object.
- Request bodies had no size limit; they are now capped at 5 MB (`413`).
- Pipeline drift tracking assumed the LLM span was always second in the trace.

### Removed

- Unused `zod` dependency, which had a high-severity advisory.
  `npm audit --omit=dev` now reports no vulnerabilities.

## [0.1.0]

- Initial TypeScript ingest server with an HTML table dashboard, and a
  single-file Python pipeline demo.
