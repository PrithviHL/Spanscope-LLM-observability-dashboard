"""Tests for the DeepEval / RAGAS eval backends.

The first group uses stand-in metrics and runs everywhere (stdlib only). The
second runs DeepEval's and RAGAS's real metric code against a fake judge model,
so no API key or network is needed; it is skipped unless the libraries are
installed (CI installs them in the "judges" job).
"""

from __future__ import annotations

import importlib.util
import io
import os
import random
import typing
import unittest
from contextlib import redirect_stdout

from llm_obs.__main__ import main
from llm_obs.evals import enrich_with_evals
from llm_obs.judges import DeepEvalScorer, HeuristicScorer, RagasScorer, make_scorer
from llm_obs.simulate import synth_trace

HAS_DEEPEVAL = importlib.util.find_spec("deepeval") is not None
HAS_RAGAS = importlib.util.find_spec("ragas") is not None


class FakeMetric:
    """Stand-in for a DeepEval metric: ``measure`` returns a fixed score."""

    def __init__(self, score, fail=False):
        self.score, self.fail, self.calls = score, fail, 0

    def measure(self, case, _show_indicator=True):
        self.calls += 1
        if self.fail:
            raise RuntimeError("judge unavailable")
        return self.score


class FakeAsyncMetric:
    def __init__(self, value):
        self.value, self.calls = value, 0

    async def ascore(self, **kwargs):
        self.calls += 1
        return type("Result", (), {"value": self.value})()


def fake_case(**kwargs):
    return kwargs


class DeepEvalScorerTests(unittest.TestCase):
    def scorer(self, **overrides):
        metrics = {"faithfulness": FakeMetric(0.9), "toxicity": FakeMetric(0.25), "pii_leak": FakeMetric(1.0)}
        metrics.update(overrides)
        return DeepEvalScorer(model="judge-x", metrics=metrics, test_case=fake_case), metrics

    def test_flips_safety_scores_so_higher_is_worse(self):
        scorer, _ = self.scorer()
        out = scorer.score("q", "answer", "ctx")
        self.assertEqual(out["faithfulness"], 0.9)
        self.assertEqual(out["toxicity"], 0.75)  # DeepEval 0.25 = 25% of opinions passed
        self.assertEqual(out["pii_leak"], 0.0)  # DeepEval 1.0 = nothing leaked
        self.assertEqual(out["eval.backend"], "deepeval")
        self.assertEqual(out["eval.judge_model"], "judge-x")

    def test_no_context_keeps_heuristic_faithfulness(self):
        scorer, metrics = self.scorer()
        out = scorer.score("q", "answer", "")
        self.assertEqual(metrics["faithfulness"].calls, 0)
        self.assertEqual(out["faithfulness"], HeuristicScorer().score("q", "answer", "")["faithfulness"])

    def test_judge_failure_falls_back_to_heuristic(self):
        scorer, _ = self.scorer(pii_leak=FakeMetric(1.0, fail=True))
        with self.assertLogs("llm_obs.judges", "WARNING") as logs:
            out = scorer.score("q", "my ssn is 123-45-6789", "ctx")
        self.assertIn("judge unavailable", logs.output[0])
        self.assertGreater(out["pii_leak"], 0.9)
        self.assertEqual(out["eval.fallback"], "pii_leak")

    def test_only_limits_judge_calls(self):
        scorer, metrics = self.scorer()
        scorer.score("q", "answer", "ctx", only=("toxicity",))
        self.assertEqual([m.calls for m in metrics.values()], [0, 1, 0])


class RagasScorerTests(unittest.TestCase):
    def test_faithfulness_and_context_relevance_from_ragas(self):
        metrics = {"faithfulness": FakeAsyncMetric(0.5), "context_relevance": FakeAsyncMetric(1.0)}
        out = RagasScorer(model="judge-x", metrics=metrics).score("q", "you idiot", "ctx")
        self.assertEqual(out["faithfulness"], 0.5)
        self.assertEqual(out["context_relevance"], 1.0)
        self.assertEqual(out["toxicity"], 1.0)  # RAGAS has no toxicity metric: heuristic
        self.assertEqual(out["eval.backend"], "ragas")

    def test_no_context_skips_the_judge(self):
        metrics = {"faithfulness": FakeAsyncMetric(0.5)}
        RagasScorer(metrics=metrics).score("q", "a", "")
        self.assertEqual(metrics["faithfulness"].calls, 0)


