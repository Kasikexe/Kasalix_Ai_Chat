"""Synthetic documentation corpus + question set for the ALC eval harness.

Every fact here is INVENTED. Identifier names, defaults, error codes, version
strings and paths are all made up, so no answer can come from a model's weights:
if an arm gets one right, it read the documentation (or a note derived from it).
That is the whole point — measuring retrieval on facts a model already knows
measures nothing.

Layout written by :func:`build` under a scratch root::

    documentation/          what ``alcDocsPaths`` points at
        halyard-*.md        a fictional "Halyard" library
        quorvex-*.md        a fictional "Quorvex" library
        peltarn-limits.md   a fictional "Peltarn" service
        vintra-*.md         a fictional "Vintra" library, with a CONTRADICTION
        index.md            noise: a table of contents that answers nothing
    workspace/              a scratch project dir (``ALC/knowledge`` goes here)

Case kinds
    single         one passage answers it
    multi_hop      the name is in one file, the value in another
    conflict       two files disagree; the newer one is correct, and the older
                   value is legitimate to *mention* as outdated
    absent         the answer is NOT in the documentation. Scored on honesty:
                   saying so is correct, inventing a value is the worst outcome
    carry          a two-turn case: the seed fact is asked first, then a
                   follow-up asked with the documentation REMOVED, so only the
                   project's own notes can answer it. That isolates what a store
                   actually carries forward.
    paraphrase     the same fact as a `single` case, asked WITHOUT the words the
                   documentation uses. A lexical retriever that only wins because
                   the question quotes the docs is exposed here.
    distractor     the question is answerable, and an OLDER example file states a
                   different value for the same key. Answering the example's value
                   is wrong; the reference file is the newer source.
    note_conflict  the workspace holds a stale project NOTE that contradicts the
                   documentation. The note is ALC's own earlier summary, so the
                   documentation must win — this is what the family rule buys.

Suites
    Every case belongs to a SUITE, and a run records which one it used. Runs from
    different suites are not comparable (they answer different questions), and the
    comparison view refuses them the same way it refuses different fact sets.
    The `hard` suite is the one to iterate against; it deliberately contains
    cases that a vocabulary-matching arm fails, plus HELD-OUT cases that should
    not be tuned on at all.
"""

from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path

DOCS_DIRNAME = "documentation"
WORKSPACE_DIRNAME = "workspace"

#: The value of ``quorvex_lease_floor()``. It is documented in the PELTARN file
#: (as a cross-reference) while the function name is documented in the QUORVEX
#: file, so the multi-hop case needs both files to answer.
LEASE_FLOOR = 9

# ─── The documentation fixture ──────────────────────────────────────────
# Written as real-looking prose on purpose: retrieval has to pick a passage out
# of a file, and the judge has to tell a relevant passage from a nearby one.
HALYARD_PACING = """\
# Halyard — pacing

## The frame clock

Halyard drives its render loop from a frame clock. The clock is configured with
`halyard_set_pace(frames)`, whose default is **12 frames**. The value is a
frame count, not a duration: halyard converts it to milliseconds internally
using the display's refresh rate.

## Modes

`HalyardMode` selects how the clock behaves under load. The members are
`HalyardMode.STEADY` (the default), `HalyardMode.GLIDE` and `HalyardMode.STALL`.
GLIDE lets the clock fall behind without raising, which is what you want for
non-interactive rendering.
"""

HALYARD_CONFIG = """\
# Halyard — configuration

## Command line

The drift policy is set with `--halyard-drift`, which accepts `tight`, `loose`
or `off`. The recommended value for long-running jobs is `--halyard-drift=loose`.

## Config file

Keys in `halyard.toml` are dotted and lower-case:

- `halyard.retry.window = 45` — the retry window, in seconds.
- `halyard.render.threads` — worker count, defaults to the core count.

## Limits

`HALYARD_MAX_FRAMES = 240` is a hard ceiling. Values above it are clamped, not
rejected, so a bad config degrades instead of refusing to start.
"""

QUORVEX_ERRORS = """\
# Quorvex — errors and versions

## Error codes

Errors carry a `QUORVEX-nnnn` code. The one worth knowing is `QUORVEX-4513`:
"the tide adapter lost its lease". It is transient — retrying the call is
correct.

## Versions

Quorvex 3.14.2 is the oldest release that supports the tide adapter. Anything
before 3.14.0 will raise at import time.
"""

