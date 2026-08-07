# Kasalix AI Chat Server — Desktop GUI

This is an **Electron desktop app** that replaces the CLI (`run-server.bat`) with a graphical dashboard.

## Features

- **Server control** — Start/Stop the Bun backend with a button
- **System stats** — Live CPU, RAM, and GPU (NVIDIA) usage
- **Network info** — Shows local IP addresses for LAN sharing
- **Ollama models** — Lists models currently loaded by Ollama
- **Client downloads** — One-click links to download Android APK and Windows EXE from GitHub
- **Auto-start** — Optionally start the server when the app launches

## How it works

The GUI spawns the Bun backend (`bun run src/index.ts`) as a child process, monitors system resources via Node.js `os` module + `nvidia-smi`, and polls the Ollama API for running models.

## Rebranding a fork

- Set the `KASALIX_REPO` env var (e.g. `KASALIX_REPO=YourName/YourFork`) to change where
  client release downloads come from (defaults to `Kasikexe/Kasalix`).
- Edit `FEEDBACK_CONFIG` at the top of the dropdown section in `public/script.js` to point the
  GitHub feedback menu (report bug / suggest idea / visit repo) at your own repository.

## Building

Built automatically by `server-app-installer/build-setup.bat` as part of the server installer.

To build standalone:

```bash
cd server-gui
npm install
npm run build:portable
```

Output: `server-gui/release/Kasalix-AI-Chat-Server-<version>.exe`

## Development

```bash
cd server-gui
npm install
npm run dev
```
