// Disable SSL verification for self-signed certs (local dev server)
// Needed so the auto-updater can fetch latest.yml and the installer .exe
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { app, BrowserWindow, ipcMain, shell } = require('electron');

// Chromium command-line switch: ignore cert errors for ALL Chromium network requests
// (auto-updater, net.fetch, net.request in any session, etc.)
// Must be called before app.whenReady() — at module scope is fine.
app.commandLine.appendSwitch('ignore-certificate-errors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const { autoUpdater } = require('electron-updater');
const { startServer, setBackendUrl, getBackendUrl } = require('./server.cjs');

// The default URL of the backend AI server
// Matches the backend mode: HTTPS by default, HTTP when HTTPS=false or --http is used
const defaultProtocol = process.env.HTTPS !== 'false' ? 'https' : 'http';
const DEFAULT_BACKEND_URL = process.env.BACKEND_URL || `${defaultProtocol}://localhost:3001`;

// Path to the saved server config file (persists in user data)
const CONFIG_FILE = 'server-config.json';

let mainWindow = null;
let server = null;

// ─── Update Preference File ──────────────────────────────────────
const UPDATE_CONFIG_FILE = 'update-config.json';

function readUpdatePreference() {
  try {
    const configPath = path.join(app.getPath('userData'), UPDATE_CONFIG_FILE);
    if (fs.existsSync(configPath)) {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (typeof data.enabled === 'boolean') return data.enabled;
    }
  } catch (err) {
    console.warn('[main] Failed to read update config:', err.message);
  }
  return true; // Default: enabled
}

function saveUpdatePreference(enabled) {
  try {
    const configPath = path.join(app.getPath('userData'), UPDATE_CONFIG_FILE);
    fs.writeFileSync(configPath, JSON.stringify({ enabled, updatedAt: Date.now() }, null, 2), 'utf-8');
    console.log(`[main] Update preference saved: ${enabled}`);
    return true;
  } catch (err) {
    console.error('[main] Failed to save update config:', err.message);
    return false;
  }
}
// session.setCertificateVerifyProc handles ALL Chromium network requests
// (auto-updater, net.fetch, net.request, etc.) — unlike certificate-error
// which only covers BrowserWindow/webContents loads.
const { session } = require('electron');
app.whenReady().then(() => {
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    const hostname = request.hostname;
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('10.') ||
      hostname.startsWith('172.16.')
    ) {
      callback(0); // Trust — 0 means valid
    } else {
      callback(-2); // Default behavior (ERR_FAILED)
    }
  });
});

// Fallback: also handle certificate-error for BrowserWindow loads
app.on('certificate-error', (event, _webContents, url, _error, _certificate, callback) => {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('10.') ||
      hostname.startsWith('172.16.')
    ) {
      event.preventDefault();
      callback(true);
      return;
    }
  } catch {}
  callback(false);
});

// ─── Auto-Updater ───────────────────────────────────────────────

// Don't auto-download — we notify the user and let them choose
autoUpdater.autoDownload = false;
autoUpdater.allowPrerelease = true;

/** Configure the updater to fetch updates from the backend server (network-accessible) */
function configureUpdater(backendUrl) {
  try {
    // Use the backend URL as the feed URL — this is accessible from any PC on the
    // network because the backend serves latest.yml and .exe files at its root.
    // The publish.url in latest.yml is set to empty so the updater resolves paths
    // RELATIVE to the feed URL (i.e., https://backend:3001/AI-Chat-Setup-1.5.0.exe).
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: backendUrl,
      channel: 'latest',
    });
    console.log(`[updater] Feed URL configured: ${backendUrl}/latest.yml`);
  } catch (err) {
    console.error('[updater] Failed to configure feed URL:', err.message);
  }
}