QUORVEX_INTERNALS = """\
# Quorvex internals

## Module layout

The tide adapter lives in `pkg/quorvex/adapters/tide.py` and is implemented by
the `TideAdapter` class. The lease floor it uses is exposed as
`quorvex_lease_floor()`.
"""

PELTARN_LIMITS = f"""\
# Peltarn limits

## Rate limit

Peltarn allows 900 requests per minute per project key. The limit is enforced
per key, not per project.

## Quota

`peltarn_write_quota()` returns the number of concurrent writes a key may make.
The documented value is 7.

## Cross-references

Quorvex's tide adapter shares this service's lease floor: `quorvex_lease_floor()`
returns {LEASE_FLOOR}.
"""

# NOTE: the older changelog says 12, the newer `vintra-pacing.md` says 16. The
# mtimes set by build() make the pacing file the newer source.
VINTRA_CHANGELOG = """\
# Vintra changelog

## 1.4.0

`vintra_pace_default()` returns 12. This was the first release with a
configurable pace.
"""

VINTRA_PACING = """\
# Vintra pacing

## Pace

`vintra_pace_default()` returns 16 since 1.7.0. The earlier value was too slow
for the adaptive scheduler.
"""

# The DECOY. It contains the same key as the reference file with a different
# value, so it both competes for retrieval and (with the two files dated) forms a
# real conflict: the reference is newer, so the reference wins. An arm without the
# conflict rule sees two values and may answer the example's.
HALYARD_EXAMPLES = """\
# Halyard — worked examples

## Example: a 60-frame clock

This older example sets the clock to 60 frames and turns the drift policy off:
`halyard_set_pace(60)` together with `--halyard-drift=off`. The value here is an
example, not the default.
"""

INDEX_NOISE = """\
# Documentation index

- Halyard: pacing, configuration
- Quorvex: errors, internals
- Peltarn: limits
- Vintra: pacing

There is no answer to any specific question on this page.
"""

# ─── The question set ───────────────────────────────────────────────────
@dataclass(frozen=True)
class Case:
    """One question, with what a correct answer must contain."""

    id: str
    kind: str
    question: str
    #: tokens that must all appear in a correct answer (normalised comparison)
    expect: tuple[str, ...]
    #: files the fact can be read from (for the report, and for sanity checks)
    sources: tuple[str, ...] = ()
    #: carry cases only: the second question, asked with the docs removed
    follow_up: str = ""
    #: values that are legitimate to MENTION but wrong to present as current
    #: (a superseded value, or a decoy example's value)
    stale: tuple[str, ...] = ()
    #: a short human note shown in the report
    note: str = ""
    #: which question set the case belongs to
    suite: str = "core"
    #: held-out cases exist to be NOT tuned on: they are reported, and are the
    #: closest thing here to an honest test set
    holdout: bool = False
    #: note_conflict cases only: a stale ALC note the harness plants in the
    #: workspace's project knowledge before the turn runs
    planted_note: str = ""


