import {
  inWindow,
  querySpans,
  summarize,
  timeseries,
  toView,
  type Bucket,
  type SpanQuery,
  type SpanView,
  type Summary,
} from "./analytics.js";
import { rollUpByModel } from "./rollup.js";
import type { ObservabilityStore } from "./store.js";
import type { Counters, ModelRollup } from "./types.js";

export type Overview = {
  counters: Counters;
  summary: Summary;
  series: Bucket[];
  models: ModelRollup[];
};

/**
 * Storage backend behind the HTTP API. Everything is async so a database-backed
 * implementation (ClickHouse) can sit behind the same routes as the in-memory one.
 */
export interface SpanRepository {
  readonly kind: "memory" | "clickhouse";
  /** Validate and store an ingest payload (flat span(s) or OTLP/HTTP JSON). */
  ingest(raw: unknown): Promise<Counters>;
  /** KPIs, time buckets and per-model roll-ups for spans ending in (now - window, now]. */
  overview(nowMs: number, windowMs: number, buckets?: number): Promise<Overview>;
  /** Per-model roll-ups across everything held. */
  models(): Promise<ModelRollup[]>;
  /** Newest first, filtered and paginated. */
  spans(query: SpanQuery): Promise<{ total: number; items: SpanView[] }>;
  /** Every held span of one trace, in start-time order. */
  trace(traceId: string): Promise<SpanView[]>;
  clear(): Promise<Counters>;
  counters(): Promise<Counters>;
  /** Throws if the backend is unreachable (used by /healthz). */
  ping(): Promise<void>;
  close(): Promise<void>;
}

/** The default backend: a fixed-size in-memory ring buffer. */
export class MemoryRepository implements SpanRepository {
  readonly kind = "memory" as const;

  constructor(readonly store: ObservabilityStore) {}

  async ingest(raw: unknown): Promise<Counters> {
    return this.store.ingest(raw);
  }

  async overview(nowMs: number, windowMs: number, buckets = 60): Promise<Overview> {
    const spans = inWindow(this.store.snapshot(), nowMs, windowMs);
    return {
      counters: this.store.counters(),
      summary: summarize(spans),
      series: timeseries(spans, nowMs, windowMs, buckets),
      models: rollUpByModel(spans),
    };
  }

  async models(): Promise<ModelRollup[]> {
    return rollUpByModel(this.store.snapshot());
  }

  async spans(query: SpanQuery) {
    return querySpans(this.store.snapshot(), query);
  }

  async trace(traceId: string): Promise<SpanView[]> {
    return this.store
      .snapshot()
      .filter((s) => s.trace_id === traceId)
      .sort((a, b) => a.start_time_unix_nano - b.start_time_unix_nano)
      .map(toView);
  }

  async clear(): Promise<Counters> {
    return this.store.clear();
  }

  async counters(): Promise<Counters> {
    return this.store.counters();
  }

  async ping(): Promise<void> {}

  async close(): Promise<void> {}
}
