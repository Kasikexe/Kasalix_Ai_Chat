import { Hono } from 'hono';
import {
  addMessage,
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
    const { title, model, mode, workspacePath } = await c.req.json();
    if (!model) return c.json({ error: 'model is required' }, 400);
    const conv = await createConversation(model, ownerId, title, mode, workspacePath);
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

// POST /:id/messages — Add a message to a conversation
conversations.post('/:id/messages', async (c) => {
  try {
    const ownerId = c.get('user').id;
    const convId = c.req.param('id');
    const { role, content } = await c.req.json();
    if (!role || !content) {
      return c.json({ error: 'role and content are required' }, 400);
    }
    const conv = await addMessage(convId, ownerId, { role, content, timestamp: Date.now() });
    if (!conv) return c.json({ error: 'Conversation not found' }, 404);
    return c.json({ conversation: conv });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'Failed to add message' }, 500);
  }
});

export default conversations;
