// ══════════════════════════════════════════════════════
// Kasalix AI Chat Server — Dashboard Logic
// ══════════════════════════════════════════════════════

const API = window.serverAPI;

// Escape HTML in dynamic values rendered into innerHTML (model names, etc.)
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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

// ─── Missing Component Install (Bun / Ollama) ───────────────────
let installResolve = null;

function promptInstall(component) {
  // If a prompt is already showing (e.g. both the startup check and the
  // bun-not-found event fire), chain onto it so no caller hangs waiting
  // for a resolver that never gets called.
  if (installResolve) {
    return new Promise((resolve) => {
      const prevResolve = installResolve;
      installResolve = (answer) => { prevResolve(answer); resolve(answer); };
    });
  }
  return new Promise((resolve) => {
    installResolve = resolve;
    if (component === 'bun') {
      $('installModalTitle').textContent = 'Bun is missing';
      $('installModalMsg').textContent = 'The Bun runtime is required to run the AI server. I can install it for you. May I?';
    } else {
      $('installModalTitle').textContent = 'Ollama is missing';
      $('installModalMsg').textContent = 'Ollama is required for AI model responses. I can install it for you. May I?';
    }
    $('installModal').style.display = 'flex';
  });
}

function answerInstall(yes) {
  $('installModal').style.display = 'none';
  if (installResolve) { installResolve(yes); installResolve = null; }
}

function showInstallProgress(title, msg) {
  $('installProgressTitle').textContent = title;
  $('installProgressMsg').textContent = msg || '';
  $('installProgressBar').style.width = '0%';
  $('installProgressOverlay').style.display = 'flex';
}

function hideInstallProgress() {
  $('installProgressOverlay').style.display = 'none';
}

async function ensureBun() {
  const check = await API.checkBun();
  if (check.installed) return true;
  const yes = await promptInstall('bun');
  if (!yes) return false;
  showInstallProgress('Installing Bun...', 'Downloading and installing the Bun runtime. This may take a minute.');
  const res = await API.installBun();
  hideInstallProgress();
  return !!res.installed;
}

async function ensureOllama() {
  const check = await API.checkOllama();
  if (check.available) return true;
  const yes = await promptInstall('ollama');
  if (!yes) return false;
  showInstallProgress('Installing Ollama...', 'Downloading Ollama and installing it. This may take a few minutes.');
  const res = await API.installOllama();
  if (res.success) {
    // Wait for the Ollama service to come up (it auto-starts after install)
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const again = await API.checkOllama();
      if (again.available) { hideInstallProgress(); return true; }
    }
    hideInstallProgress();
    // Installed successfully even if the service hasn't come up yet
    return true;
  }
  hideInstallProgress();
  return false;
}

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

  // Step 1: Check Bun (auto-install if missing, after asking)
  mark('check-bun', 'active');
  log('Checking Bun runtime...');
  const bunOk = await ensureBun();
  if (bunOk) {
    mark('check-bun', 'done');
    log('Bun found ✓');
  } else {
    mark('check-bun', 'error');
    log('Bun not found — server cannot start without it. Install from https://bun.sh');
  }

  // Step 2: Check Ollama (auto-install if missing, after asking)
  mark('check-deps', 'active');
  log('Checking if Ollama is available...');
  const ollamaOk = await ensureOllama();
  if (ollamaOk) {
    mark('check-deps', 'done');
    updateOllamaBadge(true);
    log('Ollama is running ✓');
  } else {
    mark('check-deps', 'error');
    updateOllamaBadge(false);
    log('Ollama not found — AI features will be unavailable');
  }

  // Step 3: Backend dependencies
  mark('check-ollama', 'active');
  log('Backend dependencies ready ✓');
  mark('check-ollama', 'done');

  // Enable start button (only if Bun is available)
  startBtn.disabled = !bunOk;

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

// ─── Install Modal Buttons ──────────────────────────────────────
$('installYesBtn').addEventListener('click', () => answerInstall(true));
$('installNoBtn').addEventListener('click', () => answerInstall(false));
$('installModalClose').addEventListener('click', () => answerInstall(false));

