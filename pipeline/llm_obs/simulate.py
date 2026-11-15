"""Synthetic chatbot traffic for the demo, with an optional PII-leak regression."""

from __future__ import annotations

import random
import time

from .spans import Span, Trace

MODELS = ("claude-sonnet-4-7", "gpt-5-4", "gemini-3-pro")
USERS = ("u_01", "u_02", "u_03", "u_04")
PROMPTS = (
    "what is the weather in Tokyo today",
    "summarize the recent Tokyo forecast",
    "give me a travel tip for Tokyo",
    "how warm is Tokyo this week",
)
GOOD_RESPONSE = "the weather in Tokyo is mild"
LEAKY_RESPONSE = "your ssn is 123-45-6789"  # fake SSN used to trigger the PII eval
CONTEXT = "relevant weather context Tokyo mild"


def synth_trace(trace_id: str, leak_pii: bool, rng: random.Random) -> Trace:
    """One chat turn: a root span plus one LLM-call child span."""
    model = rng.choice(MODELS)
    user = rng.choice(USERS)
    root = Span(
        trace_id=trace_id,
        span_id=f"{trace_id}_0",
        parent_span_id=None,
        name="chat_turn",
        start_ms=int(time.time() * 1000),
        duration_ms=rng.randint(400, 2400),
        attributes={"app_id": "chatbot"},
    )
    prompt = rng.choice(PROMPTS)
    llm = Span(
        trace_id=trace_id,
        span_id=f"{trace_id}_1",
        parent_span_id=root.span_id,
        name="llm_call",
        start_ms=root.start_ms + 50,
        duration_ms=root.duration_ms - 80,
        attributes={
            "gen_ai.system": model.split("-")[0],
            "gen_ai.request.model": model,
            "gen_ai.usage.input_tokens": rng.randint(80, 800),
            "gen_ai.usage.output_tokens": rng.randint(20, 300),
            "user_id": user,
            "prompt": prompt,
            "response": LEAKY_RESPONSE if leak_pii else GOOD_RESPONSE,
            "context": CONTEXT,
            "cost_usd": round(rng.uniform(0.002, 0.05), 4),
        },
    )
    return [root, llm]
