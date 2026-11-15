import { strict as assert } from "node:assert";
import { test } from "node:test";
import { querySpans, summarize, timeseries } from "../src/analytics.js";
import { buildApp } from "../src/server.js";
import { ObservabilityStore } from "../src/store.js";
import type { GenAISpan } from "../src/types.js";

const NOW = 1_800_000_000_000; // fixed "now" in unix ms

function span(
  i: number,
  opts: { model?: string; endMs?: number; latencyMs?: number; error?: boolean } = {},
): GenAISpan {
  const end = (opts.endMs ?? NOW) * 1e6;
  return {
    trace_id: i.toString(16).padStart(32, "0"),
    span_id: i.toString(16).padStart(16, "0"),
    name: "chat.completion",
    start_time_unix_nano: end - (opts.latencyMs ?? 100) * 1e6,
    end_time_unix_nano: end,
    status: opts.error ? "ERROR" : "OK",
    attributes: {
      "gen_ai.system": "openai",
      "gen_ai.request.model": opts.model ?? "gpt-4o-mini",
      "gen_ai.operation.name": "chat",
      "gen_ai.usage.input_tokens": 1_000_000,
      "gen_ai.usage.output_tokens": 0,
    },
  };
}

test("summarize computes totals, error rate and cost", () => {
  const s = summarize([span(1), span(2, { error: true }), span(3), span(4)]);
  assert.equal(s.spans, 4);
  assert.equal(s.errors, 1);
  assert.equal(s.errorRate, 0.25);
  assert.equal(s.costUsd, 0.6); // 4 x 1M input tokens x $0.15
});

test("summarize of nothing is all zeros", () => {
  const s = summarize([]);
  assert.equal(s.spans, 0);
  assert.equal(s.errorRate, 0);
  assert.equal(s.p95LatencyMs, 0);
});

test("timeseries puts spans in the right bucket and keeps empty buckets", () => {
  const hour = 60 * 60_000;
  const spans = [
    span(1, { endMs: NOW - 30_000 }), // last minute
    span(2, { endMs: NOW - 30_000, error: true }),
    span(3, { endMs: NOW - hour + 30_000 }), // first minute
    span(4, { endMs: NOW - 2 * hour }), // outside the window
  ];
  const series = timeseries(spans, NOW, hour);
  assert.equal(series.length, 60);
  assert.equal(series.at(-1)?.count, 2);
  assert.equal(series.at(-1)?.errors, 1);
  assert.equal(series[0]?.count, 1);
  assert.equal(
    series.reduce((a, b) => a + b.count, 0),
    3,
  );
});

test("querySpans filters, sorts newest first and paginates", () => {
  const spans = [
    span(1, { endMs: NOW - 3000, model: "a" }),
    span(2, { endMs: NOW - 1000, model: "b", error: true }),
    span(3, { endMs: NOW - 2000, model: "a" }),
  ];
  const all = querySpans(spans, {});
  assert.deepEqual(
    all.items.map((s) => s.span_id.slice(-1)),
    ["2", "3", "1"],
  );
  assert.equal(querySpans(spans, { model: "a" }).total, 2);
  assert.equal(querySpans(spans, { status: "ERROR" }).items[0]?.model, "b");
  const page = querySpans(spans, { limit: 1, offset: 1 });
  assert.equal(page.total, 3);
  assert.equal(page.items[0]?.span_id.slice(-1), "3");
  assert.equal(querySpans(spans, { q: "0000000000000003" }).total, 1);
});

test("web app and API routes respond", async () => {
  const store = new ObservabilityStore();
  store.ingest([span(1, { endMs: Date.now() }), span(2, { endMs: Date.now(), error: true })]);
  const app = buildApp(store);

  const html = await app.request("/");
  assert.equal(html.status, 200);
  assert.match(await html.text(), /<script type="module" src="\/assets\/app.js">/);
  for (const f of ["app.js", "charts.js", "styles.css"]) {
    assert.equal((await app.request(`/assets/${f}`)).status, 200, f);
  }
  assert.equal((await app.request("/assets/..%2Fpackage.json")).status, 404);
  assert.equal((await app.request("/assets/secret.txt")).status, 404);

  const ov = (await (await app.request("/api/overview?window=15m")).json()) as {
    summary: { spans: number; errors: number };
    series: unknown[];
  };
  assert.equal(ov.summary.spans, 2);
  assert.equal(ov.summary.errors, 1);
  assert.equal(ov.series.length, 60);

  const list = (await (await app.request("/api/spans?status=ERROR")).json()) as { total: number };
  assert.equal(list.total, 1);

  const trace = await app.request(`/api/traces/${span(1).trace_id}`);
  assert.equal(trace.status, 200);
  assert.equal((await app.request("/api/traces/ffff")).status, 404);

  const cleared = await app.request("/api/spans", { method: "DELETE" });
  assert.equal(cleared.status, 200);
  assert.deepEqual(store.counters(), { accepted: 0, rejected: 0, held: 0 });
});
