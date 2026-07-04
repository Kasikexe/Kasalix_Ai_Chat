import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serve } from '@hono/node-server';
import { createServer } from 'node:https';
import { readFileSync } from 'fs';
import modelsRoutes from './routes/models';
import chatRoutes from './routes/chat';
import conversationsRoutes from './routes/conversations';
import settingsRoutes from './routes/settings';
import { errorHandler, generateId } from './utils/helpers';

const app = new Hono();

app.use('*', logger());
app.use('*', cors({
  origin: ['https://localhost:5173', 'http://localhost:3000'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-User-Id'],
  exposeHeaders: ['X-User-Id'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
}));

// User middleware: trust X-User-Id header from frontend
app.use('*', async (c, next) => {
  const headerId = c.req.header('X-User-Id');
  const userId = headerId || generateId();
  c.set('user', { id: userId });
  await next();
});

// Settings auth: gated by admin password
app.use('/api/settings/*', async (c, next) => {
  const authCookie = c.req.header('Cookie');
  const isAuthed = authCookie?.includes('settings_auth=1') || false;
  c.set('auth', { authenticated: isAuthed });
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
const useHttps = process.env.HTTPS !== 'false';

if (useHttps) {
  const certPath = process.env.SSL_CERT || '../certs/localhost.crt';
  const keyPath = process.env.SSL_KEY || '../certs/localhost.key';

  serve({
    fetch: app.fetch,
    port,
    createServer, // use https.createServer instead of http.createServer
    serverOptions: {
      cert: readFileSync(certPath).toString(),
      key: readFileSync(keyPath).toString(),
    },
  }, (info) => {
    console.log(`🔒 Backend running on https://localhost:${info.port}`);
  });
} else {
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`🚀 Backend running on http://localhost:${info.port}`);
  });
}
