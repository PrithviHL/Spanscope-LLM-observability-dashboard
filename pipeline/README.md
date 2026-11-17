# Spanscope pipeline: trace processing in Python (`llm_obs`)

A dependency-free reference implementation of the stages that sit between span
ingest and the dashboard: tail sampling, evals written back as child spans,
prompt-drift detection and alerting. It runs on the Python standard library
(3.9+).

## Run the demo

```bash
cd pipeline
python3 -m llm_obs
```

This simulates 200 chatbot traces. 1% of them leak a fake SSN, which should
raise a PII alert:

```text
ingested spans     : 165
spans by model     : {'gpt-5-4': 24, 'claude-sonnet-4-7': 14, 'gemini-3-pro': 17}
cost by user       : {'u_02': 0.3625, 'u_03': 0.3835, 'u_04': 0.3294, 'u_01': 0.2116}

ALERTS:
  - PII LEAK DETECTED: 5 events (first trace: t0008)

PSI (current vs baseline): 0.083
```

| Option | Default | Meaning |
|---|---|---|
| `--traces N` | 200 | number of simulated traces |
| `--leak-rate R` | 0.01 | share of traces whose response leaks PII |
| `--sample-rate R` | 0.20 | share of healthy traces the tail sampler keeps |
| `--seed S` | 5 | random seed; the same seed gives the same output |

## Test

```bash
cd pipeline
python3 -m unittest discover -s tests -v
```

## Modules

| Module | Responsibility |
|---|---|
| `spans.py` | `Span` model using OpenTelemetry GenAI attribute names |
| `simulate.py` | synthetic chat traces, with an optional PII-leak regression |
| `evals.py` | faithfulness, toxicity and PII-leak heuristics; `enrich_with_evals` adds `eval` child spans |
| `judges.py` | eval backends: heuristics (default), DeepEval or RAGAS judged by Claude |
| `sampler.py` | `TailSampler`: always keeps errored or flagged traces, samples the rest |
| `store.py` | in-memory `SpanStore` with per-user and per-model counters (ClickHouse stand-in) |
| `drift.py` | prompt fingerprints and PSI; above 0.2 counts as drift |
| `alerts.py` | `evaluate_alerts`: PII and toxicity thresholds (Alertmanager stand-in) |
| `__main__.py` | command-line demo wiring the stages together |

By default the evals are heuristics (standard library only). Their accuracy is
measured in [`benchmarks/`](benchmarks/README.md): on 860
human-labelled OffensEval tweets never used for tuning, toxicity reaches F1 0.52
at 0.88 precision (up from 0.02). See
[`docs/architecture.md`](../docs/architecture.md) for how they map to the target
production stack.

## Model-based evals: DeepEval and RAGAS

The same three scores can come from [DeepEval](https://github.com/confident-ai/deepeval)
or [RAGAS](https://github.com/explodinggradients/ragas), with Claude or Gemini as
the judge.
Sampling and alerting don't change: every backend writes the same attributes
to the `eval` span.

| Backend | faithfulness | toxicity | pii_leak | Extra attributes |
|---|---|---|---|---|
| `heuristic` (default) | rules | rules | rules | none |
| `deepeval` | `FaithfulnessMetric` | `ToxicityMetric` | `PIILeakageMetric` | `eval.backend`, `eval.judge_model` |
| `ragas` | `Faithfulness` | rules (RAGAS has no toxicity metric) | rules (no PII metric) | `context_relevance`, `eval.backend`, `eval.judge_model` |

Install the extra (Python 3.10+) and set credentials for the judge:

```bash
pip install -e ".[deepeval]"     # or ".[ragas]", or ".[judges]" for both
python -m llm_obs --evals deepeval --traces 20                        # Claude
python -m llm_obs --evals deepeval --judge-model gemini-3.6-flash      # Gemini
python benchmarks/run.py --backend deepeval --limit 5
```

- **Judge model:** `claude-opus-5-5` by default. Change it with `--judge-model`
  or `SPANSCOPE_JUDGE_MODEL`. The provider follows the name: `claude-*` uses the
  Anthropic SDK (`ANTHROPIC_API_KEY` or an `ant auth login` profile), `gemini-*`
  uses the Gemini API (`GEMINI_API_KEY` or `GOOGLE_API_KEY`).
- **Free option:** Gemini has a free tier (key from
  [Google AI Studio](https://aistudio.google.com/apikey)). It allows about 5
  requests a minute per model, so Gemini judges are paced to 4 a minute by
  default; set `SPANSCOPE_JUDGE_RPM` to change that (0 = no limit). RAGAS
  reaches Gemini through Google's OpenAI-compatible endpoint, because its native
  Google path needs a newer `instructor` than RAGAS 0.4.4 installs.
- **Cost:** each LLM span takes several judge calls (DeepEval: 2–3 per metric).
  Use small `--traces` / `--limit` values while trying it, and in production run
  the judges on tail-sampled traces only.
- **Direction:** DeepEval 4.3+ scores toxicity and PII as the share of
  statements that pass (1.0 = safe). Spanscope flips them so that, as everywhere
  else in the project, higher means worse.
- **Failures:** if a judge call fails (rate limit, timeout), that metric falls
  back to the heuristic, a warning is logged, and the span gets `eval.fallback`.
  Faithfulness is only judged when the span has a retrieval `context`.
- **Telemetry:** both libraries send usage analytics by default. Spanscope sets
  `DEEPEVAL_TELEMETRY_OPT_OUT=1` and `RAGAS_DO_NOT_TRACK=true` unless you have
  set them yourself.
- **Tests:** `tests/test_judges.py` runs the real DeepEval and RAGAS metric code
  against a fake judge model, so CI checks the integration without an API key
  or network access.
