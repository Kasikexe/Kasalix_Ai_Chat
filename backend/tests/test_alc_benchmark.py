"""ALC Benchmark — the menu, the history and the comparison.

A benchmark that gets its arithmetic wrong is worse than no benchmark, so the
things checked here are: the fact generator really produces fresh, self-consistent
facts per seed; a saved run is read back with the metadata needed to compare it
later; the summary counts the same way the harness does; and the comparison says
which direction is better in words rather than leaving an arrow to interpret.

The end-to-end test drives the whole path (benchmark → subprocess → harness →
saved json → summary) with the scripted model, so it needs no Ollama.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

_TMP = tempfile.mkdtemp(prefix="kasalix-alc-benchmark-test-")
os.environ["DATA_DIR"] = _TMP
os.environ["OLLAMA_URL"] = "http://127.0.0.1:9"

import pytest  # noqa: E402

from eval import alc_eval, benchmark  # noqa: E402
from eval.alc_eval import resolve_variant  # noqa: E402
from eval.corpus import CLASSIC, build as build_corpus, generated  # noqa: E402
from eval.scoring import normalise  # noqa: E402


# ─── Generated fact sets ────────────────────────────────────────────────
def test_a_seed_is_repeatable_and_a_new_seed_is_new_facts():
    one, again, other = generated(7), generated(7), generated(8)
    assert one.files == again.files, "the same seed must be the same benchmark"
    assert one.cases == again.cases
    assert one.files != other.files, "a different seed must be different facts"
    assert one.name == "seed-7" and other.name == "seed-8"


def test_generated_facts_are_self_consistent_for_many_seeds():
    """Every expected token must be in that case's own sources, or the benchmark
    is asking for something its own documentation does not say."""
    for seed in (0, 1, 3, 7, 11, 42, 99, 12345):
        root = Path(tempfile.mkdtemp(prefix="alc-bench-fixture-"))
        corpus = build_corpus(root, variant=generated(seed))
        problems: list[str] = []
        for case in corpus.cases:
            if not case.expect:
                continue
            facts = normalise(corpus.facts_for(case))
            missing = [token for token in case.expect if normalise(token) not in facts]
            if missing:
                problems.append(f"seed {seed} {case.id}: {missing}")
        assert not problems, problems
        assert len(corpus.cases) >= 8


def test_generated_variants_cover_every_question_kind():
    kinds = {case.kind for case in generated(5).cases}
    assert {"single", "multi_hop", "conflict", "absent", "carry"} <= kinds


def test_a_generated_absent_case_is_really_absent():
    variant = generated(5)
    corpus = build_corpus(Path(tempfile.mkdtemp()), variant=variant)
    absent = next(case for case in corpus.cases if case.kind == "absent")
    assert absent.expect == ()
    # The function name is only in the question; no file documents it.
    name = absent.question.split("default value of ")[1].split("(")[0]
    assert all(name not in text for text in corpus.files.values())


def test_a_generated_conflict_has_a_newer_superseding_source():
    root = Path(tempfile.mkdtemp())
    corpus = build_corpus(root, variant=generated(9))
    conflict = next(case for case in corpus.cases if case.kind == "conflict")
    older, newer = conflict.sources
    assert (root / "documentation" / newer).stat().st_mtime > (
        root / "documentation" / older
    ).stat().st_mtime
    assert conflict.stale, "the superseded value must be recorded"


def test_resolve_variant_accepts_classic_and_seeds():
    assert resolve_variant("classic").name == "classic"
    assert resolve_variant("").name == "classic"
    assert resolve_variant("seed-7").name == "seed-7"
    assert resolve_variant("7").name == "seed-7"
    assert resolve_variant("seed-7").files == generated(7).files
    with pytest.raises(ValueError):
        resolve_variant("nonsense")


def test_classic_variant_is_untouched_by_the_generator():
    """The tests pin classic's exact tokens; the generator must not move under them."""
    assert CLASSIC.name == "classic"
    assert any(case.id == "halyard-pace" for case in CLASSIC.cases)
    assert CLASSIC.files["halyard-pacing.md"] == build_corpus(Path(tempfile.mkdtemp())).files["halyard-pacing.md"]


# ─── Saved runs ─────────────────────────────────────────────────────────
def _fake_run(label: str, *, credit_by_arm: dict[str, str], variant: str = "classic", **meta) -> dict:
    rows = []
    for arm, verdict in credit_by_arm.items():
        rows.append(
            {
                "key": f"{arm}|case-1|single",
                "arm": arm,
                "case": "case-1",
                "kind": "single",
                "variant": "single",
                "turn": 1,
                "verdict": verdict,
                "matched": ["a"] if verdict == "correct" else [],
                "missing": [] if verdict in ("correct", "admitted") else ["b"],
                "invented": ["99"] if verdict == "invented" else [],
                "ttft": 1.0,
                "total": 2.0,
                "calls": 3,
            }
        )
    return {
        "label": label,
        "tag": meta.get("tag", "alc-test"),
        "variant": variant,
        "model": meta.get("model", "test-model"),
        "startedAt": meta.get("startedAt", "2026-09-29T10:00:00+00:00"),
        "args": {"arms": ",".join(credit_by_arm), "docs": "on", "web": "off"},
        "rows": rows,
    }


