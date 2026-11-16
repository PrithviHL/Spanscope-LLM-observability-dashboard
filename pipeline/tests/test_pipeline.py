import contextlib
import io
import random
import unittest

from llm_obs import (
    Span,
    SpanStore,
    TailSampler,
    enrich_with_evals,
    eval_faithfulness,
    eval_pii_leak,
    eval_toxicity,
    evaluate_alerts,
    prompt_fingerprint,
    psi,
)
from llm_obs.__main__ import main
from llm_obs.simulate import synth_trace


def llm_span(response="the weather is mild", status="ok", user="u_01", cost=0.01):
    return Span(
        trace_id="t1",
        span_id="t1_1",
        parent_span_id="t1_0",
        name="llm_call",
        start_ms=0,
        duration_ms=100,
        status=status,
        attributes={
            "gen_ai.system": "openai",
            "gen_ai.request.model": "gpt-x",
            "user_id": user,
            "response": response,
            "context": "weather is mild",
            "cost_usd": cost,
        },
    )


class EvalTests(unittest.TestCase):
    def test_faithfulness_overlap_and_contradictions(self):
        ctx = "the store opens at 9 am and closes at 6 pm"
        self.assertEqual(eval_faithfulness("the store opens at 9 am", ctx), 1.0)
        self.assertEqual(eval_faithfulness("it closes at 6 pm and opens at 9 am", ctx), 1.0)  # reordered
        self.assertLessEqual(eval_faithfulness("revenue fell", "revenue grew"), 0.3)  # word with 2 antonyms
        self.assertEqual(eval_faithfulness("", ctx), 0.0)
        self.assertLessEqual(eval_faithfulness("the store opens at 7 am", ctx), 0.3)  # unsupported number
        self.assertLessEqual(eval_faithfulness("the store does not open", ctx), 0.4)  # added negation
        self.assertLessEqual(eval_faithfulness("the store closes early", "the store opens early"), 0.3)  # antonym
        self.assertLessEqual(eval_faithfulness("it opens at 6 pm and closes at 9 am", ctx), 0.3)  # swapped facts

    def test_toxicity_needs_a_target(self):
        self.assertEqual(eval_toxicity("have a nice day"), 0.0)
        self.assertEqual(eval_toxicity("you are stupid"), 1.0)
        self.assertEqual(eval_toxicity("what a clueless take"), 1.0)
        self.assertEqual(eval_toxicity("i'm going to hurt you"), 1.0)
        self.assertEqual(eval_toxicity("shut up"), 1.0)
        for benign in ("kill the process with -9", "garbage collection paused for 40 ms",
                       "the dumb terminal is offline", "i hate flaky tests"):
            self.assertLess(eval_toxicity(benign), 0.5, benign)

    def test_pii_leak(self):
        self.assertGreater(eval_pii_leak("ssn 123-45-6789"), 0.9)
        self.assertGreater(eval_pii_leak("card 4111 1111 1111 1111"), 0.9)  # passes Luhn
        self.assertLess(eval_pii_leak("order 4111 1111 1111 1112"), 0.5)  # fails Luhn
        self.assertEqual(eval_pii_leak("mail me at a@b.com"), 0.6)
        self.assertEqual(eval_pii_leak("call 352-555-0142"), 0.6)
        self.assertEqual(eval_pii_leak("ship to 42 elm street"), 0.7)
        for benign in ("nothing to see", "release v1.24.3", "port 8080", "meet at 14:30", "scored 4-1"):
            self.assertLess(eval_pii_leak(benign), 0.1, benign)

    def test_enrich_adds_one_eval_child_per_llm_span(self):
        root = Span("t1", "t1_0", None, "chat_turn", 0, 200, {})
        out = enrich_with_evals([root, llm_span()])
        evals = [s for s in out if s.is_eval()]
        self.assertEqual(len(out), 3)
        self.assertEqual(len(evals), 1)
        self.assertEqual(evals[0].parent_span_id, "t1_1")
        self.assertIn("pii_leak", evals[0].attributes)


class SamplerTests(unittest.TestCase):
    def test_keeps_errors_and_pii_even_at_zero_rate(self):
        sampler = TailSampler(sample_rate=0.0)
        self.assertTrue(sampler.decide([llm_span(status="error")]))
        self.assertTrue(sampler.decide(enrich_with_evals([llm_span("ssn 123-45-6789")])))
        self.assertFalse(sampler.decide(enrich_with_evals([llm_span()])))

    def test_keeps_everything_at_full_rate(self):
        self.assertTrue(TailSampler(sample_rate=1.0).decide([llm_span()]))

    def test_rejects_invalid_rate(self):
        with self.assertRaises(ValueError):
            TailSampler(sample_rate=1.5)


class StoreAndAlertTests(unittest.TestCase):
    def test_store_attributes_cost_per_user_and_model(self):
        store = SpanStore()
        store.insert_trace([llm_span(user="a", cost=0.5)])
        store.insert_trace([llm_span(user="a", cost=0.25), llm_span(user="b", cost=1.0)])
        self.assertEqual(store.by_user["a"], 2)
        self.assertEqual(store.by_model["gpt-x"], 3)
        self.assertAlmostEqual(store.cost_by_user["a"], 0.75)

    def test_alerts_fire_only_on_pii(self):
        store = SpanStore()
        store.insert_trace(enrich_with_evals([llm_span()]))
        self.assertEqual(evaluate_alerts(store), [])
        store.insert_trace(enrich_with_evals([llm_span("ssn 123-45-6789")]))
        alerts = evaluate_alerts(store)
        self.assertEqual(len(alerts), 1)
        self.assertIn("PII LEAK DETECTED: 1 events", alerts[0])


class DriftTests(unittest.TestCase):
    def test_psi_zero_for_identical_and_large_for_disjoint(self):
        self.assertAlmostEqual(psi([0, 1, 2, 3], [0, 1, 2, 3]), 0.0)
        self.assertGreater(psi([0] * 50, [7] * 50), 1.0)

    def test_fingerprint_is_stable_and_in_range(self):
        fp = prompt_fingerprint("hello")
        self.assertEqual(fp, prompt_fingerprint("hello"))
        self.assertTrue(0 <= fp < 8)


class SimulationTests(unittest.TestCase):
    def test_synth_trace_shape(self):
        root, llm = synth_trace("t9", leak_pii=True, rng=random.Random(1))
        self.assertIsNone(root.parent_span_id)
        self.assertEqual(llm.parent_span_id, root.span_id)
        self.assertTrue(llm.is_llm())
        self.assertIn("123-45-6789", llm.attributes["response"])


class DemoTests(unittest.TestCase):
    def run_demo(self, *argv):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = main(list(argv))
        return code, buf.getvalue()

    def test_default_demo_catches_injected_pii_regression(self):
        code, out = self.run_demo()
        self.assertEqual(code, 0)
        self.assertIn("PII LEAK DETECTED", out)

    def test_no_leaks_means_no_alerts(self):
        _, out = self.run_demo("--leak-rate", "0")
        self.assertIn("no alerts", out)

    def test_invalid_arguments_exit_with_usage_error(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as ctx:
            main(["--sample-rate", "2"])
        self.assertEqual(ctx.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
