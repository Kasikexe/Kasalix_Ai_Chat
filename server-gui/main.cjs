const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, exec, execSync } = require('child_process');
const net = require('net');

// ─── Paths (resolved at runtime) ─────────────────────────────────
// Resources resolve to: packaged → process.resourcesPath, dev → project root
const RESOURCES_DIR = app.isPackaged
  ? process.resourcesPath
  : path.join(__dirname, '..', '..');

const BACKEND_DIR = path.join(RESOURCES_DIR, 'backend');
const CERTS_DIR = path.join(RESOURCES_DIR, 'certs');
const RELEASE_DIR = path.join(RESOURCES_DIR, 'release');

// ─── Stable data location ────────────────────────────────────────
// The backend writes its runtime data (accounts, conversations, speed tests,
// memory, uploads, settings) to process.cwd()/data. For a portable exe that
// cwd is the temp extraction dir (resourcesPath), which gets WIPED — so users
// would lose data on every update. Instead we point DATA_DIR at a stable
// per-install folder next to the exe, which survives updates (NSIS File /r
// never deletes it) and matches run-server.bat.
function getAppDataRoot() {
  // Portable exe: env var set by electron-builder pointing at the exe's folder
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  // Installed (non-portable) build
  if (app.isPackaged) return path.dirname(app.getPath('exe'));
  // Dev: project root (same place the repo's backend/data lives)
  return path.join(__dirname, '..', '..');
}
const APP_DATA_ROOT = getAppDataRoot();
const DATA_DIR = path.join(APP_DATA_ROOT, 'data');
const GENERATED_IMAGES_DIR = path.join(APP_DATA_ROOT, 'generated_images');
const GITHUB_API = 'https://api.github.com/repos/Kasikexe/Kasalix/releases/latest';

let mainWindow = null;
let serverProcess = null;
let statsInterval = null;

// Track how the backend is currently running (HTTPS vs HTTP, port) so
// the auth IPC handlers can talk to it with the correct protocol.
// Previously these were hardcoded to http://localhost:3001, which broke
// auth whenever the backend ran in HTTPS mode (the default).
let serverMode = { https: false, port: 3001 };

// ─── Detect Local IPs ───────────────────────────────────────────
function getLocalIPs() {
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
}

// ─── CPU Measurement (cross-platform) ───────────────────────────
// os.loadavg() returns [0,0,0] on Windows, so we use os.cpus() tick deltas.
let _prevCpuTimes = null;

function getCpuUsage() {
  const cpus = os.cpus();
  let totalIdle = 0;
  let totalTick = 0;

  const current = cpus.map((cpu) => ({
    idle: cpu.times.idle,
    total: Object.values(cpu.times).reduce((a, b) => a + b, 0),
  }));

  if (!_prevCpuTimes) {
    _prevCpuTimes = current;
    return { count: cpus.length, usagePercent: 0, load: 0 };
  }

  for (let i = 0; i < current.length; i++) {
    const deltaIdle = current[i].idle - _prevCpuTimes[i].idle;
    const deltaTotal = current[i].total - _prevCpuTimes[i].total;
    totalIdle += deltaIdle;
    totalTick += deltaTotal;
  }

  _prevCpuTimes = current;
  const usagePercent = totalTick > 0
    ? Math.round((1 - totalIdle / totalTick) * 100)
    : 0;

  return {
    count: cpus.length,
    usagePercent,
    load: usagePercent / 100,
  };
}

// ─── GPU Measurement (async, non-blocking) ───────────────────────
function getGpuInfo(callback) {
  exec(
    'nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,name,driver_version --format=csv,noheader,nounits',
    { encoding: 'utf-8', timeout: 2000, windowsHide: true },
    (error, stdout) => {
      if (error || !stdout) {
        callback(null);
        return;
      }
      const parts = stdout.trim().split(', ');
      callback({
        gpuUtil: parseFloat(parts[0]) || 0,
        memUsed: parseInt(parts[1]) || 0,
        memTotal: parseInt(parts[2]) || 0,
        name: parts[3] || 'Unknown',
        driverVersion: parts[4] || '',
      });
    }
  );
}