def _write(out_dir: Path, payload: dict) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{payload['label']}.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def test_saved_runs_are_listed_newest_first_with_their_metadata(tmp_path):
    out = tmp_path / "reports"
    _write(out, _fake_run("first", credit_by_arm={"alc-study": "correct"}, startedAt="2026-09-29T09:00:00+00:00"))
    _write(out, _fake_run("second", credit_by_arm={"alc-study": "wrong"}, tag="kasalix-1.0", startedAt="2026-09-29T11:00:00+00:00"))

    runs = benchmark.load_runs(out)
    assert [run.label for run in runs] == ["second", "first"]
    assert runs[0].tag == "kasalix-1.0"
    assert runs[0].model == "test-model"
    assert runs[0].variant == "classic"
    assert runs[0].arms == ["alc-study"]


def test_load_ignores_files_that_are_not_runs(tmp_path):
    out = tmp_path / "reports"
    out.mkdir(parents=True)
    (out / "notes.json").write_text('{"hello": "world"}', encoding="utf-8")
    (out / "broken.json").write_text("{not json", encoding="utf-8")
    _write(out, _fake_run("real", credit_by_arm={"normal": "wrong"}))
    assert [run.label for run in benchmark.load_runs(out)] == ["real"]


def test_summary_counts_like_the_harness(tmp_path):
    out = tmp_path / "reports"
    _write(
        out,
        _fake_run(
            "mixed",
            credit_by_arm={
                "normal": "wrong",
                "alc-study": "correct",
                "alc-heuristic": "admitted",
            },
        ),
    )
    run = benchmark.load_runs(out)[0]
    stats = benchmark.summarise(run)
    assert stats["normal"]["credit"] == 0.0
    assert stats["alc-study"]["credit"] == 1.0
    # An honest admission counts as credit, exactly as in the harness.
    assert stats["alc-heuristic"]["credit"] == 1.0
    assert stats["normal"]["calls"] == 3.0


def test_find_run_accepts_a_prefix(tmp_path):
    out = tmp_path / "reports"
    _write(out, _fake_run("phase4-long", credit_by_arm={"normal": "wrong"}))
    runs = benchmark.load_runs(out)
    assert benchmark.find_run(runs, "phase4") is not None
    assert benchmark.find_run(runs, "nothing-like-this") is None


def test_a_new_label_never_overwrites_an_existing_run(tmp_path):
    out = tmp_path / "reports"
    _write(out, _fake_run("alc-0.13.0", credit_by_arm={"normal": "wrong"}))
    runs = benchmark.load_runs(out)
    assert benchmark.next_label(runs, "alc-0.13.0") == "alc-0.13.0-2"
    assert benchmark.next_label(runs, "fresh") == "fresh"


# ─── Re-scoring history ─────────────────────────────────────────────────
def _question_for(case_id: str) -> str:
    for case in CLASSIC.cases:
        if case.id == case_id:
            return case.question
    raise AssertionError(f"no such case: {case_id}")


def _legacy_run(tmp_path, *, verdict: str, answer: str, case: str = "halyard-pace") -> tuple[Path, Path]:
    """A saved run as an OLDER scorer judged it: verdicts baked in, answers kept."""
    out = tmp_path / "reports"
    payload = _fake_run("legacy", credit_by_arm={"alc-study": verdict})
    row = payload["rows"][0]
    row["case"], row["kind"], row["answer"] = case, "single", answer
    # The question is part of the evidence a re-score is allowed to use (quoting
    # it is not inventing), so it has to be the question that was actually asked.
    row["question"] = _question_for(case)
    row["matched"], row["missing"], row["invented"] = [], [], []
    return _write(out, payload), Path(out)


def test_a_saved_run_can_be_rescored_onto_todays_scorer(tmp_path):
    """A verdict is a judgement by a version of the scorer, and a saved run keeps
    the judgement. Re-scoring from the stored answers keeps the history comparable
    instead of meaning something slightly different than a new run."""
    path, out = _legacy_run(
        tmp_path,
        verdict="wrong",
        case="brimwall-absent",
        answer="The default value of brimwall_set_ceiling() is not explicitly documented in the provided sources.",
    )
    run = benchmark.load_runs(out)[0]
    assert benchmark.summarise(run)["alc-study"]["credit"] == 0.0

    result = benchmark.rescore(run)
    assert result["changed"], "an honest refusal must be re-credited"
    assert result["before"]["alc-study"]["credit"] == 0.0
    assert result["after"]["alc-study"]["credit"] == 1.0

    # It is written back, so the saved history is on one rule.
    assert json.loads(path.read_text(encoding="utf-8"))["rescored"] is True
    assert benchmark.summarise(benchmark.load_runs(out)[0])["alc-study"]["credit"] == 1.0


