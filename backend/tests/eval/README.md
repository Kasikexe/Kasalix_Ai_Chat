# ALC eval harness

Answers one question with a number: **does the Advanced Learning Cycle actually
improve an answer, and what does it cost?**

Everything else about ALC is verifiable in unit tests (does the cycle run, does
the index work, does the store dedupe). Whether it *helps* is not — that needs a
measurement, a corpus the model cannot have memorised, and a committed reading of
the result.

```bash
cd backend
.venv/Scripts/python.exe -m tests.eval.alc_eval --list
.venv/Scripts/python.exe -m tests.eval.alc_eval --arms normal,alc-none,alc-raw,alc-study,alc-heuristic --label phase4
```

Writes `reports/<label>.md` (readable in 20 seconds) and `reports/<label>.json`
(machine-diffable). Nothing is written outside the scratch run directory, which is
a temp dir unless you pass `--run-dir`.

## Running it as a benchmark (`ALC_Benchmark.bat`)

The harness above is the engine; `benchmark.py` is the yardstick around it. A
benchmark is only a benchmark if a result can be **run again and compared**, so
every run is tagged with what it was measuring (`alc-0.13.0`, `kasalix-1.0-lora`,
any free text) and nothing is ever overwritten — a label that already exists gets
a numbered suffix.

Double-click `ALC_Benchmark.bat` in the repository root for a menu:

1. **Full test** — everything on: every question in the fact set, the documentation
   folders configured, web search too if you give it a key, measured ALC off against
   ALC on. This is the one you normally press. It asks for the model, then for your
   Tavily key (see below), then runs and shows the result and the comparison against
   the previous run on the same fact set.
2. **Customise a test** — the same wizard with every knob: name, model, fact set,
   arms, question count, documentation on/off, web search on/off.
3. **See the results in the browser** — the graphical view, described below.
4. **Look at previous results in the terminal** — the run list, then one run's
   table, optionally turn by turn.
5. **Compare two runs in the terminal** — a delta table where every metric says
   which direction is better *in words*: `credit 79% -> 86% (better)`,
   `invented 1 -> 0 (better)`. `ALC off` is called out as the control, because
   movement there is model variance between the two runs, not a change in ALC —
   and it sets the noise floor for the other rows.

### The full test in one command

```bash
ALC_Benchmark.bat --full
```

Same thing without the menu: all 14 questions, documentation on, web search on,
ALC off vs ALC on, named as the next version in the series. At the end it writes
the graphical view.

### Your Tavily API key

Web search needs a key from [tavily.com](https://tavily.com) (API Keys). **It is
asked for every time and never saved.** Answering blank simply runs without web
search — everything else still works, because the invented facts live in the local
documentation folder and are deliberately not on the web.

The key is handled the way a key should be:

- asked for with hidden input, so it is not echoed to the screen or into the
  terminal's scrollback;
- carried to the run **in the child process's environment**, not on its command
  line, because a command line is readable by anything that can list processes;
- **redacted from the report** — `reports/<label>.json` records
  `"usedTavilyKey": true` and never the key itself;
- **scrubbed from the run's own scratch files** the moment the run ends (the app
  reads it from a settings file in a temp directory, which outlives the process);
- stripped out of anything printed, so a traceback that dumps a settings dict
  cannot leak it either.

For scripting, pass it explicitly rather than storing it anywhere persistent:

```bash
ALC_Benchmark.bat --full --tavily-key sk-...
# or let it come from the environment of the current shell only
set TAVILY_API_KEY=sk-...   &&   ALC_Benchmark.bat --full
```

If there is no terminal to prompt on (a piped or headless run), the prompt is
skipped instead of hanging — on Windows `getpass` reads the console rather than
stdin, so a prompt there would block for ever — and it says how to pass the key
instead.

### Names count up (`ALC v2` → `ALC v3`)

Every run is **the previous version plus one**, so the series is its own changelog.
The runner reads the highest `vN` among the saved runs' names and tags and offers
`vN+1` — in the menu it is the default for "Name this run", and `--run` with no
`--tag` names itself. An unversioned run (an old, hand-named one, or a run labelled
`kasalix-1.0`) never resets the count.

The name is also the filename, so it is cleaned of characters a filesystem will not
take (`/ \ : * ? " < > |`). Case and spaces survive — `ALC v3` reads better in a
list than `alc-v3`, and `--show` matches on a case-insensitive substring, so it
stays easy to type.

```bash
# names itself, from whatever is already saved
.venv/Scripts/python.exe -m tests.eval.benchmark --run --arms normal,alc-study

# or say it explicitly, e.g. when switching model builds
.venv/Scripts/python.exe -m tests.eval.benchmark --run --tag "Kasalix v1" --model kasalix:1.0
```

