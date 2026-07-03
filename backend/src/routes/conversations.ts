import { Hono } from 'hono';
import {
  createConversation,
  deleteConversation,
  getAllConversations,
  getConversation,
  updateConversation,
} from '../services/storage';
import type { Variables } from '../types';

const conversations = new Hono<{ Variables: Variables }>();

conversations.get('/', async (c) => {
  const ownerId = c.get('user').id;
  const list = await getAllConversations(ownerId);
  return c.json({ conversations: list });
});

conversations.get('/:id', async (c) => {
  const ownerId = c.get('user').id;
  const conv = await getConversation(c.req.param('id'), ownerId);
  if (!conv) return c.json({ error: 'Not found' }, 404);
  return c.json({ conversation: conv });
});

conversations.post('/', async (c) => {
  try {
    const ownerId = c.get('user').id;
    const { title, model } = await c.req.json();
    if (!model) return c.json({ error: 'model is required' }, 400);
    const conv = await createConversation(model, ownerId, title);
    return c.json({ conversation: conv });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'Failed to create' }, 500);
  }
});

conversations.put('/:id', async (c) => {
  try {
    const ownerId = c.get('user').id;
    const id = c.req.param('id');
    const updates = await c.req.json();
    const conv = await updateConversation(id, ownerId, updates);
    if (!conv) return c.json({ error: 'Not found' }, 404);
    return c.json({ conversation: conv });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'Failed to update' }, 500);
  }
});

conversations.delete('/:id', async (c) => {
  const ownerId = c.get('user').id;
  const ok = await deleteConversation(c.req.param('id'), ownerId);
  if (!ok) return c.json({ error: 'Not found' }, 404);
  return c.json({ success: true });
});

export default conversations;
