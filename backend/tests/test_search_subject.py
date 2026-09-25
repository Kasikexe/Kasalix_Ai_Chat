"""What the web search is actually asked, and whether it runs at all.

The bug these lock down: the query used to be the raw user message, so a
follow-up like "can you search it up for me" was searched verbatim — and the
short version, "search it up", was under the 15-character gate and never
searched at all. A message now resolves to a SUBJECT: its own, or the earlier
turn it points back at.
"""

from __future__ import annotations

import asyncio
import os
import tempfile

import pytest

_TMP = tempfile.mkdtemp(prefix="kasalix-subject-test-")
os.environ["DATA_DIR"] = _TMP

from app import search as search_mod  # noqa: E402
from app.pipeline import (  # noqa: E402
    extract_search_topic,
    needs_web_search,
    plan_search,
    resolve_search_query,
    usable_search_query,
)
from app.search import decide_search, parse_search_decision  # noqa: E402

TOPIC = "What is the current population of Czechia"


def history(*messages: str) -> list[dict[str, str]]:
    return [{"role": "user", "content": m} for m in messages]


class TestSearchTrigger:
    def test_explicit_commands_are_honoured_at_any_length(self):
        """"search it up" is 12 characters and used to fall through the length
        gate, so the follow-up silently never searched."""
        assert needs_web_search("search it up") is True
        assert needs_web_search("google it") is True
        assert needs_web_search("look that up for me please") is True

    def test_greetings_and_follow_ups_still_do_not_search(self):
        assert needs_web_search("hi") is False
        assert needs_web_search("thanks") is False
        assert needs_web_search("tell me more") is False
        assert needs_web_search("can you elaborate further") is False

    def test_self_referential_questions_still_do_not_search(self):
        assert needs_web_search("how tall am i compared to the average man") is False

    def test_short_topics_still_need_a_keyword(self):
        # Unchanged: below the gate and no freshness/factual word.
        assert needs_web_search("ok then buddy") is False


class TestQueryCleaning:
    def test_command_and_politeness_are_stripped(self):
        assert (
            resolve_search_query("can you search it up for me? population of Czechia")
            == "population of Czechia"
        )
        assert extract_search_topic("could you please look up the population of Czechia") == (
            "the population of Czechia"
        )
        assert extract_search_topic("search for the best pizza in Rome") == (
            "the best pizza in Rome"
        )
        assert extract_search_topic("find me a recipe for tiramisu") == (
            "a recipe for tiramisu"
        )

    def test_a_plain_question_is_searched_unchanged(self):
        # The case that already worked must keep working, word for word.
        assert resolve_search_query(TOPIC) == TOPIC

    def test_mid_sentence_search_is_a_topic_word_not_a_command(self):
        text = "how does a binary search work"
        assert extract_search_topic(text) == text

    def test_a_bare_verb_in_front_of_a_noun_is_part_of_the_topic(self):
        # Stripping the leading verb here would search "algorithms explained"
        # and "maps vs apple maps" — the words ARE the subject.
        for text in (
            "search algorithms explained",
            "google maps vs apple maps",
            "research papers about transformers",
        ):
            assert extract_search_topic(text) == text

    def test_bare_verb_before_a_determiner_is_a_command(self):
        assert extract_search_topic("search the population of Czechia") == (
            "the population of Czechia"
        )
        assert extract_search_topic("google the population of Czechia") == (
            "the population of Czechia"
        )

    def test_filler_left_behind_by_a_command_is_removed(self):
        assert extract_search_topic("can you search for me the population of Czechia") == (
            "the population of Czechia"
        )


class TestSubjectFromContext:
    def test_reference_only_follow_up_borrows_the_earlier_topic(self):
        assert resolve_search_query("search it up", history(TOPIC)) == TOPIC
        assert resolve_search_query("could you look that up for me", history(TOPIC)) == TOPIC

    def test_walks_past_other_reference_only_turns(self):
        assert (
            resolve_search_query(
                "can you search it up for me",
                history(TOPIC, "search it up", "search it up again"),
            )
            == TOPIC
        )

    def test_borrows_a_cleaned_subject_from_an_earlier_command(self):
        assert (
            resolve_search_query(
                "search it up for me please",
                history("can you search for the population of Czechia"),
            )
            == "the population of Czechia"
        )

    def test_assistant_replies_are_not_treated_as_a_topic(self):
        # A reply is long and may be a refusal — borrowing it would search a
        # paraphrase of the answer instead of the question.
        convo = [
            {"role": "user", "content": TOPIC},
            {"role": "assistant", "content": "Czechia has about 10.9 million people."},
        ]
        assert resolve_search_query("search it up", convo) == TOPIC

    def test_no_earlier_turn_means_no_search_rather_than_a_useless_one(self):
        assert resolve_search_query("search it up") is None
        assert resolve_search_query("search it up", []) is None

    def test_no_search_when_the_heuristic_says_no(self):
        assert resolve_search_query("thanks", history(TOPIC)) is None


