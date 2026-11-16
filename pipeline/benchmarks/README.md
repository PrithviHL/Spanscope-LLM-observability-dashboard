# Evaluator benchmark

How well the heuristic evaluators in [`llm_obs/evals.py`](../llm_obs/evals.py)
agree with labels. Run from `pipeline/`:

```bash
python3 benchmarks/fetch_offenseval.py   # optional: downloads the external set
python3 benchmarks/run.py
```

## Results (threshold 0.5)

| Set | Evaluator | Before (v0.3.0) | After |
|---|---|---|---|
| **OffensEval 2019 test**: 860 human-labelled tweets, never used for tuning | toxicity | F1 0.02 (P 1.00, R 0.01), AUROC 0.52 | **F1 0.52** (P 0.88, R 0.37), AUROC 0.70 |
| OffensEval 2019 validation: 1,324 tweets, used for tuning | toxicity | n/a | F1 0.48 (P 0.82, R 0.34) |
| Held-out (AI-written, see caveats) | toxicity | F1 0.12, AUROC 0.44 | F1 0.98, AUROC 1.00 |
| | faithfulness | accuracy 0.57, AUROC 0.59 | accuracy 0.88, AUROC 0.92 |
| | PII | F1 0.33 (P 1.00, R 0.20) | F1 1.00 |
| Dev (AI-written, tuning set) | toxicity | F1 0.40, AUROC 0.52 | F1 0.91, AUROC 0.93 |
| | faithfulness | accuracy 0.65, AUROC 0.69 | accuracy 0.95, AUROC 0.97 |
| | PII | F1 0.57 (P 1.00, R 0.40) | F1 1.00 |

## How much to trust each number

- **OffensEval test is the honest one.** It is human-labelled, external, and was
  scored once after the rules were final. Its "offensive" label is broader than
  what an LLM-output monitor needs (it includes political insults and slurs the
  rules don't list), so recall is low. Precision is what matters for alerting.
- **The held-out set is not blind.** It was written and checksummed before the
  upgrade, but by the same author (Claude) who then wrote the rules with it in
  view, so its wording leaked into the lexicon. Treat its toxicity and PII
  scores as an upper bound.
- **The dev set was used for tuning**, so its scores are optimistic by design.
- Dev and held-out are small (120 examples each) and were written and labelled
  by an AI. They have not been reviewed by a human annotator.
- Faithfulness and PII have no external benchmark yet. Good candidates:
  HaluEval / RAGTruth (faithfulness) and a hand-labelled sample of real traces (PII).

## Known misses

- Toxicity: insults without a listed word ("go back to your country"), slurs,
  sarcasm; "garbage in, garbage out, as they say" is a false alarm.
- Faithfulness: swapped facts without numbers ("freezes in april and thaws in
  january"), entity swaps ("lyon is the capital of france"), new claims that
  reuse context words.
- PII: names on their own, non-US formats beyond phones, free-text dates of birth.
