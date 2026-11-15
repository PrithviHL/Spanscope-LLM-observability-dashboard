"""In-memory span store standing in for ClickHouse, with per-user and per-model counters."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import DefaultDict, List

from .spans import Span, Trace


@dataclass
class SpanStore:
    spans: List[Span] = field(default_factory=list)
    by_user: DefaultDict[str, int] = field(default_factory=lambda: defaultdict(int))
    by_model: DefaultDict[str, int] = field(default_factory=lambda: defaultdict(int))
    cost_by_user: DefaultDict[str, float] = field(default_factory=lambda: defaultdict(float))

    def insert_trace(self, trace: Trace) -> None:
        self.spans.extend(trace)
        for s in trace:
            if s.is_llm():
                user = s.attributes.get("user_id", "anon")
                model = s.attributes.get("gen_ai.request.model", "unknown")
                self.by_user[user] += 1
                self.by_model[model] += 1
                self.cost_by_user[user] += s.attributes.get("cost_usd", 0.0)
