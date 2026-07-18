import { promises as fs } from 'fs';
import path from 'path';
import type { MemoryData } from '../types';

const MEMORY_DIR = path.join(process.cwd(), 'data', 'memory');

const DEFAULT_MEMORY: MemoryData = {
  enabled: false,
  categories: {},
  updatedAt: 0,
};

// Per-user write queue to prevent race conditions when multiple extractions run concurrently
const writeQueues = new Map<string, Promise<unknown>>();

async function serializedWrite<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = (writeQueues.get(userId) || Promise.resolve()) as Promise<unknown>;
  const next = prev.then(fn, fn); // Run even if previous failed
  writeQueues.set(userId, next);
  // Cleanup after completion
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
  // Sanitize userId to prevent directory traversal
  const safe = userId.replace(/[^a-zA-Z0-9_\-]/g, '_');
  return path.join(MEMORY_DIR, `${safe}.json`);
}

export async function getMemory(userId: string): Promise<MemoryData> {
  try {
    await ensureDir();
    const filePath = memoryFilePath(userId);
    const data = await fs.readFile(filePath, 'utf-8');
    return { ...DEFAULT_MEMORY, ...JSON.parse(data) };
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

/**
 * Merge extracted memory entries into existing memory.
 * New categories/keys are added. Existing keys are overwritten if the extractor provides a new value.
 * Keys with empty string values are removed (deletion).
 * Uses a per-user write queue to prevent race conditions.
 */
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
        // Only create the category if it has non-empty entries
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
          // Empty value = delete this key
          delete categoryEntries[key];
        } else {
          categoryEntries[key] = value;
        }
      }

      // If category has no entries left, remove it
      if (Object.keys(categoryEntries).length === 0) {
        delete merged[category];
      } else {
        merged[category] = categoryEntries;
      }
    }

    // Enable memory automatically when entries are added
    const next: MemoryData = {
      ...current,
      enabled: Object.keys(merged).length > 0 ? true : current.enabled,
      categories: merged,
      updatedAt: Date.now(),
    };

    return saveMemory(userId, next);
  });
}
