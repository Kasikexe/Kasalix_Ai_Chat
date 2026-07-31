#!/usr/bin/env node

/**
 * Developer Build Tool — builds Electron EXE and/or Android APK.
 *
 * This tool is for the developer only. It is NOT distributed to hosts
 * who download the server app.
 *
 * Usage:
 *   node build.mjs --electron     Build Electron EXE
 *   node build.mjs --android      Build Android APK
 *   node build.mjs --interactive  Interactive build with menu
 *   node build.mjs --all          Build both
 */

import { execSync } from 'child_process';
import { createInterface } from 'readline';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..', 'frontend');
const CONFIG_PATH = join(ROOT_DIR, 'build-config.json');
const PKG_PATH = join(ROOT_DIR, 'package.json');

// ─── Helpers ────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

function loadJson(fp) {
  try { return JSON.parse(readFileSync(fp, 'utf-8')); }
  catch { return null; }
}

function saveJson(fp, data) {
  writeFileSync(fp, JSON.stringify(data, null, 2) + '\n');
}

function detectPm() {
  try {
    execSync('bun --version', { stdio: 'pipe', windowsHide: true });
    return 'bun';
  } catch {
    return 'npx';
  }
}

function run(cmd, opts = {}) {
  console.log(`\n  $ ${cmd}\n`);
  try {
    execSync(cmd, {
      cwd: opts.cwd || ROOT_DIR,
      stdio: 'inherit',
      shell: true,
      timeout: opts.timeout || 600000,
      windowsHide: true,
    });
  } catch (e) {
    console.error(`\n  ❌ Command failed: ${cmd}`);
    throw e;
  }
}

// Keep the web favicon (public/icon.png) in sync with the current root icon.
// Runs before BOTH Electron and Android builds so the favicon embedded in
// dist/ (and thus the EXE, the APK, and the web) always matches the icon.
function syncWebFavicon() {
  const faviconSrc = resolve(__dirname, '..', 'icon.png');
  if (!existsSync(faviconSrc)) return;
  const publicDir = join(ROOT_DIR, 'public');
  if (!existsSync(publicDir)) mkdirSync(publicDir, { recursive: true });
  copyFileSync(faviconSrc, join(publicDir, 'icon.png'));
  console.log('  ✓ Web favicon synced from icon.png');
}

// ─── Config Management ──────────────────────────────────

function ensureConfig() {
  if (!existsSync(CONFIG_PATH)) {
    saveJson(CONFIG_PATH, {
      version: '1.0.0',
      productName: 'AI Chat',
      appId: 'com.aichat.desktop',
      iconPath: '',
      description: 'AI Chat Desktop Application',
      author: '',
      lastBuild: null,
    });
    console.log('  📄 Created default build-config.json');
  }
  return loadJson(CONFIG_PATH);
}

function applyConfig(config) {
  const pkg = loadJson(PKG_PATH);
  if (!pkg) { console.error('  ❌ Cannot read package.json'); process.exit(1); }
  pkg.version = config.version;
  if (!pkg.build) pkg.build = {};
  pkg.build.productName = config.productName;
  pkg.build.appId = config.appId;
  if (config.description) pkg.description = config.description;
  if (config.author) pkg.author = config.author;
  if (config.iconPath && existsSync(config.iconPath)) {
    if (!pkg.build.win) pkg.build.win = {};
    pkg.build.win.icon = resolve(config.iconPath);
  }
  if (pkg.build.nsis) pkg.build.nsis.shortcutName = config.productName;
  saveJson(PKG_PATH, pkg);
  console.log(`  ✓ Applied config to package.json`);
}

// ─── Build Steps ────────────────────────────────────────

