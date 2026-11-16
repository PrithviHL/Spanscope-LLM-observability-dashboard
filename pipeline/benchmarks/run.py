"""Score the evaluators: python3 benchmarks/run.py  (from pipeline/)

Sets:
  dev       dev_set.py      written alongside the rules; used to tune them
  held-out  heldout_set.py  written before the upgrade (sha256 in heldout.sha256)
  external  OffensEval 2019 tweets (toxicity only), if fetch_offenseval.py was run
"""
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

from llm_obs.evals import eval_faithfulness, eval_pii_leak, eval_toxicity  # noqa: E402

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


def score(name, mod):
    print(f"== {name}")
    y = [k for _, k in mod.TOXICITY]
    print("  toxicity     ", metrics(y, [eval_toxicity(x) for x, _ in mod.TOXICITY]))
    y = [k for *_, k in mod.FAITHFULNESS]
    print("  faithfulness ", metrics(y, [eval_faithfulness(r, c) for c, r, _ in mod.FAITHFULNESS]))
    y = [k for _, k in mod.PII]
    print("  pii_leak     ", metrics(y, [eval_pii_leak(x) for x, _ in mod.PII]))


score("dev (tuning set)", dev_set)

with open(os.path.join(HERE, "heldout_set.py"), "rb") as f:
    digest = hashlib.sha256(f.read()).hexdigest()
with open(os.path.join(HERE, "heldout.sha256")) as f:
    frozen = f.read().split()[0]
score(f"held-out (sha256 {'matches' if digest == frozen else 'CHANGED'})", heldout_set)

for split in ("validation", "test"):
    path = os.path.join(HERE, "data", f"offenseval_{split}.json")
    if os.path.exists(path):
        rows = json.load(open(path))
        y = [r["label"] for r in rows]
        print(f"== OffensEval 2019 {split}")
        print("  toxicity     ", metrics(y, [eval_toxicity(r["text"]) for r in rows]))
