import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
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
import changelogRoutes from './routes/changelog';
import plannedRoutes from './routes/planned';
import speedtestRoutes from './routes/speedtest';
import { errorHandler, generateId, getGeneratedImagesDir } from './utils/helpers';
import { registerAllTools } from './services/tools/register';
import { getAllTools, executeTool } from './services/tools/index';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logger as appLogger } from './services/logger';
import {
  registerUser,
  loginUser,
  validateSession,
  destroySession,
  getCurrentUser,
  getAllUsers,
  shutdown as shutdownAuth,
} from './services/auth';

const execAsync = promisify(exec);

// Register built-in tools
registerAllTools();

const app = new Hono();

app.use('*', honoLogger());
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

// User middleware: trust X-User-Id header from frontend (fallback)
// Also checks for a Bearer token in the Authorization header (session auth)
app.use('*', async (c, next) => {
  // Check for session token first
  const authHeader = c.req.header('Authorization');
  let userId: string | undefined;

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const result = validateSession(token);
    if (result.valid && result.userId) {
      userId = result.userId;
    }
  }

  // Fall back to X-User-Id header (existing behavior)
  if (!userId) {
    const headerId = c.req.header('X-User-Id');
    userId = headerId || generateId();
  }

  c.set('user', { id: userId });
  c.set('session', {
    authenticated: !!authHeader?.startsWith('Bearer ') && !!userId,
    userId,
  });
  await next();
});

// ─── Admin auth (unchanged from existing system) ───────────────
// Uses cookie-based auth for admin-only features (settings, changelog, speedtest)
app.use('/api/settings/*', async (c, next) => {
  const authCookie = c.req.header('Cookie');
  const isAuthed = authCookie?.includes('settings_auth=1') || false;
  c.set('auth', { authenticated: isAuthed });
  await next();
});
app.use('/api/planned/*', async (c, next) => {
  const authCookie = c.req.header('Cookie');
  c.set('auth', { authenticated: authCookie?.includes('settings_auth=1') || false });
  await next();
});
app.use('/api/changelog/*', async (c, next) => {
  const authCookie = c.req.header('Cookie');
  c.set('auth', { authenticated: authCookie?.includes('settings_auth=1') || false });
  await next();
});
app.use('/api/speedtest/*', async (c, next) => {
  const authCookie = c.req.header('Cookie');
  c.set('auth', { authenticated: authCookie?.includes('settings_auth=1') || false });
  await next();
});

// ─── User session auth (protects user-facing features) ────────
// These routes require a valid Bearer token in the Authorization header
const SESSION_PROTECTED = [
  '/api/chat/*',
  '/api/conversations/*',
  '/api/files/*',
  '/api/editor/*',
  '/api/memory/*',
];

app.use('*', async (c, next) => {
  const path = c.req.path;
  const isProtected = SESSION_PROTECTED.some((p) => {
    // Convert glob-like pattern to regex
    const pattern = new RegExp('^' + p.replace(/\*/g, '.*') + '$');
    return pattern.test(path);
  });

  if (isProtected) {
    const session = c.get('session');
    if (!session.authenticated) {
      return c.json({ error: 'Authentication required' }, 401);
    }
  }

  await next();
});

// Auth routes (public — for registration, login, logout, and session check)
app.post('/api/auth/register', async (c) => {
  try {
    const { username, password, rememberMe } = await c.req.json();
    if (!username || !password) {
      return c.json({ error: 'Username and password are required' }, 400);
    }
    const result = await registerUser(username, password);
    if (!result.success) {
      return c.json({ error: result.error }, 400);
    }
    // Auto-login after registration
    const loginResult = await loginUser(username, password, c.req.header('x-forwarded-for') || 'local', rememberMe === true);
    if (!loginResult.success) {
      return c.json({ error: loginResult.error }, 500);
    }
    const profile = await getCurrentUser(loginResult.userId);
    appLogger.info(`[auth] New user registered: ${username}`);
    return c.json({
      token: loginResult.token,
      user: profile,
    }, 201);
  } catch (e) {
    appLogger.error('[auth] Registration error:', e);
    return c.json({ error: 'Registration failed' }, 500);
  }
});

app.post('/api/auth/login', async (c) => {
  try {
    const { username, password, rememberMe } = await c.req.json();
    if (!username || !password) {
      return c.json({ error: 'Username and password are required' }, 400);
    }
    const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'local';
    const result = await loginUser(username, password, ip, rememberMe === true);
    if (!result.success) {
      return c.json({ error: result.error }, 401);
    }
    const profile = await getCurrentUser(result.userId);
    return c.json({
      token: result.token,
      user: profile,
    });
  } catch (e) {
    appLogger.error('[auth] Login error:', e);
    return c.json({ error: 'Login failed' }, 500);
  }
});