/** Check for updates manually (called after window is ready) */
async function checkForUpdates(showSilent = true) {
  try {
    const result = await autoUpdater.checkForUpdates();
    if (result && result.updateInfo && result.updateInfo.version) {
      const current = app.getVersion();
      const latest = result.updateInfo.version;
      console.log(`[updater] Current: ${current}, Latest: ${latest}`);

          // Always check critical status
      let critical = false;
      try {
        const backendUrl = getBackendUrl();
        const httpMod = backendUrl.startsWith('https') ? https : http;
        const urlObj = new URL(`${backendUrl}/api/build/critical`);
        const critResult = await new Promise((resolve) => {
          const req = httpMod.request(
            { hostname: urlObj.hostname, port: urlObj.port, path: urlObj.pathname, method: 'GET', rejectUnauthorized: false, timeout: 3000 },
            (res) => {
              let data = '';
              res.on('data', (chunk) => { data += chunk; });
              res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch { resolve({ critical: false }); }
              });
            }
          );
          req.on('error', () => resolve({ critical: false }));
          req.on('timeout', () => { req.destroy(); resolve({ critical: false }); });
          req.end();
        });
        critical = critResult.critical === true && critResult.version === latest;
      } catch { /* non-critical: fallback */ }

      if (current !== latest) {
        console.log(`[updater] Update critical: ${critical}`);

        // Notify the renderer about the update
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('update-available', {
            version: latest,
            currentVersion: current,
            releaseNotes: result.updateInfo.releaseNotes || '',
            critical,
          });
        }
        return { available: true, version: latest, currentVersion: current, critical };
      }

      // Version matches — still return the latest version so the UI can show what's available
      console.log(`[updater] Already up to date (v${current}). Server latest: v${latest}`);
      return { available: false, latestVersion: latest, currentVersion: current };
    }
    // No update info returned at all
    return { available: false, error: 'Could not read update information from server' };
  } catch (err) {
    // Silent check failures are expected (server might not have update files yet)
    if (!showSilent) {
      console.warn('[updater] Check failed:', err.message);
    }
    return { available: false, error: err.message };
  }
}

// ─── Server Config ───────────────────────────────────────────────

function readServerConfig() {
  try {
    const configPath = path.join(app.getPath('userData'), CONFIG_FILE);
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(data);
      if (config.backendUrl) return config;
    }
  } catch (err) {
    console.warn('[main] Failed to read server config:', err.message);
  }
  return null;
}

function saveServerConfig(url) {
  try {
    const configPath = path.join(app.getPath('userData'), CONFIG_FILE);
    const config = { backendUrl: url, savedAt: Date.now() };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    console.log(`[main] Saved server config: ${url}`);
    return true;
  } catch (err) {
    console.error('[main] Failed to save server config:', err.message);
    return false;
  }
}

// ─── Subnet Scanning ─────────────────────────────────────────────

/** Try to connect to a single IP on port 3001 (both HTTP and HTTPS) */
function tryConnect(ip, timeoutMs) {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (result) => {
      if (!resolved) { resolved = true; resolve(result); }
    };

    // Try HTTPS first, then HTTP
    tryUrl(`https://${ip}:3001/api/health`, timeoutMs).then((ok) => {
      if (ok) return done(`https://${ip}:3001`);
      tryUrl(`http://${ip}:3001/api/health`, timeoutMs).then((ok2) => {
        done(ok2 ? `http://${ip}:3001` : null);
      });
    });
  });
}

function tryUrl(urlStr, timeoutMs) {
  return new Promise((resolve) => {
    try {
      const urlObj = new URL(urlStr);
      const transport = urlObj.protocol === 'https:' ? https : http;
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname,
        method: 'GET',
        rejectUnauthorized: false,
        timeout: timeoutMs,
      };
      const req = transport.request(options, (res) => {
        resolve(res.statusCode >= 200 && res.statusCode < 400);
        res.resume();
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    } catch { resolve(false); }
  });
}

/** Scan the subnet for any device responding on port 3001 */
async function scanSubnet() {
  const interfaces = os.networkInterfaces();
  const seen = new Set();
  const scanTargets = [];

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (
        iface.family === 'IPv4' && !iface.internal &&
        !name.toLowerCase().includes('docker') &&
        !name.toLowerCase().includes('virtual') &&
        !name.toLowerCase().includes('vmware') &&
        !name.toLowerCase().includes('vbox')
      ) {
        // Use only /24 subnets (first 3 octets) for practical scanning
        const parts = iface.address.split('.');
        const subnet = `${parts[0]}.${parts[1]}.${parts[2]}`;
        const ownIp = iface.address;
        for (let i = 1; i <= 254; i++) {
          const ip = `${subnet}.${i}`;
          if (ip !== ownIp && !seen.has(ip)) {
            seen.add(ip);
            scanTargets.push(ip);
          }
        }
      }
    }
  }

  if (scanTargets.length === 0) return null;

  // Scan in parallel batches of 50, 300ms timeout per request
  const BATCH_SIZE = 50;
  const TIMEOUT = 300;

  for (let i = 0; i < scanTargets.length; i += BATCH_SIZE) {
    const batch = scanTargets.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map((ip) => tryConnect(ip, TIMEOUT)));
    const found = results.find(Boolean);
    if (found) return found;
  }

  return null;
}

