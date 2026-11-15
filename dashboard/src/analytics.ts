import { spanCostUsd, spanLatencyMs, spanModel } from "./pricing.js";
import { percentile } from "./rollup.js";
import type { GenAISpan } from "./types.js";

export type Summary = {
  spans: number;
  errors: number;
  errorRate: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
};

export type Bucket = {
  /** bucket start, unix ms */
  t: number;
  count: number;
  errors: number;
  costUsd: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
};

export type SpanView = GenAISpan & {
  model: string;
  latency_ms: number;
  cost_usd: number;
};

const round = (n: number, d = 2) => Number(n.toFixed(d));

export function spanEndMs(s: GenAISpan): number {
  return s.end_time_unix_nano / 1e6;
}

export function inWindow(spans: GenAISpan[], nowMs: number, windowMs: number): GenAISpan[] {
  const from = nowMs - windowMs;
  return spans.filter((s) => {
    const t = spanEndMs(s);
    return t >= from && t <= nowMs;
  });
}

export function summarize(spans: GenAISpan[]): Summary {
  const lat = spans.map(spanLatencyMs).sort((a, b) => a - b);
  let errors = 0;
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const s of spans) {
    if (s.status === "ERROR") errors += 1;
    costUsd += spanCostUsd(s);
    inputTokens += Number(s.attributes["gen_ai.usage.input_tokens"] ?? 0);
    outputTokens += Number(s.attributes["gen_ai.usage.output_tokens"] ?? 0);
  }
  return {
    spans: spans.length,
    errors,
    errorRate: spans.length ? round(errors / spans.length, 4) : 0,
    costUsd: round(costUsd, 4),
    inputTokens,
    outputTokens,
    p50LatencyMs: round(percentile(lat, 0.5)),
    p95LatencyMs: round(percentile(lat, 0.95)),
  };
}

/** Fixed-width time buckets covering [nowMs - windowMs, nowMs). Empty buckets are included. */
export function timeseries(
  spans: GenAISpan[],
  nowMs: number,
  windowMs: number,
  buckets = 60,
): Bucket[] {
  const bucketMs = Math.max(1000, Math.ceil(windowMs / buckets));
  const start = nowMs - bucketMs * buckets;
  const groups: GenAISpan[][] = Array.from({ length: buckets }, () => []);
  for (const s of spans) {
    const idx = Math.floor((spanEndMs(s) - start) / bucketMs);
    if (idx >= 0 && idx < buckets) groups[idx]!.push(s);
  }
  return groups.map((g, i) => {
    const lat = g.map(spanLatencyMs).sort((a, b) => a - b);
    return {
      t: start + i * bucketMs,
      count: g.length,
      errors: g.filter((s) => s.status === "ERROR").length,
      costUsd: round(
        g.reduce((acc, s) => acc + spanCostUsd(s), 0),
        4,
      ),
      p50LatencyMs: round(percentile(lat, 0.5)),
      p95LatencyMs: round(percentile(lat, 0.95)),
    };
  });
}

export function toView(s: GenAISpan): SpanView {
  return {
    ...s,
    model: spanModel(s),
    latency_ms: round(spanLatencyMs(s)),
    cost_usd: round(spanCostUsd(s), 6),
  };
}

export type SpanQuery = {
  model?: string;
  status?: "OK" | "ERROR";
  q?: string;
  limit?: number;
  offset?: number;
};

/** Newest first, filtered and paginated. */
export function querySpans(
  spans: GenAISpan[],
  query: SpanQuery,
): { total: number; items: SpanView[] } {
  const q = query.q?.trim().toLowerCase();
  const filtered = spans.filter((s) => {
    if (query.model && spanModel(s) !== query.model) return false;
    if (query.status && s.status !== query.status) return false;
    if (
      q &&
      !s.trace_id.includes(q) &&
      !s.span_id.includes(q) &&
      !s.name.toLowerCase().includes(q)
    ) {
      return false;
    }
    return true;
  });
  filtered.sort((a, b) => b.end_time_unix_nano - a.end_time_unix_nano);
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
  const offset = Math.max(query.offset ?? 0, 0);
  return {
    total: filtered.length,
    items: filtered.slice(offset, offset + limit).map(toView),
  };
}