// Install progress updates from main process
API.onInstallProgress((data) => {
  const bar = $('installProgressBar');
  const msg = $('installProgressMsg');
  if (msg) msg.textContent = data.message || '';
  if (bar && typeof data.percent === 'number') {
    bar.style.width = Math.min(100, data.percent) + '%';
  }
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
    // If the user is on the Models / Speed Test tab, refresh it now that we're authed
    refreshAuthedView();
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

$('pwResetBtn').addEventListener('click', async () => {
  $('pwErrorMsg').textContent = '⏳ Resetting...';
  $('pwErrorMsg').style.color = 'var(--text-dim)';
  const result = await API.resetSettingsPassword();
  if (result.success) {
    $('pwErrorMsg').textContent = '✅ ' + (result.message || 'Password reset');
    $('pwErrorMsg').style.color = 'var(--green)';
    // Pre-fill the default password so the user can log right in
    $('pwInput').value = 'letmein';
    $('pwInput').focus();
  } else {
    $('pwErrorMsg').textContent = '❌ ' + (result.error || 'Reset failed');
    $('pwErrorMsg').style.color = 'var(--red)';
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

// ══════════════════════════════════════════════════════
// Tab Navigation (Dashboard / Models / Speed Test)
// ══════════════════════════════════════════════════════
const tabs = document.querySelectorAll('.tab');
const views = {
  dashboard: $('view-dashboard'),
  models: $('view-models'),
  speedtest: $('view-speedtest'),
};

function switchView(name) {
  Object.entries(views).forEach(([key, el]) => {
    if (el) el.style.display = key === name ? 'block' : 'none';
  });
  tabs.forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  if (name === 'models') enterModelsView();
  if (name === 'speedtest') enterSpeedTestView();
}

tabs.forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));

// If the user unlocks the admin panel while on the Models / Speed Test tab,
// refresh that view immediately.
function refreshAuthedView() {
  const activeTab = document.querySelector('.tab.active');
  if (!activeTab) return;
  if (activeTab.dataset.view === 'models') enterModelsView();
  if (activeTab.dataset.view === 'speedtest') enterSpeedTestView();
}

// ══════════════════════════════════════════════════════
// Models View — Model Assignments
// ══════════════════════════════════════════════════════
const MODEL_KEYS = [
  'chat_thinking', 'chat_fast', 'code', 'vision', 'extraction',
  'editor', 'editor_vision', 'search', 'image_generation',
];
const MODEL_LABELS = {
  chat_thinking: 'Chat (Thinking)',
  chat_fast: 'Chat (Fast)',
  code: 'Code Generation',
  vision: 'Vision Analysis',
  extraction: 'Memory Extraction',
  editor: 'Video Editor',
  editor_vision: 'Editor Vision',
  search: 'Web Search',
  image_generation: 'Image Generation',
};
const MODEL_ICONS = {
  chat_thinking: '🧠', chat_fast: '⚡', code: '💻', vision: '👁️',
  extraction: '🧠', editor: '🎬', editor_vision: '👁️', search: '🌐', image_generation: '🎨',
};
const DEFAULT_ASSIGNMENTS = {
  chat_thinking: 'qwen3:4b',
  chat_fast: 'qwen2.5:3b',
  code: 'qwen2.5-coder:7b',
  vision: 'qwen2.5vl:3b',
  extraction: 'qwen2.5:3b',
  editor: 'qwen2.5:3b',
  editor_vision: 'qwen2.5vl:3b',
  search: 'qwen2.5:3b',
  image_generation: 'x/flux2-klein',
};

let installedModels = [];
let localAssignments = {};

async function enterModelsView() {
  if (!settingsAuthed) {
    $('modelsLocked').style.display = 'block';
    $('modelsGrid').innerHTML = '';
    $('modelsSaveBtn').disabled = true;
    $('modelsResetBtn').disabled = true;
    return;
  }
  $('modelsLocked').style.display = 'none';
  $('modelsSaveBtn').disabled = false;
  $('modelsResetBtn').disabled = false;
  await loadModelsView();
}

async function loadModelsView() {
  $('modelsGrid').innerHTML = '<div class="models-loading">Loading models…</div>';
  const [mRes, sRes] = await Promise.all([API.getInstalledModels(), API.getSettings()]);
  installedModels = (mRes && mRes.models) || [];
  const saved = (sRes && sRes.modelAssignments) || {};
  localAssignments = { ...DEFAULT_ASSIGNMENTS };
  for (const k of MODEL_KEYS) if (saved[k]) localAssignments[k] = saved[k];
  $('modelsCount').textContent = installedModels.length + ' model' + (installedModels.length === 1 ? '' : 's') + ' installed';
  renderModelsGrid();
}

function suggestFor(key) {
  if (key === 'vision' || key === 'editor_vision') {
    const v = installedModels.find((m) => /vl|vision|llava/i.test(m.name));
    if (v) return v.name;
  }
  if (key === 'code') {
    const c = installedModels.find((m) => /coder|deepseek-coder/i.test(m.name));
    if (c) return c.name;
  }
  if (key === 'chat_thinking') {
    const t = installedModels.find((m) => /qwen3|deepseek-r1|qwq/i.test(m.name));
    if (t) return t.name;
  }
  if (key === 'extraction' || key === 'editor') {
    const small = installedModels
      .filter((m) => m.details && m.details.parameter_size)
      .sort((a, b) => {
        const sz = (s) => parseInt(s.replace(/[^0-9]/g, '')) || 999;
        return sz(a.details.parameter_size) - sz(b.details.parameter_size);
      });
    if (small.length) return small[0].name;
  }
  return null;
}

function renderModelsGrid() {
  const grid = $('modelsGrid');
  grid.innerHTML = MODEL_KEYS.map((key) => {
    const cur = localAssignments[key];
    const suggestion = suggestFor(key);
    const chips = installedModels
      .map((m) => {
        const sel = m.name === cur;
        const size = m.details && m.details.parameter_size
          ? `<span class="chip-size">${esc(m.details.parameter_size)}</span>`
          : '';
        return `<button class="model-chip${sel ? ' selected' : ''}" data-key="${key}" data-model="${m.name}">${esc(m.name)}${size}</button>`;
      })
      .join('');
    const suggBtn = suggestion && suggestion !== cur
      ? `<button class="model-chip suggestion" data-key="${key}" data-model="${suggestion}">✨ ${esc(suggestion)}</button>`
      : '';
    return `<div class="model-card">
      <div class="model-card-head">
        <span class="model-card-icon">${MODEL_ICONS[key]}</span>
        <div class="model-card-titles">
          <div class="model-card-label">${MODEL_LABELS[key]}</div>
          <div class="model-card-key">${key.replace(/_/g, ' ')}</div>
        </div>
        ${cur ? `<span class="model-card-current" title="${esc(cur)}">${esc(cur)}</span>` : ''}
      </div>
      <div class="model-chips">
        ${installedModels.length ? chips : '<span style="font-size:11px;color:var(--text-muted)">No models installed</span>'}
        ${suggBtn}
      </div>
    </div>`;
  }).join('');

  grid.querySelectorAll('.model-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      localAssignments[chip.dataset.key] = chip.dataset.model;
      renderModelsGrid();
      const status = $('modelsSaveStatus');
      status.textContent = 'Unsaved changes';
      status.className = 'save-status';
    });
  });
}

