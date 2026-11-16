/* global process, crypto, performance, fetch, console */
// Spanscope ingest load test: OTLP/HTTP JSON exports to /v1/traces.
// Usage: node bench/load.mjs <url> [spansPerRequest=100] [seconds=10] [connections=32]
// Start the server without a rate limit first (the default), e.g. `npm run serve`.
const [url, batch = "100", seconds = "10", conc = "32"] = process.argv.slice(2);
const B = +batch,
  T = +seconds * 1000,
  C = +conc;
const hex = (n) =>
  [...crypto.getRandomValues(new Uint8Array(n))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
const models = ["gpt-4o-mini", "gpt-5.4", "claude-3-5-sonnet", "claude-opus-4-7", "gemini-2-5-pro"];
function body() {
  const now = BigInt(Date.now()) * 1000000n;
  const spans = Array.from({ length: B }, (_, i) => ({
    traceId: hex(16),
    spanId: hex(8),
    name: "chat",
    startTimeUnixNano: String(now - 900000000n),
    endTimeUnixNano: String(now),
    status: { code: i % 33 === 0 ? 2 : 1 },
    attributes: [
      { key: "gen_ai.system", value: { stringValue: "openai" } },
      { key: "gen_ai.request.model", value: { stringValue: models[i % 5] } },
      { key: "gen_ai.usage.input_tokens", value: { intValue: String(100 + i) } },
      { key: "gen_ai.usage.output_tokens", value: { intValue: String(40 + i) } },
    ],
  }));
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "loadtest" } }] },
        scopeSpans: [{ spans }],
      },
    ],
  });
}
const bodies = Array.from({ length: 50 }, body); // pre-built so the client isn't the bottleneck
let ok = 0,
  fail = 0,
  k = 0;
const lat = [];
const end = performance.now() + T;
async function worker() {
  while (performance.now() < end) {
    const t0 = performance.now();
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bodies[k++ % bodies.length],
      });
      await r.arrayBuffer();
      if (r.status === 202) ok++;
      else fail++;
    } catch {
      fail++;
    }
    lat.push(performance.now() - t0);
  }
}
const t0 = performance.now();
await Promise.all(Array.from({ length: C }, worker));
const secs = (performance.now() - t0) / 1000;
lat.sort((a, b) => a - b);
const q = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))].toFixed(1);
console.log(
  JSON.stringify({
    batch: B,
    conc: C,
    requests_per_sec: Math.round(ok / secs),
    spans_per_sec: Math.round((ok * B) / secs),
    failed: fail,
    p50_ms: +q(0.5),
    p99_ms: +q(0.99),
  }),
);
