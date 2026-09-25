/**
 * Protected server-internal directories
 *
 * When the agent's workspace is this repository itself, these directories are
 * the SERVER's internals (backend code, server app, certs, data, build
 * artifacts). They must not be read, listed, searched, edited, committed, or
 * referenced — enforced hard at the tool/API level, not just via prompt rules.
 *
 * The same guard backs BOTH the agent tool loop (agent.ts) and the files API
 * (files.ts) so the workspace FileTree cannot expose them either.
 */

import path from 'path';

export const PROTECTED_DIRS: string[] = (
  process.env.AGENT_PROTECTED_DIRS || 'backend,.freebuff,certs,server-gui,release,node_modules'
).split(',').map((s) => s.trim()).filter(Boolean);

/** Normalize a path for comparison (resolve + lowercase + forward slashes). */
function normPath(p: string): string {
  return path.resolve(p).toLowerCase().replace(/\\/g, '/');
}

/**
 * True if a candidate path is inside any protected directory (checked against
 * the workspace root, so it also covers nested dirs like backend/src).
 * Case-insensitive and slash-agnostic (Windows-safe, fail-closed elsewhere).
 */
export function isProtectedPath(wsRoot: string, candidate: string): boolean {
  const root = normPath(wsRoot);
  const target = normPath(candidate);
  if (target === root) return false;
  for (const dir of PROTECTED_DIRS) {
    const protectedPath = `${root}/${dir.toLowerCase()}`;
    if (target === protectedPath || target.startsWith(protectedPath + '/')) return true;
  }
  return false;
}

/** Protected dirs rendered as a compact list for prompts/profiles. */
export function protectedDirsLabel(): string {
  return PROTECTED_DIRS.filter((d) => d !== 'node_modules').join(', ');
}

/** True if a directory NAME itself is protected (for listing filters). */
export function isProtectedDirName(name: string): boolean {
  const lower = name.toLowerCase();
  return PROTECTED_DIRS.some((d) => d.toLowerCase() === lower);
}