CASES: tuple[Case, ...] = (
    Case(
        "halyard-pace",
        "single",
        "What is the default frame count for halyard_set_pace in the Halyard documentation?",
        ("halyard_set_pace", "12"),
        ("halyard-pacing.md",),
    ),
    Case(
        "halyard-mode",
        "single",
        "Which HalyardMode member is documented for letting the clock fall behind without raising?",
        ("halyardmode.glide",),
        ("halyard-pacing.md",),
    ),
    Case(
        "halyard-drift",
        "single",
        "What value does the Halyard documentation recommend for the halyard-drift command line option?",
        ("loose",),
        ("halyard-config.md",),
    ),
    Case(
        "halyard-retry",
        "single",
        "What is the retry window in seconds for halyard.retry.window in halyard.toml?",
        ("45",),
        ("halyard-config.md",),
    ),
    Case(
        "halyard-max",
        "single",
        "What is HALYARD_MAX_FRAMES set to, and what happens above it?",
        ("halyard_max_frames", "240", "clamp"),
        ("halyard-config.md",),
    ),
    Case(
        "quorvex-4513",
        "single",
        "What does the Quorvex error code QUORVEX-4513 mean?",
        ("quorvex-4513", "lease"),
        ("quorvex-errors.md",),
    ),
    Case(
        "quorvex-version",
        "single",
        "Which Quorvex release is the oldest that supports the tide adapter?",
        ("3.14.2",),
        ("quorvex-errors.md",),
    ),
    Case(
        "quorvex-path",
        "single",
        "Which file defines the TideAdapter class in Quorvex?",
        ("pkg/quorvex/adapters/tide.py",),
        ("quorvex-internals.md",),
    ),
    Case(
        "peltarn-rate",
        "single",
        "What is the Peltarn rate limit in requests per minute?",
        ("900",),
        ("peltarn-limits.md",),
    ),
    Case(
        "quorvex-lease-floor",
        "multi_hop",
        "What does quorvex_lease_floor() return, and which file documents the function?",
        ("quorvex_lease_floor", "9"),
        ("quorvex-internals.md", "peltarn-limits.md"),
        note="the name is in the Quorvex file, the value in the Peltarn one",
    ),
    Case(
        "vintra-pace",
        "conflict",
        "What does vintra_pace_default() return?",
        ("16",),
        ("vintra-pacing.md", "vintra-changelog.md"),
        stale=("12",),
        note="the older changelog says 12; the newer pacing file says 16",
    ),
    Case(
        "brimwall-absent",
        "absent",
        "What is the default value of brimwall_set_ceiling() in the Brimwall documentation?",
        (),
        (),
        note="never documented — the honest answer is that it cannot be found",
    ),
    Case(
        "peltarn-carry",
        "carry",
        "What does peltarn_write_quota() return, and what is the Peltarn rate limit?",
        ("peltarn_write_quota", "7", "900"),
        ("peltarn-limits.md",),
        follow_up="What does peltarn_write_quota() return, and what is the Peltarn rate limit per key?",
        note="second turn runs with the documentation removed",
    ),
    Case(
        "halyard-carry",
        "carry",
        "What is the default frame count for halyard_set_pace, and what is the hard ceiling constant?",
        ("12", "240"),
        ("halyard-pacing.md", "halyard-config.md"),
        follow_up="What is the default frame count for halyard_set_pace, and what is the hard ceiling constant?",
        note="second turn runs with the documentation removed",
    ),
    # ── the `hard` suite: the same facts, asked less forgivingly ────────
    Case(
        "halyard-frames-paraphrase",
        "paraphrase",
        "Out of the box, how many frames does Halyard's render clock tick through?",
        ("12",),
        ("halyard-pacing.md",),
        note="the same default as halyard-pace, asked without the documented key name",
        suite="hard",
    ),
    Case(
        "halyard-example-distractor",
        "distractor",
        "What is the default frame count for halyard_set_pace in the Halyard documentation?",
        ("halyard_set_pace", "12"),
        ("halyard-pacing.md", "halyard-config.md"),
        stale=("60",),
        note="an older example file uses 60 for the same key; the newer reference says 12",
        suite="hard",
    ),
    Case(
        "vintra-poisoned-note",
        "note_conflict",
        "What does vintra_pace_default() return?",
        ("16",),
        ("vintra-pacing.md", "vintra-changelog.md"),
        stale=("12", "41"),
        note="a stale project note claims 41; the documentation is authoritative",
        suite="hard",
        holdout=True,
        planted_note=(
            "# Vintra pace\n\n"
            "## Key facts\n\n"
            "- vintra_pace_default() returns 41 as of the current release.\n"
        ),
    ),
    Case(
        "brimwall-paraphrase-absent",
        "absent",
        "Which ceiling value does Brimwall use by default?",
        (),
        (),
        note="still undocumented, asked in different words — honesty must not depend on phrasing",
        suite="hard",
        holdout=True,
    ),
)

#: Files a correct answer may be derived from. Anything else is not a source.
FILES: dict[str, str] = {
    "halyard-pacing.md": HALYARD_PACING,
    "halyard-config.md": HALYARD_CONFIG,
    "halyard-examples.md": HALYARD_EXAMPLES,
    "quorvex-errors.md": QUORVEX_ERRORS,
    "quorvex-internals.md": QUORVEX_INTERNALS,
    "peltarn-limits.md": PELTARN_LIMITS,
    "vintra-changelog.md": VINTRA_CHANGELOG,
    "vintra-pacing.md": VINTRA_PACING,
    "index.md": INDEX_NOISE,
}

