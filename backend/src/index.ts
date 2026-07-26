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
import { registerAllTools } from './services/tools/register';
import { getAllTools, executeTool } from './services/tools/index';

// Register built-in tools
registerAllTools();

const app = new Hono();

app.use('*', logger());
app.use('*', cors({
  origin: (origin) => {
    // Allow any origin — this is a local-only AI chat app, not a public service.
    // Restricting CORS breaks the Electron proxy which connects from 127.0.0.1.
    return origin || '*';
  },
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

// Serve the desktop app download (.exe) — prefers portable version for first-time users
const RELEASE_DIR = path.join(process.cwd(), '..', 'frontend', 'release');

app.get('/download', async (c) => {
  try {
    const files = await fs.readdir(RELEASE_DIR);
    // Prefer portable .exe (no install required), fallback to any .exe
    const portableFiles = files.filter((f) => f.includes('Portable') && f.endsWith('.exe') && !f.endsWith('.exe.blockmap'));
    const allExe = files.filter((f) => f.endsWith('.exe') && !f.endsWith('.exe.blockmap'));
    const exeFiles = portableFiles.length > 0 ? portableFiles : allExe;
    if (exeFiles.length === 0) {
      return c.redirect('https://github.com/your-repo/releases/latest');
    }

    exeFiles.sort().reverse();
    const latest = exeFiles[0];
    const filePath = path.join(RELEASE_DIR, latest);
    const data = await fs.readFile(filePath);

    return new Response(data, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${latest}"`,
        'Content-Length': String(data.length),
      },
    });
  } catch {
    return c.html(`
      <!DOCTYPE html>
      <html lang="en" class="dark">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Download AI Chat</title>
        <style>
          body { background: #030712; color: #e5e7eb; font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
          .card { text-align: center; padding: 2rem; max-width: 480px; }
          h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 0.5rem; }
          p { color: #9ca3af; font-size: 0.875rem; line-height: 1.5; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Download AI Chat Desktop App</h1>
          <p>The desktop app is not yet built. Run <code>build_electron.bat</code> in the frontend directory to create the .exe, then it will be available here.</p>
          <a href="/" class="btn">Back to Chat</a>
        </div>
      </body>
      </html>
    `, 200, { 'Content-Type': 'text/html' });
  }
});

// ─── Auto-Update Server ────────────────────────────────────────
// Serves latest.yml and installer files for the Electron auto-updater
const UPDATE_DIR = path.join(process.cwd(), '..', 'frontend', 'release');

app.get('/latest.yml', async (c) => {
  try {
    const data = await fs.readFile(path.join(UPDATE_DIR, 'latest.yml'), 'utf-8');
    return c.body(data, 200, {
      'Content-Type': 'application/x-yaml',
      'Cache-Control': 'no-cache',
    });
  } catch {
    return c.json({ error: 'No update available yet' }, 404);
  }
});

app.get('/latest.yml.blockmap', async (c) => {
  try {
    const data = await fs.readFile(path.join(UPDATE_DIR, 'latest.yml.blockmap'));
    return c.body(data, 200, {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
  } catch {
    return c.json({ error: 'Not found' }, 404);
  }
});

app.get('/:filename{[A-Za-z0-9._-]+\.exe}', async (c) => {
  const filename = c.req.param('filename');
  try {
    const data = await fs.readFile(path.join(UPDATE_DIR, filename));
    return new Response(data, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch {
    return c.json({ error: 'Installer not found' }, 404);
  }
});

// ─── Tools API ────────────────────────────────────────────
app.get('/api/tools', (c) => {
  const tools = getAllTools();
  return c.json({ tools });
});

app.post('/api/tools/execute', async (c) => {
  const { toolId, params, userInput } = await c.req.json();
  if (!toolId) return c.json({ error: 'toolId is required' }, 400);
  const result = await executeTool(toolId, params || {}, { userInput: userInput || '' });
  return c.json(result);
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
    createServer,
    serverOptions: {
      cert: readFileSync(certPath).toString(),
      key: readFileSync(keyPath).toString(),
    },
  }, (info) => {
    // Node.js defaults to 0.0.0.0 (all interfaces) when no host is given
    console.log(`🔒 Backend running on https://localhost:${info.port}`);
  });
} else {
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`🚀 Backend running on http://localhost:${info.port}`);
  });
}
