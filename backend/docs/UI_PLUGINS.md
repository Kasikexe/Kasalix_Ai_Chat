# Data-only UI plugins

UI plugins describe modes using a `plugin.json` file. Kasalix renders the
interface with built-in components. A plugin may optionally declare isolated
backend actions; see [PLUGIN_BACKEND.md](PLUGIN_BACKEND.md). Plugins can be
distributed through the existing curated catalog or loaded from a local folder
on the server computer for development.

```json
{
  "id": "example-ui",
  "name": "Example UI",
  "version": "1.0.0",
  "kind": "ui",
  "modes": [
    {
      "id": "example",
      "name": "Example",
      "baseMode": "chat",
      "memory": "per-item",
      "theme": {
        "accent": "#8b5cf6",
        "background": "#11111b",
        "surface": "#24243a",
        "text": "#ffffff"
      },
      "welcome": {
        "type": "card-list",
        "title": "Choose a starter",
        "description": "Select a starter or write your own message.",
        "items": [
          {
            "id": "first",
            "label": "First option",
            "description": "A short description.",
            "message": "Help me get started.",
            "instructions": "Respond in a warm and thoughtful style."
          }
        ]
      }
    }
  ]
}
```

- `kind` must be `ui`. A top-level `entry` is not allowed. A separately
  declared backend entry runs only through Docker after local approval.
- A plugin can define 1–12 modes. Plugin and mode IDs use lowercase letters,
  digits and hyphens; the host namespaces mode IDs by plugin ID.
- `baseMode` is `chat` or `agent`; agent-based modes are available in the
  desktop app and use the existing Koding workspace and permission behavior.
- Optional `memory: "per-item"` isolates saved details for each user and
  selected card, including across chats. Memory is only used and extracted
  while the user's existing Memory setting is enabled. The host extracts
  details explicitly shared by the user; it does not guarantee perfect recall.
  Users can inspect and clear a selected card's memory in Chat, and resetting
  the user's memory also clears all of their separate plugin memories.
- Theme fields are optional six-digit hex colors. Choose colors that provide
  readable contrast. The host uses these as scoped UI color tokens.
- The welcome screen is a `card-list`, with up to 50 cards. Each card needs a
  unique `id` and `label`; `description` and `message` are optional. A card
  with a message shows a Start button that sends that text as a user message.
  Cards without messages display information only. Optional `instructions`
  provide mode-specific guidance to the model on every turn. The selected card
  and its instructions are saved with the conversation, so changing a plugin
  later doesn't silently change an existing conversation.
- Optional cards may use `backendAction` and a JSON `payload` instead of a
  starter `message`; they show the action's result when clicked. The action
  must be declared by the plugin backend. Custom JavaScript is not supported.

To load a local plugin, enter the **absolute path on the server computer** to
its folder in **Server App → Plugins → Load local plugin**. Only requests
from the server computer can use the local-folder endpoint. The folder is not
copied or deleted. After editing `plugin.json`, use the plugin's Update button
to reload it; the plugin ID must remain unchanged. Enable, disable, and remove
use the existing plugin controls. Return focus to the client to refresh its
mode list. Existing chats remain saved if a plugin is disabled or removed.

For catalog distribution, publish the manifest in a catalog-listed plugin
folder. Legacy executable tool plugins are disabled until migrated to isolated
backend actions; existing data-only plugins continue to work.