Old runs can be moved to `reports/archive/` to start a clean series; `load_runs`
only reads `*.json` in `reports/` itself, so an archive is ignored by the run list
and the view without being thrown away.

### Two arms, and as many diagnostics as you ask for

A new run measures **`ALC off`** (the baseline) and **`ALC on`** (the cycle as it
ships) — one number per run, with a reference point to read it against. That is
what comparing two generations of the model needs: "ALC 0.13 scored 86%, Kasalix
1.0 scored 93%", all on the same fact set.

Every other arm isolates a single variable and is still runnable
(`--arms alc-heuristic`), but they are offered in the menu only if you decline
"measure just those two" and are labelled `diagnostic arm` in the view. Six
unfamiliar names in a seven-row table is not a result; it is a puzzle.

| name you see | arm id | what it is |
| --- | --- | --- |
| `ALC off` | `normal` | no cycle at all — the baseline |
| `ALC on` | `alc-study` | the shipped cycle |
| `ALC on, keeps nothing` | `alc-none` | diagnostic: gathers, writes nothing back |
| `ALC on, raw excerpts` | `alc-raw` | diagnostic: Phase 2 notes instead of studies |
| `ALC on, software decides` | `alc-heuristic` | diagnostic: the model's decide/judge layer off |
| `ALC on, conflicts unresolved` | `alc-noconflict` | **ablation**: no ordering of contradictory sources |
| `ALC on, answer unchecked` | `alc-noguard` | **ablation**: the answer gate and its prompt hint off |

The two ablations exist so a guarantee is measured on its own instead of being
part of a bundle that "seems better": run `alc-noguard` when you want to know how
much of "zero fabrications" is the gate, and `alc-noconflict` when you want to know
whether ordering the evidence in software is what fixes a conflict case.

### The graphical view (`reports/index.html`)

`ALC_Benchmark.bat` option 2, or `--dashboard [--open]`. A single self-contained
HTML file — no server, no CDN, no build step, opens offline by double-click:

- one bar per saved run, newest first: the credit for the arm the run is *about*,
  with `ALC off` as a thin grey mark on the same bar, and a red "made up: N" pill
  when the run invented values;
- click any run for its full table (credit, correct, said "not found", made up,
  time per turn, model calls, carry kept/wiped);
- pick any two runs for a comparison with coloured, worded deltas — and a warning
  instead of numbers when the two runs used different fact sets.

The numbers are computed in Python by the same `summarise` the terminal tables
use, then embedded as JSON, so the picture and the text cannot disagree.

Non-interactive equivalents, if you'd rather script it:

```bash
.venv/Scripts/python.exe -m tests.eval.benchmark --list
.venv/Scripts/python.exe -m tests.eval.benchmark --dashboard --open
.venv/Scripts/python.exe -m tests.eval.benchmark --show phase4 --verbose
.venv/Scripts/python.exe -m tests.eval.benchmark --compare baseline-0.13.0 phase4
.venv/Scripts/python.exe -m tests.eval.benchmark --run --tag kasalix-1.0 --model kasalix:1.0
```

### Fresh facts every time (`--variant`)

A fixed fixture has a shelf life: once a generation has been scored on it, it can
pass by memorising the fixture rather than by retrieving it. `--variant <seed>`
generates a brand-new set of invented libraries, identifiers, defaults, error
codes and paths from a seed (`--variant 7`, or `--variant seed-7`). The same seed
is always the same benchmark; a new seed is facts nothing has ever seen.

The generated set covers every question kind — retrieval, multi-hop,
contradiction, unanswerable and carry — and the comparison refuses to compare two
runs on **different** fact sets, because their numbers are not the same quantity.
Use `--variant classic` (the default) when you want the fixed fixtures the unit
tests pin.

### Suites and held-out cases (`--suite`, `--holdout-only`)

Question sets are grouped into **suites**, and a run records which one it used:

| suite | what is in it |
| --- | --- |
| `core` | the historical, well-worded cases — every report made before suites existed is a `core` run |
| `hard` | the cases a vocabulary-matching arm fails: a **paraphrase** that avoids the documentation's words, a **distractor** whose older example file states a plausible wrong value, and a **poisoned note** that contradicts the file it summarises |

```bash
.venv/Scripts/python.exe -m tests.eval.alc_eval --suite hard
.venv/Scripts/python.exe -m tests.eval.alc_eval --suite all --holdout-only
```

Two runs from different suites are **not comparable** — a paraphrase asks a
different question than the `core` case it was built from — so the comparison view
refuses them the same way it refuses two different fact sets, in words rather than
by printing a delta nobody should read. `--holdout-only` runs just the held-out
cases (currently the poisoned note and an absent-value paraphrase): they are
reported, meant to be looked at rarely, and must not be tuned against.

