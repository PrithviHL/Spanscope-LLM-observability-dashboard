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
import { GitHubAuth } from "./auth.js";
import { ClickHouseRepository } from "./clickhouse.js";
import { loadConfig, type Config } from "./config.js";
import { MemoryRepository, type SpanRepository } from "./repository.js";
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

async function openRepository(config: Config): Promise<SpanRepository> {
  if (config.storage === "clickhouse") {
    const { url, database } = config.clickhouse;
    console.log(`[spanscope] storage: ClickHouse at ${url} (database "${database}")`);
    return ClickHouseRepository.connect(config.clickhouse);
  }
  console.log(`[spanscope] storage: in memory (newest ${config.capacity} spans)`);
  return new MemoryRepository(new ObservabilityStore(config.capacity));
}

async function main(): Promise<void> {
  const config = loadConfig();
  const repo = await openRepository(config);

  // ClickHouse keeps data across restarts, so only seed an empty table there.
  const alreadyHeld = (await repo.counters()).held;
  if (config.seedSpans > 0 && alreadyHeld === 0) {
    console.log(`[spanscope] generating ${config.seedSpans} synthetic OTel-GenAI spans...`);
    await repo.ingest(
      generateSyntheticSpans({ spans: config.seedSpans, errorRate: 0.03, models: DEMO_MODELS }),
    );
    reportRollups(await repo.models());
    console.log("[spanscope] counters:", await repo.counters());
  } else if (alreadyHeld > 0) {
    console.log(`[spanscope] ${alreadyHeld} spans already stored; skipping demo seed`);
  }

  if (!config.serve) {
    console.log("[spanscope] run `npm run serve` to start the web app and ingest server");
    await repo.close();
    return;
  }

  const auth = config.auth ? new GitHubAuth(config.auth) : null;
  console.log(
    auth
      ? "[spanscope] sign-in: GitHub (viewing is public; writes need sign-in or an ingest key)"
      : "[spanscope] sign-in: off (set GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, SESSION_SECRET to enable)",
  );
  const app = buildApp(repo, {
    auth,
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
      if (n > 0) {
        repo.ingest(generateLiveSpans(n)).catch((err: unknown) => {
          console.error(`[spanscope] live traffic insert failed: ${String(err)}`);
        });
      }
    }, 5000);
    traffic.unref();
    console.log(`[spanscope] live demo traffic: ${config.liveTrafficPerMin} spans/min`);
  }

  const shutdown = (signal: string) => {
    if (traffic) clearInterval(traffic);
    console.log(`[spanscope] ${signal} received, shutting down`);
    server.close(() => {
      repo.close().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error(`[spanscope] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