// ─── Cached GPU Info (updated asynchronously) ───────────────────
let _lastGpuInfo = null;

function getGpuInfo(callback) {
  exec(
    'nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,name,driver_version --format=csv,noheader,nounits',
    { encoding: 'utf-8', timeout: 2000, windowsHide: true },
    (error, stdout) => {
      if (error || !stdout) {
        _lastGpuInfo = null;
        callback(null);
        return;
      }
      const parts = stdout.trim().split(', ');
      const info = {
        gpuUtil: parseFloat(parts[0]) || 0,
        memUsed: parseInt(parts[1]) || 0,
        memTotal: parseInt(parts[2]) || 0,
        name: parts[3] || 'Unknown',
        driverVersion: parts[4] || '',
      };
      _lastGpuInfo = info;
      callback(info);
    }
  );
}

// ─── System Stats ───────────────────────────────────────────────
function getSystemStats() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  const cpu = getCpuUsage();

  return {
    cpu,
    ram: {
      total: totalMem,
      used: usedMem,
      free: freeMem,
      usagePercent: Math.round((usedMem / totalMem) * 100),
    },
    gpu: _lastGpuInfo, // Use cached value (updated async every poll)
  };
}

// ─── Check Port Availability ────────────────────────────────────
function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port, '127.0.0.1');
  });
}

// ─── Ollama Models ───────────────────────────────────────────────
async function getRunningModels() {
  try {
    const https = require('https');
    const http = require('http');
    return new Promise((resolve) => {
      const req = http.get('http://localhost:11434/api/ps', (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.models || []);
          } catch { resolve([]); }
        });
      });
      req.on('error', () => resolve([]));
      req.setTimeout(3000, () => { req.destroy(); resolve([]); });
    });
  } catch { return []; }
}

