import { promises as fs } from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { streamChat } from './ollama';
import { logger } from './logger';
import { applySearchReplace, diffLines, changedLineCount } from '../utils/edits';
import { withAiRules } from './ai-rules';
import { getWebContext } from './search';
import { getModelAssignment } from './model-assignments';
import { readProjectRules, findAgentMemoryFile, readAgentMemory, appendAgentMemory } from './project-rules';
import { PROTECTED_DIRS, isProtectedPath, protectedDirsLabel } from '../utils/protected-dirs';
const execAsync = promisify(exec);

// ─── Sandbox helpers (same rules as routes/files.ts + /api/terminal) ─────
function resolveWorkspaceRoot(ws?: string): string | null {
  if (!ws || typeof ws !== 'string') return null;
  const resolved = path.resolve(ws);
  if (path.parse(resolved).root === resolved) return null; // reject drive roots
  return resolved;
}

import { isPathInside } from '../utils/containment';

/** Resolve a relative path inside the workspace, or null if it escapes or is protected. */
async function resolveInWorkspace(wsRoot: string, p: string): Promise<string | null> {
  const candidate = path.resolve(wsRoot, p);
  if (isProtectedPath(wsRoot, candidate)) return null;
  if (!(await isPathInside(wsRoot, candidate))) return null;
  return candidate;
}

/** Recursively find existing files in the workspace whose basename matches
 * (case-insensitive), capped. Used to auto-resolve a slightly-wrong path
 * ("main.py" when the file actually lives in Test1/main.py) so small models
 * don't fail just because they dropped a folder prefix. Returns absolute
 * paths, always inside the workspace and never in protected directories. */
export async function findWorkspaceFilesByBasename(root: string, basename: string, maxResults = 10): Promise<string[]> {
  const needle = basename.toLowerCase();
  const found: string[] = [];
  async function walk(dir: string, depth: number) {
    if (depth > 5 || found.length >= maxResults) return;
    if (isProtectedPath(root, dir)) return; // never search server internals
    let entries: import('fs').Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      } else if (e.name.toLowerCase() === needle) {
        found.push(full);
        if (found.length >= maxResults) return;
      }
    }
  }
  await walk(root, 0);
  return found;
}

/** Resolve a path for reading/editing/deleting with a basename fallback.
 * Returns the exact path when it exists inside the workspace; otherwise, when
 * the exact path is inside the workspace but the file is missing (a dropped
 * folder prefix like "main.py" instead of "Test1/main.py"), resolves to the
 * single file that shares its basename. Outside-workspace paths still fail. */
/** True when `p` exists and is a regular file. */
async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

async function resolveTargetSmart(root: string, p: string): Promise<{ target: string | null; resolvedFrom?: string; error?: string }> {
  const exact = await resolveInWorkspace(root, p);
  if (exact) {
    try {
      const st = await fs.stat(exact);
      if (st.isFile()) return { target: exact };
    } catch { /* missing or unreadable — try basename fallback */ }
  }
  // Only fall back when the requested path was INSIDE the workspace (an
  // outside-workspace path must never silently redirect to a different file).
  if (exact) {
    const candidates = await findWorkspaceFilesByBasename(root, path.basename(p));
    if (candidates.length === 1) return { target: candidates[0], resolvedFrom: p };
    if (candidates.length > 1) {
      return { target: null, error: `${p} does not exist, and ${candidates.length} files share that name (${candidates.map((c) => path.relative(root, c).split(path.sep).join('/')).join(', ')}). Specify the full subfolder path.` };
    }
    return { target: null, error: `Could not find ${p} inside the workspace (${root}). Use list_files to see what exists.` };
  }
  return { target: null, error: `Access denied: ${p} is outside the workspace.` };
}

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.DS_Store',
  '__pycache__', '.next', '.nuxt', 'dist', 'build', '.cache',
  'target', 'vendor', '.venv', 'venv', 'env', 'coverage',
]);

// ─── Protected directories ──────────────────────────────────────────────
// When the agent's workspace is this repository itself, these directories are
// the SERVER's internals — the agent must not read, edit, list, search,
// commit, or even reference them. Enforced hard at the tool level (not just a
// prompt rule), so a small model physically cannot touch them. Guard lives in
// ../utils/protected-dirs (shared with the files API).

// ─── User rules (read-only for the agent) ───────────────────────────────
// .agent-rules.md / AGENT_RULES.md are the USER's authoritative rules. The
// agent may READ them (via read_rules) but can never write, edit, delete, or
// run commands that touch them — enforced here at the tool level so a small
// model physically cannot override what the user told it. Agent-written
// project knowledge lives in a SEPARATE file (.agent-memory.md) via
// update_memory, and is lower priority than the user's rules.
const USER_RULES_FILENAMES = ['.agent-rules.md', '.agent-rules', 'AGENT_RULES.md'];

function isUserRulesPath(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  if (rel.includes(path.sep)) return false; // must be the file at the workspace root
  return USER_RULES_FILENAMES.includes(path.basename(target).toLowerCase());
}

const MAX_READ_BYTES = 200 * 1024;       // read_file cap
const MAX_OUTPUT_CHARS = 8000;           // run_command output cap
const MAX_SEARCH_MATCHES = 50;
const MAX_ITERATIONS = 15;               // loop guard
const MAX_HISTORY = 40;                  // bounded tool-loop history

// ─── Transient-error retry ───────────────────────────────────────────────
// A single Ollama/network hiccup must not abort an entire agent run. We retry
// transient failures (connection refused, fetch failed, 5xx, timeouts) with
// backoff, but never retry aborts or clear 4xx errors (bad model/request).
export function isTransientError(e: unknown): boolean {
  if (e instanceof DOMException && e.name === 'AbortError') return false;
  const msg = e instanceof Error ? e.message : String(e);
  if (/AbortError|aborted/i.test(msg)) return false;
  if (/Ollama error \(4\d\d\)/.test(msg)) return false;
  return /fetch failed|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ETIMEDOUT|socket|network|Ollama error \(5\d\d\)|timed\s?out/i.test(msg);
}

