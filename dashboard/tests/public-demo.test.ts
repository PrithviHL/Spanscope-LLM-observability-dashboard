import { strict as assert } from "node:assert";
import { test } from "node:test";
import { RateLimiter } from "../src/rate-limit.js";
import { buildApp } from "../src/server.js";
import { ObservabilityStore } from "../src/store.js";
import { DEMO_MODELS, generateLiveSpans } from "../src/synthetic.js";

const span = JSON.stringify({
  attributes: { "gen_ai.system": "openai", "gen_ai.request.model": "gpt-4o-mini" },
});

const post = (app: ReturnType<typeof buildApp>, ip: string) =>
  app.request("/trace", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `${ip}, 10.0.0.1` },
    body: span,
  });

test("demo mode refuses to clear spans and reports itself", async () => {
  const store = new ObservabilityStore(100);
  store.ingest(generateLiveSpans(5));
  const app = buildApp(store, { demo: true });

  assert.deepEqual(await (await app.request("/api/config")).json(), { demo: true });
  const res = await app.request("/api/spans", { method: "DELETE" });
  assert.equal(res.status, 403);
  assert.equal(store.counters().held, 5);
});

test("without demo mode, clearing still works", async () => {
  const store = new ObservabilityStore(100);
  store.ingest(generateLiveSpans(5));
  const app = buildApp(store);
  assert.deepEqual(await (await app.request("/api/config")).json(), { demo: false });
  assert.equal((await app.request("/api/spans", { method: "DELETE" })).status, 200);
  assert.equal(store.counters().held, 0);
});

test("ingest is rate limited per client IP", async () => {
  const app = buildApp(new ObservabilityStore(100), { ingestRateLimitPerMin: 2 });
  assert.equal((await post(app, "1.1.1.1")).status, 202);
  assert.equal((await post(app, "1.1.1.1")).status, 202);
  assert.equal((await post(app, "1.1.1.1")).status, 429);
  // A different client has its own budget.
  assert.equal((await post(app, "2.2.2.2")).status, 202);
});

test("RateLimiter resets after the window", () => {
  const rl = new RateLimiter(1, 1000);
  assert.equal(rl.allow("a", 0), true);
  assert.equal(rl.allow("a", 500), false);
  assert.equal(rl.allow("a", 1000), true);
});

test("generateLiveSpans produces valid spans ending now", () => {
  const now = Date.now();
  const store = new ObservabilityStore(100);
  const spans = generateLiveSpans(20, DEMO_MODELS, now);
  assert.equal(spans.length, 20);
  for (const s of spans) {
    assert.ok(s.end_time_unix_nano <= now * 1e6);
    assert.ok(s.end_time_unix_nano > (now - 2000) * 1e6);
    assert.ok(s.start_time_unix_nano < s.end_time_unix_nano);
  }
  assert.equal(store.ingest(spans).held, 20);
});
