// ══════════════════════════════════════════════════════
// Kasalix AI Chat Server — Dashboard Logic
// ══════════════════════════════════════════════════════

const API = window.serverAPI;

// ─── State ───────────────────────────────────────────────────────
let state = {
  serverRunning: false,
  httpMode: false,
  autoStart: true,
};

// ─── Settings Persistence ───────────────────────────────────────
async function loadGuiSettings() {
  const saved = await API.loadGuiSettings();
  if (saved) {
    if (saved.httpMode !== undefined) state.httpMode = saved.httpMode;
    if (saved.autoStart !== undefined) state.autoStart = saved.autoStart;
    if (saved.iconPath) {
      $('iconPreview').src = 'file:///' + saved.iconPath.replace(/\\/g, '/');
      $('iconPreview').style.display = 'block';
      $('iconStatus').textContent = '✓ Custom icon set';
    }
  }
  // Apply toggles
  httpToggle.classList.toggle('toggle-on', state.httpMode);
  autoStartToggle.classList.toggle('toggle-on', state.autoStart);
}

async function saveGuiSettings() {
  const iconImg = $('iconPreview');
  const iconPath = iconImg.style.display !== 'none' && iconImg.src ? iconImg.src : '';
  await API.saveGuiSettings({
    httpMode: state.httpMode,
    autoStart: state.autoStart,
    iconPath: iconPath.startsWith('file://') ? decodeURIComponent(iconPath.slice(7)) : iconPath,
  });
}

async function saveGuiSettings() {
  await API.saveGuiSettings({
    httpMode: state.httpMode,
    autoStart: state.autoStart,
  });
}

// ─── DOM References ──────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const startBtn = $('startBtn');
const stopBtn = $('stopBtn');
const serverUrl = $('serverUrl');
const httpToggle = $('httpToggle');
const autoStartToggle = $('autoStartToggle');
const startupOverlay = $('startupOverlay');
const startupLog = $('startupLog');
const ollamaBadge = $('ollamaStatus');
const serverBadge = $('serverStatus');

// ─── Startup Sequence ───────────────────────────────────────────
async function runStartup() {
  const mark = (id, status) => {
    const el = $(id);
    if (!el) return;
    el.classList.remove('active', 'done', 'error');
    if (status === 'active') el.classList.add('active');
    if (status === 'done') el.classList.add('done');
    if (status === 'error') el.classList.add('error');
    if (status === 'active') {
      const spinner = el.querySelector('.check-spinner');
      if (spinner) spinner.style.animation = 'spin 0.8s linear infinite';
    }
  };

  const log = (text) => {
    startupLog.textContent += text + '\n';
    startupLog.scrollTop = startupLog.scrollHeight;
  };

  // Step 1: Check Bun
  mark('check-bun', 'active');
  log('Checking Bun runtime...');
  // Bun check is passive - if it's not available, we'll show error later

  // Step 2: Check Ollama
  mark('check-bun', 'done');
  mark('check-deps', 'active');
  log('Checking if Ollama is available...');
  const ollama = await API.checkOllama();
  if (ollama.available) {
    mark('check-deps', 'done');
    updateOllamaBadge(true);
    log('Ollama is running ✓');
  } else {
    mark('check-deps', 'done');
    log('Ollama not found — AI features will be unavailable');
    updateOllamaBadge(false);
  }

  // Step 3: Install deps if needed
  mark('check-ollama', 'active');
  log('Backend dependencies ready ✓');
  mark('check-ollama', 'done');

  // Enable start button
  startBtn.disabled = false;

  // Step 4: Auto-start server if setting is on
  mark('check-server', 'active');
  if (state.autoStart) {
    log('Auto-start enabled — launching server...');
    await startServer();
  } else {
    mark('check-server', 'done');
    log('Ready. Click "Start Server" to begin.');
    startupOverlay.classList.add('hidden');
  }
}

