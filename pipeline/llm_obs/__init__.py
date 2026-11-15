"""LLM observability pipeline: tail sampling, eval spans, drift detection and alerting.

A dependency-free reference implementation of the processing stages that sit
between span ingest and the dashboard. Run the end-to-end demo with::

    python -m llm_obs
"""

from .alerts import evaluate_alerts
from .drift import PSI_ALERT_THRESHOLD, prompt_fingerprint, psi
from .evals import enrich_with_evals, eval_faithfulness, eval_pii_leak, eval_toxicity
from .sampler import TailSampler
from .spans import Span, Trace
from .store import SpanStore

__version__ = "0.2.0"

__all__ = [
    "PSI_ALERT_THRESHOLD",
    "Span",
    "SpanStore",
    "TailSampler",
    "Trace",
    "enrich_with_evals",
    "eval_faithfulness",
    "eval_pii_leak",
    "eval_toxicity",
    "evaluate_alerts",
    "prompt_fingerprint",
    "psi",
]