class TestPipelineUsesTheSubject:
    """The resolved subject — not the raw message — is what reaches the search."""

    def _run(self, message: str, convo: list[dict[str, str]], monkeypatch) -> list[str]:
        import app.pipeline as pipeline

        seen: list[str] = []

        async def fake_decision(*_args, **_kwargs):
            # "The model is unavailable" — exactly the case these tests cover:
            # the keyword path is what decides when the model cannot.
            return None

        async def fake_search(query):
            seen.append(query)
            return None

        async def fake_model(model, messages, tools, on_chunk, options):
            on_chunk("ok")
            return {"content": "ok", "toolCalls": [], "metrics": {}}

        monkeypatch.setattr(pipeline, "decide_search", fake_decision)
        monkeypatch.setattr(pipeline, "get_web_context", fake_search)
        monkeypatch.setattr(pipeline, "stream_chat_with_tools", fake_model)

        asyncio.run(
            pipeline.run_pipeline(
                {
                    "model": "test-model",
                    "messages": [*convo, {"role": "user", "content": message}],
                    "mode": "chat",
                    "onChunk": lambda *_: None,
                }
            )
        )
        return seen

    def test_follow_up_searches_the_topic_not_the_wording(self, monkeypatch):
        seen = self._run(
            "can you search it up for me",
            [{"role": "user", "content": TOPIC}],
            monkeypatch,
        )
        assert seen == [TOPIC]

    def test_short_follow_up_actually_searches(self, monkeypatch):
        seen = self._run("search it up", [{"role": "user", "content": TOPIC}], monkeypatch)
        assert seen == [TOPIC]

    def test_nothing_to_search_for_means_no_search_at_all(self, monkeypatch):
        seen = self._run("search it up", [], monkeypatch)
        assert seen == []

    def test_plain_question_is_unchanged_end_to_end(self, monkeypatch):
        seen = self._run(TOPIC, [], monkeypatch)
        assert seen == [TOPIC]


class TestDecisionParsing:
    def test_plain_json(self):
        assert parse_search_decision('{"search": true, "query": "czechia population"}') == {
            "search": True,
            "query": "czechia population",
        }
        assert parse_search_decision('{"search": false, "query": ""}') == {
            "search": False,
            "query": "",
        }

    def test_json_wrapped_in_prose_or_fences(self):
        raw = 'Sure!\n```json\n{"search": true, "query": "messi goals"}\n```\nHope that helps.'
        assert parse_search_decision(raw) == {"search": True, "query": "messi goals"}

    def test_string_booleans_are_understood(self):
        assert parse_search_decision('{"search": "true", "query": "x"}')["search"] is True
        assert parse_search_decision('{"search": "no", "query": ""}')["search"] is False

    def test_unusable_replies_are_rejected_rather_than_guessed(self):
        assert parse_search_decision("I think you should search for it.") is None
        assert parse_search_decision('{"search": "maybe", "query": "x"}') is None
        assert parse_search_decision('{"query": "x"}') is None
        assert parse_search_decision("") is None
        assert parse_search_decision("{not json}") is None

    def test_missing_query_with_a_yes_is_kept_as_a_yes(self):
        assert parse_search_decision('{"search": true}') == {"search": True, "query": ""}


