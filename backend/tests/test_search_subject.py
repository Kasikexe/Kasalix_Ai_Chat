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

from app.pipeline import (  # noqa: E402
    extract_search_topic,
    needs_web_search,
    resolve_search_query,
)

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

        async def fake_search(query):
            seen.append(query)
            return None

        async def fake_model(model, messages, tools, on_chunk, options):
            on_chunk("ok")
            return {"content": "ok", "toolCalls": [], "metrics": {}}

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


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-q"]))
