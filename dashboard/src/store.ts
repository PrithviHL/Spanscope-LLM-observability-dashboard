import { normaliseSpan } from "./normalise.js";
import { flattenOtlp, isOtlpPayload } from "./otlp.js";
import { RingBuffer } from "./ring-buffer.js";
import type { Counters, GenAISpan } from "./types.js";

/** In-memory span store: validates incoming spans and keeps the newest N in a ring buffer. */
export class ObservabilityStore {
  private readonly spans: RingBuffer<GenAISpan>;
  private accepted = 0;
  private rejected = 0;

  constructor(capacity = 10_000) {
    this.spans = new RingBuffer<GenAISpan>(capacity);
  }

  ingest(raw: unknown): Counters {
    const items = isOtlpPayload(raw) ? flattenOtlp(raw) : Array.isArray(raw) ? raw : [raw];
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

  /** Drop all held spans and reset counters. */
  clear(): Counters {
    this.spans.clear();
    this.accepted = 0;
    this.rejected = 0;
    return this.counters();
  }

  counters(): Counters {
    return {
      accepted: this.accepted,
      rejected: this.rejected,
      held: this.spans.size(),
    };
  }
}
