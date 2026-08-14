/**
 * Plugin Platform — manager
 *
 * Installs plugins from GitHub into the data directory, persists the
 * registry (data/plugins/installed.json), and loads each plugin's entry
 * file at runtime to register its tools with the shared tool registry.
 *
 * SECURITY: installing a plugin downloads and executes code from the
 * internet. All mutations are admin-only (settings_auth cookie), and the
 * UI warns the user before installing.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { getDataDir } from '../../utils/helpers';
import { logger as appLogger } from '../logger';
import { registerTool, unregisterTool, isToolRegistered, type ToolDefinition, type ToolExecutor } from '../tools/index';
import {
  parseRepoInput,
  resolveRepo,
  fetchRepoTree,
  downloadRawFile,
} from './github';
import type { InstalledPlugin, PluginManifest, PluginRegistry } from './types';

// ─── Serialize mutations ───────────────────────────────────
// Install/uninstall/toggle/update read-modify-write the registry file;
// a simple promise chain prevents concurrent operations from losing entries.
// Reentrant: nested withLock calls (e.g. updatePlugin -> installPlugin) run
// inline instead of queuing behind themselves (which would deadlock).
let opChain: Promise<unknown> = Promise.resolve();
let lockDepth = 0;
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  if (lockDepth > 0) return fn();
  lockDepth++;
  const run = opChain.then(fn, fn);
  // Keep the chain alive regardless of the outcome
  opChain = run.catch(() => {}).finally(() => {
    lockDepth--;
  });
  return run;
}

const APP_VERSION = process.env.APP_VERSION || '0.10.15';

// ─── Paths ────────────────────────────────────────────────
function getPluginsDir(): string {
  return path.join(getDataDir(), 'plugins');
}

function getRegistryFile(): string {
  return path.join(getPluginsDir(), 'installed.json');
}

function getPluginDir(id: string): string {
  return path.join(getPluginsDir(), id);
}

// ─── Registry persistence ────────────────────────────────
async function readRegistry(): Promise<PluginRegistry> {
  try {
    const raw = await fs.readFile(getRegistryFile(), 'utf-8');
    const parsed = JSON.parse(raw);
    return { installed: Array.isArray(parsed.installed) ? parsed.installed : [] };
  } catch {
    return { installed: [] };
  }
}

async function writeRegistry(registry: PluginRegistry): Promise<void> {
  await fs.mkdir(getPluginsDir(), { recursive: true });
  await fs.writeFile(getRegistryFile(), JSON.stringify(registry, null, 2), 'utf-8');
}

// ─── Manifest validation ──────────────────────────────────
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function parseManifest(raw: string): PluginManifest {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('plugin.json is not valid JSON');
  }
  if (!data || typeof data !== 'object') throw new Error('plugin.json must be an object');
  const id = String(data.id || '').trim();
  const name = String(data.name || '').trim();
  const version = String(data.version || '').trim();
  if (!ID_RE.test(id)) {
    throw new Error('Invalid plugin id — use lowercase letters, numbers and dashes (e.g. "roblox-maker")');
  }
  if (!name) throw new Error('plugin.json is missing "name"');
  if (!version) throw new Error('plugin.json is missing "version"');
  if (version.length > 40) throw new Error('Plugin version is too long');
  const description = String(data.description || '').slice(0, 500);
  // Entry must stay inside the plugin folder — no traversal
  let entry = data.entry ? String(data.entry).trim() : 'index.js';
  if (entry.includes('..') || entry.startsWith('/') || entry.startsWith('\\') || entry.includes(':')) {
    throw new Error('Invalid entry path in plugin.json');
  }
  return {
    id,
    name,
    version,
    description,
    author: data.author ? String(data.author).slice(0, 100) : undefined,
    icon: data.icon ? String(data.icon).slice(0, 20) : undefined,
    minKasalixVersion: data.minKasalixVersion ? String(data.minKasalixVersion).slice(0, 30) : undefined,
    entry,
  };
}

function checkMinVersion(manifest: PluginManifest): void {
  if (!manifest.minKasalixVersion) return;
  const min = manifest.minKasalixVersion.replace(/^v/i, '');
  const cur = APP_VERSION.replace(/^v/i, '');
  // Simple numeric comparison — 0.9.0 vs 1.2.3
  const toNum = (v: string) => {
    const parts = v.split('.').map((n) => parseInt(n, 10) || 0);
    return parts[0] * 1000000 + (parts[1] || 0) * 1000 + (parts[2] || 0);
  };
  if (toNum(cur) < toNum(min)) {
    throw new Error(
      `This plugin requires Kasalix v${manifest.minKasalixVersion} — this server is v${APP_VERSION}. Update the server first.`
    );
  }
}

// ─── Entry loading ────────────────────────────────────────
interface PluginApi {
  registerTool: (definition: ToolDefinition, execute: ToolExecutor) => void;
  getDataDir: () => string;
}

/**
 * Dynamically load a plugin entry file and collect the tools it registers.
 * Returns the ids of the tools the plugin registered.
 * @param opts.dirOverride load from a temp dir (used during atomic install)
 */
