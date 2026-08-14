/**
 * Project rules + agent memory service
 *
 * Two separate per-workspace files with a strict priority order:
 *
 *   1. USER RULES  (.agent-rules.md / .agent-rules / AGENT_RULES.md)
 *      Authoritative instructions written BY THE USER. The agent may READ
 *      them but can never write, edit, delete, or override them — the user's
 *      rules always win, even over the agent's own notes. The agent is
 *      hard-blocked from touching these files at the tool level (see
 *      agent.ts isUserRulesPath) so a model cannot silently change them.
 *
 *   2. AGENT MEMORY (.agent-memory.md)
 *      Notes the AGENT writes to itself (lessons, build commands, framework
 *      conventions, gotchas) so it does not have to re-read the whole
 *      project every session. Lower priority than user rules — if the
 *      agent's memory contradicts a user rule, the user rule wins.
 *
 * Both files are plain markdown injected into the agent's system prompt.
 */

import { promises as fs } from 'fs';
import path from 'path';

const RULES_FILENAMES = ['.agent-rules.md', '.agent-rules', 'AGENT_RULES.md'];
const MEMORY_FILENAMES = ['.agent-memory.md', '.agent-memory', 'AGENT_MEMORY.md'];
const MAX_FILE_BYTES = 64 * 1024; // 64KB cap each — enough for rich rules/memory

/** Resolve the user rules file path inside a workspace, or null if none exists. */
export async function findProjectRulesFile(workspaceRoot: string): Promise<string | null> {
  for (const name of RULES_FILENAMES) {
    try {
      const p = path.join(workspaceRoot, name);
      const stat = await fs.stat(p);
      if (stat.isFile()) return p;
    } catch { /* try next */ }
  }
  return null;
}

/** Read the user rules file content (capped), or null if there is none. */
export async function readProjectRules(workspaceRoot: string): Promise<string | null> {
  const filePath = await findProjectRulesFile(workspaceRoot);
  if (!filePath) return null;
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_FILE_BYTES) {
      // Don't inject a giant file — but still let the agent know it exists AND
      // where, so it can read_file the file in ranges and split it itself.
      return `(user rules file ${filePath} is ${(stat.size / 1024).toFixed(0)}KB — larger than the ${(MAX_FILE_BYTES / 1024)}KB read limit; read it in ranges with read_file and consider splitting it)`;
    }
    const content = await fs.readFile(filePath, 'utf-8');
    return content.trim() || null;
  } catch {
    return null;
  }
}

/** Resolve the agent memory file path inside a workspace, or null if none exists. */
export async function findAgentMemoryFile(workspaceRoot: string): Promise<string | null> {
  for (const name of MEMORY_FILENAMES) {
    try {
      const p = path.join(workspaceRoot, name);
      const stat = await fs.stat(p);
      if (stat.isFile()) return p;
    } catch { /* try next */ }
  }
  return null;
}

/** Read the agent memory file content (capped), or null if there is none. */
export async function readAgentMemory(workspaceRoot: string): Promise<string | null> {
  const filePath = await findAgentMemoryFile(workspaceRoot);
  if (!filePath) return null;
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_FILE_BYTES) {
      return `(agent memory file ${filePath} is ${(stat.size / 1024).toFixed(0)}KB — larger than the ${(MAX_FILE_BYTES / 1024)}KB read limit; read it in ranges with read_file and consider splitting it)`;
    }
    const content = await fs.readFile(filePath, 'utf-8');
    return content.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Append a note to the agent memory file (creates it if missing).
 * Returns the file path used. Duplicate notes are skipped.
 */
export async function appendAgentMemory(workspaceRoot: string, note: string): Promise<string> {
  // Collapse newlines to spaces so one note = one line (multi-line notes would
  // corrupt the markdown file and could even swallow it via HTML comments).
  const clean = note.trim().replace(/\s*\n+\s*/g, ' ');
  if (!clean) throw new Error('Cannot append an empty note.');

  let filePath = await findAgentMemoryFile(workspaceRoot);
  if (!filePath) {
    filePath = path.join(workspaceRoot, MEMORY_FILENAMES[0]);
    await fs.writeFile(
      filePath,
      `# Agent Memory\n\nNotes written by the AI agent and remembered across sessions. Lower priority than the user's rules (${RULES_FILENAMES[0]}) — if these notes ever contradict a user rule, the user rule wins.\n\n`,
      'utf-8'
    );
  }

  let existing = '';
  try {
    existing = await fs.readFile(filePath, 'utf-8');
  } catch { /* new file */ }

  // De-duplicate: skip only EXACT matches (normalized) — near-duplicates are
  // allowed to append so distinct-but-similar notes are never silently lost.
  const needle = clean.toLowerCase().replace(/\s+/g, ' ');
  const exists = existing.toLowerCase().split('\n').some((line) => {
    const l = line.trim().toLowerCase().replace(/\s+/g, ' ');
    const bare = l.startsWith('-') ? l.slice(1).trim() : l;
    return bare.length > 0 && (bare === needle || l === `- ${needle}`);
  });
  if (exists) {
    return filePath;
  }

  const line = clean.startsWith('-') ? clean : `- ${clean}`;
  await fs.appendFile(filePath, `${line}\n`, 'utf-8');
  return filePath;
}
