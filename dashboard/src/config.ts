/** Runtime configuration, read from CLI flags and environment variables. */
export type Config = {
  /** Start the HTTP server (otherwise print a roll-up and exit). */
  serve: boolean;
  host: string;
  port: number;
  /** Number of synthetic spans to seed on start-up (0 disables seeding). */
  seedSpans: number;
  /** Ring buffer capacity: the newest N spans are kept in memory. */
  capacity: number;
};

function intFrom(value: string | undefined, fallback: number, name: string, min = 0): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${name} must be an integer >= ${min}, got "${value}"`);
  }
  return n;
}

export function loadConfig(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Config {
  return {
    serve: argv.includes("--serve") || env["SERVE"] === "1",
    host: env["HOST"] || "localhost",
    port: intFrom(env["PORT"], 8011, "PORT", 1),
    seedSpans: intFrom(env["SEED_SPANS"], 1200, "SEED_SPANS"),
    capacity: intFrom(env["BUFFER_CAPACITY"], 10_000, "BUFFER_CAPACITY", 1),
  };
}
