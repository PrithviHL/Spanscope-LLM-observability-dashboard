import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { SpanQuery } from "./analytics.js";
import { renderDashboardHtml } from "./legacy-dashboard.js";
import { PRICE_USD_PER_MTOKEN } from "./pricing.js";
import { RateLimiter } from "./rate-limit.js";
import { MemoryRepository, type SpanRepository } from "./repository.js";
import { ObservabilityStore } from "./store.js";

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

export type AppOptions = {
  /** Public demo: refuse destructive requests such as clearing all spans. */
  demo?: boolean;
  /** Ingest requests allowed per client IP per minute (0 or unset: no limit). */
  ingestRateLimitPerMin?: number;
};

/** Client IP as seen behind a reverse proxy (first X-Forwarded-For entry). */
function clientKey(c: Context): string {
  const fwd = c.req.header("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";
}

/** Build the HTTP app: ingest endpoints, the web app, its JSON API and health checks. */
export function buildApp(
  source: SpanRepository | ObservabilityStore,
  options: AppOptions = {},
): Hono {
  const repo = source instanceof ObservabilityStore ? new MemoryRepository(source) : source;
  const app = new Hono();
  const demo = options.demo ?? false;
  const limiter = options.ingestRateLimitPerMin
    ? new RateLimiter(options.ingestRateLimitPerMin)
    : null;

  const limit = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ error: "payload_too_large" }, 413),
  });

  const ingestHandler = async (c: Context) => {
    if (limiter && !limiter.allow(clientKey(c))) {
      return c.json(
        { error: "rate_limited", message: "Too many requests, try again in a minute" },
        429,
      );
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err) {
      return c.json({ error: "bad_request", message: String(err) }, 400);
    }
    try {
      const counters = await repo.ingest(body);
      return c.json({ status: "accepted", counters }, 202);
    } catch (err) {
      return c.json({ error: "storage_unavailable", message: String(err) }, 503);
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
  app.get("/api/overview", async (c) => {
    const nowMs = Date.now();
    const windowMs = parseWindowMs(c.req.query("window"));
    return c.json({ nowMs, windowMs, ...(await repo.overview(nowMs, windowMs)) });
  });

  app.get("/api/models", async (c) =>
    c.json({
      models: (await repo.models()).map((r) => ({
        ...r,
        errorRate: r.count ? Number((r.errors / r.count).toFixed(4)) : 0,
        price: PRICE_USD_PER_MTOKEN[r.model] ?? null,
      })),
      pricing: PRICE_USD_PER_MTOKEN,
    }),
  );

  app.get("/api/spans", async (c) => {
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
    return c.json(await repo.spans(query));
  });

  app.get("/api/traces/:traceId", async (c) => {
    const id = c.req.param("traceId").toLowerCase();
    const spans = await repo.trace(id);
    if (spans.length === 0) return c.json({ error: "not_found" }, 404);
    return c.json({ trace_id: id, spans });
  });

  app.get("/api/config", (c) => c.json({ demo, storage: repo.kind }));

  app.delete("/api/spans", async (c) => {
    if (demo) {
      return c.json(
        { error: "forbidden", message: "Clearing is disabled in the public demo" },
        403,
      );
    }
    return c.json({ status: "cleared", counters: await repo.clear() });
  });

  // ---- legacy server-rendered table ---------------------------------------
  app.get("/dashboard", async (c) =>
    c.html(renderDashboardHtml(await repo.counters(), await repo.models())),
  );

  app.get("/dashboard.json", async (c) =>
    c.json({ counters: await repo.counters(), models: await repo.models() }),
  );

  app.get("/healthz", async (c) => {
    try {
      await repo.ping();
      return c.json({ status: "ok", storage: repo.kind, counters: await repo.counters() });
    } catch (err) {
      return c.json({ status: "error", storage: repo.kind, message: String(err) }, 503);
    }
  });

  // A storage backend that is down should answer with JSON, not a bare 500 page.
  app.onError((err, c) =>
    c.json(
      { error: "server_error", message: err instanceof Error ? err.message : String(err) },
      500,
    ),
  );

  return app;
}
