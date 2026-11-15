"""Prompt-distribution drift via the Population Stability Index (PSI)."""

from __future__ import annotations

import hashlib
import math
from typing import Sequence

#: Conventional PSI threshold above which drift is considered meaningful.
PSI_ALERT_THRESHOLD = 0.2
_EPSILON = 0.0001


def prompt_fingerprint(prompt: str, n_bins: int = 8) -> int:
    """Stable bucket for a prompt (stand-in for clustering prompt embeddings)."""
    return hashlib.sha256(prompt.encode()).digest()[0] % n_bins


def psi(baseline: Sequence[int], current: Sequence[int], n_bins: int = 8) -> float:
    """PSI between two samples of bucket ids in ``[0, n_bins)``. 0 means identical."""
    ca = [0] * n_bins
    cb = [0] * n_bins
    for v in baseline:
        ca[v] += 1
    for v in current:
        cb[v] += 1
    total_a = max(sum(ca), 1)
    total_b = max(sum(cb), 1)
    score = 0.0
    for i in range(n_bins):
        pa = max(ca[i] / total_a, _EPSILON)
        pb = max(cb[i] / total_b, _EPSILON)
        score += (pa - pb) * math.log(pa / pb)
    return score
