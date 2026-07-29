#!/usr/bin/env node

/**
 * ═══════════════════════════════════════════════════════════════════
 *  Kasalix Changelog CLI
 *  Manages changelog.json in the Kasalix GitHub repo.
 *
 *  Usage:
 *    node index.js                    → Interactive mode (asks for entry details)
 *    node index.js --help             → Show help
 *
 *  Environment:
 *    GH_TOKEN  required  GitHub Personal Access Token with repo scope
 *
 *  The tool:
 *    1. Reads the current changelog.json from the repo root
 *    2. Adds a new entry (interactive prompts)
 *    3. Commits and pushes to GitHub
 * ═══════════════════════════════════════════════════════════════════
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const readline = require('readline');

// ─── Config ──────────────────────────────────────────────────────
const REPO_URL = 'https://github.com/Kasikexe/Kasalix.git';
const CHANGELOG_FILE = 'changelog.json';
const TOKEN_ENV_VAR = 'GH_TOKEN';

/** Load token from .env file if env var is not set */
function loadToken() {
  if (process.env[TOKEN_ENV_VAR]) return; // already set
  try {
    const envPath = path.join(__dirname, '.env');
    const raw = fs.readFileSync(envPath, 'utf-8');
    const match = raw.match(/^GH_TOKEN=['"]?([^'"\n]+)['"]?$/m);
    if (match && match[1]) {
      const value = match[1].split('#')[0].trim();
      if (value) process.env[TOKEN_ENV_VAR] = value;
    }
  } catch { /* no .env file — that's fine */ }
}

/** Detect the current git branch */
function getCurrentBranch() {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8', windowsHide: true }).trim();
  } catch {
    return 'main';
  }
}

/** Check that the git remote points to the right repo */
function checkRemote() {
  try {
    const remote = execSync('git remote get-url origin', { encoding: 'utf-8', windowsHide: true }).trim();
    if (!remote.includes('Kasikexe/Kasalix')) {
      console.log(yellow('  ⚠️  Git remote "origin" does not point to Kasikexe/Kasalix'));
      console.log(`     ${dim('Remote: ' + remote)}`);
      return false;
    }
    return true;
  } catch {
    console.log(yellow('  ⚠️  Could not verify git remote. Make sure you are in the Kasalix repo.'));
    return false;
  }
}

// ─── Paths ───────────────────────────────────────────────────────
const TOOL_DIR = __dirname;
const PROJECT_ROOT = path.resolve(TOOL_DIR, '..');
const CHANGELOG_PATH = path.join(PROJECT_ROOT, CHANGELOG_FILE);

// ─── Readline Interface ──────────────────────────────────────────
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const ask = (q) => new Promise((r) => rl.question(q, r));

// ─── Helpers ─────────────────────────────────────────────────────

function green(text)  { return `\x1b[32m${text}\x1b[0m`; }
function yellow(text) { return `\x1b[33m${text}\x1b[0m`; }
function red(text)    { return `\x1b[31m${text}\x1b[0m`; }
function dim(text)    { return `\x1b[2m${text}\x1b[0m`; }
function bold(text)   { return `\x1b[1m${text}\x1b[0m`; }

// ─── Changelog Operations ────────────────────────────────────────

/**
 * Read the current changelog.json from the repo root.
 */