async function loadPluginEntry(plugin: InstalledPlugin, opts?: { enabled?: boolean; dirOverride?: string }): Promise<string[]> {
  const dir = opts?.dirOverride || getPluginDir(plugin.id);
  const entryRel = plugin.manifest.entry || 'index.js';
  const entryPath = path.join(dir, entryRel);
  let stat;
  try {
    stat = await fs.stat(entryPath);
  } catch {
    appLogger.warn(`[plugins] ${plugin.id}: entry "${entryRel}" not found — no tools registered`);
    return [];
  }
  if (!stat.isFile()) {
    throw new Error(`Entry "${entryRel}" is not a file`);
  }

  const enabled = opts?.enabled ?? plugin.enabled;
  const toolIds: string[] = [];
  const api: PluginApi = {
    registerTool: (definition, execute) => {
      if (!enabled) return; // disabled plugins must not register tools
      const withPlugin: ToolDefinition = {
        ...definition,
        pluginId: plugin.id,
        keywords: definition.keywords || [],
      };
      if (!toolIds.includes(withPlugin.id)) toolIds.push(withPlugin.id);
      registerTool(withPlugin, execute);
    },
    getDataDir,
  };

  // Cache-busting query so updates re-import fresh code (Bun caches imports)
  const importUrl = `${pathToFileURL(entryPath).href}?t=${plugin.updatedAt}`;
  try {
    const mod = await import(importUrl);
    const registerFn = mod.register || (mod.default && mod.default.register) || mod.default;
    if (typeof registerFn !== 'function') {
      throw new Error(`Entry "${entryRel}" must export a register(api) function`);
    }
    await registerFn(api);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Roll back any tools registered before the failure
    for (const id of toolIds) unregisterTool(id);
    throw new Error(`Failed to load plugin "${plugin.id}": ${msg}`);
  }
  return toolIds;
}

/** Remove all tools a plugin previously registered. */
function clearPluginTools(plugin: InstalledPlugin): void {
  for (const id of plugin.toolIds || []) {
    if (isToolRegistered(id)) unregisterTool(id);
  }
  plugin.toolIds = [];
}

// ─── Public API ───────────────────────────────────────────

/** List installed plugins (public read). */
export async function listPlugins(): Promise<InstalledPlugin[]> {
  const registry = await readRegistry();
  return registry.installed;
}

/** Install (or update) a plugin from a GitHub repo spec. */
export async function installPlugin(input: string): Promise<InstalledPlugin> {
  return withLock(async () => {
    const { owner, repo, path: subdir } = parseRepoInput(input);
    const branch = await resolveRepo({ owner, repo });

    // 1. Fetch the repo file list + download the manifest
    const files = await fetchRepoTree({ owner, repo, branch, path: subdir });
    const prefix = subdir ? subdir.replace(/^\/+|\/+$/g, '') + '/' : '';
    const manifestRel = prefix ? prefix + 'plugin.json' : 'plugin.json';
    if (!files.includes(manifestRel)) {
      throw new Error(`No plugin.json found in ${owner}/${repo}${subdir ? '/' + subdir : ''}`);
    }
    const manifestRaw = await downloadRawFile(owner, repo, branch, manifestRel);
    if (!manifestRaw) throw new Error('Could not download plugin.json');
    const manifest = parseManifest(manifestRaw);
    checkMinVersion(manifest);

    // 2. Download every file into a TEMP dir first so a failed install never
    //    destroys the currently-working plugin (atomic install).
    const dir = getPluginDir(manifest.id);
    const tmpDir = `${dir}.tmp`;
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.mkdir(tmpDir, { recursive: true });
    try {
      for (const file of files) {
        const rel = prefix ? file.slice(prefix.length) : file;
        if (!rel || rel === 'plugin.json') continue;
        // No traversal, no absolute paths
        if (rel.includes('..') || path.isAbsolute(rel)) continue;
        const content = await downloadRawFile(owner, repo, branch, file);
        if (content === null) continue;
        const dest = path.join(tmpDir, rel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, content, 'utf-8');
      }
    } catch (err) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      throw err;
    }

    // 3. Persist registry entry (before entry load, so a load failure can
    //    still leave a clean uninstallable state)
    const registry = await readRegistry();
    const existingIdx = registry.installed.findIndex((p) => p.id === manifest.id);
    const now = Date.now();
    const plugin: InstalledPlugin = {
      id: manifest.id,
      manifest,
      repo: `${owner}/${repo}`,
      path: subdir,
      branch,
      enabled: existingIdx >= 0 ? registry.installed[existingIdx].enabled : true,
      installedAt: existingIdx >= 0 ? registry.installed[existingIdx].installedAt : now,
      updatedAt: now,
      toolIds: [],
    };

    // 4. Load the entry from the TEMP dir to validate before swapping
    try {
      plugin.toolIds = await loadPluginEntry(plugin, { enabled: plugin.enabled, dirOverride: tmpDir });
    } catch (err) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      throw err;
    }

    // 5. Swap: unload old tools, replace dir, persist registry
    if (existingIdx >= 0) {
      clearPluginTools(registry.installed[existingIdx]);
      registry.installed[existingIdx] = plugin;
    } else {
      registry.installed.push(plugin);
    }
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rename(tmpDir, dir);
    await writeRegistry(registry);
    appLogger.info(
      `[plugins] ${existingIdx >= 0 ? 'Updated' : 'Installed'} ${manifest.name} (${manifest.id}) — ${plugin.toolIds.length} tool(s)`
    );
    return plugin;
  });
}

