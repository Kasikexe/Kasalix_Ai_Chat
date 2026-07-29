# Kasalix AI Chat — Developer Build Tool

This tool is for the **developer** only — it is **NOT** distributed to hosts who download the server app.

## Requirements

- **Windows** (for Electron EXE build)
- **Node.js** (npm) or **Bun** installed
- **Java 21+** with `JAVA_HOME` set (for Android APK build)
- **Android SDK** (for Android APK build)

## Usage

### Quick (using .bat file — Windows)

Just double-click **`build.bat`** or run it from the command prompt:

```bat
build.bat
```

This opens an interactive menu where you can:
- Build Electron EXE
- Build Android APK  
- Build both
- Launch the interactive version configurator

### Quick Build (CLI — any platform)

```bash
cd dev-build-tool
bun run build-electron    # Build Electron EXE
bun run build-android     # Build Android APK
bun run build-all         # Build both
bun run build-interactive # Interactive menu with version config
```

Or with npm:

```bash
cd dev-build-tool
npm run build-electron
```

### Interactive Mode

The interactive mode guides you through:
1. Bumping version (major/minor/patch)
2. Configuring app name, icon, description
3. Choosing build type (EXE or APK or both)
4. Building

## Output

- Electron EXE: `../frontend/release/`
- Android APK: `../frontend/android/app/build/outputs/apk/`
