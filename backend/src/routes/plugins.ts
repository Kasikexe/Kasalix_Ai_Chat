import { Hono } from 'hono';
import type { Variables } from '../types';
import {
  listPlugins,
  installPlugin,
  uninstallPlugin,
  setPluginEnabled,
  updatePlugin,
} from '../services/plugins/manager';
import {
  fetchPluginCatalog,
  isCatalogSource,
  CATALOG_REPO,
} from '../services/plugins/catalog';
import { getAllTools } from '../services/tools/index';
import { logger as appLogger } from '../services/logger';

const plugins = new Hono<{ Variables: Variables }>();

// Public: list installed plugins (read-only)
plugins.get('/', async (c) => {
  try {
    const installed = await listPlugins();
    // Attach the live tool list (from the shared registry) so the UI can show
    // exactly which tools each plugin contributed.
    const tools = getAllTools();
    const byPlugin = tools.filter((t) => t.pluginId);
    return c.json({
      plugins: installed.map((p) => ({
        ...p,
        registeredTools: byPlugin.filter((t) => t.pluginId === p.id),
      })),
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'Failed to list plugins' }, 500);
  }
});

// Public: the curated catalog (read-only) — the list of plugins the host can
// browse and install. Only plugins in this catalog are ever installable.
plugins.get('/catalog', async (c) => {
  try {
    const catalog = await fetchPluginCatalog();
    const installed = await listPlugins();
    const installedById = new Map(installed.map((p) => [p.id, p]));
    return c.json({
      repo: catalog.repo,
      plugins: catalog.entries.map((e) => {
        const inst = installedById.get(e.id);
        return {
          ...e,
          installed: !!inst,
          installedVersion: inst?.manifest.version,
          enabled: inst?.enabled,
        };
      }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed to load plugin catalog';
    appLogger.error('[plugins] Catalog error:', msg);
    return c.json({ error: msg, repo: CATALOG_REPO }, 500);
  }
});

// Admin: install a plugin — ONLY from the curated catalog, so the host can
// never install an arbitrary third-party repo.
plugins.post('/install', async (c) => {
  if (!c.get('auth').authenticated) {
    return c.json({ error: 'Not authenticated' }, 401);
  }
  try {
    const body = await c.req.json();
    const repo = typeof body?.repo === 'string' ? body.repo.trim() : '';
    if (!repo) return c.json({ error: 'repo is required (e.g. "owner/repo")' }, 400);

    // Gate: the requested source must be one of the catalog entries.
    const catalog = await fetchPluginCatalog();
    if (!isCatalogSource(catalog.entries, repo)) {
      appLogger.warn(`[plugins] Install blocked: ${repo} is not in the curated catalog`);
      return c.json(
        { error: `Install blocked: "${repo}" is not in the official plugin catalog (${CATALOG_REPO}). Only plugins listed in the catalog can be installed.` },
        403
      );
    }

    const plugin = await installPlugin(repo);
    return c.json({ success: true, plugin });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Install failed';
    appLogger.error('[plugins] Install error:', msg);
    return c.json({ error: msg }, 400);
  }
});

// Admin: uninstall a plugin
plugins.post('/:id/uninstall', async (c) => {
  if (!c.get('auth').authenticated) {
    return c.json({ error: 'Not authenticated' }, 401);
  }
  try {
    const id = c.req.param('id');
    const result = await uninstallPlugin(id);
    return c.json(result);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'Uninstall failed' }, 400);
  }
});

// Admin: enable / disable a plugin
plugins.post('/:id/toggle', async (c) => {
  if (!c.get('auth').authenticated) {
    return c.json({ error: 'Not authenticated' }, 401);
  }
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const enabled = !!body?.enabled;
    const plugin = await setPluginEnabled(id, enabled);
    return c.json({ success: true, plugin });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'Toggle failed' }, 400);
  }
});

// Admin: update a plugin from its source repo
plugins.post('/:id/update', async (c) => {
  if (!c.get('auth').authenticated) {
    return c.json({ error: 'Not authenticated' }, 401);
  }
  try {
    const id = c.req.param('id');
    const plugin = await updatePlugin(id);
    return c.json({ success: true, plugin });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'Update failed' }, 400);
  }
});

export default plugins;