// ─── Local File Operations ───────────────────────────────────────

/** Get the default workspace path: Documents/AiChat */
function getDefaultWorkspacePath() {
  const docs = app.getPath('documents');
  const aiChatDir = path.join(docs, 'AiChat');
  try {
    fs.mkdirSync(aiChatDir, { recursive: true });
  } catch {}
  return aiChatDir;
}

/**
 * Workspace sandbox: file content/delete/write must stay inside the workspace
 * root the renderer declares. The workspace must be a real subfolder (not a
 * drive root). Listing stays open so the workspace picker can browse.
 */
function resolveWorkspaceRoot(ws) {
  if (!ws || typeof ws !== 'string') return null;
  const resolved = path.resolve(ws);
  if (path.parse(resolved).root === resolved) return null;
  return resolved;
}

/** Realpath the nearest EXISTING ancestor of `p`, then re-append the missing
 * tail, so containment checks work even when the target (or any parent dir)
 * does not exist yet — e.g. creating a brand-new project subfolder. Symlinks
 * in the existing part are still resolved, so symlink escapes stay blocked. */
function resolveForContainment(p) {
  const missing = [];
  let current = p;
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return missing.length === 0 ? real : path.join(real, ...missing);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p); // reached the root — give up resolving
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isPathInside(root, target) {
  // Realpath comparison so symlinks inside the workspace cannot point outside it.
  // Missing path segments (new files/folders) are resolved via their nearest
  // existing ancestor, so creating a new project folder inside the workspace
  // passes the check instead of failing realpath.
  try {
    const realRoot = resolveForContainment(root);
    const realTarget = resolveForContainment(target);
    const rel = path.relative(realRoot, realTarget);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

/** List directory contents */
function listDir(dirPath) {
  const resolved = path.resolve(dirPath);
  const entries = fs.readdirSync(resolved, { withFileTypes: true });
  const result = entries
    .filter((e) => !e.name.startsWith('.'))
    .map((e) => {
      const fullPath = path.join(resolved, e.name);
      let size;
      if (e.isFile()) {
        try { size = fs.statSync(fullPath).size; } catch {}
      }
      return {
        name: e.name,
        path: fullPath.replace(/\\\\/g, '/'),
        type: e.isDirectory() ? 'directory' : 'file',
        size,
      };
    });
  // Sort: directories first, then files alphabetically
  result.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { entries: result };
}

/** Read a file's content */
function readFileContent(filePath) {
  const resolved = path.resolve(filePath);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) return { error: 'Not a file' };

  const MAX_SIZE = 1024 * 1024;
  const truncated = stat.size > MAX_SIZE;
  const buffer = fs.readFileSync(resolved, { flag: 'r' });

  // Check if binary
  const sampleSize = Math.min(buffer.length, 8192);
  let binary = false;
  for (let i = 0; i < sampleSize; i++) {
    if (buffer[i] === 0) { binary = true; break; }
  }

  if (binary) return { content: null, binary: true, size: stat.size, truncated: false };

  const content = truncated
    ? buffer.subarray(0, MAX_SIZE).toString('utf-8')
    : buffer.toString('utf-8');

  return { content, binary: false, size: stat.size, truncated };
}

/** Compact line diff (Myers): returns hunks, or null when too different. */
function diffLines(aLines, bLines, maxD = 400) {
  const N = aLines.length, M = bLines.length;
  const max = N + M, offset = max;
  const V = new Int32Array(2 * max + 1);
  const trace = [];
  let foundD = -1;
  outer: for (let d = 0; d <= maxD; d++) {
    trace.push(V.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && V[offset + k - 1] < V[offset + k + 1])) x = V[offset + k + 1];
      else x = V[offset + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && aLines[x] === bLines[y]) { x++; y++; }
      V[offset + k] = x;
      if (x >= N && y >= M) { foundD = d; break outer; }
    }
  }
  if (foundD === -1) return null;
  const hunks = [];
  let x = N, y = M;
  for (let d = foundD; d > 0; d--) {
    const Vp = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && Vp[offset + k - 1] < Vp[offset + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = Vp[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; }
    if (x === prevX) { hunks.unshift({ oldStart: prevX, oldCount: 0, newStart: prevY, newCount: y - prevY }); y = prevY; }
    else { hunks.unshift({ oldStart: prevX, oldCount: x - prevX, newStart: prevY, newCount: 0 }); x = prevX; }
  }
  const merged = [];
  for (const h of hunks) {
    const last = merged[merged.length - 1];
    if (last && last.oldStart + last.oldCount === h.oldStart && last.newStart + last.newCount === h.newStart) {
      last.oldCount += h.oldCount;
      last.newCount += h.newCount;
    } else merged.push({ ...h });
  }
  return merged;
}