/** Uninstall a plugin: unregister its tools and delete its folder. */
export async function uninstallPlugin(id: string): Promise<{ success: boolean }> {
  return withLock(async () => {
    if (!ID_RE.test(id)) throw new Error('Invalid plugin id');
    const registry = await readRegistry();
    const idx = registry.installed.findIndex((p) => p.id === id);
    if (idx < 0) throw new Error(`Plugin "${id}" is not installed`);
    const plugin = registry.installed[idx];
    clearPluginTools(plugin);
    registry.installed.splice(idx, 1);
    await writeRegistry(registry);
    await fs.rm(getPluginDir(id), { recursive: true, force: true });
    appLogger.info(`[plugins] Uninstalled ${plugin.manifest.name} (${id})`);
    return { success: true };
  });
}

/** Enable/disable a plugin (unregisters tools when disabled). */
export async function setPluginEnabled(id: string, enabled: boolean): Promise<InstalledPlugin> {
  return withLock(async () => {
    const registry = await readRegistry();
    const plugin = registry.installed.find((p) => p.id === id);
    if (!plugin) throw new Error(`Plugin "${id}" is not installed`);
    plugin.enabled = !!enabled;
    plugin.updatedAt = Date.now();
    if (plugin.enabled) {
      plugin.toolIds = await loadPluginEntry(plugin, { enabled: true });
    } else {
      clearPluginTools(plugin);
    }
    await writeRegistry(registry);
    appLogger.info(`[plugins] ${plugin.manifest.name} (${id}) ${enabled ? 'enabled' : 'disabled'}`);
    return plugin;
  });
}

/**
 * Re-fetch a plugin from its source repo.
 *
 * installPlugin already handles the "update" case atomically: it preserves
 * the plugin's enabled state, downloads + validates into a temp dir, and only
 * then unloads the old tools and swaps the directory. A failed download or
 * entry load leaves the currently-installed plugin completely untouched,
 * so updatePlugin simply delegates to it.
 */
export async function updatePlugin(id: string): Promise<InstalledPlugin> {
  const registry = await readRegistry();
  const plugin = registry.installed.find((p) => p.id === id);
  if (!plugin) throw new Error(`Plugin "${id}" is not installed`);
  return withLock(async () => {
    try {
      return await installPlugin(`${plugin.repo}${plugin.path ? '/' + plugin.path : ''}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Update failed: ${msg}`);
    }
  });
}

/** Register tools for every installed + enabled plugin (called at startup). */
export async function loadInstalledPlugins(): Promise<number> {
  const registry = await readRegistry();
  let loaded = 0;
  let changed = false;
  for (const plugin of registry.installed) {
    if (!plugin.enabled) continue;
    try {
      plugin.toolIds = await loadPluginEntry(plugin, { enabled: true });
      changed = true;
      loaded++;
    } catch (err) {
      appLogger.error(`[plugins] Failed to load "${plugin.id}" on startup:`, err);
    }
  }
  // Persist toolIds so uninstall/toggle can clean up tools later
  if (changed) await writeRegistry(registry);
  if (registry.installed.length > 0) {
    appLogger.info(`[plugins] Loaded ${loaded}/${registry.installed.length} installed plugin(s)`);
  }
  return loaded;
}