async function buildElectron(config) {
  const pm = detectPm();
  console.log(`\n  ╔══════════════════════════════════════════╗`);
  console.log(`  ║    Building Electron EXE v${config.version.padEnd(12)}║`);
  console.log(`  ╚══════════════════════════════════════════╝\n`);

  // Step 1: Clean old builds
  console.log('  [1/4] Cleaning old builds...');
  const releaseDir = join(ROOT_DIR, 'release');
  if (existsSync(releaseDir)) {
    // Windows
    try { execSync(`rmdir /s /q "${releaseDir}" 2>nul`, { shell: 'cmd.exe', windowsHide: true }); }
    catch { /* ignore */ }
  }

  // Step 2: Install dependencies
  console.log('  [2/4] Installing dependencies...');
  run(`${pm} install`, { cwd: ROOT_DIR, timeout: 120000 });

  // Step 3: Build frontend with Vite
  console.log('  [3/4] Building frontend with Vite...');
  syncWebFavicon();
  run(`${pm} run build`, { cwd: ROOT_DIR, timeout: 120000 });

  // Step 4: Package with electron-builder
  console.log('  [4/4] Packaging Electron app...');
  config.lastBuild = Date.now();
  saveJson(CONFIG_PATH, config);
  applyConfig(config);
  run(`npx electron-builder --win --config -c.extraMetadata.version=${config.version}`, {
    cwd: ROOT_DIR,
    timeout: 300000,
  });

  // Copy EXE to root release/ directory
  const rootReleaseDir = resolve(__dirname, '..', 'release');
  if (!existsSync(rootReleaseDir)) mkdirSync(rootReleaseDir, { recursive: true });
  try {
    const files = readdirSync(releaseDir);
    for (const f of files) {
      if (f.endsWith('.exe') || f.endsWith('.yml') || f.endsWith('.blockmap')) {
        copyFileSync(join(releaseDir, f), join(rootReleaseDir, f));
        console.log(`     Copied ${f} → release/`);
      }
    }
  } catch (err) {
    console.log(`  ⚠️  Could not copy to release/: ${err.message}`);
  }

  console.log(`\n  ✅ Build complete!`);
  console.log(`     ${config.productName} v${config.version}`);    console.log(`     Output: ${rootReleaseDir}\\`);
  console.log(`     To distribute: share the Setup .exe file from the release folder.`);
  console.log(`     Auto-update: place latest.yml + new .exe in the root release/ folder.\n`);
}

async function buildAndroid(config) {
  console.log(`\n  ╔══════════════════════════════════════════╗`);
  console.log(`  ║    Building Android APK v${config.version.padEnd(12)}║`);
  console.log(`  ╚══════════════════════════════════════════╝\n`);

  const pm = detectPm();
  const androidDir = join(ROOT_DIR, 'android');

  if (!existsSync(androidDir)) {
    console.error('  ❌ Android directory not found. Run `npx cap init` and `npx cap add android` first.');
    return;
  }

  // Step 1: Install deps
  console.log('  [1/4] Installing dependencies...');
  run(`${pm} install`, { cwd: ROOT_DIR, timeout: 120000 });

  // Step 2: Build frontend
  console.log('  [2/4] Building frontend with Vite...');
  syncWebFavicon();
  run(`${pm} run build`, { cwd: ROOT_DIR, timeout: 120000 });

  // Step 3: Generate Android icons from the source logo in assets/
  // capacitor-assets v3 reads assets/logo.png (no --path flag supported).
  // The build tool copies the root icon.png there before running.
  const rootIcon = resolve(__dirname, '..', 'icon.png');
  const assetsDir = join(ROOT_DIR, 'assets');
  if (existsSync(rootIcon)) {
    console.log('  [3/5] Generating Android icons from root icon.png...');
    try {
      // Keep assets/logo.png in sync with the current root icon
      if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true });
      copyFileSync(rootIcon, join(assetsDir, 'logo.png'));
      run(`npx @capacitor/assets generate --android --iconBackgroundColor "#030712" --splashBackgroundColor "#030712"`, {
        cwd: ROOT_DIR,
        timeout: 60000,
      });
      console.log('  [OK] Android icons regenerated from icon.png');
    } catch {
      console.log('  [WARN] Icon generation failed — using existing icons');
    }
  } else {
    console.log('  [SKIP] No icon.png found at root — using existing icons');
  }

  // Step 4: Sync to Capacitor
  console.log('  [4/5] Syncing to Capacitor...');
  run('npx cap sync android', { cwd: ROOT_DIR, timeout: 60000 });

  // Step 5: Build APK with Gradle
  console.log('  [5/5] Building APK with Gradle (this may take a while)...');
  run('gradlew.bat assembleDebug', { cwd: androidDir, timeout: 600000 });

  // Copy APK to root release/ directory
  const apkDir = join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug');
  const rootReleaseDir = resolve(__dirname, '..', 'release');
  if (!existsSync(rootReleaseDir)) mkdirSync(rootReleaseDir, { recursive: true });
  try {
    const files = readdirSync(apkDir);
    for (const f of files) {
      if (f.endsWith('.apk')) {
        copyFileSync(join(apkDir, f), join(rootReleaseDir, f));
        console.log(`     Copied ${f} → release/`);
      }
    }
  } catch (err) {
    console.log(`  ⚠️  Could not copy APK to release/: ${err.message}`);
  }

  console.log(`\n  ✅ Android APK build complete!`);
  console.log(`     Output: ${rootReleaseDir}\\`);
  console.log(`     File: app-debug.apk\n`);
}