function readChangelog() {
  try {
    const raw = fs.readFileSync(CHANGELOG_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * Write entries to changelog.json.
 */
function writeChangelog(entries) {
  fs.writeFileSync(CHANGELOG_PATH, JSON.stringify(entries, null, 2) + '\n', 'utf-8');
}

/**
 * Compare two semver strings (descending: newest first).
 */
function compareVersions(a, b) {
  const aParts = a.split('.').map(Number);
  const bParts = b.split('.').map(Number);
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aNum = aParts[i] || 0;
    const bNum = bParts[i] || 0;
    if (aNum !== bNum) return aNum - bNum;
  }
  return 0;
}

/**
 * Add a new entry and save sorted (newest first).
 */
function addEntry(entry) {
  const entries = readChangelog();

  // Validate: no duplicate versions
  const existing = entries.find((e) => e.version === entry.version);
  if (existing) {
    console.log(yellow(`  ⚠️  Version ${entry.version} already exists. It will be overwritten.`));
    // Filter out the old entry for this version
    const filtered = entries.filter((e) => e.version !== entry.version);
    filtered.push(entry);
    filtered.sort((a, b) => compareVersions(b.version, a.version));
    writeChangelog(filtered);
    return entry;
  }

  entries.push(entry);
  entries.sort((a, b) => compareVersions(b.version, a.version));
  writeChangelog(entries);
  return entry;
}

// ─── Git Operations ──────────────────────────────────────────────

/**
 * Check if git is available.
 */
function checkGit() {
  try {
    execSync('git --version', { stdio: 'pipe', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if GH_TOKEN is set.
 */
function checkToken() {
  return !!process.env[TOKEN_ENV_VAR];
}

/**
 * Get the remote URL with token embedded for authentication.
 */
function getAuthedRemote() {
  const token = process.env[TOKEN_ENV_VAR];
  // https://token@github.com/Kasikexe/Kasalix.git
  return REPO_URL.replace('https://', `https://${token}@`);
}

/**
 * Commit and push the changelog.json to GitHub.
 * Uses temporary remote URL with embedded token to avoid Git Credential Manager prompts.
 */
function commitAndPush(version, title) {
  const cwd = PROJECT_ROOT;

  console.log(`\n  ${dim('── Committing to GitHub ──')}\n`);

  // Stage the changelog file
  execSync(`git add "${CHANGELOG_FILE}"`, { cwd, stdio: 'pipe', windowsHide: true });
  console.log(`  ${green('✔')} Staged ${CHANGELOG_FILE}`);

  // Check if there's anything to commit
  const status = execSync('git status --porcelain', { cwd, encoding: 'utf-8', windowsHide: true });
  if (!status.trim()) {
    console.log(`  ${yellow('ℹ')} No changes to commit.`);
    return true;
  }

  // Commit
  const commitMsg = `chore(changelog): add v${version} - ${title}`;
  execSync(`git commit -m "${commitMsg}"`, { cwd, stdio: 'pipe', windowsHide: true });
  console.log(`  ${green('✔')} Committed: ${dim(commitMsg)}`);

  const branch = getCurrentBranch();
  const authedRemote = getAuthedRemote();

  // Save the original remote URL
  let originalRemote;
  try {
    originalRemote = execSync('git remote get-url origin', { cwd, encoding: 'utf-8', windowsHide: true }).trim();
  } catch {
    originalRemote = null;
  }

  try {
    // Set remote with token embedded — prevents Git Credential Manager popup
    execSync(`git remote set-url origin "${authedRemote}"`, { cwd, stdio: 'pipe', windowsHide: true });

    // Push using origin (the standard remote name)
    execSync(`git push origin ${branch}`, {
      cwd,
      stdio: 'pipe',
      windowsHide: true,
      timeout: 30000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    });

    // Restore original remote URL
    if (originalRemote) {
      execSync(`git remote set-url origin "${originalRemote}"`, { cwd, stdio: 'pipe', windowsHide: true });
    }

    console.log(`  ${green('✔')} Pushed to ${REPO_URL}`);
    return true;
  } catch (err) {
    // Restore original remote URL on failure too
    if (originalRemote) {
      try {
        execSync(`git remote set-url origin "${originalRemote}"`, { cwd, stdio: 'pipe', windowsHide: true });
      } catch {}
    }
    console.log(`  ${red('✘')} Push failed: ${err.message}`);
    console.log(`  ${yellow('ℹ')} The changelog.json has been updated locally.`);
    console.log(`     You can push manually:\n       git push origin ${branch}`);
    return false;
  }
}

// ─── Interactive Prompts ─────────────────────────────────────────

async function interactiveMode() {
  console.log(`
  ╔═══════════════════════════════════════════════╗
  ║      Kasalix Changelog — New Entry           ║
  ╚═══════════════════════════════════════════════╝
  `);

  // Get latest version from existing entries
  const entries = readChangelog();
  const latestVersion = entries.length > 0 ? entries[0].version : '1.0.0';
  console.log(`  Current latest version: ${bold(latestVersion)}`);

  const version = await ask(`  ${bold('Version')} (e.g. 1.7.0): `);
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    console.log(`  ${red('✘ Invalid version format. Use semver (e.g. 1.7.0)')}`);
    rl.close();
    process.exit(1);
  }

  const title = await ask(`  ${bold('Title')} (e.g. New Features & Improvements): `);
  if (!title) {
    console.log(`  ${red('✘ Title is required')}`);
    rl.close();
    process.exit(1);
  }

  const type = await ask(`  ${bold('Type')} (major/minor/patch): `);
  const validTypes = ['major', 'minor', 'patch'];
  if (!validTypes.includes(type)) {
    console.log(`  ${red('✘ Type must be major, minor, or patch')}`);
    rl.close();
    process.exit(1);
  }

  console.log(`\n  ${dim('Enter description (markdown).')}`);
  console.log(`  ${dim('Type an empty line (just press Enter twice) to finish.')}`);
  console.log(`  ${dim('Example:')}`);
  console.log(`  ${dim('  - Added new dashboard widget')}`);
  console.log(`  ${dim('  - Fixed login timeout bug')}`);
  console.log(`  ${dim('  - Improved search performance')}`);
  console.log('');

  // Collect multi-line input safely — no collision with rl.question()
  let descLines = [];
  let emptyLineCount = 0;
  await new Promise((resolve) => {
    const handler = (line) => {
      if (line === '') {
        emptyLineCount++;
      } else {
        emptyLineCount = 0;
      }
      descLines.push(line);
      if (emptyLineCount >= 2) {
        rl.removeListener('line', handler);
        resolve();
      }
    };
    rl.on('line', handler);
  });

  // Remove the two trailing empty lines (the delimiter)
  descLines = descLines.slice(0, -2);
  const description = descLines.join('\n');
  if (!description.trim()) {
    console.log(`  ${red('✘ Description cannot be empty')}`);
    process.exit(1);
  }

  const entry = {
    version,
    title,
    description: description.trim(),
    date: new Date().toISOString().split('T')[0],
    type,
  };

  console.log(`\n  ${green('✔')} Entry ready:\n`);
  console.log(`    ${bold('v' + version)} — ${title} ${dim('(' + type + ')')}`);
  console.log(`    ${dim(entry.date)}`);
  console.log(`    ${description.trim().split('\n').length} lines\n`);

  const confirm = await new Promise((r) => {
    rl.question(`  ${bold('Push to GitHub?')} (y/N): `, r);
  });

  if (confirm.toLowerCase() !== 'y') {
    console.log(`  ${yellow('ℹ')} Cancelled. No changes were made.`);
    process.exit(0);
  }

  // Save entry
  addEntry(entry);
  console.log(`  ${green('✔')} Added v${version} to changelog.json`);

  // Commit & push
  const pushed = commitAndPush(version, title);

  console.log(`\n  ${bold('─'.repeat(45))}\n`);
  rl.close();

  if (pushed) {
    console.log(`  ${green('✔')} Changelog entry published!`);
    console.log(`  ${dim('  Raw URL:')} https://raw.githubusercontent.com/Kasikexe/Kasalix/main/${CHANGELOG_FILE}`);
    console.log(`  ${dim('  GitHub:')}  ${REPO_URL}\n`);
  } else {
    console.log(`  ${yellow('ℹ')} Entry saved locally. Push manually when ready.\n`);
  }
}

// ─── CLI Entry ───────────────────────────────────────────────────

function showHelp() {
  console.log(`
  ╔═══════════════════════════════════════════════╗
  ║      Kasalix Changelog CLI                   ║
  ╚═══════════════════════════════════════════════╝

  ${bold('Usage:')}
    node index.js              Interactive mode
    node index.js --help       Show this help

  ${bold('Environment:')}
    ${TOKEN_ENV_VAR}  GitHub Personal Access Token (required for pushing)

  ${bold('How to get a GitHub token:')}
    1. Go to https://github.com/settings/tokens
    2. Click "Generate new token (classic)"
    3. Select scope: ${bold('repo')} (Full control of private repositories)
    4. Copy the token
    5. Set it in your environment:

       ${dim('# Windows (cmd)')}
       set ${TOKEN_ENV_VAR}=ghp_xxxxxxxxxxxx

       ${dim('# Windows (PowerShell)')}
       $env:${TOKEN_ENV_VAR}="ghp_xxxxxxxxxxxx"

       ${dim('# Or create a .env file next to this script')}

  ${bold('What it does:')}
    1. Reads current changelog.json from the project root
    2. Adds a new entry with version, title, description, date, type
    3. Commits and pushes to ${REPO_URL}

  ${bold('The changelog is publicly accessible at:')}
    https://raw.githubusercontent.com/Kasikexe/Kasalix/main/${CHANGELOG_FILE}
  `);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }

  // Check prerequisites
  if (!checkGit()) {
    console.log(`  ${red('✘ Git is not installed or not in PATH.')}`);
    console.log(`    Please install Git from https://git-scm.com/`);
    process.exit(1);
  }

  loadToken();
  checkRemote();

  if (!checkToken()) {
    console.log(`  ${yellow('⚠️  ' + TOKEN_ENV_VAR + ' is not set.')}`);
    console.log(`    Without a GitHub token, the tool cannot push to GitHub.`);
    console.log(`    You can still add entries locally and push manually.\n`);
    console.log(`    Set it with:`);
    console.log(`      set ${TOKEN_ENV_VAR}=ghp_xxxxxxxxxxxx\n`);

    const proceed = await new Promise((r) => {
      rl.question(`  Continue without pushing? (y/N): `, r);
    });
    if (proceed.toLowerCase() !== 'y') {
      console.log(`  ${yellow('ℹ')} Exiting.`);
      process.exit(0);
    }
  }

  await interactiveMode();
}

main().catch((err) => {
  console.error(`\n  ${red('✘ Error:')} ${err.message}\n`);
  process.exit(1);
});