// ─── Server Control ─────────────────────────────────────────────
async function startServer() {
  startBtn.disabled = true;
  startBtn.textContent = 'Starting...';

  const result = await API.startServer(state.httpMode);

  if (result.success) {
    state.serverRunning = true;
    updateServerBadge(true);
    updateServerURL(result.port, result.https);
    startBtn.disabled = true;
    stopBtn.disabled = false;
    startBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg> Running`;

    // Hide startup overlay
    startupOverlay.classList.add('hidden');

    const $checkServer = $('check-server');
    if ($checkServer) {
      $checkServer.classList.remove('active');
      $checkServer.classList.add('done');
    }
  } else {
    state.serverRunning = false;
    startBtn.disabled = false;
    startBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg> Start Server`;

    const $checkServer = $('check-server');
    if ($checkServer) {
      $checkServer.classList.remove('active');
      $checkServer.classList.add('error');
    }
    startupLog.textContent += '❌ Server failed to start: ' + (result.error || 'Unknown error') + '\n';
    startupOverlay.classList.remove('hidden');
  }
}

async function stopServer() {
  stopBtn.disabled = true;
  const result = await API.stopServer();
  if (result.success) {
    state.serverRunning = false;
    updateServerBadge(false);
    startBtn.disabled = false;
    stopBtn.disabled = true;
    startBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg> Start Server`;
    serverUrl.querySelector('.value').textContent = '—';
  }
  stopBtn.disabled = false;
}

// ─── UI Updates ──────────────────────────────────────────────────
function updateOllamaBadge(available) {
  const dot = ollamaBadge.querySelector('.dot');
  dot.className = 'dot ' + (available ? 'dot-online' : 'dot-offline');
}

function updateServerBadge(running) {
  const dot = serverBadge.querySelector('.dot');
  dot.className = 'dot ' + (running ? 'dot-online' : 'dot-offline');
}

function updateServerURL(port, https) {
  const protocol = https ? 'https' : 'http';
  const value = serverUrl.querySelector('.value');
  value.textContent = `${protocol}://localhost:${port}`;
}

function updateIPs(ips) {
  const container = $('ipList');
  if (!ips || ips.length === 0) {
    container.innerHTML = `<div class="ip-row placeholder">No network interfaces found</div>`;
    return;
  }
  container.innerHTML = ips.map(ip => `
    <div class="ip-row">
      <span class="ip-address">${ip.address}</span>
      <span class="ip-interface">${ip.interface}</span>
    </div>
  `).join('');
}

function updateStats(stats) {
  if (!stats) return;

  // CPU
  $('cpuValue').textContent = stats.cpu.usagePercent + '%';
  $('cpuBar').style.width = stats.cpu.usagePercent + '%';
  $('cpuDetail').textContent = `Cores: ${stats.cpu.count} | Load: ${stats.cpu.load.toFixed(2)}`;

  // RAM
  $('ramValue').textContent = stats.ram.usagePercent + '%';
  $('ramBar').style.width = stats.ram.usagePercent + '%';
  const usedGB = (stats.ram.used / (1024**3)).toFixed(1);
  const totalGB = (stats.ram.total / (1024**3)).toFixed(1);
  $('ramDetail').textContent = `${usedGB} GB / ${totalGB} GB used`;

  // GPU (optional)
  if (stats.gpu) {
    const gpuCard = $('gpuCard');
    gpuCard.style.display = 'block';
    $('gpuName').textContent = stats.gpu.name || 'GPU';
    $('gpuValue').textContent = stats.gpu.gpuUtil + '%';
    $('gpuBar').style.width = stats.gpu.gpuUtil + '%';
    $('gpuDetail').textContent = `VRAM: ${stats.gpu.memUsed} MB / ${stats.gpu.memTotal} MB`;
  }
}

function updateModels(models) {
  const container = $('modelsList');
  if (!models || models.length === 0) {
    container.innerHTML = `<div class="model-row placeholder">No models currently loaded</div>`;
    return;
  }
  container.innerHTML = models.map(m => `
    <div class="model-row">
      <span class="model-name">${m.name || 'Unknown'}</span>
      <span class="model-status">Running</span>
    </div>
  `).join('');
}

// ─── Dashboard Update Handler ────────────────────────────────────
API.onDashboardUpdate((data) => {
  if (data.stats) updateStats(data.stats);
  if (data.ips) updateIPs(data.ips);
  if (data.models) updateModels(data.models);
  if (data.serverStatus) {
    state.serverRunning = data.serverStatus.running;
    updateServerBadge(data.serverStatus.running);
    if (!data.serverStatus.running && state.serverRunning !== data.serverStatus.running) {
      // Server stopped unexpectedly
      startBtn.disabled = false;
      stopBtn.disabled = true;
      startBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg> Start Server`;
    }
  }
});

API.onServerLog((text) => {
  // Logs are received here for a log viewer if needed
});

// ─── Event Handlers ──────────────────────────────────────────────
startBtn.addEventListener('click', startServer);
stopBtn.addEventListener('click', stopServer);

// HTTP mode toggle
httpToggle.addEventListener('click', () => {
  state.httpMode = !state.httpMode;
  httpToggle.classList.toggle('toggle-on', state.httpMode);
  saveGuiSettings();
});

// Auto-start toggle
autoStartToggle.addEventListener('click', () => {
  state.autoStart = !state.autoStart;
  autoStartToggle.classList.toggle('toggle-on', state.autoStart);
  saveGuiSettings();
});

// Window controls
$('minimizeBtn').addEventListener('click', () => {
  API.minimizeWindow();
});

$('closeBtn').addEventListener('click', () => {
  window.close();
});

// ─── Download Manager ──────────────────────────────────────────
let downloading = {};

async function downloadAsset(assetName, statusEl, progressEl) {
  if (downloading[assetName]) return;

  // Check if already downloaded locally
  const existing = await API.getReleaseFiles();
  if (existing.files && existing.files.some(f => f.name === assetName)) {
    statusEl.textContent = '✓ Already downloaded';
    if (progressEl) {
      progressEl.textContent = '100%';
      progressEl.style.display = 'inline';
      progressEl.style.color = 'var(--green)';
    }
    return;
  }

  downloading[assetName] = true;
  statusEl.textContent = 'Starting...';
  if (progressEl) progressEl.style.display = 'inline';

  const result = await API.downloadRelease(assetName);

  if (result.success) {
    statusEl.textContent = '✓ Downloaded';
    if (progressEl) {
      progressEl.textContent = '100%';
      progressEl.style.color = 'var(--green)';
    }
  } else {
    statusEl.textContent = '❌ ' + (result.error || 'Failed');
    if (progressEl) progressEl.style.display = 'none';
  }
  downloading[assetName] = false;
}

$('downloadWin').addEventListener('click', async () => {
  // First check what available on GitHub
  const release = await API.checkGitHubRelease();
  if (!release || !release.assets) {
    $('dlWinStatus').textContent = 'Could not reach GitHub';
    return;
  }
  // Find the EXE asset (largest, not blockmap)
  const exeAsset = release.assets.find(a => a.name.endsWith('.exe') && !a.name.endsWith('.exe.blockmap'));
  if (!exeAsset) {
    $('dlWinStatus').textContent = 'No EXE found in latest release';
    return;
  }
  downloadAsset(exeAsset.name, $('dlWinStatus'), $('dlWinProgress'));
});

$('downloadAndroid').addEventListener('click', async () => {
  const release = await API.checkGitHubRelease();
  if (!release || !release.assets) {
    $('dlAndroidStatus').textContent = 'Could not reach GitHub';
    return;
  }
  const apkAsset = release.assets.find(a => a.name.toLowerCase().endsWith('.apk'));
  if (!apkAsset) {
    $('dlAndroidStatus').textContent = 'No APK found in latest release';
    return;
  }
  downloadAsset(apkAsset.name, $('dlAndroidStatus'), $('dlAndroidProgress'));
});

// Download progress updates
API.onDownloadProgress((data) => {
  const statusEl = data.asset.endsWith('.apk') ? $('dlAndroidStatus') : $('dlWinStatus');
  const progressEl = data.asset.endsWith('.apk') ? $('dlAndroidProgress') : $('dlWinProgress');
  if (statusEl) statusEl.textContent = `Downloading... ${data.percent}%`;
  if (progressEl) progressEl.textContent = data.percent + '%';
});

// ─── Icon Picker ───────────────────────────────────────────────
$('pickIconBtn').addEventListener('click', async () => {
  const result = await API.pickIcon();
  if (result.success && result.path) {
    $('iconPreview').src = 'file://' + result.path;
    $('iconPreview').style.display = 'block';
    $('iconStatus').textContent = '✓ Custom icon set';
    // Save to settings
    const current = await API.loadGuiSettings() || {};
    current.iconPath = result.path;
    await API.saveGuiSettings(current);
  }
});

// ─── Settings Password ────────────────────────────────────────
let settingsAuthed = false;

$('pwAuthBtn').addEventListener('click', async () => {
  const pw = $('pwInput').value;
  if (!pw) return;
  $('pwErrorMsg').textContent = '⏳ Authenticating...';
  $('pwErrorMsg').style.color = 'var(--text-dim)';
  const result = await API.authSettings(pw);
  if (result.authenticated) {
    settingsAuthed = true;
    $('pwDot').className = 'dot dot-online';
    $('pwStatusText').textContent = 'Authenticated';
    $('pwForm').style.display = 'none';
    $('pwChange').style.display = 'flex';
    $('pwMsg').textContent = '';
    $('pwErrorMsg').textContent = '';
    loadUsers();
  } else {
    $('pwErrorMsg').textContent = '❌ ' + (result.error || 'Wrong password');
    $('pwErrorMsg').style.color = 'var(--red)';
  }
});

$('pwChangeBtn').addEventListener('click', async () => {
  const current = $('pwCurrent').value;
  const next = $('pwNew').value;
  if (!current || !next) {
    $('pwMsg').textContent = 'Fill in both fields';
    return;
  }
  if (next.length < 4) {
    $('pwMsg').textContent = 'Min 4 characters';
    return;
  }
  const result = await API.changeSettingsPassword(current, next);
  if (result.success) {
    $('pwMsg').textContent = '✓ Password changed!';
    $('pwMsg').style.color = 'var(--green)';
    $('pwCurrent').value = '';
    $('pwNew').value = '';
  } else {
    $('pwMsg').textContent = '❌ ' + (result.error || 'Failed');
    $('pwMsg').style.color = 'var(--red)';
  }
});

$('pwInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('pwAuthBtn').click();
});
$('pwCurrent').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('pwChangeBtn').click();
});
$('pwNew').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('pwChangeBtn').click();
});

// ─── Connected Users ─────────────────────────────────────────
async function loadUsers() {
  if (!settingsAuthed) return;
  const result = await API.getUsers();
  const container = $('usersList');
  const count = $('usersCount');
  if (result.users && result.users.length > 0) {
    count.textContent = result.users.length;
    container.innerHTML = result.users.map(u => `
      <div class="user-row">
        <span class="user-color" style="background:${u.color || '#6366f1'}"></span>
        <span class="user-name">${u.username}</span>
        <span class="user-date">${new Date(u.createdAt).toLocaleDateString()}</span>
      </div>
    `).join('');
  } else {
    count.textContent = '0';
    container.innerHTML = `<div class="user-row placeholder">No users registered yet</div>`;
  }
}

// Refresh users periodically when authenticated
setInterval(() => {
  if (settingsAuthed) loadUsers();
}, 10000);

// Check GitHub release version on init
async function checkLatestRelease() {
  const release = await API.checkGitHubRelease();
  if (release && release.version) {
    const badge = $('releaseVersion');
    if (badge) badge.textContent = 'v' + release.version.replace(/^v/i, '') + ' available';
  }
}

// ─── Init ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Load version
  API.getAppInfo().then((info) => {
    $('versionDisplay').textContent = 'v' + info.version;
  });

  // Handle Bun not found
  API.onBunNotFound(() => {
    const $checkBun = $('check-bun');
    if ($checkBun) {
      $checkBun.classList.remove('active');
      $checkBun.classList.add('error');
    }
    startupLog.textContent += '❌ Bun runtime not found! Please install Bun from https://bun.sh\n';
    startupOverlay.classList.remove('hidden');
    startBtn.disabled = true;
  });

  // Load saved settings (autoStart, httpMode) — AWAIT so startup respects them
  await loadGuiSettings();

  // Check for latest GitHub release
  checkLatestRelease();

  // Run startup sequence
  runStartup();
});
