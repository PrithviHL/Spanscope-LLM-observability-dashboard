import { randomBytes } from "node:crypto";
import type { Counters, GenAISpan } from "./types.js";

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;

function canonicalTraceId(s: unknown): string {
  if (typeof s === "string") {
    const norm = s.replace(/-/g, "").toLowerCase();
    if (TRACE_ID_RE.test(norm)) return norm;
  }
  return randomBytes(16).toString("hex");
}

function canonicalSpanId(s: unknown): string {
  if (typeof s === "string") {
    const norm = s.replace(/-/g, "").toLowerCase();
    if (SPAN_ID_RE.test(norm)) return norm;
  }
  return randomBytes(8).toString("hex");
}

function validTokenField(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  const n = Number(v);
  return Number.isFinite(n) && Number.isInteger(n) && n >= 0;
}

const TOKEN_KEYS = [
  "gen_ai.request.prompt_tokens",
  "gen_ai.usage.input_tokens",
  "gen_ai.request.completion_tokens",
  "gen_ai.usage.output_tokens",
  "gen_ai.usage.total_tokens",
];

export class RingBuffer<T> {
  private readonly capacity: number;
  private readonly slots: (T | undefined)[];
  private writeIdx = 0;
  private filled = false;

  constructor(capacity: number) {
    if (capacity <= 0) throw new Error("capacity must be > 0");
    this.capacity = capacity;
    this.slots = new Array<T | undefined>(capacity);
  }

  push(item: T): void {
    this.slots[this.writeIdx] = item;
    this.writeIdx = (this.writeIdx + 1) % this.capacity;
    if (this.writeIdx === 0) this.filled = true;
  }

  size(): number {
    return this.filled ? this.capacity : this.writeIdx;
  }

  isFull(): boolean {
    return this.filled;
  }

  snapshot(): T[] {
    if (!this.filled) return this.slots.slice(0, this.writeIdx) as T[];
    return [
      ...(this.slots.slice(this.writeIdx) as T[]),
      ...(this.slots.slice(0, this.writeIdx) as T[]),
    ];
  }
}

export function normaliseSpan(raw: unknown): GenAISpan | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const rawAttrs = r["attributes"];
  if (rawAttrs !== undefined && (typeof rawAttrs !== "object" || rawAttrs === null || Array.isArray(rawAttrs))) {
    return null;
  }
  const attrs: Record<string, unknown> = { ...(rawAttrs as Record<string, unknown> | undefined) };
  if (typeof attrs["gen_ai.system"] !== "string") return null;
  if (typeof attrs["gen_ai.request.model"] !== "string") return null;
  const start = Number(r["start_time_unix_nano"] ?? 0);
  const end = Number(r["end_time_unix_nano"] ?? start);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (end < start) return null;
  for (const key of TOKEN_KEYS) {
    if (!validTokenField(attrs[key])) return null;
  }
  // A non-string response model would later crash the dashboard renderer;
  // drop it so the request model is used instead.
  if (
    attrs["gen_ai.response.model"] !== undefined &&
    (typeof attrs["gen_ai.response.model"] !== "string" ||
      attrs["gen_ai.response.model"] === "")
  ) {
    delete attrs["gen_ai.response.model"];
  }
  if (typeof attrs["gen_ai.operation.name"] !== "string") {
    attrs["gen_ai.operation.name"] = "chat";
  }
  const span: GenAISpan = {
    trace_id: canonicalTraceId(r["trace_id"]),
    span_id: canonicalSpanId(r["span_id"]),
    name: typeof r["name"] === "string" ? r["name"] : "chat.completion",
    start_time_unix_nano: start,
    end_time_unix_nano: end,
    status: r["status"] === "ERROR" ? "ERROR" : "OK",
    attributes: attrs as GenAISpan["attributes"],
  };
  if (typeof r["parent_span_id"] === "string") {
    const pid = canonicalSpanId(r["parent_span_id"]);
    span.parent_span_id = pid;
  }
  return span;
}

