import type { Counters, ModelRollup } from "./types.js";

function escapeHtml(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Server-rendered single-table view, kept at /dashboard for scripts and no-JS clients. */
export function renderDashboardHtml(counters: Counters, rollups: ModelRollup[]): string {
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
    "<title>Spanscope</title>",
    "<style>",
    "body{font-family:system-ui,sans-serif;margin:2rem;max-width:1100px;}",
    "table{border-collapse:collapse;width:100%;}",
    "th,td{padding:.4rem .8rem;border-bottom:1px solid #ddd;text-align:left;font-variant-numeric:tabular-nums;}",
    "th{background:#f3f3f3;}",
    ".stats{display:flex;gap:1.5rem;margin-bottom:1rem;}",
    ".stat{background:#fafafa;border:1px solid #ddd;padding:.6rem 1rem;border-radius:6px;}",
    "</style></head><body>",
    "<h1>Spanscope</h1>",
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
