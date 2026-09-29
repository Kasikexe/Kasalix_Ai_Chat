"""ALC answer verification — software decides what the user is allowed to read.

The gate is the honesty guarantee for the *answer*, the way :mod:`app.alc.study`
is the guarantee for the note. It runs mid-stream (the client appends chunks and
never reconciles them with the final message), so the properties that matter are
behavioural and exact:

* grounded prose passes through character for character;
* a sentence asserting a value that is in no source is NEVER emitted — the
  released text must not contain it, which is what makes the metric and the
  user's screen agree;
* code, list markers and ordinary prose are left alone (a guard that mangles a
  correct answer is worse than the fabrication it prevented);
* what the caller returns is exactly what was released.
"""

from __future__ import annotations

import os
import tempfile

os.environ.setdefault("DATA_DIR", tempfile.mkdtemp(prefix="kasalix-alc-verify-test-"))
os.environ.setdefault("OLLAMA_URL", "http://127.0.0.1:9")

from app.alc.verify import (  # noqa: E402
    AnswerGate,
    allowed_specifics,
    claim_tokens,
    evidence_norm,
    guard_hint,
    ungrounded_claims,
)

DOC = (
    "# Halyard\n"
    "\n"
    "## Clock\n"
    "\n"
    "HALYARD_MAX_FRAMES defaults to 120 frames and is capped by "
    "HalyardMode.RELAXED. Read a file with halyard/clock.py and watch clock_frames. "
    "A frame budget of 120 is the documented default; the ceiling is 4000.\n"
)
EVIDENCE = evidence_norm(DOC)


# ─── Claim extraction ───────────────────────────────────────────────────
def test_claim_tokens_finds_the_shapes_a_fabrication_arrives_in():
    text = (
        "Set HALYARD_MAX_FRAMES and read halyard/clock.py; "
        "HalyardMode.RELAXED raises QUORVEX-4513. The default is 120 and the cap is 4000."
    )
    tokens = claim_tokens(text)
    assert "HALYARD_MAX_FRAMES" in tokens
    assert "halyard/clock.py" in tokens
    assert "HalyardMode.RELAXED" in tokens
    assert "QUORVEX-4513" in tokens
    assert "120" in tokens
    assert any(token == "4000" for token in tokens)


def test_claim_tokens_ignores_prose_numbers_and_dates():
    # A guard that flags ordinary prose would destroy correct answers.
    tokens = claim_tokens("Here are 3 things to know. Step 2 is optional. It shipped in 2019.")
    assert tokens == []


def test_claim_tokens_flags_numbers_in_a_value_position():
    assert "1000" in claim_tokens("the default is 1000")
    assert "120" in claim_tokens("HALYARD_MAX_FRAMES defaults to 120")
    assert "4000" in claim_tokens("the cap is 4000")
    assert "60" in claim_tokens("it returns 60 ms")
    assert "2.5" in claim_tokens("pygame 2.5 changed this")


def test_ungrounded_claims_needs_the_value_in_the_evidence():
    assert ungrounded_claims("HALYARD_MAX_FRAMES defaults to 120.", EVIDENCE) == []
    assert ungrounded_claims("HALYARD_MAX_FRAMES defaults to 1000.", EVIDENCE) == ["1000"]
    assert ungrounded_claims("Use halyard/pace.py.", EVIDENCE) == ["halyard/pace.py"]


def test_allowed_specifics_are_bounded_and_drop_years():
    allowed = allowed_specifics(DOC, limit=5)
    assert 0 < len(allowed) <= 5
    assert "2019" not in allowed_specifics("released 2019 and 2020")


def test_guard_hint_says_so_when_there_is_nothing_to_cite():
    assert "NOTHING TO CITE" in guard_hint("")
    assert "HALYARD_MAX_FRAMES" in guard_hint(DOC)


# ─── The gate ───────────────────────────────────────────────────────────
def _run(chunks: list[str], evidence: str = EVIDENCE, *, enabled: bool = True) -> tuple[str, AnswerGate]:
    gate = AnswerGate(evidence, enabled=enabled)
    emitted = "".join(gate.feed(chunk) for chunk in chunks)
    emitted += gate.finish()
    assert emitted == gate.released, "what the caller emits must equal what was released"
    return emitted, gate


def test_grounded_answer_passes_through_unchanged():
    answer = "HALYARD_MAX_FRAMES defaults to 120 frames.\nThe ceiling is 4000.\n"
    released, gate = _run([answer])
    assert released == answer
    assert gate.result.blocks == 0


def test_a_fabricated_value_never_reaches_the_reader():
    answer = "The default is 1000 frames, which is plenty.\n"
    released, gate = _run([answer])
    assert "1000" not in released
    assert "could not verify" in released
    assert gate.result.blocks == 1
    # The point of the gate: no claim from the withheld text reaches the reader,
    # so the scored answer and the user's screen agree.
    assert not set(claim_tokens(answer)) & set(claim_tokens(released))


def test_only_the_offending_sentence_is_replaced():
    answer = "HALYARD_MAX_FRAMES defaults to 120 frames. The hard cap is 9999.\n"
    released, _gate = _run([answer])
    assert "120 frames" in released  # the supported sentence survives
    assert "9999" not in released


def test_gate_holds_a_unit_until_it_is_complete():
    gate = AnswerGate(EVIDENCE)
    assert gate.feed("The default is ") == ""
    # The value is still arriving — nothing may be emitted before it can be judged.
    assert gate.feed("") == ""
    tail = gate.feed("120 frames.\n")
    assert "120 frames" in tail


def test_chunk_boundaries_do_not_change_the_verdict():
    whole = "HALYARD_MAX_FRAMES defaults to 1000.\n"
    released, _gate = _run([whole])
    split, _gate2 = _run([whole[:9], whole[9:16], whole[16:]])
    assert "1000" not in released and "1000" not in split
    assert released == split


def test_code_blocks_are_never_touched():
    answer = (
        "Here is how to set it:\n"
        "```python\n"
        "frames = 9999\n"
        "cap = 12345\n"
        "```\n"
    )
    released, gate = _run([answer])
    assert released == answer
    assert gate.result.blocks == 0


def test_a_bullet_keeps_its_shape_when_replaced():
    released, _gate = _run(["- The default is 1000 frames.\n"])
    assert released.startswith("- I could not verify")
    assert "1000" not in released


def test_withheld_details_are_recorded_for_the_trajectory():
    _released, gate = _run(["The cap is 9999 frames.\n"])
    assert gate.result.withheld
    assert gate.result.withheld[0]["claims"] == ["9999"]
    answer = "The default is 1000 frames.\n"
    released, gate = _run([answer], enabled=False)
    assert released == answer
    assert gate.result.blocks == 0


def test_a_long_runaway_unit_is_released_instead_of_stalling():
    # No sentence end and no newline anywhere: the buffer has to be force-flushed
    # rather than held forever waiting for a boundary that never comes.
    answer = ("word " * 400) + "the default is 1000"
    released, _gate = _run([answer])
    assert released  # something came out rather than buffering forever
    assert "1000" not in released


def test_closing_note_only_when_nothing_verifiable_survived():
    _released, gate = _run(["The default is 1000.\n"])
    assert "not going to guess" in gate.closing_note()
    _released2, mixed = _run(["Set HALYARD_MAX_FRAMES to 120. The cap is 9999.\n"])
    assert mixed.closing_note() == ""
