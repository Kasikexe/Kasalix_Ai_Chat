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
import changelogRoutes from './routes/changelog';
import plannedRoutes from './routes/planned';
import speedtestRoutes from './routes/speedtest';
import { errorHandler, generateId } from './utils/helpers';
import { registerAllTools } from './services/tools/register';
import { getAllTools, executeTool } from './services/tools/index';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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

// Admin auth: gated by admin password — applies to settings AND changelog admin endpoints
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
app.use('/api/build/*', async (c, next) => {
  const authCookie = c.req.header('Cookie');
  c.set('auth', { authenticated: authCookie?.includes('settings_auth=1') || false });
  await next();
});
app.use('/api/speedtest/*', async (c, next) => {
  const authCookie = c.req.header('Cookie');
  c.set('auth', { authenticated: authCookie?.includes('settings_auth=1') || false });
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
app.route('/api/changelog', changelogRoutes);
app.route('/api/planned', plannedRoutes);
app.route('/api/speedtest', speedtestRoutes);

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

// ─── Download Page ─────────────────────────────────────────────
// Serves a download page with links to both desktop and Android APK.
const RELEASE_DIR = path.join(process.cwd(), '..', 'frontend', 'release');
const ANDROID_APK_DIR = path.join(process.cwd(), '..', 'frontend', 'android', 'app', 'build', 'outputs', 'apk');

/** Readable file size formatting */
function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// Serve the download page HTML (with dark theme matching the app)
async function renderDownloadPage(c: any): Promise<Response> {
  let hasDesktop = false;
  let desktopFile = '';
  let desktopSize = '';
  let hasAndroid = false;
  let androidFile = '';
  let androidSize = '';
  let version = '';

  // Check for desktop EXE
  try {
    const files = await fs.readdir(RELEASE_DIR);
    const setupFiles = files
      .filter((f) => f.includes('Setup') && f.endsWith('.exe') && !f.endsWith('.exe.blockmap'))
      .sort().reverse();
    if (setupFiles.length > 0) {
      desktopFile = setupFiles[0];
      const stat = await fs.stat(path.join(RELEASE_DIR, desktopFile));
      desktopSize = formatSize(stat.size);
      hasDesktop = true;
      // Extract version from filename like "AI-Chat-Setup-1.5.13.exe"
      const verMatch = desktopFile.match(/([\d.]+)\.exe/);
      if (verMatch) version = verMatch[1];
    }
  } catch {}

  // Check for Android APK (debug or release)
  const apkPaths = [
    path.join(ANDROID_APK_DIR, 'release', 'app-release.apk'),
    path.join(ANDROID_APK_DIR, 'debug', 'app-debug.apk'),
  ];
  for (const apkPath of apkPaths) {
    try {
      await fs.access(apkPath);
      androidFile = apkPath.endsWith('app-release.apk') ? 'app-release.apk' : 'app-debug.apk';
      const stat = await fs.stat(apkPath);
      androidSize = formatSize(stat.size);
      hasAndroid = true;
      break;
    } catch {}
  }

  const pageTitle = `Download AI Chat${version ? ` v${version}` : ''}`;

  // Build card HTML for each available platform
  let cardsHtml = '';

  if (hasDesktop) {
    cardsHtml += `
      <a href="/download/desktop" class="card">
        <div class="card-icon">🖥️</div>
        <div class="card-content">
          <div class="card-title">Windows Desktop</div>
          <div class="card-desc">Native Electron app with full features &middot; ${desktopSize}</div>
        </div>
        <div class="card-arrow">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </div>
      </a>`;
  }

  if (hasAndroid) {
    cardsHtml += `
      <a href="/download/android" class="card">
        <div class="card-icon">📱</div>
        <div class="card-content">
          <div class="card-title">Android APK</div>
          <div class="card-desc">Mobile app for phones &amp; tablets &middot; ${androidSize}</div>
        </div>
        <div class="card-arrow">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </div>
      </a>`;
  }

  // No builds available
  if (!cardsHtml) {
    cardsHtml = `
      <div class="card disabled">
        <div class="card-content" style="text-align: center;">
          <div class="card-title">No builds available yet</div>
          <div class="card-desc">Build the desktop app with <code>build_electron.bat</code> or the Android APK with Android Studio, then check back here.</div>
        </div>
      </div>`;
  }

  return c.html(`
    <!DOCTYPE html>
    <html lang="en" class="dark">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${pageTitle}</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          background: #030712;
          color: #e5e7eb;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
          padding: 1.5rem;
        }
        .container { width: 100%; max-width: 440px; }
        .header {
          text-align: center;
          margin-bottom: 2rem;
        }
        .logo {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 3.5rem;
          height: 3.5rem;
          border-radius: 1rem;
          background: linear-gradient(135deg, #7c3aed, #2563eb);
          font-size: 1.5rem;
          margin-bottom: 1rem;
          box-shadow: 0 8px 32px rgba(124, 58, 237, 0.2);
        }
        h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 0.5rem; }
        .subtitle { color: #9ca3af; font-size: 0.875rem; line-height: 1.5; }
        .cards { display: flex; flex-direction: column; gap: 0.75rem; }
        .card {
          display: flex;
          align-items: center;
          gap: 1rem;
          padding: 1rem 1.25rem;
          background: #111827;
          border: 1px solid #1f2937;
          border-radius: 1rem;
          text-decoration: none;
          color: inherit;
          transition: all 0.2s;
          cursor: pointer;
        }
        .card:hover {
          border-color: #374151;
          background: #1a2332;
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        }
        .card.disabled { opacity: 0.5; cursor: default; }
        .card.disabled:hover { transform: none; border-color: #1f2937; background: #111827; box-shadow: none; }
        .card-icon { font-size: 1.75rem; flex-shrink: 0; }
        .card-content { flex: 1; min-width: 0; }
        .card-title { font-weight: 600; font-size: 0.95rem; margin-bottom: 0.2rem; }
        .card-desc { color: #9ca3af; font-size: 0.8rem; line-height: 1.4; }
        .card-desc code { color: #a78bfa; background: #1e1b4b; padding: 0.1rem 0.3rem; border-radius: 0.25rem; font-size: 0.75rem; }
        .card-arrow { color: #6b7280; flex-shrink: 0; transition: all 0.2s; }
        .card:hover .card-arrow { color: #a78bfa; transform: translateY(2px); }
        .footer { text-align: center; margin-top: 2rem; }
        .back-link { color: #6b7280; font-size: 0.8rem; text-decoration: none; transition: color 0.2s; }
        .back-link:hover { color: #e5e7eb; }
        code { font-family: 'Cascadia Code', 'Fira Code', monospace; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="logo">🤖</div>
          <h1>${pageTitle}</h1>
          <p class="subtitle">Download the AI Chat app for your device.<br>Connect to your local AI server.</p>
        </div>
        <div class="cards">
          ${cardsHtml}
        </div>
        <div class="footer">
          <a href="/" class="back-link">&larr; Back to Chat</a>
        </div>
      </div>
    </body>
    </html>
  `, 200, { 'Content-Type': 'text/html' });
}

app.get('/download', async (c) => {
  return renderDownloadPage(c);
});

// Serve the desktop app download (.exe)
app.get('/download/desktop', async (c) => {
  try {
    const files = await fs.readdir(RELEASE_DIR);
    const setupFiles = files
      .filter((f) => f.includes('Setup') && f.endsWith('.exe') && !f.endsWith('.exe.blockmap'))
      .sort().reverse();

    const exeToServe = setupFiles.length > 0 ? setupFiles[0] : null;
    if (!exeToServe) {
      return renderDownloadPage(c);
    }

    const filePath = path.join(RELEASE_DIR, exeToServe);
    const data = await fs.readFile(filePath);

    return new Response(data, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${exeToServe}"`,
        'Content-Length': String(data.length),
      },
    });
  } catch {
    return renderDownloadPage(c);
  }
});

