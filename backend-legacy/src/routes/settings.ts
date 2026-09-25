import { Hono } from 'hono';
import { promises as fs } from 'fs';
import path from 'path';
import type { Variables } from '../types';
import { getDataDir } from '../utils/helpers';
import { invalidateNumCtxCache } from '../services/ollama';

const SETTINGS_DIR = getDataDir();
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');

// Load settings password — first from persisted file, then env var, then default
const PW_FILE = path.join(SETTINGS_DIR, 'settings_password.txt');
let SETTINGS_PASSWORD = process.env.SETTINGS_PASSWORD || 'letmein';

// Reload the password from the persisted file on every check so that a
// reset from the Server app (or deleting the file) takes effect immediately
// without restarting the backend.
function reloadSettingsPassword(): void {
  try {
    const savedPw = require('fs').readFileSync(PW_FILE, 'utf-8').trim();
    SETTINGS_PASSWORD = savedPw || process.env.SETTINGS_PASSWORD || 'letmein';
  } catch {
    SETTINGS_PASSWORD = process.env.SETTINGS_PASSWORD || 'letmein';
  }
}
reloadSettingsPassword();

interface AppSettings {
  hiddenModels: string[];
  modelAssignments?: Record<string, string>;
  cloudModelAssignments?: Record<string, string>;
  cloudMode?: 'auto' | 'local' | 'cloud';
  cloudApiKey?: string;
  cloudEndpoint?: string;
  /** KV cache GPU offloading — when false, KV cache stays in system RAM */
  kvCacheOffload?: boolean;
  /** KV cache quantization type (f32, f16, q8_0, q4_0) */
  kvCacheType?: string;
  /** Default context window size for all models (num_ctx) */
  defaultNumCtx?: number;
  updatedAt: number;
}

const DEFAULT_SETTINGS: AppSettings = {
  hiddenModels: [],
  modelAssignments: {},
  cloudModelAssignments: {},
  cloudMode: 'auto',
  cloudApiKey: '',
  cloudEndpoint: '',
  kvCacheOffload: true,
  kvCacheType: 'f16',
  defaultNumCtx: 0,
  updatedAt: 0,
};

async function ensureDir(): Promise<void> {
  await fs.mkdir(SETTINGS_DIR, { recursive: true });
}

