# ALC — Advanced Learning Cycle (v0.13.0 design)

**Status:** design agreed; **Phases 1–3 implemented** (chat core + Koding integration + UI) —
see §9 for the file map and §10 for what live testing against qwen3:1.7b revealed. Phase 4
(tuning against the real model, optional embedding rerank, the `alc` model assignment) is open.
**Target:** v0.13.0, working with the current stock models (e.g. Qwen3 1.7B).
**Version of this document:** 2026-09-27

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
Human-editable markdown notes plus a machine index (`id`, `topic`, `tags`, `source`, `createdAt`,
`bytes`) used for retrieval and dedupe. Koding only — Chat has no project directory, and the
knowledge tools report "no project" instead of erroring.
*Rejected:* append-only JSONL (machine-first, unreadable); single `knowledge.md` (weak structure);
extending `.agent-memory.md` (mixes two different lifecycles — the agent's own lessons vs.
ALC's retrieved facts).

### D9 — Write-back: software auto-summarize + explicit `remember` tool
After a cycle the controller distills useful-but-not-currently-needed findings into knowledge; the
model may also call `remember` for something specific. Dedupe by topic/source before writing.
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
    controller.py   # run_alc_turn: cycle, caps, orchestration
    scratchpad.py   # Scratchpad dataclass: render(), prune(), budget accounting
    decide.py       # structured JSON decision calls + repair/parse + heuristic fallback
    tools.py        # ALC_TOOLS table (schema + prompt examples) and dispatcher
    docs.py         # FTS5 index: build, update, search, snippet extraction
    knowledge.py    # ALC/knowledge read/search/write + index.json maintenance
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
   │     └─ kept → findings (with source); dropped → recorded metadata; budget check
   │                       exhaustion → force `act`
   │
   ├─ Phase 2  ACT         Chat  → run_chat_tool_loop with the ALC briefing
   │                       Koding → run_agent_loop with extraContext = ALC briefing
   │
   └─ Phase 3  VERIFY + WRITE-BACK
                           reuse the existing `verify` event machinery (Koding)
                           distil durable findings → ALC/knowledge (Koding only)
                           unresolved gaps → caveat in the answer, or `ask_user`
```

`run_agent_loop` already accepts `extraContext` (supplied today by `build_memory_context`), so the
Koding integration is a parameter, not a refactor.

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
            index.json          # [{id, topic, tags, source, createdAt, bytes, file}]
            <topic-slug>.md     # human-readable notes (markdown, one topic per file)
```

`index.json` is the retrieval/dedupe surface; the markdown files are the payload and remain
hand-editable. Each entry keeps its provenance (the documentation path or page URL) and the date it
was learned, because a note whose source is not recorded cannot be re-checked later.

Write-back (software, not the model — D9) promotes up to three of the cycle's findings per turn.
Dedupe is layered, because exact-content hashing alone is not enough:

1. the same body under the same topic is a no-op (content hash), and
2. a body whose vocabulary is already contained in the topic's notes is a no-op too — a
   rediscovered fact comes back as a search snippet with headings and a source line around it, and
   without this check every cycle that rediscovered the same fact appended it again.

Findings that came *from* `knowledge_search` are never written back (they are already there), and
nothing is written at all in a read-only session or when `alcWriteKnowledge` is off.

### 4.8 Events

New SSE types (and matching `SESSION_EVENT_TYPES` / `TrajectoryView` styles):

`alc:start`, `alc:stage`, `alc:goal`, `alc:decision`, `alc:search`, `alc:result`, `alc:finding`,
`alc:reject`, `alc:gap`, `alc:budget`, `alc:index`, `alc:knowledge-written`, `alc:done`,
`alc:notice`.

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
| Bytes read per call | 200 KB | — |
| Characters per finding | 800 | — |

Every round checks the abort signal (`_check_abort`, `pipeline.py:512`) so the Stop button works
mid-cycle, and every counter is emitted via `alc:budget` for display.

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
| `components/TrajectoryView.tsx` | icons/colours for the fourteen `alc:*` session-log events |
| `components/AlcSettings.tsx` (new, Settings → ALC) | documentation folders, live index status + rebuild/clear, web-search and write-back toggles, per-turn budget, this project's saved notes |
| `backend/app/routes/alc.py` (new) | `GET/POST/DELETE /api/alc/index`, `GET /api/alc/knowledge` — session-protected like `/api/files`, because they report on folders on the server's disk |
| `backend/app/alc/docs.py` | `clear_index()` so the cache can be dropped from the UI |

Normal mode stays byte-identical: the toggle defaults to off, is never forced on, and with `alc`
false the client sends exactly the payload it sent before.

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
information` / … while the cycle runs), the fourteen `alc:*` events styled in the trajectory view,
and a Settings → ALC tab covering documentation folders, index status with rebuild/clear, the
web-search and write-back toggles, the per-turn budget, and the notes saved for the open project.
Added the small HTTP surface those screens need (`/api/alc/index`, `/api/alc/knowledge`).

**Phase 4 — Tuning & future models.** Budget tuning against the real 1.7B model, documentation,
optional embedding rerank, `alc` model assignment for a fine-tuned Kasalix-1.0-ALC.

---

## 7. Testing

`backend/tests/test_alc_*.py` (144 tests, ~2.5 s, no Ollama and no network, plus one settings
round-trip test in `test_api.py`): the model decisions
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

Existing baseline to preserve: `backend/tests/` (625 passing in total). Normal-mode behaviour must
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
- **FTS5 ranking quality** — keyword search may miss semantically-related chunks; the optional
  embedding rerank (D7) is the escape hatch.
- **Index staleness** — configured folders change outside the app; the mtime/hash rebuild handles
  it, but a large first build needs progress feedback (`alc:index`).
- **Prompt-time cost** — an ALC turn costs more model calls than Normal; the intake off-ramp and
  budgets are what keep trivial turns cheap.

---

## 9. File map

```
backend/app/alc/__init__.py      public surface: run_alc_turn, run_alc_gather, emit_alc, emit_alc_notice
backend/app/alc/controller.py    the cycle: intake -> bounded gather -> act (chat) / brief the agent (Koding)
backend/app/alc/decide.py        the three structured decisions + heuristic fallbacks
backend/app/alc/scratchpad.py    bounded working memory (findings, rejects, gaps, queries, knowledge)
backend/app/alc/docs.py          FTS5 index, markdown-aware chunking, safe file reads, self-healing
backend/app/alc/knowledge.py     ALC/knowledge store: search, remember, dedupe, topics
backend/app/alc/tools.py         the curated tool set + dispatcher + index maintenance
backend/app/alc/events.py        alc:* event vocabulary and emitter
backend/app/routes/alc.py        HTTP surface for the UI: index status/rebuild/clear, project notes
backend/tests/test_alc_*.py      144 tests (docs, knowledge, scratchpad, decide, controller/routing, routes)
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

Wiring: `settings_store.py` (six ALC keys + `get_alc_settings`), `routes/settings.py` (allowlist),
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

## 11. Long-term: Kasalix 1.0 / 2.0

ALC is designed so that future fine-tuned models can *cooperate* with it rather than replace it:

- **Kasalix AI 1.0** — text, reasoning, tools, ALC cooperation (Qwen3 base, QLoRA).
- **Kasalix AI 2.0** — adds vision (vision-capable Qwen base, QLoRA).

The `alc` model-assignment slot exists so a cooperating model can be pinned when it ships, while
0.13.0 validates the orchestration with stock models on consumer hardware.