app.post('/api/auth/logout', async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      destroySession(token);
    }
    return c.json({ success: true });
  } catch (e) {
    appLogger.error('[auth] Logout error:', e);
    return c.json({ error: 'Logout failed' }, 500);
  }
});

app.get('/api/auth/me', async (c) => {
  try {
    const session = c.get('session');
    if (!session.authenticated || !session.userId) {
      return c.json({ authenticated: false });
    }
    const profile = await getCurrentUser(session.userId);
    if (!profile) {
      return c.json({ authenticated: false });
    }
    return c.json({ authenticated: true, user: profile });
  } catch (e) {
    appLogger.error('[auth] Session check error:', e);
    return c.json({ authenticated: false });
  }
});

// GET /api/auth/users — list all registered users (protected by settings auth)
app.get('/api/auth/users', async (c) => {
  const authCookie = c.req.header('Cookie');
  if (!authCookie?.includes('settings_auth=1')) {
    return c.json({ error: 'Not authenticated' }, 401);
  }
  try {
    const users = await getAllUsers();
    return c.json({ users });
  } catch (e) {
    appLogger.error('[auth] List users error:', e);
    return c.json({ error: 'Failed to list users' }, 500);
  }
});

// ─── API Tools are publicly accessible for model use ──────────
// (Tools like calculator, converter, etc. are called by the AI, not the user directly)

app.onError(errorHandler);

app.route('/api/models', modelsRoutes);
app.route('/api/chat', chatRoutes);
app.route('/api/conversations', conversationsRoutes);
app.route('/api/settings', settingsRoutes);
app.route('/api/files', filesRoutes);
app.route('/api/editor', editorRoutes);
app.route('/api/memory', memoryRoutes);
app.route('/api/changelog', changelogRoutes);
app.route('/api/planned', plannedRoutes);
app.route('/api/speedtest', speedtestRoutes);

// Serve generated images
const GENERATED_DIR = getGeneratedImagesDir();

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
    await fs.copyFile(sourcePath, destPath);      appLogger.info(`[image] Saved to workspace: ${destPath}`);
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