async function loadSettings(): Promise<AppSettings> {
  try {
    await ensureDir();
    const data = await fs.readFile(SETTINGS_FILE, 'utf-8');
    return { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

async function saveSettings(settings: AppSettings): Promise<void> {
  await ensureDir();
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

const settings = new Hono<{ Variables: Variables }>();

// Public: read the filter (everyone respects it)
settings.get('/', async (c) => {
  const data = await loadSettings();
  return c.json(data);
});

// Public: check if this request is authenticated
settings.get('/auth', (c) => {
  return c.json({ authenticated: c.get('auth').authenticated });
});

// Public: try to authenticate
settings.post('/auth', async (c) => {
  try {
    const body = await c.req.json();
    reloadSettingsPassword();
    if (body.password === SETTINGS_PASSWORD) {
      c.header('Set-Cookie', 'settings_auth=1; HttpOnly; Path=/; SameSite=Strict; Max-Age=86400');
      return c.json({ authenticated: true });
    }
    return c.json({ error: 'Wrong password' }, 401);
  } catch {
    return c.json({ error: 'Invalid request' }, 400);
  }
});

// Protected: requires authentication
settings.put('/', async (c) => {
  if (!c.get('auth').authenticated) {
    return c.json({ error: 'Not authenticated' }, 401);
  }
  try {
    const body = await c.req.json();
    // Merge with existing settings to preserve fields not sent in this request
    const existing = await loadSettings();
    const next: AppSettings = {
      ...existing,
      ...(body.hiddenModels !== undefined
        ? { hiddenModels: body.hiddenModels }
        : {}),
      ...(body.modelAssignments !== undefined
        ? { modelAssignments: body.modelAssignments }
        : {}),
      ...(body.cloudMode !== undefined
        ? { cloudMode: body.cloudMode }
        : {}),
      ...(body.cloudApiKey !== undefined
        ? { cloudApiKey: body.cloudApiKey }
        : {}),
      ...(body.cloudEndpoint !== undefined
        ? { cloudEndpoint: body.cloudEndpoint }
        : {}),
      ...(body.cloudModelAssignments !== undefined
        ? { cloudModelAssignments: body.cloudModelAssignments }
        : {}),
      ...(body.kvCacheOffload !== undefined
        ? { kvCacheOffload: body.kvCacheOffload }
        : {}),
      ...(body.kvCacheType !== undefined
        ? { kvCacheType: body.kvCacheType }
        : {}),
      ...(body.defaultNumCtx !== undefined
        ? { defaultNumCtx: body.defaultNumCtx }
        : {}),

      updatedAt: Date.now(),
    };
    await saveSettings(next);
    // Invalidate num_ctx cache so the next API call picks up new settings
    if (body.defaultNumCtx !== undefined) invalidateNumCtxCache();
    return c.json(next);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'Failed to save' }, 500);
  }
});

settings.post('/reset', async (c) => {
  if (!c.get('auth').authenticated) {
    return c.json({ error: 'Not authenticated' }, 401);
  }
  const data: AppSettings = { ...DEFAULT_SETTINGS, modelAssignments: {}, updatedAt: Date.now() };
  await saveSettings(data);
  return c.json(data);
});

// Protected: change settings password
settings.post('/password', async (c) => {
  if (!c.get('auth').authenticated) {
    return c.json({ error: 'Not authenticated' }, 401);
  }
  try {
    const body = await c.req.json();
    const { currentPassword, newPassword } = body as { currentPassword: string; newPassword: string };

    if (!currentPassword || !newPassword) {
      return c.json({ error: 'Current password and new password are required' }, 400);
    }
    if (newPassword.length < 4) {
      return c.json({ error: 'New password must be at least 4 characters' }, 400);
    }

    // Verify current password
    reloadSettingsPassword();
    if (currentPassword !== SETTINGS_PASSWORD) {
      return c.json({ error: 'Current password is incorrect' }, 401);
    }

    // Update the in-memory variable immediately
    SETTINGS_PASSWORD = newPassword;

    // Persist to file so it survives restarts
    const pwDir = getDataDir();
    await fs.mkdir(pwDir, { recursive: true });
    await fs.writeFile(path.join(pwDir, 'settings_password.txt'), newPassword, 'utf-8');

    return c.json({ success: true, message: 'Password updated' });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'Failed to change password' }, 500);
  }
});

// Get current password info (whether a custom password is set)
settings.get('/password', async (c) => {
  if (!c.get('auth').authenticated) {
    return c.json({ error: 'Not authenticated' }, 401);
  }
  try {
    const pwFile = path.join(getDataDir(), 'settings_password.txt');
    let isCustom = false;
    try {
      await fs.access(pwFile);
      isCustom = true;
    } catch {}
    return c.json({
      isCustom,
      message: isCustom ? 'Custom password is set' : 'Using default password',
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'Failed' }, 500);
  }
});

