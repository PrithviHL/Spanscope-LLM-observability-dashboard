/**
 * Spanscope — entry point.
 *
 * Seeds the in-memory store with synthetic OpenTelemetry GenAI spans, prints a
 * per-model roll-up, and (with --serve) starts the HTTP server that hosts the
 * ingest endpoints, the web app and its JSON API.
 *
 * Span schema: OpenTelemetry GenAI semantic conventions
 *   https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */

import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { rollUpByModel } from "./rollup.js";
import { buildApp } from "./server.js";
import { ObservabilityStore } from "./store.js";
import { DEMO_MODELS, generateLiveSpans, generateSyntheticSpans } from "./synthetic.js";
import type { ModelRollup } from "./types.js";

function reportRollups(rollups: ModelRollup[]): void {
  const row = (cells: string[]) => "  " + cells.map((s) => s.padEnd(20)).join("");
  console.log("[spanscope] model roll-ups:");
  console.log(row(["model", "n", "err", "p50", "p95", "p99", "cost($)"]));
  for (const r of rollups) {
    console.log(
      row([
        r.model,
        String(r.count),
        String(r.errors),
        r.p50LatencyMs.toFixed(1),
        r.p95LatencyMs.toFixed(1),
        r.p99LatencyMs.toFixed(1),
        r.costUsd.toFixed(4),
      ]),
    );
  }
}

function main(): void {
  const config = loadConfig();
  const store = new ObservabilityStore(config.capacity);

  if (config.seedSpans > 0) {
    console.log(`[spanscope] generating ${config.seedSpans} synthetic OTel-GenAI spans...`);
    store.ingest(
      generateSyntheticSpans({ spans: config.seedSpans, errorRate: 0.03, models: DEMO_MODELS }),
    );
    reportRollups(rollUpByModel(store.snapshot()));
    console.log("[spanscope] counters:", store.counters());
  }

  if (!config.serve) {
    console.log("[spanscope] run `npm run serve` to start the web app and ingest server");
    return;
  }

  const app = buildApp(store, {
    demo: config.demo,
    ingestRateLimitPerMin: config.ingestRateLimitPerMin,
  });
  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    console.log(`[spanscope] web app on http://${config.host}:${info.port}`);
    console.log(
      `[spanscope] OTLP/HTTP JSON ingest at http://${config.host}:${info.port}/v1/traces`,
    );
  });

  if (config.demo) console.log("[spanscope] public demo mode: clearing spans is disabled");

  // Background traffic keeps the charts moving on a public demo. Spread the
  // per-minute budget over 5-second ticks.
  let traffic: NodeJS.Timeout | undefined;
  if (config.liveTrafficPerMin > 0) {
    const perTick = config.liveTrafficPerMin / 12;
    let carry = 0;
    traffic = setInterval(() => {
      carry += perTick;
      const n = Math.floor(carry);
      carry -= n;
      if (n > 0) store.ingest(generateLiveSpans(n));
    }, 5000);
    traffic.unref();
    console.log(`[spanscope] live demo traffic: ${config.liveTrafficPerMin} spans/min`);
  }

  const shutdown = (signal: string) => {
    if (traffic) clearInterval(traffic);
    console.log(`[spanscope] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

try {
  main();
} catch (err) {
  console.error(`[spanscope] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