class TestModelDecision:
    def _stub_model(self, monkeypatch, reply: str | None, error: bool = False, delay: float = 0.0):
        async def fake_stream(model, messages, on_chunk, options):
            if delay:
                await asyncio.sleep(delay)
            if error:
                raise RuntimeError("model gone")
            on_chunk(reply or "")

        monkeypatch.setattr(search_mod, "stream_chat", fake_stream)

    def test_the_conversation_is_what_the_model_sees(self, monkeypatch):
        captured: dict = {}

        async def fake_stream(model, messages, on_chunk, options):
            captured["prompt"] = messages[0]["content"]
            captured["model"] = model
            on_chunk('{"search": true, "query": "czechia population 2026"}')

        monkeypatch.setattr(search_mod, "stream_chat", fake_stream)
        decision = asyncio.run(
            decide_search(
                [
                    {"role": "user", "content": TOPIC},
                    {"role": "assistant", "content": "About 10.9 million."},
                    {"role": "user", "content": "search it up"},
                ],
                "test-model",
            )
        )
        assert decision == {"search": True, "query": "czechia population 2026"}
        assert captured["model"] == "test-model"
        # The model must SEE the earlier turn, or "it" is unanswerable.
        assert TOPIC in captured["prompt"]
        assert "search it up" in captured["prompt"]

    def test_image_markers_never_leak_into_the_prompt(self, monkeypatch):
        captured: dict = {}

        async def fake_stream(model, messages, on_chunk, options):
            captured["prompt"] = messages[0]["content"]
            on_chunk('{"search": false, "query": ""}')

        monkeypatch.setattr(search_mod, "stream_chat", fake_stream)
        asyncio.run(
            decide_search([{"role": "user", "content": "hi [image:abc.png]"}], "test-model")
        )
        assert "[image" not in captured["prompt"]

    def test_a_broken_model_means_no_decision(self, monkeypatch):
        self._stub_model(monkeypatch, None, error=True)
        assert asyncio.run(decide_search(history(TOPIC), "test-model")) is None

    def test_a_slow_model_times_out_instead_of_stalling_the_turn(self, monkeypatch):
        self._stub_model(monkeypatch, '{"search": true, "query": "x"}', delay=5.0)
        monkeypatch.setattr(search_mod, "SEARCH_DECISION_TIMEOUT_S", 0.05)
        assert asyncio.run(decide_search(history(TOPIC), "test-model")) is None

    def test_garbage_output_means_no_decision(self, monkeypatch):
        self._stub_model(monkeypatch, "I would search for the population.")
        assert asyncio.run(decide_search(history(TOPIC), "test-model")) is None

    def test_an_empty_conversation_costs_nothing(self, monkeypatch):
        async def explode(*_args, **_kwargs):
            raise AssertionError("the model must not be called with nothing to read")

        monkeypatch.setattr(search_mod, "stream_chat", explode)
        assert asyncio.run(decide_search([], "test-model")) is None


class TestPlanSearch:
    """Who decides, and what wins when the model and the keywords disagree."""

    def _plan(self, monkeypatch, decision, message, history_msgs=None):
        async def fake_decision(*_args, **_kwargs):
            return decision

        monkeypatch.setattr("app.pipeline.decide_search", fake_decision)
        return asyncio.run(
            plan_search(
                [*(history_msgs or []), {"role": "user", "content": message}],
                message,
                "test-model",
            )
        )

    def test_the_models_query_wins(self, monkeypatch):
        plan = self._plan(
            monkeypatch,
            {"search": True, "query": "czechia population 2026"},
            "can you search it up for me please",
        )
        assert plan["query"] == "czechia population 2026"
        assert plan["source"] == "model"

    def test_the_model_can_say_no_where_keywords_would_have_searched(self, monkeypatch):
        # "current population" trips every keyword rule there is.
        plan = self._plan(monkeypatch, {"search": False, "query": ""}, TOPIC)
        assert plan["query"] is None
        assert plan["source"] == "model"

    def test_a_model_that_wants_a_search_but_writes_no_usable_query(self, monkeypatch):
        plan = self._plan(
            monkeypatch,
            {"search": True, "query": "it"},
            "search it up",
            history(TOPIC),
        )
        assert plan["query"] == TOPIC
        assert plan["source"] == "model+keywords"

    def test_no_decision_falls_back_to_the_keywords(self, monkeypatch):
        plan = self._plan(monkeypatch, None, TOPIC)
        assert plan["query"] == TOPIC
        assert plan["source"] == "keywords"

    def test_no_decision_and_nothing_to_search(self, monkeypatch):
        plan = self._plan(monkeypatch, None, "thanks")
        assert plan["query"] is None
        assert plan["reason"]

    def test_an_unusable_query_is_rejected_by_the_guard(self):
        assert usable_search_query("it") is None
        assert usable_search_query("  ") is None
        assert usable_search_query(None) is None
        assert usable_search_query('  "czechia population"  ') == "czechia population"
        assert len(usable_search_query("x " * 500) or "") <= 300


