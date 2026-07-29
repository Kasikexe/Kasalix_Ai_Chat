# Kasalix AI Chat Server — Installer Builder

This folder contains everything you need to build a **Setup.exe** installer for the AI Chat Server App.

The installer packages:
- **Backend** — Bun/TypeScript API server (handles AI requests, auth, etc.)
- **Frontend** — Pre-built React web UI (served directly by the backend on port 3001)
- **SSL Certificates** — Self-signed certs for HTTPS
- **Start/Stop scripts** — Windows batch files for running the server

The installer does **NOT** include:
- The Electron client app
- The Android APK builder
- Developer build tools (`dev-build-tool/`)
- Bun runtime (user must install Bun separately)

---

## License

**NSIS** (Nullsoft Scriptable Install System) is open-source under the **zlib/libpng license**.
✅ **Free for commercial use** — no license purchase required, no revenue thresholds.

---

## How to Build the Setup.exe

### Prerequisites

1. **Node.js** — [nodejs.org](https://nodejs.org) (required for building the frontend)
2. **Bun** — [bun.sh](https://bun.sh) (install backend deps)
3. **NSIS** — [nsis.sourceforge.io/Download](https://nsis.sourceforge.io/Download) (to compile the installer)
   - Download and install with default settings (adds `makensis` to PATH automatically)

### Build (one-click)

Double-click **`build-setup.bat`** or run it from a terminal:

```
build-setup.bat
```

The script will:

1. Install backend dependencies (`bun install`)
2. Build the frontend for production (`npm run build`)
3. Read the version from `frontend/package.json`
4. Compile `setup.nsi` into `output\Kasalix-AI-Chat-Server-Setup-<version>.exe`

### Without NSIS

If NSIS is not installed, the script falls back to creating a **portable ZIP archive**:

```
output\Kasalix-AI-Chat-Server-Portable-<version>.zip
```

To get the proper Setup.exe later, install NSIS and right-click `setup.nsi` → "Compile NSIS Script".

---

## What the Installer Does

On the user's machine, the Setup.exe:

1. **Installs to:** `%LOCALAPPDATA%\Kasalix AI Chat Server\`
2. **Creates shortcuts:** Start Menu group + Desktop shortcut
3. **Checks for Bun** — offers to open bun.sh if not found
4. **Offers to run** the server after installation finishes
5. **Uninstaller** — cleanly removes all files, shortcuts, and registry entries

After installation, the user double-clicks the **"Kasalix AI Chat Server"** shortcut to start.

---

## Files in this directory

| File | Purpose |
|------|---------|
| `build-setup.bat` | Build script — installs deps, builds frontend, compiles Setup.exe |
| `setup.nsi` | **NSIS script** — defines the installer (zlib/libpng license, free for commercial use) |
| `run-server.bat` | Start script (included in the installer) |
| `stop-server.bat` | Stop script (included in the installer) |
| `README.md` | This file |
| `output/` | Generated installers appear here (gitignored) |

## Distribution Checklist

Before distributing the Setup.exe:

- [ ] Test the installer on a clean Windows VM
- [ ] Verify the server starts and is accessible at `https://localhost:3001`
- [ ] Verify Ollama connection works
- [ ] Update `frontend/package.json` version before building
- [ ] (Optional) Sign the `.exe` with a code signing certificate
