// Disable SSL verification for self-signed certs
// Needed so the client can talk to the backend's self-signed HTTPS server
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
const { startServer, setBackendUrl, getBackendUrl } = require('./server.cjs');

// ─── Brand-consistent data folders (migrate legacy names once) ──────
// Chromium profile, localStorage, settings and the updater cache used to
// land in generic folders named after the old npm package ("ai-chat-frontend",
// "AI Chat") in both %APPDATA% (Roaming) and %LOCALAPPDATA% (Local).
// Everything now lives under ONE brand folder: "Kasalix-AI-Chat".
const APP_DATA_FOLDER = 'Kasalix-AI-Chat';
// Old data folder in Roaming — renamed (not deleted) so nothing is lost. The
// most recently modified one wins (the profile the user actually used last).
const LEGACY_DATA_FOLDERS = ['Ai-Chat-frontend', 'ai-chat-frontend', 'AI Chat'];
const LEGACY_UPDATER_FOLDER = 'ai-chat-frontend-updater';
(function migrateUserData() {
  try {
    const appData = app.getPath('appData');
    const target = path.join(appData, APP_DATA_FOLDER);
    if (!fs.existsSync(target)) {
      const stats = LEGACY_DATA_FOLDERS
        .map((n) => path.join(appData, n))
        .filter((p) => fs.existsSync(p))
        .map((p) => ({ p, m: fs.statSync(p).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      if (stats.length > 0) {
        const legacy = stats[0].p;
        try {
          fs.renameSync(legacy, target);
          console.log(`[init] Migrated user data: ${path.basename(legacy)} -> ${APP_DATA_FOLDER}`);
        } catch (e) {
          // Old folder locked (app still running, OneDrive, AV scan) — start
          // fresh at the new path rather than blocking startup.
          console.warn(`[init] Could not rename legacy data folder (${e.message}) — starting fresh profile`);
        }
      }
    }
    app.setPath('userData', target);
    // Auto-updater cache in Local: one-time rename so downloaded installers
    // and pending-update state follow the brand.
    const localUpdater = path.join(app.getPath('appData'), '..', 'Local', APP_DATA_FOLDER + '-updater');
    const legacyUpdater = path.join(app.getPath('appData'), '..', 'Local', LEGACY_UPDATER_FOLDER);
    try {
      if (fs.existsSync(legacyUpdater) && !fs.existsSync(localUpdater)) {
        fs.renameSync(legacyUpdater, localUpdater);
        console.log(`[init] Migrated updater cache -> ${APP_DATA_FOLDER}-updater`);
      }
    } catch { /* non-fatal — updater just re-downloads on next update */ }
  } catch (e) {
    console.warn('[init] userData path setup failed:', e.message);
  }
})();
// app.name drives the auto-updater cache (%LOCALAPPDATA%/<name>-updater) —
// align it with the brand so "ai-chat-frontend-updater" becomes
// "Kasalix-AI-Chat-updater".
app.setName('Kasalix-AI-Chat');

// The default URL of the backend AI server
// Matches the backend mode: HTTPS by default, HTTP when HTTPS=false or --http is used
const defaultProtocol = process.env.HTTPS !== 'false' ? 'https' : 'http';
const DEFAULT_BACKEND_URL = process.env.BACKEND_URL || `${defaultProtocol}://localhost:3001`;

// Path to the saved server config file (persists in user data)
const CONFIG_FILE = 'server-config.json';

let mainWindow = null;
let server = null;

// ─── Koding Preview (agent-driven live preview window + bridge) ───────
let previewWindow = null;
let previewBridgeServer = null;
let previewBridgeRegistered = false;

function agentFetch(endpoint, body) {
  // Backend runs on HTTPS with a self-signed certificate — use the
  // bundled http(s) modules with TLS verification disabled.
  const base = getBackendUrl();
  const mod = base.startsWith('https') ? https : http;
  return new Promise((resolve) => {
    try {
      const u = new URL(base.replace(/\/$/, '') + endpoint);
      const payload = JSON.stringify(body || {});
      const req = mod.request({
        hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        rejectUnauthorized: false,
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            console.log(`[agent] ${endpoint} → HTTP ${res.statusCode}: ${String(data).slice(0, 300)}`);
          }
          try { resolve(JSON.parse(data)); } catch { resolve({}); }
        });
      });
      req.on('error', (e) => {
        console.log(`[agent] ${endpoint} → request failed: ${e.message}`);
        resolve({});
      });
      req.write(payload);
      req.end();
    } catch (e) {
      console.log(`[agent] ${endpoint} → error: ${e.message}`);
      resolve({});
    }
  });
}

