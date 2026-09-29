#!/usr/bin/env python3
"""ALC Benchmark — an interactive yardstick for ALC, with saved history.

This is the *user-facing* side of the harness in :mod:`tests.eval.alc_eval`. The
harness is the engine (it runs the turns and scores them); this is the menu around
it, so a run can be started, looked up later, and compared against a previous
generation of ALC — or against the fine-tuned Kasalix model when there is one.

Launch it with the wrapper in the repository root::

    ALC_Benchmark.bat

or directly::

    cd backend
    .venv/Scripts/python.exe -m tests.eval.benchmark

Two things you can do, as asked: look at previous results, or run a new test that
gets saved. Plus the one that makes a series of runs worth having — compare two of
them and see which way each number moved.

No results are ever overwritten: a label that already exists gets a numbered
suffix, because a benchmark whose history can be silently replaced is not history.

Non-interactive equivalents (used by tests and by scripting)::

    python -m tests.eval.benchmark --list
    python -m tests.eval.benchmark --show phase4
    python -m tests.eval.benchmark --compare baseline-0.13.0 phase4
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import webbrowser
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

try:  # imported as tests.eval.benchmark
    from .alc_eval import ARMS, DEFAULT_MODEL, REPORTS_DIR, arm_available, display_name
    from .corpus import CLASSIC, generated
    from .scoring import tally
except ImportError:  # invoked as a plain script
    sys.path.insert(0, str(HERE))
    from alc_eval import ARMS, DEFAULT_MODEL, REPORTS_DIR, arm_available, display_name  # type: ignore
    from corpus import CLASSIC, generated  # type: ignore
    from scoring import tally  # type: ignore

#: The arms a new run measures unless the user says otherwise.
#:
#: Five arms was a design mistake. Four of them differ from each other in ways only
#: interesting while the cycle was being built, and a table with five rows and four
#: names nobody can remember is a table nobody reads. What a human needs to compare
#: two generations of the model is ONE number per run plus a reference point:
#:
#:   ALC off   — the baseline, so a gain has something to be a gain over
#:   ALC on    — the shipped cycle, the thing being measured
#:
#: The rest are still runnable by name (`--arms alc-heuristic`) for diagnosis, and
#: the GUI hides them behind "advanced" rather than putting them in front of you.
DEFAULT_ARMS = ("normal", "alc-study")

#: Everything the advanced picker can add, in the order it should be offered.
ADVANCED_ARMS = ("alc-none", "alc-raw", "alc-heuristic", "alc-study")

#: How a run names itself. Every test is the previous version plus one, so the
#: series is its own changelog and nobody has to remember what to call the next
#: one: this reads the highest `vN` already saved and offers `vN+1`.
NAME_PREFIX = "ALC"
_VERSION_RE = re.compile(r"\bv(\d+)\b", re.IGNORECASE)


def highest_version(runs: list[Run]) -> int:
    """The highest `vN` among the saved runs' names, or 0 if there is none."""
    highest = 0
    for run in runs:
        for text in (run.label, run.tag):
            for match in _VERSION_RE.finditer(text or ""):
                highest = max(highest, int(match.group(1)))
    return highest


def suggest_name(runs: list[Run], prefix: str = NAME_PREFIX) -> str:
    """What to call the next run: `ALC v<n+1>`."""
    return f"{prefix} v{highest_version(runs) + 1}"


def sanitise_name(name: str) -> str:
    """A run's name is also its filename, so drop what a filesystem will not take.

    Case and spaces are kept: `ALC v3` reads better than `alc-v3` in a list, and
    `--show` matches on a case-insensitive substring, so it stays easy to type.
    """
    cleaned = re.sub(r"[<>:\"/|?*]", "", str(name or ""))
    cleaned = "".join(char for char in cleaned if char.isprintable())
    cleaned = re.sub(r"\s+", " ", cleaned).strip().strip(".")
    return cleaned or "run"


