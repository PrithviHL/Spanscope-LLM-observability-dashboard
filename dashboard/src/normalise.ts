import { randomBytes } from "node:crypto";
import type { GenAISpan } from "./types.js";

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

export function normaliseSpan(raw: unknown): GenAISpan | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const rawAttrs = r["attributes"];
  if (
    rawAttrs !== undefined &&
    (typeof rawAttrs !== "object" || rawAttrs === null || Array.isArray(rawAttrs))
  ) {
    return null;
  }
  const attrs: Record<string, unknown> = { ...(rawAttrs as Record<string, unknown> | undefined) };
  if (typeof attrs["gen_ai.system"] !== "string") return null;
  if (typeof attrs["gen_ai.request.model"] !== "string") return null;
  // Timestamps are optional. With neither, the span is stamped with the time it
  // arrived; with only one, the other is set equal to it (zero latency).
  const rawStart = r["start_time_unix_nano"];
  const rawEnd = r["end_time_unix_nano"];
  const hasStart = rawStart !== undefined && rawStart !== null;
  const hasEnd = rawEnd !== undefined && rawEnd !== null;
  const start = hasStart ? Number(rawStart) : hasEnd ? Number(rawEnd) : Date.now() * 1e6;
  const end = hasEnd ? Number(rawEnd) : start;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (end < start) return null;
  for (const key of TOKEN_KEYS) {
    if (!validTokenField(attrs[key])) return null;
  }
  // A non-string response model would later crash the dashboard renderer;
  // drop it so the request model is used instead.
  if (
    attrs["gen_ai.response.model"] !== undefined &&
    (typeof attrs["gen_ai.response.model"] !== "string" || attrs["gen_ai.response.model"] === "")
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
