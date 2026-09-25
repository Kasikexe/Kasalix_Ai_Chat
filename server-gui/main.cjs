const { app, BrowserWindow, ipcMain, shell } = require('electron');
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
// Release downloads (update installers, manual EXE/APK downloads) must live in
// the STABLE data root, not resourcesPath: a portable exe extracts resources
// to a random temp dir that Windows wipes on close — installers saved there
// vanish between runs and the updater "forgets" them.
const RELEASE_DIR = path.join(APP_DATA_ROOT, 'release');

// ─── Ollama concurrency settings (read from the backend's settings.json) ──
// Read straight from disk instead of waiting for the backend HTTP API, so the
// env vars are known even when Ollama auto-starts before the backend is up.
// Same clamp/validate rules as the backend's coerce helpers.
function readOllamaTuning() {
  try {
    const settingsPath = path.join(DATA_DIR, 'settings.json');
    if (!fs.existsSync(settingsPath)) return {};
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const clamp = (v) => {
      const n = parseInt(v, 10);
      return Number.isFinite(n) && n > 0 ? Math.min(n, 16) : 0;
    };
    const ka = String(raw.ollamaKeepAlive || '').trim();
    const kv = String(raw.kvCacheType || '').trim();
    return {
      numParallel: clamp(raw.ollamaNumParallel),
      maxLoadedModels: clamp(raw.ollamaMaxLoadedModels),
      keepAlive: /^-?\d+(\.\d+)?(ms|s|m|h)?$/.test(ka) ? ka : '',
      kvCacheType: /^(f16|f32|q8_0|q4_0)$/.test(kv) ? kv : 'f16',
      kvCacheOffload: raw.kvCacheOffload !== false,
    };
  } catch { return {}; }
}

function buildOllamaEnv() {
  // Mirrors the backend's _build_ollama_env: the GUI spawns Ollama before
  // the backend may exist (auto-start), so the FULL tuning must come from
  // here — dropping the KV settings silently reverted cache quantization.
  const t = readOllamaTuning();
  const env = {};
  if (t.numParallel) env.OLLAMA_NUM_PARALLEL = String(t.numParallel);
  if (t.maxLoadedModels) env.OLLAMA_MAX_LOADED_MODELS = String(t.maxLoadedModels);
  if (t.keepAlive) env.OLLAMA_KEEP_ALIVE = t.keepAlive;
  if (t.kvCacheType) {
    if (t.kvCacheType === 'f32') {
      // f32 = explicit full-precision override, nothing to set
    } else {
      env.LLAMA_ARG_CACHE_TYPE_K = t.kvCacheType;
      env.LLAMA_ARG_CACHE_TYPE_V = t.kvCacheType;
      if (t.kvCacheType !== 'f16') env.OLLAMA_FLASH_ATTENTION = '1';
    }
  }
  if (t.kvCacheOffload === false) env.LLAMA_ARG_KV_OFFLOAD = '0';
  return env;
}
// ─── Branding / upstream repo ────────────────────────────────────
// Where release downloads come from. Override with the KASALIX_REPO
// env var ("owner/name") when running a rebranded fork.
const GITHUB_REPO = process.env.KASALIX_REPO || 'Kasikexe/Kasalix';
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

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
        // Skip link-local (APIPA 169.254.x.x) — unusable for sharing
        !iface.address.startsWith('169.254.') &&
        !name.toLowerCase().includes('docker') &&
        !name.toLowerCase().includes('virtual') &&
        !name.toLowerCase().includes('vmware') &&
        !name.toLowerCase().includes('vbox')
      ) {
        ips.push({ address: iface.address, netmask: iface.netmask, interface: friendlyInterfaceName(name) });
      }
    }
  }
  return ips;
}

