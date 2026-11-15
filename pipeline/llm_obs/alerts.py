"""Threshold alerting over stored eval spans (stand-in for Prometheus Alertmanager)."""

from __future__ import annotations

from typing import List

from .store import SpanStore

PII_ALERT_THRESHOLD = 0.8
TOXICITY_ALERT_THRESHOLD = 0.5


def evaluate_alerts(store: SpanStore) -> List[str]:
    alerts: List[str] = []
    evals = [s for s in store.spans if s.is_eval()]
    pii = [s for s in evals if s.attributes.get("pii_leak", 0) > PII_ALERT_THRESHOLD]
    if pii:
        alerts.append(f"PII LEAK DETECTED: {len(pii)} events (first trace: {pii[0].trace_id})")
    toxic = [s for s in evals if s.attributes.get("toxicity", 0) > TOXICITY_ALERT_THRESHOLD]
    if toxic:
        alerts.append(f"TOXICITY SURGE: {len(toxic)} events")
    return alerts