// ─── Preview preference ("hide preview window") ────────────────────
const PREVIEW_PREFS_FILE = 'preview-prefs.json';

function readPreviewHidden() {
  try {
    const p = path.join(app.getPath('userData'), PREVIEW_PREFS_FILE);
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8')).hidden === true;
    }
  } catch { /* fall through to default */ }
  return false; // default: window IS shown
}

function writePreviewHidden(hidden) {
  try {
    const p = path.join(app.getPath('userData'), PREVIEW_PREFS_FILE);
    fs.writeFileSync(p, JSON.stringify({ hidden: hidden === true }), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

function ensurePreviewWindow(targetUrl) {
  return new Promise((resolve) => {
    const hidden = readPreviewHidden();
    if (previewWindow && !previewWindow.isDestroyed()) {
      previewWindow.loadURL(targetUrl).then(() => resolve({ ok: true, hidden })).catch(() => resolve({ ok: false, hidden }));
      return;
    }
    previewWindow = new BrowserWindow({
      width: 1100, height: 800,
      // Hidden mode: never on screen. Offscreen rendering keeps capturePage
      // working so the agent can still screenshot/verify the page.
      show: !hidden,
      ...(hidden ? { webPreferences: { offscreen: true } } : {}),
      title: 'Koding Preview',
      autoHideMenuBar: true,
      icon: path.join(__dirname, '..', 'icon_client.png'),
      webPreferences: {
        nodeIntegration: false, contextIsolation: true,
        javascript: true, images: true,
      },
    });
    previewWindow.setMenuBarVisibility(false);
    previewWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    previewWindow.on('closed', () => { previewWindow = null; });
    if (hidden) {
      // Offscreen windows need an explicit frame rate to paint at all —
      // without this capturePage() returns blank frames.
      try { previewWindow.webContents.setFrameRate(10); } catch { /* optional */ }
    } else {
      previewWindow.once('ready-to-show', () => {
        try { previewWindow.show(); } catch { /* already visible */ }
      });
    }
    previewWindow.loadURL(targetUrl)
      .then(() => resolve({ ok: true, hidden }))
      .catch(() => resolve({ ok: false, hidden }));
  });
}

function closePreviewWindow() {
  if (previewWindow && !previewWindow.isDestroyed()) {
    try { previewWindow.destroy(); } catch { /* closing anyway */ }
  }
  previewWindow = null;
}

function startPreviewBridge() {
  if (previewBridgeServer) return;
  previewBridgeServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 10 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      const reply = (obj) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method !== 'POST') { reply({ ok: false, error: 'POST only' }); return; }
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch { reply({ ok: false, error: 'bad JSON' }); return; }
      handlePreviewBridge(payload).then(reply).catch((e) => reply({ ok: false, error: e.message }));
    });
  });
  previewBridgeServer.listen(0, '127.0.0.1', async () => {
    const port = previewBridgeServer.address().port;
    console.log(`[preview] Bridge listening on 127.0.0.1:${port}`);
    // Register with the backend, then KEEP re-registering every 15s: the
    // backend forgets us when IT restarts, so the client must re-announce
    // itself (cheap loopback POST; a restarted backend picks the bridge up
    // within seconds without any user action).
    const register = async () => {
      const r = await agentFetch('/api/preview/register-client', { url: `http://127.0.0.1:${port}/` });
      if (r && r.ok) return true;
      if (!register._warnedOnce) {
        register._warnedOnce = true;
        console.log(`[preview] Bridge registration failed (retrying every 15s): ${JSON.stringify(r || null)} — backend: ${getBackendUrl()}`);
      }
      return false;
    };
    for (let attempt = 0; attempt < 10; attempt++) {
      if (await register()) { console.log('[preview] Bridge registered with backend'); break; }
      await new Promise((res) => setTimeout(res, 3000));
    }
    setInterval(async () => {
      const ok = await register();
      if (ok && !previewBridgeRegistered) {
        console.log('[preview] Bridge (re-)registered with backend');
      }
      previewBridgeRegistered = ok;
    }, 15000);
  });
}

