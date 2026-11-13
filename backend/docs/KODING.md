# KODING action limits

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
