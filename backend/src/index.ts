import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serve } from '@hono/node-server';
import { createServer } from 'node:https';
import { readFileSync } from 'fs';
import path from 'path';
import { promises as fs } from 'fs';
import modelsRoutes from './routes/models';
import chatRoutes from './routes/chat';
import conversationsRoutes from './routes/conversations';
import settingsRoutes from './routes/settings';
import filesRoutes from './routes/files';
import editorRoutes from './routes/editor';
import memoryRoutes from './routes/memory';
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
app.route('/api/files', filesRoutes);
app.route('/api/editor', editorRoutes);
app.route('/api/memory', memoryRoutes);

// Serve generated images
const GENERATED_DIR = path.join(process.cwd(), 'generated_images');

async function streamGeneratedImage(filename: string, c: any, forceDownload?: boolean) {
  // Prevent path traversal
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return c.json({ error: 'Invalid filename' }, 400);
  }
  const filePath = path.join(GENERATED_DIR, filename);
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filename).toLowerCase();
    const contentType =
      ext === '.png' ? 'image/png' :
      ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
      ext === '.webp' ? 'image/webp' :
      'application/octet-stream';
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Cache-Control': forceDownload ? 'no-cache' : 'public, max-age=3600',
    };
    if (forceDownload) {
      headers['Content-Disposition'] = `attachment; filename="${filename}"`;
    }
    return new Response(data, { headers });
  } catch {
    return c.json({ error: 'Image not found' }, 404);
  }
}

// Serve image for embedding (inline)
app.get('/api/generated/:filename', async (c) => {
  return streamGeneratedImage(c.req.param('filename'), c, false);
});

// Download image (forces browser download dialog)
app.get('/api/generated/:filename/download', async (c) => {
  return streamGeneratedImage(c.req.param('filename'), c, true);
});

// Save a generated image to a workspace folder
app.post('/api/generated/:filename/save-to-workspace', async (c) => {
  const filename = c.req.param('filename');
  let targetDir: string;
  try {
    const body = await c.req.json();
    targetDir = body.workspacePath;
  } catch {
    return c.json({ error: 'workspacePath is required in request body' }, 400);
  }

  if (!targetDir) {
    return c.json({ error: 'workspacePath is required' }, 400);
  }

  // Prevent path traversal in filename
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return c.json({ error: 'Invalid filename' }, 400);
  }

  const sourcePath = path.join(GENERATED_DIR, filename);
  const resolvedDir = path.resolve(targetDir);
  const destPath = path.join(resolvedDir, filename);

  try {
    await fs.access(sourcePath);
    await fs.mkdir(resolvedDir, { recursive: true });
    await fs.copyFile(sourcePath, destPath);
    console.log(`[image] Saved to workspace: ${destPath}`);
    return c.json({
      success: true,
      path: destPath,
      filename,
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return c.json({ error: 'Image not found' }, 404);
    }
    return c.json({ error: 'Failed to save image to workspace' }, 500);
  }
});

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
