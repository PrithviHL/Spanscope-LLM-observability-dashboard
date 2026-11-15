# Design decisions

Short records of the choices that shape Spanscope: what was decided, why, and
what it costs. Newest decisions are at the bottom.

## 1. In-memory storage by default, ClickHouse optional

**Decision.** Routes talk to a `SpanRepository` interface with two
implementations: an in-memory ring buffer (default) and ClickHouse
(`STORAGE=clickhouse`).

**Why.** In memory needs no infrastructure, so the demo runs free on Render and
anyone can `npm run serve`. ClickHouse is the production answer for trace
data: append-only, highly compressible, and queried with time-bucketed
aggregates and percentiles, which is what a columnar database is built for.

**Trade-off.** The hosted demo forgets data on every restart. Two backends must
stay consistent, which an integration test enforces (decision 3).

## 2. No ClickHouse driver

**Decision.** `clickhouse.ts` uses ClickHouse's HTTP interface with `fetch`.
Every user-supplied value is a bound query parameter (`{name:Type}` plus
`param_name`), never part of the SQL text. Identifiers that can't be bound
(the database name) are validated against `^[A-Za-z_][A-Za-z0-9_]*$`.

**Why.** No new runtime dependency or supply-chain surface, and SQL injection
is ruled out by construction rather than by escaping.

## 3. Both backends must return identical numbers

**Decision.** ClickHouse percentiles use `quantileExactInclusive`, which
interpolates between ranks exactly like the in-memory `percentile()`. Windows
and bucket boundaries are computed the same way. CI feeds identical spans to
both backends and compares the overview, roll-ups, span lists and trace
lookups.

**Why.** Switching storage must not change what the dashboard reports.

**Trade-off.** Exact quantiles cost more memory than ClickHouse's approximate
`quantile()` on very large windows; switch if that ever matters.

## 4. A dependency-free front end

**Decision.** The web app is plain HTML, CSS and ES modules with hand-written
SVG charts. No framework, bundler or build step.

**Why.** The server can serve the files as they are, there's nothing to keep
updated, and it loads fast on a cold-started free instance.

**Trade-off.** More code to write by hand for things like the command palette.

## 5. Demo protections instead of accounts

**Decision.** The public demo runs with `DEMO_MODE=1` (no clearing data), a
per-IP ingest rate limit of 60 requests a minute, and 30 synthetic spans a
minute of background traffic.

**Why.** Strangers can use every feature without being able to wipe the demo
for others or flood it, and the charts never go empty.

## 6. Stateless GitHub sign-in

**Decision.** Optional Sign in with GitHub, with HMAC-signed session cookies,
a signed OAuth `state` cookie and signed ingest keys. No user database. No
GitHub scopes are requested, and the access token is discarded after reading
the public profile.

**Why.** Render's free plan has no persistent storage, so stored accounts would
vanish whenever the server sleeps. Signed tokens need no storage. Email and
password would need a database, password resets and breach handling.

**Trade-off.** Individual keys or sessions can't be revoked; rotating
`SESSION_SECRET` revokes all of them. Spans aren't separated per user.

## 7. The public demo has no sign-in

**Decision** (15 November 2026). Sign-in stays switched off on the public
demo. Anyone can simulate incidents, send data and use every page without an
account.

**Why.** The demo is shared on LinkedIn for recruiters. Many don't have a
GitHub account, and any sign-in step loses visitors before they reach the
interesting part. Decision 5 already limits abuse.

**Trade-off.** Anyone can send data to the shared demo. The sign-in code stays
in the repository, tested, and can be turned on by setting two environment
variables ([deployment.md](deployment.md#sign-in-with-github-optional)).

## 8. Render for hosting

**Decision.** Host the demo on Render's free plan from a Blueprint
(`render.yaml`), auto-deploying from `main`.

**Why.** It runs a long-lived Node process from the GitHub repository at no
cost. GitHub Pages only serves static files, and serverless platforms such as
Vercel don't keep in-memory state between requests.

**Trade-off.** Cold starts of 30–60 seconds after 15 idle minutes, and no
persistent disk.

## 9. Spans without timestamps get their arrival time

**Decision.** A span with no timestamps is stamped with the time it arrived;
with only one timestamp, the other is set equal to it.

**Why.** Missing timestamps used to default to 0 (1970), so such spans never
appeared on any chart, and ClickHouse expired them immediately while the API
reported them as accepted. Found by the ClickHouse smoke test in CI.

## 10. The name Spanscope

**Decision.** The project, repository (`Spanscope-LLM-observability-dashboard`)
and Render service (`spanscope-llm-observability-dashboard`) are named
Spanscope: a scope for spans, the unit of trace data it collects. The Python
import name stays `llm_obs` to avoid breaking imports.

**Consequence.** Render can't rename a service's URL, so the service was
recreated under the new name and the old one deleted. GitHub redirects the old
repository URL.
