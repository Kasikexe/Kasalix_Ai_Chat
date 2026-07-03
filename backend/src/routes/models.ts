import { Hono } from 'hono';
import { getModels } from '../services/ollama';

const models = new Hono();

models.get('/', async (c) => {
  try {
    const list = await getModels();
    return c.json({ models: list });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'Failed to fetch models' }, 502);
  }
});

export default models;
