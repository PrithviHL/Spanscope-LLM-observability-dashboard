"""Eval backends: the built-in heuristics, DeepEval or RAGAS (judged by Claude or Gemini).

Every backend returns the same span attributes, so sampling and alerting don't
change with the backend:

    faithfulness  0..1, higher = better supported by the retrieval context
    toxicity      0..1, higher = more toxic
    pii_leak      0..1, higher = more likely to leak personal data

DeepEval and RAGAS are optional (``pip install "spanscope-pipeline[deepeval]"``
or ``[ragas]``, Python 3.10+). They are imported only when their backend is
chosen, so the default heuristic backend still needs nothing but the standard
library. Each LLM span costs a few judge-model calls, so use them on sampled
traffic, not on every request.

The judge provider follows the model name: ``claude-*`` uses the Anthropic SDK
(``ANTHROPIC_API_KEY`` or an ``ant auth login`` profile); ``gemini-*`` uses
Google's Gemini API (``GEMINI_API_KEY`` or ``GOOGLE_API_KEY``), which has a free
tier. ``SPANSCOPE_JUDGE_RPM`` caps judge requests per minute (default 4 for
Gemini, to stay inside free-tier limits; no cap for Claude).
"""

from __future__ import annotations

import asyncio
import functools
import logging
import os
import threading
import time
import warnings
from typing import Any, Callable, Dict, Mapping, Optional

from .evals import eval_faithfulness, eval_pii_leak, eval_toxicity

BACKENDS = ("heuristic", "deepeval", "ragas")
DEFAULT_JUDGE_MODEL = "claude-opus-5-5"
JUDGE_MODEL_ENV = "SPANSCOPE_JUDGE_MODEL"
JUDGE_RPM_ENV = "SPANSCOPE_JUDGE_RPM"
GEMINI_FREE_TIER_RPM = 4  # free tier allows 5 per minute per model; keep a margin
# Gemini's OpenAI-compatible endpoint, used for RAGAS (its native Google path
# needs a newer `instructor` than RAGAS 0.4.4 installs).
GEMINI_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"

Scores = Dict[str, Any]
log = logging.getLogger(__name__)
_POLARITY_NOTICE = ".*scores in the same direction.*"  # DeepEval 4.3 deprecation notice


def judge_model(model: Optional[str] = None) -> str:
    return model or os.environ.get(JUDGE_MODEL_ENV) or DEFAULT_JUDGE_MODEL


def judge_provider(model: str) -> str:
    """``google`` for Gemini models, otherwise ``anthropic``."""
    return "google" if model.lower().startswith("gemini") else "anthropic"


def _gemini_key() -> str:
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key:
        raise RuntimeError("a Gemini judge needs GEMINI_API_KEY (or GOOGLE_API_KEY) to be set")
    return key


def judge_rpm(model: str) -> float:
    """Requests per minute allowed for the judge (0 = no limit)."""
    raw = os.environ.get(JUDGE_RPM_ENV)
    if raw:
        return max(0.0, float(raw))
    return GEMINI_FREE_TIER_RPM if judge_provider(model) == "google" else 0.0


class Pacer:
    """Spaces calls at least ``60 / rpm`` seconds apart (thread-safe)."""

    def __init__(self, rpm: float, clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], None] = time.sleep):
        self.interval = 60.0 / rpm if rpm > 0 else 0.0
        self.clock, self.sleep = clock, sleep
        self._next = 0.0
        self._lock = threading.Lock()

    def delay(self) -> float:
        """Reserve the next slot and return how long to wait for it."""
        with self._lock:
            now = self.clock()
            start = max(now, self._next)
            self._next = start + self.interval
            return start - now

    def wait(self) -> None:
        d = self.delay()
        if d > 0:
            self.sleep(d)

    async def await_turn(self) -> None:
        d = self.delay()
        if d > 0:
            await asyncio.sleep(d)


def _pace(obj: Any, pacer: Pacer, sync_names=(), async_names=()) -> None:
    """Wrap a judge's request methods so every call waits for the pacer."""
    if not pacer.interval:
        return
    for name in sync_names:
        fn = getattr(obj, name)

        @functools.wraps(fn)
        def paced(*a, _fn=fn, **k):
            pacer.wait()
            return _fn(*a, **k)

        setattr(obj, name, paced)
    for name in async_names:
        fn = getattr(obj, name)

        @functools.wraps(fn)
        async def apaced(*a, _fn=fn, **k):
            await pacer.await_turn()
            return await _fn(*a, **k)

        setattr(obj, name, apaced)


