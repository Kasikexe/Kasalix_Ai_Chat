"""The eval harness, tested — so its numbers can be trusted.

The harness reports on ALC, which means it has to be right about ALC. Three
things are checked here, all without Ollama:

* the corpus fixture is self-consistent (every expected token really is in the
  sources the case names, and the invented cases really are absent);
* the scorer discriminates — it credits a correct answer, refuses credit for a
  fabricated one, and does not confuse 12 with 120;
* the pipeline plumbing in BOTH directions: with a scripted "oracle" that may
  only state what the pipeline put in front of it, ALC scores and Normal does
  not, and the scripted "guesser" is caught inventing.

The scripted model is the point: it removes the model's own variability from the
question "did the retrieval actually reach the prompt?".
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

_TMP = tempfile.mkdtemp(prefix="kasalix-alc-eval-test-")
os.environ["DATA_DIR"] = _TMP
os.environ["OLLAMA_URL"] = "http://127.0.0.1:9"

import pytest  # noqa: E402

from eval import alc_eval  # noqa: E402
from eval.corpus import CASES, CLASSIC, build as build_corpus  # noqa: E402
from eval.scoring import _ADMISSION_RE, normalise, score_answer, tally  # noqa: E402


# ─── The fixture and the scorer ─────────────────────────────────────────
def test_every_expected_token_is_actually_in_its_own_sources():
    """If this fails the harness is asking for something its docs do not say."""
    root = Path(tempfile.mkdtemp(prefix="alc-eval-fixture-"))
    corpus = build_corpus(root)
    problems: list[str] = []
    for case in corpus.cases:
        if not case.expect:
            continue
        facts = normalise(corpus.facts_for(case))
        missing = [token for token in case.expect if normalise(token) not in facts]
        if missing:
            problems.append(f"{case.id}: {missing}")
    assert not problems, problems


def test_absent_case_is_absent_from_every_file():
    root = Path(tempfile.mkdtemp(prefix="alc-eval-fixture-"))
    corpus = build_corpus(root)
    case = corpus.by_id("brimwall-absent")
    assert case.expect == ()
    # Neither the name nor a value is documented anywhere — the question is the
    # only place "brimwall" appears, so no amount of retrieval can answer it.
    assert "brimwall" not in corpus.all_text().lower()


def test_conflicting_sources_are_ordered_by_age():
    """The conflict case is only resolvable if the newer file really is newer."""
    root = Path(tempfile.mkdtemp(prefix="alc-eval-fixture-"))
    corpus = build_corpus(root)
    old = (corpus.docs_root / "vintra-changelog.md").stat().st_mtime
    new = (corpus.docs_root / "vintra-pacing.md").stat().st_mtime
    assert new > old, "the superseding source must be the newer one"


async def test_scorer_credits_correct_and_refuses_to_credit_invention():
    root = Path(tempfile.mkdtemp(prefix="alc-eval-fixture-"))
    corpus = build_corpus(root)
    case = corpus.by_id("halyard-pace")

    good = score_answer("halyard_set_pace defaults to 12 frames.", case, corpus)
    assert good.verdict == "correct" and good.ok

    fabricated = score_answer("halyard_set_pace defaults to 99 frames.", case, corpus)
    assert fabricated.verdict == "invented" and not fabricated.ok
    assert "99" in fabricated.invented

    # 120 contains "12" as a substring but is not the documented value.
    sneaky = score_answer("The default is 120 frames for halyard_set_pace.", case, corpus)
    assert sneaky.verdict == "invented"

    silent = score_answer("I could not find that in the documentation.", case, corpus)
    assert silent.verdict == "wrong"  # honest, but no credit when the answer exists


async def test_scorer_credits_admission_on_an_unanswerable_question():
    root = Path(tempfile.mkdtemp(prefix="alc-eval-fixture-"))
    corpus = build_corpus(root)
    case = corpus.by_id("brimwall-absent")

    honest = score_answer("I could not find that — brimwall_set_ceiling is not documented.", case, corpus)
    assert honest.verdict == "admitted" and honest.ok

    guessed = score_answer("brimwall_set_ceiling defaults to 42.", case, corpus)
    assert guessed.verdict == "invented" and not guessed.ok


def test_scorer_credits_an_honest_refusal_dressed_up_with_an_adverb():
    """Reading a live run found this: the 1.7B said "not explicitly documented" —
    honest, and scored as a FAILURE, because the literal phrase "not documented"
    was not in the text. Refusing credit over an adverb understates the model."""
    root = Path(tempfile.mkdtemp(prefix="alc-eval-fixture-"))
    corpus = build_corpus(root)
    case = corpus.by_id("brimwall-absent")
    phrasings = (
        "The default value of brimwall_set_ceiling() is not explicitly documented in the provided sources.",
        "brimwall_set_ceiling is not directly mentioned anywhere.",
        "It isn't clearly defined in the sources I was given.",
        "There is no documentation for brimwall_set_ceiling.",
        "The value is not listed.",
    )
    for phrasing in phrasings:
        verdict = score_answer(phrasing, case, corpus)
        assert verdict.verdict == "admitted", (phrasing, verdict.verdict)


def test_an_honest_phrase_does_not_excuse_a_fabricated_value():
    """The relaxed rule must never hide the failure the harness exists to catch."""
    root = Path(tempfile.mkdtemp(prefix="alc-eval-fixture-"))
    corpus = build_corpus(root)
    case = corpus.by_id("brimwall-absent")
    mixed = "brimwall_set_ceiling is not documented here, but it defaults to 42 frames."
    verdict = score_answer(mixed, case, corpus)
    assert verdict.verdict == "invented", verdict.verdict
    assert "42" in verdict.invented


def test_the_relaxed_admission_rule_does_not_fire_on_ordinary_prose():
    for text in (
        "Halyard drives its render loop from a frame clock.",
        "brimwall_set_ceiling returns a list of active ceilings in meters.",
        "Quorvex 3.14.2 is the oldest release that supports the tide adapter.",
        "The retry window is 45 seconds.",
    ):
        assert not _ADMISSION_RE.search(text), text


def test_scorer_ignores_list_markers_and_dates():
    root = Path(tempfile.mkdtemp(prefix="alc-eval-fixture-"))
    corpus = build_corpus(root)
    case = corpus.by_id("peltarn-rate")
    answer = "1. Peltarn allows 900 requests per minute.\n2. The limit is per key, checked in 2026."
    verdict = score_answer(answer, case, corpus)
    assert verdict.verdict == "correct"
    assert verdict.invented == [], verdict.invented


def test_tally_separates_credit_from_correctness():
    rows = [
        {"verdict": "correct"},
        {"verdict": "admitted"},
        {"verdict": "invented"},
        {"verdict": "wrong"},
    ]
    summary = tally(rows)
    assert summary["credit"] == 2
    assert summary["correct_rate"] == 0.25
    assert summary["invented_rate"] == 0.25


# ─── The plumbing, with a scripted model ────────────────────────────────
async def _run(arms, case_ids=None, *, fake="oracle", limit=0, docs=True):
    """Run the harness over the real pipeline with a scripted model."""
    root = Path(tempfile.mkdtemp(prefix="alc-eval-suite-"))
    corpus = build_corpus(root)
    chosen = list(corpus.cases)
    if case_ids:
        wanted = set(case_ids)
        chosen = [case for case in chosen if case.id in wanted]
    if limit:
        chosen = chosen[:limit]
    ctx = alc_eval.RunContext(
        corpus=corpus,
        root=root,
        model="scripted",
        docs=docs,
        web=False,
        fake=alc_eval.FakeModel(fake) if fake else None,
    )
    rows: list[dict] = []
    meter = alc_eval.Meter()
    alc_eval.install_meter(meter)
    alc_eval.apply_patches(web=False, fake=ctx.fake)
    try:
        for name in arms:
            arm = alc_eval.ARMS[name]
            for case in chosen:
                rows.extend(await alc_eval.run_case(ctx, arm, case, meter))
    finally:
        alc_eval.restore_patches()
    return rows, corpus


async def test_retrieved_evidence_reaches_the_answer_and_normal_gets_none():
    rows, _ = await _run(("normal", "alc-none"), case_ids={"halyard-pace", "peltarn-rate"})
    normal = [row for row in rows if row["arm"] == "normal"]
    alc = [row for row in rows if row["arm"] == "alc-none"]

    assert len(normal) == 2 and len(alc) == 2
    assert tally(normal)["credit"] == 0, "Normal has no documentation source at all"
    assert tally(alc)["counts"]["correct"] == 2, [row["answer"] for row in alc]
    assert all(row["calls"] > 0 for row in alc)


async def test_the_cycle_really_searches_the_configured_documentation():
    rows, _ = await _run(("alc-none",), case_ids={"halyard-pace"})
    row = rows[0]
    assert row["alcEvents"].get("alc:search"), row["alcEvents"]
    assert row["alcEvents"].get("alc:finding"), f"nothing was kept: {row['alcEvents']}"
    assert row["alcFindings"] >= 1
    assert row["alcCycles"] >= 1


async def test_an_unanswerable_question_is_admitted_not_guessed():
    """The corpus has one answerable-by-nothing case: retrieve, retry, then say so."""
    rows, _ = await _run(("alc-none",), case_ids={"brimwall-absent"})
    row = rows[0]
    assert row["verdict"] == "admitted", row["answer"]
    assert tally(rows)["credit"] == 1
    assert tally(rows)["counts"]["invented"] == 0


def test_every_hard_case_is_answerable_from_its_own_sources():
    """The suite's fixtures must satisfy the harness's own self-check.

    A hard case whose expected token is not in its sources would be asking for
    something the documentation does not say — a broken fixture, not a hard one.
    """
    hard = [case for case in CLASSIC.cases if case.suite == "hard"]
    assert hard, "the hard suite must exist"
    assert {case.suite for case in CLASSIC.cases} == {"core", "hard"}
    assert [case.id for case in hard if case.holdout], "some hard cases are held out"
    for case in hard:
        if not case.expect:
            continue
        facts = normalise("\n".join(CLASSIC.files[name] for name in case.sources))
        missing = [token for token in case.expect if normalise(token) not in facts]
        assert not missing, f"{case.id}: its own sources do not state {missing}"


def test_the_hard_suite_covers_the_three_weak_spots():
    kinds = {case.kind for case in CLASSIC.cases if case.suite == "hard"}
    assert {"paraphrase", "distractor", "note_conflict", "absent"} <= kinds


async def test_a_stale_note_is_planted_for_the_poisoned_note_case():
    """A knowledge store's own hazard: its notes can be wrong."""
    rows, corpus = await _run(("alc-study",), case_ids={"vintra-poisoned-note"})
    case = corpus.by_id("vintra-poisoned-note")
    assert case.planted_note, "the case needs a note to be about"
    # Each arm reads its own workspace, so the note has to be planted there.
    planted = corpus.root / "alc-study" / "workspace" / "ALC" / "knowledge" / "vintra-poisoned-note.md"
    assert planted.exists(), "the note must be in the store the turn reads"
    assert rows[0]["verdict"] in ("correct", "partial"), rows[0]
    assert rows[0]["failureStage"] == "", rows[0]