// ---------------------------------------------------------------------------
// OTLP/HTTP JSON support: what real OpenTelemetry exporters POST to /v1/traces
// https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding
// ---------------------------------------------------------------------------

type OtlpKeyValue = { key?: unknown; value?: unknown };

function decodeAnyValue(v: unknown): unknown {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if ("stringValue" in o) return o["stringValue"];
  if ("boolValue" in o) return o["boolValue"];
  // int64 is encoded as a decimal string in OTLP JSON
  if ("intValue" in o) return Number(o["intValue"]);
  if ("doubleValue" in o) return Number(o["doubleValue"]);
  if ("arrayValue" in o) {
    const values = (o["arrayValue"] as { values?: unknown[] } | null)?.values;
    return Array.isArray(values) ? values.map(decodeAnyValue) : [];
  }
  if ("kvlistValue" in o) {
    const values = (o["kvlistValue"] as { values?: unknown[] } | null)?.values;
    return decodeAttributes(values);
  }
  return undefined;
}

function decodeAttributes(list: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(list)) return out;
  for (const kv of list as OtlpKeyValue[]) {
    if (kv && typeof kv.key === "string") out[kv.key] = decodeAnyValue(kv.value);
  }
  return out;
}

function isOtlpError(status: unknown): boolean {
  if (!status || typeof status !== "object") return false;
  const code = (status as Record<string, unknown>)["code"];
  return code === 2 || code === "STATUS_CODE_ERROR";
}

export function isOtlpPayload(raw: unknown): boolean {
  return (
    !!raw &&
    typeof raw === "object" &&
    Array.isArray((raw as Record<string, unknown>)["resourceSpans"])
  );
}

/** Flatten an OTLP ExportTraceServiceRequest into the flat span shape normaliseSpan expects. */
export function flattenOtlp(raw: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (!isOtlpPayload(raw)) return out;
  for (const rs of (raw as { resourceSpans: unknown[] }).resourceSpans) {
    if (!rs || typeof rs !== "object") continue;
    const resourceAttrs = decodeAttributes(
      (rs as { resource?: { attributes?: unknown } }).resource?.attributes,
    );
    const scopeSpans = (rs as { scopeSpans?: unknown }).scopeSpans;
    if (!Array.isArray(scopeSpans)) continue;
    for (const ss of scopeSpans) {
      const spans = (ss as { spans?: unknown } | null)?.spans;
      if (!Array.isArray(spans)) continue;
      for (const s of spans) {
        if (!s || typeof s !== "object") continue;
        const o = s as Record<string, unknown>;
        const flat: Record<string, unknown> = {
          trace_id: o["traceId"],
          span_id: o["spanId"],
          name: o["name"],
          start_time_unix_nano: o["startTimeUnixNano"],
          end_time_unix_nano: o["endTimeUnixNano"],
          status: isOtlpError(o["status"]) ? "ERROR" : "OK",
          attributes: { ...resourceAttrs, ...decodeAttributes(o["attributes"]) },
        };
        if (typeof o["parentSpanId"] === "string" && o["parentSpanId"] !== "") {
          flat["parent_span_id"] = o["parentSpanId"];
        }
        out.push(flat);
      }
    }
  }
  return out;
}

export class ObservabilityStore {
  private readonly spans: RingBuffer<GenAISpan>;
  private accepted = 0;
  private rejected = 0;

  constructor(capacity = 10_000) {
    this.spans = new RingBuffer<GenAISpan>(capacity);
  }

  ingest(raw: unknown): Counters {
    const items = isOtlpPayload(raw)
      ? flattenOtlp(raw)
      : Array.isArray(raw)
        ? raw
        : [raw];
    for (const item of items) {
      const span = normaliseSpan(item);
      if (!span) {
        this.rejected += 1;
        continue;
      }
      this.spans.push(span);
      this.accepted += 1;
    }
    return this.counters();
  }

  snapshot(): GenAISpan[] {
    return this.spans.snapshot();
  }

  counters(): Counters {
    return {
      accepted: this.accepted,
      rejected: this.rejected,
      held: this.spans.size(),
    };
  }
}