### Moving old results onto a new scorer (`--rescore`)

A saved run stores the *verdict* as well as the answer, so a run scored by an older
version of `scoring.py` means something slightly different from a new one — and
comparing the two compares two rules. `--rescore <label>` (or `--rescore all`)
re-applies today's scorer to the stored answers and rewrites the report:

```bash
.venv/Scripts/python.exe -m tests.eval.benchmark --rescore all
```

It prints what changed per row and the credit before/after per arm. Nothing is
invented: only the verdicts and their evidence lists are recomputed. This was
used for real — a live run exposed the admission rule rejecting "not *explicitly*
documented", and re-scoring put the whole history onto the fixed rule.

### The noise floor

Two runs of the *same* code differ. `normal` runs no cycle at all, so any swing in
its row between two runs measures how much a result has to move to be worth
believing — read the other rows against it before calling anything an improvement.
Timing deltas under 0.05s and credit deltas under 2 points are reported as `same`
on purpose.

## Why the corpus is invented

`corpus.py` builds a documentation folder for five fictional libraries — Halyard,
Quorvex, Peltarn, Vintra, Brimwall — with invented identifiers, defaults, error
codes, version strings and paths. No model has `halyard_set_pace` in its weights,
so **a correct answer can only have come from retrieval**. Measuring retrieval on
facts a model already knows measures nothing.

The corpus is deterministic (fixed fixtures, fixed file ages), so two runs are
comparable, and it fixes the mtimes on purpose: the `vintra-pace` case has an
older changelog saying 12 and a newer file saying 16, which is only resolvable if
the newer source really is newer.

## Question kinds

| kind | what it isolates |
| --- | --- |
| `single` | plain retrieval from one passage |
| `multi_hop` | the name is in one file, the value in another |
| `conflict` | two sources disagree; the newer one is current |
| `absent` | **not** in the documentation — scored on honesty, not recall |
| `carry` | a two-turn case, see below |
| `paraphrase` | the same fact asked **without** the documentation's vocabulary |
| `distractor` | an older example file states a plausible value for the same key |
| `note_conflict` | a stale project note planted in the workspace contradicts the docs |

The last three (`hard` suite) are the cases the quality pass is measured on: they
exist to expose a retriever that only wins because the question quotes the docs, an
arm that prefers an example over the reference, and one that lets a project note
overrule the file it was summarised from.

The runner ends with a **corpus self-check** table: every expected token must
appear in that case's own sources. A ❌ there means the fixture is wrong, not the
arm — the harness would be asking for something its documents do not say.

## The three measurements that matter

**`docs_gain`** — credit(ALC) − credit(Normal) on the first turn of each case.
Is the cycle worth its latency at all?

**`decide_cost`** — `alc-heuristic` vs `alc-raw`. `alc-heuristic` disables the
model's own intake/action/judge calls entirely (`alcDecideModel: ""`), so every
decision comes from the software heuristics. If it scores as well or better, the
extra generations are buying latency and nothing else.

**`carry_gain`** — the only number that justifies the knowledge store, and the
one Phase 4 exists to move. A `carry` case runs three turns:

1. `seed` — ask a question with the documentation configured and an empty store;
2. `warm` — ask the follow-up again, **in a fresh conversation, with the
   documentation removed**, keeping the store;
3. `cold` — the identical turn against a wiped store.

`warm − cold` is what the store carried, and nothing else differs between the two
runs. A fresh conversation is deliberate: reusing the history would let the model
answer from its own earlier reply, which tests memory of the chat rather than the
project's notes.

## Arms

| arm | what it is |
| --- | --- |
| `normal` | today's pipeline, no cycle |
| `alc-none` | gathers, answers, writes nothing back (what chat did before Phase 4) |
| `alc-raw` | ALC + appended excerpt notes (Phase 2 behaviour) |
| `alc-study` | ALC + synthesised studies (the shipped default) |
| `alc-heuristic` | the cycle with the model's decision layer removed |
| `alc-noconflict` | ablation: the shipped cycle with in-turn conflict resolution off |
| `alc-noguard` | ablation: the shipped cycle with the answer gate and its prompt hint off |

An ablation switches **one guarantee off** and nothing else, so a difference
between it and `alc-study` is that guarantee's worth. Nothing in the product can
switch them off — they are opts keys the harness sets, not settings a user could
toggle.

Arms whose mechanism is missing in the checkout are skipped with a reason rather
than run and mislabelled (`--list` shows which are available).

## Scoring

Deterministic, no judge model and no API key. `correct` (every expected token),
`partial`, `admitted` (said plainly it could not find it), `invented` (asserted a
value that appears in no source for that case), `wrong`. **Credit = correct or
admitted**: turning a confident wrong answer into "I could not find it" is a real
improvement even when the fact was not retrieved.

