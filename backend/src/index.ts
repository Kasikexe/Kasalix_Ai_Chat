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

// Serve the desktop app download (.exe)
const RELEASE_DIR = path.join(process.cwd(), '..', 'frontend', 'release');

app.get('/download', async (c) => {
  try {
    const files = await fs.readdir(RELEASE_DIR);
    // Find the latest Setup installer
    const setupFiles = files
      .filter((f) => f.includes('Setup') && f.endsWith('.exe') && !f.endsWith('.exe.blockmap'))
      .sort().reverse();
    
    const exeToServe = setupFiles.length > 0 ? setupFiles[0] : null;
    if (!exeToServe) {
      return c.redirect('https://github.com/your-repo/releases/latest');
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
    // Release directory doesn't exist yet — show a friendly message
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
          .btn { display: inline-flex; align-items: center; gap: 0.5rem; margin-top: 1.5rem; padding: 0.75rem 1.5rem; background: linear-gradient(135deg, #7c3aed, #6d28d9); color: white; border-radius: 0.75rem; text-decoration: none; font-size: 0.875rem; font-weight: 500; transition: all 0.2s; }
          .btn:hover { transform: scale(1.05); }
          .sub { margin-top: 1rem; font-size: 0.75rem; color: #6b7280; }
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
  let buildMeta: { productName?: string; iconPath?: string; description?: string; author?: string; appId?: string } = {};
  try {
    const body = await c.req.json();
    buildVersion = body.version;
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

        // ── Done ──────────────────────────────────────────────
        console.log('[build] Build completed successfully');
        send({
          type: 'done',
          success: true,
          output: (buildOut.stdout + '\n' + pkgOut.stdout).slice(-2000) || '',
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
