import type { Context } from 'hono';

export const errorHandler = (err: Error, c: Context) => {
  console.error('API Error:', err);
  return c.json({ error: err.message || 'Internal server error' }, 500);
};

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