// ─── Terminal API ──────────────────────────────────────────────
// POST /api/terminal — execute a shell command in the workspace directory
app.post('/api/terminal', async (c) => {
  // Require session authentication
  const session = c.get('session');
  if (!session.authenticated) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  try {
    const { command, cwd } = await c.req.json();
    if (!command || typeof command !== 'string') {
      return c.json({ error: 'command is required' }, 400);
    }

    // Input validation: block truly dangerous command patterns only
    const dangerous = /\b(rm\s+-[rf]\s+\/|format\s+[c-z]:\s*\/q|dd\s+if=|mkfs\.|fdisk|shutdown\s+-[rh]\s+-t\s+0|del\s+\/f\s+\/s)/i;
    if (dangerous.test(command)) {
      appLogger.warn(`[terminal] Blocked dangerous command from user ${session.userId}`);
      return c.json({ error: 'Command blocked for security' }, 403);
    }

    const safeCwd = cwd ? path.resolve(cwd) : process.cwd();

    const result = await execAsync(command, {
      cwd: safeCwd,
      timeout: 60000,
      shell: true,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });

    return c.json({
      success: true,
      stdout: result.stdout,
      stderr: result.stderr,
      code: 0,
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number; killed?: boolean; message?: string };
    return c.json({
      success: false,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      code: err.code ?? 1,
      killed: err.killed ?? false,
      timeout: err.killed ?? false,
    });
  }
});

// ─── Tools API ────────────────────────────────────────────
app.get('/api/tools', (c) => {
  const tools = getAllTools();
  return c.json({ tools });
});

app.post('/api/tools/execute', async (c) => {
  // Require session authentication
  const session = c.get('session');
  if (!session.authenticated) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const { toolId, params, userInput } = await c.req.json();
  if (!toolId) return c.json({ error: 'toolId is required' }, 400);
  const result = await executeTool(toolId, params || {}, { userInput: userInput || '' });
  return c.json(result);
});




// ─── Release Directory ──────────────────────────────
// Where downloaded APK/EXE files are stored. The auto-updater and web
// download page serve files from here.
const RELEASE_DIR = path.join(process.cwd(), '..', 'release');
const GITHUB_RELEASES_URL = process.env.GITHUB_RELEASES_URL || 'https://github.com/Kasikexe/Kasalix/releases';

// ─── Download Page ────────────────────────────────
app.get('/download', async (c) => {
  // Check what's available locally
  let hasDesktop = false, hasAndroid = false, desktopName = '', androidName = '';
  try {
    const files = await fs.readdir(RELEASE_DIR);
    for (const f of files) {
      if (f.endsWith('.exe') && !f.endsWith('.exe.blockmap')) {
        hasDesktop = true;
        desktopName = f;
      }
      if (f.toLowerCase().endsWith('.apk')) {
        hasAndroid = true;
        androidName = f;
      }
    }
  } catch {}

  const version = process.env.APP_VERSION || '1.6.0';
  const html = `
<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#0a0a0a" />
  <title>Download Kasalix AI Chat</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #030712;
      color: #e5e7eb;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
    }
    .container { max-width: 600px; padding: 2rem; text-align: center; }
    h1 { font-size: 1.5rem; font-weight: 700; color: #f9fafb; margin-bottom: 0.5rem; }
    .subtitle { color: #9ca3af; font-size: 0.95rem; margin-bottom: 2rem; line-height: 1.5; }
    .card {
      background: linear-gradient(135deg, #111827, #1f2937);
      border: 1px solid #374151;
      border-radius: 12px;
      padding: 1.5rem;
      margin-bottom: 1rem;
      display: flex;
      align-items: center;
      gap: 1rem;
      text-decoration: none;
      transition: all 0.2s ease;
    }
    .card:hover { border-color: #6366f1; background: linear-gradient(135deg, #1e1b4b, #1f2937); transform: translateY(-1px); }
    .card-icon { width: 48px; height: 48px; background: #1e293b; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 1.5rem; flex-shrink: 0; }
    .card-content { flex: 1; text-align: left; }
    .card-title { color: #f9fafb; font-weight: 600; font-size: 1rem; margin-bottom: 0.25rem; }
    .card-desc { color: #9ca3af; font-size: 0.8rem; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 9999px; font-size: 0.7rem; font-weight: 500; margin-top: 4px; }
    .badge-green { background: #064e3b; color: #6ee7b7; }
    .badge-blue { background: #1e3a5f; color: #93c5fd; }
    .badge-gray { background: #374151; color: #9ca3af; }
    .github-link { margin-top: 2rem; display: inline-block; color: #6366f1; font-size: 0.85rem; text-decoration: none; }
    .github-link:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Kasalix AI Chat</h1>
    <p class="subtitle">Download the app for your device.<br>Connect to your local AI server.</p>

    <a href="${hasDesktop ? '/download/desktop' : GITHUB_RELEASES_URL}" class="card" target="${hasDesktop ? '_self' : '_blank'}" rel="noopener noreferrer">
      <div class="card-icon">🪟</div>
      <div class="card-content">
        <div class="card-title">Windows Desktop</div>
        <div class="card-desc">${hasDesktop ? 'Download from this server' : 'Get from GitHub releases'}</div>
        <span class="badge ${hasDesktop ? 'badge-blue' : 'badge-gray'}">${hasDesktop ? desktopName : 'Not on this server'}</span>
      </div>
    </a>

    <a href="${hasAndroid ? '/download/android' : GITHUB_RELEASES_URL}" class="card" target="${hasAndroid ? '_self' : '_blank'}" rel="noopener noreferrer">
      <div class="card-icon">📱</div>
      <div class="card-content">
        <div class="card-title">Android App</div>
        <div class="card-desc">${hasAndroid ? 'Download from this server' : 'Get from GitHub releases'}</div>
        <span class="badge ${hasAndroid ? 'badge-green' : 'badge-gray'}">${hasAndroid ? androidName : 'Not on this server'}</span>
      </div>
    </a>

    <a href="${GITHUB_RELEASES_URL}" class="github-link" target="_blank" rel="noopener noreferrer">View all releases on GitHub →</a>
  </div>
</body>
</html>`;
  return c.html(html);
});

// ─── Desktop download ──────────────────────────────
app.get('/download/desktop', async (c) => {
  try {
    const files = await fs.readdir(RELEASE_DIR);
    const exe = files.find(f => f.endsWith('.exe') && !f.endsWith('.exe.blockmap'));
    if (!exe) return c.redirect(GITHUB_RELEASES_URL);
    const data = await fs.readFile(path.join(RELEASE_DIR, exe));
    return new Response(data, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${exe}"`,
      },
    });
  } catch {
    return c.redirect(GITHUB_RELEASES_URL);
  }
});