# ─── Runs on disk ───────────────────────────────────────────────────────
@dataclass
class Run:
    """One saved benchmark run."""

    label: str
    path: Path
    tag: str = ""
    variant: str = "classic"
    #: Which question set the run used. Runs made before suites existed answered
    #: the `core` questions, so that is the default for anything missing the field.
    suite: str = "core"
    model: str = ""
    started_at: str = ""
    arms: list[str] = field(default_factory=list)
    rows: list[dict[str, Any]] = field(default_factory=list)
    docs: bool = True
    web: bool = False

    @property
    def first_turn(self) -> list[dict[str, Any]]:
        return [row for row in self.rows if row.get("turn") == 1]

    @property
    def when(self) -> str:
        if self.started_at:
            return self.started_at.replace("T", " ").replace("+00:00", " UTC")
        try:
            return datetime.fromtimestamp(self.path.stat().st_mtime, timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        except OSError:
            return "unknown"


def _rows_for(run: Run, arm: str, variants: Iterable[str] | None = None) -> list[dict[str, Any]]:
    wanted = set(variants) if variants is not None else None
    return [
        row
        for row in run.rows
        if row.get("arm") == arm and (wanted is None or row.get("variant") in wanted)
    ]


def summarise(run: Run) -> dict[str, dict[str, float]]:
    """Per-arm headline numbers, computed from the saved rows.

    Deliberately re-derived from the rows rather than read from the markdown, so a
    summary is always consistent with the data it came from.
    """
    out: dict[str, dict[str, float]] = {}
    for arm in dict.fromkeys([*run.arms, *(str(row.get("arm")) for row in run.rows)]):
        if not arm:
            continue
        first = _rows_for(run, arm)
        first = [row for row in first if row.get("turn") == 1]
        if not first:
            continue
        summary = tally(first)
        warm = _rows_for(run, arm, ["warm"])
        cold = _rows_for(run, arm, ["cold"])
        out[arm] = {
            "turns": len(first),
            "credit": float(summary["credit_rate"]),
            "correct": float(summary["counts"]["correct"]),
            "admitted": float(summary["counts"]["admitted"]),
            "partial": float(summary["counts"]["partial"]),
            "invented": float(summary["counts"]["invented"]),
            "wrong": float(summary["counts"]["wrong"]),
            "ttft": _median([float(row.get("ttft") or 0) for row in first]),
            "turn": _median([float(row.get("total") or 0) for row in first]),
            "calls": _median([float(row.get("calls") or 0) for row in first]),
            "carry_kept": recall(warm) if warm else -1.0,
            "carry_wiped": recall(cold) if cold else -1.0,
        }
    return out


def recall(rows: list[dict[str, Any]]) -> float:
    """The share of each case's expected details that appeared in the answer."""
    scores = [
        len(row.get("matched") or []) / (len(row.get("matched") or []) + len(row.get("missing") or []))
        for row in rows
        if (row.get("matched") or row.get("missing"))
    ]
    return round(sum(scores) / len(scores), 3) if scores else 0.0


def _median(values: list[float]) -> float:
    clean = sorted(value for value in values if value is not None)
    if not clean:
        return 0.0
    middle = len(clean) // 2
    return round(clean[middle] if len(clean) % 2 else (clean[middle - 1] + clean[middle]) / 2, 2)


def load_runs(out_dir: Path | str = REPORTS_DIR) -> list[Run]:
    """Every saved run, newest first."""
    directory = Path(out_dir)
    runs: list[Run] = []
    if not directory.is_dir():
        return runs
    for path in sorted(directory.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict) or "rows" not in data:
            continue
        args = data.get("args") if isinstance(data.get("args"), dict) else {}
        runs.append(
            Run(
                label=str(data.get("label") or path.stem),
                path=path,
                tag=str(data.get("tag") or args.get("tag") or ""),
                variant=str(data.get("variant") or args.get("variant") or "classic"),
                suite=str(data.get("suite") or args.get("suite") or "core"),
                model=str(data.get("model") or args.get("model") or ""),
                started_at=str(data.get("startedAt") or ""),
                arms=[item.strip() for item in str(args.get("arms") or "").split(",") if item.strip()],
                rows=list(data.get("rows") or []),
                docs=str(args.get("docs") or "on") != "off",
                web=str(args.get("web") or "off") == "on",
            )
        )
    runs.sort(key=lambda run: run.started_at or "", reverse=True)
    return runs


def find_run(runs: list[Run], label: str) -> Run | None:
    wanted = str(label or "").strip().lower()
    for run in runs:
        if run.label.lower() == wanted:
            return run
    for run in runs:
        if wanted and wanted in run.label.lower():
            return run
    return None


# ─── Re-scoring history ─────────────────────────────────────────────────
def rescore(run: Run, *, write: bool = True) -> dict[str, Any]:
    """Re-apply TODAY's scorer to a saved run's stored answers.

    A verdict is a judgement by a specific version of the scorer, and a saved run
    keeps the judgement, not just the answer. When the scorer changes — as it did
    when a live run showed an honest refusal being scored as a failure — every
    older run silently means something slightly different, and comparing it to a
    new one compares two rules.

    This re-scores from the answers themselves, which are stored in full, so the
    history can be brought onto one rule instead of being thrown away. Nothing is
    invented: only the verdicts and their evidence lists are recomputed.
    """
    from .alc_eval import RunContext, build_report, resolve_variant
    from .corpus import build as build_corpus
    from .scoring import score_answer

    root = Path(tempfile.mkdtemp(prefix="alc-rescore-"))
    corpus = build_corpus(root, variant=resolve_variant(run.variant))
    by_id = {case.id: case for case in corpus.cases}

    # Capture the date BEFORE anything is written. A run saved before the metadata
    # existed has no start time, and re-scoring rewrites the file — so reading the
    # mtime afterwards would record "when it was re-scored" as "when it ran", which
    # is exactly the kind of quiet lie a benchmark must not tell about itself.
    original_stamp = run.started_at or _file_stamp(run.path)

    before, after_changes = summarise(run), []
    skipped = 0
    for row in run.rows:
        case = by_id.get(str(row.get("case")))
        if case is None or not str(row.get("answer") or "").strip():
            skipped += 1
            continue
        verdict = score_answer(
            str(row["answer"]), case, corpus, question=str(row.get("question") or "")
        )
        if verdict.verdict != row.get("verdict"):
            after_changes.append(
                {
                    "arm": row.get("arm"),
                    "case": row.get("case"),
                    "variant": row.get("variant"),
                    "was": row.get("verdict"),
                    "now": verdict.verdict,
                }
            )
        row["verdict"] = verdict.verdict
        row["matched"] = verdict.matched
        row["missing"] = verdict.missing
        row["invented"] = verdict.invented
        row["reason"] = verdict.reason

    after = summarise(run)

    # A run whose verdicts moved is rewritten; so is one that was already
    # re-scored, so that its report keeps the current scorer's wording (and its own
    # original date) rather than drifting. A run that agrees and has never been
    # re-scored is left byte-identical: history should not churn for nothing.
    if write:
        payload = json.loads(run.path.read_text(encoding="utf-8"))
        if after_changes or payload.get("rescored"):
            # The report reads a few bookkeeping fields directly, and an older or
            # hand-made row may not carry them all — re-scoring a saved run must
            # not be the thing that crashes on its own history.
            for row in run.rows:
                for key, value in (
                    ("ttft", 0.0),
                    ("total", 0.0),
                    ("calls", 0),
                    ("turn", 1),
                    ("alcCycles", 0),
                    ("alcToolCalls", 0),
                    ("alcFindings", 0),
                    ("matched", []),
                    ("missing", []),
                    ("invented", []),
                    ("knowledgeFiles", []),
                    ("alcEvents", {}),
                ):
                    row.setdefault(key, value)
            payload["rows"] = run.rows
            payload["rescored"] = True
            if not payload.get("startedAt"):
                payload["startedAt"] = original_stamp
            run.path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
            arms = [ARMS[name] for name in ARMS if any(row.get("arm") == name for row in run.rows)]
            ctx = RunContext(
                corpus=corpus, root=root, model=run.model, docs=run.docs, web=run.web, tag=run.tag
            )
            run.path.with_suffix(".md").write_text(
                build_report(
                    run.label,
                    ctx,
                    arms,
                    run.rows,
                    ran_at=original_stamp,
                    rescored=True,
                ),
                encoding="utf-8",
            )

    return {
        "label": run.label,
        "changed": after_changes,
        "skipped": skipped,
        "before": before,
        "after": after,
    }


def _file_stamp(path: Path) -> str:
    try:
        return datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(timespec="minutes")
    except OSError:
        return ""


def print_rescore(result: dict[str, Any]) -> None:
    print()
    print(f"  rescored {result['label']}")
    print(f"  {'-' * 60}")
    if not result["changed"]:
        print("  nothing changed - this run already agrees with the current scorer.")
    else:
        print(f"  {len(result['changed'])} verdict(s) changed:")
        for item in result["changed"]:
            print(f"    {item['arm']:14s} {item['case']:20s} {item['variant']:6s} {item['was']} -> {item['now']}")
    if result["skipped"]:
        print(f"  ({result['skipped']} row(s) had no stored answer to re-score)")
    print()
    print("  arm             credit before   credit now")
    print(f"  {'-' * 60}")
    for arm, stats in result["after"].items():
        was = result["before"].get(arm, {}).get("credit", 0.0)
        print(f"  {arm:15s} {was:13.0%} {stats['credit']:13.0%}")
    print()


# ─── Presentation ───────────────────────────────────────────────────────
def legend(names: Iterable[str]) -> str:
    """Which machine id each spoken name stands for.

    Printed once beneath a table rather than repeated in every row: the table can
    use words a person recognises, and the CLI can still be driven by the ids.
    """
    return " | ".join(f"{display_name(name)} = {name}" for name in names)


def print_run(run: Run, *, verbose: bool = False) -> None:
    print()
    print(f"  {run.label}")
    print(f"  {'-' * 60}")
    print(f"  when      {run.when}")
    print(f"  measuring {run.tag or '(untagged)'}")
    print(f"  model     {run.model or '(unknown)'}   facts: {run.variant}")
    print(f"  settings  docs={'on' if run.docs else 'off'}  web={'on' if run.web else 'off'}  turns={len(run.rows)}")
    print()
    print("  arm                     credit  correct  partial  invented  time/turn  ttft  calls   carry kept/wiped")
    print(f"  {'-' * 105}")
    stats_by_arm = summarise(run)
    for arm, stats in stats_by_arm.items():
        carry = (
            f"{stats['carry_kept']:.0%} / {stats['carry_wiped']:.0%}"
            if stats["carry_kept"] >= 0
            else "n/a"
        )
        print(
            f"  {display_name(arm):23s} {stats['credit']:5.0%}  {stats['correct']:5.0f}/{stats['turns']:.0f}"
            f"  {stats['partial']:6.0f}  {stats['invented']:6.0f}   {stats['turn']:7.2f}s"
            f"  {stats['ttft']:5.2f}s  {stats['calls']:4.1f}   {carry}"
        )
    print(f"  {legend(stats_by_arm)}")
    print("  credit = right, or said plainly it could not find out. 'made up' is never credit.")
    if verbose:
        print()
        for row in run.rows:
            flag = "!" if row.get("verdict") == "invented" else " "
            print(
                f" {flag} {row.get('arm'):14s} {row.get('case'):20s} t{row.get('turn')} "
                f"{row.get('variant'):6s} {row.get('verdict'):8s} {float(row.get('total') or 0):6.2f}s "
                f"{(', '.join(row.get('invented') or []))[:40]}"
            )
    print()
    print(f"  detail: {run.path.with_suffix('.md')}")
    print()


def compare_runs(newer: Run, older: Run) -> str:
    """A delta table: what moved between two generations of ALC (or two models).

    Every metric says which direction is BETTER, in words, so the table cannot be
    read the wrong way round — the whole point of a benchmark is that a regression
    is embarrassing, not ambiguous.
    """
    lines: list[str] = []
    lines.append("")
    lines.append(f"  {newer.label}  vs  {older.label}")
    lines.append(f"  {'-' * 60}")
    lines.append(
        f"  newer: {newer.when}  |  {newer.tag or '(untagged)'}  |  {newer.model}  |  "
        f"facts {newer.variant}  |  suite {newer.suite}"
    )
    lines.append(
        f"  older: {older.when}  |  {older.tag or '(untagged)'}  |  {older.model}  |  "
        f"facts {older.variant}  |  suite {older.suite}"
    )
    if newer.variant != older.variant:
        lines.append("")
        lines.append("  !! different fact sets - the numbers are NOT comparable. Re-run one of them")
        lines.append("     on the other's variant (--variant) before reading any of this.")
    if newer.suite != older.suite:
        lines.append("")
        lines.append(f"  !! different question sets ({older.suite} vs {newer.suite}) - a score is only")
        lines.append("     comparable within one suite. Re-run one of them with --suite before reading this.")
    if newer.tag and older.tag and newer.tag != older.tag:
        lines.append("")
        lines.append(f"  (comparing '{older.tag}' -> '{newer.tag}')")
    lines.append("")
    lines.append("  arm                     credit          correct         invented        time/turn")
    lines.append(f"  {'-' * 92}")
    new_stats, old_stats = summarise(newer), summarise(older)
    names = list(dict.fromkeys([*new_stats, *old_stats]))
    for arm in names:
        a, b = new_stats.get(arm), old_stats.get(arm)
        if not a or not b:
            lines.append(f"  {display_name(arm):23s} {'only in one of the two runs'}")
            continue
        lines.append(
            f"  {display_name(arm):23s} {_delta(a['credit'], b['credit'], percent=True, better='up'):>16s} "
            f"{_delta(a['correct'], b['correct'], better='up', tolerance=0.5):>13s} "
            f"{_delta(a['invented'], b['invented'], better='down', tolerance=0.5):>14s} "
            f"{_delta(a['turn'], b['turn'], better='down', unit='s', decimals=2, tolerance=0.05):>18s}"
        )
    lines.append(f"  {legend(names)}")
    lines.append("")
    lines.append("  credit/correct: higher is better. invented/time: lower is better.")
    lines.append("  'same' means the change is inside the run-to-run noise band for that metric.")
    if "normal" in new_stats and "normal" in old_stats:
        lines.append("")
        lines.append(
            "  'ALC off' (normal) is the control - no cycle runs at all. Any movement there is"
        )
        lines.append(
            "  model variance between the two runs, not a change in ALC, and it sets the noise"
        )
        lines.append("  floor for the other rows.")
    lines.append("")

    # The verdict, in words, per arm — so nobody has to read the columns.
    for arm in names:
        a, b = new_stats.get(arm), old_stats.get(arm)
        if not a or not b or arm == "normal":
            continue
        change = a["credit"] - b["credit"]
        cost = a["turn"] - b["turn"]
        verdict = (
            "BETTER" if change > 0.02 else ("WORSE" if change < -0.02 else "unchanged")
        )
        lines.append(
            f"  {display_name(arm):23s} {verdict}: credit {b['credit']:.0%} -> {a['credit']:.0%} "
            f"({change:+.0%}) at {cost:+.2f}s per turn"
        )
        if a["carry_kept"] >= 0 and b["carry_kept"] >= 0:
            lines.append(
                f"  {'':23s} carry {b['carry_kept']:.0%} -> {a['carry_kept']:.0%} "
                f"({a['carry_kept'] - b['carry_kept']:+.0%})"
            )
    lines.append("")
    return "\n".join(lines)


def _delta(
    new: float,
    old: float,
    *,
    better: str,
    percent: bool = False,
    unit: str = "",
    decimals: int = 0,
    tolerance: float = 0.005,
) -> str:
    """``old -> new`` plus the change, marked better/worse. ASCII only: a benchmark
    that prints mojibake in a default Windows console is a benchmark nobody reads.

    ``tolerance`` is the noise band: a tenth of a second or a single turn is not a
    finding, and calling it "worse" would train the reader to ignore the column.
    """
    diff = new - old
    if percent:
        mark = "better" if diff > 0.02 else ("worse" if diff < -0.02 else "same")
        return f"{old:.0%}->{new:.0%} {mark}"
    if abs(diff) < tolerance:
        return f"{new:.{decimals}f}{unit} same"
    good = diff > 0 if better == "up" else diff < 0
    sign = "+" if diff > 0 else ""
    return f"{new:.{decimals}f}{unit} ({sign}{diff:.{decimals}f}{unit}) {'better' if good else 'worse'}"


# ─── The dashboard ──────────────────────────────────────────────────────
DASHBOARD_NAME = "index.html"


def dashboard_payload(out_dir: Path | str = REPORTS_DIR) -> dict[str, Any]:
    """Everything the dashboard draws, computed here so the browser only renders.

    Deliberately NOT computed in JavaScript: the numbers come from `summarise`, the
    same function the CLI tables use, so the picture and the text cannot disagree.
    """
    runs = load_runs(out_dir)
    payload_runs: list[dict[str, Any]] = []
    for run in runs:
        stats = summarise(run)
        arms: list[dict[str, Any]] = []
        # ARMS order, so two runs always list their arms the same way round.
        for name in ARMS:
            if name not in stats:
                continue
            arm = stats[name]
            arms.append(
                {
                    "name": name,
                    "display": display_name(name),
                    "advanced": bool(ARMS[name].advanced),
                    "credit": arm["credit"],
                    "correct": arm["correct"],
                    "admitted": arm["admitted"],
                    "partial": arm["partial"],
                    "invented": arm["invented"],
                    "wrong": arm["wrong"],
                    "turns": arm["turns"],
                    "ttft": arm["ttft"],
                    "turn": arm["turn"],
                    "calls": arm["calls"],
                    "carryKept": arm["carry_kept"],
                    "carryWiped": arm["carry_wiped"],
                }
            )
        payload_runs.append(
            {
                "label": run.label,
                "when": run.when,
                "tag": run.tag,
                "model": run.model,
                "variant": run.variant,
                "suite": run.suite,
                "docs": run.docs,
                "web": run.web,
                "arms": arms,
            }
        )
    return {
        "generated": f"{datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC",
        "thresholds": {"credit": 0.02, "seconds": 0.05, "count": 0.5},
        "runs": payload_runs,
    }


def write_dashboard(out_dir: Path | str = REPORTS_DIR) -> Path:
    """Write `index.html`: one bar per run, click for detail, pick two to compare.

    Self-contained on purpose — no server, no CDN, no build step. It opens by
    double-click from anywhere, which is what makes it useful to someone who does
    not want to read a terminal table.
    """
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    data = json.dumps(dashboard_payload(out), indent=None)
    # `<` would let a run label close the script tag early.
    path = out / DASHBOARD_NAME
    path.write_text(DASHBOARD_HTML.replace("/*__DATA__*/", data.replace("<", "\\u003c")), encoding="utf-8")
    return path


DASHBOARD_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ALC Benchmark</title>
<style>
  :root {
    --bg: #12151a; --panel: #1a1f27; --line: #2a323e; --ink: #e6eaf0;
    --dim: #8d99ab; --good: #3fb27f; --warn: #d8a13a; --bad: #d9634f; --accent: #5aa9e6;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f4f6f9; --panel:#fff; --line:#dde3ec; --ink:#1b2027; --dim:#5d6879;
            --good:#1f8f5f; --warn:#a9741a; --bad:#c0402c; --accent:#2b6fa8; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:14px/1.5 ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width:1080px; margin:0 auto; padding:28px 20px 60px; }
  h1 { font-size:22px; margin:0 0 4px; }
  h2 { font-size:15px; margin:28px 0 10px; text-transform:uppercase;
       letter-spacing:.08em; color:var(--dim); font-weight:600; }
  .lede { color:var(--dim); margin:0 0 6px; max-width:70ch; }
  .lede b { color:var(--ink); }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px;
          padding:14px 16px; margin-bottom:10px; cursor:pointer; }
  .card:hover { border-color:var(--accent); }
  .card.sel { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent) inset; }
  .top { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; }
  .name { font-weight:650; font-size:15px; }
  .meta { color:var(--dim); font-size:12.5px; }
  .badge { font-size:11px; padding:1px 7px; border-radius:999px; border:1px solid var(--line);
           color:var(--dim); }
  .row { display:grid; grid-template-columns:148px 1fr 116px; gap:10px; align-items:center;
         margin-top:8px; }
  .armname { font-size:12.5px; color:var(--dim); }
  .armname .diag { display:block; font-size:11px; opacity:.7; }
  .score { text-align:right; }
  .score .pct { font-variant-numeric:tabular-nums; font-weight:600; }
  .score .pill { margin-left:0; margin-top:3px; }
  .track { position:relative; height:16px; background:#0c0f13; border-radius:8px;
           overflow:hidden; border:1px solid var(--line); }
  @media (prefers-color-scheme: light) { .track { background:#eef2f7; } }
  .fill { height:100%; border-radius:7px 0 0 7px; }
  .ref { position:absolute; top:-2px; bottom:-2px; width:2px; background:var(--dim); opacity:.85; }
  .pill { display:inline-block; font-size:11px; padding:1px 7px; border-radius:999px;
          margin-left:6px; white-space:nowrap; }
  .pill.bad { background:rgba(217,99,79,.18); color:var(--bad); border:1px solid var(--bad); }
  .pill.good { background:rgba(63,178,127,.16); color:var(--good); border:1px solid var(--good); }
  table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }
  th, td { text-align:right; padding:6px 8px; border-bottom:1px solid var(--line); }
  th:first-child, td:first-child { text-align:left; }
  th { color:var(--dim); font-weight:600; font-size:12px; }
  .muted { color:var(--dim); }
  .better { color:var(--good); } .worse { color:var(--bad); } .same { color:var(--dim); }
  select { background:var(--panel); color:var(--ink); border:1px solid var(--line);
           border-radius:7px; padding:6px 9px; font:inherit; max-width:320px; }
  .warning { border:1px solid var(--warn); color:var(--warn); border-radius:8px;
             padding:10px 12px; margin:0 0 12px; }
  .hint { color:var(--dim); font-size:12.5px; }
  .empty { background:var(--panel); border:1px dashed var(--line); border-radius:10px;
           padding:26px; text-align:center; color:var(--dim); }
  footer { margin-top:34px; color:var(--dim); font-size:12px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>ALC Benchmark</h1>
  <p class="lede">
    Does the Advanced Learning Cycle actually help? One number per run, <b>credit</b>:
    the answer was right, <b>or</b> the model said plainly it could not find out.
    Making a value up is never credit — that is what the red pill counts. The thin
    grey mark on each bar is <b>ALC off</b>, the baseline to read the bar against.
  </p>

  <h2>Saved runs</h2>
  <div id="runs"></div>

  <div id="detail"></div>

  <h2>Compare two runs</h2>
  <div id="compare"></div>

  <footer id="foot"></footer>
</div>

<script>const DATA = /*__DATA__*/;</script>
<script>
const T = DATA.thresholds;
const runs = DATA.runs;
let selected = runs.length ? runs[0].label : null;

const pct = (x) => Math.round(x * 100) + '%';
const num = (x, d) => (Math.round(x * 10 ** d) / 10 ** d).toFixed(d);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// Colour by how much of the answer was right, and say the number too — colour
// alone is not a label.
function tone(credit) {
  if (credit >= 0.7) return 'var(--good)';
  if (credit >= 0.4) return 'var(--warn)';
  return 'var(--bad)';
}

// The one arm a run is judged by: ALC on if it ran, otherwise whatever it ran.
function mainArm(run) {
  return run.arms.find((a) => a.name !== 'normal') || run.arms[0] || null;
}
const refArm = (run) => run.arms.find((a) => a.name === 'normal') || null;

function armRow(arm, ref) {
  const bar = Math.max(0, Math.min(1, arm.credit)) * 100;
  const marker = ref ? `<span class="ref" style="left:${Math.max(0, Math.min(1, ref.credit)) * 100}%"></span>` : '';
  const invented = arm.invented > 0
    ? `<span class="pill bad">made up: ${arm.invented}</span>`
    : '';
  const diag = arm.advanced ? '<span class="diag">diagnostic arm</span>' : '';
  return `<div class="row">
    <div class="armname">${esc(arm.display)}${diag}</div>
    <div class="track"><div class="fill" style="width:${bar}%;background:${tone(arm.credit)}"></div>${marker}</div>
    <div class="score"><div class="pct">${pct(arm.credit)}</div>${invented}</div>
  </div>`;
}

function renderRuns() {
  const host = document.getElementById('runs');
  if (!runs.length) {
    host.innerHTML = `<div class="empty">No saved runs yet.<br>
      Run one from the menu (<b>ALC_Benchmark.bat</b>, option 1) and it will appear here.</div>`;
    return;
  }
  host.innerHTML = runs.map((run) => {
    const main = mainArm(run), ref = refArm(run);
    const badges = [
      run.model ? `<span class="badge">${esc(run.model)}</span>` : '',
      `<span class="badge">facts: ${esc(run.variant)}</span>`,
      `<span class="badge">suite: ${esc(run.suite || 'core')}</span>`,
      run.docs ? '<span class="badge">docs on</span>' : '<span class="badge">docs off</span>',
      run.web ? '<span class="badge">web on</span>' : '',
    ].join(' ');
    return `<div class="card${run.label === selected ? ' sel' : ''}" data-label="${esc(run.label)}">
      <div class="top">
        <span class="name">${esc(run.label)}</span>
        <span class="meta">${esc(run.tag && run.tag !== run.label ? run.tag : '')}</span>
        <span class="meta">· ${esc(run.when)}</span>
        ${badges}
      </div>
      ${main ? armRow(main, ref) : '<div class="hint">no scored rows</div>'}
      ${ref && main !== ref ? armRow(ref, null) : ''}
    </div>`;
  }).join('');
  host.querySelectorAll('.card').forEach((card) => {
    card.onclick = () => { selected = card.dataset.label; renderRuns(); renderDetail(); };
  });
}

function renderDetail() {
  const host = document.getElementById('detail');
  const run = runs.find((r) => r.label === selected);
  if (!run) { host.innerHTML = ''; return; }
  const ref = refArm(run);
  const rows = run.arms.map((a) => {
    const lift = ref && a !== ref ? ` (${a.credit - ref.credit >= 0 ? '+' : ''}${pct(a.credit - ref.credit)} vs ALC off)` : '';
    const carry = a.carryKept >= 0 ? `${pct(a.carryKept)} / ${pct(a.carryWiped)}` : '—';
    return `<tr>
      <td>${esc(a.display)}${a.advanced ? ' <span class="muted">(diagnostic)</span>' : ''}</td>
      <td>${pct(a.credit)}<span class="muted">${lift}</span></td>
      <td>${a.correct}/${a.turns}</td>
      <td>${a.admitted}</td>
      <td class="${a.invented > 0 ? 'worse' : 'muted'}">${a.invented}</td>
      <td>${num(a.turn, 2)}s</td>
      <td>${num(a.calls, 1)}</td>
      <td>${carry}</td>
    </tr>`;
  }).join('');
  host.innerHTML = `<h2>${esc(run.label)} — every arm</h2>
    <div class="card" style="cursor:default">
      <table>
        <tr><th>arm</th><th>credit</th><th>correct</th><th>said \u201cnot found\u201d</th>
            <th>made up</th><th>time/turn</th><th>model calls</th><th>carry kept/wiped</th></tr>
        ${rows}
      </table>
      <p class="hint">correct = answered with the invented fact. “said not found” is also credit:
      on a question the documentation cannot answer, saying so is the right answer.
      carry = a later session with the documentation removed, so only the notes it wrote can answer.</p>
    </div>`;
}

function delta(value, was, kind) {
  // Each metric knows which direction is good, so a change cannot be read backwards.
  const d = value - was;
  const tol = kind === 'time' ? T.seconds : kind === 'count' ? T.count : T.credit;
  if (Math.abs(d) < tol) return `<span class="same">${kind === 'time' ? num(value, 2) + 's' : kind === 'count' ? value : pct(value)} same</span>`;
  const good = kind === 'time' || kind === 'count' ? d < 0 : d > 0;
  const shown = kind === 'time' ? `${num(was, 2)}s\u2192${num(value, 2)}s` : kind === 'count' ? `${was}\u2192${value}` : `${pct(was)}\u2192${pct(value)}`;
  return `<span class="${good ? 'better' : 'worse'}">${shown} ${good ? 'better' : 'worse'}</span>`;
}

function renderCompare() {
  const host = document.getElementById('compare');
  if (runs.length < 1) { host.innerHTML = '<p class="hint">Nothing to compare yet.</p>'; return; }
  const options = runs.map((r) => `<option value="${esc(r.label)}">${esc(r.label)} — ${esc(r.when)}</option>`).join('');
  host.innerHTML = `
    <p class="hint">Pick the older run, then the newer one. Read only rows that changed;
    <b>ALC off</b> is the control — if it moves, the change is the model's mood, not the code.</p>
    <p><select id="newer">${options}</select> <span class="muted">vs</span> <select id="older">${options}</select></p>
    <div id="cmpOut"></div>`;
  const newerSel = document.getElementById('newer');
  const olderSel = document.getElementById('older');
  newerSel.selectedIndex = 0;
  olderSel.selectedIndex = Math.min(1, runs.length - 1);
  const draw = () => drawCompare(newerSel.value, olderSel.value);
  newerSel.onchange = draw; olderSel.onchange = draw;
  draw();
}

function drawCompare(newerLabel, olderLabel) {
  const host = document.getElementById('cmpOut');
  const newer = runs.find((r) => r.label === newerLabel);
  const older = runs.find((r) => r.label === olderLabel);
  if (!newer || !older) { host.innerHTML = ''; return; }
  if (newer.label === older.label) {
    host.innerHTML = '<p class="hint">Same run on both sides — pick two different runs.</p>';
    return;
  }
  const warn = newer.variant !== older.variant
    ? `<div class="warning"><b>Different fact sets</b> (${esc(older.variant)} vs ${esc(newer.variant)}) —
       these numbers are not comparable. Re-run one on the other's fact set.</div>`
    : (newer.suite !== older.suite
      ? `<div class="warning"><b>Different question sets</b> (${esc(older.suite || 'core')} vs ${esc(newer.suite || 'core')}) —
         a score only compares within one suite. Re-run one with the other's suite.</div>`
      : '');
  const names = [...new Set([...newer.arms, ...older.arms].map((a) => a.name))];
  const rows = names.map((name) => {
    const a = newer.arms.find((x) => x.name === name);
    const b = older.arms.find((x) => x.name === name);
    if (!a || !b) return `<tr><td>${esc((a || b).display)}</td><td colspan="4" class="muted">only in one run</td></tr>`;
    const move = a.credit - b.credit;
    const verdict = Math.abs(move) < T.credit ? 'unchanged' : (move > 0 ? 'BETTER' : 'WORSE');
    return `<tr>
      <td>${esc(a.display)}<div class="muted" style="font-size:12px">${verdict}</div></td>
      <td>${delta(a.credit, b.credit, 'credit')}</td>
      <td>${delta(a.correct, b.correct, 'count')}</td>
      <td>${delta(a.invented, b.invented, 'count')}</td>
      <td>${delta(a.turn, b.turn, 'time')}</td>
    </tr>`;
  }).join('');
  host.innerHTML = `${warn}
    <div class="card" style="cursor:default">
      <table>
        <tr><th>arm</th><th>credit (higher better)</th><th>correct</th>
            <th>made up (lower better)</th><th>time/turn (lower better)</th></tr>
        ${rows}
      </table>
      <p class="hint">“same” means inside the run-to-run noise band — under
      ${pct(T.credit)} credit or ${num(T.seconds, 2)}s. A ${pct(T.credit)} gap is a single question.</p>
    </div>`;
}

if (runs.length) { renderRuns(); renderDetail(); }
else { renderRuns(); }
renderCompare();
document.getElementById('foot').textContent = 'generated ' + DATA.generated +
  ' · ' + runs.length + ' run(s) · rebuild with:  python -m tests.eval.benchmark --dashboard';
</script>
</body>
</html>
"""


# ─── Running a test ─────────────────────────────────────────────────────
def next_label(runs: list[Run], base: str) -> str:
    """A free label — a benchmark must never overwrite its own history."""
    taken = {run.label.lower() for run in runs}
    if base.lower() not in taken:
        return base
    index = 2
    while f"{base}-{index}".lower() in taken:
        index += 1
    return f"{base}-{index}"


def _redact(text: str, secret: str) -> str:
    """Take a key out of anything about to be shown.

    A traceback or a settings dump can carry the key into the console, and the
    console scrolls back. The key is stripped rather than hoped about.
    """
    if secret and secret in text:
        return text.replace(secret, "***")
    return text


def can_prompt() -> bool:
    """Whether a typed key can actually be read here.

    On Windows `getpass` reads the console rather than stdin, so a piped or headless
    run would block for ever waiting for a keypress that can never arrive. If there
    is no terminal, say how to pass the key instead of hanging.
    """
    try:
        return bool(sys.stdin and sys.stdin.isatty())
    except (AttributeError, ValueError):  # pragma: no cover — an odd stdin
        return False


def ask_key(existing: str = "") -> str:
    """Ask for the Tavily key without echoing it.

    Never stored: it goes to the run in the child process's environment, is redacted
    from the report, and is wiped out of the run's scratch settings when the run
    ends. Answering blank simply runs without web search.
    """
    if existing:
        print("  Using TAVILY_API_KEY from the environment for this run.")
        return existing
    print()
    if not can_prompt():
        print("  No terminal to ask the Tavily key on, and a prompt would hang here.")
        print("  Pass --tavily-key, or set TAVILY_API_KEY, to run with web search.")
        return ""
    print("  Web search needs a Tavily API key (tavily.com -> API Keys).")
    print("  It is asked for every time and never saved: it is not written into the")
    print("  report, and it is removed from the run's scratch files when the run ends.")
    try:
        key = getpass.getpass("  Tavily API key (blank = no web search): ").strip()
    except (EOFError, KeyboardInterrupt):
        print()
        return ""
    if not key:
        print("  No key given: running with web search off (configured documentation only).")
    return key


def full_test_kwargs(
    out_dir: Path | str = REPORTS_DIR,
    *,
    model: str = "",
    key: str = "",
    name: str = "",
    tag: str = "",
    variant: str = "classic",
    suite: str = "core",
    timeout: float = 900.0,
    fake: str = "",
) -> dict[str, Any]:
    """The one-button test: everything on.

    Every question in the SUITE, documentation folders configured, web search
    enabled when a key was given, measured with ALC off against ALC on. A pure
    function so the plumbing can be asserted without a network call.

    The suite defaults to `core` so a new run stays comparable with the existing
    series; the `hard` suite (paraphrase, decoy and poisoned-note cases) is one
    choice away, and the dashboard refuses to compare across the two.
    """
    runs = load_runs(out_dir)
    chosen = tag or name or suggest_name(runs)
    return {
        "label": next_label(runs, sanitise_name(chosen)),
        "tag": chosen,
        "model": model or (runs[0].model if runs else DEFAULT_MODEL),
        "arms": list(DEFAULT_ARMS),
        "variant": variant,
        "suite": suite,
        "cases": "",
        "docs": True,
        "web": bool(key),
        "tavily_key": key,
        "out_dir": Path(out_dir),
        "timeout": timeout,
        # Only ever set by the self-test flags: a scripted model, so the whole
        # command can be exercised without a model or a network.
        "fake": fake,
    }


def run_test(
    *,
    label: str,
    tag: str,
    model: str,
    arms: Iterable[str],
    variant: str,
    suite: str = "core",
    cases: str = "",
    limit: int = 0,
    docs: bool = True,
    web: bool = False,
    out_dir: Path | str = REPORTS_DIR,
    timeout: float = 600.0,
    echo: bool = True,
    keep_store: bool = False,
    fake: str = "",
    tavily_key: str = "",
) -> tuple[Path, dict[str, Any]]:
    """Run the harness as a subprocess, streaming the lines worth reading.

    A subprocess (rather than an in-process call) keeps the two halves honest: the
    benchmark cannot accidentally share module state with a run, every run starts
    from the same place, and the engine can be used on its own exactly as the
    harness documents.
    """
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    args = [
        sys.executable, "-m", "tests.eval.alc_eval",
        "--label", label,
        "--tag", tag,
        "--model", model,
        "--arms", ",".join(arms),
        "--variant", variant,
        "--suite", suite,
        "--docs", "on" if docs else "off",
        "--web", "on" if web else "off",
        "--out-dir", str(out),
        "--timeout", str(timeout),
        "--resume",
    ]
    if cases:
        args += ["--cases", cases]
    if limit:
        args += ["--limit", str(limit)]
    if keep_store:
        args.append("--keep")
    if fake:
        args += ["--fake", fake]

    # The key travels in the child's environment, not on its command line: a
    # command line is readable by anything that can list processes.
    child_env = dict(os.environ)
    if tavily_key:
        child_env["TAVILY_API_KEY"] = tavily_key
    secret = tavily_key or os.environ.get("TAVILY_API_KEY", "")

    proc = subprocess.Popen(
        args,
        cwd=str(BACKEND),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env=child_env,
    )
    kept: list[str] = []
    assert proc.stdout is not None
    for line in proc.stdout:
        kept.append(line.rstrip("\n"))
        if echo and _interesting(line):
            print("  " + _redact(line.rstrip("\n"), secret), flush=True)
    proc.wait()
    json_path = out / f"{label}.json"
    if not json_path.exists():
        raise RuntimeError(
            f"the run produced no results ({json_path}). Last output:\n"
            + _redact("\n".join(kept[-12:]), secret)
        )
    data = json.loads(json_path.read_text(encoding="utf-8"))
    return json_path, data


def _interesting(line: str) -> bool:
    """The harness prints log noise too; a benchmark only needs the progress."""
    stripped = line.strip()
    if stripped.startswith("[") and "][INFO]" in stripped:
        return False
    return bool(
        stripped.startswith("alc-eval:")
        or stripped.startswith("wrote ")
        or stripped.startswith("interrupted")
        or stripped.startswith("skipping arm")
        or (line.startswith("  ") and " t" in line and "calls=" in line)
        or stripped.startswith("credit ")
        or stripped.startswith("carry ")
    )


# ─── The menu ───────────────────────────────────────────────────────────
def ask(prompt: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    try:
        answer = input(f"{prompt}{suffix}: ").strip()
    except (EOFError, KeyboardInterrupt):
        print()
        raise SystemExit(0)
    return answer or default


def ask_yes(prompt: str, default: bool = True) -> bool:
    answer = ask(prompt, "y" if default else "n").lower()
    return answer.startswith("y")


def menu(out_dir: Path | str = REPORTS_DIR) -> int:
    out = Path(out_dir)
    print()
    print("  ============================================================")
    print("    ALC Benchmark - does the learning cycle actually help?")
    print("  ============================================================")
    while True:
        runs = load_runs(out)
        print()
        print(f"  {len(runs)} saved run(s)")
        print("  1) Full test    - every question, documentation + web search, ALC off vs ALC on")
        print("  2) Customise a test  - pick the fact set, the arms and what to search")
        print("  3) See results in the browser  (charts, click any run, compare any two)")
        print("  4) Look at previous results in the terminal")
        print("  5) Compare two runs in the terminal")
        print("  6) Quit")
        choice = ask("  Choose", "1")
        if choice in {"6", "q", "quit", "exit"}:
            return 0
        if choice == "3":
            _open_dashboard(out)
            continue
        if choice == "4":
            _browse(runs)
            continue
        if choice == "5":
            _compare(runs)
            continue
        if choice == "1":
            _full_test_flow(out, runs)
            continue
        if choice != "2":
            print("  Please choose 1-6.")
            continue

        # ── A customised test
        print()
        print("  One number per run, and a reference point to read it against:")
        print(f"    {display_name('normal'):14s} the baseline - ALC switched off")
        print(f"    {display_name('alc-study'):14s} the cycle as it ships")
        if highest_version(runs):
            print(f"  Names count up: the newest saved run is '{runs[0].label}'.")
        else:
            print("  No versioned run saved yet, so the series starts here.")
        tag = ask("  Name this run", suggest_name(runs))
        label = next_label(runs, sanitise_name(tag))
        print(f"  saved as: {label}   (in {out})")
        model = ask("  Model", runs[0].model if runs else "qwen3:1.7b")

        available = [name for name in DEFAULT_ARMS if name in ARMS and arm_available(ARMS[name])[0]]
        chosen = list(available)
        if not ask_yes("  Measure just those two", True):
            advanced = [name for name in ADVANCED_ARMS if arm_available(ARMS[name])[0]]
            print("  Diagnostics isolate one variable each - for investigating, not for reading:")
            for name in advanced:
                print(f"    {name:15s} {display_name(name)}")
            picked = ask("  Arms (comma separated)", ",".join([*available, *advanced]))
            chosen = [item.strip() for item in picked.split(",") if item.strip() in ARMS]
        if not chosen:
            print("  No known arms chosen — nothing to run.")
            continue

        variant_choice = ask("  Fact set: 'classic' or a seed number", "classic").strip().lower()
        if variant_choice != "classic" and not variant_choice.lstrip("-+").isdigit():
            print("  Unknown fact set — using classic.")
            variant_choice = "classic"
        variant = CLASSIC.name if variant_choice == "classic" else generated(int(variant_choice)).name
        print("  Question sets: core = the original cases, hard = paraphrase/decoy/poisoned-note,")
        print("  all = both. A score is only comparable within one set.")
        suite = ask("  Which questions", "core").strip().lower()
        if suite not in ("core", "hard", "all"):
            print("  Unknown question set — using core.")
            suite = "core"

        limit_text = ask("  How many questions (blank = all 14)", "")
        try:
            limit = int(limit_text) if limit_text else 0
        except ValueError:
            limit = 0
        docs = ask_yes("  Give it documentation folders to search", True)
        key = ""
        if ask_yes("  Allow web search (needs a Tavily key)", False):
            key = ask_key(os.environ.get("TAVILY_API_KEY", "").strip())

        print()
        print(f"  About to measure '{tag}' with {model} on fact set '{variant}'.")
        if not ask_yes("  Start", True):
            continue

        started = time.time()
        print()
        try:
            _json_path, _data = run_test(
                label=label,
                tag=tag,
                model=model,
                arms=chosen,
                variant=variant if variant_choice != "classic" else "classic",
                suite=suite,
                limit=limit,
                docs=docs,
                web=bool(key),
                tavily_key=key,
                out_dir=out,
            )
        except Exception as err:  # noqa: BLE001 — a benchmark must report, not crash the menu
            print(f"\n  The run failed: {type(err).__name__}: {_redact(str(err), key)}")
            continue
        _after_run(out, label, variant, started)
    return 0


def _full_test_flow(out: Path, runs: list[Run]) -> None:
    """Everything on, one keystroke: the thing you normally press."""
    print()
    print("  Full test: every question in the fact set, documentation folders configured,")
    print("  web search as well if you give a key, measured ALC off against ALC on.")
    core_cases = [case for case in CLASSIC.cases if case.suite == "core"]
    print(f"  That is {len(core_cases)} questions x 2 arms (3 turns each for the 2 carry cases).")
    print("  The 'hard' suite (paraphrase, decoy, poisoned-note cases) is in option 2.")
    model = ask("  Model", runs[0].model if runs else DEFAULT_MODEL)
    key = ask_key(os.environ.get("TAVILY_API_KEY", "").strip())
    kwargs = full_test_kwargs(out, model=model, key=key)
    print()
    print(f"  saving as: {kwargs['label']}   (the next version in the series)")
    print(f"  web search: {'on' if kwargs['web'] else 'OFF'}   documentation: on   arms: {', '.join(kwargs['arms'])}")
    print("  this takes a few minutes on a local model.")
    if not ask_yes("  Start", True):
        return

    started = time.time()
    print()
    try:
        _json, _data = run_test(**kwargs)
    except Exception as err:  # noqa: BLE001 — a benchmark must report, not crash the menu
        print(f"\n  The run failed: {type(err).__name__}: {_redact(str(err), key)}")
        return
    _after_run(out, kwargs["label"], kwargs["variant"], started)


def _after_run(out: Path, label: str, variant: str, started: float) -> None:
    """What to say and show once a run has finished: the result, then the comparison."""
    print(f"\n  Done in {time.time() - started:.0f}s.")
    after = load_runs(out)
    fresh = find_run(after, label)
    if fresh:
        print_run(fresh)
    previous = _previous_with_same_variant(after, label, variant)
    if fresh and previous:
        print(compare_runs(fresh, previous))
        print("  (against the previous run on the same fact set — 'older' is that run.)")
    elif fresh:
        print("  (the first run on this fact set — nothing to compare it against yet.)")
    if ask_yes("  Show the results in the browser", True):
        _open_dashboard(out)


def open_path(path: Path) -> bool:
    """Hand a local file to the default browser.

    Never fatal: a benchmark that crashes because a desktop has no browser
    configured is worse than one that only prints a path.
    """
    target = path.resolve()
    try:
        webbrowser.open(target.as_uri())
        return True
    except Exception:  # noqa: BLE001 — an odd desktop, fall through
        pass
    try:
        os.startfile(str(target))  # type: ignore[attr-defined]
        return True
    except Exception:  # noqa: BLE001
        return False


def _open_dashboard(out: Path) -> None:
    try:
        path = write_dashboard(out)
    except OSError as err:
        print(f"  could not write the dashboard: {err}")
        return
    print(f"  wrote {path}")
    if not open_path(path):
        print("  (could not open a browser — double-click that file.)")


def _previous_with_same_variant(runs: list[Run], label: str, variant: str) -> Run | None:
    for run in runs:
        if run.label == label:
            continue
        if run.variant == variant:
            return run
    return None


def _browse(runs: list[Run]) -> None:
    if not runs:
        print("\n  Nothing saved yet — run a test first (option 1).")
        return
    print()
    for index, run in enumerate(runs, start=1):
        stats = summarise(run)
        best = max(
            (f"{arm} {value['credit']:.0%}" for arm, value in stats.items() if arm != "normal"),
            default="n/a",
        )
        print(
            f"  {index:2d}) {run.label:22s} {run.when:22s} {(run.tag or '(untagged)'):18s} "
            f"{run.variant:9s} best: {best}"
        )
    choice = ask("  Show which one (number, or blank to go back)", "")
    if not choice:
        return
    try:
        picked = runs[int(choice) - 1]
    except (ValueError, IndexError):
        print("  Not one of the listed runs.")
        return
    print_run(picked, verbose=ask_yes("  Show every turn", False))


def _compare(runs: list[Run]) -> None:
    if len(runs) < 2:
        print("\n  Need at least two saved runs to compare.")
        return
    print()
    for index, run in enumerate(runs, start=1):
        print(f"  {index:2d}) {run.label:22s} {run.when:22s} {(run.tag or '(untagged)'):18s} {run.variant}")
    newer_choice = ask("  Newer run (number)", "1")
    older_choice = ask("  Older run (number)", "2")
    try:
        newer = runs[int(newer_choice) - 1]
        older = runs[int(older_choice) - 1]
    except (ValueError, IndexError):
        print("  Not one of the listed runs.")
        return
    print(compare_runs(newer, older))


# ─── Non-interactive ────────────────────────────────────────────────────
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="ALC Benchmark — run, review and compare ALC tests.")
    parser.add_argument("--out-dir", default=str(REPORTS_DIR), help="where results are saved")
    parser.add_argument("--list", action="store_true", help="list saved runs and exit")
    parser.add_argument("--show", default="", help="print one saved run (label or part of one)")
    parser.add_argument("--verbose", action="store_true", help="with --show: every turn")
    parser.add_argument("--compare", nargs=2, default=None, metavar=("NEWER", "OLDER"))
    parser.add_argument(
        "--rescore",
        default="",
        metavar="LABEL",
        help="re-apply the current scorer to a saved run (or 'all'), so history stays comparable",
    )
    parser.add_argument(
        "--dashboard",
        action="store_true",
        help="rebuild the graphical view (index.html) from the saved runs",
    )
    parser.add_argument(
        "--open",
        dest="open_view",
        action="store_true",
        help="with --dashboard: open it in the browser as well",
    )
    parser.add_argument(
        "--full",
        action="store_true",
        help="everything on: every question, documentation + web search, ALC off vs ALC on",
    )
    parser.add_argument(
        "--tavily-key",
        default="",
        help="Tavily key for web search; asked for interactively when omitted. Never saved: "
        "redacted from the report and scrubbed from the scratch settings afterwards",
    )
    parser.add_argument("--run", action="store_true", help="run a test without the menu (uses the flags)")
    parser.add_argument(
        "--tag",
        default="",
        help="what this run is measuring; default: the next version in the series, e.g. 'ALC v3'",
    )
    parser.add_argument("--model", default="qwen3:1.7b")
    parser.add_argument("--arms", default=",".join(DEFAULT_ARMS))
    parser.add_argument("--variant", default="classic")
    parser.add_argument("--cases", default="")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--docs", choices=["on", "off"], default="on")
    parser.add_argument("--web", choices=["on", "off"], default="off")
    parser.add_argument(
        "--fake",
        choices=["", "oracle", "guesser"],
        default="",
        help="scripted model, so the benchmark itself can be verified without Ollama",
    )
    parser.add_argument("--label", default="")
    args = parser.parse_args(argv)
    out = Path(args.out_dir)

    if args.compare:
        runs = load_runs(out)
        newer, older = find_run(runs, args.compare[0]), find_run(runs, args.compare[1])
        if not newer or not older:
            print(f"could not find both runs in {out}", file=sys.stderr)
            return 2
        print(compare_runs(newer, older))
        return 0

    if args.dashboard:
        try:
            path = write_dashboard(out)
        except OSError as err:
            print(f"could not write the dashboard: {err}", file=sys.stderr)
            return 2
        print(path)
        if args.open_view:
            open_path(path)
        return 0

    if args.rescore:
        runs = load_runs(out)
        if args.rescore.lower() in ("all", "*"):
            targets = runs
        else:
            found = find_run(runs, args.rescore)
            targets = [found] if found else []
        if not targets:
            print(f"no saved run matches {args.rescore!r} in {out}", file=sys.stderr)
            return 2
        for run in targets:
            print_rescore(rescore(run))
        return 0

    if args.show:
        runs = load_runs(out)
        run = find_run(runs, args.show)
        if not run:
            print(f"no saved run matches {args.show!r} in {out}", file=sys.stderr)
            return 2
        print_run(run, verbose=args.verbose)
        return 0

    if args.list:
        runs = load_runs(out)
        if not runs:
            print(f"no saved runs in {out}")
            return 0
        for run in runs:
            print(f"{run.label:22s} {run.when:22s} {run.tag or '(untagged)':18s} {run.variant:9s} {len(run.rows)} turns")
        return 0

    if args.full:
        key = str(args.tavily_key or "").strip() or os.environ.get("TAVILY_API_KEY", "").strip()
        if not key:
            key = ask_key()
        kwargs = full_test_kwargs(
            out,
            model=args.model,
            key=key,
            tag=args.tag,
            name=args.label,
            variant=args.variant,
            timeout=900.0,
            fake=args.fake,
        )
        print(
            f"name: {kwargs['label']}   model: {kwargs['model']}   "
            f"web search: {'on' if kwargs['web'] else 'OFF'}   arms: {','.join(kwargs['arms'])}"
        )
        _json, _data = run_test(**kwargs)
        fresh = find_run(load_runs(out), kwargs["label"])
        if fresh:
            print_run(fresh)
        try:
            print(f"dashboard: {write_dashboard(out)}")
        except OSError as err:  # pragma: no cover — disk full, read-only, etc.
            print(f"could not write the dashboard: {err}", file=sys.stderr)
        return 0

    if args.run:
        runs = load_runs(out)
        # With no --tag, the run names itself: the previous version plus one.
        tag = args.tag or suggest_name(runs)
        label = next_label(runs, sanitise_name(args.label or tag))
        print(f"name: {label}" + ("" if args.tag else "  (the next version in the series)"))
        _json, _data = run_test(
            label=label,
            tag=tag,
            model=args.model,
            arms=[item.strip() for item in args.arms.split(",") if item.strip()],
            variant=args.variant,
            cases=args.cases,
            limit=args.limit,
            docs=args.docs == "on",
            web=args.web == "on",
            out_dir=out,
            fake=args.fake,
        )
        fresh = find_run(load_runs(out), label)
        if fresh:
            print_run(fresh)
        # Keep the graphical view current: a dashboard that lags behind the runs on
        # disk is worse than no dashboard.
        try:
            print(f"dashboard: {write_dashboard(out)}")
        except OSError as err:  # pragma: no cover — disk full, read-only, etc.
            print(f"could not write the dashboard: {err}", file=sys.stderr)
        return 0

    return menu(out)


if __name__ == "__main__":
    raise SystemExit(main())