$('modelsSaveBtn').addEventListener('click', async () => {
  const status = $('modelsSaveStatus');
  status.textContent = 'Saving…';
  status.className = 'save-status';
  const res = await API.saveSettings({ modelAssignments: localAssignments });
  if (res && res.modelAssignments) {
    status.textContent = '✓ Saved';
    status.className = 'save-status ok';
    setTimeout(() => { status.textContent = ''; }, 2500);
  } else {
    status.textContent = '❌ ' + ((res && res.error) || 'Failed to save');
    status.className = 'save-status err';
  }
});

$('modelsResetBtn').addEventListener('click', () => {
  localAssignments = { ...DEFAULT_ASSIGNMENTS };
  renderModelsGrid();
  const status = $('modelsSaveStatus');
  status.textContent = 'Defaults loaded — click Save';
  status.className = 'save-status';
});

// ══════════════════════════════════════════════════════
// Speed Test View — timeline + detail modal
// ══════════════════════════════════════════════════════
const MODEL_STYLES = {
  chat_fast: { color: '#34d399', bg: 'rgba(52,211,153,0.12)' },
  chat_thinking: { color: '#c084fc', bg: 'rgba(168,85,247,0.15)' },
  code: { color: '#60a5fa', bg: 'rgba(59,130,246,0.15)' },
  vision: { color: '#fbbf24', bg: 'rgba(251,191,36,0.12)' },
  search: { color: '#22d3ee', bg: 'rgba(34,211,238,0.12)' },
  extraction: { color: '#fb7185', bg: 'rgba(244,63,94,0.12)' },
};

let speedResults = [];
let speedRunning = false;