// ─── Android download ──────────────────────────────
app.get('/download/android', async (c) => {
  try {
    const files = await fs.readdir(RELEASE_DIR);
    const apk = files.find(f => f.toLowerCase().endsWith('.apk'));
    if (!apk) return c.redirect(GITHUB_RELEASES_URL);
    const data = await fs.readFile(path.join(RELEASE_DIR, apk));
    return new Response(data, {
      headers: {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Disposition': `attachment; filename="${apk}"`,
      },
    });
  } catch {
    return c.redirect(GITHUB_RELEASES_URL);
  }
});

// ─── Auto-update files (latest.yml, blockmap) ──────
app.get('/latest.yml', async (c) => {
  try {
    const data = await fs.readFile(path.join(RELEASE_DIR, 'latest.yml'));
    return new Response(data, {
      headers: { 'Content-Type': 'text/yaml', 'Cache-Control': 'no-cache' },
    });
  } catch { return c.json({ error: 'Not found' }, 404); }
});

app.get('/:filename.blockmap', async (c) => {
  const filename = c.req.param('filename');
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return c.json({ error: 'Invalid path' }, 400);
  }
  try {
    const data = await fs.readFile(path.join(RELEASE_DIR, `${filename}.blockmap`));
    return new Response(data, {
      headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-cache' },
    });
  } catch { return c.json({ error: 'Not found' }, 404); }
});

// ─── Serve any file from the release dir (for auto-updater) ─────
app.get('/:filename.exe', async (c) => {
  const filename = c.req.param('filename');
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return c.json({ error: 'Invalid path' }, 400);
  }
  try {
    const data = await fs.readFile(path.join(RELEASE_DIR, `${filename}.exe`));
    return new Response(data, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-cache',
      },
    });
  } catch { return c.json({ error: 'Not found' }, 404); }
});

app.get('/api/health', (c) => c.json({ status: 'ok' }));

// ─── Frontend Static File Server ──────────────────────────
// When the server is run standalone (not behind Vite dev server),
// serve the built frontend files so hosts can open http://localhost:3001
const STATIC_DIR = path.join(process.cwd(), '..', 'frontend', 'dist');
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

app.get('*', async (c) => {
  // Only handle non-API routes (API routes are matched first by Hono)
  const url = c.req.path;
  if (url.startsWith('/api/')) return c.json({ error: 'Not found' }, 404);
  // /download is handled by a dedicated route above — skip SPA fallback for it
  if (url === '/download') {
    return c.json({ error: 'Not found' }, 404);
  }

  const filePath = url === '/' || url === '' ? '/index.html' : url;
  if (filePath.includes('..')) {
    return c.json({ error: 'Invalid path' }, 400);
  }

  const fullPath = path.join(STATIC_DIR, filePath);
  try {
    await fs.access(fullPath);
    const stat = await fs.stat(fullPath);
    if (stat.isFile()) {
      const ext = path.extname(fullPath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const data = await fs.readFile(fullPath);
      return new Response(data, {
        headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' },
      });
    }
  } catch {}

  // SPA fallback: serve index.html for any non-file path
  try {
    const indexData = await fs.readFile(path.join(STATIC_DIR, 'index.html'));
    return new Response(indexData, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  } catch {
    return c.json({ error: 'Frontend not built. Run `cd frontend && npm run build` first.' }, 404);
  }
});

const port = Number(process.env.PORT) || 3001;

// HTTPS mode detection (priority: CLI flag > env var > default HTTPS)
// Pass --http to `bun run dev` via `bun run dev -- --http` to disable HTTPS
const useHttps = process.argv.includes('--http') ? false : process.env.HTTPS !== 'false';

appLogger.info('[server] Starting...');
appLogger.info(`[server] HTTPS: ${useHttps ? 'enabled' : 'disabled'}`);
appLogger.info(`[server] Port: ${port}`);
appLogger.info(`[server] Session TTL: ${Number(process.env.SESSION_TTL_MS) || 86400000}ms`);

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
    appLogger.info(`[server] Backend running on https://0.0.0.0:${info.port}`);
  });
} else {
  serve({ fetch: app.fetch, port }, (info) => {
    appLogger.info(`[server] Backend running on http://0.0.0.0:${info.port}`);
  });
}

// Graceful shutdown
process.on('SIGINT', () => {
  appLogger.info('[server] Shutting down...');
  shutdownAuth();
  process.exit(0);
});

process.on('SIGTERM', () => {
  appLogger.info('[server] Shutting down...');
  shutdownAuth();
  process.exit(0);
});