def test_plant_note_writes_where_the_knowledge_search_looks(tmp_path):
    case = next(case for case in CLASSIC.cases if case.id == "vintra-poisoned-note")
    written = alc_eval.plant_note(tmp_path, case)
    assert written.read_text(encoding="utf-8") == case.planted_note
    assert written.parent.name == "knowledge"


def test_failure_stages_name_the_step_that_lost_the_turn():
    """A score says how many; the stage says what to fix."""
    def row(**over):
        base = {"verdict": "wrong", "error": "", "stale": [], "invented": [], "answer": "x", "alcFindings": 1}
        base.update(over)
        return base

    alc = [{"type": "alc:start"}, {"type": "alc:search"}, {"type": "alc:result"}]
    assert alc_eval.classify_failure(row(verdict="correct"), alc) == ""
    assert alc_eval.classify_failure(row(verdict="admitted"), alc) == ""
    assert alc_eval.classify_failure(row(), [{"type": "stage"}]) == "no-cycle"
    assert alc_eval.classify_failure(row(error="timeout"), alc) == "error"
    assert alc_eval.classify_failure(row(stale=["12"]), alc) == "conflict"
    assert alc_eval.classify_failure(row(invented=["99"]), alc) == "unsupported-claim"
    assert alc_eval.classify_failure(row(answer=""), alc) == "empty-answer"
    assert alc_eval.classify_failure(row(), [{"type": "alc:start"}]) == "no-lookup"
    # Candidates came back and none were kept: the judge, not the retriever.
    kept_none = [{"type": "alc:start"}, {"type": "alc:search"}, {"type": "alc:result", "count": 4}]
    assert alc_eval.classify_failure(row(alcFindings=0), kept_none) == "judge-drop"
    # The search itself came back empty: the retriever.
    found_none = [{"type": "alc:start"}, {"type": "alc:search"}, {"type": "alc:result", "count": 0}]
    assert alc_eval.classify_failure(row(alcFindings=0), found_none) == "retrieval-miss"
    assert alc_eval.classify_failure(row(), alc) == "unclassified"


