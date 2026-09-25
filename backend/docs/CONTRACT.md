# API Contract — Python Backend (kasalix-backend)

This document is the wire-level contract between the frontend (`frontend/src/services/api.ts`)
and the backend. The Python backend (`backend/`) must satisfy **exactly** this contract so the
frontend never changes. The TypeScript backend (`backend/src/`) is the reference implementation;
run the parity harness (`tests/parity/`) to diff them.

## Base URL & transport

- Base path: `/api`
- HTTPS with a self-signed localhost certificate (auto-generated at startup, `certs/localhost.crt|key`)
- JSON bodies/responses; `text/event-stream` for chat/agent streaming
- Trailing slashes are optional (`/api/settings` ≡ `/api/settings/` — FastAPI 307-redirects)

## Auth model

| Scheme | Where | Used by |
|---|---|---|
| `Authorization: Bearer <token>` | session token (from register/login) | chat, conversations, files, memory, auth/me |
| `X-User-Id: <id>` | generated client-side profile id | fallback identity everywhere |
| `Cookie: settings_auth=1` | admin cookie (set via `POST /api/settings/auth`) | settings, planned, changelog, speedtest, plugins, cloud-usage, session-logs, ollama |

401 is returned when a Bearer-token-protected route gets no valid token.
First-run flow: frontend generates a profile id and passes `X-User-Id`; registration is optional
but chat/conversations require a real session.

## Endpoints (frontend-consumed)

### Auth
| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/auth/register` | `{username, password, rememberMe?}` | `{token, user:{id,username,color}}` |
| POST | `/api/auth/login` | `{username, password, rememberMe?}` | `{token, user:{id,username,color}}` |
| POST | `/api/auth/logout` | — | `{success:true}` |
| GET | `/api/auth/me` | — | `{authenticated:bool, user?}` |
| GET | `/api/auth/users` | — | `{users:[...]}` (admin) |

### Chat (SSE)
| Method | Path | Body | Streams |
|---|---|---|---|
| POST | `/api/chat` | `{model, messages[], conversationId?, mode:'chat'\|'agent', workspacePath?, thinkingMode:'auto'\|'off', temperature?, top_p?, max_tokens?, userName, planningEnabled?, autoApply?, planMode?, toolPermission?}` | SSE events below |
| POST | `/api/chat/stop` | `{conversationId}` | `{ok:true}` |
| POST | `/api/chat/answer` | `{key, answer}` | resolves an `agent_question` |
| POST | `/api/chat/approve` | `{key, approve}` | resolves an `agent_approval_request` |
| POST | `/api/chat/title` | `{conversationId, title?}` | `{title}` |
| GET | `/api/chat/background-processes` | — | `{processes:[...]}` |

**SSE wire format:** each event is `data: {json}\n\n`. Event types (all JSON `type` fields):

- `conversationId` `{conversationId}`
- `chunk` `{content}` — streamed assistant text
- `thinking` `{content}` — reasoning tokens (thinking models)
- `stage` `{stage}` — e.g. `chat:thinking`, `tool:executing`, `image:generating`, `agent:planning`, `agent:working`, `agent:reviewing`, `vision:analyzing`, `code:writing`, `summary:writing`
- `agent_tool` `{tool, args}`
- `file_written` `{path, changeType, originalContent?}`
- `agent_command` `{command, output, failed}`
- `agent_question` `{key, question}`
- `agent_approval_request` `{key, tool, args}`
- `plan` `{plan}`
- `model_info` `{model, source:'local'\|'cloud'}`
- `done` `{stage}` — terminal
- `error` `{error}` — terminal

Terminal event order: `conversationId` → `model_info` → `stage` → (`chunk`/`thinking`/tool events)* → `done`.

### Conversations
| Method | Path | Notes |
|---|---|---|
| GET | `/api/conversations` | `{conversations:[...]}` (per user) |
| POST | `/api/conversations` | `{title, mode, model}` → `{conversation}` |
| GET | `/api/conversations/{id}` | `{conversation}` |
| PUT | `/api/conversations/{id}` | partial update (title/messages/agentState) |
| DELETE | `/api/conversations/{id}` | — |
| POST | `/api/conversations/{id}/messages` | append message |
| DELETE | `/api/conversations/{id}/messages/{index}` | remove message |

### Settings (admin)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/settings` | full settings object |
| PUT | `/api/settings` | partial update |
| POST | `/api/settings/reset` | reset to defaults |
| GET | `/api/settings/auth` | `{authenticated:bool}` |
| POST | `/api/settings/auth` | `{password}` → sets `settings_auth=1` cookie |
| GET | `/api/settings/cloud-models` | `{models:[...]}` from ollama.com |