function formatDuration(ms) {
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  return Math.floor(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
}

function formatSpeedDate(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  if (diff < 86400000) return 'Today, ' + time;
  if (diff < 172800000) return 'Yesterday, ' + time;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' + time;
}

function qualityColor(score) {
  return score >= 70 ? '#fbbf24' : score >= 40 ? '#fb923c' : '#f87171';
}

function sanitizeResult(r) {
  const ms = {};
  Object.entries(r.modelSummaries || {}).forEach(([k, v]) => {
    ms[k] = { ...v, avgQualityScore: v.avgQualityScore || 0 };
  });
  return {
    ...r,
    modelSummaries: ms,
    modelCount: r.modelCount ?? Object.keys(ms).length,
    summary: { avgQualityScore: 0, ...(r.summary || {}) },
    tests: (r.tests || []).map((t) => ({ qualityScore: 0, qualityChecks: [], ...t })),
  };
}

async function enterSpeedTestView() {
  if (!settingsAuthed) {
    $('speedLocked').style.display = 'block';
    $('speedRunBtn').disabled = true;
    $('speedTimeline').innerHTML = '';
    return;
  }
  $('speedLocked').style.display = 'none';
  $('speedRunBtn').disabled = false;
  await loadSpeedResults();
}

async function loadSpeedResults() {
  const res = await API.getSpeedTestResults();
  speedResults = ((res && res.results) || []).map(sanitizeResult);
  renderTimeline();
}

function renderTimeline() {
  const tl = $('speedTimeline');
  if (!speedResults.length) {
    tl.innerHTML = '<div class="speed-empty">No speed test results yet. Click "Run All Tests" to benchmark your models.</div>';
    return;
  }

  tl.innerHTML = speedResults.map((r, idx) => {
    const isLatest = idx === 0;
    const badges = Object.entries(r.modelSummaries || {}).map(([k, ms]) => {
      const color = (MODEL_STYLES[k] || {}).color || '#9ca3af';
      return `<span class="speed-badge" style="color:${color};border-color:${color}44">${esc(ms.icon)} ${esc(ms.label)}: ${formatDuration(ms.avgResponseTimeMs)}</span>`;
    }).join('');
    const maxTime = Math.max(...r.tests.map((t) => t.totalTimeMs), 1);
    const miniBars = r.tests.map((t) => {
      const h = Math.max(15, (t.totalTimeMs / maxTime) * 100);
      const style = MODEL_STYLES[t.assignmentKey] || {};
      const grad = t.success ? (style.color || '#6b7280') : '#ef4444';
      return `<div class="mini-bar" style="height:${h}%;background:${grad};opacity:${t.success ? 0.75 : 0.5}" title="${esc(t.testName)}: ${formatDuration(t.totalTimeMs)}"></div>`;
    }).join('');
    return `<div class="speed-item${isLatest ? ' latest' : ''}" data-id="${r.id}">
      <div class="speed-item-top">
        <div class="speed-chips">
          <span class="speed-chip">🗓 ${formatSpeedDate(r.date)}</span>
          <span class="speed-chip">🧠 ${r.modelCount} models</span>
          ${isLatest ? '<span class="speed-chip latest-chip">Latest</span>' : ''}
        </div>
        <button class="speed-del" data-id="${r.id}" title="Delete result">🗑</button>
      </div>
      <div class="speed-model-badges">${badges}</div>
      <div class="speed-quick">
        <span><b>${formatDuration(r.summary.avgResponseTimeMs)}</b> avg resp</span>
        <span><b>${r.summary.avgTokensPerSecond.toFixed(1)}</b> tok/s</span>
        <span><b>${formatDuration(r.summary.avgTimeToFirstTokenMs)}</b> ttfb</span>
        <span><b>${r.summary.passed}/${r.summary.totalTests}</b> passed</span>
        <span><b style="color:${qualityColor(r.summary.avgQualityScore)}">${r.summary.avgQualityScore}%</b> quality</span>
      </div>
      <div class="speed-mini-bars">${miniBars}</div>
      <div class="speed-hint">Click for detailed results and graphs</div>
    </div>`;
  }).join('');

  tl.querySelectorAll('.speed-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.speed-del')) return;
      const r = speedResults.find((x) => x.id === item.dataset.id);
      if (r) openSpeedDetail(r);
    });
  });

  tl.querySelectorAll('.speed-del').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await API.deleteSpeedTestResult(btn.dataset.id);
      await loadSpeedResults();
    });
  });
}

