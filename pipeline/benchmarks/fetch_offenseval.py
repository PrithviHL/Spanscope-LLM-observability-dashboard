"""Download OffensEval 2019 (tweet_eval/offensive) validation and test splits.

Human-labelled tweets (Zampieri et al., 2019; via cardiffnlp/tweet_eval). Not
redistributed here; this script fetches them from the Hugging Face datasets API.
"""
import json
import os
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
API = "https://datasets-server.huggingface.co/rows?dataset=cardiffnlp/tweet_eval&config=offensive"

for split in ("validation", "test"):
    rows, offset = [], 0
    while True:
        with urllib.request.urlopen(f"{API}&split={split}&offset={offset}&length=100") as r:
            page = json.load(r)["rows"]
        rows += [{"text": p["row"]["text"], "label": p["row"]["label"]} for p in page]
        offset += 100
        if len(page) < 100:
            break
    path = os.path.join(HERE, "data", f"offenseval_{split}.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(rows, f)
    print(f"{split}: {len(rows)} tweets, {sum(r['label'] for r in rows)} offensive -> {path}")