// ─── Bun Runtime Detection ────────────────────────────────────────
// Bun may be installed but not on the current process PATH (fresh install).
// We check PATH first, then fall back to the well-known install locations.
function resolveBunPath() {
  try {
    execSync('where bun', { stdio: 'ignore', windowsHide: true });
    return 'bun';
  } catch { /* not on PATH */ }
  const candidates = [
    path.join(os.homedir(), '.bun', 'bin', 'bun.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'bun', 'bun.exe'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

// ─── Server Management ───────────────────────────────────────────
async function startServer(httpMode) {
  if (serverProcess) {
    return { success: false, error: 'Server already running' };
  }

  const port = process.env.PORT || 3001;
  const certFile = path.join(CERTS_DIR, 'localhost.crt');
  const keyFile = path.join(CERTS_DIR, 'localhost.key');
  let useHttps = !httpMode && fs.existsSync(certFile);

  // Auto-generate missing/expired SSL certificates (zero-dependency, pure
  // Node crypto — no openssl needed) so HTTPS stays the default even when
  // the certs folder was deleted or reset.
  if (!httpMode && !useHttps) {
    try {
      const certGen = require(path.join(CERTS_DIR, 'generate-certs.cjs'));
      const created = certGen.ensureCerts(certFile, keyFile);
      useHttps = fs.existsSync(certFile) && fs.existsSync(keyFile);
      if (useHttps && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('server-log', created
          ? '[server] SSL certificates missing — generated automatically\n'
          : '[server] SSL certificates ready\n');
      }
    } catch (_) {
      // Generation unavailable (e.g. older packaged build without the
      // generator) — keep the existing HTTP fallback below.
    }
  }

  // Check if port is already in use (e.g., zombie bun from a previous stop)
  const portInUse = await isPortInUse(parseInt(port));
  if (portInUse) {
    if (os.platform() === 'win32') {
      // Use netstat to find the exact PID holding the port, then kill only that process
      try {
        const netstatOut = execSync(
          `netstat -ano | findstr ":${port} "`,
          { encoding: 'utf-8', windowsHide: true, timeout: 3000 }
        );
        // Parse PID from netstat output: proto  local  foreign  state  PID
        // Example: "  TCP    0.0.0.0:3001    0.0.0.0:0    LISTENING    12345"
        const lines = netstatOut.split('\n').filter(l => l.includes('LISTENING'));
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[parts.length - 1]);
          if (pid && !isNaN(pid)) {
            try {
              execSync(`taskkill /PID ${pid} /F /T 2>nul`, { windowsHide: true });
            } catch (_) {}
          }
        }
        await new Promise(r => setTimeout(r, 1000));
        const stillInUse = await isPortInUse(parseInt(port));
        if (stillInUse) {
          return { success: false, error: `Port ${port} is in use by another application` };
        }
      } catch (_) {
        // netstat found nothing — port may have freed itself between check and netstat
        await new Promise(r => setTimeout(r, 1000));
        const stillInUse = await isPortInUse(parseInt(port));
        if (stillInUse) {
          return { success: false, error: `Port ${port} is in use but could not be freed` };
        }
      }
    } else {
      return { success: false, error: `Port ${port} is already in use` };
    }
  }

  // Ensure backend dependencies exist. The portable exe ships with a bundled
  // node_modules (see extraResources in package.json), but if it's missing
  // (dev run, older build, or manual copy) install it on the fly so the
  // server can always start instead of failing with "ENOENT resolving package".
  if (!fs.existsSync(path.join(BACKEND_DIR, 'node_modules'))) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('install-progress', {
        component: 'backend',
        stage: 'install',
        message: 'Installing backend dependencies (first run)...',
      });
    }
    const bunCmd = resolveBunPath() || 'bun';
    let installLog = '';
    const depsOk = await new Promise((resolve) => {
      const proc = spawn(bunCmd, ['install'], {
        cwd: BACKEND_DIR,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      proc.stdout.on('data', (d) => { installLog += d.toString(); });
      proc.stderr.on('data', (d) => { installLog += d.toString(); });
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
    });
    if (!depsOk || !fs.existsSync(path.join(BACKEND_DIR, 'node_modules'))) {
      const tail = installLog.split('\n').filter(Boolean).slice(-4).join('; ');
      return {
        success: false,
        error: 'Backend dependencies could not be installed' +
          (tail ? ': ' + tail : '. Check that Bun is installed correctly, then try again.'),
      };
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('install-progress', {
        component: 'backend',
        stage: 'done',
        message: 'Backend dependencies ready',
      });
    }
  }

  const env = {
    ...process.env,
    PORT: String(port),
    HTTPS: useHttps ? 'true' : 'false',
    NODE_ENV: 'production',
    // Stable data locations — see the DATA_DIR note above
    DATA_DIR,
    GENERATED_IMAGES_DIR,
  };

  // Add SSL cert paths if using HTTPS
  if (useHttps) {
    env.SSL_CERT = path.join(CERTS_DIR, 'localhost.crt');
    env.SSL_KEY = path.join(CERTS_DIR, 'localhost.key');
  }

  return new Promise((resolve) => {
    try {
      const bunCmd = resolveBunPath() || 'bun';
      serverProcess = spawn(bunCmd, ['run', 'src/index.ts'], {
        cwd: BACKEND_DIR,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: false,
        shell: true,
      });

      let startupLog = '';

      serverProcess.stdout.on('data', (data) => {
        const text = data.toString();
        startupLog += text;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('server-log', text);
        }
      });

      serverProcess.stderr.on('data', (data) => {
        const text = data.toString();
        startupLog += text;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('server-log', text);
        }
      });

      serverProcess.on('error', (err) => {
        serverProcess = null;
        resolve({ success: false, error: err.message });
      });

      serverProcess.on('exit', (code) => {
        console.log(`[server] Process exited with code ${code}`);
        serverProcess = null;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('server-status', { running: false, code });
        }
      });

      // Wait a bit and check if it's still running
      setTimeout(() => {
        if (serverProcess && serverProcess.exitCode === null) {
          serverMode = { https: useHttps, port: parseInt(port, 10) || 3001 };
          resolve({ success: true, port, https: useHttps });
        } else {
          // Extract a meaningful error from the startup log
          let errorMsg = 'Server failed to start';
          if (startupLog) {
            const lines = startupLog.split('\n').filter(l => l.trim());
            const lastLines = lines.slice(-3).join('; ');
            if (lastLines) errorMsg += ': ' + lastLines;
          }
          resolve({ success: false, error: errorMsg, log: startupLog });
        }
      }, 2000);
    } catch (err) {
      resolve({ success: false, error: err.message });
    }
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!serverProcess) {
      resolve({ success: false, error: 'Server not running' });
      return;
    }

    // On Windows with shell:true, serverProcess.pid is cmd.exe, not bun.
    // We need /T to kill the entire process tree (cmd.exe AND bun.exe).
    if (os.platform() === 'win32') {
      try {
        execSync(`taskkill /PID ${serverProcess.pid} /F /T 2>nul`, { windowsHide: true });
      } catch (_) { /* already dead */ }
    } else {
      try { serverProcess.kill('SIGTERM'); } catch (_) {}
    }

    serverProcess = null;

    // The renderer gets the stop result from the IPC invoke return value,
    // and the dashboard poll confirms eventually. No need to push a redundant event.

    resolve({ success: true });
  });
}

