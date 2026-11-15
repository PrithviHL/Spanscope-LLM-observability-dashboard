/**
 * Runs against a real ClickHouse when CLICKHOUSE_TEST_URL is set (CI starts one
 * as a service container); skipped otherwise. Feeds identical spans to both
 * backends and checks they report the same numbers.
 */
import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import {
  ClickHouseClient,
  ClickHouseRepository,
  type ClickHouseConfig,
} from "../src/clickhouse.js";
import { MemoryRepository } from "../src/repository.js";
import { ObservabilityStore, parseIncoming } from "../src/store.js";
import { DEMO_MODELS, generateSyntheticSpans } from "../src/synthetic.js";

const url = process.env["CLICKHOUSE_TEST_URL"];
const skip = url ? false : "set CLICKHOUSE_TEST_URL to run against a real ClickHouse";

const cfg: ClickHouseConfig = {
  url: url ?? "",
  user: process.env["CLICKHOUSE_TEST_USER"] ?? "default",
  password: process.env["CLICKHOUSE_TEST_PASSWORD"] ?? "",
  database: `spanscope_test_${process.pid}_${Date.now()}`,
  ttlDays: 30,
};

let ch: ClickHouseRepository;
let mem: MemoryRepository;
let now: number;
let sampleTraceId = "";

before(async () => {
  if (skip) return;
  ch = await ClickHouseRepository.connect(cfg);
  mem = new MemoryRepository(new ObservabilityStore(10_000));
  // Validate once so both backends get identical spans: the validator replaces
  // the generator's non-hex IDs with random ones, which would otherwise differ.
  const { spans } = parseIncoming(
    generateSyntheticSpans({ spans: 600, errorRate: 0.05, models: DEMO_MODELS }),
  );
  sampleTraceId = spans[42]!.trace_id;
  now = Date.now() + 1000;
  await ch.ingest(spans);
  await mem.ingest(spans);
});

after(async () => {
  if (skip) return;
  await new ClickHouseClient(cfg).exec(`DROP DATABASE IF EXISTS ${cfg.database}`, {}, null);
});

const byModel = <T extends { model: string }>(xs: T[]) =>
  [...xs].sort((a, b) => a.model.localeCompare(b.model));

test("ClickHouse and memory agree on the overview", { skip }, async () => {
  for (const windowMs of [15 * 60_000, 60 * 60_000]) {
    const a = await ch.overview(now, windowMs);
    const b = await mem.overview(now, windowMs);
    assert.deepEqual(a.summary, b.summary);
    assert.deepEqual(a.series, b.series);
    assert.deepEqual(byModel(a.models), byModel(b.models));
  }
});

test("ClickHouse and memory agree on model roll-ups and counters", { skip }, async () => {
  assert.deepEqual(byModel(await ch.models()), byModel(await mem.models()));
  assert.equal((await ch.counters()).held, 600);
});

test("ClickHouse and memory agree on filtered, paginated span lists", { skip }, async () => {
  for (const q of [
    { limit: 25 },
    { limit: 25, offset: 50 },
    { model: "gpt-5.4", limit: 10 },
    { status: "ERROR" as const, limit: 50 },
    { q: "chat", limit: 50 },
    { q: sampleTraceId.slice(0, 12).toUpperCase(), limit: 50 }, // case-insensitive ID search
  ]) {
    const a = await ch.spans(q);
    const b = await mem.spans(q);
    assert.equal(a.total, b.total, JSON.stringify(q));
    assert.deepEqual(
      a.items.map((s) => [s.span_id, s.latency_ms, s.cost_usd, s.model]),
      b.items.map((s) => [s.span_id, s.latency_ms, s.cost_usd, s.model]),
      JSON.stringify(q),
    );
  }
});

test("trace lookup and clear work", { skip }, async () => {
  const [first] = (await mem.spans({ limit: 1 })).items;
  const trace = await ch.trace(first!.trace_id);
  assert.equal(trace.length, 1);
  assert.equal(trace[0]!.span_id, first!.span_id);
  assert.deepEqual(trace[0]!.attributes, first!.attributes);
  await ch.clear();
  assert.equal((await ch.counters()).held, 0);
});
