# KODING action limits

KODING exposes nine workspace tools: `list_files`, `glob`, `read_file`,
`search_files`, `edit_file`, `edit_lines`, `write_file`, `rename_file`, and
`delete_file`, plus `run_command` for commands and background processes and
`browser` for the visible desktop browser pane. Search
is literal text matching, not semantic symbol lookup. Search and listing
outputs report when their limits may hide results. Git-specific, web search,
image-generation, and subagent tools are not available to the model. It can still
ask a question as a normal final response.

`run_command` accepts a command, an optional workspace-relative `cwd`, and a
timeout in seconds (1–600, default 120 for foreground commands). It returns the
exit code and bounded stdout/stderr; timeouts and user cancellation stop the
process tree. Pass `background: true` to start a long-running process and get a
process ID. Use `operation: "status"` with that ID to read bounded logs and the
exit status; `wait` can wait up to 10 seconds for new output. Use
`operation: "stop"` to stop it. Background processes normally stop when the run
ends. If the run opens a browser preview, its processes and browser session can
be reused by follow-up messages in the same chat. They stop when the run is
cancelled, the browser pane is closed, the chat is deleted, the server shuts down, or the preview has been
inactive for 30 minutes. Handles are private to their chat, and at most eight
processes are retained per chat. Commands that deliberately
detach child processes can escape process-tree cleanup; do not daemonize them. Commands
run with the server user's permissions and are not sandboxed: they may change
files or access the network, and shell-created changes are not tracked for
revert. Auto permits commands, Ask requires approval, and Read-only blocks
them. Auto-edit also asks before executing commands.

The desktop `browser` tool opens a right-side pane and supports `open`, `inspect`,
`click`, `type`, `console`, `screenshot`, and `close`. It accepts local HTTP(S)
top-level URLs only. `open` with `path: "index.html"` (or without a path) starts
a loopback static server automatically; it serves the HTML file's folder and
blocks traversal, hidden files, protected files, and directory listings. For a
framework app, start its development server and pass its actual URL instead.
Localhost refers to the desktop client machine; a server
running on a different host requires a suitable local port forward. Inspected
page content and screenshots are sent to the model. Screenshots require a
vision-capable coding model and a usable display surface; `inspect` also works
with text-only models. Clicks are DOM-generated, so pages that require trusted
physical input may reject them. Ask requires approval, and Read-only blocks
browser actions. KODING inspects the current page before interacting and
checks the result before claiming it was verified. Closing or hiding the pane
prevents further interactions.

Automatic project verification and game checks remain separate from the tool
catalog. In Auto mode those checks may execute project code with the server
user's permissions; restricted permission modes do not run them automatically.

KODING selects native tool calls when available, tries structured actions for
local models, and falls back to text calls when necessary. The timeline shows
the selected mode and when a retry occurs. Each model action has a 180-second
wall-clock limit by default, with up to two retries after unusable actions.
The timeout includes model loading and generation, but not tool execution or
approval waits. An unfinished tool call is never executed on timeout.

For a slower model or a different retry budget, add or edit
`.agent-config.json` in the workspace root:

```json
{
  "actionTimeoutSeconds": 300,
  "actionRetryLimit": 2
}
```

Timeouts are clamped to 5–1800 seconds and retries to 0–4. These settings are
per workspace. Keep existing fields in the file if it already exists.

In **Settings → Koding → Test model tool calling**, run a harmless synthetic
call against the assigned coding model or a model you enter. No tool is
executed. Results are stored separately from API capability detection. One
successful check is not a guarantee; a recent failed check makes KODING prefer
the fallback protocol for that model and endpoint for seven days. Retest after
changing the model or its template.