def _no_telemetry() -> None:
    """Both libraries send usage analytics by default; keep that off unless the
    user has set these variables themselves. Also give DeepEval more retries for
    rate limits (it backs off between them), which free tiers hit often."""
    os.environ.setdefault("DEEPEVAL_TELEMETRY_OPT_OUT", "1")
    os.environ.setdefault("RAGAS_DO_NOT_TRACK", "true")
    os.environ.setdefault("DEEPEVAL_RETRY_MAX_ATTEMPTS", "6")
    # DeepEval splits a 180 s budget across attempts unless this is set, which
    # with 6 attempts cuts slow judge calls off after ~26 s.
    os.environ.setdefault("DEEPEVAL_PER_ATTEMPT_TIMEOUT_SECONDS_OVERRIDE", "120")


def _missing(extra: str, err: ImportError) -> ImportError:
    return ImportError(
        f"The {extra} backend needs: pip install 'spanscope-pipeline[{extra}]' "
        f"(Python 3.10+). Original error: {err}"
    )


class HeuristicScorer:
    """The dependency-free rules in ``evals.py``."""

    name = "heuristic"

    def score(self, prompt: str, response: str, context: str, only=None) -> Scores:
        return {
            "faithfulness": eval_faithfulness(response, context),
            "toxicity": eval_toxicity(response),
            "pii_leak": eval_pii_leak(response),
        }


class DeepEvalScorer:
    """DeepEval's Faithfulness, Toxicity and PII Leakage metrics.

    DeepEval scores toxicity and PII as the share of statements that *pass*
    (1.0 = safe); they are flipped here so higher means worse, as in Spanscope.
    Faithfulness needs a retrieval context: without one the heuristic score is
    kept. If a judge call fails, that metric falls back to the heuristic and the
    span gets ``eval.fallback``.
    """

    name = "deepeval"

    def __init__(self, model: Optional[str] = None, metrics: Optional[Mapping[str, Any]] = None,
                 test_case: Optional[Callable[..., Any]] = None):
        self.model = judge_model(model)
        if metrics is None or test_case is None:
            _no_telemetry()
            try:
                from deepeval.metrics import FaithfulnessMetric, PIILeakageMetric, ToxicityMetric
                from deepeval.models import AnthropicModel, GeminiModel
                from deepeval.test_case import LLMTestCase
            except ImportError as err:
                raise _missing("deepeval", err) from err
            if judge_provider(self.model) == "google":
                judge = GeminiModel(model=self.model, api_key=_gemini_key())
            else:
                judge = AnthropicModel(model=self.model)
            _pace(judge, Pacer(judge_rpm(self.model)), ("generate",), ("a_generate",))
            opts = {"model": judge, "include_reason": False, "async_mode": False}
            with warnings.catch_warnings():
                warnings.filterwarnings("ignore", message=_POLARITY_NOTICE)
                metrics = metrics or {
                    "faithfulness": FaithfulnessMetric(**opts),
                    "toxicity": ToxicityMetric(**opts),
                    "pii_leak": PIILeakageMetric(**opts),
                }
            test_case = test_case or LLMTestCase
        self.metrics = dict(metrics)
        self.test_case = test_case
        self.fallback = HeuristicScorer()

    def score(self, prompt: str, response: str, context: str, only=None) -> Scores:
        """``only``: names of the metrics to judge (default all); the rest stay heuristic."""
        out = self.fallback.score(prompt, response, context)
        case = self.test_case(input=prompt or "-", actual_output=response,
                              retrieval_context=[context] if context else None)
        failed = []
        for key, metric in self.metrics.items():
            if (only and key not in only) or (key == "faithfulness" and not context):
                continue
            started = time.monotonic()
            try:
                with warnings.catch_warnings():
                    # DeepEval 4.3 announces its polarity change on every measure();
                    # the flip below already accounts for it.
                    warnings.filterwarnings("ignore", message=_POLARITY_NOTICE)
                    value = metric.measure(case, _show_indicator=False)
                value = metric.score if value is None else value
            except Exception as err:  # noqa: BLE001 - a judge failure must not drop the trace
                log.warning("deepeval %s failed, using heuristic: %s", key, err)
                failed.append(key)
                continue
            value = float(value)
            out[key] = round(value if key == "faithfulness" else 1.0 - value, 4)
            log.info("deepeval %s = %.2f (%.1fs)", key, out[key], time.monotonic() - started)
        out["eval.backend"] = self.name
        out["eval.judge_model"] = self.model
        if failed:
            out["eval.fallback"] = ",".join(failed)
        return out


