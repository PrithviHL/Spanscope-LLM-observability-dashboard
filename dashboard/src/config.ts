/** Runtime configuration, read from CLI flags and environment variables. */
export type StorageKind = "memory" | "clickhouse";

export type AuthSettings = {
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
  publicUrl?: string;
};

export type Config = {
  /** GitHub sign-in; null when GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET aren't set. */
  auth: AuthSettings | null;
  /** Where spans live: an in-memory ring buffer (default) or ClickHouse. */
  storage: StorageKind;
  clickhouse: {
    url: string;
    user: string;
    password: string;
    database: string;
    ttlDays: number;
  };
  /** Start the HTTP server (otherwise print a roll-up and exit). */
  serve: boolean;
  host: string;
  port: number;
  /** Number of synthetic spans to seed on start-up (0 disables seeding). */
  seedSpans: number;
  /** Ring buffer capacity: the newest N spans are kept in memory. */
  capacity: number;
  /** Public demo: disables destructive endpoints such as clearing all spans. */
  demo: boolean;
  /** Synthetic spans generated per minute in the background (0 disables it). */
  liveTrafficPerMin: number;
  /** Ingest requests allowed per client IP per minute (0 disables the limit). */
  ingestRateLimitPerMin: number;
};

function intFrom(value: string | undefined, fallback: number, name: string, min = 0): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${name} must be an integer >= ${min}, got "${value}"`);
  }
  return n;
}

function authFrom(env: NodeJS.ProcessEnv): AuthSettings | null {
  const clientId = env["GITHUB_CLIENT_ID"] || "";
  const clientSecret = env["GITHUB_CLIENT_SECRET"] || "";
  const sessionSecret = env["SESSION_SECRET"] || "";
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret) {
    throw new Error("set both GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to enable sign-in");
  }
  if (sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters when sign-in is enabled");
  }
  const publicUrl = env["PUBLIC_URL"] || "";
  if (publicUrl && !/^https?:\/\/[^/]+\/?$/.test(publicUrl)) {
    throw new Error(`PUBLIC_URL must be an origin like https://example.com, got "${publicUrl}"`);
  }
  const auth: AuthSettings = { clientId, clientSecret, sessionSecret };
  if (publicUrl) auth.publicUrl = publicUrl;
  return auth;
}

export function loadConfig(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Config {
  const storage = (env["STORAGE"] || "memory").toLowerCase();
  if (storage !== "memory" && storage !== "clickhouse") {
    throw new Error(`STORAGE must be "memory" or "clickhouse", got "${env["STORAGE"]}"`);
  }
  return {
    auth: authFrom(env),
    storage,
    clickhouse: {
      url: env["CLICKHOUSE_URL"] || "http://localhost:8123",
      user: env["CLICKHOUSE_USER"] || "default",
      password: env["CLICKHOUSE_PASSWORD"] ?? "",
      database: env["CLICKHOUSE_DATABASE"] || "spanscope",
      ttlDays: intFrom(env["CLICKHOUSE_TTL_DAYS"], 30, "CLICKHOUSE_TTL_DAYS", 1),
    },
    serve: argv.includes("--serve") || env["SERVE"] === "1",
    host: env["HOST"] || "localhost",
    port: intFrom(env["PORT"], 8011, "PORT", 1),
    seedSpans: intFrom(env["SEED_SPANS"], 1200, "SEED_SPANS"),
    capacity: intFrom(env["BUFFER_CAPACITY"], 10_000, "BUFFER_CAPACITY", 1),
    demo: env["DEMO_MODE"] === "1",
    liveTrafficPerMin: intFrom(env["LIVE_TRAFFIC_PER_MIN"], 0, "LIVE_TRAFFIC_PER_MIN"),
    ingestRateLimitPerMin: intFrom(
      env["INGEST_RATE_LIMIT_PER_MIN"],
      0,
      "INGEST_RATE_LIMIT_PER_MIN",
    ),
  };
}
