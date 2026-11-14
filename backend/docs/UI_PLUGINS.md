# Data-only UI plugins

UI plugins describe modes using a `plugin.json` file. Kasalix renders the
interface with built-in components; it does not execute code from a UI plugin.
They can be distributed through the existing curated catalog or loaded from a
local folder on the server computer for development.

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
            "message": "Help me get started."
          }
        ]
      }
    }
  ]
}
```

- `kind` must be `ui`. An `entry` is not allowed, and `index.py` or other
  code in the folder is never imported by this plugin type.
- A plugin can define 1–12 modes. Plugin and mode IDs use lowercase letters,
  digits and hyphens; the host namespaces mode IDs by plugin ID.
- `baseMode` is `chat` or `agent`; agent-based modes are available in the
  desktop app and use the existing Koding workspace and permission behavior.
- Theme fields are optional six-digit hex colors. Choose colors that provide
  readable contrast. The host uses these as scoped UI color tokens.
- The welcome screen is a `card-list`, with up to 50 cards. Each card needs a
  unique `id` and `label`; `description` and `message` are optional. A card
  with a message shows a Start button that sends that text as a user message.
  Cards without messages display information only.
- This version customizes the interface and starter messages. It does not add
  new backend behavior, custom JavaScript, or plugin-specific permissions.
  Existing executable tool plugins have their separate, existing behavior.

To load a local plugin, enter the **absolute path on the server computer** to
its folder in **Server App → Plugins → Load local UI plugin**. Only requests
from the server computer can use the local-folder endpoint. The folder is not
copied or deleted. After editing `plugin.json`, use the plugin's Update button
to reload it; the plugin ID must remain unchanged. Enable, disable, and remove
use the existing plugin controls. Return focus to the client to refresh its
mode list. Existing chats remain saved if a plugin is disabled or removed.

For catalog distribution, publish the manifest in a catalog-listed plugin
folder. The existing GitHub installer handles UI manifests as well as tool
plugins. UI plugins cannot register tools or run backend code.
