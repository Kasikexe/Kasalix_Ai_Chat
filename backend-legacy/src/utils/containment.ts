import { promises as fs } from 'fs';
import path from 'path';

/**
 * Shared workspace containment check (realpath-based, symlink-safe) used by
 * BOTH the agent tool sandbox (services/agent.ts) and the files API
 * (routes/files.ts) so a targeted edit behaves identically everywhere.
 *
 * Missing path segments (new files/folders) are resolved via their nearest
 * EXISTING ancestor, so creating a brand-new project folder inside the
 * workspace passes the check instead of failing because realpath cannot see
 * not-yet-existing directories. Symlinks in the existing part are still
 * resolved, so symlink escapes stay blocked.
 */

/** Realpath the nearest EXISTING ancestor of `p`, then re-append the missing
 * tail. Falls back to the unresolved absolute path at the filesystem root. */
export async function resolveForContainment(p: string): Promise<string> {
  const missing: string[] = [];
  let current = p;
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return missing.length === 0 ? real : path.join(real, ...missing);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p); // reached the root — give up resolving
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** True when `target` resolves inside `root` (equal or a descendant). */
export async function isPathInside(root: string, target: string): Promise<boolean> {
  try {
    const realRoot = await resolveForContainment(root);
    const realTarget = await resolveForContainment(target);
    const rel = path.relative(realRoot, realTarget);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}
