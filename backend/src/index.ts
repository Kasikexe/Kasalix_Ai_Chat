import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getCookie, setCookie } from 'hono/cookie';
import { serve } from '@hono/node-server';
import modelsRoutes from './routes/models';
import chatRoutes from './routes/chat';
import conversationsRoutes from './routes/conversations';
import settingsRoutes from './routes/settings';
import { errorHandler, generateId } from './utils/helpers';
import type { Variables } from './types';

const app = new Hono<{ Variables: Variables }>();

app.use('*', cors({
  origin: ['http://localhost:5173', 'http://localhost:3000'],
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
}));

app.use('*', async (c, next) => {
  let userId = getCookie(c, 'user_id');
  if (!userId) {
    userId = generateId();
    setCookie(c, 'user_id', userId, {
      httpOnly: false,
      path: '/',
      sameSite: 'Lax',
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  c.set('user', { id: userId });
  await next();
});

app.use('/api/settings/*', async (c, next) => {
  const authCookie = getCookie(c, 'settings_auth');
  c.set('auth', { authenticated: authCookie === '1' });
  await next();
});

app.onError(errorHandler);

app.route('/api/models', modelsRoutes);
app.route('/api/chat', chatRoutes);
app.route('/api/conversations', conversationsRoutes);
app.route('/api/settings', settingsRoutes);

app.get('/', (c) => c.json({ message: 'AI Chat API', version: '1.0.0' }));
app.get('/api/health', (c) => c.json({ status: 'ok' }));

const port = Number(process.env.PORT) || 3001;

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`🚀 Backend running on http://localhost:${info.port}`);
});
