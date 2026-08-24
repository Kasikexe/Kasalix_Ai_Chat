import { Hono } from 'hono';
import { getModels, modelSupportsThinking } from '../services/ollama';

const models = new Hono();

models.get('/', async (c) => {
  try {
    const list = await getModels();
    const enriched = await Promise.all(
      list.map(async (m) => ({
        ...m,
        supportsThinking: await modelSupportsThinking(m.name),
      }))
    );
    return c.json({ models: enriched });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'Failed to fetch models' }, 502);
  }
});

export default models;