/** Changed-line count: number of edited lines between two file texts. */
function changedLineCount(a, b) {
  const aLines = a.split('\n'), bLines = b.split('\n');
  const hunks = diffLines(aLines, bLines);
  if (!hunks) return { count: Infinity, total: Math.max(aLines.length, bLines.length) };
  return { count: hunks.reduce((s, h) => s + h.oldCount + h.newCount, 0), total: Math.max(aLines.length, bLines.length) };
}

/** Write content to a file. For EXISTING files this is a SURGICAL apply: only
 * the lines that actually differ are written (whole-file re-emits are refused)
 * so a slightly-off full rewrite can't silently clobber the user's work. */
function writeFileContent(filePath, content) {
  const resolved = path.resolve(filePath);
  // Read old content for diff
  let oldContent = null;
  try { oldContent = fs.readFileSync(resolved, 'utf-8'); } catch {}
  // Ensure parent dir exists
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  if (oldContent !== null) {
    const { count: changed, total } = changedLineCount(
      oldContent.replace(/\r\n/g, '\n'),
      content.replace(/\r\n/g, '\n')
    );
    const isSmallEdit = changed <= Math.max(20, Math.floor(total * 0.4));
    if (!isSmallEdit) {
      const err = new Error(`Refusing to overwrite ${path.basename(resolved)}: your version changes ${changed} of ${total} lines — that is a full rewrite, not an edit. To rewrite the whole file on purpose, delete it first (or use the edit/EDIT flow with a small old_string).`);
      err.code = 'EWRITEGUARD';
      throw err;
    }
    const finalContent = oldContent.includes('\r\n')
      ? content.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
      : content;
    fs.writeFileSync(resolved, finalContent, 'utf-8');
    return { success: true, path: resolved, isNew: false, size: Buffer.byteLength(finalContent, 'utf-8') };
  }
  fs.writeFileSync(resolved, content, 'utf-8');
  return { success: true, path: resolved, isNew: true, size: Buffer.byteLength(content, 'utf-8') };
}

/** Surgical edit: replace oldString with newString inside an existing file */
function editFileContent(filePath, oldString, newString) {
  const resolved = path.resolve(filePath);
  const content = fs.readFileSync(resolved, 'utf-8');

  // Exact match first
  let count = 0;
  let idx = content.indexOf(oldString);
  while (idx !== -1) { count++; idx = content.indexOf(oldString, idx + oldString.length); }
  if (count === 1) {
    const updated = content.replace(oldString, newString);
    fs.writeFileSync(resolved, updated, 'utf-8');
    return { success: true, path: resolved, size: Buffer.byteLength(updated, 'utf-8') };
  }
  if (count > 1) {
    throw new Error('Found multiple identical matches — include more surrounding context to make it unique.');
  }

  // Whitespace-tolerant line match (collapse runs of whitespace per line)
  const norm = (l) => l.replace(/\r$/, '').replace(/\s+/g, ' ').trim();
  const contentLines = content.split('\n').map((l) => l.replace(/\r$/, ''));
  const oldLines = oldString.split('\n').map(norm);
  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    let match = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (norm(contentLines[i + j]) !== oldLines[j]) { match = false; break; }
    }
    if (match) {
      // Empty replacement = deletion of the matched lines
      const replacement = newString === '' ? [] : newString.split('\n');
      const updated = [...contentLines.slice(0, i), ...replacement, ...contentLines.slice(i + oldLines.length)].join('\n');
      fs.writeFileSync(resolved, updated, 'utf-8');
      return { success: true, path: resolved, size: Buffer.byteLength(updated, 'utf-8') };
    }
  }

  throw new Error('Could not find the search text in the file. Read the current file and retry with the exact text.');
}

