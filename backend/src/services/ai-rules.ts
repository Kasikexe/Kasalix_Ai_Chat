/**
 * AI Ruleset service
 *
 * Loads a single user-editable rules file — AI_RULES.md — from the data
 * directory and injects the relevant rules into every AI-facing system prompt.
 *
 * FILE FORMAT (markdown):
 *   Everything before the first "## " heading is the CORE section — it is
 *   injected into EVERY mode (agent, chat).
 *   Then optional per-mode sections:
 *     ## Agent Rules   → injected in agent mode + code generation
 *     ## Chat Rules    → injected in plain chat
 *
 * The file is created automatically on first boot with sensible defaults.
 * Edits are picked up on the next request (mtime-based cache), no restart.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { getDataDir } from '../utils/helpers';

const RULES_FILENAME = 'AI_RULES.md';

export function getAiRulesPath(): string {
  return path.join(getDataDir(), RULES_FILENAME);
}

export type AiRuleMode = 'chat' | 'agent';

interface ParsedRules {
  core: string;
  agent: string;
  chat: string;
}

const RULES_VERSION_MARKER = 'ai-rules-version: 7';

const DEFAULT_RULES = `# AI Rules

<!-- ai-rules-version: 7 -->

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
- ALWAYS read a file BEFORE editing it. Never guess or invent file contents.
- When changing an existing file, use surgical edits (edit_file / the EDIT code-block convention) that replace only the changed lines — do NOT rewrite entire files unless a full rewrite is intended.
- For every code block, put the relative file path as a comment on the FIRST LINE (e.g. "// src/app.ts", "# main.py", "<!-- index.html -->").
- New files and full rewrites must contain the COMPLETE file — never use placeholders like "# rest of the code" or "...".
- To delete a file, use "// DELETE: path/to/file.ext" as the only content of a code block.
- Run commands inside the workspace only (build, test, install). Verify your work after making changes.
- Work step by step: gather context, make changes, verify, fix failures, then summarize.

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
    await fs.mkdir(getDataDir(), { recursive: true });
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
