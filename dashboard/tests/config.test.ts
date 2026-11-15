import { strict as assert } from "node:assert";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { DEMO_MODELS, generateSyntheticSpans } from "../src/synthetic.js";

test("loadConfig uses defaults when nothing is set", () => {
  assert.deepEqual(loadConfig([], {}), {
    serve: false,
    host: "localhost",
    port: 8011,
    seedSpans: 1200,
    capacity: 10_000,
    demo: false,
    liveTrafficPerMin: 0,
    ingestRateLimitPerMin: 0,
  });
});

test("loadConfig reads the --serve flag and environment variables", () => {
  const cfg = loadConfig(["--serve"], { PORT: "9000", SEED_SPANS: "0", HOST: "0.0.0.0" });
  assert.equal(cfg.serve, true);
  assert.equal(cfg.port, 9000);
  assert.equal(cfg.seedSpans, 0);
  assert.equal(cfg.host, "0.0.0.0");
  assert.equal(loadConfig([], { SERVE: "1" }).serve, true);
  const pub = loadConfig([], {
    DEMO_MODE: "1",
    LIVE_TRAFFIC_PER_MIN: "20",
    INGEST_RATE_LIMIT_PER_MIN: "60",
  });
  assert.equal(pub.demo, true);
  assert.equal(pub.liveTrafficPerMin, 20);
  assert.equal(pub.ingestRateLimitPerMin, 60);
});

test("loadConfig rejects invalid numbers", () => {
  assert.throws(() => loadConfig([], { PORT: "abc" }), /PORT/);
  assert.throws(() => loadConfig([], { PORT: "0" }), /PORT/);
  assert.throws(() => loadConfig([], { SEED_SPANS: "-1" }), /SEED_SPANS/);
});

test("synthetic spans cover every model inside the last hour", () => {
  const before = Date.now();
  const spans = generateSyntheticSpans({ spans: 100, errorRate: 0.1, models: DEMO_MODELS });
  assert.equal(spans.length, 100);
  assert.deepEqual(
    new Set(spans.map((s) => s.attributes["gen_ai.request.model"])),
    new Set(DEMO_MODELS),
  );
  for (const s of spans) {
    const endMs = s.end_time_unix_nano / 1e6;
    assert.ok(endMs <= Date.now() + 1 && endMs >= before - 60 * 60_000 - 1);
    assert.ok(s.end_time_unix_nano > s.start_time_unix_nano);
  }
  assert.ok(spans.some((s) => s.status === "ERROR"));
});

test("synthetic generator rejects an empty model list", () => {
  assert.throws(() => generateSyntheticSpans({ spans: 1, errorRate: 0, models: [] }));
});