#: Relative age of each file in days, as written by build() (bigger = older).
#: Only the disagreeing pairs matter: the older value has to be the older file,
#: which is what makes the conflict resolvable at all.
AGE_DAYS: dict[str, int] = {
    "vintra-changelog.md": 30,
    "vintra-pacing.md": 2,
    # The decoy example is the OLDEST source, so the reference wins on recency and
    # the distractor stays a retrieval test rather than a rigged conflict.
    "halyard-examples.md": 90,
}

#: The suites a run can select. `core` is the historical question set — every
#: report made before suites existed was a `core` run.
SUITES = ("core", "hard")


@dataclass
class Variant:
    """One set of invented facts. ``classic`` is the fixed benchmark; generated
    variants exist so a model cannot memorise the fixtures between generations."""

    name: str
    files: dict[str, str]
    cases: tuple[Case, ...]
    ages: dict[str, int] = field(default_factory=dict)


@dataclass
class Corpus:
    """A built corpus on disk, with the scratch dirs an arm needs."""

    root: Path
    docs_root: Path
    workspace: Path
    cases: tuple[Case, ...] = CASES
    files: dict[str, str] = field(default_factory=lambda: dict(FILES))
    ages: dict[str, int] = field(default_factory=lambda: dict(AGE_DAYS))
    variant: str = "classic"
    sizes: dict[str, int] = field(default_factory=dict)

    def by_id(self, case_id: str) -> Case:
        for case in self.cases:
            if case.id == case_id:
                return case
        raise KeyError(case_id)

    def texts(self) -> dict[str, str]:
        return dict(self.files)

    def all_text(self) -> str:
        """Every passage in the corpus (used for the corpus self-check)."""
        return "\n".join(self.files.values())

    def source_text(self, names: tuple[str, ...]) -> str:
        return "\n".join(self.files[name] for name in names if name in self.files)

    def facts_for(self, case: Case) -> str:
        """The passages that answer one case — the only legitimate grounding.

        The invented-answer check is scoped to THIS text rather than the whole
        corpus: a value that is documented elsewhere is not evidence of an
        invention, but a value that appears nowhere in this case's sources, and
        is not the case's own expected token, is the model making something up.
        """
        return self.source_text(case.sources)


CLASSIC = Variant("classic", dict(FILES), CASES, dict(AGE_DAYS))


def build(root: str | Path, *, variant: Variant | None = None) -> Corpus:
    """Write the documentation folder and a scratch workspace under ``root``."""
    root = Path(root)
    chosen = variant or CLASSIC
    docs_root = root / DOCS_DIRNAME
    workspace = root / WORKSPACE_DIRNAME
    docs_root.mkdir(parents=True, exist_ok=True)
    workspace.mkdir(parents=True, exist_ok=True)

    now = time.time()
    sizes: dict[str, int] = {}
    for name, text in chosen.files.items():
        path = docs_root / name
        path.write_text(text, encoding="utf-8")
        sizes[name] = len(text)
        # A deterministic mtime per file: the conflict case is resolved by which
        # source is NEWER, so the corpus fixes the ages rather than letting
        # checkout order decide.
        age = chosen.ages.get(name, 10)
        stamp = now - age * 86400
        os.utime(path, (stamp, stamp))

    return Corpus(
        root=root,
        docs_root=docs_root,
        workspace=workspace,
        cases=chosen.cases,
        files=dict(chosen.files),
        ages=dict(chosen.ages),
        variant=chosen.name,
        sizes=sizes,
    )


# ─── Generated variants ─────────────────────────────────────────────────
# The classic fixtures are hand-written so the tests can assert exact tokens.
# A BENCHMARK has a different problem: if the facts never change, a model (or a
# fine-tune) can pass by memorising the fixtures instead of retrieving them. So a
# variant derives its invented names and values from a seed — the same seed is
# always the same benchmark, and a new seed is a new set of facts nothing has
# ever seen.
_ONSET = ("ba", "bri", "cor", "dra", "fel", "glim", "hal", "jor", "kel", "lum",
          "mor", "nit", "pel", "quo", "rin", "sar", "tor", "var", "wel", "zor")
_CODA = ("del", "fex", "gar", "lex", "min", "nox", "pex", "rax", "sil", "tar",
         "vex", "wick", "xen", "yar", "zil")
_VERB = ("set", "get", "read", "write", "reset", "sync", "flush", "fetch", "apply", "probe")
_NOUN = ("pace", "drift", "tide", "loom", "brim", "quill", "spin", "vane", "moss",
         "reed", "glint", "ember")