class TestModelDecisionEndToEnd:
    def test_a_pronoun_follow_up_is_searched_where_keywords_would_not(self, monkeypatch):
        """"and its population?" matches no keyword rule at all — only a model
        can see what it refers to. This is the whole point of the change."""
        import app.pipeline as pipeline

        message = "and what about that one?"
        assert needs_web_search(message) is False  # the keyword path never searches this

        seen: list[str] = []

        async def fake_decision(messages, model, **kwargs):
            return {"search": True, "query": "czechia population 2026"}

        async def fake_search(query):
            seen.append(query)
            return None

        async def fake_model(model, messages, tools, on_chunk, options):
            on_chunk("ok")
            return {"content": "ok", "toolCalls": [], "metrics": {}}

        monkeypatch.setattr(pipeline, "decide_search", fake_decision)
        monkeypatch.setattr(pipeline, "get_web_context", fake_search)
        monkeypatch.setattr(pipeline, "stream_chat_with_tools", fake_model)

        asyncio.run(
            pipeline.run_pipeline(
                {
                    "model": "test-model",
                    "messages": [
                        {"role": "user", "content": TOPIC},
                        {"role": "assistant", "content": "About 10.9 million."},
                        {"role": "user", "content": message},
                    ],
                    "mode": "chat",
                    "onChunk": lambda *_: None,
                }
            )
        )
        assert seen == ["czechia population 2026"]

    def test_the_keyword_path_at_best_search_its_own_pronouns(self, monkeypatch):
        """The contrast that motivates the change: a message with a keyword the
        rules recognise still gives them nothing to search FOR."""
        message = "and its population?"
        assert needs_web_search(message) is True
        assert resolve_search_query(message, history(TOPIC)) == "its population"

        async def no_decision(*_args, **_kwargs):
            return None

        monkeypatch.setattr("app.pipeline.decide_search", no_decision)
        plan = asyncio.run(
            plan_search(
                [*(history(TOPIC)), {"role": "user", "content": message}],
                message,
                "test-model",
            )
        )
        # Without the model, that useless query is what reaches the search engine.
        assert plan["query"] == "its population"
        assert plan["source"] == "keywords"

    def test_the_decision_failure_hurts_nothing(self, monkeypatch):
        """A model that cannot decide must not stop the reply."""
        import app.pipeline as pipeline

        async def broken_decision(*_args, **_kwargs):
            raise RuntimeError("decision layer exploded")

        async def fake_model(model, messages, tools, on_chunk, options):
            on_chunk("Hello!")
            return {"content": "Hello!", "toolCalls": [], "metrics": {}}

        monkeypatch.setattr(pipeline, "decide_search", broken_decision)
        monkeypatch.setattr(pipeline, "stream_chat_with_tools", fake_model)

        # plan_search wraps the decision, so an exploding layer is caught by the
        # fallback rather than killing the turn.
        reply = asyncio.run(
            pipeline.run_pipeline(
                {
                    "model": "test-model",
                    "messages": [                    {"role": "user", "content": "hello there"}],
                    "mode": "chat",
                    "onChunk": lambda *_: None,
                }
            )
        )
        assert "Hello" in reply

    def test_even_a_broken_planner_cannot_stop_the_reply(self, monkeypatch):
        """The second layer: an exception escaping plan_search itself."""
        import app.pipeline as pipeline

        async def exploding_plan(*_args, **_kwargs):
            raise RuntimeError("planning layer exploded")

        async def fake_model(model, messages, tools, on_chunk, options):
            on_chunk("Still here.")
            return {"content": "Still here.", "toolCalls": [], "metrics": {}}

        monkeypatch.setattr(pipeline, "plan_search", exploding_plan)
        monkeypatch.setattr(pipeline, "stream_chat_with_tools", fake_model)

        reply = asyncio.run(
            pipeline.run_pipeline(
                {
                    "model": "test-model",
                    "messages": [{"role": "user", "content": "hello there"}],
                    "mode": "chat",
                    "onChunk": lambda *_: None,
                }
            )
        )
        assert "Still here" in reply


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-q"]))
