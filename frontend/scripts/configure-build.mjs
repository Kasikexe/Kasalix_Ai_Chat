#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { createInterface } from 'readline';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT_DIR, 'build-config.json');
const PKG_PATH = path.join(ROOT_DIR, 'package.json');

// ── Helpers ──────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

function loadJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch { return null; }
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

function detectPkgManager() {
  try {
    execSync('bun --version', { stdio: 'pipe', windowsHide: true });
    return 'bun';
  } catch {
    return 'npx';
  }
}

function getBuildCommand(portable) {
  // Run electron-builder directly — vite build was already done by the batch file
  const args = portable ? '--win portable' : '--win';
  return `electron-builder ${args} --config`;
}

// ── Banner ───────────────────────────────────────────────

function showBanner(config) {
  console.log('');
  console.log('  ╔════════════════════════════════════════════════╗');
  console.log('  ║      AI Chat Desktop App — Build Config      ║');
  console.log('  ╚════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  📦  Version:      ${config.version}`);
  console.log(`  🏷️   App Name:     ${config.productName}`);
  console.log(`  🖼️   Icon:         ${config.iconPath || '(default Electron icon)'}`);
  console.log(`  🆔  App ID:       ${config.appId}`);
  if (config.lastBuild) {
    console.log(`  📅  Last build:   ${new Date(config.lastBuild).toLocaleString()}`);
  }
  console.log('');
  console.log('  ──────────────────────────────────────────────');
  console.log('');
}

function showMenu() {
  console.log('  ┌───── Version Bump ─────────────────────────┐');
  console.log('  │  [1] Major  — incompatible API changes    │');
  console.log('  │  [2] Minor  — new features (backward)     │');
  console.log('  │  [3] Patch  — bug fixes (backward)        │');
  console.log('  └───────────────────────────────────────────┘');
  console.log('  [4] Manual version input');
  console.log('  [5] Change app name / icon / other');
  console.log('  [6] Build now (current settings)');
  console.log('  [7] Build portable .exe (no install)');
  console.log('  [Q] Quit');
  console.log('');
}

// ── Apply config to package.json ────────────────────────

function applyConfig(config) {
  const pkg = loadJson(PKG_PATH);
  if (!pkg) {
    console.error('  ❌ Could not read package.json');
    process.exit(1);
  }

  pkg.version = config.version;
  if (!pkg.build) pkg.build = {};
  pkg.build.productName = config.productName;
  pkg.build.appId = config.appId;
  if (config.description) pkg.description = config.description;
  if (config.author) pkg.author = config.author;

  // Icon handling
  if (config.iconPath && fs.existsSync(config.iconPath)) {
    if (!pkg.build.win) pkg.build.win = {};
    pkg.build.win.icon = path.resolve(config.iconPath);
    console.log(`  🖼️   Using icon: ${config.iconPath}`);
  } else {
    if (pkg.build.win) delete pkg.build.win.icon;
    if (config.iconPath && !fs.existsSync(config.iconPath)) {
      console.log(`  ⚠️   Icon not found: ${config.iconPath} — using default`);
    }
  }

  // NSIS shortcut name
  if (pkg.build.nsis) {
    pkg.build.nsis.shortcutName = config.productName;
  }

  saveJson(PKG_PATH, pkg);
}

// ── Interactive menu ────────────────────────────────────

async function runMenu(config) {
  let running = true;

  while (running) {
    showBanner(config);
    showMenu();
    const choice = (await ask('  Select option: ')).trim().toLowerCase();

    function bumpVersion(index) {
      const parts = config.version.split('.').map(Number);
      // Ensure 3 parts exist
      for (let i = 0; i < 3; i++) if (isNaN(parts[i])) parts[i] = 0;
      // Zero out parts after the bumped segment (proper semver)
      for (let i = index + 1; i < 3; i++) parts[i] = 0;
      parts[index]++;
      config.version = `${parts[0]}.${parts[1]}.${parts[2]}`;
    }

    const LEVEL_LABELS = { '1': 'Major', '2': 'Minor', '3': 'Patch' };

    switch (choice) {
      case '1':
      case '2':
      case '3': {
        const idx = parseInt(choice) - 1; // 0=major, 1=minor, 2=patch
        bumpVersion(idx);
        console.log(`\n  ✅ ${LEVEL_LABELS[choice]} bump: ${config.version}`);
        await ask('  Press Enter to continue...');
        break;
      }

      case '4': {
        const v = await ask(`  Enter version (current: ${config.version}): `);
        if (v.trim()) {
          config.version = v.trim();
          console.log(`  ✅ Version set to ${config.version}`);
        }
        await ask('  Press Enter to continue...');
        break;
      }

      case '5': {
        console.log('');
        const name = await ask(`  App name (${config.productName}): `);
        if (name.trim()) config.productName = name.trim();

        const icon = await ask(`  Icon path (.ico/.png, or empty for default): `);
        if (icon.trim()) config.iconPath = icon.trim().replace(/"/g, '');

        const desc = await ask(`  Description (${config.description}): `);
        if (desc.trim()) config.description = desc.trim();

        const author = await ask(`  Author (${config.author || '(empty)'}): `);
        if (author.trim()) config.author = author.trim();

        console.log('\n  ✅ Settings updated');
        await ask('  Press Enter to continue...');
        break;
      }

      case '6':
      case '7': {
        // Save config
        config.lastBuild = Date.now();
        saveJson(CONFIG_PATH, config);

        // Apply to package.json
        applyConfig(config);

        // Only show version reminder for auto-update
        console.log('');
        console.log('  ──────────────────────────────────────────────');
        console.log(`  🚀 Building ${config.productName} v${config.version}...`);
        console.log('  ──────────────────────────────────────────────');
        console.log('');

        // Close readline before running the build
        rl.close();

        const pkgManager = detectPkgManager();
        const isPortable = choice === '5';
        const buildCmd = getBuildCommand(isPortable);

        // Run electron-builder directly (Vite already built by batch file)
        console.log(`  Running: ${pkgManager} ${buildCmd}\n`);
        try {
          execSync(`${pkgManager} ${buildCmd}`, {
            cwd: ROOT_DIR,
            stdio: 'inherit',
            shell: true,
          });
        } catch (err) {
          console.error('\n  ❌ Build failed. See errors above.\n');
          process.exit(1);
        }

        console.log('');
        console.log('  ╔══════════════════════════════════════════════╗');
        console.log('  ║           ✅  BUILD COMPLETE!                ║');
        console.log('  ╚══════════════════════════════════════════════╝');
        console.log(`     ${config.productName} v${config.version}`);
        console.log(`     Output: ${path.join(ROOT_DIR, 'release')}\\`);
        console.log('');

        // Auto-update reminder
        console.log('  💡 Tip for auto-update in the future:');
        console.log('     Always bump the version before building!');
        console.log('     Run build_electron.bat again for the next');
        console.log('     release and choose option [1] to bump.');
        console.log('');

        running = false;
        break;
      }

      case 'q': {
        console.log('\n  Build cancelled.\n');
        rl.close();
        process.exit(0);
      }

      default: {
        console.log('\n  ⚠️  Invalid option. Please choose 1-5 or Q.\n');
        await ask('  Press Enter to continue...');
      }
    }
  }
}

// ── Entry ────────────────────────────────────────────────

async function main() {
  // Ensure build-config.json exists
  if (!fs.existsSync(CONFIG_PATH)) {
    const defaults = {
      version: '1.0.0',
      productName: 'AI Chat',
      appId: 'com.aichat.desktop',
      iconPath: '',
      description: 'AI Chat Desktop Application',
      author: '',
      lastBuild: null,
    };
    saveJson(CONFIG_PATH, defaults);
    console.log('  📄 Created default build-config.json');
  }

  const config = loadJson(CONFIG_PATH);
  if (!config) {
    console.error('  ❌ Could not load build-config.json');
    process.exit(1);
  }

  await runMenu(config);
}

main().catch((err) => {
  console.error('  ❌ Error:', err.message);
  process.exit(1);
});