/** Stream one model response, retrying transient failures with backoff. */
async function streamChatWithRetry(
  opts: AgentLoopOptions,
  messages: { role: string; content: string }[],
  onChunk: (c: string) => void,
  onThinkingChunk: (c: string) => void
): Promise<string> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const buffered: string[] = [];
    const bufferedThinking: string[] = [];
    try {
      await streamChat(opts.model, messages as any, (c) => buffered.push(c), {
        signal: opts.signal,
        temperature: opts.temperature,
        top_p: opts.top_p,
        max_tokens: opts.max_tokens,
        think: opts.think,
        onThinking: (t) => bufferedThinking.push(t),
      });
      const out = buffered.join('');
      for (const c of buffered) onChunk(c);
      for (const t of bufferedThinking) onThinkingChunk(t);
      return out;
    } catch (e) {
      if (attempt >= maxAttempts || !isTransientError(e) || opts.signal?.aborted) throw e;
      const delay = [1000, 3000, 7000][attempt - 1] ?? 5000;
      opts.callbacks.onStage('agent:retry');
      logger.info(`[agent] Transient model error (${e instanceof Error ? e.message : String(e)}) — retry ${attempt}/${maxAttempts - 1} in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error('streamChatWithRetry exhausted retries');
}

// ─── Context budget ──────────────────────────────────────────────────────
// Long runs with big files can outgrow the model's context even with bounded
// history. Rough token accounting prunes the oldest non-system messages
// (usually old tool results) first, keeping the most recent context.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const MAX_CONTEXT_TOKENS = 16000;

export function pruneToBudget(msgs: { role: string; content: string }[]): { role: string; content: string }[] {
  const system = msgs.filter((m) => m.role === 'system');
  const rest = msgs.filter((m) => m.role !== 'system');
  let total =
    system.reduce((s, m) => s + estimateTokens(m.content), 0) +
    rest.reduce((s, m) => s + estimateTokens(m.content), 0);
  while (rest.length > 6 && total > MAX_CONTEXT_TOKENS) {
    const removed = rest.shift()!;
    total -= estimateTokens(removed.content);
  }
  return [...system, ...rest];
}

// ─── ask_user (mid-task clarification) ───────────────────────────────────
// When the agent calls ask_user, the loop pauses and the frontend shows a
// question modal. The user's answer arrives via POST /api/chat/answer and
// resolves the pending promise below, letting the loop continue.
const pendingQuestions = new Map<string, { resolve: (answer: string) => void }>();

export function resolvePendingQuestion(key: string, answer: string): boolean {
  const p = pendingQuestions.get(key);
  if (!p) return false;
  pendingQuestions.delete(key);
  p.resolve(answer);
  return true;
}

async function askUserQuestion(question: string, opts: AgentLoopOptions): Promise<string> {
  const key = opts.askKey || `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  opts.callbacks.onQuestion?.(key, question);
  return new Promise<string>((resolve, reject) => {
    const onAbort = () => {
      pendingQuestions.delete(key);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    if (opts.signal) {
      if (opts.signal.aborted) { onAbort(); return; }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    pendingQuestions.set(key, {
      resolve: (answer) => {
        opts.signal?.removeEventListener('abort', onAbort);
        resolve(answer);
      },
    });
  });
}

// ─── Tool definitions (exposed to the model) ────────────────────────────

export interface AgentToolDef {
  name: string;
  description: string;
  /** JSON-schema-ish arg names + types, shown to the model as examples */
  args: string;
  /** Whether this tool mutates the workspace (only offered when auto-apply) */
  mutating: boolean;
}

export const AGENT_TOOL_DEFS: AgentToolDef[] = [
  {
    name: 'list_files',
    description: 'List files and directories in the workspace (recursive, ignores node_modules/.git/dist etc). Use this to see what exists before editing.',
    args: '{}',
    mutating: false,
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file inside the workspace. Always read a file BEFORE editing it so you know exactly what is in it. For files larger than 200KB use offset/length to read it in ranges (e.g. offset 200000, length 100000).',
    args: '{"path": "src/index.ts"} or {"path": "src/index.ts", "offset": 200000, "length": 100000}',
    mutating: false,
  },
  {
    name: 'search_files',
    description: 'Search the workspace for a text pattern. Returns matching file paths + line numbers. Use to find where things are defined.',
    args: '{"query": "function render"}',
    mutating: false,
  },
  {
    name: 'run_command',
    description: 'Run a shell command inside the workspace directory (e.g. build, test, install). The command is sandboxed to the workspace. Output is capped.',
    args: '{"command": "bun run build"}',
    mutating: false,
  },
  {
    name: 'web_search',
    description: 'Search the live web and return current, real-time information (docs, APIs, syntax, news). Use when you need up-to-date knowledge that is not in your training data. Results are capped.',
    args: '{"query": "python requests library latest API"}',
    mutating: false,
  },
  {
    name: 'read_image',
    description: 'Describe an image file inside the workspace using the vision model (e.g. screenshots, mockups, diagrams). Returns a detailed plain-text description.',
    args: '{"path": "screenshots/ui.png"}',
    mutating: false,
  },
  {
    name: 'read_rules',
    description: 'Read BOTH the user rules file (.agent-rules.md) and the agent memory file (.agent-memory.md). USER RULES are authoritative — written by the user, follow them strictly, and you can NEVER edit them. AGENT MEMORY is your own notes from previous sessions — lower priority, and if your memory contradicts a user rule, the user rule wins. Read this when you start a task or whenever you are unsure about conventions.',
    args: '{}',
    mutating: false,
  },
  {
    name: 'update_memory',
    description: 'Append a durable lesson to YOUR OWN memory file (.agent-memory.md) so it is remembered across sessions (e.g. "the test command is python -m unittest", "use snake_case"). Duplicates are skipped. You can only write to your memory file — the USER RULES file (.agent-rules.md) is read-only for you and you can never edit it. Use sparingly — only durable, reusable project knowledge, not one-off task notes.',
    args: '{"rule": "The test command is: python -m unittest"}',
    mutating: true,
  },
  {
    name: 'ask_user',
    description: 'Ask the user a short clarifying question mid-task when you genuinely cannot proceed (ambiguous requirements, conflicting instructions, a destructive action you must not assume). The run pauses until the user answers. Use ONLY for questions you cannot answer yourself from the workspace, your rules, or memory — never ask about things you can check yourself.',
    args: '{"question": "Should the new module be TypeScript or plain JavaScript?"}',
    mutating: false,
  },
  {
    name: 'git_status',
    description: 'Show the current git repository state (branch, staged/unstaged changes, untracked files). Run this before committing so you know what changed. Returns an error if the workspace is not a git repo.',
    args: '{}',
    mutating: false,
  },
  {
    name: 'git_diff',
    description: 'Show the exact changes (diff) of files in the workspace. Use this to review your own work and to write an accurate commit message. Returns an error if the workspace is not a git repo.',
    args: '{}',
    mutating: false,
  },
  {
    name: 'git_commit',
    description: 'Stage ALL changes and create a LOCAL git commit with the given summary. ALWAYS write a concise, accurate summary (what changed and why) based on your diff — never generic text like "update files". Uses "Kasalix Agent" as the author unless you pass a name. IMPORTANT: commits are LOCAL ONLY — this tool NEVER pushes to GitHub or any remote, so never claim to have pushed anything. Returns an error if the workspace is not a git repo or there is nothing to commit.',
    args: '{"summary": "Raise max connections to 500 and add retry logic"} or {"summary": "...", "name": "User Name"}',
    mutating: true,
  },
  {
    name: 'edit_file',
    description: 'SURGICAL edit of an existing file: replace an exact snippet (old_string) with new content (new_string). Use this for SMALL changes to existing files instead of rewriting the whole file. old_string must appear exactly once in the file (or differ only in whitespace). ONLY available in auto-apply mode. After a successful edit the result includes a diff summary.',
    args: '{"path": "src/app.ts", "old_string": "const x = 1;", "new_string": "const x = 2;"}',
    mutating: true,
  },
  {
    name: 'write_file',
    description: 'Create a NEW file. If the file already exists, only YOUR CHANGED LINES are applied and everything else in the file is preserved exactly (safe to pass the full new file content — a version that rewrites most of the file is refused). ONLY available in auto-apply mode — the file is written immediately and can be reverted by the user.',
    args: '{"path": "src/app.ts", "content": "..."}',
    mutating: true,
  },
  {
    name: 'delete_file',
    description: 'Delete a file inside the workspace. ONLY available in auto-apply mode — the deletion happens immediately and can be reverted by the user.',
    args: '{"path": "src/old.ts"}',
    mutating: true,
  },
];

const TOOL_JSON_EXAMPLES = `Available tools — to use one, respond with ONLY a single JSON object, no markdown, no other text:

{"tool": "list_files", "args": {}}
{"tool": "read_file", "args": {"path": "src/index.ts"}}
{"tool": "search_files", "args": {"query": "function render"}}
{"tool": "run_command", "args": {"command": "bun run build"}}
{"tool": "edit_file", "args": {"path": "src/app.ts", "old_string": "const x = 1;", "new_string": "const x = 2;"}}
{"tool": "write_file", "args": {"path": "src/app.ts", "content": "..."}} — for an EXISTING file only your changed lines are applied; the rest is preserved
{"tool": "delete_file", "args": {"path": "src/old.ts"}}
{"tool": "git_status", "args": {}}
{"tool": "git_diff", "args": {}}
{"tool": "git_commit", "args": {"summary": "Raise max connections to 500"}}
{"tool": "read_rules", "args": {}}
{"tool": "update_memory", "args": {"rule": "The test command is: python -m unittest"}}
{"tool": "ask_user", "args": {"question": "TypeScript or JavaScript?"}}`;

// ─── Tool execution ─────────────────────────────────────────────────────

interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface AgentToolResult {
  ok: boolean;
  /** Human-readable result to feed back to the model */
  output: string;
  /** Set when a file was written/deleted (for SSE file_written events) */
  fileWrite?: { path: string; changeType: 'created' | 'edited' | 'deleted'; originalContent?: string };
}

async function listWorkspaceTree(root: string): Promise<string> {
  const lines: string[] = [];
  async function walk(dir: string, depth: number) {
    if (depth > 3 || lines.length > 400) return;
    if (isProtectedPath(root, dir)) return; // never even list server internals
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    for (const e of entries) {
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/'); // forward slashes always
      if (e.isDirectory()) {
        lines.push('  '.repeat(depth) + rel + '/');
        await walk(full, depth + 1);
      } else {
        let size = '';
        try {
          const s = await fs.stat(full);
          size = s.size < 1024 ? ` (${s.size}B)` : ` (${(s.size / 1024).toFixed(1)}KB)`;
        } catch { /* skip */ }
        lines.push('  '.repeat(depth) + rel + size);
      }
    }
  }
  await walk(root, 0);
  return lines.length > 0 ? lines.join('\n') : '(empty workspace)';
}

// ─── Workspace profile (language + key files) ───────────────────────────
// Small models easily lose track of WHAT a project is. Detecting the dominant
// language up front and re-stating it in every loop iteration keeps the agent
// from drifting into wrong-language files (e.g. creating config.js in a Python
// project).

const LANGUAGE_EXT_MAP: Record<string, string> = {
  py: 'Python', ts: 'TypeScript', tsx: 'TypeScript/React', js: 'JavaScript', jsx: 'JavaScript/React',
  c: 'C', h: 'C/C++', cpp: 'C++', hpp: 'C++', cs: 'C#', java: 'Java', kt: 'Kotlin',
  go: 'Go', rs: 'Rust', rb: 'Ruby', php: 'PHP', swift: 'Swift',
  html: 'HTML', css: 'CSS', scss: 'SCSS', vue: 'Vue', svelte: 'Svelte',
  sql: 'SQL', sh: 'Shell', bat: 'Batch', ps1: 'PowerShell',
};

/** Marker files that strongly identify a project type (checked case-insensitively). */
const PROJECT_MARKERS: { pattern: RegExp; label: string }[] = [
  { pattern: /^requirements\.txt$/i, label: 'Python (requirements.txt)' },
  { pattern: /^pyproject\.toml$/i, label: 'Python (pyproject.toml)' },
  { pattern: /^setup\.py$/i, label: 'Python (setup.py)' },
  { pattern: /^Pipfile$/i, label: 'Python (Pipfile)' },
  { pattern: /^manage\.py$/i, label: 'Python/Django (manage.py)' },
  { pattern: /^package\.json$/i, label: 'JavaScript/Node (package.json)' },
  { pattern: /^tsconfig\.json$/i, label: 'TypeScript (tsconfig.json)' },
  { pattern: /^go\.mod$/i, label: 'Go (go.mod)' },
  { pattern: /^Cargo\.toml$/i, label: 'Rust (Cargo.toml)' },
  { pattern: /^pom\.xml$/i, label: 'Java/Maven (pom.xml)' },
  { pattern: /^build\.gradle$/i, label: 'Java/Gradle (build.gradle)' },
  { pattern: /^Gemfile$/i, label: 'Ruby (Gemfile)' },
  { pattern: /^composer\.json$/i, label: 'PHP (composer.json)' },
  { pattern: /^index\.html$/i, label: 'Web (index.html)' },
];

/** Count source files by extension and collect the most relevant ones. */
export async function detectProjectProfile(root: string): Promise<{
  language: string | null;
  extensions: { ext: string; count: number; label: string }[];
  keyFiles: string[];
}> {
  const counts = new Map<string, number>();
  const keyFiles: string[] = [];
  // First matching project marker wins (markers are ordered by priority)
  let markerLabel: string | null = null;

  async function walk(dir: string, depth: number) {
    if (depth > 4 || keyFiles.length > 25) return;
    if (isProtectedPath(root, dir)) return; // never even index server internals
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (e.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      const ext = (e.name.split('.').pop() || '').toLowerCase();
      if (ext && ext !== e.name.toLowerCase()) {
        counts.set(ext, (counts.get(ext) || 0) + 1);
      }
      // Collect marker files + the biggest source files as "key files"
      if (markerLabel === null) {
        const marker = PROJECT_MARKERS.find((m) => m.pattern.test(e.name));
        if (marker) markerLabel = marker.label;
      }
      if (markerLabel && keyFiles.length < 15) {
        keyFiles.push(`${rel} (${e.name})`);
      } else if (LANGUAGE_EXT_MAP[ext] && keyFiles.length < 15) {
        keyFiles.push(rel);
      }
    }
  }
  await walk(root, 0);

  const extensions = [...counts.entries()]
    .filter(([ext]) => LANGUAGE_EXT_MAP[ext])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([ext, count]) => ({ ext, count, label: LANGUAGE_EXT_MAP[ext] }));

  // Language priority: marker file (first found, by marker priority) > dominant source extension
  const language = markerLabel ?? (extensions.length > 0 ? extensions[0].label : null);

  return { language, extensions, keyFiles: [...new Set(keyFiles)].slice(0, 20) };
}

/** Render the profile as a compact block the model reads in every iteration. */
export async function buildWorkspaceProfile(root: string, verifyCommand?: string | null, projectRules?: string | null, agentMemory?: string | null): Promise<string> {
  const profile = await detectProjectProfile(root);
  const lines: string[] = ['WORKSPACE PROFILE (read this — it tells you what kind of project this is):'];
  if (profile.language) {
    lines.push(`- Project language: ${profile.language}`);
  } else {
    lines.push('- Project language: unknown — use list_files + read_file to determine it before making changes');
  }
  if (profile.extensions.length > 0) {
    const extSummary = profile.extensions.map((e) => `${e.label} (.${e.ext} × ${e.count})`).join(', ');
    lines.push(`- Source files: ${extSummary}`);
  }
  if (profile.keyFiles.length > 0) {
    lines.push('- Key files: ' + profile.keyFiles.slice(0, 12).join(', '));
  }
  if (verifyCommand) {
    lines.push(`- Verify command: ${verifyCommand} (auto-run after every file change to check your work)`);
  }
  lines.push(`- User rules: ${projectRules ? 'stored in .agent-rules.md (authoritative — follow them strictly, you can never edit them)' : 'none yet — the user can create .agent-rules.md for standing instructions'}`);
  lines.push(`- Agent memory: ${agentMemory ? 'stored in .agent-memory.md (your own notes — lower priority than user rules)' : 'none yet — use update_memory to save durable project knowledge'}`);
  lines.push(`- PROTECTED directories (NEVER read, list, search, edit, commit, or run commands referencing them — they are server internals): ${protectedDirsLabel()}`);
  lines.push('- RULE: Match the project language above for ALL new or edited files. Do NOT create files in a different language than the project unless the user explicitly asks for that language.');
  return lines.join('\n');
}

/**
 * Accurate minimal diff summary (old → new) using a real line diff, capped so
 * the model is not flooded. Unlike positional comparison this shows ONLY the
 * lines that actually changed — even when a model re-emits a whole file, a
 * one-line edit reports one changed line.
 */
export function summarizeDiff(path: string, oldContent: string, newContent: string): string {
  const oldLines = oldContent.replace(/\r\n/g, '\n').split('\n');
  const newLines = newContent.replace(/\r\n/g, '\n').split('\n');
  const hunks = diffLines(oldLines, newLines);
  if (!hunks) return `Diff for ${path}: (files differ too much to summarize) — read the file and re-apply your change as a targeted edit.`;
  const parts: string[] = [];
  let changed = 0;
  const CAP = 30;
  for (const h of hunks) {
    changed += Math.max(h.oldCount, h.newCount);
    for (let i = 0; i < h.oldCount; i++) {
      if (parts.length >= CAP) { parts.push('  ... (more)'); break; }
      parts.push(`- ${oldLines[h.oldStart + i]}`);
    }
    if (parts.length >= CAP) break;
    for (let i = 0; i < h.newCount; i++) {
      if (parts.length >= CAP) { parts.push('  ... (more)'); break; }
      parts.push(`+ ${newLines[h.newStart + i]}`);
    }
  }
  return `Diff for ${path} (${changed} changed line(s)):\n${parts.join('\n') || '  (no changes)'}`;
}

/** Detect the most useful run/test command for a project, if any. */
export async function detectVerifyCommand(root: string): Promise<{ command: string; label: string; isTest: boolean } | null> {
  // Per-workspace override via .agent-config.json:
  //   { "verifyCommand": "npm run lint", "verifyLabel": "lint", "verifyEnabled": true }
  // Setting verifyEnabled:false disables auto-verify entirely for this project.
  try {
    const cfgRaw = await fs.readFile(path.join(root, '.agent-config.json'), 'utf-8');
    const cfg = JSON.parse(cfgRaw);
    if (cfg && cfg.verifyEnabled === false) return null;
    if (cfg && typeof cfg.verifyCommand === 'string' && cfg.verifyCommand.trim()) {
      return {
        command: cfg.verifyCommand.trim(),
        label: typeof cfg.verifyLabel === 'string' && cfg.verifyLabel.trim() ? cfg.verifyLabel.trim() : 'custom verify',
        isTest: false,
      };
    }
  } catch { /* no .agent-config.json */ }

  const candidates: { command: string; label: string; isTest: boolean }[] = [];

  // Node: package.json scripts (test > build). Skip start — dev servers hang.
  try {
    const pkgRaw = await fs.readFile(path.join(root, 'package.json'), 'utf-8');
    const pkg = JSON.parse(pkgRaw);
    const scripts: Record<string, string> = pkg?.scripts || {};
    if (typeof scripts.test === 'string') candidates.push({ command: `npm test --prefix "${root}"`, label: 'npm test', isTest: true });
    else if (typeof scripts.build === 'string') candidates.push({ command: `npm run build --prefix "${root}"`, label: 'npm run build', isTest: false });
  } catch { /* no package.json */ }

  // Python: prefer a venv interpreter. Only suggest real test commands when
  // test infrastructure exists (tests/ dir, pytest.ini, setup.cfg, pyproject
  // with pytest config); otherwise fall back to a cheap syntax check on the
  // main script so we still catch broken edits without noisy failures.
  const pyEnv = await (async () => {
    for (const p of ['venv', '.venv']) {
      try {
        const bin = path.join(root, p, process.platform === 'win32' ? 'Scripts' : 'bin');
        await fs.access(path.join(bin, process.platform === 'win32' ? 'python.exe' : 'python'));
        return path.join(bin, process.platform === 'win32' ? 'python.exe' : 'python');
      } catch { /* try next */ }
    }
    return null;
  })();
  const pyCmd = pyEnv ? `"${pyEnv}"` : 'python';
  const hasPyTests = await (async () => {
    try { await fs.access(path.join(root, 'tests')); return true; } catch { /* no */ }
    for (const f of ['pytest.ini', 'setup.cfg', 'pyproject.toml']) {
      try {
        const raw = await fs.readFile(path.join(root, f), 'utf-8');
        if (/pytest/i.test(raw)) return true;
      } catch { /* no */ }
    }
    return false;
  })();
  if (hasPyTests) {
    candidates.push({ command: `${pyCmd} -m pytest -q`, label: 'pytest', isTest: true });
    candidates.push({ command: `${pyCmd} -m unittest discover -q`, label: 'unittest', isTest: true });
  } else {
    // Script-only project: verify syntax of the main .py scripts (searched in
    // subfolders too, so a project inside a folder like Test1/ is still
    // checked) — catches broken edits without a real test suite.
    const pyMain = await findMainScript(root, ['.py']);
    if (pyMain) {
      candidates.push({ command: `${pyCmd} -m py_compile "${pyMain}"`, label: 'python syntax check', isTest: false });
    }
  }

  // Node project WITHOUT a test/build script: a lone JS file still gets a
  // syntax check so broken edits are caught instead of silently shipped.
  try {
    await fs.access(path.join(root, 'package.json'));
  } catch {
    const jsMain = await findMainScript(root, ['.js', '.mjs', '.cjs']);
    if (jsMain) {
      candidates.push({ command: `node --check "${jsMain}"`, label: 'node syntax check', isTest: false });
    }
  }

  // Rust / Go / others
  try { await fs.access(path.join(root, 'Cargo.toml')); candidates.push({ command: 'cargo test', label: 'cargo test', isTest: true }); } catch { /* no */ }
  try { await fs.access(path.join(root, 'go.mod')); candidates.push({ command: 'go test ./...', label: 'go test', isTest: true }); } catch { /* no */ }
  try { await fs.access(path.join(root, 'Makefile')); candidates.push({ command: 'make test', label: 'make test', isTest: true }); } catch { /* no */ }

  // Prefer a test command over a build command; first match wins per ecosystem.
  const chosen =
    candidates.find((c) => c.isTest && c.label === 'npm test') ||
    candidates.find((c) => c.label === 'npm run build') ||
    candidates.find((c) => c.label === 'pytest' || c.label === 'unittest') ||
    candidates.find((c) => c.label === 'python syntax check') ||
    candidates.find((c) => c.label === 'node syntax check') ||
    candidates.find((c) => c.isTest) ||
    null;
  return chosen;
}

/** Find the best "main" script in the workspace for the given extensions:
 * prefers a file named main/index/app at the root or shallow depth, else the
 * first matching file up to 3 levels deep. Returns an absolute path or null. */
async function findMainScript(root: string, extensions: string[]): Promise<string | null> {
  const wanted = extensions.map((e) => e.toLowerCase());
  const matches: string[] = [];
  const preferredNames = new Set(['main', 'index', 'app']);
  async function walk(dir: string, depth: number) {
    if (depth > 3 || matches.length >= 20) return;
    if (isProtectedPath(root, dir)) return; // never index server internals
    let entries: import('fs').Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      } else {
        const ext = (e.name.split('.').pop() || '').toLowerCase();
        if (!wanted.includes(ext)) continue;
        const stem = e.name.replace(/\.[^.]+$/, '').toLowerCase();
        if (preferredNames.has(stem) && matches.length < 3) {
          matches.unshift(full); // main/index/app get priority
        } else {
          matches.push(full);
        }
      }
    }
  }
  await walk(root, 0);
  return matches[0] || null;
}