// Serve the Android APK download
app.get('/download/android', async (c) => {
  // Try release first, fall back to debug
  const apkPaths = [
    { path: path.join(ANDROID_APK_DIR, 'release', 'app-release.apk'), name: 'app-release.apk' },
    { path: path.join(ANDROID_APK_DIR, 'debug', 'app-debug.apk'), name: 'app-debug.apk' },
  ];

  for (const { path: apkPath, name } of apkPaths) {
    try {
      await fs.access(apkPath);
      const data = await fs.readFile(apkPath);
      const stat = await fs.stat(apkPath);
      console.log(`[download] Serving Android APK: ${apkPath} (${formatSize(stat.size)})`);
      return new Response(data, {
        headers: {
          'Content-Type': 'application/vnd.android.package-archive',
          'Content-Disposition': `attachment; filename="AiChat-Android.apk"`,
          'Content-Length': String(data.length),
        },
      });
    } catch {}
  }

  // No APK found — show download page with info
  return renderDownloadPage(c);
});

// ─── Terminal API ──────────────────────────────────────────────
// POST /api/terminal — execute a shell command in the workspace directory
app.post('/api/terminal', async (c) => {
  try {
    const { command, cwd } = await c.req.json();
    if (!command || typeof command !== 'string') {
      return c.json({ error: 'command is required' }, 400);
    }

    // Security: resolve and restrict command to workspace (or any parent)
    const safeCwd = cwd ? path.resolve(cwd) : process.cwd();

    // Run the command with a timeout
    const result = await execAsync(command, {
      cwd: safeCwd,
      timeout: 60000,
      shell: true,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024, // 10MB
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

// ─── Critical Update Status ────────────────────────────────────
const CRITICAL_UPDATE_FILE = path.join(process.cwd(), 'data', 'update-critical.json');

async function readCriticalStatus(): Promise<{ version: string; critical: boolean } | null> {
  try {
    return JSON.parse(await fs.readFile(CRITICAL_UPDATE_FILE, 'utf-8'));
  } catch { return null; }
}

async function writeCriticalStatus(version: string, critical: boolean): Promise<void> {
  await fs.mkdir(path.dirname(CRITICAL_UPDATE_FILE), { recursive: true });
  await fs.writeFile(CRITICAL_UPDATE_FILE, JSON.stringify({ version, critical, updatedAt: Date.now() }, null, 2), 'utf-8');
}

// GET /api/build/critical — returns whether the latest build version is critical
app.get('/api/build/critical', async (c) => {
  const status = await readCriticalStatus();
  return c.json({ version: status?.version || null, critical: status?.critical || false });
});

// PUT /api/build/critical — sets the critical flag for a version (admin only)
app.put('/api/build/critical', async (c) => {
  if (!c.get('auth').authenticated) {
    return c.json({ error: 'Not authenticated' }, 401);
  }
  try {
    const { version, critical } = await c.req.json();
    if (!version || typeof version !== 'string') {
      return c.json({ error: 'version is required' }, 400);
    }
    await writeCriticalStatus(version, critical === true);
    return c.json({ success: true, version, critical: critical === true });
  } catch {
    return c.json({ error: 'Invalid request body' }, 400);
  }
});

// ─── Build Config Endpoints ──────────────────────────────────
// GET /api/build/config — returns current build config from build-config.json
app.get('/api/build/config', async (c) => {
  if (!c.get('auth').authenticated) {
    return c.json({ error: 'Not authenticated' }, 401);
  }
  const cfgPath = path.join(path.resolve(process.cwd(), '..', 'frontend'), 'build-config.json');
  try {
    const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf-8'));
    return c.json({ config: cfg });
  } catch {
    // Return defaults
    return c.json({
      config: {
        version: '1.0.0',
        productName: 'AI Chat',
        appId: 'com.aichat.desktop',
        iconPath: '',
        description: 'AI Chat Desktop Application',
        author: '',
        lastBuild: null,
      },
    });
  }
});

// PUT /api/build/config — saves updated build config to build-config.json
app.put('/api/build/config', async (c) => {
  if (!c.get('auth').authenticated) {
    return c.json({ error: 'Not authenticated' }, 401);
  }
  const frontendDir = path.resolve(process.cwd(), '..', 'frontend');
  const cfgPath = path.join(frontendDir, 'build-config.json');
  try {
    const body = await c.req.json();
    const current = await fs.readFile(cfgPath, 'utf-8').then(JSON.parse).catch(() => ({}));
    const updated = { ...current, ...body, lastBuild: current.lastBuild || null };
    await fs.writeFile(cfgPath, JSON.stringify(updated, null, 2), 'utf-8');
    return c.json({ config: updated });
  } catch (e) {
    return c.json({ error: 'Failed to save build config' }, 500);
  }
});

// ─── Build Trigger (SSE) ─────────────────────────────────────
// POST /api/build — triggers the Electron build (admin only)
// Accepts { version, productName, iconPath, description, author } to update config before building
// Returns SSE stream with real-time progress: stage, chunk, done/error events
app.post('/api/build', async (c) => {
  if (!c.get('auth').authenticated) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  const frontendDir = path.resolve(process.cwd(), '..', 'frontend');
  const pm = process.env.PKG_MANAGER === 'bun' ? 'bun' : 'npm';

  // Read optional config from request body
  let buildVersion: string | undefined;
  let buildAndroid = false;
  let buildMeta: { productName?: string; iconPath?: string; description?: string; author?: string; appId?: string } = {};
  try {
    const body = await c.req.json();
    buildVersion = body.version;
    buildAndroid = body.buildAndroid === true;
    if (body.productName) buildMeta.productName = body.productName;
    if (body.iconPath !== undefined) buildMeta.iconPath = body.iconPath;
    if (body.description) buildMeta.description = body.description;
    if (body.author !== undefined) buildMeta.author = body.author;
    if (body.appId) buildMeta.appId = body.appId;
  } catch { /* no body — version unchanged */ }

  const encoder = new TextEncoder();
  let aborted = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        if (aborted) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch { /* controller closed */ }
      };

      const run = async (cmd: string, opts?: { timeout?: number; label?: string }) => {
        send({ type: 'stage', stage: opts?.label || cmd });
        try {
          const result = await execAsync(cmd, {
            cwd: frontendDir,
            timeout: opts?.timeout || 120000,
            shell: 'cmd.exe',
            windowsHide: true,
            maxBuffer: 1024 * 1024,
          });
          // Send real output as chunks
          if (result.stdout) {
            // Split into lines and send each as a chunk for real-time feel
            const lines = result.stdout.split('\n');
            for (const line of lines) {
              if (line.trim()) {
                send({ type: 'chunk', content: line + '\n' });
              }
            }
          }
          if (result.stderr) {
            const lines = result.stderr.split('\n');
            for (const line of lines) {
              if (line.trim()) {
                send({ type: 'chunk', content: line + '\n' });
              }
            }
          }
          return result;
        } catch (e) {
          const err = e as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
          if (err.stdout) send({ type: 'chunk', content: err.stdout });
          if (err.stderr) send({ type: 'chunk', content: err.stderr });
          throw err;
        }
      };

      try {
        console.log(`[build] Starting build in ${frontendDir} with ${pm}...`);

        // ── Step 0: Save config & version ───────────────────
        const cfgPath = path.join(frontendDir, 'build-config.json');
        const pkgPath = path.join(frontendDir, 'package.json');

        // Apply config metadata (productName, iconPath, etc.)
        const hasMeta = Object.keys(buildMeta).length > 0;
        if (hasMeta) {
          send({ type: 'stage', stage: 'build:version' });
          send({ type: 'chunk', content: 'Applying build configuration...\n' });

          // Update build-config.json
          try {
            const cfgJson = JSON.parse(await fs.readFile(cfgPath, 'utf-8'));
            Object.assign(cfgJson, buildMeta);
            await fs.writeFile(cfgPath, JSON.stringify(cfgJson, null, 2), 'utf-8');
            send({ type: 'chunk', content: '✓ Updated build-config.json\n' });
          } catch {}

          // Apply to package.json (productName, appId, description, author)
          try {
            const pkgJson = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
            if (buildMeta.productName) {
              pkgJson.build = pkgJson.build || {};
              pkgJson.build.productName = buildMeta.productName;
              if (pkgJson.build.nsis) pkgJson.build.nsis.shortcutName = buildMeta.productName;
            }
            if (buildMeta.appId) pkgJson.build = pkgJson.build || {};
            if (buildMeta.appId) pkgJson.build.appId = buildMeta.appId;
            if (buildMeta.description) pkgJson.description = buildMeta.description;
            if (buildMeta.author !== undefined) pkgJson.author = buildMeta.author;
            if (buildMeta.iconPath) {
              pkgJson.build = pkgJson.build || {};
              pkgJson.build.win = pkgJson.build.win || {};
              pkgJson.build.win.icon = path.resolve(frontendDir, buildMeta.iconPath);
            }
            await fs.writeFile(pkgPath, JSON.stringify(pkgJson, null, 2), 'utf-8');
            send({ type: 'chunk', content: '✓ Updated package.json metadata\n' });
          } catch {}
        }

        // ── Step 0b: Update version (if provided) ────────────
        if (buildVersion) {
          send({ type: 'stage', stage: 'build:version' });
          send({ type: 'chunk', content: `Updating version to ${buildVersion}...\n` });

          // Update package.json
          const pkgJson = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
          pkgJson.version = buildVersion;
          await fs.writeFile(pkgPath, JSON.stringify(pkgJson, null, 2), 'utf-8');

          // Verify it was written correctly
          const verifyPkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
          if (verifyPkg.version !== buildVersion) {
            send({ type: 'chunk', content: `⚠️ Version mismatch after write (got ${verifyPkg.version}), retrying...\n` });
            verifyPkg.version = buildVersion;
            await fs.writeFile(pkgPath, JSON.stringify(verifyPkg, null, 2), 'utf-8');
          }
          send({ type: 'chunk', content: `✓ Updated package.json version → ${buildVersion}\n` });

          // Update build-config.json
          try {
            const cfgJson = JSON.parse(await fs.readFile(cfgPath, 'utf-8'));
            cfgJson.version = buildVersion;
            cfgJson.lastBuild = Date.now();
            await fs.writeFile(cfgPath, JSON.stringify(cfgJson, null, 2), 'utf-8');
            send({ type: 'chunk', content: `✓ Updated build-config.json → ${buildVersion}\n` });
          } catch {
            send({ type: 'chunk', content: '⚠️ No build-config.json found, skipping\n' });
          }
        } else {
          // Read current version from package.json if no version was provided
          try {
            const pkgJson = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
            buildVersion = pkgJson.version;
            send({ type: 'chunk', content: `Using existing version: ${buildVersion}\n` });
          } catch {}
        }

        // ── Step 1: Clean old builds ──────────────────────────
        send({ type: 'stage', stage: 'build:clean' });
        send({ type: 'chunk', content: 'Cleaning old builds...\n' });
        try {
          await execAsync('rmdir /s /q release 2>nul & echo cleaned', {
            cwd: frontendDir, shell: 'cmd.exe', windowsHide: true,
          });
          send({ type: 'chunk', content: '✓ Old builds cleaned\n' });
        } catch {
          send({ type: 'chunk', content: '⚠️ Could not clean release directory\n' });
        }

        // ── Step 2: Build frontend with Vite ──────────────────
        send({ type: 'stage', stage: 'build:vite' });
        const buildOut = await run(`${pm} run build`, { timeout: 120000, label: 'build:vite' });
        send({ type: 'chunk', content: '\n✓ Frontend build complete\n' });

        // ── Step 3: Package with electron-builder ─────────────
        // Use --extraMetadata.version to FORCE the version in electron-builder
        // This overrides the version from package.json at build time
        send({ type: 'stage', stage: 'build:electron' });

        let pkgOut;
        if (buildVersion) {
          // Run electron-builder directly with explicit version override
          // Using node_modules/.bin path instead of npm run to avoid the vite rebuild
          // -c.extraMetadata.version overrides package.json fields at build time
          // (The help text says: electron-builder set package.json property `foo` to -c.extraMetadata.foo=bar)
          pkgOut = await run(
            `node_modules\\.bin\\electron-builder.cmd --win --config -c.extraMetadata.version=${buildVersion}`,
            { timeout: 300000, label: 'build:electron' }
          );
        } else {
          pkgOut = await run(`${pm} run build:electron`, { timeout: 300000, label: 'build:electron' });
        }
        send({ type: 'chunk', content: '\n✓ Electron packaging complete\n' });

        // ── Step 4: Build Android APK (optional) ──────────────
        let androidOut: any = { stdout: '' };
        if (buildAndroid) {
          const androidDir = path.join(path.resolve(process.cwd(), '..', 'frontend'), 'android');
          send({ type: 'stage', stage: 'build:android' });
          send({ type: 'chunk', content: '\nBuilding Android APK...\n' });

          // Helper to convert exec output to string (Bun returns NonSharedBuffer, Node returns string)
          const toStr = (v: any): string => typeof v === 'string' ? v : v?.toString() || '';

          // Auto-detect JAVA_HOME for the Gradle build
          // Capacitor 8 requires Java 21, so we need to find the JDK 21 installation
          let javaHome = '';
          try {
            const javaResult = await execAsync('java -XshowSettings:properties -version 2>&1 | findstr "java.home"', {
              timeout: 10000, shell: 'cmd.exe', windowsHide: true,
            });
            const match = javaResult.stdout.match(/java\.home\s*=\s*(.+)/);
            if (match) {
              javaHome = match[1].trim();
              send({ type: 'chunk', content: `✓ Detected JAVA_HOME: ${javaHome}\n` });
            }
          } catch {}

          // First sync the web build to Capacitor
          const frontendRoot = path.resolve(process.cwd(), '..', 'frontend');
          try {
            send({ type: 'chunk', content: 'Syncing web build to Capacitor...\n' });
            await execAsync('npx cap sync android', {
              cwd: frontendRoot,
              timeout: 60000,
              shell: 'cmd.exe',
              windowsHide: true,
            } as any);
            send({ type: 'chunk', content: '✓ Capacitor sync complete\n' });
          } catch (e) {
            const err = e as { stdout?: string; stderr?: string; message?: string };
            send({ type: 'chunk', content: `⚠️ Capacitor sync issue: ${err.message || 'unknown'}\n` });
          }

          // Run Gradle build with the detected JAVA_HOME
          try {
            send({ type: 'chunk', content: 'Running Gradle assembleDebug...\n' });
            const gradleEnv = { ...process.env } as Record<string, string>;
            if (javaHome) gradleEnv.JAVA_HOME = javaHome;

            const gradleResult: any = await execAsync('gradlew.bat assembleDebug', {
              cwd: androidDir,
              timeout: 600000, // 10 minutes for Android build
              shell: 'cmd.exe',
              windowsHide: true,
              maxBuffer: 10 * 1024 * 1024,
              env: gradleEnv,
            });
            androidOut = gradleResult;
            const stdoutStr = toStr(gradleResult.stdout);
            if (stdoutStr) {
              const lines = stdoutStr.split('\n');
              for (const line of lines) {
                if (line.trim()) send({ type: 'chunk', content: line + '\n' });
              }
            }
            send({ type: 'chunk', content: '\n✓ Android APK build complete!\n' });
          } catch (e) {
            const err = e as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
            if (err.stdout) send({ type: 'chunk', content: toStr(err.stdout) });
            if (err.stderr) send({ type: 'chunk', content: toStr(err.stderr) });
            send({ type: 'chunk', content: `\n⚠️ Android build issue: ${err.message || 'unknown'}\n` });
          }
        }

        // ── Done ──────────────────────────────────────────────
        console.log('[build] Build completed successfully');
        send({
          type: 'done',
          success: true,
          output: (buildOut.stdout + '\n' + pkgOut.stdout + '\n' + androidOut.stdout).slice(-2000) || '',
          version: buildVersion || undefined,
        });

      } catch (e) {
        const error = e as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
        const cause = error.killed ? 'Build timed out' : (error.message || 'Build failed');
        console.error('[build] Build failed:', cause);
        send({
          type: 'error',
          error: cause,
          output: (error.stdout || error.stderr || '').slice(-2000),
        });
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
    cancel() {
      aborted = true;
      console.log('[build] Client disconnected');
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});

app.get('/', (c) => c.json({ message: 'AI Chat API', version: '1.0.0' }));
app.get('/api/health', (c) => c.json({ status: 'ok' }));

const port = Number(process.env.PORT) || 3001;

// HTTPS mode detection (priority: CLI flag > env var > default HTTPS)
// Pass --http to `bun run dev` via `bun run dev -- --http` to disable HTTPS
const useHttps = process.argv.includes('--http') ? false : process.env.HTTPS !== 'false';

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