/** Delete a file or directory */
function deleteFileOrDir(filePath) {
  const resolved = path.resolve(filePath);
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    fs.rmSync(resolved, { recursive: true });
  } else {
    fs.unlinkSync(resolved);
  }
  return { success: true, path: resolved };
}

// ─── App Startup ─────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Determine backend URL: saved config > env var > default
  const savedConfig = readServerConfig();
  let backendUrl = savedConfig ? savedConfig.backendUrl : DEFAULT_BACKEND_URL;

  console.log(`[main] Backend URL: ${backendUrl}`);

  // Start a local static file server that also proxies /api to the backend
  const distDir = path.join(__dirname, '..', 'dist');
  // Calculate the release directory — when packaged, __dirname is inside app.asar,
  // but the release folder is at the app root (same level as app.asar, NOT inside it)
  const isPackaged = app.isPackaged;
  let releaseDir;
  if (isPackaged) {
    // Packaged: app executable is at C:\Program Files\AI Chat\AI Chat.exe
    // release dir is C:\Program Files\AI Chat\release
    releaseDir = path.join(path.dirname(app.getPath('exe')), 'release');
  } else {
    // Development: release dir is at frontend/release
    releaseDir = path.join(__dirname, '..', 'release');
  }
  console.log(`[main] Release directory: ${releaseDir}`);
  const result = await startServer(distDir, backendUrl, releaseDir);
  server = result.server;
  const port = result.port;

  // Configure the auto-updater to fetch from the backend server (network-accessible)
  // The backend serves latest.yml and .exe files at its root routes
  configureUpdater(backendUrl);

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 600,
    title: 'Kasalix AI Chat',
    backgroundColor: '#030712',
    show: false,
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'icon.png')
      : path.join(__dirname, '..', '..', 'icon_client.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Load the locally-served frontend
  mainWindow.loadURL(`http://localhost:${port}`);

  // Show window when ready (avoids white flash)
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Check for updates silently after the window is shown (if enabled)
    const updateEnabled = readUpdatePreference();
    if (updateEnabled) {
      setTimeout(async () => {
        // First check if backend is reachable — no point trying updates if it's down
        try {
          const backendUrl = getBackendUrl();
          const httpMod = backendUrl.startsWith('https') ? https : http;
          const urlObj = new URL(`${backendUrl}/api/health`);
          const healthy = await new Promise((resolve) => {
            const req = httpMod.request(
              { hostname: urlObj.hostname, port: urlObj.port, path: urlObj.pathname, method: 'GET', rejectUnauthorized: false, timeout: 3000 },
              (res) => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 400); }
            );
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.end();
          });
          if (!healthy) {
            console.log('[updater] Backend unreachable, skipping update check');
            return;
          }
        } catch { /* skip health check on error */ }

        checkForUpdates(true).catch((err) => {
          console.warn('[updater] Initial check failed:', err.message);
        });
      }, 5000); // Wait 5 seconds to let the app settle
    } else {
      console.log('[updater] Auto-update disabled by user preference');
    }
  });

  // Hide menu bar
  mainWindow.setMenuBarVisibility(false);

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }
});

// ─── Auto-Updater Event Handlers ─────────────────────────────────

autoUpdater.on('download-progress', (progress) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-download-progress', {
      percent: Math.round(progress.percent),
      bytesPerSecond: progress.bytesPerSecond,
      total: progress.total,
      transferred: progress.transferred,
    });
  }
});

autoUpdater.on('update-downloaded', (info) => {
  console.log(`[updater] Update v${info.version} downloaded and ready to install.`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-downloaded', {
      version: info.version,
      releaseNotes: info.releaseNotes || '',
    });
  }
});

autoUpdater.on('error', (err) => {
  console.error('[updater] Error:', err.message);
  // Suppress network/cert errors when the backend is unreachable
  const isNetworkError = err.message && (
    err.message.includes('ERR_CERT_AUTHORITY_INVALID') ||
    err.message.includes('ERR_CONNECTION_REFUSED') ||
    err.message.includes('ERR_CONNECTION_RESET') ||
    err.message.includes('ERR_NAME_NOT_RESOLVED') ||
    err.message.includes('ENOTFOUND') ||
    err.message.includes('ECONNREFUSED') ||
    err.message.includes('ETIMEDOUT')
  );
  if (isNetworkError) {
    console.log('[updater] Network error suppressed — backend may be offline');
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-error', { error: err.message });
  }
});

