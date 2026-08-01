import type { Context } from 'hono';
import path from 'path';

export const errorHandler = (err: Error, c: Context) => {
  console.error('API Error:', err);
  return c.json({ error: err.message || 'Internal server error' }, 500);
};

// Where persistent user data (accounts, conversations, speed tests, memory,
// uploads, settings) lives. The Server App passes DATA_DIR so runtime data is
// stored in a STABLE per-user folder that survives updates — otherwise the
// portable exe writes it into a temp extraction dir that gets wiped.
export const getDataDir = (): string =>
  process.env.DATA_DIR || path.join(process.cwd(), 'data');

// Where generated images live. Same rationale — overridable so they persist.
export const getGeneratedImagesDir = (): string =>
  process.env.GENERATED_IMAGES_DIR || path.join(process.cwd(), 'generated_images');

export const generateId = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
};

export const truncate = (text: string, max: number): string => {
  if (text.length <= max) return text;
  return text.slice(0, max).trim() + '...';
};
