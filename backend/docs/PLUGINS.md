# Kasalix plugin quick start

## Install and use a plugin

1. Start the Server App and open **Plugins**. Select **Install** on a catalog
   entry. For a local plugin, enter the absolute path to the folder containing
   `plugin.json` on the server computer and select **Load local plugin**.
2. If the plugin is disabled, select **Enable**. Switch back to a client
   connected to that server to refresh its mode list.
3. Choose the plugin's mode in the sidebar near **Chat** and **Koding**.
   Koding-based plugin modes require the desktop client. In a mode with
   welcome cards, **Start** sends the card's starter message and **Run**
   executes the card's backend action.

Use **Update** to fetch the latest catalog version or reload edits to a local
plugin. **Disable** hides the plugin's modes and pauses its actions. **Remove**
uninstalls the plugin. Existing conversations stay in your history.

## Enable backend actions

1. Install Docker Desktop on the server computer. If the **Plugins** tab
   shows a Docker banner, **Download automatically** saves the installer to
   Downloads. Open the installer to install Docker Desktop. **Download
   manually** dismisses the banner so you can get the installer yourself.
   [Docker Desktop installation guide](https://docs.docker.com/desktop/setup/install/windows-install/)
2. Start Docker Desktop with Linux containers enabled. In a terminal on the
   server computer, run `docker pull python:3.12-slim`. Restart the Server App.
3. On the plugin card, select **Review permissions**. Approve execution and
   grant the storage permissions you want the plugin to use. Use **Revoke**
   to withdraw approval. After an update changes the backend code or its
   permissions, review the plugin again.

## Create a plugin

Start with the `plugin.json` example in the [UI plugin reference](UI_PLUGINS.md).
Load the folder locally and use **Update** to test changes. To add a Python
action, follow the [backend action reference](PLUGIN_BACKEND.md).