async def test_a_guessing_model_is_caught_inventing():
    """The ablation pair that proves the answer check does something.

    With the check off, a confidently wrong model is caught by the scorer — the
    failure the whole harness exists to detect. With it on (the shipped cycle,
    which is what `alc-none` runs), the fabricated sentence never reaches the
    reader, so the turn is scored as honest ignorance instead of an invention.
    That difference IS the measurement.
    """
    unguarded, _ = await _run(
        ("alc-noguard",), case_ids={"halyard-pace", "peltarn-rate"}, fake="guesser"
    )
    summary = tally(unguarded)
    assert summary["counts"]["invented"] == 2, summary
    assert summary["credit"] == 0
    assert {row["failureStage"] for row in unguarded} == {"unsupported-claim"}, unguarded

    guarded, _ = await _run(("alc-none",), case_ids={"halyard-pace", "peltarn-rate"}, fake="guesser")
    guarded_summary = tally(guarded)
    assert guarded_summary["counts"]["invented"] == 0, guarded
    # NOT credit either: these cases HAVE an answer, and the scorer only credits
    # honest ignorance where nothing was expected (otherwise an arm could farm
    # credit by refusing everything). What the guard buys is that the turn fails
    # as a miss instead of as a confident lie — 2 inventions became 0.
    assert guarded_summary["credit"] == 0
    assert all(row["failureStage"] != "unsupported-claim" for row in guarded)
    for row in guarded:
        assert "99" not in row["answer"], row["answer"]
        assert "could not verify" in row["answer"], row["answer"]