### Files (workspace-sandboxed; require Bearer + `X-User-Id`)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/files?path=` | directory listing `{entries:[{name,path,type,size}]}` |
| GET | `/api/files/content?path=&workspacePath=` | `{content, language, size, truncated, binary}` |
| PUT | `/api/files/write` | `{filePath, content, workspacePath}` → `{success,path,isNew,size}` |
| POST | `/api/files/edit` | `{filePath, oldString, newString, workspacePath}` → `{success,path,size}` |
| DELETE | `/api/files/delete?path=&workspacePath=` | `{success,path}` |

Containment: target must resolve inside `workspacePath` and not inside protected dirs
(`node_modules`, `.git`, `target`, `vendor`, `.venv`, `venv`, `env`, backend data dirs).

### Memory (per user)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/memory` | `{enabled, categories, updatedAt}` |
| PUT | `/api/memory` | update memory object |

### Generated images
| Method | Path | Notes |
|---|---|---|
| GET | `/api/generated/{filename}` | raw image bytes (`image/png` or `image/svg+xml`) |
| GET | `/api/generated/{filename}/download` | `Content-Disposition: attachment` |
| POST | `/api/generated/{filename}/save-to-workspace` | copy into a workspace |

### Other
| Method | Path | Notes |
|---|---|---|
| GET | `/api/models` | `{models:[...]}` from Ollama `/api/tags` |
| GET | `/api/health` | `{status:'ok'}` |
| GET | `/api/cloud-usage` | `{...}` (admin) |
| GET | `/api/planned` · POST/PUT/DELETE | planned features (admin) |
| GET | `/api/changelog` · `/api/changelog/draft` · `/api/changelog/draft/publish` | changelog (admin) |
| GET | `/api/speedtest/tests` · POST `/api/speedtest/run` · GET `/api/speedtest/results` · DELETE `/api/speedtest/results/{id}` | speed tests (admin) |
| GET | `/api/session-logs` · `/api/session-logs/{id}` | agent session logs (admin) |
| GET | `/api/plugins` · POST install/update/uninstall/enable | plugins (admin) |
| GET | `/api/ollama/status` · POST `/api/ollama/start` · POST `/api/ollama/stop` · POST `/api/ollama/restart` · GET `/api/ollama/ps` | Ollama process mgmt (admin) |
| POST | `/api/terminal` | `{command, cwd, workspacePath}` → `{output, exitCode}` |
| GET | `/download/desktop` · `/download/android` | download page routes (served by main app) |

## Data files (same paths as TS backend)

- `data/users.json`, `data/sessions.json` — auth
- `data/conversations.json` — chat history
- `data/settings.json` — app settings incl. `modelAssignments`, `cloudModelAssignments`
- `data/memory.json` — per-user memory
- `data/planned.json`, `data/changelog.json`, `data/plugins.json`, `data/session-logs/`
- `data/generated_images/` (TS: `generated_images/`) — drawn artwork
- `ai-rules.md`, `AGENTS.md` / `.agent-rules` — rule files (user-editable)
- `certs/localhost.crt|key` — auto-generated self-signed certs

## Model routing (settings keys)

`modelAssignments`: `chat`, `agent`, `vision`, `planning`, `summary`, `thinking`
(+ `image` if image models are configured). `cloudModelAssignments` for cloud providers.
`get_resolved_model(category)` → `{model, source:'local'|'cloud'}`.

## Chat pipeline behavior (parity-critical)

1. Resolve model by category (`chat` or `agent`), detect thinking support (capability cache).
2. Intent detection: image request → `draw_image` path (SVG artist + guaranteed fallback);
   tool request → heuristic `execute_tool`; else plain stream.
3. Tool loop (`web_search`, `draw_image`): max 4 rounds, model decides.
4. Agent mode (`mode:'agent'`): planning → workspace loop → review; streams `agent_*` events.
5. Every reply ends with `done` (or `error`).

## Parity harness

`tests/parity/` starts both backends on separate ports and diffs responses for the same
request bodies (auth, models, settings, chat SSE event sequence). See `tests/parity/README.md`.