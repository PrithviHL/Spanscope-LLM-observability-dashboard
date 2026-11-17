"""Score the evaluators: python3 benchmarks/run.py [--backend heuristic|deepeval|ragas] [--limit N]
(run from pipeline/)

DeepEval and RAGAS call a Claude judge for every example, so they cost money:
use --limit to cap examples per set while trying them out.

Sets:
  dev       dev_set.py      written alongside the rules; used to tune them
  held-out  heldout_set.py  written before the upgrade (sha256 in heldout.sha256)
  external  OffensEval 2019 tweets (toxicity only), if fetch_offenseval.py was run
"""
import argparse
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

from llm_obs.judges import BACKENDS, make_scorer  # noqa: E402

import dev_set  # noqa: E402
import heldout_set  # noqa: E402


def metrics(y, s, t=0.5):
    pred = [v >= t for v in s]
    tp = sum(a and b for a, b in zip(y, pred))
    fp = sum((not a) and b for a, b in zip(y, pred))
    fn = sum(a and not b for a, b in zip(y, pred))
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * p * r / (p + r) if p + r else 0.0
    acc = sum(a == b for a, b in zip(y, pred)) / len(y)
    pos = [v for v, k in zip(s, y) if k]
    neg = [v for v, k in zip(s, y) if not k]
    auc = sum((a > b) + 0.5 * (a == b) for a in pos for b in neg) / (len(pos) * len(neg))
    return f"n={len(y):4}  precision {p:.2f}  recall {r:.2f}  F1 {f1:.2f}  accuracy {acc:.2f}  AUROC {auc:.2f}"


ap = argparse.ArgumentParser()
ap.add_argument("--backend", choices=BACKENDS, default="heuristic")
ap.add_argument("--judge-model", default=None)
ap.add_argument("--limit", type=int, default=0, help="max examples per class per set (0 = all)")
args = ap.parse_args()
scorer = make_scorer(args.backend, args.judge_model)
print(f"backend: {args.backend}" + (f", judge {scorer.model}" if hasattr(scorer, "model") else ""))


def cap(rows, label=lambda r: r[-1]):
    """Keep at most --limit positives and --limit negatives, so small runs stay balanced."""
    if not args.limit:
        return rows
    pos = [r for r in rows if label(r)][: args.limit]
    neg = [r for r in rows if not label(r)][: args.limit]
    return pos + neg


def field(key, prompt, response, context=""):
    return scorer.score(prompt, response, context, only=(key,))[key]


def score(name, mod):
    print(f"== {name}")
    rows = cap(mod.TOXICITY)
    y = [k for _, k in rows]
    print("  toxicity     ", metrics(y, [field("toxicity", "", x) for x, _ in rows]))
    rows = cap(mod.FAITHFULNESS)
    y = [k for *_, k in rows]
    print("  faithfulness ", metrics(y, [field("faithfulness", "", r, c) for c, r, _ in rows]))
    rows = cap(mod.PII)
    y = [k for _, k in rows]
    print("  pii_leak     ", metrics(y, [field("pii_leak", "", x) for x, _ in rows]))


score("dev (tuning set)", dev_set)

with open(os.path.join(HERE, "heldout_set.py"), "rb") as f:
    digest = hashlib.sha256(f.read()).hexdigest()
with open(os.path.join(HERE, "heldout.sha256")) as f:
    frozen = f.read().split()[0]
score(f"held-out (sha256 {'matches' if digest == frozen else 'CHANGED'})", heldout_set)

for split in ("validation", "test"):
    path = os.path.join(HERE, "data", f"offenseval_{split}.json")
    if os.path.exists(path):
        rows = cap(json.load(open(path)), label=lambda r: r["label"])
        y = [r["label"] for r in rows]
        print(f"== OffensEval 2019 {split}")
        print("  toxicity     ", metrics(y, [field("toxicity", "", r["text"]) for r in rows]))