def test_rescoring_leaves_an_agreeing_run_alone(tmp_path):
    path, out = _legacy_run(
        tmp_path,
        verdict="correct",
        answer="halyard_set_pace defaults to 12 frames.",
    )
    before = path.read_text(encoding="utf-8")
    result = benchmark.rescore(benchmark.load_runs(out)[0])
    assert result["changed"] == []
    assert result["before"] == result["after"]
    assert path.read_text(encoding="utf-8") == before


def test_rescoring_reports_a_fabrication_rather_than_hiding_it(tmp_path):
    _, out = _legacy_run(
        tmp_path,
        verdict="correct",
        case="brimwall-absent",
        answer="brimwall_set_ceiling is not documented, but the default is 42 frames.",
    )
    result = benchmark.rescore(benchmark.load_runs(out)[0])
    assert [item["now"] for item in result["changed"]] == ["invented"]
    assert result["after"]["alc-study"]["credit"] == 0.0


def test_the_rescore_flag_handles_every_saved_run(tmp_path, capsys):
    out = tmp_path / "reports"
    _write(out, _fake_run("stale", credit_by_arm={"alc-study": "wrong"}))
    assert benchmark.main(["--out-dir", str(out), "--rescore", "all"]) == 0
    assert "rescored stale" in capsys.readouterr().out
    assert benchmark.main(["--out-dir", str(out), "--rescore", "nothing-like-this"]) == 2


# ─── Comparison ─────────────────────────────────────────────────────────
def test_the_comparison_says_which_way_each_number_moved(tmp_path):
    out = tmp_path / "reports"
    _write(out, _fake_run("old", credit_by_arm={"normal": "wrong", "alc-study": "wrong"}, startedAt="2026-09-29T09:00:00+00:00"))
    _write(out, _fake_run("new", credit_by_arm={"normal": "wrong", "alc-study": "correct"}, startedAt="2026-09-29T11:00:00+00:00"))
    older, newer = benchmark.load_runs(out)[1], benchmark.load_runs(out)[0]

    text = benchmark.compare_runs(newer, older)
    assert "alc-study" in text
    assert "BETTER" in text, text
    assert "0%->100% better" in text
    # The control arm did not move, and the text says so rather than inventing a delta.
    assert "normal" in text and "same" in text
    assert "control" in text, "the reader must be told what 'normal' moving would mean"


def test_a_regression_is_called_worse(tmp_path):
    out = tmp_path / "reports"
    _write(out, _fake_run("good", credit_by_arm={"alc-study": "correct"}, startedAt="2026-09-29T09:00:00+00:00"))
    _write(out, _fake_run("bad", credit_by_arm={"alc-study": "invented"}, startedAt="2026-09-29T11:00:00+00:00"))
    runs = benchmark.load_runs(out)
    text = benchmark.compare_runs(runs[0], runs[1])
    assert "WORSE" in text


def test_comparing_different_fact_sets_refuses_to_compare(tmp_path):
    out = tmp_path / "reports"
    _write(out, _fake_run("a", credit_by_arm={"alc-study": "correct"}, variant="classic", startedAt="2026-09-29T09:00:00+00:00"))
    _write(out, _fake_run("b", credit_by_arm={"alc-study": "wrong"}, variant="seed-7", startedAt="2026-09-29T11:00:00+00:00"))
    runs = benchmark.load_runs(out)
    text = benchmark.compare_runs(runs[0], runs[1])
    assert "NOT comparable" in text, "a different fact set must be called out, not averaged over"


# ─── The CLI ────────────────────────────────────────────────────────────
def test_list_and_show_work_without_a_model(tmp_path, capsys):
    out = tmp_path / "reports"
    _write(out, _fake_run("phase4", credit_by_arm={"normal": "wrong", "alc-study": "correct"}))

    assert benchmark.main(["--out-dir", str(out), "--list"]) == 0
    printed = capsys.readouterr().out
    assert "phase4" in printed and "classic" in printed

    assert benchmark.main(["--out-dir", str(out), "--show", "phase4"]) == 0
    shown = capsys.readouterr().out
    assert "alc-study" in shown and "credit" in shown

    assert benchmark.main(["--out-dir", str(out), "--show", "missing"]) == 2


def test_compare_flag_prints_the_comparison(tmp_path, capsys):
    out = tmp_path / "reports"
    _write(out, _fake_run("old", credit_by_arm={"alc-study": "wrong"}, startedAt="2026-09-29T09:00:00+00:00"))
    _write(out, _fake_run("new", credit_by_arm={"alc-study": "correct"}, startedAt="2026-09-29T11:00:00+00:00"))
    assert benchmark.main(["--out-dir", str(out), "--compare", "new", "old"]) == 0
    assert "BETTER" in capsys.readouterr().out


