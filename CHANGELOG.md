# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] - 2026-11-15

### Added

- Documentation: a [user guide](docs/user-guide.md), [deployment
  guide](docs/deployment.md), [ClickHouse guide](docs/clickhouse.md) and a
  record of [design decisions](docs/decisions.md); README with screenshots,
  a feature list and a 30-second walkthrough.

- Optional **Sign in with GitHub** (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
  `SESSION_SECRET`, `PUBLIC_URL`). Viewing stays public; simulating incidents,
  sending data and clearing need a signed-in user. Stateless: HMAC-signed
  session cookies (HttpOnly, SameSite=Lax, Secure on HTTPS) and a signed OAuth
  `state`; no GitHub scopes requested and no access token stored.
- Personal **ingest keys** (`POST /api/keys`, `Authorization: Bearer ssk_…`)
  so apps and OpenTelemetry exporters can send data when sign-in is on.
- Web app: Sign in button and account menu, sign-in prompts on gated actions,
  an ingest key generator that fills in the setup snippets, palette commands.
- `GET /api/me`. Writes return `401` with a sign-in hint when sign-in is on.
- Render Blueprint: `PUBLIC_URL`, generated `SESSION_SECRET`, and GitHub
  values to fill in on the dashboard.
- Optional **ClickHouse storage** (`STORAGE=clickhouse`): spans persist across
  restarts in a day-partitioned `MergeTree` table with a TTL, and the overview,
  model roll-ups, span search and trace lookups run as SQL inside ClickHouse.
  No driver dependency (HTTP interface via `fetch`); all user input is sent as
  bound query parameters. Configured with `CLICKHOUSE_URL`, `CLICKHOUSE_USER`,
  `CLICKHOUSE_PASSWORD`, `CLICKHOUSE_DATABASE` and `CLICKHOUSE_TTL_DAYS`.
- `docker-compose.yml` to run ClickHouse locally.
- `SpanRepository` interface, so routes no longer depend on the in-memory store.
- `/healthz` returns `503` when the storage backend is unreachable; ingest
  returns `503` on storage errors. `/api/config` reports the storage backend,
  and the web app footer shows it.
- Tests: ClickHouse backend unit tests, and integration tests that check the
  ClickHouse and in-memory backends return identical results. CI runs them
  against a real ClickHouse service container, plus a server smoke test.

- Redesigned web app: Inter typography, glass header, soft background glow,
  staggered entrance animations and charts that draw in on first load; full
  light and dark themes with a circular theme-switch transition.
- Overview: a welcome banner with a one-click **Simulate an incident** button,
  KPI tiles with count-up numbers and sparklines, and a live stream of the
  newest requests.
- Command palette (⌘K / Ctrl+K) for navigation, actions, model and trace
  search, plus keyboard shortcuts (`g o/m/t/s`, `/`, `i`, `p`, `t`).
- Provider colour dots, inline cost and latency bars, highlighted new rows,
  skeleton loaders, a status filter toggle and copy buttons in the span detail.
- Respects `prefers-reduced-motion`.
- Public demo deployment: a Render Blueprint (`render.yaml`), `DEMO_MODE`
  (clearing spans returns 403 and the Reset card is hidden),
  `INGEST_RATE_LIMIT_PER_MIN` (per-IP ingest limit, `429` when exceeded),
  `LIVE_TRAFFIC_PER_MIN` (background synthetic traffic) and `GET /api/config`.

### Changed

- The project is now called **Spanscope** (web app title and header, package
  names and docs). The Python import name stays `llm_obs`, and the GitHub repo
  and Render URL are unchanged.
- CI actions upgraded to v7 (checkout, setup-node, setup-python), which run on
  Node.js 24 and clear the Node.js 20 deprecation warnings.

### Fixed

- A span sent without timestamps was stored at 1 January 1970, so it never
  appeared on any chart (and ClickHouse expired it immediately). It is now
  stamped with the time it was received.
- CI: the Python 3.9 job failed because `ubuntu-latest` (now Ubuntu 26.04)
  has no Python 3.9 build. Python jobs now run on Ubuntu 24.04.

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