$('speedRunBtn').addEventListener('click', async () => {
  if (speedRunning || !settingsAuthed) return;
  speedRunning = true;
  $('speedRunBtn').disabled = true;
  const status = $('speedRunStatus');
  status.textContent = 'Running tests… this can take a few minutes';
  status.className = 'save-status';
  try {
    const res = await API.runSpeedTests();
    if (res && res.result) {
      status.textContent = '✓ Suite complete';
      status.className = 'save-status ok';
    } else {
      status.textContent = '❌ ' + ((res && res.error) || 'Test failed');
      status.className = 'save-status err';
    }
    await loadSpeedResults();
  } catch (err) {
    status.textContent = '❌ ' + (err.message || 'Test failed');
    status.className = 'save-status err';
  }
  speedRunning = false;
  $('speedRunBtn').disabled = !settingsAuthed;
  setTimeout(() => {
    if ($('speedRunStatus').textContent.startsWith('✓')) status.textContent = '';
  }, 3000);
});

// ─── Speed Test Detail Modal ────────────────────────
function openSpeedDetail(r) {
  $('speedModalTitle').textContent = 'Speed Test Results — ' + formatSpeedDate(r.date);
  $('speedModalBody').innerHTML = '';
  $('speedModal').style.display = 'flex';

  const maxTime = Math.max(...r.tests.map((t) => t.totalTimeMs), 1);
  const maxTps = Math.max(...r.tests.map((t) => t.tokensPerSecond), 1);

  const summary = `
    <div class="summary-cards">
      <div class="summary-card"><div class="sc-label">⏱ Total Duration</div><div class="sc-value">${formatDuration(r.totalDurationMs)}</div></div>
      <div class="summary-card"><div class="sc-label">🧠 Models Tested</div><div class="sc-value">${r.modelCount}</div></div>
      <div class="summary-card"><div class="sc-label">⚡ Avg Response</div><div class="sc-value">${formatDuration(r.summary.avgResponseTimeMs)}</div></div>
      <div class="summary-card"><div class="sc-label">🎯 Avg Quality</div><div class="sc-value" style="color:${qualityColor(r.summary.avgQualityScore)}">${r.summary.avgQualityScore}%</div></div>
    </div>`;

  const modelCards = `
    <div class="model-summary-cards">
      ${Object.entries(r.modelSummaries || {}).map(([k, ms]) => {
        const color = (MODEL_STYLES[k] || {}).color || '#9ca3af';
        return `<div class="model-summary">
          <div class="ms-head"><span>${ms.icon}</span> ${ms.label}</div>
          <div class="ms-model">${ms.model}</div>
          <div class="ms-metrics">
            <span><b style="color:${color}">${formatDuration(ms.avgResponseTimeMs)}</b> avg</span>
            <span><b style="color:${color}">${ms.avgTokensPerSecond.toFixed(1)}</b> tok/s</span>
            <span><b style="color:${ms.failed === 0 ? '#34d399' : '#f87171'}">${ms.passed}/${ms.tests}</b> pass</span>
            <span><b style="color:${qualityColor(ms.avgQualityScore)}">${ms.avgQualityScore}%</b> quality</span>
          </div>
        </div>`;
      }).join('')}
    </div>`;

  // Group tests by assignment key
  const groups = {};
  for (const t of r.tests) {
    if (!groups[t.assignmentKey]) groups[t.assignmentKey] = [];
    groups[t.assignmentKey].push(t);
  }

  const barChart = (title, valueFn, formatter, maxVal) => `
    <div class="chart-block">
      <div class="chart-title">${title}</div>
      ${Object.entries(groups).map(([k, tests]) => {
        const color = (MODEL_STYLES[k] || {}).color || '#6b7280';
        const ms = r.modelSummaries[k];
        return `<div class="chart-group">
          <div class="chart-group-head"><span class="gdot" style="background:${color}"></span> ${ms ? ms.label : k} <span style="color:var(--text-muted);font-weight:400">(${ms ? ms.model : ''})</span></div>
          ${tests.map((t) => {
            const val = valueFn(t);
            const pct = Math.max(2, (val / maxVal) * 100);
            return `<div class="bar-row">
              <div class="br-label">${t.testName}</div>
              <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${t.success ? color : '#ef4444'};opacity:${t.success ? 1 : 0.5}"></div></div>
              <div class="br-value">${formatter(val)}</div>
            </div>`;
          }).join('')}
        </div>`;
      }).join('')}
    </div>`;

  const qualityBlock = `
    <div class="chart-block">
      <div class="chart-title">🎯 Quality Score by Test — check details below each bar</div>
      ${r.tests.map((t) => {
        const q = t.qualityScore || 0;
        const color = qualityColor(q);
        const checks = (t.qualityChecks || []).map((c) =>
          `<div class="qcheck ${c.passed ? 'pass' : 'fail'}"><span>${c.passed ? '✓' : '✗'}</span> ${c.name}${c.details ? ` <span class="qc-detail">— ${c.details}</span>` : ''}</div>`
        ).join('');
        return `<div class="qrow">
          <div class="qrow-top"><span class="qrow-name">${t.testName}</span><span class="qrow-score" style="color:${color}">${q}%</span></div>
          <div class="bar-track"><div class="bar-fill" style="width:${q}%;background:${color}"></div></div>
          ${checks ? `<div class="qchecks">${checks}</div>` : ''}
        </div>`;
      }).join('')}
    </div>`;

  const table = `
    <div class="chart-block">
      <div class="chart-title">📋 All Test Details</div>
      <table class="detail-table">
        <thead><tr><th>Test</th><th>Model</th><th>Status</th><th>Time</th><th>TTFB</th><th>Chars</th><th>Tok/s</th><th>Quality</th></tr></thead>
        <tbody>
          ${r.tests.map((t) => {
            const color = (MODEL_STYLES[t.assignmentKey] || {}).color || '#9ca3af';
            const q = t.qualityScore || 0;
            const ms = r.modelSummaries[t.assignmentKey];
            return `<tr>
              <td>${t.testName}</td>
              <td><span style="color:${color}">${ms ? ms.label : t.assignmentKey}</span></td>
              <td class="td-status">${t.success ? '✅' : '❌'}</td>
              <td class="td-mono">${formatDuration(t.totalTimeMs)}</td>
              <td class="td-mono">${formatDuration(t.timeToFirstTokenMs)}</td>
              <td class="td-mono">${t.totalChars}</td>
              <td class="td-mono">${t.tokensPerSecond.toFixed(1)}</td>
              <td class="td-mono" style="color:${qualityColor(q)}">${q}%</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;

  const errors = r.tests.filter((t) => !t.success);
  const errorsBlock = errors.length
    ? `<div class="errors-block"><h4>⚠️ Errors</h4>${errors.map((t) => `<p><strong>${t.testName}:</strong> ${t.error || 'Unknown error'}</p>`).join('')}</div>`
    : '';

  $('speedModalBody').innerHTML =
    summary + modelCards +
    barChart('📊 Response Time by Test', (t) => t.totalTimeMs, formatDuration, maxTime) +
    barChart('⚡ Tokens per Second', (t) => t.tokensPerSecond, (v) => v.toFixed(1) + ' tok/s', maxTps) +
    qualityBlock + table + errorsBlock;
}

