/**
 * AI Ruleset service
 *
 * Loads a single user-editable rules file — AI_RULES.md — from the rules/
 * directory and injects the relevant rules into every AI-facing system prompt.
 * The rules/ directory ships with builds (unlike data/ which is excluded).
 *
 * FILE FORMAT (markdown):
 *   Everything before the first "## " heading is the CORE section — it is
 *   injected into EVERY mode (agent, chat).
 *   Then optional per-mode sections:
 *     ## Agent Rules   → injected in Koding mode
 *     ## Chat Rules    → injected in plain chat
 *
 * The file is created automatically on first boot with sensible defaults.
 * Edits are picked up on the next request (mtime-based cache), no restart.
 */

import { promises as fs } from 'fs';
import path from 'path';

const RULES_FILENAME = 'AI_RULES.md';

/**
 * Path to the AI_RULES.md file. Lives in a rules/ directory next to the
 * backend source so it ships with builds (unlike data/ which is excluded
 * from the installer to avoid leaking user accounts and conversations).
 */
export function getAiRulesPath(): string {
  return path.join(process.cwd(), 'rules', RULES_FILENAME);
}

export type AiRuleMode = 'chat' | 'agent';

interface ParsedRules {
  core: string;
  agent: string;
  chat: string;
}

const RULES_VERSION_MARKER = 'ai-rules-version: 8';

const DEFAULT_RULES = `# AI Rules

<!-- ai-rules-version: 8 -->

<!--
  This file is the single source of truth for how the AI behaves.
  Everything before the first "## " heading is the CORE section and applies in EVERY mode.
  Add or edit "## " sections (Agent Rules / Chat Rules) to tune a specific mode.
  Edits apply immediately — no restart needed.
-->

## Core Rules

- You are a friendly, honest, and helpful AI assistant.
- Talk like a real person: use contractions, lead with the answer, and never open with robotic filler ("I can provide...", "Based on...", "According to...", "As an AI...", "Here is what I found").
- Answer directly and conversationally.
- When web search results are provided, treat them as the primary source of truth and answer with those facts — do not just dump links.
- NEVER fabricate facts: no invented numbers, statistics, dimensions, prices, dates, names, quotes, or sources. If asked a factual question you genuinely don't know, say "I don't know" plainly — a confident guess is worse.
- If you have a web search available (web context or a web_search tool) and you need a fact you can't verify from memory, look it up before answering rather than guessing.
- Never claim to have done something you have not done.
- Keep answers concise unless the user asks for detail.
- Refuse genuinely illegal or dangerous requests (weapons/explosives, doxxing, fraud, malware) in one calm sentence — no sermon — then move on.

## Agent Rules

- You work inside a workspace folder and may only touch files inside it.
- Never execute destructive commands on the user's machine (never delete system files, never run commands outside the workspace).
- Never look outside the project root.
- Always read a file BEFORE editing it. Never guess or invent file contents.
- Never write code during thinking/reasoning.
- Always use JSON tool calls — never output plain text tool names like "glob" or "run_command".
- Use write_file tool calls to create files, not markdown code blocks.
- When changing an existing file, use surgical edits (edit_file) that replace only the changed lines — do NOT rewrite entire files unless a full rewrite is intended.
- Use glob (not list_files) when searching for files by extension or name pattern.
- Say "I created X" or "I wrote X" — never "here is the code, copy it".
- For every code block, put the relative file path as a comment on the FIRST LINE (e.g. "// src/app.ts", "# main.py", "<!-- index.html -->").
- The file path MUST include a file extension (.html, .py, .ts, .css, etc.).
- Use relative paths like src/index.ts, components/Button.tsx, etc.
- NEVER output a code block without a file path comment on the first line.
- You MUST output the COMPLETE file content in every code block. NEVER use placeholders like "# rest of the code", "...", or "remaining code unchanged".
- To delete a file, output a code block with the first line as: // DELETE: path/to/file.ext and NO other content.
- Run verify command after changes (build, test, syntax check).
- Match the project language (see workspace profile).
- Prefer editing existing files over creating new ones.
- Keep changes minimal and focused.
- Work step by step: gather context, make changes, verify, fix failures, then summarize.

### Git Rules (critical — do not ask the user)

- When the user says "commit" / "commit this" / "make a commit": FIRST call git_status, THEN git_diff, THEN git_commit with a descriptive summary. Do NOT ask for confirmation — just do it.
- git_commit stages ALL changes and creates a LOCAL commit. It NEVER pushes.
- When the user says "push": tell them git_commit is local-only and they need to push manually.

## Chat Rules

- This is a normal conversation, not a coding session — answer questions and discuss naturally.
- If the user asks about code, you may show snippets, but do not try to write files or use file tools.
- Be a friend, not a robot: casual, warm, and direct. Don't over-structure answers, avoid clinical or academic phrasing, and never start with meta-commentary like "I can provide some context" or "Based on available data".
- Always answer the user's ACTUAL question — never reply with something that belongs to a different topic.
`;