The admission rule allows an adverb between the negation and the verb ("not
*explicitly* documented", "isn't *directly* mentioned"). That looseness is
deliberate: a live run was scored as a failure for phrasing an honest refusal
slightly differently, which understates the model rather than the other way
round. It cannot hide a fabrication, because an invented value is checked first
and still outranks admission — "not documented here, but it defaults to 42
frames" is `invented`, and there is a test for it.

Reading a **live** run's stored answers, not just its table, is how that bug was
found. The tables are a summary; the answers are the evidence.

The invention check is deliberately conservative — it only flags values,
identifiers, codes and paths, and only when they appear in none of the case's
sources, the question, or the case's known-stale values. List markers and years
are not claims. So **an invention rate is a floor, not a ceiling.**

`--judge-model`/LLM judging is deliberately not implemented: a judge that
disagrees run to run would make "did this change help?" unanswerable, which is the
only question the harness exists to answer.

## Flags

| flag | meaning |
| --- | --- |
| `--arms a,b` | which arms to run |
| `--cases id1,id2` / `--limit N` | narrow the question set |
| `--docs on\|off` | configure the documentation folders or not |
| `--web on\|off` | `on` needs `TAVILY_API_KEY`; **off is the default** so a run is offline and repeatable |
| `--fake oracle\|guesser` | scripted model: the harness's self-test (see below) |
| `--suite core\|hard\|all` | which question set (default `core`); runs from different suites are not comparable |
| `--holdout-only` | only the held-out cases, which are not meant to be tuned on |
| `--variant classic\|SEED` | the fixed fixtures, or a freshly generated fact set |
| `--resume` | skip turns already present in the label's json, then re-report |
| `--timeout S` | per-turn ceiling; a timed-out turn is recorded as data, not a crash |

## The scripted model (`--fake`)

`--fake oracle` replaces the model with one that **may only state what the
pipeline put in front of it**: it scans the system prompt for the case's expected
tokens and either repeats them or says it could not find them. `--fake guesser`
always invents a value.

That makes the harness testable without Ollama and proves the plumbing in both
directions: with retrieval wired up the oracle scores and Normal does not, and the
guesser is caught — and with the answer gate on, the value it invents is stopped
before it reaches the stream, which is how the answer check is proven without a
live model. It is also how `tests/test_alc_eval.py` proves the carry
mechanism end to end — including that `alc-study`'s fallback path (excerpt notes)
still carries a fact.

Two things the fake cannot do, by design: it cannot write a real study (its
synthesis reply is unparseable, so `alc-study` falls back to excerpts — use a live
model for that), and it cannot tell you anything about answer quality.

## Where a turn lost (`failureStage`)

A single falling score says something regressed; it does not say what to open.
Every losing turn is classified from the events it already emitted — deterministically,
with no judge model — and the report prints a table of stage counts per arm:

| stage | what it means |
| --- | --- |
| `no-cycle` | the turn never entered ALC (intake off-ramped, or the toggle was lost) |
| `no-lookup` | the cycle ran but gathered nothing |
| `retrieval-miss` | lookups happened and the answer was not among the hits |
| `judge-drop` | the passage was found and the relevance judge dropped it |
| `conflict` | it answered with a value the sources had already superseded |
| `unsupported-claim` | it asserted something no source states |
| `empty-answer` | nothing was produced |
| `error` | the turn failed |
| `unclassified` | lost, and none of the above fits — a case worth reading by hand |

The stages map onto the parts of the cycle that exist, so a `retrieval-miss` and a
`judge-drop` send you to different files even though both rows read "wrong".

A row also keeps **what the turn actually did**, so a stage is actionable without
re-running anything: `queries` (what was asked of each source), `rejects` (the
relevance judge's own reason for every passage it threw away) and `withheld`
(what the answer gate refused to release, plus whether the gate was on).
`rejects` is how the `vintra-pace` defect was found — the saved report named the
passage *and* the reason (`off-topic` for the file holding the current value) —
and `withheld` is the difference between "it never said that" and "it said it and
software stopped it", which is the whole claim the guard makes.

## Reading a result honestly

* `docs off` + `web off` is the "day one" configuration: ALC has no source at all
  and should score like Normal. If it does not, something is wrong.
* `web on` with this corpus is expected to change nothing — the facts are invented,
  so they are not on the web. That is the point: **ALC's advantage comes from the
  documentation you configure.**
* Latency is reported as `ttft` (time to first token) *and* total. `alc-study`
  spends its writing-up time **after** the answer has streamed, so `ttft` should
  stay close to `alc-raw` even when the total does not.
* A single run on one machine is an indication, not a benchmark. The deltas between
  arms in one run are the result; the absolute totals are not.