// ─── Interactive Menu ──────────────────────────────────

function showBanner(config) {
  console.log('');
  console.log('  ╔════════════════════════════════════════════════╗');
  console.log('  ║      AI Chat — Developer Build Tool          ║');
  console.log('  ╚════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  📦  Version:      ${config.version}`);
  console.log(`  🏷️   App Name:     ${config.productName}`);
  console.log(`  🖼️   Icon:         ${config.iconPath || '(default)'}`);
  console.log(`  🆔  App ID:       ${config.appId}`);
  if (config.lastBuild) {
    console.log(`  📅  Last build:   ${new Date(config.lastBuild).toLocaleString()}`);
  }
  console.log('');
  console.log('  ──────────────────────────────────────────────');
  console.log('');
}

function showMenu() {
  console.log('  [1] Bump version (major)');
  console.log('  [2] Bump version (minor)');
  console.log('  [3] Bump version (patch)');
  console.log('  [4] Set version manually');
  console.log('  [5] Change app name / icon / description');
  console.log('  [6] Build Electron EXE');
  console.log('  [7] Build Android APK');
  console.log('  [8] Build both (EXE + APK)');
  console.log('  [Q] Quit');
  console.log('');
}

async function interactiveMenu(config) {
  let running = true;
  while (running) {
    showBanner(config);
    showMenu();
    const choice = (await ask('  Select option: ')).trim().toLowerCase();

    switch (choice) {
      case '1': case '2': case '3': {
        const idx = parseInt(choice) - 1;
        const parts = config.version.split('.').map(Number);
        for (let i = 0; i < 3; i++) if (isNaN(parts[i])) parts[i] = 0;
        for (let i = idx + 1; i < 3; i++) parts[i] = 0;
        parts[idx]++;
        config.version = `${parts[0]}.${parts[1]}.${parts[2]}`;
        const labels = ['Major', 'Minor', 'Patch'];
        console.log(`  ✅ ${labels[idx]} bump: ${config.version}`);
        await ask('  Press Enter to continue...');
        break;
      }
      case '4': {
        const v = await ask(`  Enter version (current: ${config.version}): `);
        if (v.trim()) config.version = v.trim();
        break;
      }
      case '5': {
        const name = await ask(`  App name (${config.productName}): `);
        if (name.trim()) config.productName = name.trim();
        const icon = await ask(`  Icon path (.ico/.png, or empty for default): `);
        if (icon.trim()) config.iconPath = icon.trim().replace(/"/g, '');
        const desc = await ask(`  Description (${config.description}): `);
        if (desc.trim()) config.description = desc.trim();
        const author = await ask(`  Author (${config.author || '(empty)'}): `);
        if (author.trim()) config.author = author.trim();
        console.log('  ✅ Settings updated');
        await ask('  Press Enter to continue...');
        break;
      }
      case '6': {
        rl.close();
        await buildElectron(config);
        running = false;
        break;
      }
      case '7': {
        rl.close();
        await buildAndroid(config);
        running = false;
        break;
      }
      case '8': {
        rl.close();
        await buildElectron(config);
        console.log('\n  ──────────────────────────────────────────────\n');
        await buildAndroid(config);
        running = false;
        break;
      }
      case 'q': {
        console.log('\n  Build cancelled.\n');
        rl.close();
        process.exit(0);
      }
      default: {
        console.log('\n  ⚠️  Invalid option.\n');
        await ask('  Press Enter to continue...');
      }
    }
  }
}

// ─── CLI Entry Point ───────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const config = ensureConfig();

  if (args.includes('--interactive')) {
    await interactiveMenu(config);
  } else {
    if (args.includes('--electron')) await buildElectron(config);
    if (args.includes('--android')) await buildAndroid(config);
    if (!args.includes('--electron') && !args.includes('--android') && !args.includes('--all')) {
      console.log('Usage:');
      console.log('  node build.mjs --electron     Build Electron EXE');
      console.log('  node build.mjs --android      Build Android APK');
      console.log('  node build.mjs --interactive  Interactive build');
      console.log('  node build.mjs --all          Build both');
    }
  }
}

main().catch((err) => {
  console.error('\n  ❌ Error:', err.message);
  process.exit(1);
});
