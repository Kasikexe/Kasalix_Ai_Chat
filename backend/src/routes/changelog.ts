import { Hono } from 'hono';
import { getChangelog, addChangelogEntry, deleteChangelogEntry, getDraft, updateDraft, publishDraft } from '../services/changelog';

const changelog = new Hono();

// GET /api/changelog — public, anyone can view
changelog.get('/', async (c) => {
  const entries = await getChangelog();
  return c.json({ entries });
});

// POST /api/changelog — admin only
changelog.post('/', async (c) => {
  const isAuthed = c.get('auth').authenticated;
  if (!isAuthed) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  const body = await c.req.json();
  const { version, title, description, type } = body as {
    version: string;
    title: string;
    description: string;
    type: 'major' | 'minor' | 'patch';
  };

  if (!version || !title || !description || !type) {
    return c.json({ error: 'version, title, description, and type are required' }, 400);
  }

  const validTypes = ['major', 'minor', 'patch'];
  if (!validTypes.includes(type)) {
    return c.json({ error: 'type must be major, minor, or patch' }, 400);
  }

  const entry = await addChangelogEntry({ version, title, description, type });
  return c.json({ entry }, 201);
});

// DELETE /api/changelog/:version — admin only
changelog.delete('/:version', async (c) => {
  const isAuthed = c.get('auth').authenticated;
  if (!isAuthed) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  const version = c.req.param('version');
  const deleted = await deleteChangelogEntry(version);
  if (!deleted) {
    return c.json({ error: 'Version not found' }, 404);
  }
  return c.json({ success: true });
});

// ─── Draft Routes (admin only) ──────────────────────────────

// GET /api/changelog/draft — get current working draft
changelog.get('/draft', async (c) => {
  const draft = await getDraft();
  return c.json({ draft });
});

// PUT /api/changelog/draft — save draft changes
changelog.put('/draft', async (c) => {
  if (!c.get('auth').authenticated) {
    return c.json({ error: 'Not authenticated' }, 401);
  }
  const body = await c.req.json();
  const { description } = body as { description: string };
  if (description === undefined) {
    return c.json({ error: 'description is required' }, 400);
  }
  const draft = await updateDraft(description);
  return c.json({ draft });
});

// POST /api/changelog/draft/publish — publish draft as a release
changelog.post('/draft/publish', async (c) => {
  if (!c.get('auth').authenticated) {
    return c.json({ error: 'Not authenticated' }, 401);
  }
  const body = await c.req.json();
  const { version, title, type } = body as {
    version: string;
    title: string;
    type: 'major' | 'minor' | 'patch';
  };
  if (!version || !title || !type) {
    return c.json({ error: 'version, title, and type are required' }, 400);
  }
  const validTypes = ['major', 'minor', 'patch'];
  if (!validTypes.includes(type)) {
    return c.json({ error: 'type must be major, minor, or patch' }, 400);
  }
  const entry = await publishDraft(version, title, type);
  return c.json({ entry }, 201);
});

export default changelog;
