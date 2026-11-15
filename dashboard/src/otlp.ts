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
