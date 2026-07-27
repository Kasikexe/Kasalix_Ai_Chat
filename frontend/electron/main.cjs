// Disable SSL verification for self-signed certs (local dev server)
// Needed so the auto-updater can fetch latest.yml and the installer .exe
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { app, BrowserWindow, ipcMain } = require('electron');

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
const DEFAULT_BACKEND_URL = process.env.BACKEND_URL || 'https://localhost:3001';

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

/** Write content to a file */
function writeFileContent(filePath, content) {
  const resolved = path.resolve(filePath);
  // Read old content for diff
  let oldContent = null;
  try { oldContent = fs.readFileSync(resolved, 'utf-8'); } catch {}
  // Ensure parent dir exists
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, 'utf-8');
  return { success: true, path: resolved, isNew: oldContent === null, size: Buffer.byteLength(content, 'utf-8') };
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
    title: 'AI Chat',
    backgroundColor: '#030712',
    show: false,
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

ipcMain.handle('read-file', async (_event, filePath) => {
  try {
    return readFileContent(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') return { error: 'File does not exist' };
    return { error: err.message };
  }
});

ipcMain.handle('write-file', async (_event, filePath, content) => {
  try {
    return writeFileContent(filePath, content);
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('delete-file', async (_event, filePath) => {
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