// Human-friendly interface label: the raw adapter names ("Ethernet 2",
// "Wi-Fi 3") don't tell the user which IP to share. Tailscale/VPN are
// especially confusing — they only work for devices on that VPN.
function friendlyInterfaceName(name) {
  const lower = (name || '').toLowerCase();
  if (lower.includes('tailscale')) return 'Tailscale VPN';
  if (lower.includes('zerotier')) return 'ZeroTier VPN';
  if (lower.includes('wireguard')) return 'WireGuard VPN';
  if (lower.includes('openvpn') || lower.includes('tun') || lower.includes('tap')) return 'VPN';
  if (lower.includes('wi-fi') || lower.includes('wifi') || lower.includes('wlan')) return 'Wi-Fi';
  if (lower.includes('ethernet') || lower.includes('eth')) return 'Ethernet';
  if (lower.includes('bluetooth')) return 'Bluetooth';
  if (lower.includes('loopback')) return 'Loopback';
  return name;
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

// True after backendRequest has confirmed the running backend's protocol
let _modeSynced = false;

// ─── GPU Measurement (async, non-blocking, multi-vendor) ─────────
// NVIDIA: nvidia-smi. AMD: rocm-smi (ROCm) or WMI fallback (name + VRAM only,
// no live utilization). Result is cached and refreshed by the poller.
let _lastGpuInfo = null;

function parseNvidiaSmi(stdout, callback) {
  const parts = stdout.trim().split(', ');
  const info = {
    gpuUtil: parseFloat(parts[0]) || 0,
    memUsed: parseInt(parts[1]) || 0,
    memTotal: parseInt(parts[2]) || 0,
    name: parts[3] || 'Unknown',
    driverVersion: parts[4] || '',
    vendor: 'nvidia',
  };
  _lastGpuInfo = info;
  callback(info);
}

function queryNvidia(callback) {
  exec(
    'nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,name,driver_version --format=csv,noheader,nounits',
    { encoding: 'utf-8', timeout: 2000, windowsHide: true },
    (error, stdout) => {
      if (error || !stdout) { callback(null); return; }
      parseNvidiaSmi(stdout, callback);
    }
  );
}

function queryAmd(callback) {
  // rocm-smi: utilization + used VRAM (MiB)
  exec(
    'rocm-smi --showuse --showmemuse vram --json',
    { encoding: 'utf-8', timeout: 2000, windowsHide: true },
    (err, stdout) => {
      if (!err && stdout) {
        try {
          const j = JSON.parse(stdout);
          const cardKey = Object.keys(j).find((k) => k !== '0' && typeof j[k] === 'object');
          const card = j[cardKey] || j['0'];
          if (card) {
            const utilRaw = (card['GPU use (%)'] ?? card['gpuUse_percent'] ?? '0').toString().replace('%', '');
            const usedRaw = (card['VRAM Total Used (B)'] ?? card['vramTotalUsed_bytes'] ?? '0').toString();
            const totalRaw = (card['VRAM Total Allocated (B)'] ?? card['vramTotalAllocated_bytes'] ?? '0').toString();
            const info = {
              gpuUtil: parseFloat(utilRaw) || 0,
              memUsed: Math.round(parseInt(usedRaw) / (1024 * 1024)) || 0,
              memTotal: Math.round(parseInt(totalRaw) / (1024 * 1024)) || 0,
              name: 'AMD GPU',
              driverVersion: '',
              vendor: 'amd',
            };
            _lastGpuInfo = info;
            callback(info);
            return;
          }
        } catch { /* fall through to WMI */ }
      }
      queryAmdWmi(callback);
    }
  );
}

function queryAmdWmi(callback) {
  // Fallback: identify the AMD card via WMI + registry (name + VRAM only —
  // no live utilization available without ROCm tooling).
  //
  // WMI's AdapterRAM is a 32-bit field that caps at 4 GB, so real VRAM comes
  // from the display-driver registry key's HardwareInformation.qwMemorySize
  // (a QWORD with the true value — 16 GB cards report 16 GB there).
  exec(
    'powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json -Compress"',
    { encoding: 'utf-8', timeout: 4000, windowsHide: true },
    (err, stdout) => {
      if (err || !stdout) { _lastGpuInfo = null; callback(null); return; }
      // Also pull true VRAM from the registry (runs in parallel with parsing).
      exec(
        'powershell -NoProfile -Command "Get-ItemProperty \'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*\' -ErrorAction SilentlyContinue | Select-Object DriverDesc, \'' +
        'HardwareInformation.qwMemorySize' + '\' | ConvertTo-Json -Compress"',
        { encoding: 'utf-8', timeout: 4000, windowsHide: true },
        (regErr, regStdout) => {
          let vramByName = {};
          if (!regErr && regStdout) {
            try {
              const entries = JSON.parse(regStdout);
              for (const e of (Array.isArray(entries) ? entries : [entries])) {
                if (e && e.DriverDesc && e['HardwareInformation.qwMemorySize']) {
                  vramByName[e.DriverDesc] = Number(e['HardwareInformation.qwMemorySize']);
                }
              }
            } catch {}
          }
          try {
            const cards = JSON.parse(stdout);
            const list = Array.isArray(cards) ? cards : [cards];
            // Prefer a dedicated GPU: filter out basic-display/virtual adapters and
            // integrated graphics ("Radeon(TM) Graphics" / Intel UHD/Iris are iGPU names).
            const isIntegrated = (name) => /radeon\(tm\) graphics|uhd graphics|iris|vega\(tm\) graphics|graphics$|basic|virtual|remote/i.test(name || '');
            const dedicated = list
              .filter((c) => c && c.Name && !isIntegrated(c.Name))
              .sort((a, b) => (b.AdapterRAM || 0) - (a.AdapterRAM || 0));
            const gpu = dedicated[0] || list.filter((c) => c && c.Name && !/basic|virtual|remote/i.test(c.Name))[0];
            if (!gpu) { _lastGpuInfo = null; callback(null); return; }
            // True VRAM: registry QWORD first (exact), WMI AdapterRAM as fallback
            // (32-bit — caps at 4 GB).
            const regBytes = vramByName[gpu.Name] || 0;
            const memTotal = regBytes > 0
              ? Math.round(regBytes / (1024 * 1024))
              : Math.round((gpu.AdapterRAM || 0) / (1024 * 1024));
            const info = {
              gpuUtil: 0,
              memUsed: 0,
              memTotal,
              name: gpu.Name,
              driverVersion: gpu.DriverVersion || '',
              vendor: /amd|radeon/i.test(gpu.Name) ? 'amd' : 'unknown',
              estimateOnly: true,
            };
            _lastGpuInfo = info;
            callback(info);
          } catch { _lastGpuInfo = null; callback(null); }
        }
      );
    }
  );
}

function getGpuInfo(callback) {
  queryNvidia((nvidia) => {
    if (nvidia) { callback(nvidia); return; }
    queryAmd((amd) => {
      callback(amd); // may be null — renderer hides the GPU card
    });
  });
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

// Resolve how to launch the backend. The backend is the self-contained
// Python exe (backend.exe — PyInstaller build). Returns { cmd, args, cwd }.
function resolveBackendCommand() {
  // 1. Packaged: backend/dist/backend/backend.exe next to the resources
  const candidates = [
    path.join(RESOURCES_DIR, 'backend', 'dist', 'backend', 'backend.exe'),
    path.join(RESOURCES_DIR, 'backend', 'backend.exe'),
    // Flat layout: exe dropped directly into the backend resources folder
    path.join(BACKEND_DIR, 'backend.exe'),
    // Stable app folder next to the exe (installer layout). Lets a rebuilt
    // backend.exe be dropped in without repackaging the whole app.
    path.join(APP_DATA_ROOT, 'backend', 'backend.exe'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      return { cmd: c, args: [], cwd: path.dirname(c) };
    }
  }
  // 2. Dev: an in-repo built exe (backend/dist/backend/backend.exe)
  const devPyExe = path.join(__dirname, '..', 'backend', 'dist', 'backend', 'backend.exe');
  if (fs.existsSync(devPyExe)) {
    return { cmd: devPyExe, args: [], cwd: path.dirname(devPyExe) };
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

  // Check if port is already in use (e.g. a zombie backend.exe from a previous stop)
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

  // The Python backend exe is self-contained — no dependency bootstrap needed.
  const backendCmd = resolveBackendCommand();
  if (!backendCmd) {
    return {
      success: false,
      error: 'Backend executable not found (backend.exe). ' +
        'Build it with server-app-installer/build-setup.bat or backend/build/build/backend.spec via PyInstaller.',
    };
  }

  // Windows Firewall: make sure the server port is reachable from other
  // devices. The installer adds this rule, but re-assert it here (idempotent,
  // best-effort) so a dev build or a rule deleted by the user doesn't cause
  // mysterious "device on my LAN can't connect" reports. On many systems the
  // default inbound policy already allows this — the netsh call just makes it
  // explicit. Failures are logged and ignored: the server runs fine locally
  // regardless.
  if (os.platform() === 'win32') {
    try {
      const exePath = backendCmd.cmd;
      exec(
        `netsh advfirewall firewall delete rule name="Kasalix AI Chat Server" & ` +
        `netsh advfirewall firewall add rule name="Kasalix AI Chat Server" dir=in action=allow program="${exePath}" protocol=TCP localport=${port} profile=any`,
        { windowsHide: true, timeout: 8000 },
        (err, _stdout, stderr) => {
          if (err) {
            console.log('[firewall] Could not update firewall rule (non-fatal):', (stderr || err.message).trim().slice(0, 200));
          } else {
            console.log('[firewall] Inbound rule ready for port', port);
          }
        }
      );
    } catch (e) {
      console.log('[firewall] Rule setup skipped:', e.message);
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
      // Launch the self-contained Python backend exe directly. No shell: the
      // install path contains spaces ("Kasalix AI Chat Server"), and shell:true
      // would wrap it in cmd.exe — which also stole the pid the Stop button
      // relies on (it killed cmd.exe instead of the server).
      serverProcess = spawn(backendCmd.cmd, backendCmd.args, {
        cwd: backendCmd.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });

      let startupLog = '';
      // Reset the one-time protocol-sync flag on each server start
      _modeSynced = false;

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

    // serverProcess is backend.exe itself (spawned with shell:false), so
    // serverProcess.pid IS the server. /T still tears down any children it
    // spawned (e.g. a python child of the PyInstaller exe) before killing it.
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

// ─── Self-update helpers ─────────────────────────────────────────
// Deterministic update: the app exits FIRST (before-quit stops the backend
// and releases every file lock), then a detached helper runs the silent
// installer. The installer itself relaunches the app on success
// (.onInstSuccess in setup.nsi), so nothing races the running exe.
function launchReleaseInstaller(installerPath) {
  const { spawn } = require('child_process');
  try {
    const bat = path.join(os.tmpdir(), 'kasalix-update-' + Date.now() + '.bat');
    // The installer requires admin, so run it via PowerShell's elevated
    // Start-Process (UAC prompt appears when the app itself is not
    // elevated; -Wait keeps the helper bat alive until install finishes).
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
    const child = spawn('cmd.exe', ['/d', '/c', bat], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch (e) {
    console.log('[update] Could not arm installer:', e.message);
    return;
  }
  // Quit so the installer can replace the running app files.
  setTimeout(() => {
    try { app.quit(); } catch {}
  }, 500);
}

/** Find a previously downloaded installer in the release directory.
 *  Returns { name, path } for the newest matching file, or null.
 *  Used by get-latest-release (banner "Install now" state) and install-release. */
function findReleaseInstaller() {
  try {
    if (!fs.existsSync(RELEASE_DIR)) return null;
    const installer = fs.readdirSync(RELEASE_DIR, { withFileTypes: true })
      .filter(e => e.isFile())
      .map(e => {
        try {
          const full = path.join(RELEASE_DIR, e.name);
          return { name: e.name, path: full, mtime: fs.statSync(full).mtimeMs };
        } catch { return null; }
      })
      .filter(f => f && /\.exe$/i.test(f.name) && !/\.blockmap$/i.test(f.name))
      .sort((a, b) => b.mtime - a.mtime)[0];
    return installer || null;
  } catch {
    return null;
  }
}

// ─── IPC Handlers ────────────────────────────────────────────────
function setupIPC() {
  // External links (GitHub feedback) → system browser
  ipcMain.handle('open-external', async (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
    }
  });

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
    // A pure liveness probe — deliberately does NOT write the ownership
    // flag. Ownership means "this app spawned Ollama (with its settings)";
    // the tray autostart instance must stay external so the backend's
    // auto-apply can restart it with the saved tuning.
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

  ipcMain.handle('start-ollama', async () => {
    const { spawn, execSync } = require('child_process');
    const path = require('path');
    const fs = require('fs');
    const isWin = process.platform === 'win32';
    const http = require('http');

    console.log('[start-ollama] Attempting to start Ollama...');

    async function isOllamaUp() {
      return new Promise(resolve => {
        const req = http.get('http://localhost:11434/api/tags', (res) => {
          resolve(res.statusCode >= 200 && res.statusCode < 400);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(2000, () => { req.destroy(); resolve(false); });
      });
    }

    // Already running?
    if (await isOllamaUp()) {
      console.log('[start-ollama] Ollama is already running');
      return { success: true };
    }

    // Find ollama executable
    let ollamaPath = null;

    if (isWin) {
      // 1. Try 'where ollama'
      try {
        const whereOut = execSync('where ollama 2>nul', { encoding: 'utf8', timeout: 5000 }).trim();
        const paths = whereOut.split(/\r?\n/).filter(Boolean);
        ollamaPath = paths.find(p => p.toLowerCase().includes('ollama.exe') && !p.toLowerCase().includes('ollama app')) || paths[0];
        console.log('[start-ollama] Found via where:', ollamaPath);
      } catch {}

      // 2. Check common install locations
      if (!ollamaPath) {
        const commonPaths = [
          path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'),
          path.join(process.env.PROGRAMFILES || '', 'Ollama', 'ollama.exe'),
          path.join(process.env['PROGRAMFILES(X86)'] || '', 'Ollama', 'ollama.exe'),
        ];
        for (const p of commonPaths) {
          try { if (fs.existsSync(p)) { ollamaPath = p; console.log('[start-ollama] Found at:', p); break; } } catch {}
        }
      }
    }

    // Use full path if found, otherwise fall back to shell
    const useShell = !ollamaPath;
    const cmd = ollamaPath || 'ollama';
    console.log('[start-ollama] Spawning:', cmd, 'serve', useShell ? '(via shell)' : '(direct)');

    return new Promise((resolve) => {
      try {
        const ollamaEnv = buildOllamaEnv();
        if (Object.keys(ollamaEnv).length) {
          console.log('[start-ollama] Tuning env:', JSON.stringify(ollamaEnv));
        }
        const child = spawn(cmd, ['serve'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ...ollamaEnv },
          ...(useShell ? { shell: true } : { windowsHide: true }),
        });

        let settled = false;
        const settle = (result) => {
          if (settled) return;
          settled = true;
          try { child.unref(); } catch {}
          resolve(result);
        };

        child.on('error', (err) => {
          console.log('[start-ollama] Spawn error:', err.message);
          settle({ success: false, error: err.message });
        });

        child.on('exit', (code) => {
          console.log('[start-ollama] Process exited with code:', code);
          settle({ success: false, error: 'Ollama exited immediately (code ' + code + ')' });
        });

        // Capture stderr for debugging
        let stderr = '';
        if (child.stderr) {
          child.stderr.on('data', (d) => { stderr += d.toString(); });
        }

        // Poll for Ollama to come up
        (async () => {
          for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 1000));
            if (await isOllamaUp()) {
              console.log('[start-ollama] Ollama is up after', i + 1, 'seconds');
              settle({ success: true });
              // Write ownership flag for backend to detect — JSON with the
              // tuning env so a fresh backend can report the ACTIVE tuning
              // in /api/ollama/status (an env-less "owned" flag made the
              // GUI show Auto defaults after any restart).
              try {
                const flagPath = require('path').join(require('os').tmpdir(), 'kasalix-ollama-owned');
                const flagDir = require('path').dirname(flagPath);
                if (!fs.existsSync(flagDir)) fs.mkdirSync(flagDir, { recursive: true });
                fs.writeFileSync(flagPath, JSON.stringify({ pid: child.pid, env: ollamaEnv }));
              } catch {}
              return;
            }
          }
          console.log('[start-ollama] Timed out. stderr:', stderr.slice(-500));
          settle({ success: false, error: 'Ollama started but not responding after 20s' + (stderr ? ': ' + stderr.slice(-200) : '') });
        })();
      } catch (e) {
        console.log('[start-ollama] Exception:', e.message);
        resolve({ success: false, error: e.message });
      }
    });
  });

  // ─── Ollama Settings / Restart ────────────────────────
  ipcMain.handle('get-ollama-status', async () => {
    try {
      return await backendRequest('/api/ollama/status', {
        headers: { 'Cookie': 'settings_auth=1' },
      });
    } catch { return { running: false, ownedByUs: false, pid: null, loadedModels: [] }; }
  });

  ipcMain.handle('restart-ollama', async (_event, confirm) => {
    try {
      return await backendRequest('/api/ollama/restart', {
        method: 'POST',
        body: { confirm: !!confirm },
        headers: { 'Cookie': 'settings_auth=1' },
        timeout: 60000,
      });
    } catch { return { success: false, error: 'Failed to communicate with backend' }; }
  });

  ipcMain.handle('apply-ollama-settings', async (_event, payload) => {
    try {
      return await backendRequest('/api/ollama/apply', {
        method: 'POST',
        body: payload,
        headers: { 'Cookie': 'settings_auth=1' },
        timeout: 60000,
      });
    } catch { return { success: false, error: 'Failed to communicate with backend' }; }
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

            // Install is explicit: the renderer calls install-release after
            // the download completes (banner updater / download view).
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

  /** Run a previously downloaded installer (no re-download) */
  ipcMain.handle('install-release', async () => {
    const found = findReleaseInstaller();
    if (!found) {
      return { success: false, error: 'No downloaded installer found' };
    }
    launchReleaseInstaller(found.path);
    return { success: true, path: found.path, name: found.name };
  });

  /** Latest GitHub release + whether an installer is already downloaded */
  ipcMain.handle('get-latest-release', async () => {
    const https = require('https');
    const release = await new Promise((resolve) => {
      try {
        const req = https.get(GITHUB_API, {
          headers: { 'User-Agent': 'Kasalix-Server/1.0', 'Accept': 'application/vnd.github.v3+json' },
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => data += chunk);
          res.on('end', () => {
            try {
              const r = JSON.parse(data);
              resolve({
                version: (r.tag_name || '').replace(/^v/i, ''),
                name: r.name || '',
                assets: (r.assets || []).map(a => ({ name: a.name, size: a.size })),
                publishedAt: r.published_at,
              });
            } catch { resolve(null); }
          });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(10000, () => { req.destroy(); resolve(null); });
      } catch { resolve(null); }
    });
    const installer = findReleaseInstaller();
    return {
      release,
      downloadedInstaller: installer ? { name: installer.name, path: installer.path } : null,
    };
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
      // Try the currently tracked protocol first. We deliberately do NOT
      // probe the other protocol on request errors: an HTTPS handshake
      // against a plain-HTTP backend makes uvicorn log
      // "WARNING: Invalid HTTP request received" on every poll. Exception:
      // a one-time sync after startup (external start with a different
      // mode), which probes the other protocol at most once.
      const primary = serverMode.https ? 'https' : 'http';
      const secondary = serverMode.https ? 'http' : 'https';
      const protocols = _modeSynced ? [primary] : [primary, secondary];

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
            try {
              const parsed = JSON.parse(body);
              if (idx === 0) _modeSynced = true; // primary protocol confirmed
              resolve(parsed);
            }
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

  /** Per-category "where it's used" descriptions for the models view */
  ipcMain.handle('get-model-usage-map', async () => {
    try {
      return await backendRequest('/api/models/usage-map');
    } catch { return { usage: null }; }
  });

  /** Pull a model from Ollama registry */
  ipcMain.handle('pull-model', async (event, modelName) => {
    try {
      const http = require('http');
      return new Promise((resolve) => {
        const payload = JSON.stringify({ name: modelName, stream: true });
        const req = http.request('http://localhost:11434/api/pull', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
          timeout: 600000, // 10 min for large models
        }, (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
            // Send each line as a progress event to renderer
            const lines = chunk.toString().split('\n').filter(l => l.trim());
            for (const line of lines) {
              try {
                const progress = JSON.parse(line);
                event.sender.send('pull-progress', progress);
              } catch {}
            }
          });
          res.on('end', () => {
            // Send final status
            event.sender.send('pull-progress', { status: 'done' });
            resolve({ ok: true });
          });
        });
        req.on('error', (err) => {
          event.sender.send('pull-progress', { status: 'error', error: err.message });
          resolve({ error: err.message });
        });
        req.on('timeout', () => {
          req.destroy();
          event.sender.send('pull-progress', { status: 'error', error: 'Pull timed out (10 min limit)' });
          resolve({ error: 'Pull timed out (10 min limit)' });
        });
        req.write(payload);
        req.end();
      });
    } catch (err) { return { error: err.message }; }
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

  // ─── API Keys / Cloud Mode ──────────────────────────
  /** Save cloud mode and API key to backend settings */
  ipcMain.handle('save-api-key-settings', async (_event, payload) => {
    try {
      return await backendRequest('/api/settings', {
        method: 'PUT',
        body: payload,
        headers: { 'Cookie': 'settings_auth=1' },
      });
    } catch { return { error: 'Failed to save API key settings' }; }
  });

  /** Get cloud mode and API key from backend settings */
  ipcMain.handle('get-api-key-settings', async () => {
    try {
      return await backendRequest('/api/settings');
    } catch { return null; }
  });

  /**
   * Verify a cloud API key against the cloud endpoint. Nothing is saved — the
   * backend probes the remote provider, so allow well past the 5s default.
   */
  ipcMain.handle('test-cloud-key', async (_event, payload) => {
    try {
      return await backendRequest('/api/settings/test-cloud-key', {
        method: 'POST',
        body: payload || {},
        headers: { 'Cookie': 'settings_auth=1' },
        timeout: 30000,
      });
    } catch {
      return { ok: false, kind: 'endpoint', message: 'Local server did not respond' };
    }
  });

  /**
   * Verify a Tavily (web search) API key. Nothing is saved, and the probe is
   * the cheapest live Tavily search — the backend handles that trade-off.
   */
  ipcMain.handle('test-tavily-key', async (_event, payload) => {
    try {
      return await backendRequest('/api/settings/test-tavily-key', {
        method: 'POST',
        body: payload || {},
        headers: { 'Cookie': 'settings_auth=1' },
        timeout: 30000,
      });
    } catch {
      return { ok: false, kind: 'endpoint', message: 'Local server did not respond' };
    }
  });

  /** Fetch available cloud models from the configured cloud API endpoint */
  ipcMain.handle('fetch-cloud-models', async () => {
    try {
      return await backendRequest('/api/settings/cloud-models', {
        headers: { 'Cookie': 'settings_auth=1' },
      });
    } catch { return { models: [], error: 'Failed to fetch cloud models' }; }
  });

  // ─── Cloud Usage ────────────────────────────────────────
  /** Get current cloud usage stats */
  ipcMain.handle('cloud-usage-get', async () => {
    try {
      return await backendRequest('/api/cloud-usage', {
        headers: { 'Cookie': 'settings_auth=1' },
      });
    } catch { return null; }
  });

  /** Update cloud usage limits */
  ipcMain.handle('cloud-usage-set-limit', async (_event, payload) => {
    try {
      return await backendRequest('/api/cloud-usage/limit', {
        method: 'PUT',
        body: payload,
        headers: { 'Cookie': 'settings_auth=1' },
      });
    } catch { return { error: 'Failed to update limit' }; }
  });

  /** Reset cloud usage counters */
  ipcMain.handle('cloud-usage-reset', async () => {
    try {
      return await backendRequest('/api/cloud-usage/reset', {
        method: 'POST',
        headers: { 'Cookie': 'settings_auth=1' },
      });
    } catch { return { error: 'Failed to reset usage' }; }
  });

  // ─── Session Logs ────────────────────────────────────
  /** List all session logs */
  ipcMain.handle('session-logs-list', async () => {
    try {
      return await backendRequest('/api/session-logs', {
        headers: { 'Cookie': 'settings_auth=1' },
      });
    } catch { return { logs: [] }; }
  });

  /** Read a specific session log */
  ipcMain.handle('session-logs-read', async (_event, runId) => {
    try {
      return await backendRequest(`/api/session-logs/${encodeURIComponent(runId)}`, {
        headers: { 'Cookie': 'settings_auth=1' },
      });
    } catch { return { events: [] }; }
  });

  // ─── Plugins ────────────────────────────────────────
  /** List installed plugins (public read) */
  ipcMain.handle('plugins-list', async () => {
    try {
      return await backendRequest('/api/plugins');
    } catch { return { plugins: [] }; }
  });

  /** Fetch the curated plugin catalog (public read) */
  ipcMain.handle('plugins-catalog', async () => {
    try {
      return await backendRequest('/api/plugins/catalog');
    } catch { return { error: 'Failed to load plugin catalog' }; }
  });

  /** Install a plugin from a GitHub repo (admin only) */
  ipcMain.handle('plugins-install', async (_event, repo) => {
    try {
      return await backendRequest('/api/plugins/install', {
        method: 'POST',
        body: { repo },
        headers: { 'Cookie': 'settings_auth=1' },
        timeout: 60000, // downloading a repo can take a while
      });
    } catch { return { error: 'Failed to install plugin' }; }
  });

  /** Uninstall a plugin (admin only) */
  ipcMain.handle('plugins-uninstall', async (_event, id) => {
    try {
      return await backendRequest(`/api/plugins/${encodeURIComponent(id)}/uninstall`, {
        method: 'POST',
        headers: { 'Cookie': 'settings_auth=1' },
      });
    } catch { return { success: false, error: 'Failed to uninstall plugin' }; }
  });

  /** Enable/disable a plugin (admin only) */
  ipcMain.handle('plugins-toggle', async (_event, id, enabled) => {
    try {
      return await backendRequest(`/api/plugins/${encodeURIComponent(id)}/toggle`, {
        method: 'POST',
        body: { enabled: !!enabled },
        headers: { 'Cookie': 'settings_auth=1' },
      });
    } catch { return { success: false, error: 'Failed to toggle plugin' }; }
  });

  /** Update a plugin from its repo (admin only) */
  ipcMain.handle('plugins-update', async (_event, id) => {
    try {
      return await backendRequest(`/api/plugins/${encodeURIComponent(id)}/update`, {
        method: 'POST',
        headers: { 'Cookie': 'settings_auth=1' },
        timeout: 60000,
      });
    } catch { return { success: false, error: 'Failed to update plugin' }; }
  });

  // ─── Bun / Ollama Install ──────────────────────────
  /** Check whether the Bun runtime is installed */
  ipcMain.handle('check-bun', async () => {
    // Bun is no longer required — the Python backend exe is self-contained.
    // Kept as a stub so the renderer's startup checklist still passes.
    return { installed: true };
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
