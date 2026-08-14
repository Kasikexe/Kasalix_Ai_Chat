/**
 * Plugin Platform — curated catalog
 *
 * The Plugins tab shows ONLY plugins from the official catalog repo
 * (Kasikexe/Kasalix-AI-Plugins by default, overridable via
 * PLUGIN_CATALOG_REPO). This keeps the plugin surface safe: the host browses
 * and installs only our own plugins instead of arbitrary third-party repos.
 *
 * The catalog repo ships a `catalog.json` at its root:
 *
 *   { "plugins": [
 *       { "id": "my-tool", "name": "My Tool", "version": "1.0.0",
 *         "description": "...", "author": "...", "icon": "🧰",
 *         "minKasalixVersion": "0.10.0",
 *         "source": "Kasikexe/Kasalix-AI-Plugins/plugins/my-tool" }
 *     ] }
 *
 * `source` is an install input the existing installPlugin() already
 * understands ("owner/repo" or "owner/repo/subdir"). The install route gates
 * on this list, so only catalog entries can ever be installed.
 */

import { resolveRepo, downloadRawFile } from './github';
import type { PluginManifest } from './types';

export const CATALOG_REPO =
  process.env.PLUGIN_CATALOG_REPO || 'Kasikexe/Kasalix-AI-Plugins';

/** One entry in the curated catalog (what the Plugins tab shows). */
export interface CatalogEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  icon?: string;
  minKasalixVersion?: string;
  /** Install input passed to installPlugin(): "owner/repo" or "owner/repo/subdir" */
  source: string;
}

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function parseCatalog(raw: string): CatalogEntry[] {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('catalog.json is not valid JSON');
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.plugins)) {
    throw new Error('catalog.json must be an object with a "plugins" array');
  }
  const entries: CatalogEntry[] = [];
  for (const p of data.plugins) {
    if (!p || typeof p !== 'object') continue;
    const id = typeof p.id === 'string' ? p.id.trim() : '';
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    const version = typeof p.version === 'string' ? p.version.trim() : '';
    const source = typeof p.source === 'string' ? p.source.trim() : '';
    if (!ID_RE.test(id)) continue;
    if (!name) continue;
    if (!version) continue;
    if (!source) continue;
    entries.push({
      id,
      name,
      version,
      description: typeof p.description === 'string' ? p.description : '',
      author: typeof p.author === 'string' ? p.author : undefined,
      icon: typeof p.icon === 'string' ? p.icon : undefined,
      minKasalixVersion:
        typeof p.minKasalixVersion === 'string' ? p.minKasalixVersion : undefined,
      source,
    });
  }
  return entries;
}

/** Normalize an install source for comparison (lowercase, no trailing slash). */
export function normalizeSource(s: string): string {
  return s.trim().toLowerCase().replace(/\/+$/, '');
}

/** True when `input` (the install endpoint's repo arg) is a catalog source. */
export function isCatalogSource(entries: CatalogEntry[], input: string): boolean {
  const needle = normalizeSource(input);
  return entries.some((e) => normalizeSource(e.source) === needle);
}

/** Fetch + validate the curated catalog from the catalog repo. */
export async function fetchPluginCatalog(): Promise<{
  repo: string;
  entries: CatalogEntry[];
}> {
  const [owner, repo] = CATALOG_REPO.split('/');
  if (!owner || !repo) throw new Error(`Invalid catalog repo: ${CATALOG_REPO}`);
  const branch = await resolveRepo({ owner, repo });
  const raw = await downloadRawFile(owner, repo, branch, 'catalog.json');
  if (raw === null) {
    throw new Error(
      `No catalog.json found in ${CATALOG_REPO}. Create the repo with a catalog.json listing your plugins.`
    );
  }
  return { repo: CATALOG_REPO, entries: parseCatalog(raw) };
}

/** Wrapper so the manager can validate against the same shape as PluginManifest. */
export function manifestFromCatalogEntry(e: CatalogEntry): PluginManifest {
  return {
    id: e.id,
    name: e.name,
    version: e.version,
    description: e.description,
    author: e.author,
    icon: e.icon,
    minKasalixVersion: e.minKasalixVersion,
  };
}