/** Send a workspace image to the vision model and return a text description. */
async function describeImage(target: string): Promise<string> {
  const buf = await fs.readFile(target);
  const b64 = buf.toString('base64');
  const MIME_BY_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
  const ext = (target.match(/\.(png|jpe?g|gif|webp|bmp)$/i) || [])[1]?.toLowerCase() || 'png';
  const mime = MIME_BY_EXT[ext] || 'image/png';
  const visionModel = await getModelAssignment('vision');
  let description = '';
  await streamChat(
    visionModel,
    [
      {
        role: 'system',
        content: 'You are a vision description assistant. Describe what you see in the image in plain text: layout, colors, text content, structure, UI elements. Be specific and technical. 2-4 paragraphs, no code blocks.',
      },
      {
        role: 'user',
        content: `Describe this image: [image:data:${mime};base64,${b64}]`,
      },
    ],
    (chunk) => { description += chunk; },
    { think: false }
  );
  return description.trim() || '(vision model returned no description)';
}

// git_commit is mutating, but committing should NOT trigger an auto-verify
// (the code was already verified before the commit). It stays out of this set.
// update_memory is mutating (writes the agent memory file) — but it must NOT
// trigger auto-verification (running tests after editing a memory file is pointless).
const MUTATING_TOOLS = new Set(['edit_file', 'write_file', 'delete_file']);

/** Git pathspec exclusions so protected dirs never appear in status/diff/commits. */
function gitExcludeArgs(): string[] {
  const args: string[] = ['--', '.'];
  for (const dir of PROTECTED_DIRS) {
    args.push(`:(exclude)${dir}`);
  }
  return args;
}

/** Run a git command inside the workspace; returns stdout or throws.
 * Args are shell-quoted (cmd.exe on Windows) so characters like `<`, `>`,
 * spaces and quotes inside messages survive the shell. */