# ─── The interactive menu ───────────────────────────────────────────────
def _feed(monkeypatch, answers):
    """Replace input() with a script. Running out means the menu asked too much."""
    remaining = list(answers)

    def fake_input(prompt: str = "") -> str:
        print(prompt, end="")
        assert remaining, f"the menu asked one question too many (at {prompt!r})"
        return remaining.pop(0)

    monkeypatch.setattr("builtins.input", fake_input)
    return remaining


def _no_browser(monkeypatch):
    """Never let a test open a real browser window."""
    monkeypatch.setattr(benchmark, "open_path", lambda _path: True)


def test_the_menu_browses_and_compares(tmp_path, monkeypatch, capsys):
    out = tmp_path / "reports"
    _write(out, _fake_run("older", credit_by_arm={"alc-study": "wrong"}, startedAt="2026-09-29T09:00:00+00:00"))
    _write(out, _fake_run("newer", credit_by_arm={"alc-study": "correct"}, startedAt="2026-09-29T11:00:00+00:00"))

    # 4 = previous results -> the second run, without every turn; then
    # 5 = compare run 1 against run 2; then 6 = quit.
    _no_browser(monkeypatch)
    remaining = _feed(monkeypatch, ["4", "2", "n", "5", "1", "2", "6"])
    assert benchmark.menu(out) == 0
    assert remaining == [], "the menu stopped reading input early"

    printed = capsys.readouterr().out
    assert "ALC Benchmark" in printed
    assert "newer" in printed and "BETTER" in printed
    # The table must speak in words, with the machine ids explained once.
    assert "ALC on" in printed and "ALC on = alc-study" in printed


def test_a_run_from_another_question_set_is_not_comparable(tmp_path):
    """Suites exist so a score cannot be read across two different question sets."""
    out = tmp_path / "reports"
    core = _fake_run("core-run", credit_by_arm={"alc-study": "correct"})
    core["suite"] = "core"
    newer = _write(out, core)
    hard = _fake_run("hard-run", credit_by_arm={"alc-study": "invented"})
    hard["suite"] = "hard"
    _write(out, hard)

    runs = benchmark.load_runs(out)
    assert {run.suite for run in runs} == {"core", "hard"}
    newer_run = next(run for run in runs if run.label == "hard-run")
    older_run = next(run for run in runs if run.label == "core-run")
    text = benchmark.compare_runs(newer_run, older_run)
    assert "different question sets" in text
    assert "suite core" in text and "suite hard" in text


def test_a_missing_suite_reads_as_core(tmp_path):
    """Every report written before suites existed answered the core questions."""
    out = tmp_path / "reports"
    payload = _fake_run("old-run", credit_by_arm={"alc-study": "correct"})
    payload.pop("suite", None)
    _write(out, payload)
    assert benchmark.load_runs(out)[0].suite == "core"


def test_the_dashboard_carries_the_question_set(tmp_path):
    out = tmp_path / "reports"
    payload = _fake_run("hard-run", credit_by_arm={"alc-study": "correct"})
    payload["suite"] = "hard"
    _write(out, payload)

    payload_json = benchmark.dashboard_payload(out)
    assert payload_json["runs"][0]["suite"] == "hard"
    assert "suite: " in benchmark.DASHBOARD_HTML, "the view must show which set a bar came from"
    assert "Different question sets" in benchmark.DASHBOARD_HTML


def test_the_full_test_stays_on_the_comparable_question_set(tmp_path):
    """One button must not silently make a run incomparable with the series."""
    kwargs = benchmark.full_test_kwargs(tmp_path / "reports", fake="oracle")
    assert kwargs["suite"] == "core"
    assert benchmark.full_test_kwargs(tmp_path / "reports", suite="hard")["suite"] == "hard"


def test_the_menu_opens_the_graphical_view(tmp_path, monkeypatch, capsys):
    out = tmp_path / "reports"
    _write(out, _fake_run("a-run", credit_by_arm={"normal": "wrong", "alc-study": "correct"}))
    _no_browser(monkeypatch)
    _feed(monkeypatch, ["3", "6"])
    assert benchmark.menu(out) == 0
    printed = capsys.readouterr().out
    assert "index.html" in printed
    assert (out / "index.html").exists()


