import { Hono } from 'hono';
import { listSessionLogs, readSessionLog } from '../services/session-log';

const sessionLogs = new Hono();

// List all session logs (most recent first)
sessionLogs.get('/', async (c) => {
  if (!c.get('auth').authenticated) {
    return c.json({ error: 'Not authenticated' }, 401);
  }
  try {
    const logs = await listSessionLogs();
    return c.json({ logs });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'Failed' }, 500);
  }
});

// Read a specific session log
sessionLogs.get('/:runId', async (c) => {
  if (!c.get('auth').authenticated) {
    return c.json({ error: 'Not authenticated' }, 401);
  }
  const runId = c.req.param('runId');
  try {
    const events = await readSessionLog(runId);
    return c.json({ runId, events });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'Failed' }, 500);
  }
});

export default sessionLogs;
