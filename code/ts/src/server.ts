import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { rollUpByModel } from "./rollup.js";
import type { ObservabilityStore } from "./spans.js";

export const MAX_BODY_BYTES = 5 * 1024 * 1024;

function escapeHtml(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildApp(store: ObservabilityStore): Hono {
  const app = new Hono();

  const limit = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ error: "payload_too_large" }, 413),
  });

  const ingestHandler = async (c: Context) => {
    try {
      const body = await c.req.json();
      const counters = store.ingest(body);
      return c.json({ status: "accepted", counters }, 202);
    } catch (err) {
      return c.json({ error: "bad_request", message: String(err) }, 400);
    }
  };

  // Flat GenAI span(s) or an OTLP/HTTP JSON export request.
  app.post("/trace", limit, ingestHandler);
  // Standard OTLP/HTTP path, so an OTel exporter can point straight at this server.
  app.post("/v1/traces", limit, ingestHandler);

  app.get("/", (c) => c.html(renderDashboardHtml(store)));
  app.get("/dashboard", (c) => c.html(renderDashboardHtml(store)));

  app.get("/dashboard.json", (c) =>
    c.json({
      counters: store.counters(),
      models: rollUpByModel(store.snapshot()),
    }),
  );

  app.get("/healthz", (c) =>
    c.json({ status: "ok", counters: store.counters() }),
  );

  return app;
}

export function renderDashboardHtml(store: ObservabilityStore): string {
  const rollups = rollUpByModel(store.snapshot());
  const counters = store.counters();
  const rows = rollups
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.model)}</td><td>${r.count}</td><td>${r.errors}</td>` +
        `<td>${r.inputTokens}</td><td>${r.outputTokens}</td>` +
        `<td>$${r.costUsd.toFixed(4)}</td>` +
        `<td>${r.p50LatencyMs}</td><td>${r.p95LatencyMs}</td><td>${r.p99LatencyMs}</td></tr>`,
    )
    .join("\n");
  return [
    "<!doctype html>",
    "<html><head><meta charset='utf-8'><meta http-equiv='refresh' content='5'>",
    "<title>LLM observability dashboard</title>",
    "<style>",
    "body{font-family:system-ui,sans-serif;margin:2rem;max-width:1100px;}",
    "table{border-collapse:collapse;width:100%;}",
    "th,td{padding:.4rem .8rem;border-bottom:1px solid #ddd;text-align:left;font-variant-numeric:tabular-nums;}",
    "th{background:#f3f3f3;}",
    ".stats{display:flex;gap:1.5rem;margin-bottom:1rem;}",
    ".stat{background:#fafafa;border:1px solid #ddd;padding:.6rem 1rem;border-radius:6px;}",
    "</style></head><body>",
    "<h1>LLM observability dashboard</h1>",
    "<div class='stats'>",
    `<div class='stat'><b>${counters.accepted}</b> spans accepted</div>`,
    `<div class='stat'>${counters.held} in ring buffer</div>`,
    `<div class='stat'>${counters.rejected} rejected</div>`,
    "</div>",
    "<table><thead><tr>",
    "<th>model</th><th>spans</th><th>errors</th><th>input tok</th><th>output tok</th>",
    "<th>cost</th><th>p50 ms</th><th>p95 ms</th><th>p99 ms</th>",
    "</tr></thead><tbody>",
    rows,
    "</tbody></table>",
    "<p><small>POST OTel-GenAI spans to /trace or OTLP/HTTP JSON to /v1/traces. JSON roll-up at /dashboard.json. Auto-refreshes every 5s.</small></p>",
    "</body></html>",
  ].join("\n");
}