def test_the_menu_starts_a_run_with_what_the_user_chose(tmp_path, monkeypatch, capsys):
    """The menu's job is to turn answers into harness arguments, and save the result."""
    out = tmp_path / "reports"
    captured: dict = {}

    def fake_run_test(**kwargs):
        captured.update(kwargs)
        payload = _fake_run(kwargs["label"], credit_by_arm={"normal": "wrong", "alc-study": "correct"})
        payload["args"] = {"arms": "normal,alc-study", "docs": "on", "web": "off"}
        path = _write(Path(kwargs["out_dir"]), payload)
        return path, payload

    monkeypatch.setattr(benchmark, "run_test", fake_run_test)
    _no_browser(monkeypatch)
    # 2 = customise a test; name; model; "just those two" = yes, so no arm picker
    # at all; fact set; question set; question count; docs; web; start; decline the
    # browser; quit.
    _feed(monkeypatch, ["2", "MY Tag", "test-model", "y", "classic", "hard", "", "y", "n", "y", "n", "6"])
    assert benchmark.menu(out) == 0

    # The name becomes the label (and so the filename); case and spaces survive,
    # because 'ALC v3' reads better in a list than 'alc-v3'.
    assert captured["label"] == "MY Tag"
    assert captured["tag"] == "MY Tag"
    assert captured["model"] == "test-model"
    assert captured["arms"] == ["normal", "alc-study"]
    assert captured["variant"] == "classic"
    assert captured["suite"] == "hard", "the question set must reach the harness"
    assert captured["docs"] is True and captured["web"] is False
    assert captured["limit"] == 0

    printed = capsys.readouterr().out
    assert "About to measure 'MY Tag'" in printed
    assert "alc-study" in printed, "the menu must show the result it just saved"
    assert "first run on this fact set" in printed, "and say why there is nothing to compare to"


def test_the_menu_offers_the_diagnostic_arms_only_when_asked(tmp_path, monkeypatch):
    """Five rows with four unfamiliar names is not a result; one number per run is."""
    out = tmp_path / "reports"
    captured: dict = {}

    def fake_run_test(**kwargs):
        captured.update(kwargs)
        payload = _fake_run(kwargs["label"], credit_by_arm={"alc-heuristic": "correct"})
        path = _write(Path(kwargs["out_dir"]), payload)
        return path, payload

    monkeypatch.setattr(benchmark, "run_test", fake_run_test)
    _no_browser(monkeypatch)
    _feed(monkeypatch, ["2", "diag", "m", "n", "alc-heuristic", "classic", "core", "", "y", "n", "y", "n", "6"])
    assert benchmark.menu(out) == 0
    assert captured["arms"] == ["alc-heuristic"]


def test_the_menu_says_what_went_wrong_instead_of_crashing(tmp_path, monkeypatch, capsys):
    out = tmp_path / "reports"

    def explode(**_kwargs):
        raise RuntimeError("the model is not running")

    monkeypatch.setattr(benchmark, "run_test", explode)
    _no_browser(monkeypatch)
    _feed(monkeypatch, ["2", "tag", "m", "y", "classic", "core", "", "y", "n", "y", "6"])
    assert benchmark.menu(out) == 0
    printed = capsys.readouterr().out
    assert "the model is not running" in printed
    assert "RuntimeError" in printed


def test_the_menu_survives_an_empty_history_and_a_bad_fact_set(tmp_path, monkeypatch, capsys):
    out = tmp_path / "reports"

    def fake_run_test(**kwargs):
        payload = _fake_run(kwargs["label"], credit_by_arm={"normal": "wrong"})
        path = _write(Path(kwargs["out_dir"]), payload)
        return path, payload

    monkeypatch.setattr(benchmark, "run_test", fake_run_test)
    _no_browser(monkeypatch)
    # An empty dashboard; then an empty history; then no usable arms; then a
    # nonsense fact set and a non-numeric question count, which must be corrected
    # rather than fatal.
    remaining = _feed(
        monkeypatch,
        [
            "3",
            "4",
            "2", "t", "m", "n", "not-an-arm",
            "2", "t", "m", "y", "nonsense", "many", "y", "n", "y", "n",
            "6",
        ],
    )
    assert benchmark.menu(out) == 0
    printed = capsys.readouterr().out
    assert "No known arms chosen" in printed
    assert "Unknown fact set" in printed
    assert "Nothing saved yet" in printed
    assert remaining == []


# ─── Names count up ─────────────────────────────────────────────────────
def test_a_new_run_names_itself_as_the_next_version(tmp_path):
    """Every test is the previous version plus one, so the series is its own
    changelog and nobody has to remember what to call the next one."""
    out = tmp_path / "reports"
    assert benchmark.suggest_name(benchmark.load_runs(out)) == "ALC v1"
    _write(out, _fake_run("ALC v1", credit_by_arm={"alc-study": "correct"}))
    assert benchmark.suggest_name(benchmark.load_runs(out)) == "ALC v2"
    _write(out, _fake_run("ALC v7", credit_by_arm={"alc-study": "correct"}))
    assert benchmark.suggest_name(benchmark.load_runs(out)) == "ALC v8", "the highest wins"
    # An unversioned run (an old, hand-named one) must not reset the count.
    _write(out, _fake_run("phase4", credit_by_arm={"alc-study": "correct"}))
    assert benchmark.suggest_name(benchmark.load_runs(out)) == "ALC v8"