export async function runGit(root: string, args: string[]): Promise<string> {
  const quoted = args.map((a) => {
    // Only quote when needed; always quote anything with spaces or shell chars.
    if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(a)) return a;
    return '"' + a.replace(/"/g, "'") + '"';
  });
  const { stdout, stderr } = await execAsync(`git ${quoted.join(' ')}`, {
    cwd: root,
    timeout: 30000,
    shell: true,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  } as any);
  return ((stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : '')).trim();
}

export async function executeTool(root: string, call: ToolCall, autoApply: boolean): Promise<AgentToolResult> {
  const args = call.args || {};

  switch (call.tool) {
    case 'list_files': {
      const tree = await listWorkspaceTree(root);
      return { ok: true, output: `Workspace files:\n${tree}` };
    }

    case 'read_file': {
      const p = typeof args.path === 'string' ? args.path : '';
      if (!p) return { ok: false, output: 'read_file requires a "path" string argument.' };
      let target = await resolveInWorkspace(root, p);
      let resolvedFrom: string | undefined;
      if (target) {
        try {
          const stat = await fs.stat(target);
          if (!stat.isFile()) target = null; // directory or missing — try basename match below
        } catch { target = null; }
      }
      if (!target) {
        // The exact path doesn't exist — a small model may have dropped a
        // folder prefix ("main.py" instead of "Test1/main.py"). Resolve by
        // basename so the file is still found instead of giving up.
        const candidates = await findWorkspaceFilesByBasename(root, path.basename(p));
        if (candidates.length === 1) {
          target = candidates[0];
          resolvedFrom = p;
        } else if (candidates.length > 1) {
          return { ok: false, output: `${p} does not exist, and ${candidates.length} files share that name (${candidates.map((c) => path.relative(root, c).split(path.sep).join('/')).join(', ')}). Read or list one of those to pick the right one.` };
        }
      }
      if (!target) return { ok: false, output: `Could not find ${p} inside the workspace (${root}). It may be in a subfolder — use list_files to see what exists, or ask the user to open the chat with the correct folder.` };
      try {
        const stat = await fs.stat(target);
        if (stat.isDirectory()) return { ok: false, output: `${p} is a directory. Use list_files instead.` };
        // Range reads (offset/length in bytes) let the agent page through big files.
        const offset = typeof args.offset === 'number' && args.offset >= 0 ? Math.floor(args.offset) : 0;
        const length = typeof args.length === 'number' && args.length > 0 ? Math.floor(args.length) : MAX_READ_BYTES;
        // Read ONLY the requested chunk via a file handle — never load the
        // whole file into memory (that defeats range paging on big files).
        const fh = await fs.open(target, 'r');
        let text: string;
        try {
          const buf = Buffer.alloc(Math.min(length, Math.max(0, stat.size - offset)));
          if (buf.length > 0) {
            const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
            text = buf.subarray(0, bytesRead).toString('utf-8');
          } else {
            text = '';
          }
        } finally {
          await fh.close();
        }
        const suffix = offset > 0 || stat.size > offset + length
          ? ` (bytes ${offset}-${offset + length} of ${stat.size} — use read_file with offset=${offset + length} to continue)`
          : '';
        const actual = resolvedFrom ? ` (resolved from "${resolvedFrom}" — the real path is ${path.relative(root, target).split(path.sep).join('/')})` : '';
        return { ok: true, output: `File ${p}${suffix}${actual}:\n${text}` };
      } catch (e) {
        return { ok: false, output: `Could not read ${p}: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    case 'web_search': {
      const q = typeof args.query === 'string' ? args.query : '';
      if (!q) return { ok: false, output: 'web_search requires a "query" string argument.' };
      try {
        const ctx = await getWebContext(q);
        if (!ctx) return { ok: true, output: 'Web search returned no results for that query.' };
        const capped = ctx.length > MAX_OUTPUT_CHARS ? ctx.slice(0, MAX_OUTPUT_CHARS) + '\n...[truncated]' : ctx;
        return { ok: true, output: `[WEB SEARCH RESULTS — CURRENT AND LIVE]\n${capped}` };
      } catch (e) {
        return { ok: false, output: `Web search failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    case 'read_image': {
      const p = typeof args.path === 'string' ? args.path : '';
      if (!p) return { ok: false, output: 'read_image requires a "path" string argument.' };
      const target = await resolveInWorkspace(root, p);
      if (!target) return { ok: false, output: `Access denied: ${p} is outside the workspace.` };
      try {
        const stat = await fs.stat(target);
        if (stat.size > 10 * 1024 * 1024) return { ok: false, output: `${p} is ${(stat.size / 1024 / 1024).toFixed(1)}MB — too large to describe (max 10MB).` };
        const description = await describeImage(target);
        return { ok: true, output: `Vision description of ${p}:\n${description}` };
      } catch (e) {
        return { ok: false, output: `Could not describe ${p}: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    case 'read_rules': {
      const rules = await readProjectRules(root);
      const memory = await readAgentMemory(root);
      const parts: string[] = [];
      if (rules) {
        parts.push(`[USER RULES — authoritative, written by the user. Follow them strictly. You can NEVER edit or override this file.]\n${rules}`);
      } else {
        parts.push('[USER RULES] No user rules file exists yet (.agent-rules.md). The user can create one to give you standing instructions.');
      }
      if (memory) {
        const memoryPath = await findAgentMemoryFile(root);
        parts.push(`[AGENT MEMORY — your own notes from previous sessions (${memoryPath}). Lower priority than user rules: if this contradicts a user rule, the user rule wins.]\n${memory}`);
      } else {
        parts.push('[AGENT MEMORY] No memory saved yet — use update_memory when you learn something durable about the project.');
      }
      return { ok: true, output: parts.join('\n\n') };
    }

    case 'update_memory': {
      const rule = typeof args.rule === 'string' ? args.rule : '';
      if (!rule.trim()) return { ok: false, output: 'update_memory requires a "rule" string argument.' };
      try {
        const filePath = await appendAgentMemory(root, rule);
        return { ok: true, output: `Memory saved to ${path.basename(filePath)} (your own notes — lower priority than user rules). It will apply from now on.` };
      } catch (e) {
        return { ok: false, output: `Failed to update memory: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    case 'git_status': {
      try {
        const out = await runGit(root, ['status', '--short', '--branch', ...gitExcludeArgs()]);
        return { ok: true, output: out || '(clean working tree — nothing changed)' };
      } catch (e) {
        return { ok: false, output: `git status failed (is this a git repository?): ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    case 'git_diff': {
      try {
        const exclude = gitExcludeArgs();
        const staged = await runGit(root, ['diff', '--cached', '--stat', ...exclude]);
        const unstaged = await runGit(root, ['diff', '--stat', ...exclude]);
        // Include the actual changed lines (first hunk) so the model can write
        // an accurate commit message, not just file-level stats.
        let hunks = '';
        try {
          const rawHunks = await runGit(root, ['diff', '-U0', ...exclude]);
          hunks = rawHunks.trim() ? `\n[CHANGED LINES]\n${rawHunks.slice(0, 2000)}` : '';
        } catch { /* no diff */ }
        let out = (staged ? `[STAGED]\n${staged}\n` : '') + (unstaged ? `[UNSTAGED]\n${unstaged}\n` : '') + hunks;
        if (!out.trim()) {
          let status = '';
          try { status = await runGit(root, ['status', '--short', ...exclude]); } catch { /* not a repo */ }
          out = status.trim()
            ? `No tracked changes yet — new/untracked files present:\n${status}\n(use git_commit to stage and commit them)`
            : '(working tree is clean) — nothing to diff.';
        }
        const capped = out.length > MAX_OUTPUT_CHARS ? out.slice(0, MAX_OUTPUT_CHARS) + '\n...[truncated]' : out;
        return { ok: true, output: capped };
      } catch (e) {
        return { ok: false, output: `git diff failed (is this a git repository?): ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    case 'git_commit': {
      const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
      if (!summary) return { ok: false, output: 'git_commit requires a "summary" string argument (what changed and why).' };
      try {
        const status = await runGit(root, ['status', '--short']);
        if (!status.trim()) return { ok: true, output: 'Nothing to commit — the working tree is clean.' };
        const author = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : 'Kasalix Agent';
        const email = 'agent@kasalix.local';
        // Stage everything EXCEPT protected server dirs — they must never be committed.
        await runGit(root, ['add', '-A', ...gitExcludeArgs()]);
        // If only protected files were modified, there is nothing left to commit.
        const staged = await runGit(root, ['diff', '--cached', '--name-only', ...gitExcludeArgs()]);
        if (!staged.trim()) {
          return { ok: true, output: 'Nothing to commit — the only changed files are in protected server directories (not tracked by the agent).' };
        }
        // -c flags set the identity inline so commits work even without global git config
        await runGit(root, [
          '-c', `user.name=${author}`,
          '-c', `user.email=${email}`,
          'commit', '-m', summary.replace(/"/g, "'"),
          '--author', `${author} <${email}>`,
        ]);
        // The commit itself succeeded — the log read is best-effort (fails on
        // fresh repos with a first-ever commit; that must NOT look like a failure).
        let log = '';
        try {
          log = await runGit(root, ['log', '-1', '--stat', '--oneline']);
        } catch { /* no commits before this one */ }
        return { ok: true, output: `Committed LOCALLY as ${author} — this was NOT pushed to GitHub or any remote (this tool never pushes).\n${log.slice(0, MAX_OUTPUT_CHARS)}` };
      } catch (e) {
        return { ok: false, output: `git commit failed (is this a git repository?): ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    case 'search_files': {
      const q = typeof args.query === 'string' ? args.query : '';
      if (!q) return { ok: false, output: 'search_files requires a "query" string argument.' };
      const matches: string[] = [];
      async function walk(dir: string, depth: number) {
        if (depth > 4 || matches.length >= MAX_SEARCH_MATCHES) return;
        if (isProtectedPath(root, dir)) return; // never search server internals
        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch { return; }
        for (const e of entries) {
          if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            await walk(full, depth + 1);
          } else {
            const rel = path.relative(root, full).split(path.sep).join('/');
            try {
              const stat = await fs.stat(full);
              if (stat.size > MAX_READ_BYTES) continue;
              const content = await fs.readFile(full, 'utf-8');
              const lines = content.split('\n');
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].toLowerCase().includes(q.toLowerCase())) {
                  matches.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 160)}`);
                  if (matches.length >= MAX_SEARCH_MATCHES) return;
                }
              }
            } catch { /* skip binary/unreadable */ }
          }
        }
      }
      await walk(root, 0);
      if (matches.length === 0) return { ok: true, output: `No matches for "${q}" in the workspace.` };
      return { ok: true, output: `Matches for "${q}":\n${matches.join('\n')}` };
    }

    case 'run_command': {
      const cmd = typeof args.command === 'string' ? args.command : '';
      if (!cmd) return { ok: false, output: 'run_command requires a "command" string argument.' };
      // Same dangerous-command block as /api/terminal, PLUS agent-specific
      // guards: no absolute-path reads (Windows drive letters), no `cd ..`
      // escapes, no environment exfiltration via %VAR% / $VAR reads.
      const dangerous = /\b(rm\s+-[rf]\s+\/|format\s+[c-z]:\s*\/q|dd\s+if=|mkfs\.|fdisk|shutdown\s+-[rh]\s+-t\s+0|del\s+\/f\s+\/s)/i;
      const escapesWorkspace =
        /(^|[;&|])\s*cd\s+(\.\.|~|\/|\\\\|[A-Za-z]:[\\/])/i.test(cmd) ||   // cd .. / cd ~ / cd C:\
        /[A-Za-z]:[\\/][^\s"']*/i.test(cmd) ||                                 // absolute Windows paths
        /\$HOME|%USERPROFILE%|%APPDATA%|%LOCALAPPDATA%|%TEMP%|%WINDIR%|%SYSTEM32%/i.test(cmd); // env reads
      // Never run commands that reference server-internal directories.
      // Token-based check: a token is a path into a protected dir if it equals
      // the dir name or starts with it followed by / or \\ (covers cd backend,
      // backend\src\index.ts, ./backend/... and quoted paths) — without false
      // positives on words that merely contain the name.
      const touchesProtected = cmd.split(/[\s]+/).some((tok) => {
        const t = tok.replace(/^["'(`]+|["')\]`]+$/g, '');
        if (!t) return false;
        const lower = t.toLowerCase();
        return PROTECTED_DIRS.some((dir) => {
          const d = dir.toLowerCase();
          return lower === d ||
            lower.startsWith(d + '/') || lower.startsWith(d + '\\') ||
            lower.startsWith('./' + d + '/') || lower.startsWith('./' + d + '\\') ||
            // ..\backend and ../backend traversal (runs from cwd=workspace)
            lower.startsWith('../' + d + '/') || lower.startsWith('../' + d + '\\') ||
            lower.startsWith('..\\' + d + '/') || lower.startsWith('..\\' + d + '\\') ||
            lower === '../' + d || lower === '..\\' + d;
        });
      });
      // Never run commands that modify the USER RULES file — it is read-only for the agent.
      const touchesRulesFile = cmd.split(/[\s]+/).some((tok) => {
        const t = tok.replace(/^["'(`]+|["')]`]+$/g, '');
        if (!t) return false;
        const lower = t.toLowerCase().replace(/\\/g, '/');
        return USER_RULES_FILENAMES.some((f) => {
          const fl = f.toLowerCase();
          return lower === fl || lower.endsWith('/' + fl) || lower.startsWith('./' + fl);
        });
      });
      if (dangerous.test(cmd) || escapesWorkspace || touchesProtected || touchesRulesFile) {
        return { ok: false, output: `Command blocked for security (must stay inside the workspace and must not touch protected directories or the USER RULES file: ${protectedDirsLabel()}).` };
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await execAsync(cmd, {
          cwd: root,
          timeout: 60000,
          shell: true,
          windowsHide: true,
          maxBuffer: 10 * 1024 * 1024,
        } as any);
        const out = (result.stdout + (result.stderr ? `\n[stderr]\n${result.stderr}` : '')).trim();
        const capped = out.length > MAX_OUTPUT_CHARS ? out.slice(-MAX_OUTPUT_CHARS) + '\n...[output truncated]' : out;
        return { ok: true, output: capped || '(command finished with no output)' };
      } catch (e: any) {
        const stderr = e?.stderr ? String(e.stderr) : (e instanceof Error ? e.message : String(e));
        const capped = stderr.length > MAX_OUTPUT_CHARS ? stderr.slice(-MAX_OUTPUT_CHARS) + '\n...[output truncated]' : stderr;
        return { ok: false, output: `Command exited with code ${e?.code ?? '?'}:\n${capped}` };
      }
    }

    case 'edit_file': {
      if (!autoApply) return { ok: false, output: 'edit_file is disabled — auto-apply mode is OFF. Include the change in your final answer using the EDIT code-block convention instead.' };
      const p = typeof args.path === 'string' ? args.path : '';
      const oldString = typeof args.old_string === 'string' ? args.old_string : '';
      const newString = typeof args.new_string === 'string' ? args.new_string : '';
      if (!p || !oldString) return { ok: false, output: 'edit_file requires "path", "old_string" and "new_string" string arguments.' };
      const res = await resolveTargetSmart(root, p);
      if (res.error) return { ok: false, output: res.error };
      const target = res.target!;
      const resolvedNote = res.resolvedFrom ? ` (resolved from "${res.resolvedFrom}" — real path ${path.relative(root, target).split(path.sep).join('/')})` : '';
      if (isUserRulesPath(root, target)) {
        return { ok: false, output: `Access denied: ${p} is the USER RULES file — it is read-only for you. The user edits it themselves. Save project knowledge to your own memory file (.agent-memory.md) with update_memory instead.` };
      }
      try {
        let originalContent: string;
        try {
          originalContent = await fs.readFile(target, 'utf-8');
        } catch {
          return { ok: false, output: `Could not read ${p} — the file may not exist. Use write_file to create it.` };
        }
        const result = applySearchReplace(originalContent, oldString, newString);
        if (!result.ok || result.newContent === undefined) {
          return { ok: false, output: `Edit failed: ${result.error || 'unknown error'}` };
        }
        // REFUSE edits that replace most of the file (e.g. old_string = the
        // whole file). A targeted edit changes a handful of lines; anything
        // rewrite-scale must be done deliberately, not as a side effect.
        const { count: changed, total } = changedLineCount(
          originalContent.replace(/\r\n/g, '\n'),
          result.newContent.replace(/\r\n/g, '\n')
        );
        if (changed > Math.max(20, Math.floor(total * 0.4))) {
          return {
            ok: false,
            output: `Refusing this edit of ${p}: it changes ${changed} of ${total} lines — that replaces most of the file instead of a targeted change. Use a SMALLER old_string that matches only the lines you are changing (include a couple of surrounding lines for uniqueness). If the USER really asked to rewrite the whole file, describe the new version in your final message and let the user apply it, instead of rewriting it yourself.`,
          };
        }
        // Preserve the file's existing line-ending style.
        const finalContent = originalContent.includes('\r\n')
          ? result.newContent.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
          : result.newContent;
        await fs.writeFile(target, finalContent, 'utf-8');
        const diff = summarizeDiff(p, originalContent, finalContent);
        return {
          ok: true,
          output: `Edited ${p}.\n${diff}`,
          fileWrite: { path: p, changeType: 'edited', originalContent },
        };
      } catch (e) {
        return { ok: false, output: `Failed to edit ${p}: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    case 'write_file': {
      if (!autoApply) return { ok: false, output: 'write_file is disabled — auto-apply mode is OFF. Include the file content in your final answer as a code block with the path as the first comment line.' };
      const p = typeof args.path === 'string' ? args.path : '';
      const content = typeof args.content === 'string' ? args.content : '';
      if (!p) return { ok: false, output: 'write_file requires "path" and "content" arguments.' };
      const exact = await resolveInWorkspace(root, p);
      if (!exact) return { ok: false, output: `Access denied: ${p} is outside the workspace.` };
      let target = exact;
      let resolvedFrom: string | undefined;
      // If the exact path doesn't exist but a single file with the same
      // basename exists elsewhere ("main.py" vs "Test1/main.py"), treat this
      // as an edit of that real file instead of silently creating a duplicate.
      if (!(await isFile(exact))) {
        const candidates = await findWorkspaceFilesByBasename(root, path.basename(p));
        if (candidates.length === 1) {
          target = candidates[0];
          resolvedFrom = p;
        } else if (candidates.length > 1) {
          return { ok: false, output: `${p} does not exist, and ${candidates.length} files share that name (${candidates.map((c) => path.relative(root, c).split(path.sep).join('/')).join(', ')}). Specify the full subfolder path.` };
        }
      }
      const resolvedNote = resolvedFrom ? ` (resolved from "${resolvedFrom}" — real path ${path.relative(root, target).split(path.sep).join('/')})` : '';
      if (isUserRulesPath(root, target)) {
        return { ok: false, output: `Access denied: ${p} is the USER RULES file — it is read-only for you. The user edits it themselves. Save project knowledge to your own memory file (.agent-memory.md) with update_memory instead.` };
      }
      try {
        let originalContent: string | undefined;
        let changeType: 'created' | 'edited' = 'created';
        try {
          const existing = await fs.readFile(target, 'utf-8');
          originalContent = existing;
          changeType = 'edited';
        } catch { /* new file */ }

        if (changeType === 'edited') {
          const orig = originalContent!; // 'edited' is only set when the read succeeded
          if (orig === content) {
            return { ok: true, output: `${p} already has exactly this content — no change needed.` };
          }
          // DIFF-BASED SURGICAL APPLY: measure how much of the file the proposed
          // version actually changes. Even when a model re-emits the whole file
          // ("rewrite"), only its real changes are applied — the rest of the file
          // is preserved. A version that genuinely rewrites most of the file is
          // REFUSED (unless force:true, which the model should never use). EOL
          // differences are normalized so they never count as edits.
          const normOld = orig.replace(/\r\n/g, '\n');
          const normNew = content.replace(/\r\n/g, '\n');
          const { count: changed, total, hunks } = changedLineCount(normOld, normNew);
          const isSmallEdit = changed <= Math.max(20, Math.floor(total * 0.4));
          if (!isSmallEdit && args.force !== true) {
            return {
              ok: false,
              output: `Refusing to overwrite ${p}: your version changes ${changed} of ${total} lines — that is a full rewrite of the file, not an edit. Re-read the file and re-emit it preserving ALL unchanged lines exactly (change only the lines you intend), or use edit_file with a small old_string that matches just the lines you are changing. If the USER really asked to rewrite the whole file, describe the new version in your final message and let the user apply it, instead of rewriting it yourself.`,
            };
          }
          // Preserve the file's existing line-ending style.
          const finalContent = orig.includes('\r\n')
            ? normNew.replace(/\n/g, '\r\n')
            : normNew;
          await fs.writeFile(target, finalContent, 'utf-8');
          // Count "changed lines" the same way summarizeDiff does (max of
          // removed/added per hunk) so the two numbers agree in one message.
          const displayChanged = hunks
            ? hunks.reduce((s, h) => s + Math.max(h.oldCount, h.newCount), 0)
            : changed;
          const changeLabel = Number.isFinite(displayChanged)
            ? `changed ${displayChanged} line${displayChanged === 1 ? '' : 's'}`
            : 'rewrote the file';
          return {
            ok: true,
            output: `Updated ${p} — ${changeLabel}.\n${summarizeDiff(p, orig, finalContent)}`,
            fileWrite: { path: p, changeType: 'edited', originalContent: orig },
          };
        }

        // New-file guard: creating a file at the workspace ROOT is only refused
        // when the root looks like a MULTI-project container (≥2 real folders,
        // or folders with no loose source files at the root). A single-project
        // workspace (e.g. src/ + main.py at root) may still create root files.
        const rel = path.relative(root, path.dirname(target)).split(path.sep).join('/');
        if (rel === '' || rel === '.') {
          // The workspace root may not exist yet (e.g. a project folder that is
          // about to be created by this very write) — treat it as empty then.
          let entries: import('fs').Dirent[] = [];
          try {
            entries = await fs.readdir(root, { withFileTypes: true });
          } catch { /* missing or unreadable root */ }
          const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !IGNORE_DIRS.has(e.name) && !PROTECTED_DIRS.includes(e.name.toLowerCase()));
          const rootSourceFiles = entries.filter((e) => e.isFile() && LANGUAGE_EXT_MAP[(e.name.split('.').pop() || '').toLowerCase()] && !e.name.startsWith('.'));
          const multiProject = dirs.length >= 2 || (dirs.length >= 1 && rootSourceFiles.length === 0);
          if (multiProject) {
            return {
              ok: false,
              output: `Refusing to create ${p} at the workspace ROOT — this looks like a multi-project repo (${dirs.slice(0, 6).map((d) => d.name).join(', ')}). The path looks wrong: pick the subdirectory the file belongs in, or confirm the path is really the root before retrying with write_file.`,
            };
          }
        }

        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, 'utf-8');
        return {
          ok: true,
          output: `Created ${p} (${Buffer.byteLength(content, 'utf-8')} bytes).`,
          fileWrite: { path: p, changeType: 'created', originalContent: undefined },
        };
      } catch (e) {
        return { ok: false, output: `Failed to write ${p}: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    case 'delete_file': {
      if (!autoApply) return { ok: false, output: 'delete_file is disabled — auto-apply mode is OFF. Suggest the deletion in your final answer instead.' };
      const p = typeof args.path === 'string' ? args.path : '';
      if (!p) return { ok: false, output: 'delete_file requires a "path" string argument.' };
      const res = await resolveTargetSmart(root, p);
      if (res.error) return { ok: false, output: res.error };
      const target = res.target!;
      if (isUserRulesPath(root, target)) {
        return { ok: false, output: `Access denied: ${p} is the USER RULES file — it is read-only for you. The user edits it themselves. Save project knowledge to your own memory file (.agent-memory.md) with update_memory instead.` };
      }
      try {
        let originalContent: string | undefined;
        try { originalContent = await fs.readFile(target, 'utf-8'); } catch { /* already gone */ }
        await fs.rm(target, { force: true });
        return { ok: true, output: `Deleted ${p}.`, fileWrite: { path: p, changeType: 'deleted', originalContent } };
      } catch (e) {
        return { ok: false, output: `Failed to delete ${p}: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    default:
      return { ok: false, output: `Unknown tool "${call.tool}". Available: ${AGENT_TOOL_DEFS.map((t) => t.name).join(', ')}` };
  }
}

// ─── Code-block file convention (auto-apply fallback) ────────────────────
// Models frequently finish a task with code blocks using the documented file
// convention (path as the first comment line, // EDIT: ..., // DELETE: ...)
// instead of calling write_file/edit_file as JSON tools. In auto-apply mode
// those blocks are materialized so the task actually lands on disk. The
// regexes below mirror the frontend (Message.tsx) conventions exactly.

interface CodeBlockFile {
  type: 'create' | 'edit' | 'delete';
  path: string;
  content?: string;
  oldString?: string;
  newString?: string;
}

const BLOCK_FILE_PATH_RE = /^(?:\/\/|#|;|%|--|\/\*|<!--)\s*([^\s]+?\.[a-zA-Z]\w*)\s*(?:\*\/|-->)?$/;
const BLOCK_DELETE_PATH_RE = /^(?:\/\/|#|--)\s*DELETE:\s*([^\s]+)/i;
const BLOCK_EDIT_PATH_RE = /^(?:\/\/|#|--|;|%|<!--)\s*EDIT:\s*([^\s]+?)(?:\s*-->)?$/i;
const BLOCK_CODE_RE = /```(?:\w*)\n([\s\S]*?)```/g;

/** Parse the code blocks in a final answer into file operations (in order). */
export function parseCodeBlockFiles(content: string): CodeBlockFile[] {
  const out: CodeBlockFile[] = [];
  const re = new RegExp(BLOCK_CODE_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const block = match[1];
    const lines = block.split('\n');
    const first = lines[0]?.trim() || '';

    // // DELETE: path
    const del = first.match(BLOCK_DELETE_PATH_RE);
    if (del) {
      out.push({ type: 'delete', path: del[1] });
      continue;
    }

    // // EDIT: path  →  OLD: ... / --- / NEW: ...
    const editM = first.match(BLOCK_EDIT_PATH_RE);
    if (editM) {
      let oldStart = -1, sep = -1, newStart = -1;
      for (let i = 1; i < lines.length; i++) {
        const t = lines[i].trim();
        if (oldStart === -1 && /^OLD:$/i.test(t)) { oldStart = i; continue; }
        if (oldStart !== -1 && sep === -1 && /^-{3,}$/.test(t)) { sep = i; continue; }
        if (sep !== -1 && /^NEW:$/i.test(t)) { newStart = i; break; }
      }
      if (oldStart !== -1 && sep !== -1 && newStart !== -1) {
        const oldString = lines.slice(oldStart + 1, sep).join('\n').trim();
        const newString = lines.slice(newStart + 1).join('\n').trim();
        if (oldString) out.push({ type: 'edit', path: editM[1], oldString, newString });
      }
      continue;
    }

    // # path (first comment line) → new file
    const pathM = first.match(BLOCK_FILE_PATH_RE);
    if (pathM) {
      out.push({ type: 'create', path: pathM[1], content: lines.slice(1).join('\n').trimStart() });
    }
  }
  return out;
}

/** Apply code-block file ops through the SAME guarded tools as the agent loop. */
async function applyCodeBlockFiles(
  root: string,
  answer: string,
  onFileWritten?: (w: { path: string; changeType: string; originalContent?: string }) => void
): Promise<string> {
  const blocks = parseCodeBlockFiles(answer).slice(0, 20);
  if (blocks.length === 0) return '';
  const applied: string[] = [];
  const failed: string[] = [];
  for (const b of blocks) {
    let result: AgentToolResult;
    if (b.type === 'delete') {
      result = await executeTool(root, { tool: 'delete_file', args: { path: b.path } }, true);
    } else if (b.type === 'edit') {
      result = await executeTool(root, { tool: 'edit_file', args: { path: b.path, old_string: b.oldString, new_string: b.newString } }, true);
    } else {
      result = await executeTool(root, { tool: 'write_file', args: { path: b.path, content: b.content ?? '' } }, true);
    }
    if (result.ok) {
      applied.push(b.path);
      if (result.fileWrite) onFileWritten?.(result.fileWrite);
    } else {
      failed.push(`${b.path} (${result.output.split('\n')[0].slice(0, 100)})`);
    }
  }
  const parts: string[] = [];
  if (applied.length) parts.push(`Auto-applied ${applied.length} file(s): ${applied.join(', ')}`);
  if (failed.length) parts.push(`Could not apply: ${failed.join('; ')}`);
  return parts.join('\n');
}

// ─── Tool-call protocol parsing ─────────────────────────────────────────

/**
 * Extract the first balanced JSON object from a model response.
 * Tolerates markdown fences and small amounts of surrounding prose.
 */
export function extractToolCall(raw: string): ToolCall | null {
  const trimmed = raw.trim();
  const start = trimmed.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = trimmed.slice(start, i + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (
            parsed &&
            typeof parsed.tool === 'string' &&
            parsed.args &&
            typeof parsed.args === 'object' &&
            AGENT_TOOL_DEFS.some((t) => t.name === parsed.tool) // only known tools
          ) {
            return { tool: parsed.tool, args: parsed.args as Record<string, unknown> };
          }
        } catch { /* not valid JSON — keep scanning */ }
      }
    }
  }
  return null;
}

// ─── The agent loop ─────────────────────────────────────────────────────

export interface AgentCallbacks {
  onStage: (stage: string) => void;
  /** Fired when a tool call starts executing */
  onToolStart?: (call: ToolCall) => void;
  /** Fired when a file was written/deleted (auto-apply mode) */
  onFileWritten?: (write: { path: string; changeType: string; originalContent?: string }) => void;
  /** Fired with the final answer chunks so the client can stream them */
  onChunk: (chunk: string) => void;
  /** Fired with reasoning chunks from thinking models (final answer only) */
  onThinking?: (chunk: string) => void;
  /** Fired when the agent runs a shell command or auto-verify (for the terminal feed) */
  onAgentCommand?: (cmd: { command: string; output: string; failed: boolean }) => void;
  /** Fired when the agent asks the user a clarifying question (ask_user) */
  onQuestion?: (key: string, question: string) => void;
  /** Fired when the run is stopped/capped so the caller can persist resume state */
  onResumeState?: (state: { history: { role: string; content: string }[] }) => void;
}

export interface AgentLoopOptions {
  model: string;
  messages: { role: string; content: string }[];
  workspacePath?: string;
  autoApply: boolean;
  userName?: string;
  signal?: AbortSignal;
  callbacks: AgentCallbacks;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  /** Whether thinking mode is enabled for this request (honors the user toggle) */
  think?: boolean;
  /** Extra system context (memory, web search results, etc.) */
  extraContext?: string;
  /** Routing key for ask_user answers (usually the conversation id) */
  askKey?: string;
  /** Resume from a previously stopped run: the exact internal history to seed with */
  resumeState?: { history: { role: string; content: string }[] };
}

function availableTools(autoApply: boolean): AgentToolDef[] {
  return AGENT_TOOL_DEFS.filter((t) => autoApply || !t.mutating);
}

function buildSystemPrompt(workspacePath: string, userName: string, autoApply: boolean): string {
  const tools = availableTools(autoApply);
  const toolList = tools.map((t) => `- ${t.name}: ${t.description}\n  Example: ${t.args}`).join('\n');

  return `You are an autonomous coding agent helping ${userName || 'a user'} inside their workspace at: ${workspacePath}

You can use tools to inspect the workspace, run commands, and (in auto-apply mode) write and delete files.

TOOL DESCRIPTIONS (what each tool does, with an example call):\n${toolList}

${TOOL_JSON_EXAMPLES}

RULES:
1. To call a tool, respond with ONLY the JSON object above — no markdown fences, no prose, no trailing explanation. You will receive the tool result next.
2. Use list_files and read_file BEFORE writing or editing anything. NEVER guess file contents — always read the actual file. NEVER invent a file name or create a file you have not confirmed exists (or is needed) — always check the WORKSPACE PROFILE and file listing first.
3. LANGUAGE CONSISTENCY: always work in the SAME language and framework as the existing project (see the WORKSPACE PROFILE). If the project is Python, edit/create .py files — NEVER switch to config.js, .html, or other languages unless the user explicitly asks. When asked to change something, first find the file that contains it (search_files), then edit THAT file.
4. EDIT vs REWRITE: For a change to an EXISTING file, prefer edit_file with a SMALL old_string matching just the lines you are changing. write_file on an existing file applies only your changed lines (the rest is preserved) but a version that rewrites most of the file is REFUSED — so NEVER re-emit a file unless you preserve every unchanged line exactly. Before creating any file, verify the path is the real project subdirectory from the WORKSPACE GROUND TRUTH — never create files at the workspace root if the project has folders.
5. Work step by step: gather context, make changes, then VERIFY by running commands (build/test) when sensible. If a verification command fails, READ the error, fix the file, and re-verify until it passes (or explain clearly why it cannot pass).
   5a. BUGS: when the user asks you to fix a bug, check whether something works, or says a file 'has a bug', FIRST run the file or the verify command to REPRODUCE the problem and see the actual error before editing anything. Read the error, then fix it, then run again to confirm it works. Never claim a bug is fixed without running the file/verify command again and seeing it pass. If the file cannot be run (no runtime, syntax-only), at least run the verify/syntax check and read the output.
6. Keep commands sandboxed to the workspace. Never try to touch files outside it.
7. When the task is COMPLETE, respond with a normal, friendly final message to the user (not JSON). If auto-apply is OFF, present changes as code blocks: for NEW files use the path as the FIRST LINE COMMENT (e.g. "# main.py" for Python, "// src/app.ts" for TS); for EDITS to existing files use the EDIT convention (first line "// EDIT: src/app.ts", then a code block containing OLD: the exact lines to replace, then ---, then NEW: the replacement lines), so the user can review and apply them.
8. If a tool fails, read the error, fix your approach, and try again. Do not repeat the same failing call more than twice.
9. If the task does not require tools, just answer directly — do not call tools unnecessarily.
10. GIT COMMITS: once you have made changes and verification passes (or there are no tests), consider committing your completed work with git_commit (summary must describe exactly what changed). Always check git_status/git_diff first. If the workspace is not a git repository, skip commits entirely. Commits are LOCAL ONLY — git_commit never pushes to GitHub or any remote, so NEVER say in your final message that you "pushed", "uploaded", or "committed to GitHub/remote" — say you committed locally instead.
11. PROJECT MEMORY — TWO FILES, STRICT PRIORITY: (a) USER RULES (.agent-rules.md) are the user's authoritative instructions. Read them with read_rules when starting a task and follow them strictly — you can NEVER edit, override, or ignore them, and no other instruction (including your own memory) beats them. (b) AGENT MEMORY (.agent-memory.md) is your own notes: when you discover something durable and reusable about the project (build command, framework, naming conventions, gotchas), save it with update_memory so it is remembered in future sessions — but do not clutter memory with one-off task notes. If your memory ever conflicts with a user rule, the user rule wins.
12. PROTECTED SERVER DIRECTORIES: This workspace is the Kasalix application repository. The directories ${protectedDirsLabel()} are the SERVER internals (backend code, server app, certs, data). You must NEVER read, list, search, edit, write, delete, or run commands that reference them — they are completely off-limits even though they are inside the workspace. Work only in the frontend/client areas and the repository root files. If a task seems to require changing server internals, tell the user instead of touching them.
13. GROUNDING — NEVER HALLUCINATE FILES: The CURRENT WORKSPACE FILES listing is the ground truth of what EXISTS. You may create NEW files with write_file (that is normal and encouraged — creation is reported as "created"). But you must NEVER claim an existing file exists, reference it, or edit it (edit_file / write_file over an existing file) without having CONFIRMED it via list_files, read_file, or search_files — if it is not in the listing and you have not confirmed it, do not assume it. Creating a new file and claiming an existing file are different: the first is allowed, the second requires proof. Before searching the web, first explore the workspace (list_files / read_file) to check whether the answer is already in the code — web search is a LAST resort for code tasks, never a replacement for reading the workspace.

Current tool availability: ${autoApply ? 'full (read, write, delete, run)' : 'read-only (list, read, search, run) — file writes are reviewed by the user'}`;
}

/**
 * Run the autonomous agent loop.
 * Returns the final answer text (also streamed via callbacks.onChunk).
 */
export async function runAgentLoop(opts: AgentLoopOptions): Promise<string> {
  const { model, workspacePath, autoApply, userName, signal, callbacks } = opts;
  const root = resolveWorkspaceRoot(workspacePath);

  // No workspace → the agent cannot use tools; answer conversationally (streamed).
  if (!root) {
    callbacks.onStage('chat:thinking');
    let out = '';
    await streamChat(model, opts.messages as any, (chunk) => {
      out += chunk;
      callbacks.onChunk(chunk);
    }, {
      signal,
      temperature: opts.temperature,
      top_p: opts.top_p,
      max_tokens: opts.max_tokens,
      think: opts.think,
      onThinking: callbacks.onThinking,
    });
    return out;
  }

  callbacks.onStage('agent:thinking');

  // Initial context: file listing + language profile injected so the model
  // starts informed about WHAT this project is. The verify command (if the
  // project has tests/build) is auto-run after every mutation.
  //
  // ALSO auto-load the contents of any files the user explicitly referenced
  // in their message (e.g. "fix the bug in Test1/main.py") — otherwise a small
  // model may "forget" to read the file and either guess its content or give
  // up saying it cannot read the files. Injecting them up front fixes that.
  const fileTree = await listWorkspaceTree(root);
  const lastUserMsg = [...opts.messages].reverse().find((m) => m.role === 'user')?.content || '';
  const referencedFiles = lastUserMsg
    ? await collectReferencedFiles(lastUserMsg, root).catch(() => '')
    : '';
  const verify = await detectVerifyCommand(root);
  const projectRules = await readProjectRules(root);
  const agentMemory = await readAgentMemory(root);
  const workspaceProfile = await buildWorkspaceProfile(root, verify?.command, projectRules, agentMemory);
  const system = await withAiRules(buildSystemPrompt(root, userName || 'a user', autoApply), 'agent');

  // History starts with system + (already user-provided messages). When a
  // previous run was stopped/capped, resume from its saved internal history
  // (which includes tool results the conversation itself doesn't store) and
  // append the user's new message (the "continue" prompt) instead of
  // restarting the loop from scratch.
  const history: { role: string; content: string }[] = opts.resumeState?.history?.length
    ? [
        ...opts.resumeState.history,
        ...opts.messages
          .filter((m) => m.role === 'user')
          .slice(-1)
          .map((m) => ({ role: 'user' as const, content: '[RESUMING a previously stopped run] ' + m.content })),
      ]
    : [
        {
          role: 'system',
          content:
            system +
            '\n\n' +
            workspaceProfile +
            '\n\nCURRENT WORKSPACE FILES:\n' +
            fileTree +
            (projectRules ? '\n\n---\n\n[USER RULES — authoritative, written by the user. Follow them strictly. You can NEVER edit or override this file.]\n' + projectRules : '') +
            (agentMemory ? '\n\n---\n\n[AGENT MEMORY — your own notes from previous sessions (.agent-memory.md). Lower priority than user rules: if this contradicts a user rule, the user rule wins.]\n' + agentMemory : '') +
            (opts.extraContext ? '\n\n---\n\n' + opts.extraContext : '') +
            (referencedFiles ? '\n\n' + referencedFiles : ''),
        },
        ...opts.messages,
      ];

  // Fresh workspace ground truth, re-injected every iteration so long runs can
  // never forget what actually exists (prevents hallucinated file names).
  const groundTruthBlock =
    'WORKSPACE GROUND TRUTH (the ONLY files that exist — never invent others):\n' +
    fileTree +
    '\n\n' +
    workspaceProfile;

  // BASELINE VERIFY: on a FRESH run (not resuming) where the task sounds like
  // bug-hunting or checking that something works, run the project's
  // test/build/syntax command once up front so the agent sees the current
  // state of the code BEFORE making any changes — reproducing the bug instead
  // of ignoring it. The result is fed into history so the model reacts to it.
  const looksLikeBugHunt = /\b(bug|fix|broken|error|not working|doesn't work|does not work|crash|fail|test|check|works\?|issue|wrong)\b/i.test(lastUserMsg);
  if (autoApply && verify && !opts.resumeState?.history?.length && looksLikeBugHunt) {
    callbacks.onStage('agent:verify');
    const VERIFY_CAP = 3000;
    let baselineOut: string;
    try {
      const r = await execAsync(verify.command, {
        cwd: root,
        timeout: 60000,
        shell: true,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      } as any);
      baselineOut = ((r.stdout || '') + (r.stderr ? `\n[stderr]\n${r.stderr}` : '')).trim() || '(verify passed with no output)';
      baselineOut = baselineOut.length > VERIFY_CAP ? baselineOut.slice(-VERIFY_CAP) + '\n...[output truncated]' : baselineOut;
    } catch (e: any) {
      baselineOut = (e?.stderr ? String(e.stderr) : (e instanceof Error ? e.message : String(e)));
      baselineOut = `FAILED (exit code ${e?.code ?? '?'}):\n${baselineOut.slice(0, VERIFY_CAP)}`;
    }
    history.push({
      role: 'user',
      content: `[BASELINE VERIFICATION — run BEFORE any changes, current state of the project. ${verify.label} (${verify.command})]\n${baselineOut}\n\nThis is the result of running the verify command before you changed anything. Use it to understand what currently works and what is broken. After you make changes, the same command runs automatically and you will see whether it passes.`,
    });
    callbacks.onAgentCommand?.({ command: verify.command, output: baselineOut, failed: baselineOut.startsWith('FAILED') });
  }

  const seenCalls = new Map<string, number>();
  // Small models often ATTEMPT a tool call but emit malformed JSON (e.g.
  // unescaped newlines inside a multi-line write_file "content"). If a response
  // clearly tries to call a tool but doesn't parse, let the model retry instead
  // of silently treating it as the final answer (which would drop the write).
  let malformedToolCalls = 0;
  // Honest stage reporting: fire agent:reading only the first time the agent
  // actually lists/reads the workspace, so the UI todo reflects real progress.
  let readingStageFired = false;
  const maybeFireReading = () => {
    if (!readingStageFired) {
      readingStageFired = true;
      callbacks.onStage('agent:reading');
    }
  };
  // Persist the internal loop history so a stopped/capped run can be resumed
  // by the next message in the same conversation instead of starting over.
  const fireResumeState = () => {
    try {
      callbacks.onResumeState?.({
        history: history.slice(-60).map((m) => ({ role: m.role, content: m.content })),
      });
    } catch (e) {
      logger.info(`[agent] Failed to save resume state: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  try {
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    // Bounded history + a FRESH workspace reminder. Long agent runs push the
    // original system message out of the window (MAX_HISTORY), so the model
    // forgets the project language and starts inventing files (e.g. config.js
    // in a Python project). Re-stating the profile every iteration keeps it
    // grounded — cheap and immune to truncation.
    const boundedBase = history.length > MAX_HISTORY
      ? [history[0], ...history.slice(-(MAX_HISTORY - 1))]
      : history;
    const bounded: { role: string; content: string }[] = pruneToBudget([
      { role: 'system', content: groundTruthBlock },
      ...boundedBase,
    ]);

    callbacks.onStage(iter === 0 ? 'agent:thinking' : 'agent:working');

    // Stream this iteration and buffer the chunks. If it turns out to be a
    // tool call we drop the buffer (tool activity is shown via stages/events);
    // if it's the final answer we replay the chunks so the user sees typing.
    // Buffer both content and (if thinking is enabled) reasoning chunks. The
    // model emits thinking BEFORE the answer, so replaying thinking first
    // keeps the collapsible "Thinking" section above the actual response.
    const chunks: string[] = [];
    const thinkingChunks: string[] = [];
    await streamChatWithRetry(opts, bounded, (c) => chunks.push(c), (t) => thinkingChunks.push(t));
    const raw = chunks.join('');

    const toolCall = extractToolCall(raw);

    // Malformed tool attempt recovery: the response contains JSON tool markers
    // ("tool" / "args") but did not parse into a valid call. Give the model up
    // to 2 corrective retries before falling back to the final-answer path.
    const looksLikeToolAttempt = !toolCall && /"tool"\s*:\s*"[a-z_]+"|\{\s*"args"\s*:/i.test(raw);
    if (looksLikeToolAttempt && malformedToolCalls < 2) {
      malformedToolCalls++;
      const retryMsg =
        'Your previous response looked like a tool call but was NOT valid JSON, so nothing was executed. ' +
        'If you want to call a tool, respond with ONLY a single valid JSON object with NO code fences and NO extra text — ' +
        'e.g. {"tool": "write_file", "args": {"path": "src/main.py", "content": "print(1)\\n"}} — and escape all quotes and newlines properly. ' +
        'If you do NOT want to call a tool, reply normally with your final answer.';
      history.push({ role: 'assistant', content: raw });
      history.push({ role: 'user', content: retryMsg });
      callbacks.onStage('agent:working');
      continue;
    }

    // No tool call → this is the final answer. In auto-apply mode, materialize
    // any code-block files the model wrote (the # path / // EDIT: / // DELETE:
    // convention) so the task lands even when the model skipped the JSON tools.
    let appliedNote = '';
    if (!toolCall && autoApply) {
      appliedNote = await applyCodeBlockFiles(root, raw, callbacks.onFileWritten);
    }

    // If the response still looked like a (broken) tool call after the retries
    // were exhausted, don't hand the user raw JSON garbage as the answer.
    const malformedNote =
      looksLikeToolAttempt && !toolCall && malformedToolCalls >= 2
        ? '\n\n_(I tried to execute a tool call from your last response but it was not valid JSON, so nothing was executed.)_'
        : '';

    // Replay the streamed chunks so the message appears progressively, then return.
    if (!toolCall) {
      callbacks.onStage('agent:done');
      for (const t of thinkingChunks) callbacks.onThinking?.(t);
      for (const c of chunks) callbacks.onChunk(c);
      const suffix = (appliedNote ? '\n\n' + appliedNote : '') + malformedNote;
      if (suffix) {
        callbacks.onChunk(suffix);
        return raw + suffix;
      }
      return raw;
    }

    // Loop guard: same call 3 times in a row → stop and answer.
    const key = `${toolCall.tool}:${JSON.stringify(toolCall.args)}`;
    seenCalls.set(key, (seenCalls.get(key) || 0) + 1);
    if (seenCalls.get(key)! >= 3) {
      const msg = `I'm having trouble completing that step (the "${toolCall.tool}" call kept repeating). Here's where things stand:\n\n${raw}`;
      callbacks.onStage('agent:done');
      callbacks.onChunk(msg);
      return msg;
    }

    callbacks.onToolStart?.(toolCall);
    callbacks.onStage('agent:tool');
    logger.info(`[agent] Tool call: ${toolCall.tool} ${JSON.stringify(toolCall.args).slice(0, 120)}`);

    // ask_user pauses the loop until the user answers via the frontend modal.
    if (toolCall.tool === 'ask_user') {
      const question = typeof toolCall.args?.question === 'string' ? toolCall.args.question : '';
      if (!question.trim()) {
        history.push({ role: 'assistant', content: raw });
        history.push({ role: 'user', content: '[ask_user] No question provided — re-read the task and continue.' });
        continue;
      }
      callbacks.onStage('agent:waiting');
      const answer = await askUserQuestion(question, opts);
      history.push({ role: 'assistant', content: raw });
      history.push({ role: 'user', content: `[USER ANSWER to your question]\n${answer}` });
      continue;
    }

    const result = await executeTool(root, toolCall, autoApply);

    if (toolCall.tool === 'run_command') {
      const cmd = typeof toolCall.args?.command === 'string' ? toolCall.args.command : '';
      callbacks.onAgentCommand?.({ command: cmd, output: result.output, failed: !result.ok });
    }

    if (toolCall.tool === 'list_files' || toolCall.tool === 'read_file' || toolCall.tool === 'search_files' || toolCall.tool === 'read_rules') {
      maybeFireReading();
    }

    if (result.fileWrite) {
      callbacks.onFileWritten?.({
        path: result.fileWrite.path,
        changeType: result.fileWrite.changeType,
        originalContent: result.fileWrite.originalContent,
      });
    }

    history.push({ role: 'assistant', content: raw });
    history.push({
      role: 'user',
      content: `[TOOL RESULT — ${toolCall.tool}]\n${result.output}`,
    });

    // Auto-verify after any file mutation: run the project's test/build
    // command and feed the outcome back so the model fixes failures.
    if (autoApply && MUTATING_TOOLS.has(toolCall.tool) && verify) {
      callbacks.onStage('agent:verify');
      logger.info(`[agent] Verifying after ${toolCall.tool}: ${verify.command}`);
      const VERIFY_CAP = 3000; // failures rarely need more than the tail
      let verifyOut: string;
      try {
        const r = await execAsync(verify.command, {
          cwd: root,
          timeout: 60000,
          shell: true,
          windowsHide: true,
          maxBuffer: 10 * 1024 * 1024,
        } as any);
        verifyOut = ((r.stdout || '') + (r.stderr ? `\n[stderr]\n${r.stderr}` : '')).trim() || '(verification passed with no output)';
        verifyOut = verifyOut.length > VERIFY_CAP ? verifyOut.slice(-VERIFY_CAP) + '\n...[output truncated]' : verifyOut;
      } catch (e: any) {
        verifyOut = (e?.stderr ? String(e.stderr) : (e instanceof Error ? e.message : String(e)));
        verifyOut = `FAILED (exit code ${e?.code ?? '?'}):\n${verifyOut.slice(0, VERIFY_CAP)}`;
      }
      history.push({
        role: 'user',
        content: `[VERIFICATION RESULT — ${verify.label} (${verify.command})]\n${verifyOut}\n\nThis is a verification you requested. If it PASSED, continue with the next step or finish the task. If it FAILED, call a tool (e.g. read_file / edit_file) to fix the code, then the verification will run again automatically.`,
      });
      callbacks.onAgentCommand?.({ command: verify.command, output: verifyOut, failed: verifyOut.startsWith('FAILED') });
    }
  }
  } catch (e) {
    // Stopped or crashed mid-run — persist the internal history so a later
    // "continue" can resume from here instead of restarting from scratch.
    fireResumeState();
    throw e;
  }

  // Hit iteration cap — stop gracefully but save state so the user can resume.
  const msg = 'I reached the maximum number of steps for this request. Here is my progress so far — tell me to continue if you want me to keep going.';
  fireResumeState();
  callbacks.onStage('agent:done');
  callbacks.onChunk(msg);
  return msg;
}

/** Collect contents of files referenced in the user's message (approval mode). */
export async function collectReferencedFiles(userText: string, workspacePath?: string): Promise<string> {
  const root = resolveWorkspaceRoot(workspacePath);
  if (!root) return '';
  const wsRoot: string = root; // narrow for closure use

  // Find path-like tokens in the message (e.g. src/index.ts, package.json)
  const pathRe = /(?:^|[\s,("'`])([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+)/g;
  const candidates = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = pathRe.exec(userText)) !== null) {
    candidates.add(m[1].replace(/\\/g, '/'));
  }
  if (candidates.size === 0) return '';

  // Recursively gather existing files
  const files: string[] = [];
  async function walk(dir: string, depth: number) {
    if (depth > 4 || files.length > 500) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else files.push(path.relative(wsRoot, full).split(path.sep).join('/'));
    }
  }
  await walk(wsRoot, 0);

  const referenced = new Set<string>();
  for (const cand of candidates) {
    const base = cand.split('/').pop() || '';
    for (const f of files) {
      if (f === cand || f.endsWith('/' + cand) || f.split('/').pop() === base) {
        referenced.add(f);
      }
    }
    if (referenced.size >= 6) break;
  }
  if (referenced.size === 0) return '';

  const parts: string[] = [];
  for (const rel of referenced) {
    try {
      const full = path.join(wsRoot, rel);
      const stat = await fs.stat(full);
      if (stat.isDirectory() || stat.size > MAX_READ_BYTES) continue;
      const content = await fs.readFile(full, 'utf-8');
      parts.push(`### ${rel}\n\`\`\`\n${content}\n\`\`\``);
    } catch { /* skip */ }
  }
  return parts.length > 0
    ? `\n\n---\n\n[CURRENT FILE CONTENTS — read from disk, use as ground truth for edits]\n\n${parts.join('\n\n')}`
    : '';
}
