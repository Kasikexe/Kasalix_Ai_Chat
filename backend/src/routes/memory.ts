import { Hono } from 'hono';
import { getMemory, saveMemory, updateMemory } from '../services/memory';
import { extractMemoryFromTurn } from '../services/extractor';
import type { Variables, MemoryData } from '../types';

const memory = new Hono<{ Variables: Variables }>();

// Get memory for the current user
memory.get('/', async (c) => {
  const userId = c.get('user').id;
  const data = await getMemory(userId);
  return c.json(data);
});

// Update memory (manual edits from user)
memory.put('/', async (c) => {
  const userId = c.get('user').id;
  try {
    const body = await c.req.json();
    const updates: Partial<Pick<MemoryData, 'enabled'>> & {
      categories?: Record<string, Record<string, string>>;
    } = {};

    if (typeof body.enabled === 'boolean') {
      updates.enabled = body.enabled;
    }

    if (body.categories && typeof body.categories === 'object') {
      updates.categories = body.categories;
    }

    if (Object.keys(updates).length === 0) {
      return c.json({ error: 'No valid updates provided' }, 400);
    }

    const result = await updateMemory(userId, updates);
    return c.json(result);
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'Failed to update memory' },
      500
    );
  }
});

// Reset memory for the current user (clear all)
memory.delete('/', async (c) => {
  const userId = c.get('user').id;
  const reset: MemoryData = {
    enabled: false,
    categories: {},
    updatedAt: Date.now(),
  };
  const result = await saveMemory(userId, reset);
  return c.json(result);
});

// Internal: trigger memory extraction from a conversation turn
// This is called by the chat route after sending a response
memory.post('/extract', async (c) => {
  try {
    const userId = c.get('user').id;
    const body = await c.req.json();
    const userMessage: string = body.userMessage || '';
    const assistantResponse: string = body.assistantResponse || '';

    if (!userMessage || !assistantResponse) {
      return c.json({ error: 'userMessage and assistantResponse are required' }, 400);
    }

    // Fire and forget — don't await
    extractMemoryFromTurn(userId, userMessage, assistantResponse);

    return c.json({ status: 'extraction started' });
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'Failed to start extraction' },
      500
    );
  }
});

export default memory;