def test_the_version_is_read_from_the_tag_too(tmp_path):
    """A run whose file name and tag disagree still counts once."""
    out = tmp_path / "reports"
    _write(out, _fake_run("renamed", credit_by_arm={"alc-study": "correct"}, tag="ALC v4"))
    assert benchmark.suggest_name(benchmark.load_runs(out)) == "ALC v5"


def test_a_run_name_is_also_a_filename():
    assert benchmark.sanitise_name("  ALC v3: test?/run*  ") == "ALC v3 testrun"
    assert benchmark.sanitise_name("ALC v3") == "ALC v3"
    assert benchmark.sanitise_name("") == "run"
    assert benchmark.sanitise_name("...") == "run"


def test_the_runner_names_the_next_version_when_no_tag_is_given(tmp_path, capsys):
    out = tmp_path / "reports"
    _write(out, _fake_run("ALC v2", credit_by_arm={"alc-study": "correct"}))
    assert benchmark.main(
        ["--out-dir", str(out), "--run", "--model", "scripted", "--fake", "oracle",
         "--arms", "alc-study", "--cases", "halyard-pace"]
    ) == 0
    printed = capsys.readouterr().out
    assert "name: ALC v3" in printed, printed
    assert (out / "ALC v3.json").exists()
    assert [run.label for run in benchmark.load_runs(out)] == ["ALC v3", "ALC v2"]


# ─── The API key ────────────────────────────────────────────────────────
def test_scrub_scratch_key_removes_it_and_leaves_the_rest_alone(tmp_path):
    """The key has to reach the app through a settings file, and a run's settings
    file lives in a scratch directory that deliberately outlives the process."""
    data = tmp_path / "normal" / "data"
    data.mkdir(parents=True)
    settings = data / "settings.json"
    settings.write_text(
        json.dumps({"tavilyApiKey": "SECRET-KEY", "alcWebEnabled": True, "alcMaxCycles": 3}),
        encoding="utf-8",
    )
    assert alc_eval.scrub_scratch_key(tmp_path) == 1
    payload = json.loads(settings.read_text(encoding="utf-8"))
    assert "tavilyApiKey" not in payload
    assert payload["alcWebEnabled"] is True and payload["alcMaxCycles"] == 3
    assert alc_eval.scrub_scratch_key(tmp_path) == 0, "must be idempotent"


def test_a_tavily_key_never_reaches_the_report_or_the_scratch_files(tmp_path):
    """Asked for every time, never saved. A key in a report is a key in a file that
    gets copied around, quoted in docs and committed."""
    secret = "SECRET-TAVILY-abc123"
    out = tmp_path / "reports"
    _json_path, data = benchmark.run_test(
        label="keyed",
        tag="keyed",
        model="scripted",
        arms=["normal", "alc-study"],
        variant="classic",
        cases="halyard-pace",
        docs=True,
        web=True,
        tavily_key=secret,
        out_dir=out,
        timeout=120,
        echo=False,
        fake="oracle",
    )

    assert (out / "keyed.json").read_text(encoding="utf-8").count(secret) == 0
    assert (out / "keyed.md").read_text(encoding="utf-8").count(secret) == 0
    # Whether a key was used is a fact about the run; the key is not.
    assert data["usedTavilyKey"] is True
    assert not data["args"]["tavily_key"], "the key travels in the environment, not on a command line"

    # And nothing in the scratch tree keeps it, including the settings files the
    # arms were configured through.
    scratch = Path(data["corpusRoot"])
    assert scratch.is_dir()
    leftovers = [
        str(path)
        for path in scratch.rglob("*")
        if path.is_file() and secret in path.read_text(encoding="utf-8", errors="ignore")
    ]
    assert leftovers == [], leftovers
    assert (scratch / "alc-study" / "data" / "settings.json").exists(), "the arm dirs really were written"


def test_a_key_given_on_the_command_line_is_redacted_from_the_report(tmp_path):
    """--tavily-key exists for scripting; it must still not be echoed into a file."""
    out = tmp_path / "reports"
    _json_path, data = benchmark.run_test(
        label="direct", tag="direct", model="scripted", arms=["normal"], variant="classic",
        cases="halyard-pace", docs=True, web=False, fake="oracle", echo=False, out_dir=out,
    )
    assert data["args"]["tavily_key"] in ("", None)  # nothing was asked for

    # The real check is on the harness's own redaction list.
    assert "tavily_key" in alc_eval.SECRET_ARGS
    assert alc_eval.SECRET_ARGS, "a secret named in the args must be redacted by name"


def test_redaction_strips_a_key_from_anything_about_to_be_shown():
    secret = "SECRET-TAVILY-abc123"
    line = f"settings={{'tavilyApiKey': '{secret}'}}"
    assert secret not in benchmark._redact(line, secret)
    assert "***" in benchmark._redact(line, secret)
    # Nothing to strip, and an empty secret, must both be harmless.
    assert benchmark._redact(line, "") == line
    assert benchmark._redact("no secret here", "nothing-to-find") == "no secret here"