class WiringTests(unittest.TestCase):
    def test_enrich_uses_the_scorer(self):
        scorer = DeepEvalScorer(metrics={"toxicity": FakeMetric(0.0)}, test_case=fake_case)
        trace = enrich_with_evals(synth_trace("t1", leak_pii=False, rng=random.Random(1)), scorer)
        evals = [s for s in trace if s.is_eval()]
        self.assertEqual(len(evals), 1)
        self.assertEqual(evals[0].attributes["toxicity"], 1.0)
        self.assertEqual(evals[0].attributes["eval.backend"], "deepeval")

    def test_unknown_backend(self):
        with self.assertRaises(ValueError):
            make_scorer("nope")

    @unittest.skipIf(HAS_DEEPEVAL, "DeepEval is installed")
    def test_cli_explains_missing_extra(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = main(["--evals", "deepeval", "--traces", "1"])
        self.assertEqual(code, 2)
        self.assertIn("spanscope-pipeline[deepeval]", buf.getvalue())


def _build(schema, yes):
    """Fill any pydantic output schema with one item whose verdict is yes/no."""
    from pydantic import BaseModel

    values = {}
    for name, field in schema.model_fields.items():
        ann = field.annotation
        if typing.get_origin(ann) is list:
            inner = typing.get_args(ann)[0]
            is_model = isinstance(inner, type) and issubclass(inner, BaseModel)
            values[name] = [_build(inner, yes) if is_model else "a statement"]
        elif isinstance(ann, type) and issubclass(ann, BaseModel):
            values[name] = _build(ann, yes)
        elif name == "verdict":
            values[name] = int(yes) if ann is int else ("yes" if yes else "no")
        elif name == "rating":
            values[name] = 2 if yes else 0
        else:
            values[name] = "x"
    return schema(**values)


@unittest.skipUnless(HAS_DEEPEVAL, "needs pip install 'spanscope-pipeline[deepeval]'")
class RealDeepEvalTests(unittest.TestCase):
    def fake_judge(self, yes):
        from deepeval.models import DeepEvalBaseLLM

        class FakeJudge(DeepEvalBaseLLM):
            def __init__(self):
                super().__init__("fake-judge")

            def load_model(self):
                return None

            def generate(self, prompt, schema=None):
                return _build(schema, yes)

            async def a_generate(self, prompt, schema=None):
                return self.generate(prompt, schema)

            def get_model_name(self):
                return "fake-judge"

        return FakeJudge()

    def scorer(self, yes):
        import warnings

        from deepeval.metrics import FaithfulnessMetric, PIILeakageMetric, ToxicityMetric
        from deepeval.test_case import LLMTestCase

        opts = {"model": self.fake_judge(yes), "include_reason": False, "async_mode": False}
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)  # DeepEval's polarity notice
            metrics = {"faithfulness": FaithfulnessMetric(**opts), "toxicity": ToxicityMetric(**opts),
                       "pii_leak": PIILeakageMetric(**opts)}
        return DeepEvalScorer(metrics=metrics, test_case=LLMTestCase)

    def test_judge_saying_yes_means_toxic_leaky_and_faithful(self):
        out = self.scorer(yes=True).score("q", "a", "ctx")
        self.assertEqual((out["toxicity"], out["pii_leak"], out["faithfulness"]), (1.0, 1.0, 1.0))
        self.assertNotIn("eval.fallback", out)

    def test_judge_saying_no_means_clean_and_unfaithful(self):
        out = self.scorer(yes=False).score("q", "a", "ctx")
        self.assertEqual((out["toxicity"], out["pii_leak"], out["faithfulness"]), (0.0, 0.0, 0.0))

    def test_default_scorer_builds_a_claude_judge_without_calling_it(self):
        os.environ.setdefault("ANTHROPIC_API_KEY", "test-key-not-used")
        scorer = make_scorer("deepeval")
        self.assertEqual(scorer.model, "claude-opus-5-5")
        self.assertEqual(set(scorer.metrics), {"faithfulness", "toxicity", "pii_leak"})


@unittest.skipUnless(HAS_RAGAS, "needs pip install 'spanscope-pipeline[ragas]'")
class RealRagasTests(unittest.TestCase):
    def scorer(self, yes):
        from ragas.llms.base import InstructorBaseRagasLLM
        from ragas.metrics.collections import ContextRelevance, Faithfulness

        class FakeJudge(InstructorBaseRagasLLM):
            is_async = True

            def generate(self, prompt, response_model):
                return _build(response_model, yes)

            async def agenerate(self, prompt, response_model):
                return _build(response_model, yes)

        judge = FakeJudge()
        return RagasScorer(metrics={"faithfulness": Faithfulness(llm=judge),
                                    "context_relevance": ContextRelevance(llm=judge)})

    def test_faithful_and_relevant(self):
        out = self.scorer(yes=True).score("q", "a", "ctx")
        self.assertEqual((out["faithfulness"], out["context_relevance"]), (1.0, 1.0))
        self.assertNotIn("eval.fallback", out)

    def test_unfaithful_and_irrelevant(self):
        out = self.scorer(yes=False).score("q", "a", "ctx")
        self.assertEqual((out["faithfulness"], out["context_relevance"]), (0.0, 0.0))

    def test_default_scorer_builds_a_claude_judge_without_calling_it(self):
        os.environ.setdefault("ANTHROPIC_API_KEY", "test-key-not-used")
        scorer = make_scorer("ragas")
        self.assertEqual(scorer.model, "claude-opus-5-5")
        self.assertEqual(set(scorer.metrics), {"faithfulness", "context_relevance"})


if __name__ == "__main__":
    unittest.main()
