import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ClickHouseRepository, type ClickHouseConfig } from "../src/clickhouse.js";
import { buildApp } from "../src/server.js";
import { generateLiveSpans } from "../src/synthetic.js";

type Call = { url: URL; body: string };

/** A stand-in for the ClickHouse HTTP interface that records requests. */
function fakeClickHouse(respond: (sql: string, url: URL) => unknown = () => ({ data: [] })) {
  const calls: Call[] = [];
  const fetchFn = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = String(init?.body ?? "");
    calls.push({ url, body });
    const sql = url.searchParams.get("query") ?? body;
    const out = respond(sql, url);
    return new Response(typeof out === "string" ? out : JSON.stringify(out), { status: 200 });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const cfg = (fetchFn: typeof fetch): ClickHouseConfig => ({
  url: "http://ch.test:8123",
  user: "u",
  password: "p",
  database: "spanscope",
  ttlDays: 30,
  fetch: fetchFn,
});

test("connect creates the database and a MergeTree table with a TTL", async () => {
  const { calls, fetchFn } = fakeClickHouse();
  await ClickHouseRepository.connect(cfg(fetchFn));
  assert.match(calls[0]!.body, /CREATE DATABASE IF NOT EXISTS spanscope/);
  assert.equal(calls[0]!.url.searchParams.get("database"), null);
  assert.match(calls[1]!.body, /CREATE TABLE IF NOT EXISTS spans/);
  assert.match(calls[1]!.body, /ENGINE = MergeTree/);
  assert.match(calls[1]!.body, /INTERVAL 30 DAY/);
  assert.equal(calls[1]!.url.searchParams.get("database"), "spanscope");
});

test("connect rejects unsafe database names", async () => {
  const { fetchFn } = fakeClickHouse();
  await assert.rejects(
    ClickHouseRepository.connect({ ...cfg(fetchFn), database: "x; DROP TABLE y" }),
    /CLICKHOUSE_DATABASE/,
  );
});

test("credentials go in headers, not the URL", async () => {
  const seen: Headers[] = [];
  const fetchFn = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    seen.push(new Headers(init?.headers));
    return new Response(JSON.stringify({ data: [] }));
  }) as typeof fetch;
  await ClickHouseRepository.connect(cfg(fetchFn));
  assert.equal(seen[0]!.get("X-ClickHouse-User"), "u");
  assert.equal(seen[0]!.get("X-ClickHouse-Key"), "p");
});

test("search text is sent as a bound parameter, never inlined into SQL", async () => {
  const { calls, fetchFn } = fakeClickHouse((sql) =>
    sql.includes("count() AS total") ? { data: [{ total: 0 }] } : { data: [] },
  );
  const repo = await ClickHouseRepository.connect(cfg(fetchFn));
  const evil = "x' OR 1=1 --";
  await repo.spans({ q: evil, model: "gpt-4o-mini", status: "ERROR", limit: 9999, offset: -5 });
  const select = calls.find((c) => c.body.includes("ORDER BY end_ns DESC"))!;
  assert.ok(!select.body.includes(evil));
  assert.match(select.body, /\{q:String\}/);
  assert.equal(select.url.searchParams.get("param_q"), evil);
  assert.equal(select.url.searchParams.get("param_model"), "gpt-4o-mini");
  assert.equal(select.url.searchParams.get("param_status"), "ERROR");
  assert.match(select.body, /LIMIT 500 OFFSET 0/); // clamped
});

test("ingest inserts JSONEachRow rows with derived model, latency and cost", async () => {
  const { calls, fetchFn } = fakeClickHouse(() => ({ data: [{ held: 3 }] }));
  const repo = await ClickHouseRepository.connect(cfg(fetchFn));
  const counters = await repo.ingest([...generateLiveSpans(2), { bad: true }]);
  assert.deepEqual(counters, { accepted: 2, rejected: 1, held: 3 });
  const insert = calls.find((c) => c.url.searchParams.get("query")?.startsWith("INSERT"))!;
  const rows = insert.body.split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(typeof r["model"], "string");
    assert.ok((r["latency_ms"] as number) > 0);
    assert.ok((r["cost_usd"] as number) >= 0);
    assert.equal(typeof JSON.parse(r["attributes"] as string), "object");
  }
});

test("trace rows are mapped back to span views", async () => {
  const row = {
    trace_id: "abc",
    span_id: "s1",
    parent_span_id: "",
    name: "chat",
    status: "OK",
    start_ns: 1_000_000_000,
    end_ns: 1_500_000_000,
    attributes: JSON.stringify({
      "gen_ai.system": "openai",
      "gen_ai.request.model": "gpt-4o-mini",
      "gen_ai.usage.input_tokens": 1_000_000,
    }),
  };
  const { fetchFn } = fakeClickHouse((sql) =>
    sql.includes("trace_id = {id:String}") ? { data: [row] } : { data: [] },
  );
  const repo = await ClickHouseRepository.connect(cfg(fetchFn));
  const [view] = await repo.trace("abc");
  assert.equal(view!.model, "gpt-4o-mini");
  assert.equal(view!.latency_ms, 500);
  assert.equal(view!.cost_usd, 0.15);
  assert.equal("parent_span_id" in view!, false);
});

test("health check reports 503 when ClickHouse is down", async () => {
  let up = true;
  const fetchFn = (async () => {
    if (!up) throw new Error("connect ECONNREFUSED");
    return new Response(JSON.stringify({ data: [{ held: 0 }] }));
  }) as typeof fetch;
  const app = buildApp(await ClickHouseRepository.connect(cfg(fetchFn)));
  const ok = await app.request("/healthz");
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { storage: string }).storage, "clickhouse");
  up = false;
  assert.equal((await app.request("/healthz")).status, 503);
  const ingest = await app.request("/trace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(generateLiveSpans(1)),
  });
  assert.equal(ingest.status, 503);
});

test("spans older than the TTL are counted as rejected, not inserted", async () => {
  const { calls, fetchFn } = fakeClickHouse(() => ({ data: [{ held: 1 }] }));
  const repo = await ClickHouseRepository.connect(cfg(fetchFn));
  const old = { ...generateLiveSpans(1)[0]!, start_time_unix_nano: 1e18, end_time_unix_nano: 1e18 };
  const counters = await repo.ingest([old, ...generateLiveSpans(1)]);
  assert.equal(counters.accepted, 1);
  assert.equal(counters.rejected, 1);
  const insert = calls.find((c) => c.url.searchParams.get("query")?.startsWith("INSERT"))!;
  assert.equal(insert.body.split("\n").length, 1);
});