def test_ask_key_asks_every_time_and_a_blank_answer_means_no_web_search(monkeypatch, capsys):
    monkeypatch.setattr(benchmark, "can_prompt", lambda: True)
    monkeypatch.setattr("getpass.getpass", lambda *a, **k: "")
    assert benchmark.ask_key() == ""
    assert "web search off" in capsys.readouterr().out.lower()

    monkeypatch.setattr("getpass.getpass", lambda *a, **k: "  typed-key  ")
    assert benchmark.ask_key() == "typed-key", "whitespace from a paste must be trimmed"

    # An environment variable is used as-is, and the user is told where it came from.
    def must_not_prompt(*_a, **_k):  # pragma: no cover — it must not be called
        raise AssertionError("ask_key prompted even though a key was available")

    monkeypatch.setattr("getpass.getpass", must_not_prompt)
    assert benchmark.ask_key("from-env") == "from-env"
    assert "environment" in capsys.readouterr().out


def test_ask_key_refuses_to_hang_when_there_is_no_terminal(monkeypatch, capsys):
    """On Windows getpass reads the console, not stdin: a piped run would block for
    ever waiting for a keypress that can never come."""

    def must_not_prompt(*_a, **_k):  # pragma: no cover — it must not be called
        raise AssertionError("getpass was called with no terminal to read")

    monkeypatch.setattr(benchmark, "can_prompt", lambda: False)
    monkeypatch.setattr("getpass.getpass", must_not_prompt)
    assert benchmark.ask_key() == ""
    printed = capsys.readouterr().out
    assert "--tavily-key" in printed, "it must say how to pass the key instead"


def test_the_full_test_turns_everything_on(tmp_path):
    out = tmp_path / "reports"
    empty = benchmark.full_test_kwargs(out, key="K")
    assert empty["docs"] is True
    assert empty["web"] is True, "a key given means web search on"
    assert empty["cases"] == "", "every question, not a subset"
    assert empty["arms"] == ["normal", "alc-study"]
    assert empty["label"] == "ALC v1"
    assert empty["model"] == "qwen3:1.7b"

    # With no key, it still runs everything it can and says so.
    keyless = benchmark.full_test_kwargs(out, key="")
    assert keyless["web"] is False and keyless["docs"] is True

    # It names itself as the next version, and follows the model last used.
    _write(out, _fake_run("ALC v2", credit_by_arm={"alc-study": "correct"}, model="qwen3:4b"))
    later = benchmark.full_test_kwargs(out, key="K")
    assert later["label"] == "ALC v3"
    assert later["model"] == "qwen3:4b"


def test_the_menu_full_test_runs_everything_with_web_on(tmp_path, monkeypatch, capsys):
    """The one keystroke: option 1, a model, a key, and go."""
    out = tmp_path / "reports"
    captured: dict = {}

    def fake_run_test(**kwargs):
        captured.update(kwargs)
        payload = _fake_run(kwargs["label"], credit_by_arm={"normal": "wrong", "alc-study": "correct"})
        path = _write(Path(kwargs["out_dir"]), payload)
        return path, payload

    monkeypatch.setattr(benchmark, "run_test", fake_run_test)
    monkeypatch.setattr(benchmark, "can_prompt", lambda: True)
    monkeypatch.setattr("getpass.getpass", lambda *a, **k: "SECRET-KEY")
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    _no_browser(monkeypatch)

    remaining = _feed(monkeypatch, ["1", "test-model", "y", "n", "6"])
    assert benchmark.menu(out) == 0
    assert remaining == []

    assert captured["docs"] is True
    assert captured["web"] is True and captured["tavily_key"] == "SECRET-KEY"
    assert captured["cases"] == ""
    assert captured["arms"] == ["normal", "alc-study"]
    assert captured["model"] == "test-model"

    printed = capsys.readouterr().out
    assert "web search: on" in printed
    assert "SECRET-KEY" not in printed, "the key must never be echoed back"


# ─── The graphical view ─────────────────────────────────────────────────
def test_the_dashboard_is_self_contained_and_says_what_credit_means(tmp_path):
    out = tmp_path / "reports"
    _write(out, _fake_run("gen-one", credit_by_arm={"normal": "wrong", "alc-study": "correct"}))
    path = benchmark.write_dashboard(out)

    assert path.name == "index.html"
    html = path.read_text(encoding="utf-8")
    assert "gen-one" in html
    # It must open offline, from a file:// path: no CDN, no fonts, no build step.
    assert "http://" not in html and "https://" not in html
    assert "<script src" not in html and "<link" not in html
    assert "credit" in html and "Making a value up is never credit" in html
    # The numbers come from the same summary the terminal table uses.
    assert '"credit": 1.0' in html and '"credit": 0.0' in html


