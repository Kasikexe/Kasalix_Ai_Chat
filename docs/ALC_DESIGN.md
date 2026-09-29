# ALC — Advanced Learning Cycle (v0.13.0 design)

**Status:** design agreed; **Phases 1–4 implemented** (chat core + Koding integration + UI +
measurement & learning) — see §9 for the file map and §10 for what live testing against qwen3:1.7b
revealed. Phase 4 also amended **D8** (project knowledge is gated on a workspace, not on Koding)
and **D9** (the model writes the study, software verifies it), and added the eval harness that
measures all of it. Open: an `alc` model assignment (D12), optional embedding rerank, and the
empty-retrieval honesty gap in §8.
**Target:** v0.13.0, working with the current stock models (e.g. Qwen3 1.7B).
**Version of this document:** 2026-09-29

---

## 1. What ALC is (and is not)

ALC is a **software-orchestrated reasoning and information-gathering cycle** wrapped around the
LLM. It lets a small local model solve tasks that exceed its weights by retrieving information
from documentation, project knowledge and the web, judging what is relevant, and keeping its
working context small.

It is **not**:

- weight training, fine-tuning, or any permanent model change during use;
- a new model requiring different hardware;
- a new engine that replaces the existing chat / Koding pipelines.

Everything in this document is ordinary Python orchestration. The model's weights are never
touched at runtime.

**Non-goals for 0.13.0:** vision, embeddings-based retrieval (kept as an optional later add),
fine-tuned Kasalix models, multi-agent ALC.

---

## 2. The two engines ALC must cooperate with

The ALC design is derived from what 0.12.0 already does. Both engines stay intact.

| Engine | Entry | Behaviour |
| --- | --- | --- |
| Chat | `pipeline.run_pipeline` (`pipeline.py:913`) | Intent detection, parallel context gathering (workspace listing + memory + search planning), optional heuristic tool stage, then a model-driven tool loop (`run_chat_tool_loop`, `pipeline.py:641`, `MAX_TOOL_ROUNDS = 4`, `CHAT_TOOL_IDS = {web_search, draw_image}`). |
| Koding | `agent.run_agent_loop` (`agent.py`) | Autonomous JSON tool protocol over `AGENT_TOOL_DEFS` (`agent.py:528`, ~35 tools), dispatched by `execute_tool` (`agent.py:1039`); loop guards `MAX_ITERATIONS = 15` soft / `120` hard, `PROGRESS_WINDOW = 6`, `MAX_HISTORY = 40`, `MAX_CONTEXT_TOKENS = 16000`. |

Existing pieces ALC reuses rather than reimplements:

| Need | Existing primitive |
| --- | --- |
| Non-streamed model call | `run_internal_stage` (`pipeline.py:518`) |
| Context pruning / budgets | `prune_to_budget` (`agent.py:328`), `MAX_READ_BYTES = 200KB`, `MAX_OUTPUT_CHARS = 8000` |
| Web search | `search.search_web` (`search.py:908`) → `SearchOutcome` (`search.py:91`), TTL cache, retry/rewrite, `set_source_sink` (`search.py:57`) |
| "Should I search?" decision | `plan_search` (`pipeline.py:272`), `decide_search` (`search.py:747`), `needs_web_search` (`pipeline.py:81`) |
| Workspace text search | agent `search_files` (`agent.py:1321`), `MAX_SEARCH_MATCHES = 50` |
| Clarifying question mid-run | `ask_user` tool → `ask_user_question` (`agent.py:408`) / `resolve_pending_question` (`agent.py:398`) |
| Approval gating | `wait_for_approval` (`agent.py:453`), `onApprovalRequest` |
| Per-project durable notes | `.agent-rules.md` (user-owned, read-only) / `.agent-memory.md` (agent-written, deduped) — `services/project_rules.py` |
| Per-user memory | `memory.py`, `data/memory/<user>.json` |
| Source attribution in UI | `onSources` sink → `sources` SSE event → Sources list + persisted with the message |
| Event timeline | `services/session_log.py` (`SESSION_EVENT_TYPES`) → `TrajectoryView.tsx` (`EVENT_STYLES`) |

**Gaps in 0.12.0 that ALC must fill:** no chunker, no index, no vector store, no `/api/embed`
usage, no documentation corpus concept anywhere in the repo.

---

## 3. Decisions (agreed)

Each decision lists the alternatives that were considered and rejected.

### D1 — Cycle shape: in-loop controller, software-bounded
Repeat **gather → judge → act** rounds. The model emits an explicit structured
`enough / need more` decision each round; software owns the caps (cycles, tool calls, tokens,
wall-clock) with a hard cap that forces the acting phase.
*Rejected:* one-shot pre-pass (not adaptive); fixed software-driven cycle count (ignores what was
found); diminishing-returns heuristic only (no model judgement).

### D2 — Scope: orthogonal toggle in both Chat and Koding
Normal | ALC is independent of Chat | Koding. ALC overlays whichever engine is running; Normal is
today's behaviour unchanged.
*Rejected:* ALC as a third top-level mode (loses the chat/coding engine distinction); Koding-only
or Chat-only for 0.13.0.

### D3 — Decision-maker: structured JSON with software fallback
The controller asks the model for a **small JSON decision**, repairs/parses it (reusing the
parsing and repair helpers already present in `agent.py`), and falls back to software heuristics
when parsing fails or the model is too weak. Weak-model degradation is a normal path, not an error.
*Rejected:* software decides everything (model only reads/writes); require a capability-probed model.

### D4 — Context: software-managed scratchpad, re-projected each round
The controller owns a scratchpad — goal, open questions, findings (with source), rejected items,
gaps, budget — and renders the prompt from it each round. Raw tool output is summarized into a
finding and evicted in the same round it was fetched.
*Rejected:* reuse the message history plus existing pruning (blind growth, no selection);
hybrid retaining raw evidence (heavier prompts, weaker selection pressure).

### D5 — Triage: model judges, software caps
The model scores retrieved chunks keep/drop with a reason (batched, one call per retrieval);
software enforces per-finding size caps, total budget, dedupe and source diversity, and records
rejections as metadata.
*Rejected:* heuristic-only prefilter with no model judgement; heuristic filter then model rerank
(fewer model calls, but poorer retention of surprising-but-relevant content).

### D6 — Source selection: model picks from a curated ALC tool set
ALC exposes a dedicated tool set (`docs_search`, `docs_open`, `knowledge_search`,
`knowledge_write`, `web_search`, `read_url`, project files in Koding). The model chooses per open
question; software can **veto** (no search key configured, off-budget, disabled by settings) and
records every decision. This is the mechanism that enforces "only search the web when necessary".
*Rejected:* controller proposes / model confirms (extra round-trip); software routing only.

### D7 — Docs index: SQLite FTS5 over user-configured folders
`sqlite3` + FTS5 (stdlib — **no new dependencies**): BM25 ranking, snippets, markdown-aware
heading paths so a "pygame" query hits the pygame section of a 10k-word file and nothing else.
Incremental rebuild by mtime/hash; lives in `DATA_DIR`.
*Rejected:* on-the-fly scan (slow on large corpora); embeddings via Ollama `/api/embed` (needs an
embedding model + RAM; kept as an optional future rerank layer).

### D8 — Project knowledge: `ALC/knowledge/*.md` + `index.json`
Human-editable markdown notes plus a machine index (`id`, `kind`, `topic`, `tags`, `source`,
`createdAt`, `updatedAt`, `bytes`) used for retrieval and dedupe. The knowledge tools report "no
project" instead of erroring.

**Amended in Phase 4 — the gate is the working DIRECTORY, not the mode.** This was Koding-only
("Chat has no project directory"), but a chat conversation with a workspace attached does have one,
and excluding it meant chat could gather, answer and keep nothing: every later turn re-searched the
same facts, so the cycle never compounded. `ALCToolContext.knowledge_enabled` is now just
`bool(workspace)`. A turn with no directory still gets no knowledge tools.

