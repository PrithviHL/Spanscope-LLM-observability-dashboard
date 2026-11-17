"""End-to-end demo: 200 synthetic traces with a 1% injected PII-leak regression.

Usage: python -m llm_obs [--traces N] [--leak-rate R] [--sample-rate R] [--seed S]
                        [--evals heuristic|deepeval|ragas] [--judge-model MODEL]
"""

from __future__ import annotations

import argparse
import random
from typing import List, Optional, Sequence

from .alerts import evaluate_alerts
from .drift import PSI_ALERT_THRESHOLD, prompt_fingerprint, psi
from .evals import enrich_with_evals
from .judges import BACKENDS, judge_model, make_scorer
from .sampler import TailSampler
from .simulate import synth_trace
from .store import SpanStore


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="python -m llm_obs", description=__doc__.splitlines()[0])
    p.add_argument("--traces", type=int, default=200, help="number of traces (default 200)")
    p.add_argument("--leak-rate", type=float, default=0.01, help="share of PII-leaking traces")
    p.add_argument("--sample-rate", type=float, default=0.20, help="tail-sample rate for OK traces")
    p.add_argument("--seed", type=int, default=5, help="random seed (default 5)")
    p.add_argument("--evals", choices=BACKENDS, default="heuristic",
                   help="eval backend: built-in heuristics (default), or DeepEval / RAGAS judged by Claude")
    p.add_argument("--judge-model", default=None,
                   help="Claude model for DeepEval/RAGAS (default $SPANSCOPE_JUDGE_MODEL or claude-opus-5-5)")
    args = p.parse_args(argv)
    if args.traces < 1:
        p.error("--traces must be at least 1")
    for name in ("leak_rate", "sample_rate"):
        if not 0.0 <= getattr(args, name) <= 1.0:
            p.error(f"--{name.replace('_', '-')} must be between 0 and 1")
    return args


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    rng = random.Random(args.seed)
    sampler = TailSampler(sample_rate=args.sample_rate, rng=rng)
    store = SpanStore()
    scorer = None
    if args.evals != "heuristic":
        try:
            scorer = make_scorer(args.evals, args.judge_model)
        except Exception as err:  # noqa: BLE001 - missing extra or judge credentials
            print(f"error: could not set up the {args.evals} backend: {err}")
            return 2
        print(f"evals: {args.evals}, judged by {judge_model(args.judge_model)} "
              f"(a few model calls per trace; {args.traces} traces)")

    # Prompt fingerprints for drift: the last quarter of traffic is compared to the rest.
    split = int(args.traces * 0.75)
    baseline_fps: List[int] = []
    current_fps: List[int] = []

    for i in range(args.traces):
        leak = rng.random() < args.leak_rate
        trace = enrich_with_evals(synth_trace(f"t{i:04d}", leak_pii=leak, rng=rng), scorer)
        if sampler.decide(trace):
            store.insert_trace(trace)
        # Drift watches the input distribution, so it sees every trace, sampled or not.
        llm_span = next(s for s in trace if s.is_llm())
        fp = prompt_fingerprint(llm_span.attributes.get("prompt", ""))
        (current_fps if i > split else baseline_fps).append(fp)

    print(f"ingested spans     : {len(store.spans)}")
    print(f"spans by model     : {dict(store.by_model)}")
    print(f"cost by user       : {dict((k, round(v, 4)) for k, v in store.cost_by_user.items())}")

    alerts = evaluate_alerts(store)
    if alerts:
        print("\nALERTS:")
        for a in alerts:
            print(f"  - {a}")
    else:
        print("\nno alerts")

    psi_val = psi(baseline_fps, current_fps, n_bins=8)
    print(f"\nPSI (current vs baseline): {psi_val:.3f}")
    if psi_val > PSI_ALERT_THRESHOLD:
        print(f"  drift alert (PSI > {PSI_ALERT_THRESHOLD})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
