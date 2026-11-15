# Isolated plugin backend actions

UI plugins can optionally define Python backend actions in a single UTF-8
file in the plugin folder. Kasalix never imports this file into the server.
It executes a requested action in a disposable Linux Docker container only
after the server operator reviews and approves that specific code and its
requested permissions in **Server App → Plugins → Review permissions**.

## Server setup

Install and start Docker with Linux containers enabled, then prepare the local
runtime image:

```sh
docker pull python:3.12-slim
```

Kasalix uses this fixed local image with `--pull never`; it does not download
an image when an action runs. Docker and the image must be available to the
server process. If they are missing or unavailable, the action fails rather
than running plugin code on the host.

Each action uses a fresh container with networking disabled, a read-only root
filesystem, a non-root user, dropped capabilities, no host mounts or Docker
socket, and time, output, memory, CPU and process limits. Docker is an
isolation boundary, not a guarantee against every container or host-runtime
vulnerability. Server operators must trust and maintain their Docker runtime
and local image.

## Manifest

Add a `backend` object to a UI plugin's `plugin.json`:

```json
{
  "backend": {
    "entry": "backend.py",
    "actions": ["increment"],
    "permissions": ["storage.read", "storage.write"]
  }
}
```

A backend-only plugin can instead use `"kind": "backend"` with this object
and no modes. Its actions are available through the authenticated API.

The entry must be a single Python file at the plugin folder's root, under
256 KB. It can use the Python standard library in the image; additional
plugin files and host packages are not mounted or installed. Action names use
lowercase letters, digits, and hyphens.

```python
def handle(action, payload, api):
    if action == "increment":
        count = api.storage.get("count", 0) + 1
        api.storage.set("count", count)
        return {"count": count}
    raise ValueError("Unknown action")
```

`handle` may also be async. Input and return values must be JSON-compatible.
The only host capability in this version is per-user, per-plugin storage:

- `storage.read`: `api.storage.get(key, default=None)`.
- `storage.write`: `api.storage.set(key, value)` and
  `api.storage.delete(key)`. Requesting or granting write also requires read.

Storage is limited to 64 KB per user and plugin. It is separate from the
plugin's code and from other users' storage. Storage persists if the plugin is
disabled or uninstalled; an authenticated user can delete their own data via
`DELETE /api/plugins/{plugin_id}/storage`. A welcome screen with backend
action cards also offers a **Clear plugin data** button.

Approving backend execution is separate from granting the requested storage
permissions. The operator can deny a requested capability; the action then
fails if it tries to use it. Changes to backend code, action names, entry or
requested permissions invalidate approval until the plugin is reloaded and
reviewed again. Revocation during a running action discards its results and
storage changes.

## Calling actions

An authenticated client can call a declared action at
`POST /api/plugins/{plugin_id}/actions/{action}` with a JSON object (at most
32 KB). The response is `{ "result": ... }`. The payload and that user's
permitted storage are the only user data supplied to the container.

For a built-in welcome card, use `backendAction` and optional object `payload`
instead of `message`:

```json
{ "id": "counter", "label": "Counter", "backendAction": "increment", "payload": {} }
```

The card displays the returned result. Backend actions cannot access the
network, host files, other users' data, arbitrary Kasalix endpoints or execute
host commands. No permission for these capabilities exists in this version.

## Existing executable tool plugins

Legacy tool plugins were previously loaded directly into the server process
and cannot be safely restricted by the new permissions. They are kept in the
registry but are not executed or registered as AI tools. Migrate their logic
to isolated backend actions; this first backend-action API does not yet expose
those actions as AI tool calls.
