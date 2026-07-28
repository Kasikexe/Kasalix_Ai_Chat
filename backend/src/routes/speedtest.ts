import { Hono } from 'hono';
import { SPEED_TESTS, getResults, deleteResult, runSpeedTests } from '../services/speedtest';

const speedtest = new Hono();

// GET /api/speedtest/tests — public, return available test definitions
speedtest.get('/tests', (c) => {
  // Return test definitions organized by model assignment
  const testList = SPEED_TESTS.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    category: t.category,
    assignmentKey: t.assignmentKey,
  }));
  return c.json({ tests: testList });
});

// POST /api/speedtest/run — admin only, run the full test suite across all models
speedtest.post('/run', async (c) => {
  if (!c.get('auth').authenticated) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  try {
    // Run tests across ALL model assignments
    const result = await runSpeedTests();
    return c.json({ result });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Speed test failed';
    console.error('[speedtest] Run error:', message);
    return c.json({ error: message }, 500);
  }
});

// GET /api/speedtest/results — admin only, get all past results
speedtest.get('/results', async (c) => {
  if (!c.get('auth').authenticated) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  const results = await getResults();
  return c.json({ results });
});

// DELETE /api/speedtest/results/:id — admin only, delete a result
speedtest.delete('/results/:id', async (c) => {
  if (!c.get('auth').authenticated) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  const id = c.req.param('id');
  const deleted = await deleteResult(id);
  if (!deleted) {
    return c.json({ error: 'Result not found' }, 404);
  }
  return c.json({ success: true });
});

export default speedtest;