def _library(rng: "random.Random") -> str:
    name = rng.choice(_ONSET) + rng.choice(_CODA)
    while name in {entry.split("-")[0] for entry in FILES}:
        name = rng.choice(_ONSET) + rng.choice(_CODA)
    return name


def generated(seed: int) -> Variant:
    """A fresh set of invented facts from a seed: same seed, same benchmark."""
    import random

    rng = random.Random(int(seed))
    lib = _library(rng)
    files: dict[str, str] = {}
    cases: list[Case] = []
    ages: dict[str, int] = {}

    def doc(name: str, text: str) -> str:
        files[name] = text
        return name

    # 1. a default value
    fn = f"{lib}_{rng.choice(_VERB)}_{rng.choice(_NOUN)}"
    frames = rng.randrange(8, 60)
    f1 = doc(
        f"{lib}-clock.md",
        f"# {lib.title()} — clock\n\n## The frame clock\n\n"
        f"The clock is configured with `{fn}(frames)`, whose default is **{frames} frames**.\n",
    )
    ages[f1] = 40
    cases.append(Case("clock-default", "single", f"What is the default frame count for {fn}?", (fn, str(frames)), (f1,)))

    # 2. an enum member
    mode = f"{lib.title()}Mode.{rng.choice(('STEADY','GLIDE','STALL','TURBO','CREEP')).title()}"
    chosen = re.sub(r"[^A-Z]", "", mode.split(".")[1]) + rng.choice(("A", "B", "C"))
    mode = f"{lib.title()}Mode.{chosen}"
    f2 = doc(
        f"{lib}-modes.md",
        f"# {lib.title()} modes\n\n## Modes\n\n`{lib.title()}Mode` members are "
        f"`{lib.title()}Mode.STEADY` and `{mode}`, which lets the clock fall behind without raising.\n",
    )
    ages[f2] = 40
    cases.append(Case("mode-member", "single", f"Which {lib.title()}Mode member lets the clock fall behind without raising?", (mode.lower(),), (f2,)))

    # 3. a config key with a value
    window = rng.randrange(20, 300)
    key = f"{lib}.retry.window"
    f3 = doc(
        f"{lib}-config.md",
        f"# {lib.title()} configuration\n\n## Keys\n\n- `{key} = {window}` — the retry window, in seconds.\n",
    )
    ages[f3] = 40
    cases.append(Case("retry-window", "single", f"What is the retry window in seconds for {key}?", (str(window),), (f3,)))

    # 4. an error code
    code = f"{lib.upper()[:4]}-{rng.randrange(1000, 9999)}"
    f4 = doc(
        f"{lib}-errors.md",
        f"# {lib.title()} errors\n\n## Codes\n\n`{code}` means the adapter lost its lease. "
        "It is transient — retrying the call is correct.\n",
    )
    ages[f4] = 40
    cases.append(Case("error-code", "single", f"What does the {lib.title()} error code {code} mean?", (code, "lease"), (f4,)))

    # 5. a file path
    path = f"pkg/{lib}/adapters/{rng.choice(_NOUN)}.py"
    cls = f"{rng.choice(_NOUN).title()}Adapter"
    f5 = doc(f"{lib}-internals.md", f"# {lib.title()} internals\n\n## Layout\n\n`{path}` holds the `{cls}` class.\n")
    ages[f5] = 40
    cases.append(Case("module-path", "single", f"Which file defines the {cls} class in {lib.title()}?", (path,), (f5,)))

    # 6. a rate limit
    rate = rng.randrange(100, 9000)
    f6 = doc(
        f"{lib}-limits.md",
        f"# {lib.title()} limits\n\n## Rate limit\n\n{lib.title()} allows {rate} requests per minute per project key.\n",
    )
    ages[f6] = 40
    cases.append(Case("rate-limit", "single", f"What is the {lib.title()} rate limit in requests per minute?", (str(rate),), (f6,)))

    # 7. multi-hop: the name in one file, its value in another
    floor_fn = f"{lib}_{rng.choice(_VERB)}_{rng.choice(_NOUN)}_floor"
    floor = rng.randrange(3, 30)
    f7a = doc(f"{lib}-adapters.md", f"# {lib.title()} adapters\n\n## Lease floor\n\nThe lease floor is exposed as `{floor_fn}()`.\n")
    f7b = doc(f"{lib}-service.md", f"# {lib.title()} service\n\n## Cross-references\n\n`{floor_fn}()` returns {floor}.\n")
    ages[f7a] = 40
    ages[f7b] = 40
    cases.append(Case("lease-floor", "multi_hop", f"What does {floor_fn}() return?", (floor_fn, str(floor)), (f7a, f7b)))

    # 8. a contradiction resolved by which source is newer
    pace_fn = f"{lib}_pace_default"
    old_value, new_value = rng.randrange(4, 20), rng.randrange(21, 60)
    f8a = doc(f"{lib}-changelog.md", f"# {lib.title()} changelog\n\n## 1.0.0\n\n`{pace_fn}()` returns {old_value}.\n")
    f8b = doc(f"{lib}-pacing.md", f"# {lib.title()} pacing\n\n## Pace\n\n`{pace_fn}()` returns {new_value} since 2.0.0.\n")
    ages[f8a] = 30
    ages[f8b] = 2
    cases.append(
        Case(
            "pace-conflict",
            "conflict",
            f"What does {pace_fn}() return?",
            (str(new_value),),
            (f8a, f8b),
            stale=(str(old_value),),
            note="the older changelog value is superseded by the newer pacing file",
        )
    )

    # 9. something that is documented nowhere
    absent_fn = f"{lib}_set_{rng.choice(_ONSET)}{rng.choice(_CODA)}"
    cases.append(
        Case(
            "undocumented",
            "absent",
            f"What is the default value of {absent_fn}() in the {lib.title()} documentation?",
            (),
            (),
            note="never documented — the honest answer is that it cannot be found",
        )
    )

    # 10. a two-turn carry case
    quota_fn = f"{lib}_{rng.choice(_VERB)}_quota"
    quota = rng.randrange(2, 20)
    f10 = doc(
        f"{lib}-quota.md",
        f"# {lib.title()} quota\n\n## Quota\n\n`{quota_fn}()` returns {quota}.\n\n"
        f"## Rate limit\n\n{lib.title()} allows {rate} requests per minute per project key.\n",
    )
    ages[f10] = 40
    cases.append(
        Case(
            "quota-carry",
            "carry",
            f"What does {quota_fn}() return, and what is the {lib.title()} rate limit?",
            (quota_fn, str(quota), str(rate)),
            (f10,),
            follow_up=f"What does {quota_fn}() return, and what is the {lib.title()} rate limit per key?",
            note="second turn runs with the documentation removed",
        )
    )

    # 11. the hard suite: the same facts, asked less forgivingly.
    cases.append(
        Case(
            "clock-paraphrase",
            "paraphrase",
            f"Out of the box, how many frames does the {lib.title()} clock tick through?",
            (str(frames),),
            (f1,),
            note="the default again, without the documented function name",
            suite="hard",
        )
    )
    example = frames * rng.randrange(2, 4)
    f_decoy = doc(
        f"{lib}-examples.md",
        f"# {lib.title()} — worked examples\n\n## Example: a {example}-frame clock\n\n"
        f"This older example sets the clock with `{fn}({example})`. The value here is an "
        "example, not the default.\n",
    )
    ages[f_decoy] = 120  # older than the reference, so recency still favours the doc
    cases.append(
        Case(
            "clock-distractor",
            "distractor",
            f"What is the default frame count for {fn}?",
            (fn, str(frames)),
            (f1,),
            stale=(str(example),),
            note="an older example file uses a different value for the same key",
            suite="hard",
        )
    )
    note_value = rng.randrange(100, 999)
    cases.append(
        Case(
            "pace-poisoned-note",
            "note_conflict",
            f"What does {pace_fn}() return?",
            (str(new_value),),
            (f8a, f8b),
            stale=(str(old_value), str(note_value)),
            note="a stale project note claims a third value; the documentation wins",
            suite="hard",
            holdout=True,
            planted_note=(
                f"# {lib.title()} pace\n\n## Key facts\n\n"
                f"- {pace_fn}() returns {note_value} as of the current release.\n"
            ),
        )
    )

    return Variant(f"seed-{int(seed)}", files, tuple(cases), ages)


__all__ = [
    "AGE_DAYS",
    "CASES",
    "CLASSIC",
    "Case",
    "Corpus",
    "DOCS_DIRNAME",
    "FILES",
    "LEASE_FLOOR",
    "SUITES",
    "Variant",
    "build",
    "generated",
]
