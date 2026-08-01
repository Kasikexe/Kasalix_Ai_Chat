import { promises as fs } from 'fs';
import path from 'path';
import type { MemoryData } from '../types';
import { getDataDir } from '../utils/helpers';

const MEMORY_DIR = path.join(getDataDir(), 'memory');

const DEFAULT_MEMORY: MemoryData = {
  enabled: false,
  categories: {},
  updatedAt: 0,
};

// ─── In-Memory Cache (#4) ──────────────────────────────────
// Cache memory data per-user for 5 seconds to avoid disk reads on every message
const MEMORY_CACHE_TTL = 5_000; // 5 seconds
const memoryCache = new Map<string, { data: MemoryData; timestamp: number }>();

function getCachedMemory(userId: string): MemoryData | null {
  const entry = memoryCache.get(userId);
  if (entry && Date.now() - entry.timestamp < MEMORY_CACHE_TTL) {
    return entry.data;
  }
  return null;
}

function setCachedMemory(userId: string, data: MemoryData): void {
  memoryCache.set(userId, { data, timestamp: Date.now() });
}

function invalidateCache(userId: string): void {
  memoryCache.delete(userId);
}

// Per-user write queue to prevent race conditions when multiple extractions run concurrently
const writeQueues = new Map<string, Promise<unknown>>();

async function serializedWrite<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = (writeQueues.get(userId) || Promise.resolve()) as Promise<unknown>;
  const next = prev.then(fn, fn);
  writeQueues.set(userId, next);
  next.finally(() => {
    if (writeQueues.get(userId) === next) {
      writeQueues.delete(userId);
    }
  });
  return next as Promise<T>;
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(MEMORY_DIR, { recursive: true });
}

function memoryFilePath(userId: string): string {
  const safe = userId.replace(/[^a-zA-Z0-9_\-]/g, '_');
  return path.join(MEMORY_DIR, `${safe}.json`);
}

export async function getMemory(userId: string): Promise<MemoryData> {
  // Check cache first
  const cached = getCachedMemory(userId);
  if (cached) return cached;

  try {
    await ensureDir();
    const filePath = memoryFilePath(userId);
    const data = await fs.readFile(filePath, 'utf-8');
    const result = { ...DEFAULT_MEMORY, ...JSON.parse(data) };
    setCachedMemory(userId, result);
    return result;
  } catch {
    return { ...DEFAULT_MEMORY };
  }
}

export async function saveMemory(userId: string, memory: MemoryData): Promise<MemoryData> {
  await ensureDir();
  const filePath = memoryFilePath(userId);
  const next: MemoryData = {
    ...memory,
    updatedAt: Date.now(),
  };
  await fs.writeFile(filePath, JSON.stringify(next, null, 2));
  invalidateCache(userId); // Invalidate cache on write
  setCachedMemory(userId, next); // Pre-populate cache
  return next;
}

export async function updateMemory(
  userId: string,
  updates: Partial<Pick<MemoryData, 'enabled'>> & {
    categories?: Record<string, Record<string, string>>;
  }
): Promise<MemoryData> {
  return serializedWrite(userId, async () => {
    const current = await getMemory(userId);
    const next: MemoryData = {
      ...current,
      ...updates,
      categories: updates.categories ?? current.categories,
      updatedAt: Date.now(),
    };
    return saveMemory(userId, next);
  });
}

export async function mergeMemoryEntries(
  userId: string,
  extracted: Record<string, Record<string, string>>
): Promise<MemoryData | null> {
  return serializedWrite(userId, async () => {
    const current = await getMemory(userId);
    if (!current.enabled) return null;

    const merged: Record<string, Record<string, string>> = { ...current.categories };

    for (const [category, entries] of Object.entries(extracted)) {
      if (!merged[category]) {
        const nonEmpty = Object.fromEntries(
          Object.entries(entries).filter(([, v]) => v !== '')
        );
        if (Object.keys(nonEmpty).length > 0) {
          merged[category] = nonEmpty;
        }
        continue;
      }

      const categoryEntries = { ...merged[category] };
      for (const [key, value] of Object.entries(entries)) {
        if (value === '') {
          delete categoryEntries[key];
        } else {
          categoryEntries[key] = value;
        }
      }

      if (Object.keys(categoryEntries).length === 0) {
        delete merged[category];
      } else {
        merged[category] = categoryEntries;
      }
    }

    const next: MemoryData = {
      ...current,
      enabled: Object.keys(merged).length > 0 ? true : current.enabled,
      categories: merged,
      updatedAt: Date.now(),
    };

    return saveMemory(userId, next);
  });
}
