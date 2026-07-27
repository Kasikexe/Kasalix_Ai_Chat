import { Hono } from 'hono';
import {
  getPlannedFeatures,
  addPlannedFeature,
  updatePlannedFeature,
  deletePlannedFeature,
} from '../services/planned';

const planned = new Hono();

// GET /api/planned — public, anyone can view
planned.get('/', async (c) => {
  const features = await getPlannedFeatures();
  return c.json({ features });
});

// POST /api/planned — admin only
planned.post('/', async (c) => {
  if (!c.get('auth').authenticated) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  const body = await c.req.json();
  const { title, description, status, icon } = body as {
    title: string;
    description: string;
    status?: 'done' | 'in-progress' | 'planned';
    icon?: string;
  };

  if (!title || !description) {
    return c.json({ error: 'title and description are required' }, 400);
  }

  const validStatuses = ['done', 'in-progress', 'planned'];
  if (status && !validStatuses.includes(status)) {
    return c.json({ error: 'status must be done, in-progress, or planned' }, 400);
  }

  const feature = await addPlannedFeature({
    title,
    description,
    status: status || 'planned',
    icon: icon || '📋',
  });
  return c.json({ feature }, 201);
});

// PUT /api/planned/:id — admin only (update feature)
planned.put('/:id', async (c) => {
  if (!c.get('auth').authenticated) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  const id = c.req.param('id');
  const body = await c.req.json();

  // Only pass fields that are actually present in the request body
  // This prevents undefined values from overwriting existing data
  const updates: Record<string, unknown> = {};
  if (body.title !== undefined) updates.title = body.title;
  if (body.description !== undefined) updates.description = body.description;
  if (body.status !== undefined) {
    const validStatuses = ['done', 'in-progress', 'planned'];
    if (!validStatuses.includes(body.status)) {
      return c.json({ error: 'Invalid status' }, 400);
    }
    updates.status = body.status;
  }
  if (body.icon !== undefined) updates.icon = body.icon;
  if (body.order !== undefined) updates.order = body.order;

  const updated = await updatePlannedFeature(id, updates);

  if (!updated) {
    return c.json({ error: 'Feature not found' }, 404);
  }
  return c.json({ feature: updated });
});

// DELETE /api/planned/:id — admin only
planned.delete('/:id', async (c) => {
  if (!c.get('auth').authenticated) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  const id = c.req.param('id');
  const deleted = await deletePlannedFeature(id);
  if (!deleted) {
    return c.json({ error: 'Feature not found' }, 404);
  }
  return c.json({ success: true });
});

export default planned;
