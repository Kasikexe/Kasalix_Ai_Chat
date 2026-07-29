import { Hono } from 'hono';
import { promises as fs } from 'fs';
import path from 'path';
import type { Variables } from '../types';

const SETTINGS_FILE = path.join(process.cwd(), 'data', 'settings.json');
const SETTINGS_DIR = path.dirname(SETTINGS_FILE);

// Load settings password — first from persisted file, then env var, then default
let SETTINGS_PASSWORD = process.env.SETTINGS_PASSWORD || 'letmein';
try {
  const savedPw = require('fs').readFileSync(path.join(process.cwd(), 'data', 'settings_password.txt'), 'utf-8').trim();
  if (savedPw) SETTINGS_PASSWORD = savedPw;
} catch { /* no saved password file — using env/default */ }

interface AppSettings {
  hiddenModels: string[];
  modelAssignments?: Record<string, string>;
  updatedAt: number;
}

const DEFAULT_SETTINGS: AppSettings = {
  hiddenModels: [],
  modelAssignments: {},
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

      updatedAt: Date.now(),
    };
    await saveSettings(next);
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
    if (currentPassword !== SETTINGS_PASSWORD) {
      return c.json({ error: 'Current password is incorrect' }, 401);
    }

    // Update the in-memory variable immediately
    SETTINGS_PASSWORD = newPassword;

    // Persist to file so it survives restarts
    const pwDir = path.join(process.cwd(), 'data');
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
    const pwFile = path.join(process.cwd(), 'data', 'settings_password.txt');
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

export default settings;
export { SETTINGS_PASSWORD };