function getServerStatus() {
  return {
    running: serverProcess !== null && serverProcess.exitCode === null,
    pid: serverProcess ? serverProcess.pid : null,
  };
}

// ─── IPC Handlers ────────────────────────────────────────────────
function setupIPC() {
  // Server control
  ipcMain.handle('server-start', async (_event, httpMode) => {
    return await startServer(httpMode);
  });

  ipcMain.handle('server-stop', async () => {
    return await stopServer();
  });

  ipcMain.handle('server-status', () => {
    return getServerStatus();
  });

  ipcMain.handle('server-is-port-open', async (_event, port) => {
    return !(await isPortInUse(port));
  });

  // System stats
  ipcMain.handle('get-stats', () => {
    return getSystemStats();
  });

  ipcMain.handle('get-ips', () => {
    return getLocalIPs();
  });

  // Ollama
  ipcMain.handle('get-ollama-models', async () => {
    const models = await getRunningModels();
    return models;
  });

  ipcMain.handle('check-ollama', async () => {
    try {
      const http = require('http');
      return new Promise((resolve) => {
        const req = http.get('http://localhost:11434/api/tags', (res) => {
          resolve({ available: res.statusCode >= 200 && res.statusCode < 400 });
        });
        req.on('error', () => resolve({ available: false }));
        req.setTimeout(2000, () => { req.destroy(); resolve({ available: false }); });
      });
    } catch { return { available: false }; }
  });

  // Window control
  ipcMain.handle('minimize-window', () => {
    minimizeWindow();
  });

  // ─── Download Manager ────────────────────────────
  /** Download a file from GitHub to the release directory */
  ipcMain.handle('download-release', async (_event, assetName) => {
    try {
      // Fetch latest release info from GitHub
      const https = require('https');
      const releaseInfo = await new Promise((resolve, reject) => {
        const req = https.get(GITHUB_API, {
          headers: { 'User-Agent': 'Kasalix-Server/1.0', 'Accept': 'application/vnd.github.v3+json' },
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => data += chunk);
          res.on('end', () => {
            try { resolve(JSON.parse(data)); }
            catch { reject(new Error('Failed to parse release data')); }
          });
        });
        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
      });

      // Find the matching asset
      const asset = (releaseInfo.assets || []).find(a => a.name === assetName);
      if (!asset) {
        return { success: false, error: `Asset "${assetName}" not found in latest release` };
      }

      // Ensure release directory exists
      if (!fs.existsSync(RELEASE_DIR)) {
        fs.mkdirSync(RELEASE_DIR, { recursive: true });
      }

      const destPath = path.join(RELEASE_DIR, assetName);
      const totalBytes = asset.size;
      let downloadedBytes = 0;

      // Download the file
      return await new Promise((resolve) => {
        const req = https.get(asset.browser_download_url, {
          headers: { 'User-Agent': 'Kasalix-Server/1.0' },
        }, (res) => {
          const fileStream = fs.createWriteStream(destPath);
          res.on('data', (chunk) => {
            downloadedBytes += chunk.length;
            const percent = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
            // Send progress to renderer
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('download-progress', {
                asset: assetName,
                percent,
                downloaded: downloadedBytes,
                total: totalBytes,
              });
            }
          });
          res.pipe(fileStream);
          fileStream.on('finish', () => {
            fileStream.close();

            // Download blockmap if it exists
            const blockmapAsset = releaseInfo.assets.find(a => a.name === `${assetName}.blockmap`);
            if (blockmapAsset) {
              const bmPath = path.join(RELEASE_DIR, `${assetName}.blockmap`);
              https.get(blockmapAsset.browser_download_url, { headers: { 'User-Agent': 'Kasalix-Server/1.0' } }, (bmRes) => {
                const bmStream = fs.createWriteStream(bmPath);
                bmRes.pipe(bmStream);
                bmStream.on('finish', () => bmStream.close());
              });
            }

            // Generate latest.yml for auto-updater
            const version = (releaseInfo.tag_name || '').replace(/^v/i, '');
            const ymlContent = [
              'version: ' + version,
              'files:',
              '  - url: ' + assetName,
              '    sha512: null',
              '    size: ' + totalBytes,
              'path: ' + assetName,
              'sha512: null',
              'releaseDate: ' + (releaseInfo.published_at || new Date().toISOString()),
            ].join('\n') + '\n';
            try {
              fs.writeFileSync(path.join(RELEASE_DIR, 'latest.yml'), ymlContent, 'utf-8');
            } catch { /* yml is optional for auto-updater */ }

            resolve({ success: true, path: destPath, size: totalBytes, version: releaseInfo.tag_name });
          });
          fileStream.on('error', (err) => {
            resolve({ success: false, error: err.message });
          });
        });
        req.on('error', (err) => resolve({ success: false, error: err.message }));
        req.setTimeout(300000, () => { req.destroy(); resolve({ success: false, error: 'Download timed out' }); });
      });
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  /** Get list of files in the release directory */
  ipcMain.handle('get-release-files', () => {
    try {
      if (!fs.existsSync(RELEASE_DIR)) return { files: [] };
      const entries = fs.readdirSync(RELEASE_DIR, { withFileTypes: true });
      const files = entries
        .filter(e => e.isFile())
        .map(e => {
          const stat = fs.statSync(path.join(RELEASE_DIR, e.name));
          return { name: e.name, size: stat.size, modified: stat.mtimeMs };
        })
        .sort((a, b) => b.modified - a.modified);
      return { files };
    } catch (err) {
      return { files: [], error: err.message };
    }
  });

  /** Get the latest GitHub release version */
  ipcMain.handle('check-github-release', async () => {
    try {
      const https = require('https');
      return await new Promise((resolve) => {
        const req = https.get(GITHUB_API, {
          headers: { 'User-Agent': 'Kasalix-Server/1.0', 'Accept': 'application/vnd.github.v3+json' },
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => data += chunk);
          res.on('end', () => {
            try {
              const r = JSON.parse(data);
              resolve({
                version: r.tag_name,
                name: r.name,
                assets: (r.assets || []).map(a => ({ name: a.name, size: a.size })),
                publishedAt: r.published_at,
              });
            } catch { resolve(null); }
          });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(10000, () => { req.destroy(); resolve(null); });
      });
    } catch { return null; }
  });

  // App info
  ipcMain.handle('get-app-info', () => {
    return {
      version: app.getVersion(),
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
      uptime: os.uptime(),
    };
  });

  // ─── Icon Picker ────────────────────────────────
  ipcMain.handle('pick-icon', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose Server Icon',
      filters: [
        { name: 'Icons', extensions: ['ico', 'png'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths.length) {
      return { success: false };
    }
    const iconPath = result.filePaths[0];
    // Apply immediately
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.setIcon(iconPath); } catch {}
    }
    return { success: true, path: iconPath };
  });

  // ─── GUI Settings Persistence ────────────────────
  const SETTINGS_FILE = path.join(app.getPath('userData'), 'gui-settings.json');

  ipcMain.handle('save-gui-settings', async (_event, settings) => {
    try {
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('load-gui-settings', async () => {
    try {
      const data = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      return JSON.parse(data);
    } catch {
      return null; // No saved settings yet
    }
  });

  // ─── Settings Password ──────────────────────────
  /** Send a request to the local backend. Tries both HTTP and HTTPS so auth
   *  works whether the server-gui started the backend or it was started
   *  externally (run-server.bat / start.bat). */
  function backendRequest(apiPath, { method = 'GET', body = null, headers = {}, timeout = 5000 } = {}) {
    return new Promise((resolve) => {
      const payload = body ? JSON.stringify(body) : null;
      const reqHeaders = { ...headers };
      if (payload) {
        reqHeaders['Content-Type'] = 'application/json';
        reqHeaders['Content-Length'] = Buffer.byteLength(payload);
      }
      const port = serverMode.port || 3001;
      // Try the currently tracked protocol first, then fall back to the other
      // if the connection fails (stale mode or externally-started backend).
      const protocols = serverMode.https ? ['https', 'http'] : ['http', 'https'];

      const attempt = (idx) => {
        if (idx >= protocols.length) {
          resolve({ error: 'Server not running' });
          return;
        }
        const protocol = protocols[idx];
        const transport = protocol === 'https' ? require('https') : require('http');
        const req = transport.request(`${protocol}://localhost:${port}${apiPath}`, {
          method,
          headers: reqHeaders,
          // Self-signed localhost certs must be accepted for HTTPS mode
          rejectUnauthorized: false,
          // 0 = no timeout (long-running requests like the speed test suite)
          timeout: timeout || 0,
        }, (res) => {
          let body = '';
          res.on('data', (chunk) => body += chunk);
          res.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch { attempt(idx + 1); } // Non-JSON (e.g. wrong-protocol error page) — try the other protocol
          });
        });
        req.on('error', () => attempt(idx + 1));
        req.on('timeout', () => { req.destroy(); attempt(idx + 1); });
        if (payload) req.write(payload);
        req.end();
      };

      attempt(0);
    });
  }

  /** Authenticate with the settings password */
  ipcMain.handle('auth-settings', async (_event, password) => {
    try {
      return await backendRequest('/api/settings/auth', { method: 'POST', body: { password } });
    } catch { return { error: 'Failed to authenticate' }; }
  });

  /** Change the settings password */
  ipcMain.handle('change-settings-password', async (_event, currentPassword, newPassword) => {
    try {
      return await backendRequest('/api/settings/password', {
        method: 'POST',
        body: { currentPassword, newPassword },
        headers: { 'Cookie': 'settings_auth=1' },
      });
    } catch { return { error: 'Failed to change password' }; }
  });

  /** Reset the settings password back to the default (letmein) */
  ipcMain.handle('reset-settings-password', async () => {
    try {
      const pwDir = DATA_DIR;
      fs.mkdirSync(pwDir, { recursive: true });
      fs.writeFileSync(path.join(pwDir, 'settings_password.txt'), 'letmein', 'utf-8');
      return { success: true, message: 'Password reset to: letmein' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  /** Get registered users */
  ipcMain.handle('get-users', async () => {
    try {
      const result = await backendRequest('/api/auth/users', {
        headers: { 'Cookie': 'settings_auth=1' },
      });
      if (result && Array.isArray(result.users)) return result;
      return { users: [] };
    } catch { return { users: [] }; }
  });

  // ─── Model Settings ────────────────────────────────
  /** Get all installed Ollama models (backend /api/models) */
  ipcMain.handle('get-installed-models', async () => {
    try {
      return await backendRequest('/api/models');
    } catch { return { models: [] }; }
  });

  /** Get the current app settings (model assignments, hidden models) */
  ipcMain.handle('get-settings', async () => {
    try {
      return await backendRequest('/api/settings');
    } catch { return null; }
  });

  /** Save model assignments (admin only) */
  ipcMain.handle('save-settings', async (_event, payload) => {
    try {
      return await backendRequest('/api/settings', {
        method: 'PUT',
        body: payload,
        headers: { 'Cookie': 'settings_auth=1' },
      });
    } catch { return { error: 'Failed to save settings' }; }
  });

  // ─── Bun / Ollama Install ──────────────────────────
  /** Check whether the Bun runtime is installed */
  ipcMain.handle('check-bun', async () => {
    return { installed: resolveBunPath() !== null };
  });

  /** Install Bun silently using the official installer script */
  ipcMain.handle('install-bun', async () => {
    return new Promise((resolve) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('install-progress', { component: 'bun', stage: 'download', message: 'Downloading Bun installer...' });
      }
      // Official Bun Windows installer: irm bun.sh/install.ps1 | iex
      // Use spawn with an arg array so the pipe is passed literally to
      // PowerShell (no fragile cmd.exe nested-quote handling).
      const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm bun.sh/install.ps1 | iex'], {
        windowsHide: true,
        shell: false,
        timeout: 600000,
      });
      let stderr = '';
      ps.stderr.on('data', (d) => { stderr += d.toString(); });
      ps.on('error', (err) => {
        resolve({ success: false, installed: false, error: err.message });
      });
      ps.on('close', () => {
        const installed = resolveBunPath() !== null;
        resolve({
          success: installed,
          installed,
          error: installed ? undefined : (stderr.trim() || 'Bun install finished but bun.exe was not found.'),
        });
      });
    });
  });

  /** Download and silently install Ollama using its official Windows installer */
  ipcMain.handle('install-ollama', async () => {
    const https = require('https');
    const url = 'https://ollama.com/download/OllamaSetup.exe';
    const dest = path.join(app.getPath('temp'), 'OllamaSetup.exe');
    const MAX_REDIRECTS = 10;

    // Download a URL, following HTTP redirects. The public download URL
    // 307s to github.com/ollama/ollama, which then 302s to a CDN — and
    // Node's https.get does NOT follow redirects on its own, which made
    // the install fail instantly with "HTTP 307".
    function download(urlToFetch, redirectsLeft) {
      return new Promise((resolve, reject) => {
        let redirected = false;
        let req = null;
        let stallTimer = null;

        // A 1.5 GB file over a slow connection can stall mid-download.
        // Abort if no data arrives for 60s instead of hanging forever.
        const armStallTimer = () => {
          clearTimeout(stallTimer);
          stallTimer = setTimeout(() => {
            if (req) req.destroy(new Error('Download stalled (no data for 60s)'));
          }, 60000);
        };

        req = https.get(urlToFetch, { headers: { 'User-Agent': 'Kasalix-Server/1.0' } }, (res) => {
          // Response received (or redirected) — reset the timer; data chunks re-arm it
          armStallTimer();
          // Redirect — follow it (up to MAX_REDIRECTS hops)
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume(); // drain the old response
            clearTimeout(stallTimer);
            if (redirectsLeft <= 0) {
              reject(new Error('Too many redirects downloading Ollama'));
              return;
            }
            redirected = true; // ignore late errors from the drained request
            const next = new URL(res.headers.location, urlToFetch).toString();
            download(next, redirectsLeft - 1).then(resolve, reject);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            clearTimeout(stallTimer);
            reject(new Error('Download failed (HTTP ' + res.statusCode + ')'));
            return;
          }
          const file = fs.createWriteStream(dest);
          let received = 0;
          const size = parseInt(res.headers['content-length'] || '0', 10) || 0;
          res.on('data', (chunk) => {
            armStallTimer(); // any data = still alive
            received += chunk.length;
            if (mainWindow && !mainWindow.isDestroyed()) {
              const percent = size ? Math.round((received / size) * 100) : 0;
              const mb = Math.round(received / 1048576);
              const totalMb = size ? ' / ' + Math.round(size / 1048576) + ' MB' : '';
              mainWindow.webContents.send('install-progress', {
                component: 'ollama',
                stage: 'download',
                message: 'Downloading Ollama... ' + percent + '% (' + mb + ' MB' + totalMb + ')',
                percent,
              });
            }
          });
          res.pipe(file);
          file.on('finish', () => { clearTimeout(stallTimer); file.close(); resolve(); });
          file.on('error', (err) => { clearTimeout(stallTimer); reject(err); });
        });
        // Also arm the timer now so a hang during DNS/TCP/TLS connect (before
        // any response callback fires) gets aborted too.
        armStallTimer();
        req.on('error', (err) => {
          clearTimeout(stallTimer);
          if (!redirected) reject(err);
        });
      });
    }

    try {
      await download(url, MAX_REDIRECTS);

      // Install silently (Inno Setup flags; per-user install, no admin needed)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('install-progress', { component: 'ollama', stage: 'install', message: 'Installing Ollama...' });
      }
      await new Promise((resolve, reject) => {
        exec(`"${dest}" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART`, { timeout: 600000, windowsHide: true }, (err) => {
          if (err) reject(err); else resolve();
        });
      });

      // Cleanup the installer file
      try { fs.unlinkSync(dest); } catch {}
      return { success: true, installed: true };
    } catch (err) {
      try { fs.unlinkSync(dest); } catch {}
      return { success: false, error: err.message };
    }
  });

  // ─── Speed Test ─────────────────────────────────────
  /** Run the full speed test suite (admin only) — can take several minutes */
  ipcMain.handle('speedtest-run', async () => {
    try {
      return await backendRequest('/api/speedtest/run', {
        method: 'POST',
        body: {},
        headers: { 'Cookie': 'settings_auth=1' },
        timeout: 0, // no timeout — suite may take minutes
      });
    } catch { return { error: 'Speed test failed' }; }
  });

  /** Get past speed test results (admin only) */
  ipcMain.handle('speedtest-results', async () => {
    try {
      return await backendRequest('/api/speedtest/results', {
        headers: { 'Cookie': 'settings_auth=1' },
      });
    } catch { return { results: [] }; }
  });

  /** Delete a speed test result (admin only) */
  ipcMain.handle('speedtest-delete', async (_event, id) => {
    try {
      return await backendRequest(`/api/speedtest/results/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { 'Cookie': 'settings_auth=1' },
      });
    } catch { return { success: false }; }
  });
}

// ─── Window Creation ─────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 700,
    minHeight: 600,
    title: 'Kasalix AI Chat Server',
    backgroundColor: '#030712',
    resizable: true,
    autoHideMenuBar: true,
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'icon.png')
      : path.join(__dirname, '..', 'icon_server.png'), // Root icon_server.png, updated after loading saved settings
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));

  // Apply saved icon after window is ready
  try {
    const settingsPath = path.join(app.getPath('userData'), 'gui-settings.json');
    const savedData = fs.readFileSync(settingsPath, 'utf-8');
    const saved = JSON.parse(savedData);
    if (saved.iconPath && fs.existsSync(saved.iconPath)) {
      mainWindow.setIcon(saved.iconPath);
    }
  } catch {}

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Start polling stats every 2 seconds
  if (statsInterval) clearInterval(statsInterval);
  statsInterval = setInterval(async () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const stats = getSystemStats();
      const ips = getLocalIPs();
      const serverStatus = getServerStatus();

      // Refresh GPU info asynchronously (non-blocking, cached for next poll)
      getGpuInfo(() => {});

      let models = [];
      if (serverStatus.running) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 3000);
          models = await getRunningModels();
          clearTimeout(timeout);
        } catch { models = []; }
      }

      // Check if Bun is available (first time only)
      if (!global._bunChecked) {
        global._bunChecked = true;
        if (!resolveBunPath() && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('bun-not-found');
        }
      }

      mainWindow.webContents.send('dashboard-update', { stats, ips, serverStatus, models });
    }
  }, 2000);
}

function minimizeWindow() {
  if (mainWindow) mainWindow.minimize();
}

// ─── App Lifecycle ───────────────────────────────────────────────
app.whenReady().then(() => {
  setupIPC();
  createWindow();
});

app.on('window-all-closed', () => {
  if (statsInterval) clearInterval(statsInterval);
  if (serverProcess) stopServer();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  if (statsInterval) clearInterval(statsInterval);
  if (serverProcess) stopServer();
});
