# llm_obs: trace processing pipeline (Python)

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
| `evals.py` | faithfulness, toxicity and PII-leak scorers; `enrich_with_evals` adds `eval` child spans |
| `sampler.py` | `TailSampler`: always keeps errored or flagged traces, samples the rest |
| `store.py` | in-memory `SpanStore` with per-user and per-model counters (ClickHouse stand-in) |
| `drift.py` | prompt fingerprints and PSI; above 0.2 counts as drift |
| `alerts.py` | `evaluate_alerts`: PII and toxicity thresholds (Alertmanager stand-in) |
| `__main__.py` | command-line demo wiring the stages together |

The evals are heuristics that stand in for LLM-judge or DeepEval scorers; see
[`docs/architecture.md`](../docs/architecture.md) for how they map to the target
production stack.