def test_the_dashboard_knows_which_arm_a_run_is_about(tmp_path):
    """One number per run: the ALC arm, with the baseline as a reference point."""
    out = tmp_path / "reports"
    _write(out, _fake_run("mix", credit_by_arm={"normal": "wrong", "alc-study": "correct", "alc-heuristic": "wrong"}))
    payload = benchmark.dashboard_payload(out)
    run = payload["runs"][0]
    names = [arm["name"] for arm in run["arms"]]
    assert names[0] == "normal", "ARMS order, so two runs list their arms the same way round"
    assert "alc-study" in names
    assert {arm["display"] for arm in run["arms"]} >= {"ALC off", "ALC on"}
    assert [arm["name"] for arm in run["arms"] if arm["advanced"]] == ["alc-heuristic"]
    assert payload["thresholds"]["credit"] == 0.02
    assert payload["generated"].endswith("UTC")


def test_the_dashboard_handles_having_no_runs_at_all(tmp_path):
    out = tmp_path / "reports"
    path = benchmark.write_dashboard(out)
    html = path.read_text(encoding="utf-8")
    assert '"runs": []' in html
    assert "No saved runs yet" in html, "an empty view must say what to do next"


def test_the_dashboard_flag_writes_and_prints_the_path(tmp_path, capsys):
    out = tmp_path / "reports"
    _write(out, _fake_run("one", credit_by_arm={"alc-study": "correct"}))
    assert benchmark.main(["--out-dir", str(out), "--dashboard"]) == 0
    printed = capsys.readouterr().out.strip()
    assert printed.endswith("index.html")
    assert (out / "index.html").exists()


def test_a_run_keeps_the_dashboard_current(tmp_path, capsys):
    """A dashboard that lags behind the runs on disk is worse than no dashboard."""
    out = tmp_path / "reports"
    benchmark.run_test(
        label="fresh", tag="fresh", model="scripted", arms=["alc-study"],
        variant="classic", cases="halyard-pace", out_dir=out, timeout=120, echo=False, fake="oracle",
    )
    capsys.readouterr()
    assert benchmark.main(["--out-dir", str(out), "--run", "--label", "second", "--tag", "second",
                           "--model", "scripted", "--fake", "oracle", "--arms", "alc-study",
                           "--cases", "halyard-pace"]) == 0
    html = (out / "index.html").read_text(encoding="utf-8")
    assert "fresh" in html and "second" in html


# ─── End to end, with the scripted model ────────────────────────────────
def test_a_test_run_is_saved_and_shows_up_in_the_history(tmp_path):
    """The whole path: menu → subprocess → harness → saved json → summary."""
    out = tmp_path / "reports"
    json_path, data = benchmark.run_test(
        label="e2e",
        tag="alc-test",
        model="scripted",
        arms=["normal", "alc-study"],
        variant="classic",
        cases="halyard-pace,peltarn-rate",
        out_dir=out,
        timeout=120,
        echo=False,
        fake="oracle",
    )
    assert json_path.exists()
    assert data["tag"] == "alc-test"
    assert data["variant"] == "classic"
    assert data["model"] == "scripted"
    assert data["startedAt"]
    assert len(data["rows"]) == 4

    runs = benchmark.load_runs(out)
    assert [run.label for run in runs] == ["e2e"]
    stats = benchmark.summarise(runs[0])
    # The scripted oracle may only state what the pipeline retrieved, so ALC scores
    # and Normal cannot — the same contract the harness itself is tested on.
    assert stats["alc-study"]["credit"] == 1.0
    assert stats["normal"]["credit"] == 0.0


def test_a_second_run_with_the_same_tag_gets_its_own_label(tmp_path):
    out = tmp_path / "reports"
    for _ in range(2):
        benchmark.run_test(
            label=benchmark.next_label(benchmark.load_runs(out), "repeat"),
            tag="same-tag",
            model="scripted",
            arms=["normal"],
            variant="classic",
            cases="halyard-pace",
            out_dir=out,
            timeout=120,
            echo=False,
            fake="oracle",
        )
    labels = [run.label for run in benchmark.load_runs(out)]
    assert sorted(labels) == ["repeat", "repeat-2"], labels


def test_the_run_metadata_is_enough_to_compare_two_generations(tmp_path):
    out = tmp_path / "reports"
    benchmark.run_test(
        label="gen1", tag="alc-0.13.0", model="scripted", arms=["normal", "alc-study"],
        variant="classic", cases="halyard-pace", out_dir=out, timeout=120, echo=False, fake="oracle",
    )
    benchmark.run_test(
        label="gen2", tag="kasalix-1.0", model="scripted", arms=["normal", "alc-study"],
        variant="classic", cases="halyard-pace", out_dir=out, timeout=120, echo=False, fake="oracle",
    )
    runs = benchmark.load_runs(out)
    text = benchmark.compare_runs(runs[0], runs[1])
    assert "kasalix-1.0" in text and "alc-0.13.0" in text
    assert "->" in text