// ─── IPC Handlers: Auto-Update ───────────────────────────────────

ipcMain.handle('check-for-updates', async () => {
  return await checkForUpdates(false);
});

ipcMain.handle('download-update', async () => {
  try {
    autoUpdater.downloadUpdate();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('install-update', async () => {
  try {
    autoUpdater.quitAndInstall(false, true);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-app-version', () => {
  return { version: app.getVersion() };
});

// ─── IPC Handlers: Update Preference ────────────────────────────

ipcMain.handle('get-update-preference', () => {
  return { enabled: readUpdatePreference() };
});

ipcMain.handle('set-update-preference', (_event, enabled) => {
  if (typeof enabled !== 'boolean') return { success: false, error: 'enabled must be boolean' };
  const saved = saveUpdatePreference(enabled);
  return { success: true, saved };
});

// ─── IPC Handlers: Server Config ─────────────────────────────────

ipcMain.handle('get-backend-url', () => {
  return { url: getBackendUrl(), hasSavedConfig: readServerConfig() !== null };
});

ipcMain.handle('set-backend-url', async (_event, newUrl) => {
  if (!newUrl || typeof newUrl !== 'string') {
    return { success: false, error: 'Invalid URL' };
  }
  try {
    const urlObj = new URL(newUrl);
    if (!['http:', 'https:'].includes(urlObj.protocol)) {
      return { success: false, error: 'URL must start with http:// or https://' };
    }
  } catch {
    return { success: false, error: 'Invalid URL format' };
  }
  setBackendUrl(newUrl);
  const saved = saveServerConfig(newUrl);
  // Re-configure the auto-updater with the new backend URL
  configureUpdater(newUrl);
  return { success: true, saved };
});

// ─── IPC Handlers: Network Detection ─────────────────────────────

ipcMain.handle('detect-ips', () => {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (
        iface.family === 'IPv4' && !iface.internal &&
        !name.toLowerCase().includes('docker') &&
        !name.toLowerCase().includes('virtual') &&
        !name.toLowerCase().includes('vmware') &&
        !name.toLowerCase().includes('vbox')
      ) {
        ips.push({ address: iface.address, netmask: iface.netmask, interface: name });
      }
    }
  }
  return ips;
});

ipcMain.handle('scan-subnet', async () => {
  try {
    const result = await scanSubnet();
    return { found: result !== null, url: result };
  } catch (err) {
    return { found: false, error: err.message };
  }
});

ipcMain.handle('test-server-url', async (_event, testUrl) => {
  try {
    const urlObj = new URL(testUrl);
    const transport = urlObj.protocol === 'https:' ? https : http;
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname,
      method: 'GET',
      rejectUnauthorized: false,
      timeout: 5000,
    };
    const result = await new Promise((resolve) => {
      const req = transport.request(options, (res) => {
        resolve({ online: res.statusCode >= 200 && res.statusCode < 400 });
        res.resume();
      });
      req.on('error', (err) => resolve({ online: false, error: err.message }));
      req.on('timeout', () => { req.destroy(); resolve({ online: false, error: 'Connection timed out' }); });
      req.end();
    });
    return result;
  } catch (err) {
    return { online: false, error: err.message };
  }
});

ipcMain.handle('check-server-health', async () => {
  try {
    const urlObj = new URL(`${getBackendUrl()}/api/health`);
    const transport = urlObj.protocol === 'https:' ? https : http;
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname,
      method: 'GET',
      rejectUnauthorized: false,
      timeout: 3000,
    };
    const result = await new Promise((resolve) => {
      const req = transport.request(options, (res) => {
        resolve({ online: res.statusCode >= 200 && res.statusCode < 400 });
        res.resume();
      });
      req.on('error', () => resolve({ online: false }));
      req.on('timeout', () => { req.destroy(); resolve({ online: false }); });
      req.end();
    });
    return result;
  } catch {
    return { online: false };
  }
});

// ─── IPC Handlers: Local File Operations ─────────────────────────

