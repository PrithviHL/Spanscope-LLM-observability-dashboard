import type { GenAISpan } from "./types.js";

export type SyntheticConfig = {
  spans: number;
  errorRate: number;
  models: string[];
};

export const DEMO_MODELS = [
  "gpt-4o-mini",
  "gpt-5.4",
  "claude-3-5-sonnet",
  "claude-opus-4-7",
  "gemini-2-5-pro",
];

/**
 * Deterministic demo traffic: spans spread evenly over the last hour across the
 * given models, with a fixed error rate and a latency regression in the final 15%.
 */
export function generateSyntheticSpans(cfg: SyntheticConfig): GenAISpan[] {
  if (cfg.models.length === 0) {
    throw new Error("generateSyntheticSpans: cfg.models must not be empty");
  }
  // Spread spans evenly over the last hour so time-series charts have data.
  const nowNs = Date.now() * 1e6;
  const spacingNs = (60 * 60 * 1e9) / Math.max(1, cfg.spans);
  const out: GenAISpan[] = [];
  for (let i = 0; i < cfg.spans; i++) {
    const model = cfg.models[i % cfg.models.length]!;
    if (!model) continue;
    // The last 15% of traffic carries a latency regression, so the demo has
    // something to spot on the latency chart.
    const regression = i > cfg.spans * 0.85 ? 1.6 : 1;
    const baseLatencyMs = Math.round((400 + ((i * 31) % 1800)) * regression);
    const endNs = nowNs - (cfg.spans - 1 - i) * spacingNs;
    const inputTokens = 200 + ((i * 17) % 4000);
    const outputTokens = 120 + ((i * 23) % 800);
    const isError = i % Math.max(1, Math.round(1 / cfg.errorRate)) === 0 && i > 0;
    out.push({
      trace_id: `trace-${i.toString(16).padStart(8, "0")}`,
      span_id: `span-${i.toString(16).padStart(8, "0")}`,
      name: "chat.completion",
      start_time_unix_nano: endNs - baseLatencyMs * 1e6,
      end_time_unix_nano: endNs,
      status: isError ? "ERROR" : "OK",
      attributes: {
        "gen_ai.system": model.startsWith("gpt")
          ? "openai"
          : model.startsWith("claude")
            ? "anthropic"
            : "google",
        "gen_ai.request.model": model,
        "gen_ai.response.model": model,
        "gen_ai.operation.name": "chat",
        "gen_ai.usage.input_tokens": inputTokens,
        "gen_ai.usage.output_tokens": isError ? 0 : outputTokens,
        "gen_ai.response.finish_reasons": [isError ? "error" : "stop"],
      },
    });
  }
  return out;
}
