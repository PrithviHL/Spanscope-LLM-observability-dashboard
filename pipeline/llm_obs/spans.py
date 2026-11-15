"""Span model using OpenTelemetry GenAI semantic-convention attribute names."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class Span:
    trace_id: str
    span_id: str
    parent_span_id: Optional[str]
    name: str
    start_ms: int
    duration_ms: int
    attributes: Dict[str, Any]
    events: List[Dict[str, Any]] = field(default_factory=list)
    status: str = "ok"

    def is_llm(self) -> bool:
        """True for spans that record a model call (they carry ``gen_ai.system``)."""
        return "gen_ai.system" in self.attributes

    def is_eval(self) -> bool:
        return self.name == "eval"


Trace = List[Span]