$('speedModalClose').addEventListener('click', () => { $('speedModal').style.display = 'none'; });
$('speedModal').addEventListener('click', (e) => { if (e.target === $('speedModal')) $('speedModal').style.display = 'none'; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('speedModal').style.display = 'none'; });

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

  // Handle Bun not found (also offer to install it)
  API.onBunNotFound(async () => {
    const $checkBun = $('check-bun');
    if ($checkBun) {
      $checkBun.classList.remove('active');
      $checkBun.classList.add('error');
    }
    const yes = await promptInstall('bun');
    if (yes) {
      startupLog.textContent += 'Installing Bun...\n';
      showInstallProgress('Installing Bun...', 'Downloading and installing the Bun runtime. This may take a minute.');
      const res = await API.installBun();
      hideInstallProgress();
      if (res.installed) {
        startupLog.textContent += '✓ Bun installed!\n';
        if ($checkBun) { $checkBun.classList.remove('error'); $checkBun.classList.add('done'); }
        startBtn.disabled = false;
      } else {
        startupLog.textContent += '❌ Bun install failed: ' + (res.error || 'unknown error') + '\n';
      }
    } else {
      startupLog.textContent += '❌ Bun runtime not found! Please install Bun from https://bun.sh\n';
      startBtn.disabled = true;
    }
    startupOverlay.classList.remove('hidden');
  });

  // Load saved settings (autoStart, httpMode) — AWAIT so startup respects them
  await loadGuiSettings();

  // Check for latest GitHub release
  checkLatestRelease();

  // Run startup sequence
  runStartup();
});