async def test_carry_runs_three_turns_with_the_documentation_removed():
    rows, corpus = await _run(("alc-study",), case_ids={"peltarn-carry"})
    variants = [row["variant"] for row in rows]
    assert variants == ["seed", "warm", "cold"]
    seed, warm, cold = rows
    assert seed["docs"] is True
    assert warm["docs"] is False and cold["docs"] is False
    # The two second turns differ in exactly one way: whether the store survived.
    assert warm["question"] == cold["question"] == corpus.by_id("peltarn-carry").follow_up
    # The seed turn is what fills the store, and the cold control must start empty.
    assert seed["knowledgeFiles"], "the seed turn must leave project knowledge behind"
    assert cold["knowledgeFiles"] == [], "the cold control must start from an empty store"


async def test_the_store_carries_a_fact_into_a_later_session():
    """The whole point of the phase, end to end with a scripted model.

    Turn 1 reads the documentation and learns; turn 2 runs in a FRESH conversation
    with the documentation gone, so only what was written down can answer it. The
    cold control runs the identical turn against an empty store.
    """
    rows, _ = await _run(("alc-study", "alc-raw"), case_ids={"peltarn-carry"})
    for arm in ("alc-study", "alc-raw"):
        warm = next(row for row in rows if row["arm"] == arm and row["variant"] == "warm")
        cold = next(row for row in rows if row["arm"] == arm and row["variant"] == "cold")
        assert warm["verdict"] in ("correct", "partial"), warm["answer"]
        assert warm["verdict"] != cold["verdict"], (
            f"{arm}: the store made no difference (warm={warm['verdict']}, cold={cold['verdict']})"
        )
        assert cold["verdict"] in ("wrong", "invented", "admitted"), cold["answer"]


async def test_a_turn_that_writes_nothing_back_carries_nothing():
    """The alc-none arm is the pre-Phase-4 behaviour: gather, answer, keep nothing."""
    rows, _ = await _run(("alc-none",), case_ids={"peltarn-carry"})
    seed = next(row for row in rows if row["variant"] == "seed")
    assert seed["knowledgeFiles"] == []
    warm = next(row for row in rows if row["variant"] == "warm")
    cold = next(row for row in rows if row["variant"] == "cold")
    assert warm["verdict"] == cold["verdict"]


async def test_normal_mode_never_writes_project_knowledge():
    rows, _ = await _run(("normal",), case_ids={"peltarn-carry"})
    assert all(row["knowledgeFiles"] == [] for row in rows)
    assert all(not row["alcEvents"] for row in rows)


def test_arm_gating_reports_what_this_checkout_can_actually_run():
    """The harness must not silently run an arm whose mechanism is missing."""
    ok, why = alc_eval.arm_available(alc_eval.ARMS["normal"])
    assert ok and why == ""
    ok, why = alc_eval.arm_available(alc_eval.ARMS["alc-heuristic"])
    assert ok, why
