import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  inWindow,
  querySpans,
  summarize,
  timeseries,
  toView,
  type SpanQuery,
} from "./analytics.js";
import { PRICE_USD_PER_MTOKEN } from "./pricing.js";
import { rollUpByModel } from "./rollup.js";
import { renderDashboardHtml } from "./legacy-dashboard.js";
import type { ObservabilityStore } from "./store.js";

export const MAX_BODY_BYTES = 5 * 1024 * 1024;

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const ASSETS: Record<string, string> = {
  "index.html": "text/html; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
  "charts.js": "text/javascript; charset=utf-8",
  "styles.css": "text/css; charset=utf-8",
};

async function serveAsset(c: Context, file: string) {
  const type = ASSETS[file];
  if (!type) return c.notFound();
  // Read per request so frontend edits show up on reload without a restart.
  const body = await readFile(PUBLIC_DIR + file, "utf8");
  return c.body(body, 200, { "content-type": type, "cache-control": "no-cache" });
}

const WINDOWS_MS: Record<string, number> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
};

function parseWindowMs(w: string | undefined): number {
  return WINDOWS_MS[w ?? "1h"] ?? WINDOWS_MS["1h"]!;
}

/** Build the HTTP app: ingest endpoints, the web app, its JSON API and health checks. */
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

  // ---- web app (static files, fixed whitelist so no path traversal) -------
  app.get("/", (c) => serveAsset(c, "index.html"));
  app.get("/assets/:file", (c) => serveAsset(c, c.req.param("file")));

  // ---- JSON API used by the web app ---------------------------------------
  app.get("/api/overview", (c) => {
    const nowMs = Date.now();
    const windowMs = parseWindowMs(c.req.query("window"));
    const spans = inWindow(store.snapshot(), nowMs, windowMs);
    return c.json({
      nowMs,
      windowMs,
      counters: store.counters(),
      summary: summarize(spans),
      series: timeseries(spans, nowMs, windowMs),
      models: rollUpByModel(spans),
    });
  });

  app.get("/api/models", (c) =>
    c.json({
      models: rollUpByModel(store.snapshot()).map((r) => ({
        ...r,
        errorRate: r.count ? Number((r.errors / r.count).toFixed(4)) : 0,
        price: PRICE_USD_PER_MTOKEN[r.model] ?? null,
      })),
      pricing: PRICE_USD_PER_MTOKEN,
    }),
  );

  app.get("/api/spans", (c) => {
    const status = c.req.query("status");
    const model = c.req.query("model");
    const q = c.req.query("q");
    const query: SpanQuery = {
      limit: Number(c.req.query("limit") ?? 50) || 50,
      offset: Number(c.req.query("offset") ?? 0) || 0,
    };
    if (model) query.model = model;
    if (q) query.q = q;
    if (status === "OK" || status === "ERROR") query.status = status;
    return c.json(querySpans(store.snapshot(), query));
  });

  app.get("/api/traces/:traceId", (c) => {
    const id = c.req.param("traceId").toLowerCase();
    const spans = store
      .snapshot()
      .filter((s) => s.trace_id === id)
      .sort((a, b) => a.start_time_unix_nano - b.start_time_unix_nano)
      .map(toView);
    if (spans.length === 0) return c.json({ error: "not_found" }, 404);
    return c.json({ trace_id: id, spans });
  });

  app.delete("/api/spans", (c) => c.json({ status: "cleared", counters: store.clear() }));

  // ---- legacy server-rendered table ---------------------------------------
  app.get("/dashboard", (c) => c.html(renderDashboardHtml(store)));

  app.get("/dashboard.json", (c) =>
    c.json({
      counters: store.counters(),
      models: rollUpByModel(store.snapshot()),
    }),
  );

  app.get("/healthz", (c) => c.json({ status: "ok", counters: store.counters() }));

  return app;
}
