/**
 * Auto-detect model capabilities by probing Ollama.
 *
 * Instead of maintaining hardcoded lists of which model families support
 * tools / thinking, we send a lightweight test request on first use and
 * cache the result. New models "just work" without code changes.
 *
 * The cache is persisted to disk so probing only happens once per model.
 * Re-probing triggers when: a new model is pulled, the cache file is
 * deleted, or the model list changes.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { getDataDir } from '../utils/helpers';

const OLLAMA_BASE_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const CACHE_FILE = path.join(getDataDir(), 'model-capabilities.json');

interface ModelCaps {
  tools: boolean;
  thinking: boolean;
}

// In-memory cache: model name → capabilities
const capsCache = new Map<string, ModelCaps>();

// Probe timeout — don't hang longer than this per model
const PROBE_TIMEOUT_MS = 8_000;

// ─── Disk persistence ─────────────────────────────────────────────────

/** Load cached capabilities from disk. */
async function loadCache(): Promise<void> {
  try {
    const raw = await fs.readFile(CACHE_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') {
      for (const [model, caps] of Object.entries(data)) {
        if (caps && typeof caps === 'object' && 'tools' in caps && 'thinking' in caps) {
          capsCache.set(model, caps as ModelCaps);
        }
      }
      console.log(`[capabilities] Loaded ${capsCache.size} cached model capabilities`);
    }
  } catch {
    // No cache file yet — first run
  }
}

/** Save cached capabilities to disk. */
async function saveCache(): Promise<void> {
  try {
    const obj: Record<string, ModelCaps> = {};
    for (const [model, caps] of capsCache) {
      obj[model] = caps;
    }
    await fs.writeFile(CACHE_FILE, JSON.stringify(obj, null, 2), 'utf-8');
  } catch (e) {
    console.error('[capabilities] Failed to save cache:', e instanceof Error ? e.message : e);
  }
}

// ─── Probe functions ──────────────────────────────────────────────────

/**
 * Probe a model to determine if it supports tool calling.
 * Sends a minimal request with `tools: []` — if the model accepts it,
 * it supports the tools parameter.
 */
async function probeTools(model: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Say OK' }],
        stream: false,
        tools: [],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return false;
    const data = await res.json();
    // If the response has a valid message structure, tools are supported
    return !!(data.message?.content !== undefined);
  } catch {
    return false;
  }
}

/**
 * Probe a model to determine if it supports thinking mode.
 * Sends a minimal request with `think: true` — if the response
 * includes a `thinking` field, the model supports it.
 */
async function probeThinking(model: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'What is 2+2?' }],
        stream: false,
        think: true,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return false;
    const data = await res.json();
    // Models that support thinking return a "thinking" field in the message
    return !!(data.message?.thinking);
  } catch {
    return false;
  }
}

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Get cached capabilities for a model, probing if not yet cached.
 * Returns { tools, thinking } booleans.
 */
export async function getModelCapabilities(model: string): Promise<{ tools: boolean; thinking: boolean }> {
  const cached = capsCache.get(model);
  if (cached) {
    return cached;
  }

  console.log(`[capabilities] Probing model: ${model}`);
  const [tools, thinking] = await Promise.all([probeTools(model), probeThinking(model)]);
  console.log(`[capabilities] ${model}: tools=${tools}, thinking=${thinking}`);

  capsCache.set(model, { tools, thinking });
  // Persist after each new probe so we don't lose results on crash
  await saveCache();
  return { tools, thinking };
}

/**
 * Check if a model supports tool calling (cached, probes on first use).
 * Falls back to hardcoded list if probe fails.
 */
export async function supportsTools(model: string): Promise<boolean> {
  try {
    const caps = await getModelCapabilities(model);
    return caps.tools;
  } catch {}
  // Fallback to hardcoded patterns
  return FALLBACK_TOOL_MODELS.some((m) => model.toLowerCase().includes(m));
}

/**
 * Check if a model supports thinking mode (cached, probes on first use).
 * Falls back to hardcoded list if probe fails.
 */
export async function supportsThinking(model: string): Promise<boolean> {
  try {
    const caps = await getModelCapabilities(model);
    return caps.thinking;
  } catch {}
  // Fallback to hardcoded patterns
  return FALLBACK_THINKING_MODELS.some((m) => model.toLowerCase().includes(m));
}

/**
 * Probe all installed models at startup.
 * Loads cache from disk first, then only probes NEW models that
 * aren't already cached. Runs in background, non-blocking.
 */
export async function probeAllModels(): Promise<void> {
  try {
    // Load existing cache from disk
    await loadCache();

    // Get installed models from Ollama
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    if (!res.ok) return;
    const data = await res.json();
    const models: { name: string }[] = data.models || [];

    // Find models that aren't cached yet
    const uncached = models.filter((m) => !capsCache.has(m.name));

    if (uncached.length === 0) {
      console.log(`[capabilities] All ${models.length} models already cached — skipping probe`);
      return;
    }

    console.log(`[capabilities] ${uncached.length} new model(s) to probe (${capsCache.size} cached)...`);

    // Probe in parallel (but cap concurrency to avoid overwhelming Ollama)
    const BATCH = 3;
    for (let i = 0; i < uncached.length; i += BATCH) {
      const batch = uncached.slice(i, i + BATCH);
      await Promise.allSettled(batch.map((m) => getModelCapabilities(m.name)));
    }
    console.log(`[capabilities] Probe complete — ${capsCache.size} models total`);
  } catch (e) {
    console.error('[capabilities] Startup probe failed:', e instanceof Error ? e.message : e);
  }
}

/**
 * Clear the capabilities cache (e.g., when a new model is pulled).
 */
export async function clearCapabilitiesCache(): Promise<void> {
  capsCache.clear();
  try {
    await fs.unlink(CACHE_FILE);
  } catch {}
}

// ─── Fallback hardcoded lists (used when probe fails) ─────────────────

const FALLBACK_TOOL_MODELS = [
  'qwen3', 'qwen2.5', 'qwen2.5-coder', 'llama3.1', 'llama3.2', 'llama3.3',
  'mistral', 'mixtral', 'gemma3', 'phi4', 'phi-4', 'gpt-oss',
  'command-r', 'aya-expanse', 'minicpm-v', 'nemotron', 'molmo',
  'minimax', 'deepseek', 'glm', 'internlm',
];

const FALLBACK_THINKING_MODELS = [
  'qwen3', 'deepseek-r1', 'qwq', 'magpie',
];