async function handlePreviewBridge(payload) {
  const type = payload.type;
  if (type === 'open') {
    const result = await ensurePreviewWindow(String(payload.url || ''));
    // `hidden` tells the backend the user chose headless verification, so
    // the agent can word its answer honestly ("running invisibly, you can
    // open <url> to see it") instead of claiming a window appeared.
    return { ok: result.ok, hidden: result.hidden };
  }
  if (type === 'close') {
    closePreviewWindow();
    return { ok: true };
  }
  if (!previewWindow || previewWindow.isDestroyed()) {
    return { ok: false, error: 'Preview window is not open' };
  }
  if (type === 'capture') {
    try {
      const img = await previewWindow.webContents.capturePage();
      const dir = app.getPath('temp');
      const file = path.join(dir, `kasalix-preview-${Date.now()}.png`);
      fs.writeFileSync(file, img.toPNG());
      return { ok: true, path: file };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  if (type === 'eval') {
    try {
      const result = await previewWindow.webContents.executeJavaScript(String(payload.code || ''), true);
      return { ok: true, value: result === undefined ? null : result };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  if (type === 'ping') return { ok: true };
  return { ok: false, error: `Unknown bridge action: ${type}` };
}

app.on('before-quit', () => {
  closePreviewWindow();
  if (previewBridgeServer) { try { previewBridgeServer.close(); } catch { /* quitting */ } }
});

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

// ─── Auto-Updater (GitHub releases, silent download) ────────────
// Updates are pulled straight from GitHub releases — the exact flow the
// Server app uses: GET /releases/latest → pick the Windows installer
// asset → stream it to the local updater cache → run it silently (/S)
// via a detached helper after this app quits. No backend involvement,
// so updates work no matter which server the client is connected to.

const GITHUB_REPO = process.env.KASALIX_REPO || 'Kasikexe/Kasalix';
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

// Installer staged by download-update; consumed by install-update.
let githubUpdatePath = null;

/** Local cache dir for downloaded installers — %LOCALAPPDATA%, so it is
 *  always writable (unlike the install dir) and shared across launches. */
function getUpdateCacheDir() {
  try {
    const dir = path.join(app.getPath('appData'), '..', 'Local', APP_DATA_FOLDER + '-updater', 'pending');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return os.tmpdir();
  }
}

/** Latest GitHub release, or null when GitHub is unreachable. */
function fetchLatestGitHubRelease() {
  return new Promise((resolve) => {
    try {
      const req = https.get(GITHUB_API, {
        headers: { 'User-Agent': 'Kasalix-Client/1.0', 'Accept': 'application/vnd.github.v3+json' },
      }, (res) => {
        if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    } catch { resolve(null); }
  });
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Run the silent installer via a detached bat helper, then quit.
 *  Same approach as the Server app: this app exits first so no files are
 *  locked, the helper waits, then NSIS runs with /S (the installer
 *  relaunches the app on success). */
function launchSilentInstaller(installerPath) {
  const { spawn } = require('child_process');
  try {
    const bat = path.join(os.tmpdir(), 'kasalix-client-update-' + Date.now() + '.bat');
    const verbElevate = '-Verb Run' + 'As';
    const psCmd = "Start-Process -FilePath '" + installerPath + "' -ArgumentList '/S' "
      + verbElevate + " -Wait";
    const CRLF = String.fromCharCode(13, 10);
    const batText = [
      '@echo off',
      'timeout /t 2 /nobreak >>nul',
      'powershell -NoProfile -ExecutionPolicy Bypass -Command "' + psCmd + '"',
      'del "%~f0"',
    ].join(CRLF);
    fs.writeFileSync(bat, batText, 'utf-8');
    const child = spawn('cmd.exe', ['/d', '/c', bat], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch (e) {
    console.error('[updater] Could not arm installer:', e.message);
    return false;
  }
  setTimeout(() => { try { app.quit(); } catch {} }, 500);
  return true;
}

/** Stream a release asset to the updater cache, emitting progress events. */
function downloadGitHubAsset(asset) {
  return new Promise((resolve) => {
    try {
      const destPath = path.join(getUpdateCacheDir(), asset.name);
      const total = asset.size || 0;
      let received = 0;
      const req = https.get(asset.browser_download_url, {
        headers: { 'User-Agent': 'Kasalix-Client/1.0' },
      }, (res) => {
        // browser_download_url redirects to the CDN — follow manually
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          downloadGitHubAsset({ ...asset, browser_download_url: res.headers.location })
            .then(resolve).catch((e) => resolve({ success: false, error: e.message }));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          resolve({ success: false, error: `Download failed: HTTP ${res.statusCode}` });
          return;
        }
        const fileStream = fs.createWriteStream(destPath);
        res.on('data', (chunk) => {
          received += chunk.length;
          const percent = total > 0 ? Math.round((received / total) * 100) : 0;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('update-download-progress', { percent, total, transferred: received });
          }
        });
        res.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close();
          resolve({ success: true, path: destPath, size: total });
        });
        fileStream.on('error', (err) => resolve({ success: false, error: err.message }));
      });
      req.on('error', (err) => resolve({ success: false, error: err.message }));
      req.setTimeout(600000, () => { req.destroy(); resolve({ success: false, error: 'Download timed out' }); });
    } catch (err) {
      resolve({ success: false, error: err.message });
    }
  });
}

/** Check GitHub for a newer release and notify the renderer (same event
 *  shape as before, so the update UI keeps working unchanged). */
async function checkForUpdates(showSilent = true) {
  try {
    const release = await fetchLatestGitHubRelease();
    if (!release) {
      return { available: false, error: 'Could not reach GitHub' };
    }
    const current = app.getVersion();
    const latest = String(release.tag_name || '').replace(/^v/i, '');
    if (!latest) {
      return { available: false, error: 'Latest release has no version tag' };
    }
    console.log(`[updater] Current: v${current}, GitHub latest: v${latest}`);

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

    if (compareVersions(latest, current) > 0) {
      console.log(`[updater] Update available: v${current} -> v${latest} (critical: ${critical})`);

      // Notify the renderer about the update
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-available', {
          version: latest,
          currentVersion: current,
          releaseNotes: release.body || '',
          critical,
        });
      }
      return { available: true, version: latest, currentVersion: current, critical };
    }

    // Already up to date — still return the latest version so the UI can show it
    return { available: false, latestVersion: latest, currentVersion: current };
  } catch (err) {
    // Silent check failures are expected (offline, GitHub unreachable)
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

/** Get the default workspace root: Documents/Koding.
 * On first run after the rename (v0.11.x), the old generic `Documents/AiChat`
 * folder is renamed to `Koding` so existing projects move with it. Renaming
 * is skipped if Koding already exists (never overwrite user data) — in that
 * case old AiChat projects stay where they are and the user can move them. */
function getDefaultWorkspacePath() {
  const docs = app.getPath('documents');
  const kodingDir = path.join(docs, 'Koding');
  const legacyDir = path.join(docs, 'AiChat');
  try {
    if (!fs.existsSync(kodingDir) && fs.existsSync(legacyDir)) {
      try {
        fs.renameSync(legacyDir, kodingDir);
      } catch {
        // Old folder locked (Explorer open, AV scan, OneDrive sync) — fall
        // through and just create/use Koding; legacy projects stay put.
      }
    }
    fs.mkdirSync(kodingDir, { recursive: true });
  } catch {}
  return kodingDir;
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
    // Packaged: app executable is at C:\Program Files\Kasalix AI Chat\Kasalix AI Chat.exe
    // release dir is C:\Program Files\Kasalix AI Chat\release
    releaseDir = path.join(path.dirname(app.getPath('exe')), 'release');
  } else {
    // Development: release dir is at frontend/release
    releaseDir = path.join(__dirname, '..', 'release');
  }
  console.log(`[main] Release directory: ${releaseDir}`);
  const result = await startServer(distDir, backendUrl, releaseDir);
  server = result.server;
  const port = result.port;

  // Koding preview: start the loopback bridge listener and register it with
  // the backend so agent preview tools can open/capture/drive the window.
  startPreviewBridge();

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
      setTimeout(() => {
        // Updates come from GitHub now — no backend health gate needed
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

  // Navigation guard: the app is a single-page client — a clicked link
  // (e.g. a preview URL the agent posted in chat) must NEVER navigate the
  // main window away, or the whole Kasalix UI is replaced by that page
  // ("the whole screen turned into the game"). Route links instead:
  //  - loopback http(s) URLs (Koding preview pages) → the preview window
  //    (real BrowserWindow with capture support)
  //  - everything else → the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    routeExternalLink(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const appUrl = mainWindow.webContents.getURL();
    if (url && appUrl && url.startsWith(appUrl.split('#')[0].split('?')[0])) return; // same-app navigation
    event.preventDefault();
    routeExternalLink(url);
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }
});

/** Open a URL the right way: loopback preview URLs in the preview window,
 * external URLs in the system browser. Never inside the app window. */
function routeExternalLink(url) {
  if (!url || typeof url !== 'string') return;
  let parsed;
  try { parsed = new URL(url); } catch { return; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return;
  const isLoopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (isLoopback && !parsed.port) return; // malformed — ignore
  if (isLoopback) {
    // Koding preview page: open (or reuse) the preview window so console/
    // capture tooling keeps working for the agent.
    ensurePreviewWindow(url).then((r) => {
      if (!r || !r.ok) shell.openExternal(url).catch(() => {});
    }).catch(() => {});
    return;
  }
  shell.openExternal(url).catch(() => {});
}

// Download progress is emitted from downloadGitHubAsset; the
// 'update-downloaded' event fires from the download-update handler below.

// ─── IPC Handlers: Auto-Update ───────────────────────────────────

ipcMain.handle('check-for-updates', async () => {
  return await checkForUpdates(false);
});

// Silently download the Windows installer from the latest GitHub release
// (same asset-picking rule as the Server app: the .exe that is not a blockmap).
ipcMain.handle('download-update', async () => {
  try {
    const release = await fetchLatestGitHubRelease();
    if (!release) {
      const error = 'Could not reach GitHub';
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-error', { error });
      return { success: false, error };
    }
    const asset = (release.assets || []).find((a) => a.name.endsWith('.exe') && !a.name.endsWith('.exe.blockmap'));
    if (!asset) {
      const error = 'No Windows installer found in the latest release';
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-error', { error });
      return { success: false, error };
    }

    const result = await downloadGitHubAsset(asset);
    if (result.success) {
      githubUpdatePath = result.path;
      const latest = String(release.tag_name || '').replace(/^v/i, '');
      console.log(`[updater] Installer v${latest} downloaded: ${result.path}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-downloaded', { version: latest, releaseNotes: release.body || '' });
      }
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-error', { error: result.error || 'Download failed' });
    }
    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Run the staged installer silently and quit so it can replace the app files.
ipcMain.handle('install-update', async () => {
  try {
    if (!githubUpdatePath || !fs.existsSync(githubUpdatePath)) {
      return { success: false, error: 'No downloaded installer found' };
    }
    launchSilentInstaller(githubUpdatePath);
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

// ─── IPC Handlers: Preview Preference ───────────────────────────

ipcMain.handle('get-preview-preference', () => {
  return { hidden: readPreviewHidden() };
});

ipcMain.handle('set-preview-preference', (_event, hidden) => {
  if (typeof hidden !== 'boolean') return { success: false, error: 'hidden must be boolean' };
  const saved = writePreviewHidden(hidden);
  return { success: saved, hidden };
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