const cache: { mtimeMs: number; parsed: ParsedRules } = { mtimeMs: -1, parsed: { core: '', agent: '', chat: '' } };

/**
 * Ensure the rules file exists, creating it with defaults if missing.
 * If an existing file predates the current defaults (missing the version
 * marker), it is backed up as AI_RULES.md.bak and refreshed with the new
 * defaults so behavior updates actually reach existing installs.
 */
export async function ensureAiRulesFile(): Promise<string> {
  const filePath = getAiRulesPath();
  try {
    await fs.access(filePath);
  } catch {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, DEFAULT_RULES, 'utf-8');
    console.log(`[ai-rules] Created ${filePath}`);
    return filePath;
  }
  try {
    const existing = await fs.readFile(filePath, 'utf-8');
    if (existing.includes(RULES_VERSION_MARKER)) return filePath;
    // Old-format file (or user copy from before this version) — keep a backup
    // before refreshing, so nothing the user wrote is ever lost silently.
    await fs.copyFile(filePath, `${filePath}.bak`).catch(() => {});
    await fs.writeFile(filePath, DEFAULT_RULES, 'utf-8');
    console.log(`[ai-rules] Updated ${filePath} to current defaults (backup saved as AI_RULES.md.bak)`);
  } catch (e) {
    console.error('[ai-rules] Failed to check/update rules file:', e);
  }
  return filePath;
}

function parseRules(content: string): ParsedRules {
  const sections: Record<string, string[]> = { core: [], agent: [], chat: [] };
  let current = 'core';
  let inComment = false;

  for (const line of content.split('\n')) {
    // Skip HTML comments (<!-- ... -->) — used for human-only meta notes.
    // Handles both multi-line blocks and single-line comments like `<!-- note -->`.
    if (line.trimStart().startsWith('<!--')) {
      if (!line.includes('-->')) inComment = true;
      continue;
    }
    if (inComment) {
      if (line.includes('-->')) inComment = false;
      continue;
    }

    // Top-level '# ' headings are file structure, not rules — skip them
    if (/^#\s/.test(line)) continue;

    const m = line.match(/^##\s*(.+)$/);
    if (m) {
      const name = m[1].trim().toLowerCase();
      if (name.includes('agent')) current = 'agent';
      else if (name.includes('chat')) current = 'chat';
      else if (name.includes('core')) current = 'core';
      else {
        // Unknown section — parsed but NOT injected into any mode, so a typo
        // like "## Agnet Rules" can't leak its content into core/chat/etc.
        console.warn(`[ai-rules] Ignoring unknown section: "${name}"`);
        current = 'ignored';
      }
      continue;
    }
    if (current !== 'ignored') sections[current].push(line);
  }

  return {
    core: sections.core.join('\n').trim(),
    agent: sections.agent.join('\n').trim(),
    chat: sections.chat.join('\n').trim(),
  };
}

async function loadRules(): Promise<ParsedRules> {
  const filePath = getAiRulesPath();
  try {
    // Fast path: cached and file unchanged
    const stat = await fs.stat(filePath);
    if (stat.mtimeMs === cache.mtimeMs) return cache.parsed;
    const content = await fs.readFile(filePath, 'utf-8');
    cache.mtimeMs = stat.mtimeMs;
    cache.parsed = parseRules(content);
    return cache.parsed;
  } catch {
    // File missing → create with defaults, then read it once
    try {
      await ensureAiRulesFile();
      const stat = await fs.stat(filePath);
      const content = await fs.readFile(filePath, 'utf-8');
      cache.mtimeMs = stat.mtimeMs;
      cache.parsed = parseRules(content);
    } catch {
      // Still failing — fall back to whatever we have
      if (!cache.parsed.core) {
        cache.parsed = parseRules(DEFAULT_RULES);
      }
    }
    return cache.parsed;
  }
}

/**
 * Get the rules for a given mode: CORE + that mode's section.
 * Returns an empty string if no rules are configured.
 */
export async function getAiRules(mode: AiRuleMode): Promise<string> {
  const rules = await loadRules();
  const parts: string[] = [];
  if (rules.core) parts.push(rules.core);
  const specific = mode === 'agent' ? rules.agent : rules.chat;
  if (specific) parts.push(specific);
  return parts.join('\n\n');
}

/** Convenience: append rules to an existing system prompt. */
export async function withAiRules(basePrompt: string, mode: AiRuleMode): Promise<string> {
  const rules = await getAiRules(mode);
  if (!rules) return basePrompt;
  return `${basePrompt}\n\n---\n\n[GLOBAL AI RULES — follow these in addition to the instructions above]\n\n${rules}`;
}
