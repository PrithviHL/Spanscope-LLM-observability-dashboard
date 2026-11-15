"""Tail sampling: decide to keep or drop a trace after it has completed."""

from __future__ import annotations

import random
from dataclasses import dataclass, field

from .spans import Trace

#: Eval scores above these always force a trace to be kept.
TOXICITY_KEEP_THRESHOLD = 0.5
PII_KEEP_THRESHOLD = 0.8


@dataclass
class TailSampler:
    """Keep every errored or flagged trace; keep a random ``sample_rate`` of the rest."""

    sample_rate: float = 0.10
    rng: random.Random = field(default_factory=lambda: random.Random(3))

    def __post_init__(self) -> None:
        if not 0.0 <= self.sample_rate <= 1.0:
            raise ValueError(f"sample_rate must be between 0 and 1, got {self.sample_rate}")

    def decide(self, trace: Trace) -> bool:
        if any(s.status == "error" for s in trace):
            return True
        for s in trace:
            if s.is_eval() and (
                s.attributes.get("toxicity", 0) > TOXICITY_KEEP_THRESHOLD
                or s.attributes.get("pii_leak", 0) > PII_KEEP_THRESHOLD
            ):
                return True
        return self.rng.random() < self.sample_rate