// Protected: fetch available models from the configured cloud API
// Uses OpenAI-compatible GET /v1/models endpoint
settings.get('/cloud-models', async (c) => {
  if (!c.get('auth').authenticated) {
    return c.json({ error: 'Not authenticated' }, 401);
  }
  try {
    const cloud = await getCloudSettings();
    if (!cloud.cloudEndpoint) {
      return c.json({ models: [], error: 'No cloud endpoint configured' });
    }
    if (!cloud.cloudApiKey) {
      return c.json({ models: [], error: 'No API key configured' });
    }

    // Normalize endpoint — strip trailing slash
    const base = cloud.cloudEndpoint.replace(/\/+$/, '');

    // Ollama Cloud models — try /v1/models first (OpenAI-compatible, works on ollama.com)
    // then /api/tags as fallback (works on local Ollama instances)
    let models: { id: string; name?: string; owned_by?: string }[] = [];
    let lastError = '';
    let lastStatus = 0;

    // Attempt 1: /v1/models (OpenAI-compatible — works on ollama.com cloud)
    try {
      const url = `${base}/v1/models`;
      console.log(`[settings] Fetching cloud models via /v1/models: ${url}`);
      const res = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${cloud.cloudApiKey}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(10_000),
      });
      lastStatus = res.status;
      if (res.ok) {
        const data = await res.json();
        // OpenAI format: { data: [{ id: "model-name", ... }] }
        if (Array.isArray(data.data)) {
          models = data.data.map((m: any) => ({
            id: m.id || m.name,
            name: m.id || m.name,
            owned_by: m.owned_by || 'ollama',
          }));
        } else if (Array.isArray(data.models)) {
          // Some proxies return { models: [...] }
          models = data.models.map((m: any) => ({
            id: m.name || m.id || m.model,
            name: m.name || m.id || m.model,
            owned_by: m.details?.family || 'ollama',
          }));
        }
        console.log(`[settings] /v1/models returned ${models.length} models`);
      } else {
        const body = await res.text().catch(() => '');
        lastError = `/v1/models returned ${res.status}: ${body.slice(0, 200)}`;
        console.warn(`[settings] ${lastError}`);
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      console.error(`[settings] /v1/models fetch failed:`, lastError);
    }

    // Attempt 2: /api/tags (native Ollama format — works on local instances)
    if (models.length === 0) {
      try {
        const url = `${base}/api/tags`;
        console.log(`[settings] Trying /api/tags fallback: ${url}`);
        const res = await fetch(url, {
          headers: {
            'Authorization': `Bearer ${cloud.cloudApiKey}`,
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.models)) {
            models = data.models.map((m: any) => ({
              id: m.name || m.model,
              name: m.name || m.model,
              owned_by: m.details?.family || 'ollama',
            }));
          }
          console.log(`[settings] /api/tags returned ${models.length} models`);
        } else {
          lastError = `/api/tags returned ${res.status}`;
          console.warn(`[settings] ${lastError}`);
        }
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        console.error(`[settings] /api/tags fetch failed:`, lastError);
      }
    }


    if (models.length === 0) {
      const detail = lastError || 'No models found';
      console.error(`[settings] No cloud models available. Status: ${lastStatus}, Error: ${detail}`);
      return c.json({ models: [], error: detail });
    }

    const result = models
      .map((m) => ({ id: m.id, name: m.name || m.id, owned_by: m.owned_by || 'ollama' }))
      .sort((a, b) => a.id.localeCompare(b.id));

    console.log(`[settings] Found ${result.length} Ollama Cloud models`);
    return c.json({ models: result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[settings] Cloud models fetch error: ${msg}`);
    return c.json({ models: [], error: msg });
  }
});

export default settings;
export { SETTINGS_PASSWORD, loadSettings };

/**
 * Read cloud-related settings (cloudMode, cloudApiKey, cloudEndpoint).
 * Used by the pipeline to decide routing and by the health check.
 */
// In-memory cache for settings file (avoids multiple disk reads per request)
let _settingsCache: { data: any; timestamp: number } | null = null;
const SETTINGS_CACHE_TTL = 2000; // 2 seconds

async function readSettingsCached(): Promise<any> {
  if (_settingsCache && Date.now() - _settingsCache.timestamp < SETTINGS_CACHE_TTL) {
    return _settingsCache.data;
  }
  try {
    const data = await fs.readFile(SETTINGS_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    _settingsCache = { data: parsed, timestamp: Date.now() };
    return parsed;
  } catch {
    return {};
  }
}

/**
 * Read cloud-related settings (cloudMode, cloudApiKey, cloudEndpoint).
 * Used by the pipeline to decide routing and by the health check.
 */
export async function getCloudSettings(): Promise<{
  cloudMode: 'auto' | 'local' | 'cloud';
  cloudApiKey: string;
  cloudEndpoint: string;
}> {
  const parsed = await readSettingsCached();
  return {
    cloudMode: parsed.cloudMode || 'auto',
    cloudApiKey: parsed.cloudApiKey || '',
    cloudEndpoint: parsed.cloudEndpoint || '',
  };
}

/**
 * Read Ollama-specific settings (kvCacheOffload).
 */
export async function getOllamaSettings(): Promise<{
  kvCacheOffload: boolean;
  kvCacheType: string;
  defaultNumCtx: number;
}> {
  const parsed = await readSettingsCached();
  return {
    kvCacheOffload: parsed.kvCacheOffload !== false,
    kvCacheType: parsed.kvCacheType || 'f16',
    defaultNumCtx: parsed.defaultNumCtx || 0,
  };
}