ipcMain.handle('get-default-workspace', () => {
  return getDefaultWorkspacePath().replace(/\\\\/g, '/');
});

ipcMain.handle('list-dir', async (_event, dirPath) => {
  try {
    return listDir(dirPath);
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('read-file', async (_event, filePath, workspacePath) => {
  const root = resolveWorkspaceRoot(workspacePath);
  if (!root) return { error: 'A valid workspacePath is required' };
  if (!isPathInside(root, filePath)) return { error: 'Access denied: path is outside the workspace' };
  try {
    return readFileContent(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') return { error: 'File does not exist' };
    return { error: err.message };
  }
});

ipcMain.handle('write-file', async (_event, filePath, content, workspacePath) => {
  const root = resolveWorkspaceRoot(workspacePath);
  if (!root) return { error: 'A valid workspacePath is required' };
  if (!isPathInside(root, filePath)) return { error: 'Access denied: path is outside the workspace' };
  try {
    return writeFileContent(filePath, content);
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('edit-file', async (_event, filePath, oldString, newString, workspacePath) => {
  const root = resolveWorkspaceRoot(workspacePath);
  if (!root) return { error: 'A valid workspacePath is required' };
  if (!isPathInside(root, filePath)) return { error: 'Access denied: path is outside the workspace' };
  try {
    return editFileContent(filePath, oldString, newString);
  } catch (err) {
    if (err.code === 'ENOENT') return { error: 'File does not exist' };
    return { error: err.message };
  }
});

ipcMain.handle('delete-file', async (_event, filePath, workspacePath) => {
  const root = resolveWorkspaceRoot(workspacePath);
  if (!root) return { error: 'A valid workspacePath is required' };
  if (!isPathInside(root, filePath)) return { error: 'Access denied: path is outside the workspace' };
  try {
    return deleteFileOrDir(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') return { error: 'File does not exist' };
    return { error: err.message };
  }
});

// ─── IPC Handlers: Folder Dialog ────────────────────────────────

ipcMain.handle('open-folder-dialog', async () => {
  const { dialog } = require('electron');
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select Workspace Folder',
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }
    const selectedPath = result.filePaths[0].replace(/\\/g, '/');
    const name = selectedPath.split('/').filter(Boolean).pop() || 'Workspace';
    return { canceled: false, path: selectedPath, name };
  } catch (err) {
    return { canceled: true, error: err.message };
  }
});

// ─── IPC Handlers: About / Legal ────────────────────────────────

/**
 * Return app identity + the bundled legal documents (LICENSE, NOTICE,
 * THIRD_PARTY_NOTICES, GPL text) so the UI can show an About dialog.
 * Packaged: reads from resources/ (extraResources). Dev: repo root.
 */
ipcMain.handle('get-about-info', () => {
  const legalDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..');
  const relFiles = ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md'];
  const legal = relFiles.map((rel) => {
    const full = path.join(legalDir, rel);
    let content = null;
    try {
      content = fs.readFileSync(full, 'utf-8');
    } catch {
      content = null;
    }
    return { name: rel, path: full, content };
  });
  return {
    name: 'Kasalix AI Chat',
    version: app.getVersion(),
    copyright: 'Copyright (c) 2026 Filip Kasman',
    license: 'Apache License 2.0',
    legal,
  };
});

/** Open a legal document in the system default viewer (used by the About dialog).
 *  Only paths inside the legal resources dir (or repo root in dev) are allowed. */
ipcMain.handle('open-legal-file', async (_event, filePath) => {
  try {
    const legalDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..');
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(legalDir))) {
      return { success: false, error: 'Access denied' };
    }
    if (!fs.existsSync(resolved)) {
      return { success: false, error: 'File not found' };
    }
    const err = await shell.openPath(resolved);
    return err ? { success: false, error: err } : { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC Handlers: External Links ────────────────────────────────

/** Open an http(s) URL in the system default browser (used by the changelog view). */
ipcMain.handle('open-external', async (_event, url) => {
  if (typeof url !== 'string') return { success: false, error: 'Invalid URL' };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { success: false, error: 'Invalid URL' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { success: false, error: 'Only http(s) links are allowed' };
  }
  try {
    await shell.openExternal(url);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── Lifecycle ───────────────────────────────────────────────────

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) app.emit('ready');
});

app.on('before-quit', () => {
  if (server) { server.close(); server = null; }
});