class RagasScorer:
    """RAGAS Faithfulness and Context Relevance.

    RAGAS has no toxicity or PII metric, so those two stay heuristic. Context
    relevance is added as an extra attribute (``context_relevance``, 0..1).
    """

    name = "ragas"

    def __init__(self, model: Optional[str] = None, metrics: Optional[Mapping[str, Any]] = None):
        self.model = judge_model(model)
        if metrics is None:
            _no_telemetry()
            try:
                import instructor
                from ragas.llms import llm_factory
                from ragas.metrics.collections import ContextRelevance, Faithfulness
            except ImportError as err:
                raise _missing("ragas", err) from err
            if judge_provider(self.model) == "google":
                from openai import AsyncOpenAI  # installed with ragas

                client = AsyncOpenAI(api_key=_gemini_key(), base_url=GEMINI_OPENAI_BASE_URL)
                llm = llm_factory(self.model, provider="openai", client=client, max_tokens=8000)
            else:
                from anthropic import AsyncAnthropic

                # ANTHROPIC_JSON: RAGAS 0.4.4's default (generic JSON) is rejected by
                # instructor for Anthropic clients, and tool mode forces a tool call,
                # which current Claude models refuse. Thinking shares max_tokens with
                # the answer, so leave room for both.
                llm = llm_factory(self.model, provider="anthropic", client=AsyncAnthropic(),
                                  mode=instructor.Mode.ANTHROPIC_JSON, max_tokens=16000)
            _pace(llm, Pacer(judge_rpm(self.model)), ("generate",), ("agenerate",))
            metrics = {"faithfulness": Faithfulness(llm=llm), "context_relevance": ContextRelevance(llm=llm)}
        self.metrics = dict(metrics)
        self.fallback = HeuristicScorer()

    async def _ascore(self, prompt: str, response: str, context: str, only=None) -> Scores:
        out: Scores = {}
        failed = []
        for key, metric in self.metrics.items():
            if only and key not in only:
                continue
            started = time.monotonic()
            try:
                if key == "faithfulness":
                    result = await metric.ascore(user_input=prompt or "-", response=response,
                                                 retrieved_contexts=[context])
                else:
                    result = await metric.ascore(user_input=prompt or "-", retrieved_contexts=[context])
            except Exception as err:  # noqa: BLE001
                log.warning("ragas %s failed, using heuristic: %s", key, err)
                failed.append(key)
                continue
            value = getattr(result, "value", result)
            if value is not None:
                out[key] = round(float(value), 4)
                log.info("ragas %s = %.2f (%.1fs)", key, out[key], time.monotonic() - started)
        if failed:
            out["eval.fallback"] = ",".join(failed)
        return out

    def score(self, prompt: str, response: str, context: str, only=None) -> Scores:
        """``only``: names of the metrics to judge (default all); the rest stay heuristic."""
        out = self.fallback.score(prompt, response, context)
        if context and (not only or set(only) & set(self.metrics)):
            out.update(asyncio.run(self._ascore(prompt, response, context, only)))
        out["eval.backend"] = self.name
        out["eval.judge_model"] = self.model
        return out


def make_scorer(backend: str = "heuristic", model: Optional[str] = None):
    """Build the scorer for ``backend`` (one of ``BACKENDS``)."""
    if backend == "heuristic":
        return HeuristicScorer()
    if backend == "deepeval":
        return DeepEvalScorer(model)
    if backend == "ragas":
        return RagasScorer(model)
    raise ValueError(f"unknown eval backend {backend!r}; choose from {', '.join(BACKENDS)}")