*Rejected:* append-only JSONL (machine-first, unreadable); single `knowledge.md` (weak structure);
extending `.agent-memory.md` (mixes two different lifecycles — the agent's own lessons vs.
ALC's retrieved facts).

### D9 — Write-back: model writes the study, software verifies it
After a cycle the controller promotes the kept findings into project knowledge; the model may also
call `remember` for something specific. Dedupe by topic/source before writing.

**Amended in Phase 4 — the roles are split, not assigned to one side.** D9 originally had software
nominate and store raw excerpts, on the grounds that a 1.7B's judgement is unreliable — which was
right about judgement and wrong about the outcome: an excerpt stores what was *searched*, not what
was *learned*, and a later turn still has to do the reasoning again. Now the model writes a
structured **study** per topic and software refuses every line it cannot ground in the gathered
passages (`app/alc/study.py`, §4.7). The original mechanism is kept as the fallback and as the
`alcStudy: false` configuration, so a failed generation still leaves the fact behind.
*Rejected:* model-decides-only (sparse); auto-write with user confirmation (adds a prompt to every
knowledgeable turn).

### D10 — Visibility: streamed `alc:*` events in the existing timeline
New SSE event types rendered in the timeline / TrajectoryView and written to the session log when
in Koding. ALC bookkeeping never appears in the answer text. Sources keep flowing through the
existing `onSources` sink so the current Sources UI keeps working.
*Rejected:* a dedicated live panel (more UI surface for 0.13.0); reusing `stage`/`narration` only
(too coarse); end-of-turn report only (no live feedback during a long cycle).

### D11 — Failures: retry once, mark the gap, may ask the user
Reformulate and retry a failed lookup once; if it still fails, record the unresolved gap and either
state the assumption/caveat in the answer or ask the user (reusing `ask_user`) when the gap is
about intent rather than something ALC could look up.
*Rejected:* never interrupt; stop and ask immediately; skip silently (the failure mode ALC exists
to prevent).

### D12 — Model routing: add an `alc` assignment slot
`ASSIGNMENT_KEYS` (`model_assignments.py:12`) gains `alc`, defaulting to the current chat/code
model. This lets a future fine-tuned Kasalix-1.0-ALC be pinned without changing ALC logic.

### D13 — Contradictions: software decides which source is current
Two sources can state different values for the same name — a changelog and a later file, a web page
and the documentation, a project note and the documentation it summarises. Once the model is handed
both, choosing between them is a *judgement call made under prose*, and it lost the one case we can
already see (`vintra-pace`: the answer must prefer the newer file and did not). So the ordering is
software's: the documentation outranks a web page, a project note never overrules the documentation
it summarises, an undated web passage loses to anything dated (a *fetch* date is not a publication
date, and web results otherwise always look newest), and within one kind the newer date wins.
`resolve_conflicts` (`app/alc/study.py`) is the one implementation, and the briefing now states the
ordering instead of asking the model to weigh it.
*Rejected:* instructing the model to prefer the newer source (this is precisely the instruction the
`vintra-pace` answer ignored); dropping the older source silently (loses the audit trail that
`alc:conflict` exists to show).

### D14 — Honesty: the answer is verified, not merely requested
Write-back already refused model text it could not ground; the reply path did not, so a fabricated
value could be streamed to the user and then be defended by an apology. (§10 shows the baseline
inventing a value on three of fourteen questions.) The answer is now audited before release, and the
audit happens *during* the stream, because the route forwards `onChunk` verbatim and the client
appends what it receives — nothing reconciles the stream with the final message, so a post-hoc caveat
cannot stop a wrong number from being read. Concretely: the prompt lists the specifics this turn's
evidence actually contains (cheap, and most fabrications never happen), and then each unit of the
reply is checked as it is produced; a unit asserting an identifier, version, error code, path or
value-cued number that appears in no passage is released as an honest sentence naming what could not
be verified. The caveat never repeats the value it refused, so the transcript cannot carry the
fabrication even as a disclaimer, and fenced code is never gated (that is the model writing what it
was asked to write). `app/alc/verify.py` — pure, no model, no I/O.
*Rejected:* a prompt instruction alone (measured to fail on the cold carry turn); annotating after
the fact (the number has already been read); refusing the whole answer (discards what *is* grounded);
a second model call to "repair" it (an extra call to maybe fix what software can fix for free).

### D15 — Stopping: coverage ends the cycle, budgets only cap it
The cycle stopped when a budget expired, which spends twelve lookups on a one-lookup question and
still stops mid-question on a hard one. Each open question is now checked against the kept findings,
and when every one is *covered* — with at least two lookups behind it — the cycle acts. The floor
matters: a multi-hop answer usually has the fact's name in one file and its value in another, so
stopping at the first hit would guarantee a wrong answer on exactly the cases the cycle exists for.
*Rejected:* a model-judged "I have enough" (one extra call per round to save calls); stopping at the
first hit.

### D16 — Retrieval: rank and widen, so the answer does not depend on the question's wording
Recall was pure BM25 over OR'd terms with the heading column stored but never ranked, so a question
phrased in different words than the documentation failed. Now the heading path is weighted in
ranking, long terms match as prefixes, and a *thin* result set (fewer hits than asked for) is re-run
with the documentation's own vocabulary substituted for the words that matched nothing — the first
attempt is always made as written, so expansion can only add hits and a well-worded question is
unaffected. A section that hits is kept whole rather than re-chunked around the match, so the answer
is not cut off mid-fact. The judge gained verified quotes (a claimed quote that is not in the
passage cannot justify a keep), keeps contradicting passages instead of dropping one, and merges
near-duplicate chunks.

Live measurement then exposed three further gaps in the judge, all now closed — and closed in
software rather than in prompt wording, because each one is a fact rather than an opinion:

- **The judge is given the goal, not only the lookup.** A passage can answer the user's question
  without matching the sub-question the model chose to search; judged against the sub-question alone,
  evidence for the real question was filed as "off-topic" (`vintra-pace`, twice, on the shipped arm
  and on its ablation).
- **An identifier the question names cannot be judged away.** `question_anchors` reads the identifier
  shapes out of the question (`vintra_pace_default`, `QUORVEX-4513`) and a passage containing one is
  evidence by construction. Everything else stays the model's call.
- **A passage about a different named thing is not evidence.** `off_subject` refuses to file
  `halyard-config.md` (Halyard's 240) as evidence for a question about Brimwall's ceiling. This is the
  one failure the answer gate *cannot* catch — the number really is in the gathered evidence — so the
  only honest fix is not to hand it over. An unverifiable quote now also costs the citation rather
  than the passage: the passage is kept on the identifier it contains, and the reason says the quote
  could not be verified.
*Rejected:* embeddings (D7's escape hatch, and this pass adds no dependency by decision); model
query rewriting (another call, and the substitution table is derivable from the index).

### D17 — Measurement: suites and a holdout, and no comparison across fact sets
A fact set a model has already been scored on can be memorised, and a run on a *different* fact set
was silently comparable to nothing. Every report now records its **suite**, the benchmark refuses in
words to compare two runs from different suites (the same way it already refuses different fact
sets), and held-out cases exist that are reported but not tuned on. Three case kinds were added
specifically to test D13/D16 rather than to add volume: **paraphrase** (the same fact asked without
the documentation's words, which is where a vocabulary-matching arm is exposed), **distractor** (an
*older* example file states a different value for the same key), and **note_conflict** (a stale ALC
note planted in the workspace that contradicts the documentation — the family rule's whole point).
*Rejected:* one growing fact set for every run (tuning and scoring on the same questions).

---

## 4. Architecture

### 4.1 Mode plumbing

- `POST /api/chat` accepts a new boolean field `alc` (`routes/chat.py`). `ConversationMode` stays
  `chat | agent`; `alc` is persisted on the conversation record next to the other flags.
- In `run_pipeline`, the ALC branch is taken **after** model resolution, the cloud probe and the
  thinking swap — ALC inherits the existing routing decisions instead of re-deriving them:

  ```python
  if opts.get("alc"):
      return await run_alc_turn(opts)
  ```

  Everything below that line is today's behaviour, untouched.
- Frontend: a Normal | ALC segmented control in `InputBar.tsx`, built like the existing
  `planMode` / `toolPermission` pills, shown in both `ChatView` and `AgentWorkspace`; the flag is
  threaded through `useChat.ts`'s request payload (alongside `planningEnabled`, `autoApply`,
  `planMode`, `toolPermission`, `useChat.ts:630`).

### 4.2 Module layout

```
backend/app/alc/
    __init__.py
    controller.py   # run_alc_turn: cycle, caps, coverage stop, orchestration
    scratchpad.py   # Scratchpad dataclass: render(), prune(), coverage, conflict ordering
    decide.py       # structured JSON decisions: parse/repair, heuristics, the judge's software rules
    tools.py        # ALC_TOOLS table (schema + prompt examples) and dispatcher
    docs.py         # FTS5 index: build, update, ranked search, expansion, snippet extraction
    knowledge.py    # ALC/knowledge read/search/write + index.json maintenance
    study.py        # the model's study prompt + software grounding / recency / conflict checks
    verify.py       # the answer gate: what may be released, and the honest caveat when it may not
    events.py       # alc:* event emission through the existing callback pattern
```

New settings keys (`settings_store.DEFAULT_SETTINGS`, `settings_store.py:28`):
`alcDocsPaths: []`, `alcMaxCycles: 3`, `alcMaxToolCalls: 12`, `alcMaxTokens: 4000`,
`alcWebEnabled: true`, `alcWriteKnowledge: true`.

### 4.3 The cycle

```
user task
   │
   ├─ Phase 0  INTAKE      one internal call → {goal, needs_info, questions[], plan}
   │                       needs_info == false  →  off-ramp to today's answer path
   │
   ├─ Phase 1..N  GATHER   (default 3 rounds, hard cap 6)
   │     ├─ render scratchpad + available tools
   │     ├─ model returns a structured decision: a tool call OR `act`
   │     ├─ controller executes (caps, dedupe, vetoes)
   │     ├─ one batched relevance call → keep/drop + reason per chunk
   │     └─ kept → findings (with source); dropped → recorded metadata
   │                       every open question covered → `act`  (§4.10)
   │                       budget exhausted → force `act`
   │
   ├─ Phase 2  ACT         Chat  → run_chat_tool_loop with the ALC briefing
   │                       Koding → run_agent_loop with extraContext = ALC briefing
   │                       contradictions are ordered in software first, and the reply
   │                       passes the answer gate as it is produced (§4.10)
   │
   └─ Phase 3  VERIFY + WRITE-BACK
                           reuse the existing `verify` event machinery (Koding)
                           distil durable findings → ALC/knowledge (Koding only)
                           unresolved gaps → caveat in the answer, or `ask_user`
```

`run_agent_loop` already accepts `extraContext` (supplied today by `build_memory_context`), so the
Koding integration is a parameter, not a refactor.

The gather loop also *stops early* — not at a budget but at coverage — and the Phase 2 answer is
gated before any token is released. Both are software decisions about when ALC is finished, and §4.10
collects them.

### 4.4 Context management

Four context classes map onto concrete software objects:

| Class | Representation | Lifetime |
| --- | --- | --- |
| Active context | the rendered scratchpad (goal + open questions + findings + gaps) | re-built every round |
| Retrieved information | raw tool output → summarized into one finding per useful chunk | one round, then evicted |
| No longer needed | `rejected[]` / `dropped[]` metadata (source, reason) — never re-injected | whole turn, prevents refetching |
| Persistent project knowledge | `ALC/knowledge/*.md` + `index.json` (Koding only) | across sessions |

The cycle also receives a one-line list of the project's existing knowledge topics, because a
small model will not think to search a store it does not know exists.

Only three things reach the acting prompt: the user's task, the rendered scratchpad (≈4k token
budget, findings truncated ≈800 chars each) and the normal system prompt / AI rules.

### 4.5 Tools

Defined in `alc/tools.py` as `ALC_TOOLS` with both JSON schemas and prompt examples, mirroring
`AGENT_TOOL_DEFS` (`agent.py:528`) and `TOOL_JSON_EXAMPLES` (`agent.py:570`).

| Tool | Behaviour |
| --- | --- |
| `docs_search(query, k)` | FTS5 search over the indexed documentation folders; returns ranked snippets with file path + heading path |
| `docs_open(path, from_line)` | read the neighbourhood of a hit (bounded) |
| `knowledge_search(query, k)` | search `ALC/knowledge` (Koding only; "no project" in Chat) |
| `knowledge_write(topic, body, tags)` | the `remember` tool — one durable note (Koding only, deduped; refused in read-only) |
| `web_search(query)` | `search.search_web` — keeps TTL cache, retry/rewrite, `set_source_sink` |
| `read_url(url)` | reuse the agent's existing implementation |
| project file tools | reuse `search_files` / `read_file` in Koding |

These are **not** registered in the plugin tool registry (`tools/register.py`), so Normal chat
never sees them; the ALC controller dispatches them itself.

### 4.6 Documentation index

- Location: `DATA_DIR/alc/docs-index.sqlite`.
- Schema: FTS5 virtual table `(path, chunk_no, heading_path, text)` + meta table
  `(path, mtime, size, hash)`.
- Sources: user-configured folders (new ALC section in Settings) and, in Koding, the project's own
  `docs/` folder.
- Chunking: markdown-aware — split on headings first, then ~1–2k char windows with overlap; the
  heading path is stored as a searchable/filterable column.
- Update: incremental by mtime + hash; first build runs as a background task with `alc:index`
  progress events. If the index is unavailable, fall back to a scan so ALC still works.

### 4.7 Project knowledge layout

```
<project>/
    ALC/
        knowledge/
            index.json          # [{id, kind, topic, tags, source(s), createdAt, updatedAt, bytes, file}]
            <topic-slug>.md     # one file per topic, TWO layers:
                                #   # <topic>
                                #   <!-- ALC-STUDY:START -->  the study — REPLACED on rewrite
                                #   <!-- ALC-STUDY:END -->
                                #   ## <date> — <source>      notes — APPEND-ONLY, never rewritten
```

`index.json` is the retrieval/dedupe surface; the markdown files are the payload and remain
hand-editable. Each entry keeps its provenance (the documentation path or page URL) and the date it
was learned or rewritten, because a note whose source is not recorded cannot be re-checked later.
Both layers live in one file so search, dedupe and the topic listing keep working on a single
artifact. `kind` is `note` (append) or `study` (replace, one per topic).

**Turning a turn into knowledge** happens in `_learn` (controller), in two steps:

1. **A study per topic** (`study.py`). One model call per topic, capped by `alcStudyMaxTopics`
   (default 2, hard ceiling 5) and skipped entirely when the connection is unusable (the
   heuristic-only configuration has nothing to spend). The model is asked for a fixed set of
   sections — what it is, key facts, APIs and signatures, pitfalls, open questions — and software
   then does two things the model must not do itself:
   - **grounding**: every identifier, code, path, version and number in a line must appear in the
     gathered passages, or the line is dropped; a heading that carries an unsourced specific drops
     its whole section. Lines that get through are counted in the `alc:study` event, and the dropped
     ones are logged, so "what did the software refuse?" is answerable afterwards.
   - **verbatim signatures**: lines in `APIs and signatures` must appear verbatim in the passages.
     This is a second rule because the token check alone was not enough — found by reading a live
     snapshot, where a source saying "`peltarn_write_quota()` returns the number of concurrent writes
     a key may make" came back as a fabricated `def peltarn_write_quota() -> int:` block with that
     sentence as its docstring. Every token was sourced; the *form* was invented, and a fabricated
     signature is the most misleading thing a note can carry because it looks like API surface.
     Verbatim-only is deliberately blunt: a legitimately reformatted signature is lost too.
     **What this does not cover:** the prose sections (`What it is`, `Pitfalls`) are checked for
     unsourced specifics only, so they can still carry the model's commentary. The stored header
     therefore says exactly what was checked — *identifiers, values and signatures* — and names the
     prose as the model's summary rather than implying the whole note was verified.
   - **recency**: when two sources state different values for the same name, the NEWER source
     (file mtime for docs, fetch date for the web) is current, the older value is recorded under
     `## Conflicting sources`, and a line that presents the superseded value as current is dropped.
   Each study carries an `_Updated <date> from N source(s); M unsourced line(s) removed._` line and
   a `_Sources:_` line, so the next turn can see how current and how well-sourced it is.
2. **Excerpt notes** (`knowledge.remember`) for whatever the study step did not cover — a topic
   over the budget, a topic the study failed on, or every topic when `alcStudy` is false. Dedupe is
   layered, because exact-content hashing alone is not enough:
   1. the same body under the same topic is a no-op (content hash), and
   2. a body whose vocabulary is already contained in the topic's *appended notes* is a no-op too —
      a rediscovered fact comes back as a search snippet with headings and a source line around
      it, and without this check every cycle that rediscovered the same fact appended it again.
      The comparison deliberately excludes the study block: a study's vocabulary is broad by
      design, so containment against it would call almost any new fact "already stored".

**When it runs.** Never before the answer. A chat turn is intake → gather → answer → *learn* →
`alc:done`: the writing-up costs a model call, and the user's reply must not wait on it. (Koding
writes back before the agent loop, because its briefing is the agent's input — that is the one
place where learning is still on the critical path, and it is the price of facts being available to
the same run.)

Findings that came *from* `knowledge_search` are never written back (they are already there), and
nothing is written at all in a read-only session or when `alcWriteKnowledge` is off.

### 4.8 Events

New SSE types (and matching `SESSION_EVENT_TYPES` / `TrajectoryView` styles):

`alc:start`, `alc:stage`, `alc:goal`, `alc:decision`, `alc:search`, `alc:result`, `alc:finding`,
`alc:conflict`, `alc:reject`, `alc:gap`, `alc:verify`, `alc:budget`, `alc:index`,
`alc:knowledge-written`, `alc:study`, `alc:done`, `alc:notice`. The stage `alc:studying` covers the
writing-up step.

`alc:study` carries `{topic, mode: synthesised|excerpt, bullets, dropped, conflicts, sources,
refreshed, changed}` (or `reason` when it fell back to an excerpt), which is how the client can say
honestly how much of the model's note the software refused. `alc:conflict` carries `{count, names}`
for the identifiers that disagreed, and `alc:verify` carries `{enabled, blocked, claims, released}`
and fires on every gated turn — including with `enabled: false`, so a run with the check switched off
cannot be mistaken for a run where nothing needed withholding (D14).

Emission follows the existing callback pattern (`onStage`, `onNarration`, `onAgentTool`, …) passed
into `run_alc_turn` / `run_alc_gather`, and the existing `onSources` sink continues to feed the
Sources UI. Decisions carry `fallback: true` when software made the call instead of the model, and
`requested` when the model asked for something unavailable — so the client can show, honestly, which
choices were the model's.

### 4.9 Limits

| Limit | Default | Hard cap |
| --- | --- | --- |
| Gather cycles | 3 | 6 |
| Tool calls per turn | 12 | 20 |
| Scratchpad tokens | 4000 | 6000 |
| Topics written up per turn (`alcStudyMaxTopics`) | 2 | 5 |
| Bytes read per call | 200 KB | — |
| Characters per finding | 800 | — |

Every round checks the abort signal (`_check_abort`, `pipeline.py:512`) so the Stop button works
mid-cycle, and every counter is emitted via `alc:budget` for display.

Two of these are *ceilings*, not targets: with D15 the cycle normally stops when the open questions
are covered (after at least two lookups), and the budgets above are what remains for a question the
documentation cannot answer.

### 4.10 What reaches the user

Three software guarantees stand between the gathered evidence and the reply (D13–D15). Each is an
opts key — `alcConflict`, `alcAnswerGuard` — that the eval harness sets to measure the guarantee's
worth, and that nothing in the UI exposes: a user must not be able to switch off honesty.

- **Ordered evidence.** Before the briefing is rendered, contradictions among the kept findings are
  resolved in software (`Scratchpad.conflicts()` → `to_briefing()`), by the family rule in D13. The
  prompt is then given an order rather than two candidate values, and `alc:conflict` reports what was
  ordered and which identifiers were involved.
- **A coverage stop.** Once every open question has a supporting finding, and at least
  `COVERAGE_MIN_CALLS` (2) lookups have happened, the controller acts instead of spending the rest of
  its budget (§4.3). A question whose answer is spread across two files therefore never stops after
  the first hit.
- **A gated answer.** `guard_hint()` puts the specifics this turn's evidence actually contains into
  the system prompt, which stops most fabrications before they are written. `AnswerGate` then checks
  every unit of the reply *as it is produced* and releases an honest sentence in place of a unit
  asserting a specific that appears in no passage. `alc:verify` reports the result, and
  `gate.released` — not the model's raw text — is what the transcript, the stored message and the
  harness all see, so a withheld claim cannot be reintroduced by a later reconciliation step.

The gate is the only component in ALC that alters model output, and it alters it in exactly one
direction: it removes a claim no source supports. It never invents a value, never rewrites prose it
can verify, never touches fenced code, and releases a too-long unit rather than stalling the stream.

---

## 5. Frontend changes

**Phase 3 ✅ DONE.**

| File | Change |
| --- | --- |
| `components/InputBar.tsx` | `Normal \| ALC` segmented control (pills like `planMode`), rendered in **both** Chat and Koding |
| `components/ChatView.tsx`, `components/AgentWorkspace.tsx` | own the ALC state (seeded from the conversation's persisted `alc`), pass it to the hook and the input bar |
| `hooks/useChat.ts` | send `alc` in the request payload; turn `alc:*` events into timeline rows and feed `alc:stage` into the status line |
| `services/api.ts` | typed `alc:*` stream events (`onAlcEvent`), `alc` request field, ALC fields on `AppSettings`, the `/api/alc` helpers |
| `utils/alc.ts` | one place that words every ALC step (source names, budgets, gaps, notices) and drops progress-only noise |
| `components/Message.tsx` | renders the ALC rows (quiet teal rows, amber when something failed) + the four `alc:*` stage labels/icons |
| `components/TrajectoryView.tsx` | icons/colours for the seventeen `alc:*` session-log events |
| `components/AlcSettings.tsx` (new, Settings → ALC) | documentation folders, live index status + rebuild/clear, web-search and write-back toggles, per-turn budget, this project's saved notes |
| `backend/app/routes/alc.py` (new) | `GET/POST/DELETE /api/alc/index`, `GET /api/alc/knowledge` — session-protected like `/api/files`, because they report on folders on the server's disk |
| `backend/app/alc/docs.py` | `clear_index()` so the cache can be dropped from the UI |

Normal mode stays byte-identical: the toggle defaults to off, is never forced on, and with `alc`
false the client sends exactly the payload it sent before.

**Phase 4 additions to the same surface:**

| File | Change |
| --- | --- |
| `utils/alc.ts` | wording for `alc:study` (including the *"kept the excerpt instead"* row when the software refused the model's note) and `alc:studying`; the start row now says when the cycle's decisions came from the software rather than the model |
| `components/AlcSettings.tsx` | a "topics written up per turn" field (`alcStudyMaxTopics`, 0 = excerpts only), a `written up` badge per topic, and a study count in the footer; the panel copy no longer says notes are Koding-only |
| `services/api.ts` | `alcStudyMaxTopics` on `AppSettings`, `studies` on the knowledge topic/stats types |

---

## 6. Phasing

**Phase 1 — Chat-only core. ✅ DONE.** Settings keys (`alcDocsPaths`, `alcMaxCycles`,
`alcMaxToolCalls`, `alcMaxTokens`, `alcWebEnabled`) + `get_alc_settings()` with clamping; FTS5 docs
index with markdown-aware chunking and `docs_search`/`docs_open`; scratchpad; `decide.py` with
heuristic fallbacks; bounded controller + `alc:*` events; wired behind the `alc` flag in Chat mode
only (`run_pipeline` branch + `POST /api/chat` field, persisted on the conversation).
Verified end-to-end with scripted responses (90 tests) **and** against a real model (§10).

**Phase 2 — Koding integration. ✅ DONE.** In Koding, ALC gathers first and then hands its briefing
to the normal agent branch as `extraContext` (`run_alc_gather` → `pipeline` merges it with the
per-user memory), so the code model, plan mode and tool permissions behave exactly as in Normal
mode and the coding work is never duplicated. Adds the `ALC/knowledge` store with
`knowledge_search` / `knowledge_write` (the `remember` tool), software write-back, a hint in the
briefing naming the note files the agent can read, read-only enforcement, and the ALC events in the
session log (`agent.py` appends them at run start, so the trajectory shows how the evidence was
gathered). Every ALC key also round-trips through `PUT /api/settings`.

**Phase 3 — UI. ✅ DONE.** The `Normal | ALC` switch in both engines (§5), ALC steps rendered in the
reply's timeline (with the stage line showing `ALC — indexing documentation` / `ALC — gathering
information` / … while the cycle runs), the seventeen `alc:*` events styled in the trajectory view,
and a Settings → ALC tab covering documentation folders, index status with rebuild/clear, the
web-search and write-back toggles, the per-turn budget, and the notes saved for the open project.
Added the small HTTP surface those screens need (`/api/alc/index`, `/api/alc/knowledge`).

**Phase 4 — Measurement & learning. ✅ DONE.** The phase was driven by a fair complaint: after
three phases nobody could say whether the cycle *helped*, and the honest reading of the code was
that it could not have — in chat it gathered, answered and kept nothing, so nothing ever
compounded, and Normal mode already had its own web search. So this phase measured first and then
fixed the one mechanism that can compound.

1. **The eval harness** (`backend/tests/eval/`, run as `python -m tests.eval.alc_eval`): a corpus of
   invented facts in fictional libraries, run through the real pipeline over five arms
   (`normal`, `alc-none`, `alc-raw`, `alc-study`, `alc-heuristic`), scored deterministically. Its
   three measurements are `docs_gain` (is retrieval worth its latency?), `decide_cost` (does the
   model's own decide/judge layer earn its generations?) and `carry_gain` (does the store carry a
   fact into a later session?). Results in §10. The harness is also the acceptance test a
   fine-tuned Kasalix 1.0 will have to move — and the traces it collects are that model's training
   data.
2. **Chat learns** (D8 amendment). A chat turn with a workspace now writes back, after the answer.
3. **Studies** (D9 amendment, §4.7). The model writes up a topic; software grounds every line
   against the passages, resolves contradictions by source date and drops the rest. Raw excerpts
   stay as the fallback and as the `alcStudy: false` configuration.
4. **An `alcDecideModel` seam** (opts key, not a setting): an explicit `""` makes every decision
   heuristic, which is how the harness prices the decide/judge layer. Nothing in the UI can turn a
   user's deciding off.

Still open in the 0.13.x line: budget tuning, optional embedding rerank, the `alc` model
assignment (D12) for a fine-tuned Kasalix-1.0-ALC.

---

## 7. Testing

`backend/tests/test_alc_*.py` (311 tests, no Ollama and no network, plus one settings round-trip test
in `test_api.py`): the model decisions
are scripted by system prompt and the acting call is stubbed, so the tests pin the orchestration —
what is kept, what is dropped, how the loop terminates — rather than model behaviour.

Covered:

- FTS5 indexing, ranking, incremental update, snippet extraction, heading filtering.
- Chunker behaviour on a large multi-library document (the pygame-in-10k-words case).
- Scratchpad render/prune and budget accounting.
- Decision JSON parsing, repair and heuristic fallback on malformed output.
- Source vetoes (no search key, disabled, off-budget).
- Budget exhaustion forcing the acting phase.
- Knowledge write-back dedupe (exact and near-duplicate) and `index.json` integrity.
- Controller end-to-end with a scripted model: intake → 2 gather rounds → act.
- Koding: gather → briefing → `extraContext`, knowledge tools gated to Koding + a workspace,
  read-only blocking both the model's write and the automatic write-back, and the session-log hand-off.
- Cross-cycle retrieval: a note written by one cycle is found by the next one.
- Source exhaustion: an empty source is retired, the next untried source is tried, and the cycle
  acts once everything has come up empty.
- The ALC HTTP surface: session-protected, reports configured/missing folders, rebuilds on demand,
  clears the index, lists a workspace's notes, and never writes to the knowledge store on a read.
- The chat route's client contract: `alc: true` in the body reaches the pipeline, the cycle's events
  come back as their own `alc:*` SSE frames, the answer text is unaffected, and the toggle is
  persisted on the conversation (absent → off).

**Phase 4 added** 41 more (666 passing in total):

- `test_alc_study.py` — the grounding filter (unsourced values, identifiers, codes and paths are
  dropped; a heading that invents a number drops its section; list markers and years are not
  claims), the recency veto (a superseded value stated as current is removed; an honest "returns 16,
  superseding 12" survives), section assembly, and the store's two layers (a rewrite never touches
  the appended notes; an unchanged study is a no-op; a study is searchable and does not make later
  excerpts look redundant).
- The wiring: a chat turn with a workspace leaves a study behind; without a workspace it writes
  nothing; an ungrounded generation falls back to the excerpt note; `alcStudy: false` keeps the
  Phase 2 behaviour; the per-turn topic budget holds; read-only never learns.
- `test_alc_eval.py` — the harness tested, so its numbers can be trusted: the corpus fixture is
  self-consistent (every expected token is in its own sources, the conflict's superseding source
  really is newer), the scorer credits a correct answer, refuses credit for a fabricated one, does
  not confuse 12 with 120, credits honest ignorance on the unanswerable case, and ignores list
  markers and dates; and a scripted "oracle" that may only state what the pipeline put in front of
  it proves the retrieval actually reaches the answer prompt (and that the "guesser" is caught).
- `test_alc_benchmark.py` — the yardstick around the harness (`ALC_Benchmark.bat`): the generated
  fact sets are repeatable per seed, self-consistent for many seeds and different per seed; a saved
  run is read back with the metadata needed to compare it later; the summary counts the way the
  harness does (an honest admission is credit, a fabrication is not); a comparison says which way
  each metric moved **in words**, calls a regression `WORSE`, calls the control arm `normal`, and
  refuses to compare two runs on different fact sets; and the interactive menu is driven through a
  scripted stdin — an empty history, an unusable arm, an unknown fact set, a non-numeric question
  count and a failing run are all reported rather than fatal — with the whole path (menu →
  subprocess → harness → saved json → summary) covered end to end by the scripted model. Re-scoring
  is pinned in both directions: a saved honest refusal is re-credited, a fabricated one is re-marked
  `invented`, and a run that already agrees with the scorer is left byte-identical on disk.
- The **API key**, which is a claim about safety and therefore needs evidence: it is scrubbed from
  the scratch settings files (and the scrub is idempotent and leaves the other settings alone), it
  never appears in the report or in a streamed line, a key arriving as an argument is redacted by
  name, a blank answer means no web search, and the prompt is skipped rather than hanging when there
  is no terminal to read it from.
- The **graphical view** (`reports/index.html`): it is self-contained (no `http://`, no external
  `<script src>` or `<link>`, so it opens offline from `file://`), it says in words what credit
  means, it marks a run's diagnostic arms as diagnostic, it embeds the same numbers `summarise`
  computes for the terminal table, and it refuses to be empty without telling the reader what to do
  next. A run writes it automatically, so it cannot lag behind the runs on disk.
- The scorer's own judgements, against the real sentences it once got wrong: a refusal with an
  adverb ("not explicitly documented") counts as honest, an honest phrasing does **not** excuse a
  fabricated value, and ordinary prose is not mistaken for an admission.

**The quality pass added** 73 more (792 passing in total), all of them pinning software rather than
model behaviour:

- `test_alc_verify.py` — the answer gate, whose entire purpose is that no unproven specific is
  released: a unit carrying a number, identifier, version, error code or path that is in no passage
  is blocked and replaced, the caveat never repeats the value it refused, a grounded claim passes
  untouched, ordinary prose ("here are 3 things", "step 2") is not mistaken for a claim, fenced code
  and code-shaped lines are never gated, an over-long unit is released rather than stalling the
  stream, a fully withheld answer gains the closing note, and the prompt hint lists the *evidence's*
  specifics — listing the question's own words instead was a real bug this suite caught.
- The `hard` suite, in `test_alc_eval.py` and `test_alc_benchmark.py`: a paraphrase that avoids the
  documentation's vocabulary still reaches the answer prompt, the distractor's older value is the
  wrong answer rather than a rigged conflict, a planted stale note loses to the documentation it
  contradicts, the holdout cases are selectable on their own, a run records its suite, and the
  comparison refuses two runs from different suites in words.
- Conflict ordering and coverage: a note never overrules the documentation it summarises, a web
  passage does not win on its fetch date, the newer of two same-family sources wins, the briefing
  states the ordered value rather than two candidates, and the cycle acts once the open questions are
  covered — but never after a single lookup.
- Retrieval: heading-weighted ranking, prefix matching, expansion only on a thin result set,
  keeping a hit's section whole, a quote that must appear in its passage to justify a keep, and
  near-duplicate chunks merged.
- The ablation arms (`alc-noconflict`, `alc-noguard`) exist so each guarantee is measured alone, and
  the scripted `guesser` now shows a fabrication being *stopped* rather than annotated: the guard's
  win is counted in fabrications prevented, because the scorer only credits an admission on a case
  that has no answer by design.
- The judge fixes, each from a live failure rather than a hypothesis: the prompt carries the goal *and*
  the lookup (a passage answering the real question is not filed as off-topic), an identifier the
  question names cannot be judged away, an unverifiable quote loses the citation and keeps the
  passage (with the reason saying so), and a passage about another name (`Halyard` for a `Brimwall`
  question) is refused as evidence — while a question that names nothing, or a passage that names
  nothing, is left alone.

Existing baseline to preserve: `backend/tests/` (784 passing in total). Normal-mode behaviour must
stay byte-identical when `alc` is false. The frontend is verified by `npx tsc --noEmit` and
`npx vite build` — there is no frontend test runner in this project, so the UI logic that could
regress (the step wording in `utils/alc.ts`) is deliberately a pure function with no React in it.

---

## 8. Risks and open items

- **Weak-model reliability** — measured: qwen3:1.7b answers the intake and action prompts with
  parseable JSON (no fallback needed in the live runs), and judges relevance correctly (it dropped
  an off-topic passage unprompted). The observed failure mode was not malformed JSON but **example
  echoing** — it returned the action prompt's sample query verbatim. See §10; the guards are in
  place, but this is the class of bug to expect from small models.
- **Retrieval quality** — partly addressed by D16 (heading weighting, prefixes, expansion on thin
  results, sections kept whole), but search is still lexical: a question that shares *no* vocabulary
  with the documentation still misses, and the expansion table is finite. The `paraphrase` case is the
  honest test, and the embedding rerank (D7) remains the escape hatch.
- **Index staleness** — configured folders change outside the app; the mtime/hash rebuild handles
  it, but a large first build needs progress feedback (`alc:index`).
- **Prompt-time cost** — an ALC turn costs more model calls than Normal; the intake off-ramp and
  budgets are what keep trivial turns cheap, and D15 stops paying for lookups that are no longer
  needed. **Measured in Phase 4**: the cycle as shipped cost ~7 model calls and ~4.3 s per turn
  against ~2 calls and ~1.1 s for Normal, and most of that difference bought nothing the software
  heuristics did not already do (§10). The cheapest configuration — `alcDecideModel: ""` — scored
  *better* on the harness, which is why the next step is a product decision about the default rather
  than more orchestration.
- **Invention with no evidence** — *addressed by D14 and now measurable*: the harness caught both
  cold carry turns inventing a concrete value ("typically set to 1000 operations") when the store was
  empty, and the gate is what now stops that sentence from being released. What remains open is the
  re-measurement: the cold-control carries must be re-run to confirm the fabricated value is gone
  from the *stream* and not merely from the stored answer, and the `alc-noguard` ablation exists to
  show the difference rather than assert it.
- **The gate is a pattern matcher** (open) — it recognises specifics by shape and by a value cue next
  to a number, so a fabrication phrased as vague prose ("quite large", "a few hundred") is neither
  caught nor wrong-looking, and a legitimately dense answer has more units to check. The honest claim
  is "no unproven *specific* is released", not "the answer is verified true"; the harness measures it
  in fabrications, which is the failure that matters.
- **The gate checks presence, not pertinence** (open) — a specific that appears anywhere in the
  gathered evidence is "grounded", even if it belongs to a different key or a different section. The
  measured instance (Halyard's 240 stated as Brimwall's ceiling) is now prevented earlier, because the
  passage about the other library is refused as evidence (`off_subject`) — but a wrong value from a
  passage that *is* about the right thing would still pass. Closing that properly means checking the
  claim, not the token, and it is the largest honesty gap left.
- **The web family rule is conservative** (open) — D13 needs a source *kind*, which comes from the
  tool that fetched the passage, so a genuinely newer web page loses to an older local file. That is
  the deliberate direction (a wrong local fact is a documentation bug; a wrong web fact is the failure
  ALC exists to prevent), but it is a real limitation, not a solved problem.
- **Coverage is a heuristic** (open) — `covered()` judges support by how much of a question's
  distinctive vocabulary a finding repeats, so a passage that shares words without answering can end a
  cycle early. The `COVERAGE_MIN_CALLS` floor and the `distractor` case are guard rails, not a proof.
- **The subject rule is a heuristic too** (open) — it only fires when the question *names* something
  (a question like "what is the retry window?" gets no filtering at all), it never filters a passage
  that names nothing, and a title's first word can be read as a name (`index.md` reads as "Documentation",
  so a general index file can be refused for a question that names a specific library). Those are the
  three known ways it can be wrong, and both directions are what the `distractor` and `note_conflict`
  cases measure.
- **Corpus questions are well-formed** (open, narrowed) — the historical `core` cases still use the
  documentation's own vocabulary, so on `core` a "just search the question" arm is flattered and those
  numbers are a floor. The new `hard` suite exists for exactly this: a paraphrase that shares none of
  the documentation's words, a distractor whose value is plausible and wrong, and a planted note that
  contradicts the file it summarises. `core` results should still be read with the caveat attached.
- **Carry is a small sample** — two carry cases, one model, one machine, one run. The direction
  (nothing → something) is solid; the ranking between study and excerpt notes is not yet.
- **Held-out cases are few** — two (a poisoned note and an absent-value paraphrase), so the holdout
  can flag a regression but cannot rank two close configurations. It is a start on not tuning on the
  test set, not a substitute for one.

---

## 9. File map

```
backend/app/alc/__init__.py      public surface: run_alc_turn, run_alc_gather, emit_alc, emit_alc_notice
backend/app/alc/controller.py    the cycle: intake -> bounded gather -> act (chat) / brief the agent (Koding)
backend/app/alc/decide.py        the three structured decisions: parsing, heuristic fallbacks, and the judge's software rules (anchors, subjects, verified quotes)
backend/app/alc/scratchpad.py    bounded working memory (findings, rejects, gaps, queries, knowledge)
backend/app/alc/docs.py          FTS5 index, markdown-aware chunking, safe file reads, self-healing
backend/app/alc/knowledge.py     ALC/knowledge store: search, remember, write_study, dedupe, topics
backend/app/alc/study.py         the model's study prompt + the software grounding/recency/conflict checks
backend/app/alc/verify.py        the answer gate + the prompt hint listing what the evidence supports
backend/app/alc/tools.py         the curated tool set + dispatcher + index maintenance
backend/app/alc/events.py        alc:* event vocabulary and emitter
backend/app/routes/alc.py        HTTP surface for the UI: index status/rebuild/clear, project notes
backend/tests/test_alc_*.py      311 tests (docs, knowledge, study, verify, scratchpad, decide, controller/routing, routes, eval, benchmark)
backend/tests/eval/              the measuring harness: corpus, scoring, runner, benchmark, README
backend/tests/eval/reports/      its output: <label>.md (readable), <label>.json (diffable), index.html (the view)
ALC_Benchmark.bat                (new) the double-clickable benchmark menu: run / view / review / compare
```

Frontend (Phase 3):

```
frontend/src/utils/alc.ts                 (new) wording for every alc:* step, one pure function
frontend/src/components/AlcSettings.tsx   (new) the Settings → ALC panel
frontend/src/components/InputBar.tsx      Normal | ALC switch (Chat and Koding)
frontend/src/components/ChatView.tsx      owns the chat conversation's ALC state
frontend/src/components/AgentWorkspace.tsx owns the Koding session's ALC state
frontend/src/components/Message.tsx       ALC timeline rows + alc:* stage labels
frontend/src/components/TrajectoryView.tsx styles for the alc:* session-log events
frontend/src/components/UserSettingsModal.tsx the ALC tab
```

Wiring: `settings_store.py` (seven ALC keys + `get_alc_settings`), `routes/settings.py` (allowlist),
`routes/chat.py` (`alc` field, persisted on the conversation, `onAlcEvent` → SSE), `pipeline.py`
(the ALC branch, after model resolution; Koding gathers and falls through to the agent branch,
which receives the briefing as `extraContext`), `agent.py` + `services/session_log.py` (ALC events
recorded in the run's session log), `deps.py` (`/api/alc` added to `SESSION_PROTECTED_PATHS`),
`main.py` (router registration).

## 10. What live testing revealed

Run against `qwen3:1.7b` with a documentation folder containing one invented fact
(`zorb_set_pace`, default 12 frames) that the model cannot know from its weights:

- **It works.** Intake produced three real questions, the model chose `docs_search` with its own
  query, judged the relevant passage in and the off-topic passage out, and the answer was
  `zorb_set_pace` / 12 frames — in two cycles, one tool call and ~5 s.
- **Bug found: example echoing.** With a realistic sample query in the action prompt, the model
  returned that sample verbatim as its own query and the cycle reported a fake lookup. Fixed by
  using `<angle-bracket>` placeholders in every example, detecting an echoed placeholder, and
  substituting the open question.
- **Bug found: argument defaults.** `make_args` filled a missing primary argument (the query) from
  the tool's example. The primary argument is now never defaulted.
- **Termination signal.** A model that repeats a lookup it already tried is treated as finished
  once evidence exists (it was previously allowed to burn the whole budget re-requesting).
- **Bug found (unit tests):** an empty string in `alcDocsPaths` resolved to the process working
  directory and would have indexed all of `backend/`.
- **Not yet exercised live:** web search through ALC (needs a provider/key), the answering prompt
  when nothing was retrieved (the model hedged rather than plainly saying it could not check — a
  prompt-strength issue worth revisiting), and turns where the acting phase itself calls a tool.

### Phase 4 — what the harness measured

`python -m tests.eval.alc_eval --arms normal,alc-none,alc-raw,alc-study,alc-heuristic`, qwen3:1.7b,
14 cases (12 single/multi-hop/conflict/absent + 2 carry), documentation folders on, web search off
(no provider key). Credit = answered correctly **or** said plainly it could not find it.

| arm | credit | correct | admitted | invented | ttft p50 | turn p50 | model calls |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `normal` | 7% | 0/14 | 1 | 4 | 0.72 s | 1.14 s | 2.0 |
| `alc-none` (gathers, keeps nothing) | 86% | 11/14 | 1 | 0 | 4.22 s | 4.35 s | 7.0 |
| `alc-raw` (excerpt notes) | 86% | 11/14 | 1 | 0 | 4.18 s | 4.35 s | 7.0 |
| `alc-study` (written-up notes) | 79% | 11/14 | 0 | 1 | 4.15 s | 6.05 s | 8.0 |
| `alc-heuristic` (software decides) | **93%** | **12/14** | 1 | 0 | **0.36 s** | **0.51 s** | **1.0** |

Carry — the same follow-up asked in a fresh conversation with the documentation removed, once with
the store kept and once with it wiped:

| arm | facts recalled, store kept | facts recalled, store wiped | credit, store kept | credit, store wiped |
| --- | --- | --- | --- | --- |
| `alc-none` | 0% (nothing was ever written) | 0% | 0% | 0% |
| `alc-raw` | 58% | 17% | 0% | 0% |
| `alc-study` | 75% | 17% | 50% | 0% |
| `alc-heuristic` | **100% / 100%** | 17% | **100%** | 0% |

Before this phase, every arm's carry was 0% — in chat the store was never written at all, so there
was nothing to carry and no way for a cycle to improve over time.

**These tables are the re-scored numbers, and the difference matters.** The reports in
`tests/eval/reports/` were produced before a live run exposed a scoring bug (§10, below), and a
verdict is a judgement by a version of the scorer rather than a fact about the answer. `--rescore`
re-applies today's scorer to the stored answers, so the whole history sits on one rule. It moved
`alc-none` and `alc-raw` from 79% to 86% and `alc-heuristic` from 86% to 93%: three arms had been
denied credit for a perfectly honest "that is not documented here". `alc-study` was unaffected —
its one failure really is a fabricated value.

What the numbers say, in order of how much they matter:

1. **Retrieval works and it is the entire win over Normal** (+72 to +86 points), and it is the only
   thing that fixes Normal's other failure: it invented four values on invented facts, because with
   no source it answers from its weights. The `absent` case shows the complementary behaviour: with
   a source available and nothing in it, the cycle says so instead of guessing.
2. **The store now compounds.** Facts written in one turn are recalled in a later session with the
   documentation gone, which was 0% before.
3. **The model's own decide/judge layer is a net negative on this corpus**: one *fewer* correct
   answer than the cheap arm, 7× the latency and seven extra generations, and *lower* credit
   (86% vs 93%). The heuristic judge keeps up to four passages by term overlap while the model's
   judge keeps fewer, so more evidence reaches the writer — but the honest reading is the cost
   line, which needs no interpretation. **Caveat:** every corpus question is phrased in the
   documentation's own vocabulary, which flatters a strategy of "search the question as asked" and
   makes a vague real request the case to test next (§8).
4. **Writing up is legible, and the model obeys the grounding rule.** The live studies came back
   `ok=True bullets=3..5 dropped=0` — the 1.7B produced sectioned, sourced notes and did not try to
   invent values, so the software veto was mostly a guard rather than a repair. When it did fail
   (an ungrounded study in the tests), the excerpt fallback kept the fact.
5. **The 1.7B is unreliable when there is no evidence at all** — the cold turns invented a concrete
   value rather than saying they could not know. Same gap as the first live run.

**Noise to ignore:** `alc-study`'s single invented first-turn answer is not caused by studies (the
study is written after the answer, and `alc-raw` answers with the same evidence); it is the model's
run-to-run variance. One run of 14 cases cannot separate a 7-point difference from variance, which
is exactly why the deltas in one run are the result and the totals are not. The margin between
`alc-heuristic` (93%) and `alc-none`/`alc-raw` (86%) is exactly one case, so read it as "the
software heuristics are not worse", not as "they are better".

### A scoring bug found by reading a live run

Running three cases against `qwen3:1.7b` and then reading the stored answers — rather than only the
table — turned up a defect in the harness itself. The cycle answered the unanswerable case with:

> The default value of `brimwall_set_ceiling()` is not explicitly documented in the provided sources.

That is honest and correct, and `wrong`. `_ADMISSION_RE` required the literal phrase "not
documented", and "not **explicitly** documented" does not contain it, so the scorer denied credit
for a refusal it should have recognised. The rule now allows a couple of adverbs (and a few
auxiliaries: isn't, didn't, hasn't) between the negation and the verb, which cannot hide a
fabrication: an invented value is checked first and still outranks admission, and there is a test
for exactly that ("not documented here, but it defaults to 42 frames" is still `invented`).

The lesson generalises beyond the regex: **an automated verdict is a claim, and reading the answers
is how you find out whether the claim is true.** Every number in the tables above is now asserted
by a scorer that has been checked against the real sentences it misjudged.

### The one-button test, and the API key

The menu's first option (and `ALC_Benchmark.bat --full`) is *everything on*: every question in the
fact set, documentation folders configured, web search as well, measured ALC off against ALC on,
named as the next version in the series, with the graphical view rewritten at the end.

Web search needs a Tavily key, and the key is asked for **every time and never saved**. That took
some care to be true rather than aspirational:

- it is read with hidden input, so it is not echoed to the screen or into scrollback;
- it reaches the run in the child process's **environment**, not on its command line, because a
  command line is readable by anything that can list processes;
- it is **redacted from the report** (`"usedTavilyKey": true` records that one was used, and the
  key itself is replaced by `(used, not saved)` if it ever arrives as an argument);
- it is **scrubbed from the run's scratch settings** as soon as the run ends — the app can only read
  it from a settings file, and a run's settings file lives in a temp directory that deliberately
  outlives the process, so leaving it there would be leaving a key on disk;
- and it is stripped out of anything printed, because a traceback that dumps a settings dict would
  otherwise carry the key into the console.

One defect found by testing rather than reading: **`getpass` on Windows reads the console, not
stdin**, so a piped or headless run blocked for ever waiting for a keypress that could never come.
The prompt is now skipped when there is no terminal, with a line saying how to pass the key instead.

### The harness as a yardstick (`ALC_Benchmark.bat`)

A measurement nobody can repeat is an anecdote. `tests/eval/benchmark.py` (launched by
`ALC_Benchmark.bat` in the repository root, or `python -m tests.eval.benchmark`) turns the harness
into a benchmark with history: run a new test, see it in a browser, look at previous results, or
compare two runs, with **nothing ever overwritten** — a label that already exists gets a numbered
suffix.

**Two corrections came from using it, and both were design mistakes worth recording.**

*Five arms was four too many.* The first version measured `normal`, `alc-none`, `alc-raw`,
`alc-study` and `alc-heuristic` on every run, which is a table with five rows and four names nobody
can remember. The arms exist to isolate one variable each — useful while the cycle was being built,
useless as a result. A run now measures `ALC off` (the baseline) and `ALC on` (the cycle as it
ships), so each run is **one number with a reference point to read it against**, which is exactly
what comparing two generations of the model needs. The diagnostics are still runnable by name and
are labelled "diagnostic arm" in the view rather than being put in front of the reader. The ids
(`normal`, `alc-study`, …) did **not** change, so every report already on disk still loads and
still means what it meant.

*Names count up.* Every run is the previous version plus one (`ALC v2` → `ALC v3`), which the
runner offers by default, so the series is its own changelog instead of a folder of names somebody
invented at the time. An unversioned or differently-prefixed run (`phase4`, `kasalix-1.0`) never
resets the count. The name doubles as the filename and is cleaned of characters a filesystem will
not take, while case and spaces survive so it still reads like a name.

*The terminal table was the wrong interface.* `reports/index.html` is now written on every run: one
bar per run with the credit for the arm it is about, the baseline as a thin grey mark on the same
bar, a red "made up: N" pill when a run invented values, a click-through to that run's full table,
and a comparison you can drive with two dropdowns. It is a single self-contained file — no server,
no CDN — so it opens offline by double-click, which is the point. The numbers are computed in
Python by the same `summarise` the terminal tables use, then embedded as JSON, so the picture and
the text cannot disagree.

Two things make the comparison trustworthy rather than decorative:

- **Every run is tagged** with what it was measuring (`alc-0.13.0`, `kasalix-1.0-lora`, any free
  text), so a later generation of the model is comparable to an earlier one without archaeology.
- **Every metric states its own direction in words** (`credit 79% -> 86% (better)`, `invented 1 -> 0
  (better)`), and a run on a **different fact set refuses to compare** — otherwise the table would
  invite a difference in the fixtures to be read as a difference in the code. Timing deltas under
  0.05 s and credit deltas under 2 points print as `same` on purpose, and `normal` — which runs no
  cycle at all — is labelled the control, because any movement there is model variance and it sets
  the noise floor for the other rows.
- **History can be moved onto one rule** (`--rescore <label>|all`). A saved run keeps the *verdict*,
  not only the answer, so when the scorer changes every older run silently means something slightly
  different and comparing it to a new one compares two rules. Re-scoring recomputes the verdicts
  from the stored answers and rewrites the report, so a fixed scorer does not orphan the past —
  including the date it ran, which is captured before the rewrite rather than read back off the
  rewritten file afterwards.
- **The view opens itself**: a run writes `index.html` and the menu offers the browser, because a
  dashboard that lags behind the runs on disk is worse than no dashboard.

**Fresh facts per run** (`--variant <seed>`) close the obvious hole in a fixed fixture: once a
generation has been scored on `classic`, it could pass a later run by memorising the fixture rather
than by retrieving. A seed derives brand-new libraries, identifiers, defaults, error codes and paths
covering all five question kinds; the same seed is always the same benchmark.

Recording the result surfaced two defects in the launcher itself, both found by running it rather
than reading it: `where .venv\Scripts\python.exe` does **not** resolve a relative path, so the
wrapper refused to start with the venv sitting right beside it; and `find /i "/c"` (used to decide
whether to keep the window open after a double-click) picks up an msys/Git-Bash `find` off `PATH`
and walks the whole drive. Both are fixed — the venv is checked with `if exist`, and the Windows
`find.exe` is called by absolute path.

### ALC v2 — the reference measurement

The first full 14-case run under the settled interface, kept as the number later versions are read
against (`reports/ALC v2.md`, `qwen3:1.7b`, documentation on, web off, 36 turns):

| arm | credit | correct | admitted | invented | ttft p50 | turn p50 | model calls | carry kept / wiped |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ALC off` | 7% | 0/14 | 1 | **3** | 0.71 s | 1.06 s | 2.0 | 17% / 17% |
| `ALC on` | **86%** | 11/14 | 1 | **0** | 3.93 s | 5.88 s | 8.5 | 83% / 17% |

Three things worth reading off it:

1. **+79 points over the baseline, and zero fabrications against three.** The baseline invented a
   value on three of fourteen invented-fact questions — it has no source, so it answers from its
   weights. That is the failure the cycle exists to prevent, and it is the number that matters more
   than the credit gain.
2. **The store carries 83% against 17%.** The cold control (same turn, store wiped) invented a
   value in both carry cases — `1000` and `60`, neither of which is documented anywhere. With the
   store kept, the same turn stated only what it actually had. The absence of notes is what makes it
   guess, which is the clearest argument yet for writing them down.
3. **One real retrieval miss: the `vintra-pace` conflict.** Two sources disagree (an older changelog
   says 12, a newer file says 16); the answer must prefer the newer and it did not. That is a
   specific, reproducible defect rather than variance, and it is the next thing to investigate.

The remaining two non-perfect first turns are honest: `brimwall-absent` said plainly it could not
find a value that is documented nowhere (credited), and `peltarn-carry`'s first turn got two of its
three facts.

### The quality pass — what it is worth, and how it is proven

The ALC v2 numbers name the work: 86% credit with zero fabrications on `core`, one reproducible defect
(`vintra-pace`), and a baseline that invents a value rather than admitting it has none. The quality
pass (D13–D17) attacks those three. Every piece lands as an **ablation arm** before it is folded into
the shipped `alc-study` arm, because "several things changed and the number went up" is not a
measurement:

| arm | what it switches off | the question it answers |
| --- | --- | --- |
| `alc-noconflict` | ordering contradictions in software (D13) | does the family rule fix `vintra-pace`, or did the model already have it? |
| `alc-noguard` | the answer gate and its prompt hint (D14) | how much of "zero fabrications" is the gate, rather than a better prompt? |
| `alc-heuristic` | model-decided gathering (D3) | is a coverage stop better than spending the budget? |
| `alc-none` / `alc-raw` | write-back / study synthesis | unchanged from Phase 4; the carry arms are now also read on `hard`. |

The run that decides the pass is a full one on `core` + `hard` with a fresh `--variant` seed, so a
memorised fixture cannot flatter it, plus the held-out cases looked at once at the end. It is folded
in only if, on the same facts and the same model: the conflict and the distractor are answered with
the **newer** value; the fabricated value is gone from the **streamed** text on both cold carry turns
(the gate has to change the stream, not just the stored message); the poisoned note loses to the
documentation; the paraphrase is retrieved at all; and credit on `core` does not fall. Anything that
fails its own arm is not kept — a quality pass sometimes honestly ends smaller than it started.

Two things about the instrument were tightened for this, because a number is only worth what the
instrument measuring it is worth:

- **The suite is recorded.** A report made before suites existed is a `core` run, and the comparison
  view refuses two runs from different suites the same way it refuses different fact sets — a
  paraphrase case is a different question, and printing a delta between them would be a lie told in
  numbers.
- **The failure stage is recorded.** Every losing turn is classified as `no-cycle`, `no-lookup`,
  `retrieval-miss`, `judge-drop`, `conflict`, `unsupported-claim`, `empty-answer` or `error`, derived
  from the events the turn already emitted. A single falling score says something regressed; the stage
  says which part of the cycle to open.
- **What the turn did is recorded too.** Each row keeps the searches (`queries`), the relevance
  judge's own reasons for what it discarded (`rejects`) and what the answer gate refused to release
  (`withheld`). Without `rejects`, `judge-drop` named a symptom and nothing more — with it, a single
  saved report named the passage *and* the reason, which is how the judge defects above were found.

Running it (`qwen3:1.7b`, documentation on, web off — one run, one model, the same machine):

| measurement | before this pass | after |
| --- | --- | --- |
| `vintra-pace` (the defect above), shipped arm | wrong | **correct (16)** |
| the same case, `alc-noconflict` ablation | — | wrong (**12**), stage `conflict` |
| `hard` suite (4 cases, shipped arm) | 75% credit, **1 invented** | **100% credit, 0 invented** |
| `brimwall-paraphrase-absent` (held out) | invented `240` — Halyard's value | **admitted** — "not available in the provided information" |
| four `core` cases naming a subject, incl. multi-hop | — | 4/4 correct (no regression from the subject rule) |

The `hard` suite is the interesting one, because each case was built to fail a specific way and all
four now pass for the *right* reason: the paraphrase is retrieved without the documentation's
vocabulary (D16), the distractor's older value loses to the reference (D13), the planted stale note
loses to the file it summarises (D13), and the absent value is admitted rather than guessed (D14 +
`off_subject`). The ablation result on `vintra-pace` is the cleanest evidence in the project so far
that a guarantee is load-bearing: identical retrieval, one software rule switched off, and the answer
goes from 16 to 12.

### Phase 2 (Koding) live findings

The two-cycle demonstration — a fact that exists only in a documentation file, then the same
question after that file is deleted:

- **Cycle 1** (~5 s): asked `knowledge_search` (empty store) → the source was retired → switched to
  `docs_search` → found the fact → briefed the agent (777 chars) → wrote one note to
  `ALC/knowledge/pacing.md` with its source path and date.
- **Cycle 2** (~2.5 s, documentation deleted): asked `knowledge_search` → found
  `knowledge:pacing` → briefed the agent with the fact (925 chars) → wrote nothing new.

Bugs the live runs exposed, all now fixed and covered by tests:

- **Deleted documentation kept answering.** `docs_search` served rows from the FTS index for files
  that no longer existed — the index is only rebuilt on a TTL, so a deleted file stayed quotable for
  minutes. Hits whose file is missing are now dropped and trigger a self-healing rebuild, and the
  TTL that governs *added* files is documented instead of being a silent correctness hole.
- **Queries were deduped globally.** The same question could never be asked of a second source,
  which is exactly how a cycle that missed the documentation answer failed to find the same fact in
  project notes. Query memory is now per source.
- **The model stuck to an empty source.** After a failed lookup it re-asked the same tool until the
  budget ran out. A source that comes up empty is now retired and the controller falls back to the
  next untried source (software carrying the load — D3), marked `fallback: true` in the events.
- **Write-back near-duplicates.** Re-writes are suppressed by the containment check in §4.7.
- **Misleading decision events.** When the model asked for an unavailable tool, the fallback
  overwrote the event's reason with the model's words, so an `act` decision read like a search. The
  model's request is now reported alongside the fallback rather than replacing its reason.
- **A write could receive a `query` key.** `PRIMARY_ARGS` did not cover the knowledge tools, so the
  placeholder substitution would have injected a query argument into `knowledge_write`.
- **Still open:** a document *added* after an index build is only searchable after the next refresh
  (≤ 60 s), and the coding agent has no ALC tools of its own — it is pointed at the note files and
  reads them with `read_file`.

### Phase 3 (UI) notes

Decisions the UI work forced, all of them about telling the truth without adding noise:

- **The toggle must be seeded from the conversation.** The server persists `alc` per conversation
  (`routes/chat.py`), and a request that omits it means *off* — so a client that mounted with a
  hard-coded `false` would silently switch a conversation back to Normal. Both views now start from
  the stored flag, because the stored flag is authoritative.
- **Two ALC events are deliberately invisible.** `alc:stage` drives the status line
  (`ALC — gathering information`), and `alc:index` emits a progress tick every 25 files; rendering
  either as a timeline row would bury the answer. `describeAlcEvent` returns `null` for both, and
  the stage icons/labels had to be registered explicitly — the status line matches stages by
  longest prefix, so an unregistered `alc:…` stage reads as a generic "Processing".
- **Unknown events must be ignored, not rendered.** The stream handler switches on the type and only
  accepts the `alc:` prefix, so a future step's payload can never be mistaken for answer text or
  crash an old client — it simply does not appear until the UI knows it.
- **Events are one vocabulary, not one endpoint per step.** `alc:*` travels over the existing chat
  stream, so the only new HTTP surface ALC needed was for the Settings screens (`/api/alc/index`,
  `/api/alc/knowledge`) — and those are session-protected because they name and count files on the
  server's disk.
- **The project-notes panel needs a workspace.** That view is bound to the open conversation's
  folder, so in Chat (there is no workspace) the panel is simply absent rather than empty-looking.
- **Wording lives in one pure function.** `utils/alc.ts` turns a payload into a label/detail pair;
  it has no React and no fetching, which is the only part of the UI a test could pin later without
  adding a frontend test runner.
- **Keys have exactly one home: the host app.** There is no Tavily field in the client, and none can
  be sent from it — the ALC panel only *reports* whether the server app has a key, so a switched-on
  web search does not look silently broken. A client that could write the key could also blank it for
  every other client on that server; the key belongs to the machine, not to a window. (The benchmark
  launcher is the third case and is deliberately different again: it asks for a key per run, passes it
  in the child's **environment** rather than its command line, and never saves it — §10.)

## 11. Long-term: Kasalix 1.0 / 2.0

ALC is designed so that future fine-tuned models can *cooperate* with it rather than replace it:

- **Kasalix AI 1.0** — text, reasoning, tools, ALC cooperation (Qwen3 base, QLoRA).
- **Kasalix AI 2.0** — adds vision (vision-capable Qwen base, QLoRA).

The `alc` model-assignment slot exists so a cooperating model can be pinned when it ships, while
0.13.0 validates the orchestration with stock models on consumer hardware.
