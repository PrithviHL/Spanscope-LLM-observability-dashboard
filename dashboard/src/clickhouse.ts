/**
 * Optional ClickHouse storage backend (STORAGE=clickhouse).
 *
 * Talks to ClickHouse over its HTTP interface with plain fetch, so there is no
 * driver dependency. Every user-supplied value travels as a bound query
 * parameter ({name:Type} placeholders + param_name URL arguments), never as
 * SQL text. Aggregations (counts, sums, percentiles, time buckets) run inside
 * ClickHouse instead of in JavaScript.
 */

import { toView, type Bucket, type SpanQuery, type SpanView, type Summary } from "./analytics.js";
import { spanCostUsd, spanLatencyMs, spanModel } from "./pricing.js";
import type { Overview, SpanRepository } from "./repository.js";
import { parseIncoming } from "./store.js";
import type { Counters, GenAISpan, ModelRollup } from "./types.js";

export type ClickHouseConfig = {
  /** HTTP interface URL, e.g. http://localhost:8123 */
  url: string;
  user: string;
  password: string;
  database: string;
  /** Spans older than this are deleted by ClickHouse (table TTL). */
  ttlDays: number;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
};

type Params = Record<string, string | number>;

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Minimal client for the ClickHouse HTTP interface. */
export class ClickHouseClient {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly cfg: ClickHouseConfig) {
    this.fetchFn = cfg.fetch ?? fetch;
  }

  private async send(
    query: string,
    params: Params = {},
    body?: string,
    database: string | null = this.cfg.database,
  ): Promise<string> {
    const url = new URL(this.cfg.url);
    if (database) url.searchParams.set("database", database);
    // Return Int64/UInt64 as JSON numbers rather than strings.
    url.searchParams.set("output_format_json_quote_64bit_integers", "0");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(`param_${k}`, String(v));
    // Queries go in the body; for INSERT the data goes in the body and the statement in the URL.
    if (body !== undefined) url.searchParams.set("query", query);
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "X-ClickHouse-User": this.cfg.user,
          "X-ClickHouse-Key": this.cfg.password,
        },
        body: body ?? query,
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 10_000),
      });
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause?.code ?? String(err);
      throw new Error(
        `can't reach ClickHouse at ${url.origin} (${cause}). Is it running? Try \`docker compose up -d\`.`,
      );
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.trim().slice(0, 300)}`);
    return text;
  }

  async query<T>(sql: string, params: Params = {}): Promise<T[]> {
    const text = await this.send(`${sql}\nFORMAT JSON`, params);
    return (JSON.parse(text) as { data: T[] }).data;
  }

  async exec(sql: string, params: Params = {}, database?: string | null): Promise<void> {
    await this.send(sql, params, undefined, database === undefined ? this.cfg.database : database);
  }

  async insert(table: string, rows: object[]): Promise<void> {
    if (rows.length === 0) return;
    await this.send(
      `INSERT INTO ${table} FORMAT JSONEachRow`,
      {},
      rows.map((r) => JSON.stringify(r)).join("\n"),
    );
  }
}

/** One stored span. Derived columns (model, latency, cost) are computed once at ingest. */
type SpanRow = {
  trace_id: string;
  span_id: string;
  parent_span_id: string;
  name: string;
  status: "OK" | "ERROR";
  system: string;
  model: string;
  start_ns: number;
  end_ns: number;
  end_ms: number;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  attributes: string;
};

function toRow(s: GenAISpan): SpanRow {
  const a = s.attributes;
  return {
    trace_id: s.trace_id,
    span_id: s.span_id,
    parent_span_id: s.parent_span_id ?? "",
    name: s.name,
    status: s.status,
    system: String(a["gen_ai.system"]),
    model: spanModel(s),
    start_ns: s.start_time_unix_nano,
    end_ns: s.end_time_unix_nano,
    end_ms: Math.round(s.end_time_unix_nano / 1e6),
    latency_ms: Math.max(0, spanLatencyMs(s)),
    input_tokens: Math.max(0, Math.round(Number(a["gen_ai.usage.input_tokens"] ?? 0))),
    output_tokens: Math.max(0, Math.round(Number(a["gen_ai.usage.output_tokens"] ?? 0))),
    cost_usd: spanCostUsd(s),
    attributes: JSON.stringify(a),
  };
}

type StoredRow = Pick<
  SpanRow,
  | "trace_id"
  | "span_id"
  | "parent_span_id"
  | "name"
  | "status"
  | "start_ns"
  | "end_ns"
  | "attributes"
>;
const STORED_COLUMNS =
  "trace_id, span_id, parent_span_id, name, status, start_ns, end_ns, attributes";

function fromRow(r: StoredRow): SpanView {
  const span: GenAISpan = {
    trace_id: r.trace_id,
    span_id: r.span_id,
    name: r.name,
    start_time_unix_nano: Number(r.start_ns),
    end_time_unix_nano: Number(r.end_ns),
    status: r.status,
    attributes: JSON.parse(r.attributes) as GenAISpan["attributes"],
  };
  if (r.parent_span_id) span.parent_span_id = r.parent_span_id;
  return toView(span);
}

const round = (n: number, d = 2) => Number(Number(n).toFixed(d));

// quantileExactInclusive interpolates between ranks exactly like the in-memory
// percentile(), so both backends report the same numbers. ifNotFinite turns the
// NaN of an empty group into 0.
const q = (p: number) => `ifNotFinite(quantileExactInclusive(${p})(latency_ms), 0)`;

type AggRow = {
  spans: number;
  errors: number;
  cost: number;
  in_tok: number;
  out_tok: number;
  p50: number;
  p95: number;
};
type ModelRow = AggRow & { model: string; p99: number };
type BucketRow = {
  idx: number;
  spans: number;
  errors: number;
  cost: number;
  p50: number;
  p95: number;
};

// Aliases deliberately differ from column names: ClickHouse substitutes aliases
// inside expressions, so "sum(x) AS x" would be a cyclic alias.
const AGG = `count() AS spans, countIf(status = 'ERROR') AS errors, sum(cost_usd) AS cost,
  sum(input_tokens) AS in_tok, sum(output_tokens) AS out_tok,
  ${q(0.5)} AS p50, ${q(0.95)} AS p95`;

const toRollup = (r: ModelRow): ModelRollup => ({
  model: r.model,
  count: Number(r.spans),
  errors: Number(r.errors),
  inputTokens: Number(r.in_tok),
  outputTokens: Number(r.out_tok),
  costUsd: round(r.cost, 4),
  p50LatencyMs: round(r.p50),
  p95LatencyMs: round(r.p95),
  p99LatencyMs: round(r.p99),
});

export class ClickHouseRepository implements SpanRepository {
  readonly kind = "clickhouse" as const;
  private accepted = 0;
  private rejected = 0;

  private constructor(
    private readonly ch: ClickHouseClient,
    private readonly ttlDays: number,
  ) {}

  /** Connect, create the database and table if needed, and return a ready repository. */
  static async connect(cfg: ClickHouseConfig): Promise<ClickHouseRepository> {
    if (!IDENT.test(cfg.database)) throw new Error(`invalid CLICKHOUSE_DATABASE "${cfg.database}"`);
    if (!Number.isInteger(cfg.ttlDays) || cfg.ttlDays < 1) throw new Error("ttlDays must be >= 1");
    const ch = new ClickHouseClient(cfg);
    await ch.exec(`CREATE DATABASE IF NOT EXISTS ${cfg.database}`, {}, null);
    await ch.exec(`
      CREATE TABLE IF NOT EXISTS spans (
        trace_id       String,
        span_id        String,
        parent_span_id String,
        name           LowCardinality(String),
        status         LowCardinality(String),
        system         LowCardinality(String),
        model          LowCardinality(String),
        start_ns       Int64,
        end_ns         Int64,
        end_ms         Int64,
        latency_ms     Float64,
        input_tokens   UInt64,
        output_tokens  UInt64,
        cost_usd       Float64,
        attributes     String CODEC(ZSTD(3)),
        INDEX idx_trace trace_id TYPE bloom_filter GRANULARITY 4
      )
      ENGINE = MergeTree
      PARTITION BY toYYYYMMDD(toDateTime(intDiv(end_ms, 1000)))
      ORDER BY (end_ms, model)
      TTL toDateTime(intDiv(end_ms, 1000)) + INTERVAL ${cfg.ttlDays} DAY`);
    return new ClickHouseRepository(ch, cfg.ttlDays);
  }

  async ingest(raw: unknown): Promise<Counters> {
    const parsed = parseIncoming(raw);
    // ClickHouse drops rows already past the table TTL on insert. Count them as
    // rejected instead of reporting them accepted and losing them silently.
    const cutoffNs = (Date.now() - this.ttlDays * 86_400_000) * 1e6;
    const spans = parsed.spans.filter((s) => s.end_time_unix_nano >= cutoffNs);
    const rejected = parsed.rejected + (parsed.spans.length - spans.length);
    await this.ch.insert("spans", spans.map(toRow));
    this.accepted += spans.length;
    this.rejected += rejected;
    return this.counters();
  }

  async overview(nowMs: number, windowMs: number, buckets = 60): Promise<Overview> {
    // Same windowing as the in-memory backend: spans ending in [now - window, now],
    // bucketed from now - bucketMs * buckets.
    const bucketMs = Math.max(1000, Math.ceil(windowMs / buckets));
    const start = nowMs - bucketMs * buckets;
    const params = { from: nowMs - windowMs, now: nowMs, start, bucket: bucketMs, n: buckets };
    const where = "end_ms >= {from:Int64} AND end_ms <= {now:Int64}";
    const [[agg], bucketRows, modelRows, counters] = await Promise.all([
      this.ch.query<AggRow>(`SELECT ${AGG} FROM spans WHERE ${where}`, params),
      this.ch.query<BucketRow>(
        `SELECT intDiv(end_ms - {start:Int64}, {bucket:Int64}) AS idx, ${AGG}
         FROM spans WHERE ${where} GROUP BY idx HAVING idx >= 0 AND idx < {n:Int64}`,
        params,
      ),
      this.ch.query<ModelRow>(
        `SELECT model, ${AGG}, ${q(0.99)} AS p99 FROM spans WHERE ${where}
         GROUP BY model ORDER BY spans DESC, model`,
        params,
      ),
      this.counters(),
    ]);
    const a = agg ?? { spans: 0, errors: 0, cost: 0, in_tok: 0, out_tok: 0, p50: 0, p95: 0 };
    const summary: Summary = {
      spans: Number(a.spans),
      errors: Number(a.errors),
      errorRate: Number(a.spans) ? round(Number(a.errors) / Number(a.spans), 4) : 0,
      costUsd: round(a.cost, 4),
      inputTokens: Number(a.in_tok),
      outputTokens: Number(a.out_tok),
      p50LatencyMs: round(a.p50),
      p95LatencyMs: round(a.p95),
    };
    const byIdx = new Map(bucketRows.map((r) => [Number(r.idx), r]));
    const series: Bucket[] = Array.from({ length: buckets }, (_, i) => {
      const r = byIdx.get(i);
      return {
        t: start + i * bucketMs,
        count: r ? Number(r.spans) : 0,
        errors: r ? Number(r.errors) : 0,
        costUsd: r ? round(r.cost, 4) : 0,
        p50LatencyMs: r ? round(r.p50) : 0,
        p95LatencyMs: r ? round(r.p95) : 0,
      };
    });
    return { counters, summary, series, models: modelRows.map(toRollup) };
  }

  async models(): Promise<ModelRollup[]> {
    const rows = await this.ch.query<ModelRow>(
      `SELECT model, ${AGG}, ${q(0.99)} AS p99 FROM spans GROUP BY model ORDER BY spans DESC, model`,
    );
    return rows.map(toRollup);
  }

  async spans(query: SpanQuery): Promise<{ total: number; items: SpanView[] }> {
    const conds: string[] = [];
    const params: Params = {};
    if (query.model) {
      conds.push("model = {model:String}");
      params["model"] = query.model;
    }
    if (query.status) {
      conds.push("status = {status:String}");
      params["status"] = query.status;
    }
    const text = query.q?.trim();
    if (text) {
      conds.push(
        "(positionCaseInsensitive(trace_id, {q:String}) > 0 OR positionCaseInsensitive(span_id, {q:String}) > 0 OR positionCaseInsensitive(name, {q:String}) > 0)",
      );
      params["q"] = text;
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    // Clamped integers, so they are safe to inline in LIMIT/OFFSET.
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 500);
    const offset = Math.max(Math.trunc(query.offset ?? 0), 0);
    const [[count], rows] = await Promise.all([
      this.ch.query<{ total: number }>(`SELECT count() AS total FROM spans ${where}`, params),
      this.ch.query<StoredRow>(
        `SELECT ${STORED_COLUMNS} FROM spans ${where} ORDER BY end_ns DESC LIMIT ${limit} OFFSET ${offset}`,
        params,
      ),
    ]);
    return { total: Number(count?.total ?? 0), items: rows.map(fromRow) };
  }

  async trace(traceId: string): Promise<SpanView[]> {
    const rows = await this.ch.query<StoredRow>(
      `SELECT ${STORED_COLUMNS} FROM spans WHERE trace_id = {id:String} ORDER BY start_ns`,
      { id: traceId },
    );
    return rows.map(fromRow);
  }

  async clear(): Promise<Counters> {
    await this.ch.exec("TRUNCATE TABLE IF EXISTS spans");
    this.accepted = 0;
    this.rejected = 0;
    return this.counters();
  }

  async counters(): Promise<Counters> {
    const [row] = await this.ch.query<{ held: number }>("SELECT count() AS held FROM spans");
    return { accepted: this.accepted, rejected: this.rejected, held: Number(row?.held ?? 0) };
  }

  async ping(): Promise<void> {
    await this.ch.query("SELECT 1 AS ok");
  }

  async close(): Promise<void> {}
}
