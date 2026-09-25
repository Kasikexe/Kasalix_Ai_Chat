import { Hono } from 'hono';
import { spawn, execSync, type ChildProcess } from 'child_process';
import type { Variables } from '../types';
import { loadSettings } from './settings';
import fs from 'fs';
import path from 'path';
import os from 'os';

const OLLAMA_BASE_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

// ─── Ollama Process State ─────────────────────────────────────
let ollamaProcess: ChildProcess | null = null;
let ollamaPid: number | null = null;
let ownedByUs = false; // whether WE spawned Ollama (vs. it was already running)
let restarting = false;

/** Detect if Ollama is reachable via HTTP */
async function isOllamaRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Get models currently loaded in Ollama (from /api/ps) */
async function getLoadedModels(): Promise<any[]> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/ps`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.models || [];
  } catch {
    return [];
  }
}

/** Poll until Ollama port becomes unreachable (process killed) */
async function waitForPortFree(maxMs = 10_000): Promise<void> {
  const start = Date.now();
  // First poll — wait for Ollama to start responding with failures
  let failedOnce = false;
  while (Date.now() - start < maxMs) {
    const running = await isOllamaRunning();
    if (!running) {
      failedOnce = true;
      // Safety buffer: port might be freed but OS hasn't released it yet
      await new Promise((r) => setTimeout(r, 500));
      // Double-check it's still down
      const stillDown = !(await isOllamaRunning());
      if (stillDown) return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!failedOnce) {
    console.warn('[ollama] Port did not free within timeout — proceeding anyway');
  }
}

/** Poll until Ollama is reachable again (new process started) */
async function waitForOllamaUp(maxMs = 30_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (await isOllamaRunning()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Kill all Ollama processes (cross-platform). Handles multiple ollama.exe instances. */
function killOllama(): void {
  // Always kill by name to catch ALL instances (ollama.exe, ollama app.exe, etc.)
  // then also clean up our tracked PID if we had one
  if (ollamaPid) {
    try {
      if (process.platform === 'win32') {
        // Kill by PID + tree first
        execSync(`taskkill /PID ${ollamaPid} /F /T 2>nul`, { windowsHide: true });
      } else {
        process.kill(ollamaPid, 'SIGTERM');
      }
      console.log(`[ollama] Killed tracked process PID ${ollamaPid}`);
    } catch (e) {
      console.warn(`[ollama] PID kill failed (may already be dead): ${(e as Error).message}`);
    }
    ollamaPid = null;
    ollamaProcess = null;
  }

  // Now kill ALL remaining Ollama processes by name (catches siblings, ollama app.exe, etc.)
  try {
    if (process.platform === 'win32') {
      // Kill all ollama.exe processes (server + app)
      execSync('taskkill /IM ollama.exe /F 2>nul', { windowsHide: true });
      // Also kill "Ollama App" if it's a separate process name
      execSync('taskkill /IM "Ollama App.exe" /F 2>nul', { windowsHide: true });
      // Broader fallback: kill any process with "ollama" in command line
      execSync('wmic process where "name like \"%ollama%\"" call terminate 2>nul', { windowsHide: true });
    } else {
      execSync('pkill -9 -f ollama 2>/dev/null', { windowsHide: true });
    }
    console.log('[ollama] Killed all Ollama processes by name');
  } catch (e) {
    // wmic/pkill may fail if no processes match — that's fine
    console.warn(`[ollama] Name-based kill completed: ${(e as Error).message}`);
  }
  // Clean up ownership flag file
  try {
    const flagPath = path.join(os.tmpdir(), "kasalix-ollama-owned");
    if (fs.existsSync(flagPath)) fs.unlinkSync(flagPath);
  } catch {}

}

/** Spawn Ollama with the given environment overrides */
function spawnOllama(envOverrides: Record<string, string> = {}): void {
  const fullEnv = { ...process.env, ...envOverrides };

  const args = ['serve'];
  const proc = spawn('ollama', args, {
    env: fullEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    shell: process.platform === 'win32',
  });

  ollamaProcess = proc;
  ollamaPid = proc.pid || null;
  ownedByUs = true;

  proc.stdout?.on('data', (d: Buffer) => {
    const text = d.toString();
    console.log(`[ollama:stdout] ${text.trimEnd()}`);
  });

  proc.stderr?.on('data', (d: Buffer) => {
    const text = d.toString();
    console.log(`[ollama:stderr] ${text.trimEnd()}`);
  });

  proc.on('exit', (code: number | null) => {
    console.log(`[ollama] Process exited with code ${code}`);
    ollamaProcess = null;
    ollamaPid = null;
    if (ownedByUs) ownedByUs = false;
  });

  proc.on('error', (err: Error) => {
    console.error(`[ollama] Spawn error: ${err.message}`);
    ollamaProcess = null;
    ollamaPid = null;
    ownedByUs = false;
  });
}

/** Build environment variables from Ollama settings */
function buildOllamaEnv(kvCacheOffload: boolean, kvCacheType: string = 'f16'): Record<string, string> {
  const env: Record<string, string> = {};
  // When kvCacheOffload is false, keep KV cache in RAM (more context, slower)
  if (!kvCacheOffload) {
    env.LLAMA_ARG_KV_OFFLOAD = '0';
  }
  // KV cache quantization — affects quality vs memory tradeoff
  // f32: highest quality, most memory
  // f16: good balance (default)
  // q8_0: ~50% memory savings, slight quality loss
  // q4_0: ~75% memory savings, noticeable quality loss
  if (kvCacheType && kvCacheType !== 'f32') {
    env.LLAMA_ARG_CACHE_TYPE_K = kvCacheType;
    env.LLAMA_ARG_CACHE_TYPE_V = kvCacheType;
  }
  return env;
}

/** Call on startup to detect if Ollama is already running */
export async function detectOllamaOwnership(): Promise<void> {
  const running = await isOllamaRunning();
  if (running) {
    // Check if server-gui started Ollama (flag file)
    try {
      const flagPath = path.join(os.tmpdir(), "kasalix-ollama-owned");
      if (fs.existsSync(flagPath)) {
        ownedByUs = true;
        console.log("[ollama] Detected running Ollama instance (owned by app)");
        return;
      }
    } catch {}
    ownedByUs = false;
    console.log("[ollama] Detected running Ollama instance (not owned by us)");
  } else {
    console.log("[ollama] No running Ollama instance detected");
  }
}

/**
 * Restart Ollama with updated settings.
 * Returns { success, wasRunning, modelsInterrupted, error? }
 */
export async function restartOllama(
  kvCacheOffload: boolean,
  kvCacheType: string = 'f16',
  confirm: boolean = false
): Promise<{
  success: boolean;
  wasRunning: boolean;
  modelsInterrupted: boolean;
  ownedByUs: boolean;
  error?: string;
}> {
  if (restarting) {
    return { success: false, wasRunning: false, modelsInterrupted: false, ownedByUs, error: 'Restart already in progress' };
  }

  restarting = true;

  try {
    const wasRunning = await isOllamaRunning();
    const loadedModels = wasRunning ? await getLoadedModels() : [];
    const modelsInterrupted = loadedModels.length > 0;

    // If models are loaded and user hasn't confirmed, return warning
    if (modelsInterrupted && !confirm) {
      return {
        success: false,
        wasRunning,
        modelsInterrupted: true,
        ownedByUs,
        error: `Model(s) currently loaded: ${loadedModels.map((m: any) => m.name || m.model).join(', ')}. Pass confirm=true to force restart.`,
      };
    }

    // Kill existing Ollama
    if (wasRunning) {
      killOllama();
      await waitForPortFree();
    }

    // Spawn new Ollama with env vars
    const envOverrides = buildOllamaEnv(kvCacheOffload, kvCacheType);
    console.log(`[ollama] Restarting with env: ${JSON.stringify(envOverrides)}`);
    spawnOllama(envOverrides);

    // Wait for it to come up
    const up = await waitForOllamaUp();
    if (!up) {
      return {
        success: false,
        wasRunning,
        modelsInterrupted,
        ownedByUs: true,
        error: 'Ollama did not come back up within 30 seconds',
      };
    }

    console.log('[ollama] Restart successful — Ollama is back up');
    return {
      success: true,
      wasRunning,
      modelsInterrupted,
      ownedByUs: true,
    };
  } catch (e) {
    return {
      success: false,
      wasRunning: false,
      modelsInterrupted: false,
      ownedByUs,
      error: (e as Error).message,
    };
  } finally {
    restarting = false;
  }
}

/** Get current Ollama process status */
export function getOllamaStatus(): {
  running: boolean;
  ownedByUs: boolean;
  pid: number | null;
  restarting: boolean;
} {
  return {
    running: ollamaProcess !== null && ollamaProcess.exitCode === null,
    ownedByUs,
    pid: ollamaPid,
    restarting,
  };
}

// ─── HTTP Routes ──────────────────────────────────────────────

const ollamaRoutes = new Hono<{ Variables: Variables }>();

/** GET /api/ollama/status — check Ollama status */
ollamaRoutes.get('/status', async (c) => {
  const status = getOllamaStatus();
  const running = await isOllamaRunning();
  const loadedModels = running ? await getLoadedModels() : [];

  return c.json({
    ...status,
    running,
    loadedModels,
  });
});

/** POST /api/ollama/restart — restart Ollama with current settings */
ollamaRoutes.post('/restart', async (c) => {
  if (!c.get('auth').authenticated) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  try {
    const body = await c.req.json().catch(() => ({}));
    const confirm = body.confirm === true;

    // Load current settings
    const settings = await loadSettings();
    const kvCacheOffload = settings.kvCacheOffload !== false;
    const kvCacheType = settings.kvCacheType || 'f16';

    const result = await restartOllama(kvCacheOffload, kvCacheType, confirm);
    return c.json(result);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

/** POST /api/ollama/apply — save Ollama settings + restart */
ollamaRoutes.post('/apply', async (c) => {
  if (!c.get('auth').authenticated) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  try {
    const body = await c.req.json();
    const confirm = body.confirm === true;
    const kvCacheOffload = body.kvCacheOffload !== false;
    const kvCacheType = body.kvCacheType || 'f16';

    // Save settings (handled by the caller via PUT /api/settings)
    // This endpoint just does the restart
    const result = await restartOllama(kvCacheOffload, kvCacheType, confirm);
    return c.json(result);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

export default ollamaRoutes;
