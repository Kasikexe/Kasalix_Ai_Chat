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
  $('installProgressMsg').classList.remove('error');
  $('installProgressBar').style.width = '0%';
  $('installProgressClose').style.display = 'none';
  $('installProgressOverlay').style.display = 'flex';
}

function hideInstallProgress() {
  $('installProgressOverlay').style.display = 'none';
  $('installProgressClose').style.display = 'none';
}

// Show the progress overlay in an error state — keeps it visible with the
// failure reason and a Close button (previously failures vanished instantly
// with no feedback).
function showInstallError(title, msg) {
  $('installProgressTitle').textContent = title;
  $('installProgressMsg').textContent = msg || 'Installation failed.';
  $('installProgressMsg').classList.add('error');
  $('installProgressBar').style.width = '0%';
  $('installProgressClose').style.display = 'inline-flex';
  $('installProgressOverlay').style.display = 'flex';
}

async function ensureBun() {
  const check = await API.checkBun();
  if (check.installed) return true;
  const yes = await promptInstall('bun');
  if (!yes) return false;
  showInstallProgress('Installing Bun...', 'Downloading and installing the Bun runtime. This may take a minute.');
  const res = await API.installBun();
  if (res.installed) { hideInstallProgress(); return true; }
  showInstallError('Bun install failed', res.error || 'Bun could not be installed. Please install it manually from https://bun.sh');
  return false;
}

async function ensureOllama() {
  // 1. Check if Ollama is already running
  const check = await API.checkOllama();
  if (check.available) return true;

  // 2. Not running — try to start it (it may be installed but not started)
  log('Ollama not responding — trying to start it...');
  try {
    const startRes = await API.startOllama();
    if (startRes.success) {
      log('Ollama started ✓');
      return true;
    }
  } catch (e) {
    // startOllama failed — Ollama probably not installed
  }

  // 3. Still not available — prompt to install
  const yes = await promptInstall('ollama');
  if (!yes) return false;
  showInstallProgress('Installing Ollama...', 'Downloading Ollama (~1.5 GB) and installing it. This may take a few minutes depending on your connection.');
  const res = await API.installOllama();
  if (res.success) {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const again = await API.checkOllama();
      if (again.available) { hideInstallProgress(); return true; }
    }
    hideInstallProgress();
    return true;
  }
  showInstallError('Ollama install failed', res.error || 'Ollama could not be installed. Please download it manually from https://ollama.com/download');
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

  // Step 2: Check Ollama (non-blocking — server starts either way)
  mark('check-deps', 'active');
  log('Checking if Ollama is available...');
  let ollamaOk = false;
  try {
    ollamaOk = await ensureOllama();
  } catch (e) {
    log('Ollama check failed: ' + e.message);
  }
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

    // Start uptime timer
    startUptimeTimer();
    refreshModePill();
    startUsageRefresh();
    startTrajectoryRefresh();

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
    startupOverlay.classList.add('hidden');
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
    $('copyUrlBtn').style.display = 'none';
    stopUptimeTimer();
    stopUsageRefresh();
    stopTrajectoryRefresh();
    $('cloudUsageCard').style.display = 'none';
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
  const url = `${protocol}://localhost:${port}`;
  value.textContent = url;
  $('copyUrlBtn').style.display = 'inline-flex';
}

// ─── Uptime Timer ──────────────────────────────────────────────
let serverStartTime = null;
let uptimeInterval = null;

function startUptimeTimer() {
  serverStartTime = Date.now();
  if (uptimeInterval) clearInterval(uptimeInterval);
  uptimeInterval = setInterval(updateUptime, 1000);
  updateUptime();
}

function stopUptimeTimer() {
  serverStartTime = null;
  if (uptimeInterval) clearInterval(uptimeInterval);
  uptimeInterval = null;
  const el = $('uptimeValue');
  if (el) el.textContent = '—';
}

function updateUptime() {
  if (!serverStartTime) return;
  const elapsed = Date.now() - serverStartTime;
  const hrs = Math.floor(elapsed / 3600000);
  const mins = Math.floor((elapsed % 3600000) / 60000);
  const secs = Math.floor((elapsed % 60000) / 1000);
  const el = $('uptimeValue');
  if (!el) return;
  if (hrs > 0) el.textContent = `${hrs}h ${mins}m`;
  else if (mins > 0) el.textContent = `${mins}m ${secs}s`;
  else el.textContent = `${secs}s`;
}

// ─── Mode Pill ────────────────────────────────────────────────
async function refreshModePill() {
  try {
    const settings = await API.getApiKeySettings();
    if (settings && settings.cloudMode) {
      const mode = settings.cloudMode;
      const icon = mode === 'auto' ? '🔄' : mode === 'local' ? '🖥️' : '☁️';
      const label = mode === 'auto' ? 'Auto' : mode === 'local' ? 'Local Only' : 'Cloud Only';
      const modeClass = `mode-${mode}`;
      $('modePillIcon').textContent = icon;
      const valEl = $('modePillValue');
      valEl.textContent = label;
      valEl.className = 'info-pill-value ' + modeClass;
    }
  } catch {}
}

// ─── Cloud Usage Bar ────────────────────────────────────────
let cloudUsageData = null;
let usageRefreshInterval = null;

async function refreshCloudUsage() {
  try {
    const usage = await API.getCloudUsage();
    if (!usage || (!usage.monthlyLimit && usage.totalRequests === 0)) {
      // No data — hide card
      $('cloudUsageCard').style.display = 'none';
      $('cloudUsageCost').style.display = 'none';
      $('costBreakdownCard').style.display = 'none';
      return;
    }

    const card = $('cloudUsageCard');
    card.style.display = 'block';
    cloudUsageData = usage;
    const used = usage.totalRequests;
    const limit = usage.monthlyLimit || 0;

    if (limit > 0) {
      // With limit set — show progress bar
      const pct = Math.min(100, Math.round((used / limit) * 100));
      const isWarning = pct >= 80;
      const isDanger = pct >= 100;
      const countEl = $('cloudUsageCount');
      countEl.textContent = `${used} / ${limit}`;
      countEl.className = 'cloud-usage-count' + (isDanger ? ' danger' : isWarning ? ' warning' : '');
      const fillEl = $('cloudUsageFill');
      fillEl.style.width = Math.min(100, pct) + '%';
      fillEl.className = 'cloud-usage-fill' + (isDanger ? ' danger' : isWarning ? ' warning' : '');
      const tokensEl = $('cloudUsageTokens');
      tokensEl.textContent = usage.totalTokens > 0 ? `~${formatTokenCount(usage.totalTokens)} tokens used` : '';
      $('cloudUsagePeriod').textContent = `${pct}% of monthly limit`;
    } else {
      // No limit — show simple count
      $('cloudUsageCount').textContent = `${used} requests`;
      $('cloudUsageFill').style.width = '100%';
      $('cloudUsageFill').className = 'cloud-usage-fill';
      $('cloudUsageTokens').textContent = usage.totalTokens > 0 ? `~${formatTokenCount(usage.totalTokens)} tokens used` : '';
      $('cloudUsagePeriod').textContent = 'No limit set';
    }

    // ─── Cost estimate ───
    const costEl = $('cloudUsageCost');
    const costValueEl = $('cloudCostValue');
    if (usage.totalEstimatedCost !== undefined && usage.totalEstimatedCost > 0) {
      costEl.style.display = 'flex';
      costValueEl.textContent = formatCost(usage.totalEstimatedCost);
      costValueEl.className = 'cloud-cost-value' + (usage.totalEstimatedCost > 10 ? ' high' : usage.totalEstimatedCost > 50 ? ' danger' : '');
    } else if (usage.totalTokens > 0 && usage.costBreakdown && usage.costBreakdown.length > 0) {
      // Has token data but no pricing matches — still show
      costEl.style.display = 'flex';
      costValueEl.textContent = 'Pricing unknown';
      costValueEl.className = 'cloud-cost-value';
    } else {
      costEl.style.display = 'none';
    }

    // ─── Cost breakdown by model ───
    updateCostBreakdown(usage);
  } catch (e) {
    console.error('[cloud-usage] Refresh failed:', e);
    const card = $('cloudUsageCard');
    if (card) card.style.display = 'none';
    const costCard = $('costBreakdownCard');
    if (costCard) costCard.style.display = 'none';
  }
}

function formatTokenCount(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

/** Format a dollar amount for display */
function formatCost(amount) {
  if (amount < 0.01) return '$' + amount.toFixed(4);
  if (amount < 1) return '$' + amount.toFixed(3);
  if (amount < 100) return '$' + amount.toFixed(2);
  return '$' + amount.toFixed(2);
}

/** Render cost breakdown by model in the API Keys tab */
function updateCostBreakdown(usage) {
  const card = $('costBreakdownCard');
  const list = $('costBreakdownList');
  const badge = $('costTotalBadge');
  if (!card || !list) return;

  const breakdown = usage.costBreakdown || [];
  if (breakdown.length === 0) {
    card.style.display = 'none';
    return;
  }

  card.style.display = 'block';

  // Total cost badge
  const totalCost = usage.totalEstimatedCost || 0;
  badge.textContent = formatCost(totalCost);
  badge.className = 'cost-total-badge' + (totalCost > 10 ? ' high' : totalCost > 50 ? ' danger' : '');

  // Render each model row
  list.innerHTML = breakdown.map(item => {
    const tokens = formatTokenCount(item.inputTokens + item.outputTokens);
    const inputTokens = formatTokenCount(item.inputTokens);
    const outputTokens = formatTokenCount(item.outputTokens);
    const cost = item.totalCost > 0 ? formatCost(item.totalCost) : '—';
    const requests = (usage.byModel && usage.byModel[item.model]) || 0;
    return `
      <div class="cost-row">
        <span class="cost-model-name" title="${esc(item.model)}">${esc(item.model)}</span>
        <span class="cost-tokens" title="In: ${inputTokens} / Out: ${outputTokens}">${tokens} tok</span>
        <span class="cost-amount">${cost}</span>
        <span class="cost-requests">${requests} req</span>
      </div>
    `;
  }).join('');
}

// Refresh usage every 15 seconds when server is running
function startUsageRefresh() {
  refreshCloudUsage();
  if (usageRefreshInterval) clearInterval(usageRefreshInterval);
  usageRefreshInterval = setInterval(() => {
    if (state.serverRunning) refreshCloudUsage();
  }, 15000);
}

function stopUsageRefresh() {
  if (usageRefreshInterval) clearInterval(usageRefreshInterval);
  usageRefreshInterval = null;
}

// ─── Copy URL Button ──────────────────────────────────────────
$('copyUrlBtn').addEventListener('click', () => {
  const url = serverUrl.querySelector('.value').textContent;
  if (!url || url === '—') return;
  navigator.clipboard.writeText(url).then(() => {
    const btn = $('copyUrlBtn');
    btn.textContent = '✓';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = '📋'; btn.classList.remove('copied'); }, 1500);
  }).catch(() => {});
});

// ─── Live Server Log Panel ────────────────────────────────────
const MAX_LOG_LINES = 200;
let logExpanded = false;

$('toggleLogBtn').addEventListener('click', () => {
  logExpanded = !logExpanded;
  $('logPanel').classList.toggle('expanded', logExpanded);
  $('toggleLogBtn').classList.toggle('expanded', logExpanded);
});

$('clearLogBtn').addEventListener('click', () => {
  $('logPanel').innerHTML = '<div class="log-empty">Waiting for server output…</div>';
});

function appendLogLine(text) {
  const panel = $('logPanel');
  if (!panel) return;
  // Remove empty state
  const empty = panel.querySelector('.log-empty');
  if (empty) empty.remove();
  // Classify log level
  let cls = '';
  if (/error|fail|❌/i.test(text)) cls = ' log-error';
  else if (/warn|⚠️/i.test(text)) cls = ' log-warn';
  else if (/✓|success|✅/i.test(text)) cls = ' log-success';
  // Timestamp
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const div = document.createElement('div');
  div.className = 'log-line' + cls;
  div.innerHTML = `<span class="log-ts">${ts}</span>${esc(text)}`;
  panel.appendChild(div);
  // Trim old lines
  while (panel.children.length > MAX_LOG_LINES) panel.removeChild(panel.firstChild);
  // Auto-scroll if not at bottom
  panel.scrollTop = panel.scrollHeight;
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
      stopUptimeTimer();
      stopUsageRefresh();
      stopTrajectoryRefresh();
      $('cloudUsageCard').style.display = 'none';
    }
  }
});

API.onServerLog((text) => {
  if (text) appendLogLine(text);
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

// ─── Feedback Dropdown (GitHub) — configurable for forks ────
// Edit FEEDBACK_CONFIG below to point a rebranded build at your own
// repo instead of the original Kasalix project.
const FEEDBACK_CONFIG = {
  issueUrl: 'https://github.com/Kasikexe/Kasalix/issues/new',
  ideasUrl: 'https://github.com/Kasikexe/Kasalix/discussions/categories/ideas',
  repoUrl: 'https://github.com/Kasikexe/Kasalix',
};

const feedbackBtn = $('feedbackBtn');
const feedbackDropdown = $('feedbackDropdown');

// Render the menu from the config above
const FEEDBACK_ITEMS = [
  { emoji: '🐞', title: 'Report a bug', sub: 'Open a GitHub issue', url: FEEDBACK_CONFIG.issueUrl },
  { emoji: '💡', title: 'Suggest an idea', sub: 'GitHub Discussions — Ideas', url: FEEDBACK_CONFIG.ideasUrl },
  null,
  { emoji: '⭐', title: 'Visit repository', sub: FEEDBACK_CONFIG.repoUrl.replace('https://', ''), url: FEEDBACK_CONFIG.repoUrl },
];
feedbackDropdown.innerHTML = FEEDBACK_ITEMS.map((item) =>
  item
    ? `<button class="dropdown-item" data-url="${item.url}">
         <span class="dd-emoji">${item.emoji}</span>
         <span class="dd-text"><span>${item.title}</span><span class="dd-sub">${item.sub}</span></span>
       </button>`
    : '<div class="dropdown-sep"></div>'
).join('');

feedbackBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  feedbackDropdown.hidden = !feedbackDropdown.hidden;
});

document.addEventListener('click', (e) => {
  if (!(e.target instanceof Element) || !e.target.closest('#feedbackMenu')) feedbackDropdown.hidden = true;
});

feedbackDropdown.addEventListener('click', (e) => {
  const item = e.target.closest('.dropdown-item');
  if (!item) return;
  const url = item.dataset.url;
  if (url) API.openExternal(url).catch(() => {});
  feedbackDropdown.hidden = true;
});

// ─── Install Modal Buttons ──────────────────────────────────────
$('installYesBtn').addEventListener('click', () => answerInstall(true));
$('installNoBtn').addEventListener('click', () => answerInstall(false));
$('installModalClose').addEventListener('click', () => answerInstall(false));
$('installProgressClose').addEventListener('click', hideInstallProgress);

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
  plugins: $('view-plugins'),
  apikeys: $('view-apikeys'),
  ollama: $('view-ollama'),
};

function switchView(name) {
  // Guard: check for unsaved Ollama settings changes
  if (name !== 'ollama' && hasOllamaUnsavedChanges()) {
    pendingOllamaTargetView = name;
    showOllamaUnsavedModal();
    return;
  }
  pendingOllamaTargetView = null;
  Object.entries(views).forEach(([key, el]) => {
    if (el) el.style.display = key === name ? 'block' : 'none';
  });
  tabs.forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  if (name === 'models') enterModelsView();
  if (name === 'speedtest') enterSpeedTestView();
  if (name === 'plugins') enterPluginsView();
  if (name === 'apikeys') enterApiKeysView();
  if (name === 'ollama') enterOllamaView();
}

tabs.forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));

// If the user unlocks the admin panel while on the Models / Speed Test tab,
// refresh that view immediately.
function refreshAuthedView() {
  const activeTab = document.querySelector('.tab.active');
  if (!activeTab) return;
  if (activeTab.dataset.view === 'models') enterModelsView();
  if (activeTab.dataset.view === 'speedtest') enterSpeedTestView();
  if (activeTab.dataset.view === 'plugins') enterPluginsView();
  if (activeTab.dataset.view === 'apikeys') enterApiKeysView();
  if (activeTab.dataset.view === 'ollama') enterOllamaView();
}

// ══════════════════════════════════════════════════════
// Models View — Model Assignments
// ══════════════════════════════════════════════════════
const MODEL_KEYS = [
  'chat', 'chat_thinking', 'code', 'vision', 'extraction',
  'search', 'image_generation',
];
const MODEL_LABELS = {
  chat: 'Chat',
  chat_thinking: 'Chat (Thinking)',
  code: 'Code Generation',
  vision: 'Vision Analysis',
  extraction: 'Memory Extraction',
  search: 'Web Search',
  image_generation: 'Image Generation',
};
const MODEL_ICONS = {
  chat: '💬', chat_thinking: '🧠', code: '💻', vision: '👁️',
  extraction: '🧠', search: '🌐', image_generation: '🎨',
};
const DEFAULT_ASSIGNMENTS = {
  chat: 'qwen3:4b',
  chat_thinking: 'qwen3:4b',
  code: 'qwen2.5-coder:7b',
  vision: 'qwen2.5vl:3b',
  extraction: 'qwen2.5:3b',
  search: 'qwen2.5:3b',
  image_generation: 'x/flux2-klein',
};

let installedModels = [];
let localAssignments = {};
let cloudAssignments = {};
let availableCloudModels = [];
let fetchingCloudModels = false;
let cloudModelsError = '';

async function fetchAvailableCloudModels() {
  fetchingCloudModels = true;
  cloudModelsError = '';
  try {
    const result = await API.fetchCloudModels();
    if (result && result.models && result.models.length > 0) {
      availableCloudModels = result.models;
      cloudModelsError = '';
    } else {
      availableCloudModels = [];
      if (result && result.error) {
        cloudModelsError = result.error;
        console.warn('[models] Cloud models fetch:', result.error);
      }
    }
  } catch (e) {
    availableCloudModels = [];
    cloudModelsError = e instanceof Error ? e.message : String(e);
    console.error('[models] Failed to fetch cloud models:', e);
  }
  fetchingCloudModels = false;
}

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
  const [mRes, sRes, apiKeySettings] = await Promise.all([API.getInstalledModels(), API.getSettings(), API.getApiKeySettings()]);
  // Fetch available cloud models (await so chips render after load)
  await fetchAvailableCloudModels();
  installedModels = (mRes && mRes.models) || [];
  const saved = (sRes && sRes.modelAssignments) || {};
  const savedCloud = (sRes && sRes.cloudModelAssignments) || {};
  // Sync API keys state for mode label
  if (apiKeySettings && apiKeySettings.cloudMode) apiKeysState.cloudMode = apiKeySettings.cloudMode;
  localAssignments = { ...DEFAULT_ASSIGNMENTS };
  cloudAssignments = {};
  // An explicit value wins — including an empty string, which is how the host
  // sets a category to "None" (must NOT fall back to the default on reload).
  for (const k of MODEL_KEYS) if (k in saved) localAssignments[k] = saved[k] ?? '';
  for (const k of MODEL_KEYS) if (k in savedCloud) cloudAssignments[k] = savedCloud[k] ?? '';
  // Legacy: older settings stored separate thinking/fast chat models —
  // migrate the old "thinking" choice to the single chat role.
  if (!saved.chat && saved.chat_thinking) localAssignments.chat = saved.chat_thinking;
  else if (!saved.chat && saved.chat_fast) localAssignments.chat = saved.chat_fast;
  $('modelsCount').textContent = installedModels.length + ' model' + (installedModels.length === 1 ? '' : 's') + ' installed';
  renderModelsGrid();
}

function suggestFor(key) {
  if (key === 'vision') {
    const v = installedModels.find((m) => /vl|vision|llava/i.test(m.name));
    if (v) return v.name;
  }
  if (key === 'code') {
    const c = installedModels.find((m) => /coder|deepseek-coder/i.test(m.name));
    if (c) return c.name;
  }
  if (key === 'chat' || key === 'chat_thinking') {
    const t = installedModels.find((m) => /qwen3|deepseek-r1|qwq/i.test(m.name));
    if (t) return t.name;
  }
  if (key === 'extraction') {
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
  // The dedicated Chat (Thinking) card only matters when the base Chat model
  // can't think — when Chat supports thinking, the toggle just flips the flag
  // on that same model and there's nothing extra to configure.
  const chatSupportsThinking = !!installedModels.find((m) => m.name === localAssignments.chat)?.supportsThinking;
  const visibleKeys = MODEL_KEYS.filter((k) => k !== 'chat_thinking' || !chatSupportsThinking);

  // ── Local section ──────────────────────────────
  const localSection = visibleKeys.map((key) => {
    const cur = localAssignments[key];
    const suggestion = suggestFor(key);
    const chips = installedModels
      .map((m) => {
        const sel = m.name === cur;
        const size = m.details && m.details.parameter_size
          ? `<span class="chip-size">${esc(m.details.parameter_size)}</span>`
          : '';
        const noThink = (key === 'chat' || key === 'chat_thinking') && m.supportsThinking === false;
        return `<button class="model-chip${sel ? ' selected' : ''}" data-key="${key}" data-model="${m.name}">${esc(m.name)}${noThink ? '<span class="chip-nothink">no thinking</span>' : ''}${size}</button>`;
      })
      .join('');
    const thinkingNote = key === 'chat' && cur && !installedModels.find((m) => m.name === cur)?.supportsThinking
      ? '<div class="model-note">⚠️ This model has no thinking mode — a separate Thinking model below is used while the Thinking toggle is on.</div>'
      : '';
    const thinkingRoleNote = key === 'chat_thinking'
      ? '<div class="model-note">Used only when the Thinking toggle is ON, because the Chat model above can\'t think.</div>'
      : '';
    const suggBtn = suggestion && suggestion !== cur
      ? `<button class="model-chip suggestion" data-key="${key}" data-model="${suggestion}">✨ ${esc(suggestion)}</button>`
      : '';
    const noneBtn = `<button class="model-chip none${cur === '' ? ' selected' : ''}" data-key="${key}" data-model="" title="Clear this category — no model used">None</button>`;
    return `<div class="model-card">
      <div class="model-card-head">
        <span class="model-card-icon">${MODEL_ICONS[key]}</span>
        <div class="model-card-titles">
          <div class="model-card-label">${MODEL_LABELS[key]}</div>
          <div class="model-card-key">${key.replace(/_/g, ' ')}</div>
        </div>
        <span class="model-card-current" title="${cur ? esc(cur) : 'No model assigned'}">${cur ? esc(cur) : 'None'}</span>
      </div>
      ${thinkingNote}
      ${thinkingRoleNote}
      <div class="model-chips">
        ${noneBtn}
        ${installedModels.length ? chips : '<span style="font-size:11px;color:var(--text-muted)">No models installed</span>'}
        ${suggBtn}
      </div>
    </div>`;
  }).join('');

  // ── Cloud section ──────────────────────────────
  const cloudLoading = fetchingCloudModels
    ? '<div class="models-loading">Fetching Ollama Cloud models…</div>'
    : availableCloudModels.length === 0
      ? `<div class="models-loading">${cloudModelsError ? '⚠️ ' + esc(cloudModelsError) : 'No Ollama Cloud models found. Check your endpoint and API key in the API Keys tab.'}</div>`
    : '';

  // Estimate usage level for a model (1=light, 4=heavy) based on name patterns
  function estimateUsageLevel(modelId) {
    const id = modelId.toLowerCase();
    // Level 4 — extra heavy (200B+)
    if (/(671b|675b|480b|1t|120b)/.test(id)) return { level: 4, label: 'Heavy', color: '#c44' };
    // Level 3 — heavy (70B-199B)
    if (/(120b|123b|235b|250b|405b|70b)/.test(id)) return { level: 3, label: 'High', color: '#b86' };
    // Level 2 — moderate (13B-69B)
    if (/(27b|30b|33b|34b|8b|14b|9b)/.test(id) && !/(20b)/.test(id)) return { level: 2, label: 'Moderate', color: '#5b7fa6' };
    // Level 1 — light (<13B)
    return { level: 1, label: 'Light', color: '#4a9' };
  }

  // Cloud tier limits (from ollama.com/pricing)
  const tierInfo = (() => {
    // Try to detect tier from cloud usage data
    if (cloudUsageData && cloudUsageData.monthlyLimit > 0) {
      if (cloudUsageData.monthlyLimit > 50000) return { tier: 'Max', color: '#c44' };
      if (cloudUsageData.monthlyLimit > 5000) return { tier: 'Pro', color: '#5b7fa6' };
    }
    return { tier: 'Free', color: '#4a9' };
  })();

  // Build usage progress bar for the models tab
  let usageBarHtml = '';
  if (cloudUsageData && (cloudUsageData.totalRequests > 0 || cloudUsageData.monthlyLimit > 0)) {
    const used = cloudUsageData.totalRequests;
    const limit = cloudUsageData.monthlyLimit || 0;
    const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    const tokens = cloudUsageData.totalTokens > 0 ? `~${formatTokenCount(cloudUsageData.totalTokens)} tokens` : '';
    usageBarHtml = `
      <div class="models-usage-bar">
        <div class="models-usage-info">
          <span class="models-usage-tier" style="color:${tierInfo.color}">${tierInfo.tier} tier</span>
          ${limit > 0
            ? `<span class="models-usage-count">${used} / ${limit} requests (${pct}%)</span>`
            : `<span class="models-usage-count">${used} requests</span>`}
          ${tokens ? `<span class="models-usage-tokens">${tokens}</span>` : ''}
        </div>
        ${limit > 0 ? `<div class="models-usage-track"><div class="models-usage-fill" style="width:${Math.min(100, pct)}%;background:${pct >= 90 ? 'var(--red)' : pct >= 70 ? 'var(--orange)' : 'var(--accent)'}"></div></div>` : ''}
      </div>`;
  }

  const cloudSection = visibleKeys.map((key) => {
    const cur = cloudAssignments[key] || '';
    const chips = availableCloudModels
      .map((m) => {
        const sel = m.id === cur;
        const usage = estimateUsageLevel(m.id);
        return `<button class="model-chip cloud-chip${sel ? ' selected' : ''}" data-key="${key}" data-model="${esc(m.id)}" title="Usage: ${usage.label} (Level ${usage.level})">${esc(m.id)}<span class="chip-usage" style="color:${usage.color}">${usage.level}</span></button>`;
      })
      .join('');
    const noneBtn = `<button class="model-chip cloud-chip none${cur === '' ? ' selected' : ''}" data-key="${key}" data-model="" title="Clear this category — no cloud model used">None</button>`;
    return `<div class="model-card">
      <div class="model-card-head">
        <span class="model-card-icon">${MODEL_ICONS[key]}</span>
        <div class="model-card-titles">
          <div class="model-card-label">${MODEL_LABELS[key]}</div>
          <div class="model-card-key">${key.replace(/_/g, ' ')}</div>
        </div>
        <span class="model-card-current" title="${cur ? esc(cur) : 'No cloud model'}">${cur ? esc(cur) : 'Not set'}</span>
      </div>
      <div class="model-chips">
        ${noneBtn}
        ${availableCloudModels.length ? chips : (fetchingCloudModels ? '<span class="models-loading-small">Loading…</span>' : '<span style="font-size:11px;color:var(--text-muted)">No Ollama Cloud models — configure endpoint and API key in API Keys tab</span>')}
      </div>
    </div>`;
  }).join('');

  grid.innerHTML = `
    <div class="models-section">
      <div class="models-section-header">
        <span class="section-icon">🖥️</span>
        <div>
          <h3>Local Models (Ollama)</h3>
          <p>Pick from installed Ollama models on this machine</p>
        </div>
      </div>
      <div class="models-grid-inner">${localSection}</div>
    </div>
    <div class="models-section">
      <div class="models-section-header">
        <span class="section-icon">☁️</span>
        <div>
          <h3>Ollama Cloud</h3>
          <p>Pick from Ollama Cloud models (used when mode is Auto or Cloud)</p>
        </div>
        <button class="cloud-refresh-btn" id="refreshCloudModelsBtn" title="Refresh Ollama Cloud models">🔄 Refresh</button>
      </div>
      ${cloudLoading}
      ${usageBarHtml}
      <div class="models-grid-inner">${cloudSection}</div>
    </div>
  `;

  // Local model chip clicks (exclude cloud chips which also have .model-chip)
  grid.querySelectorAll('.model-chip:not(.cloud-chip)').forEach((chip) => {
    chip.addEventListener('click', () => {
      localAssignments[chip.dataset.key] = chip.dataset.model;
      renderModelsGrid();
      const status = $('modelsSaveStatus');
      status.textContent = 'Unsaved changes';
      status.className = 'save-status';
    });
  });

  // Cloud model chip clicks
  grid.querySelectorAll('.cloud-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      cloudAssignments[chip.dataset.key] = chip.dataset.model;
      renderModelsGrid();
      const status = $('modelsSaveStatus');
      status.textContent = 'Unsaved changes';
      status.className = 'save-status';
    });
  });

  // Refresh cloud models button
  const refreshBtn = $('refreshCloudModelsBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.textContent = '⏳ Loading…';
      refreshBtn.disabled = true;
      await fetchAvailableCloudModels();
      renderModelsGrid();
      refreshBtn.textContent = '🔄 Refresh';
      refreshBtn.disabled = false;
    });
  }

  // Update summary banner
  updateModelsSummary();
}

function updateModelsSummary() {
  const summaryEl = $('modelsSummary');
  if (!summaryEl) return;
  summaryEl.style.display = 'flex';
  // Count local assignments (non-empty)
  const localCount = MODEL_KEYS.filter(k => localAssignments[k] && localAssignments[k] !== '').length;
  // Count cloud assignments (non-empty)
  const cloudCount = MODEL_KEYS.filter(k => cloudAssignments[k] && cloudAssignments[k] !== '').length;
  $('localAssignedCount').textContent = localCount;
  $('cloudAssignedCount').textContent = cloudCount;
  // Show current mode
  const modeEl = $('modelsModeLabel');
  if (modeEl && apiKeysState.cloudMode) {
    const mode = apiKeysState.cloudMode;
    modeEl.textContent = mode === 'auto' ? 'Auto' : mode === 'local' ? 'Local Only' : 'Cloud Only';
    modeEl.className = 'ms-value mode-' + mode;
  }
}

$('modelsSaveBtn').addEventListener('click', async () => {
  const status = $('modelsSaveStatus');
  status.textContent = 'Saving…';
  status.className = 'save-status';
  const res = await API.saveSettings({ modelAssignments: localAssignments, cloudModelAssignments: cloudAssignments });
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
  cloudAssignments = {};
  renderModelsGrid();
  const status = $('modelsSaveStatus');
  status.textContent = 'Defaults loaded — click Save';
  status.className = 'save-status';
});

// ══════════════════════════════════════════════════════
// Speed Test View — timeline + detail modal
// ══════════════════════════════════════════════════════
const MODEL_STYLES = {
  chat: { color: '#c084fc', bg: 'rgba(168,85,247,0.15)' },
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

// ══════════════════════════════════════════════════════
// Plugins View — CURATED CATALOG. Shows only plugins from the official
// catalog repo (Kasikexe/Kasalix-AI-Plugins). The backend gates installs to
// catalog entries, so the host can never install an arbitrary third-party
// repo. Listing + catalog are public reads; mutations require admin auth.
let pluginsLoaded = false;
let pluginsRenderedAuthed = null;

async function enterPluginsView() {
  const $locked = $('pluginsLocked');
  if ($locked) $locked.style.display = settingsAuthed ? 'none' : 'block';
  // Re-render when the admin-lock state changes (unlock/lock while on the tab)
  // so the action buttons appear/disappear immediately.
  if (pluginsLoaded && pluginsRenderedAuthed === settingsAuthed) return;
  pluginsLoaded = true;
  pluginsRenderedAuthed = settingsAuthed;
  await loadPluginCatalog();
}

async function loadPluginCatalog() {
  const $catalog = $('pluginsCatalog');
  if (!$catalog) return;
  const $count = $('pluginsCount');
  $catalog.innerHTML = '<div class="plugins-loading">Loading catalog…</div>';
  try {
    const data = await API.getPluginCatalog();
    if (data && data.error) {
      $catalog.innerHTML = `<div class="plugins-empty">
        <p>${escapeHtml(data.error)}</p>
        <p class="plugins-empty-sub">Create the <code>${escapeHtml(data.repo || 'plugins catalog')}</code> repo with a <code>catalog.json</code> at its root listing your plugins, then hit Refresh.</p>
      </div>`;
      if ($count) $count.textContent = '0 available';
      return;
    }
    const plugins = (data && data.plugins) || [];
    if ($count) $count.textContent = plugins.length + ' available';
    if (plugins.length === 0) {
      $catalog.innerHTML = `<div class="plugins-empty">
        <p>No plugins in the catalog yet.</p>
        <p class="plugins-empty-sub">Add entries to <code>catalog.json</code> in <code>${escapeHtml((data && data.repo) || 'the catalog repo')}</code> and hit Refresh.</p>
      </div>`;
      return;
    }
    $catalog.innerHTML = plugins.map((p) => pluginCard(p, settingsAuthed)).join('');
    bindPluginActions(plugins);
  } catch (e) {
    $catalog.innerHTML = `<div class="plugins-empty"><p>Failed to load the plugin catalog: ${escapeHtml(e instanceof Error ? e.message : 'unknown error')}</p></div>`;
  }
}

function pluginCard(p, authed) {
  const isEnabled = p.enabled === true;
  const badge = p.installed
    ? `<span class="plugin-badge plugin-badge-installed" title="Installed v${escapeHtml(p.installedVersion || p.version)}">${isEnabled ? '✓ Enabled' : '⏸ Disabled'}</span>`
    : `<span class="plugin-badge">${escapeHtml(p.version)}</span>`;
  const actions = p.installed
    ? (authed
        ? `<button class="btn btn-small btn-ghost" data-act="toggle" data-id="${escapeHtml(p.id)}" data-enabled="${isEnabled ? 'true' : 'false'}">${isEnabled ? 'Disable' : 'Enable'}</button>
           <button class="btn btn-small btn-ghost" data-act="update" data-id="${escapeHtml(p.id)}">Update</button>
           <button class="btn btn-small btn-danger" data-act="uninstall" data-id="${escapeHtml(p.id)}">Remove</button>`
        : `<span class="plugin-installed-note">Installed — unlock admin to manage</span>`)
    : (authed
        ? `<button class="btn btn-small btn-primary" data-act="install" data-id="${escapeHtml(p.id)}" data-source="${escapeHtml(p.source)}">Install</button>`
        : `<span class="plugin-installed-note">🔒 Unlock admin to install</span>`);
  return `<div class="plugin-card">
    <div class="plugin-icon">${p.icon ? escapeHtml(p.icon) : '🧩'}</div>
    <div class="plugin-body">
      <div class="plugin-title-row">
        <span class="plugin-name">${escapeHtml(p.name)}</span>
        ${badge}
      </div>
      <p class="plugin-desc">${escapeHtml(p.description || 'No description provided.')}</p>
      <p class="plugin-meta">${escapeHtml(p.author ? p.author + ' · ' : '')}${escapeHtml(p.source)}</p>
    </div>
    <div class="plugin-actions">${actions}</div>
  </div>`;
}

async function bindPluginActions(plugins) {
  document.querySelectorAll('#pluginsCatalog [data-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const act = btn.dataset.act;
      const id = btn.dataset.id;
      btn.disabled = true;
      const status = $('pluginsStatus');
      try {
        let res;
        if (act === 'install') {
          status.textContent = 'Installing…';
          res = await API.installPlugin(btn.dataset.source);
          if (res && res.success) {
            status.textContent = 'Installed ✓';
            pluginsLoaded = false; // re-fetch next time so badge flips
            await loadPluginCatalog();
            return;
          }
          status.textContent = '';
          alert((res && res.error) || 'Install failed');
        } else if (act === 'toggle') {
          const enable = btn.dataset.enabled !== 'true';
          status.textContent = enable ? 'Enabling…' : 'Disabling…';
          res = await API.togglePlugin(id, enable);
          if (res && res.success) status.textContent = enable ? 'Enabled ✓' : 'Disabled ✓';
          else { status.textContent = ''; alert((res && res.error) || 'Failed to toggle'); }
        } else if (act === 'update') {
          status.textContent = 'Updating…';
          res = await API.updatePlugin(id);
          if (res && res.success) status.textContent = 'Updated ✓';
          else { status.textContent = ''; alert((res && res.error) || 'Update failed'); }
        } else if (act === 'uninstall') {
          if (!confirm(`Remove the "${id}" plugin?`)) return;
          status.textContent = 'Removing…';
          res = await API.uninstallPlugin(id);
          if (res && res.success) status.textContent = 'Removed ✓';
          else { status.textContent = ''; alert((res && res.error) || 'Uninstall failed'); }
        }
        // Refresh after any successful mutation so installed badges stay accurate.
        if (res && res.success) {
          pluginsLoaded = false;
          await loadPluginCatalog();
        }
      } catch (e) {
        status.textContent = '';
        alert(e instanceof Error ? e.message : 'Plugin action failed');
      } finally {
        btn.disabled = false;
      }
    });
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// Refresh button + re-render when the admin panel is unlocked.
const pluginsRefreshBtn = $('pluginsRefreshBtn');
if (pluginsRefreshBtn) {
  pluginsRefreshBtn.addEventListener('click', async () => {
    pluginsLoaded = false;
    pluginsRenderedAuthed = null;
    await loadPluginCatalog();
    const $locked = $('pluginsLocked');
    if ($locked) $locked.style.display = settingsAuthed ? 'none' : 'block';
  });
}

// Check GitHub release version on init
async function checkLatestRelease() {
  try {
    const [release, appInfo] = await Promise.all([
      API.checkGitHubRelease(),
      API.getAppInfo(),
    ]);
    if (!release || !release.version || !appInfo?.version) return;

    const latest = release.version.replace(/^v/i, '');
    const current = appInfo.version.replace(/^v/i, '');

    // Always show badge
    const badge = $('releaseVersion');
    if (badge) badge.textContent = 'v' + latest + ' available';

    // Compare versions — skip if same or if dismissed this session
    if (latest === current) return;
    if (sessionStorage.getItem('updateDismissed') === latest) return;

    // Show banner
    const banner = $('updateBanner');
    const versionEl = $('updateBannerVersion');
    const descEl = $('updateBannerDesc');
    if (banner && versionEl) {
      versionEl.textContent = 'Update available: v' + latest + ' (you have v' + current + ')';
      if (descEl && release.name) descEl.textContent = release.name;
      banner.style.display = 'block';
    }
  } catch {}
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

  // Load routing mode pill
  refreshModePill();

  // Check for latest GitHub release
  checkLatestRelease();

// Dismiss update banner
$('updateBannerDismiss')?.addEventListener('click', () => {
  const banner = $('updateBanner');
  if (banner) banner.style.display = 'none';
  // Remember dismissal for this session
  const versionEl = $('updateBannerVersion');
  if (versionEl) {
    const match = versionEl.textContent.match(/v([\d.]+)/);
    if (match) sessionStorage.setItem('updateDismissed', match[1]);
  }
});

  // Run startup sequence
  runStartup();
});

// ══════════════════════════════════════════════════════
// Toast Notifications
// ══════════════════════════════════════════════════════
function ensureToastContainer() {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  return container;
}

function showToast(message, type = 'info', duration = 5000) {
  const container = ensureToastContainer();
  const icons = { error: '❌', warning: '⚠️', success: '✅', info: 'ℹ️' };
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || 'ℹ️'}</span>
    <span class="toast-text">${message}</span>
    <button class="toast-close" title="Dismiss">✕</button>
  `;
  const close = () => {
    toast.classList.add('toast-exit');
    setTimeout(() => toast.remove(), 300);
  };
  toast.querySelector('.toast-close').addEventListener('click', close);
  container.appendChild(toast);
  if (duration > 0) setTimeout(close, duration);
  return toast;
}

// Expose globally so other scripts/modules can use it
window.showToast = showToast;

// ══════════════════════════════════════════════════════
// API Keys View
// ══════════════════════════════════════════════════════
let apiKeysState = {
  cloudMode: 'auto', // 'auto' | 'local' | 'cloud'
  cloudApiKey: '',
  cloudEndpoint: '',
};

async function enterApiKeysView() {
  // Load current settings from backend
  try {
    const settings = await API.getApiKeySettings();
    if (settings) {
      if (settings.cloudMode) apiKeysState.cloudMode = settings.cloudMode;
      if (settings.cloudApiKey !== undefined) apiKeysState.cloudApiKey = settings.cloudApiKey;
      if (settings.cloudEndpoint !== undefined) apiKeysState.cloudEndpoint = settings.cloudEndpoint;
    }
  } catch {}
  // Load usage limits
  try {
    const usage = await API.getCloudUsage();
    if (usage) {
      const limitInput = $('cloudUsageLimitInput');
      const budgetInput = $('cloudTokenBudgetInput');
      if (limitInput) limitInput.value = usage.monthlyLimit || '';
      if (budgetInput) budgetInput.value = usage.tokenBudget || '';
    }
  } catch {}
  renderApiKeysView();
}

function renderApiKeysView() {
  // Update mode buttons
  document.querySelectorAll('.apikeys-mode-btn').forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.mode === apiKeysState.cloudMode);
  });
  // Update inputs
  const keyInput = $('cloudApiKeyInput');
  const endpointInput = $('cloudEndpointInput');
  if (keyInput) keyInput.value = apiKeysState.cloudApiKey;
  if (endpointInput) endpointInput.value = apiKeysState.cloudEndpoint;
  // Update key status indicator
  updateApiKeyStatus();
}

function updateApiKeyStatus() {
  const statusEl = $('apiKeyStatus');
  const dotEl = $('apiKeyDot');
  const textEl = $('apiKeyStatusText');
  const maskedEl = $('apiKeyMasked');
  if (!statusEl) return;
  if (apiKeysState.cloudApiKey && apiKeysState.cloudApiKey.length > 0) {
    statusEl.classList.add('has-key');
    dotEl.className = 'dot dot-online';
    textEl.textContent = 'Key configured';
    // Show masked version: first 4 chars + stars + last 4 chars
    const k = apiKeysState.cloudApiKey;
    if (k.length > 8) maskedEl.textContent = k.slice(0, 4) + '••••••••' + k.slice(-4);
    else maskedEl.textContent = '••••••••';
  } else {
    statusEl.classList.remove('has-key');
    dotEl.className = 'dot dot-offline';
    textEl.textContent = 'No key configured';
    maskedEl.textContent = '';
  }
}

// Mode button clicks
document.querySelectorAll('.apikeys-mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    apiKeysState.cloudMode = btn.dataset.mode;
    renderApiKeysView();
  });
});

// Toggle API key visibility
$('toggleApiKeyVisibility').addEventListener('click', () => {
  const input = $('cloudApiKeyInput');
  if (input.type === 'password') {
    input.type = 'text';
  } else {
    input.type = 'password';
  }
});

// Save button
$('apikeysSaveBtn').addEventListener('click', async () => {
  const status = $('apikeysStatus');
  status.textContent = 'Saving…';
  status.className = 'save-status';

  apiKeysState.cloudApiKey = ($('cloudApiKeyInput').value || '').trim();
  apiKeysState.cloudEndpoint = ($('cloudEndpointInput').value || '').trim();

  // Auto-fill endpoint to ollama.com if API key is set but endpoint is empty
  if (apiKeysState.cloudApiKey && !apiKeysState.cloudEndpoint) {
    apiKeysState.cloudEndpoint = 'https://ollama.com';
    $('cloudEndpointInput').value = 'https://ollama.com';
  }

  const res = await API.saveApiKeySettings({
    cloudMode: apiKeysState.cloudMode,
    cloudApiKey: apiKeysState.cloudApiKey,
    cloudEndpoint: apiKeysState.cloudEndpoint,
  });

  if (res && !res.error) {
    status.textContent = '✓ Saved';
    status.className = 'save-status ok';
    updateApiKeyStatus();
    refreshModePill();
    // Save usage limits
    const monthlyLimit = parseInt($('cloudUsageLimitInput')?.value) || 0;
    const tokenBudget = parseInt($('cloudTokenBudgetInput')?.value) || 0;
    await API.setCloudUsageLimit({ monthlyLimit, tokenBudget });
    refreshCloudUsage();
    setTimeout(() => { status.textContent = ''; }, 2500);
  } else {
    status.textContent = '❌ ' + ((res && res.error) || 'Failed to save');
    status.className = 'save-status err';
  }
});

// Connection test button
$('testApiKeyBtn').addEventListener('click', async () => {
  const resultEl = $('testResult');
  const btn = $('testApiKeyBtn');
  btn.disabled = true;
  resultEl.textContent = 'Testing…';
  resultEl.className = 'apikeys-test-result test-testing';
  // Collect current values
  const key = ($('cloudApiKeyInput').value || '').trim();
  const endpoint = ($('cloudEndpointInput').value || '').trim();
  if (!key) {
    resultEl.textContent = '❌ No API key entered';
    resultEl.className = 'apikeys-test-result test-error';
    btn.disabled = false;
    return;
  }
  // Save first, then attempt a quick request through the backend
  await API.saveApiKeySettings({
    cloudMode: apiKeysState.cloudMode,
    cloudApiKey: key,
    cloudEndpoint: endpoint,
  });
  apiKeysState.cloudApiKey = key;
  apiKeysState.cloudEndpoint = endpoint;
  try {
    // Use getSettings as a lightweight connectivity check
    const res = await API.getSettings();
    if (res && !res.error) {
      resultEl.textContent = '✓ Settings reachable — key saved';
      resultEl.className = 'apikeys-test-result test-success';
    } else {
      resultEl.textContent = '⚠ Key saved but backend unreachable';
      resultEl.className = 'apikeys-test-result test-error';
    }
  } catch (e) {
    resultEl.textContent = '❌ ' + (e.message || 'Connection failed');
    resultEl.className = 'apikeys-test-result test-error';
  }
  btn.disabled = false;
  setTimeout(() => { resultEl.textContent = ''; }, 5000);
});

// Cloud unavailable notification — called from dashboard update or backend events
API.onServerLog((text) => {
  if (text && text.includes('[cloud] Unavailable')) {
    showToast('Cloud provider unavailable. Falling back to local models.', 'warning', 6000);
  }
});

// Reset usage counters button
$('resetUsageBtn').addEventListener('click', async () => {
  const resultEl = $('resetUsageResult');
  const btn = $('resetUsageBtn');
  btn.disabled = true;
  resultEl.textContent = 'Resetting…';
  resultEl.className = 'apikeys-test-result test-testing';
  try {
    const res = await API.resetCloudUsage();
    if (res && !res.error) {
      resultEl.textContent = '✓ Usage counters reset';
      resultEl.className = 'apikeys-test-result test-success';
      refreshCloudUsage();
    } else {
      resultEl.textContent = '❌ ' + ((res && res.error) || 'Failed');
      resultEl.className = 'apikeys-test-result test-error';
    }
  } catch (e) {
    resultEl.textContent = '❌ ' + (e.message || 'Failed');
    resultEl.className = 'apikeys-test-result test-error';
  }
  btn.disabled = false;
  setTimeout(() => { resultEl.textContent = ''; }, 5000);
});

// ─── Trajectory Panel ─────────────────────────────────────────────────
const TRAJECTORY_ICONS = {
  'run:start': '▶️', 'run:end': '⏹️', 'message': '💬',
  'tool:call': '🔧', 'tool:result': '📋', 'plan': '📝',
  'plan:update': '✅', 'verify': '🔍', 'thinking': '🧠',
  'stage': '🔄', 'error': '❌',
};
const TRAJECTORY_CLASSES = {
  'run:start': 'te-run', 'run:end': 'te-run', 'message': 'te-message',
  'tool:call': 'te-tool-call', 'tool:result': 'te-tool-result',
  'plan': 'te-plan', 'plan:update': 'te-plan', 'verify': 'te-verify',
  'thinking': 'te-message', 'stage': 'te-stage', 'error': 'te-error',
};

async function loadTrajectorySessions() {
  const sel = $('trajectorySelect');
  if (!sel) return;
  try {
    const result = await API.listSessionLogs();
    const logs = (result && result.logs) || [];
    sel.innerHTML = '';
    if (logs.length === 0) {
      sel.innerHTML = '<option value="">No sessions yet</option>';
      return;
    }
    for (const log of logs) {
      const opt = document.createElement('option');
      opt.value = log.runId;
      opt.textContent = `${log.runId} (${new Date(log.mtime).toLocaleString()})`;
      sel.appendChild(opt);
    }
    sel.value = logs[0].runId;
    await loadTrajectoryEvents(logs[0].runId);
  } catch {
    sel.innerHTML = '<option value="">Failed to load</option>';
  }
}

async function loadTrajectoryEvents(runId) {
  const container = $('trajectoryEvents');
  if (!container || !runId) return;
  container.innerHTML = '<div class="log-empty">Loading…</div>';
  try {
    const result = await API.readSessionLog(runId);
    const events = (result && result.events) || [];
    if (events.length === 0) {
      container.innerHTML = '<div class="log-empty">No events in this session.</div>';
      return;
    }
    container.innerHTML = '';
    for (const ev of events) {
      const cls = TRAJECTORY_CLASSES[ev.type] || 'te-message';
      const icon = TRAJECTORY_ICONS[ev.type] || '•';
      const label = ev.type.replace(/:/g, ' ');
      const time = new Date(ev.ts).toLocaleTimeString();
      const statusHtml = ev.meta?.ok === false || ev.meta?.passed === false
        ? '<span class="te-status failed">failed</span>'
        : (ev.meta?.passed === true ? '<span class="te-status passed">passed</span>' : '');
      const roleHtml = ev.role
        ? `<span class="te-tag">${esc(ev.role)}</span>`
        : '';
      const labelHtml = ev.label
        ? `<span class="te-tag">${esc(ev.label)}</span>`
        : '';
      let contentHtml = '';
      if (ev.content && ev.content.length > 0) {
        const preview = ev.content.length > 200 ? ev.content.slice(0, 200) + '…' : ev.content;
        contentHtml = `<div class="te-content" onclick="this.classList.toggle('expanded')">${esc(preview)}</div>`;
      }
      const div = document.createElement('div');
      div.className = `trajectory-event ${cls}`;
      div.innerHTML = `
        <div class="te-header">
          <span class="te-icon">${icon}</span>
          <span class="te-label">${esc(label)}</span>
          ${labelHtml}${roleHtml}${statusHtml}
          <span class="te-time">${time}</span>
        </div>
        ${contentHtml}`;
      container.appendChild(div);
    }
    container.scrollTop = container.scrollHeight;
  } catch (e) {
    container.innerHTML = `<div class="log-empty">Error loading trajectory: ${esc(String(e))}</div>`;
  }
}

$('toggleTrajectoryBtn')?.addEventListener('click', () => {
  const panel = $('trajectoryPanel');
  const card = $('trajectoryCard');
  if (panel.style.display === 'none') {
    panel.style.display = 'block';
    card.classList.remove('log-collapsed');
    loadTrajectorySessions();
  } else {
    panel.style.display = 'none';
    card.classList.add('log-collapsed');
  }
});

$('trajectorySelect')?.addEventListener('change', (e) => {
  const runId = e.target.value;
  if (runId) loadTrajectoryEvents(runId);
});

let trajectoryRefreshInterval = null;
function startTrajectoryRefresh() {
  const card = $('trajectoryCard');
  if (card) card.style.display = 'block';
  loadTrajectorySessions();
  trajectoryRefreshInterval = setInterval(loadTrajectorySessions, 30000);
}
function stopTrajectoryRefresh() {
  if (trajectoryRefreshInterval) { clearInterval(trajectoryRefreshInterval); trajectoryRefreshInterval = null; }
}

// ══════════════════════════════════════════════════════
// Ollama Settings View
// ══════════════════════════════════════════════════════
let ollamaSettings = { kvCacheOffload: true, kvCacheType: 'f16', defaultNumCtx: 0 };
let ollamaSettingsLoaded = false;
let ollamaGpuInfo = null; // { memTotal, memUsed, name }
let ollamaRamInfo = null; // { total, used, free, usagePercent }
let ollamaSettingsSnapshot = null; // snapshot when settings were loaded
let pendingOllamaTargetView = null; // view to switch to after discard/save

// VRAM estimates for a 7B model as baseline (in MB)
const BASELINE_KV_VRAM_MB = {
  f32: 2048,
  f16: 1024,
  q8_0: 512,
  q4_0: 256,
};
const BASELINE_MODEL_VRAM_MB = 4096; // model weights for 7B Q4

async function enterOllamaView() {
  // Load current settings
  if (!ollamaSettingsLoaded) {
    try {
      const settings = await API.getSettings();
      if (settings) {
        ollamaSettings.kvCacheOffload = settings.kvCacheOffload !== false;
        ollamaSettings.kvCacheType = settings.kvCacheType || 'f16';
        ollamaSettings.defaultNumCtx = settings.defaultNumCtx || 0;
      }
    } catch {}
    ollamaSettingsLoaded = true;
    // Save snapshot for unsaved-changes detection
    ollamaSettingsSnapshot = { ...ollamaSettings };
  }

  // Get GPU + RAM info for estimates
  try {
    const stats = await API.getStats();
    ollamaGpuInfo = stats?.gpu || null;
    ollamaRamInfo = stats?.ram || null;
  } catch {}
  updateHardwareInfo();

  // Apply to GPU/RAM buttons
  updateKvOffloadCards();

  // Apply KV cache type cards
  updateQuantCards();

  // Apply context length
  const numCtxSlider = $('numCtxSlider');
  const numCtxValue = $('numCtxValue');
  if (numCtxSlider) {
    numCtxSlider.value = ollamaSettings.defaultNumCtx;
    if (numCtxValue) numCtxValue.textContent = ollamaSettings.defaultNumCtx === 0 ? 'Auto' : formatNumCtx(ollamaSettings.defaultNumCtx);
  }
  updateCtxPresets();
  updateCtxMemoryEstimate();

  // Load Ollama status
  refreshOllamaStatus();

  // Load model catalog
  loadModelCatalog();

  // Update save button state
  updateOllamaSaveBtn();
}

function updateOllamaSaveBtn() {
  const btn = $('ollamaSaveBtn');
  if (!btn) return;
  btn.disabled = false;
}

function hasOllamaUnsavedChanges() {
  if (!ollamaSettingsSnapshot) return false;
  return ollamaSettings.kvCacheOffload !== ollamaSettingsSnapshot.kvCacheOffload
    || ollamaSettings.kvCacheType !== ollamaSettingsSnapshot.kvCacheType
    || ollamaSettings.defaultNumCtx !== ollamaSettingsSnapshot.defaultNumCtx;
}

async function refreshOllamaStatus() {
  const runningEl = $('ollamaRunningStatus');
  const ownershipEl = $('ollamaOwnershipStatus');
  const loadedEl = $('ollamaLoadedModels');
  const statusText = $('ollamaStatusText');

  try {
    const status = await API.getOllamaStatus();
    if (runningEl) runningEl.textContent = status.running ? '✅ Running' : '❌ Stopped';
    if (ownershipEl) ownershipEl.textContent = status.ownedByUs ? 'Yes (app started)' : 'No (external)';
    if (loadedEl) {
      const models = status.loadedModels || [];
      loadedEl.textContent = models.length > 0
        ? models.map(m => m.name || m.model).join(', ')
        : 'None loaded';
    }
    if (statusText) statusText.textContent = status.running ? 'Connected' : 'Disconnected';
  } catch {
    if (runningEl) runningEl.textContent = '❌ Unreachable';
    if (statusText) statusText.textContent = 'Unreachable';
  }
}

// ─── Model Database ──────────────────────────────────
const MODEL_DATABASE_FALLBACK = [
  // Qwen 3 family
  { name: 'qwen3:0.6b', family: 'Qwen 3', params: '0.6B', tools: true, thinking: true, vision: false, description: 'Ultra-lightweight Qwen 3 model with tool calling and thinking support.' },
  { name: 'qwen3:1.7b', family: 'Qwen 3', params: '1.7B', tools: true, thinking: true, vision: false, description: 'Lightweight Qwen 3 model good for fast inference with reasoning.' },
  { name: 'qwen3:4b', family: 'Qwen 3', params: '4B', tools: true, thinking: true, vision: false, description: 'Balanced Qwen 3 model with strong tool calling and thinking.' },
  { name: 'qwen3:8b', family: 'Qwen 3', params: '8B', tools: true, thinking: true, vision: false, description: 'Popular mid-size Qwen 3 with excellent reasoning and tool use.' },
  { name: 'qwen3:14b', family: 'Qwen 3', params: '14B', tools: true, thinking: true, vision: false, description: 'Large Qwen 3 model with strong multilingual capabilities.' },
  { name: 'qwen3:32b', family: 'Qwen 3', params: '32B', tools: true, thinking: true, vision: false, description: 'High-capability Qwen 3 for complex reasoning tasks.' },
  { name: 'qwen3:235b', family: 'Qwen 3', params: '235B', tools: true, thinking: true, vision: false, description: 'Flagship Qwen 3 MoE model, top-tier performance.' },
  // Qwen 3 VL (Vision)
  { name: 'qwen3-vl:4b', family: 'Qwen 3 VL', params: '4B', tools: true, thinking: true, vision: true, description: 'Compact vision-language model for image understanding.' },
  { name: 'qwen3-vl:8b', family: 'Qwen 3 VL', params: '8B', tools: true, thinking: true, vision: true, description: 'Mid-size vision model with strong image reasoning.' },
  // Qwen 2.5 family
  { name: 'qwen2.5:0.5b', family: 'Qwen 2.5', params: '0.5B', tools: false, thinking: false, vision: false, description: 'Tiny Qwen 2.5 for edge deployment.' },
  { name: 'qwen2.5:1.5b', family: 'Qwen 2.5', params: '1.5B', tools: false, thinking: false, vision: false, description: 'Small Qwen 2.5 model for quick responses.' },
  { name: 'qwen2.5:3b', family: 'Qwen 2.5', params: '3B', tools: false, thinking: false, vision: false, description: 'Compact Qwen 2.5 with solid performance.' },
  { name: 'qwen2.5:7b', family: 'Qwen 2.5', params: '7B', tools: false, thinking: false, vision: false, description: 'Popular Qwen 2.5 size for general use.' },
  { name: 'qwen2.5:14b', family: 'Qwen 2.5', params: '14B', tools: false, thinking: false, vision: false, description: 'Strong Qwen 2.5 for coding and analysis.' },
  { name: 'qwen2.5:32b', family: 'Qwen 2.5', params: '32B', tools: false, thinking: false, vision: false, description: 'Large Qwen 2.5 for complex tasks.' },
  { name: 'qwen2.5-coder:1.5b', family: 'Qwen 2.5 Coder', params: '1.5B', tools: false, thinking: false, vision: false, description: 'Code-focused small model.' },
  { name: 'qwen2.5-coder:7b', family: 'Qwen 2.5 Coder', params: '7B', tools: false, thinking: false, vision: false, description: 'Code-focused 7B with strong programming skills.' },
  { name: 'qwen2.5-coder:14b', family: 'Qwen 2.5 Coder', params: '14B', tools: false, thinking: false, vision: false, description: 'Large code-focused model for complex programming.' },
  { name: 'qwen2.5-coder:32b', family: 'Qwen 2.5 Coder', params: '32B', tools: false, thinking: false, vision: false, description: 'Flagship code model rivaling GPT-4 on coding tasks.' },
  // Llama 4 family
  { name: 'llama4-scout:17b', family: 'Llama 4', params: '17B', tools: true, thinking: false, vision: true, description: 'Meta Llama 4 Scout — 17B with vision support.' },
  { name: 'llama4-maverick:17b', family: 'Llama 4', params: '17B', tools: true, thinking: false, vision: true, description: 'Meta Llama 4 Maverick — optimized for speed.' },
  // Llama 3.3
  { name: 'llama3.3:8b', family: 'Llama 3.3', params: '8B', tools: true, thinking: false, vision: false, description: 'Meta Llama 3.3 8B — solid general-purpose model.' },
  { name: 'llama3.3:70b', family: 'Llama 3.3', params: '70B', tools: true, thinking: false, vision: false, description: 'Meta Llama 3.3 70B — top-tier open model.' },
  // Llama 3.2
  { name: 'llama3.2:1b', family: 'Llama 3.2', params: '1B', tools: false, thinking: false, vision: false, description: 'Ultra-light Llama for edge devices.' },
  { name: 'llama3.2:3b', family: 'Llama 3.2', params: '3B', tools: false, thinking: false, vision: false, description: 'Compact Llama 3.2 for fast inference.' },
  { name: 'llama3.2-vision:11b', family: 'Llama 3.2 Vision', params: '11B', tools: false, thinking: false, vision: true, description: 'Vision-language model for image understanding.' },
  // Llama 3.1
  { name: 'llama3.1:8b', family: 'Llama 3.1', params: '8B', tools: true, thinking: false, vision: false, description: 'Widely-used 8B model with 128K context.' },
  { name: 'llama3.1:70b', family: 'Llama 3.1', params: '70B', tools: true, thinking: false, vision: false, description: 'Large Llama 3.1 for complex reasoning.' },
  { name: 'llama3.1:405b', family: 'Llama 3.1', params: '405B', tools: true, thinking: false, vision: false, description: 'Flagship open model from Meta.' },
  // Gemma 3
  { name: 'gemma3:1b', family: 'Gemma 3', params: '1B', tools: false, thinking: false, vision: true, description: 'Google Gemma 3 — tiny with vision support.' },
  { name: 'gemma3:4b', family: 'Gemma 3', params: '4B', tools: false, thinking: false, vision: true, description: 'Compact Google model with multimodal support.' },
  { name: 'gemma3:12b', family: 'Gemma 3', params: '12B', tools: false, thinking: false, vision: true, description: 'Mid-size Gemma 3 with strong vision capabilities.' },
  { name: 'gemma3:27b', family: 'Gemma 3', params: '27B', tools: false, thinking: false, vision: true, description: 'Large Gemma 3 with excellent multimodal performance.' },
  // Gemma 4
  { name: 'gemma4:12b', family: 'Gemma 4', params: '12B', tools: true, thinking: true, vision: true, description: 'Google Gemma 4 — supports tools, thinking, and vision.' },
  { name: 'gemma4:26b', family: 'Gemma 4', params: '26B', tools: true, thinking: true, vision: true, description: 'Large Gemma 4 with top-tier capabilities.' },
  { name: 'gemma4:31b', family: 'Gemma 4', params: '31B', tools: true, thinking: true, vision: true, description: 'Flagship Gemma 4 model with full feature support.' },
  // Phi family
  { name: 'phi4:3.8b', family: 'Phi 4', params: '3.8B', tools: false, thinking: false, vision: false, description: 'Microsoft Phi 4 — efficient reasoning model.' },
  { name: 'phi4-mini:3.8b', family: 'Phi 4 Mini', params: '3.8B', tools: true, thinking: false, vision: false, description: 'Compact Phi 4 with tool calling support.' },
  { name: 'phi4-reasoning:14b', family: 'Phi 4 Reasoning', params: '14B', tools: false, thinking: true, vision: false, description: 'Phi 4 optimized for mathematical reasoning.' },
  // DeepSeek
  { name: 'deepseek-r1:1.5b', family: 'DeepSeek R1', params: '1.5B', tools: false, thinking: true, vision: false, description: 'DeepSeek R1 distilled — chain-of-thought reasoning.' },
  { name: 'deepseek-r1:7b', family: 'DeepSeek R1', params: '7B', tools: false, thinking: true, vision: false, description: 'DeepSeek R1 7B — strong reasoning for its size.' },
  { name: 'deepseek-r1:14b', family: 'DeepSeek R1', params: '14B', tools: false, thinking: true, vision: false, description: 'DeepSeek R1 14B — excellent math and code reasoning.' },
  { name: 'deepseek-r1:32b', family: 'DeepSeek R1', params: '32B', tools: false, thinking: true, vision: false, description: 'DeepSeek R1 32B — top reasoning model.' },
  { name: 'deepseek-r1:70b', family: 'DeepSeek R1', params: '70B', tools: false, thinking: true, vision: false, description: 'DeepSeek R1 flagship — rivals o1 on reasoning.' },
  // Mistral
  { name: 'mistral:7b', family: 'Mistral', params: '7B', tools: false, thinking: false, vision: false, description: 'Classic Mistral 7B — fast and efficient.' },
  { name: 'mistral-large:123b', family: 'Mistral Large', params: '123B', tools: true, thinking: false, vision: false, description: 'Mistral\'s flagship model.' },
  { name: 'codestral:22b', family: 'Codestral', params: '22B', tools: false, thinking: false, vision: false, description: 'Mistral\'s code-specialized model.' },
  // Command R
  { name: 'command-r:35b', family: 'Command R', params: '35B', tools: true, thinking: false, vision: false, description: 'Cohere Command R — RAG and tool-use focused.' },
  // Code models
  { name: 'codellama:7b', family: 'Code Llama', params: '7B', tools: false, thinking: false, vision: false, description: 'Meta code-focused Llama.' },
  { name: 'codellama:13b', family: 'Code Llama', params: '13B', tools: false, thinking: false, vision: false, description: 'Larger Code Llama for complex programming.' },
  { name: 'codellama:34b', family: 'Code Llama', params: '34B', tools: false, thinking: false, vision: false, description: 'Large Code Llama for serious coding tasks.' },
  // StarCoder
  { name: 'starcoder2:3b', family: 'StarCoder 2', params: '3B', tools: false, thinking: false, vision: false, description: 'Small code generation model.' },
  { name: 'starcoder2:7b', family: 'StarCoder 2', params: '7B', tools: false, thinking: false, vision: false, description: 'Mid-size code model supporting 619 languages.' },
  { name: 'starcoder2:15b', family: 'StarCoder 2', params: '15B', tools: false, thinking: false, vision: false, description: 'Large code model from BigCode.' },
  // Uncensored variants (common community models)
  { name: 'huihui/qwen3-abliterated:1.7b', family: 'Qwen 3', params: '1.7B', tools: true, thinking: true, vision: false, uncensored: true, description: 'Uncensored Qwen 3 1.7B — no content restrictions.' },
  { name: 'huihui/qwen3-abliterated:4b', family: 'Qwen 3', params: '4B', tools: true, thinking: true, vision: false, uncensored: true, description: 'Uncensored Qwen 3 4B — unrestricted responses.' },
  { name: 'huihui/qwen3-abliterated:8b', family: 'Qwen 3', params: '8B', tools: true, thinking: true, vision: false, uncensored: true, description: 'Uncensored Qwen 3 8B — full capability, no guardrails.' },
  { name: 'huihui/qwen3-abliterated:14b', family: 'Qwen 3', params: '14B', tools: true, thinking: true, vision: false, uncensored: true, description: 'Uncensored Qwen 3 14B.' },
  { name: 'huihui/qwen3-abliterated:32b', family: 'Qwen 3', params: '32B', tools: true, thinking: true, vision: false, uncensored: true, description: 'Uncensored Qwen 3 32B — large uncensored model.' },
  { name: 'dolphin-mistral:7b', family: 'Dolphin', params: '7B', tools: false, thinking: false, vision: false, uncensored: true, description: 'Uncensored Dolphin based on Mistral 7B.' },
  { name: 'dolphin-llama3:8b', family: 'Dolphin', params: '8B', tools: false, thinking: false, vision: false, uncensored: true, description: 'Uncensored Dolphin based on Llama 3.' },
  // Gemma 3n
  { name: 'gemma3n:e2b', family: 'Gemma 3n', params: '~3B', tools: false, thinking: false, vision: true, description: 'Google Gemma 3n — efficient Nano model with vision.' },
  { name: 'gemma3n:e4b', family: 'Gemma 3n', params: '~5B', tools: false, thinking: false, vision: true, description: 'Google Gemma 3n — larger efficient model.' },
];

// ─── Model Catalog (fetched from GitHub, fallback to hardcoded) ──
let MODEL_DATABASE = [...MODEL_DATABASE_FALLBACK];
let catalogDbVersion = 'local';
let catalogDbSource = 'local';
const CATALOG_URL = 'https://raw.githubusercontent.com/Kasikexe/Kasalix/main/model-catalog.json';
const CATALOG_CACHE_KEY = 'kasalix_model_catalog';
const CATALOG_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

function updateCatalogDbBadge() {
  const badge = document.getElementById('catalogDbSource');
  if (!badge) return;
  const v = catalogDbVersion === 'local' ? 'v1' : 'v' + catalogDbVersion;
  if (catalogDbSource === 'remote') {
    badge.textContent = '📡 ' + v + ' (remote)';
    badge.className = 'catalog-db-badge catalog-db-remote';
  } else {
    badge.textContent = '💾 ' + v + ' (local)';
    badge.className = 'catalog-db-badge catalog-db-local';
  }
}

async function fetchModelCatalog() {
  try {
    // Check cache first
    const cached = localStorage.getItem(CATALOG_CACHE_KEY);
    if (cached) {
      const { timestamp, data } = JSON.parse(cached);
      if (Date.now() - timestamp < CATALOG_CACHE_TTL && data?.models?.length) {
        MODEL_DATABASE = data.models;
        catalogDbVersion = data.version || 'local';
        catalogDbSource = 'remote';
        updateCatalogDbBadge();
        return;
      }
    }
  } catch {}

  try {
    const res = await fetch(CATALOG_URL);
    if (res.ok) {
      const data = await res.json();
      if (data?.models?.length) {
        MODEL_DATABASE = data.models;
        catalogDbVersion = data.version || 'local';
        catalogDbSource = 'remote';
        // Cache for next time
        localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify({ timestamp: Date.now(), data }));
      }
    }
  } catch {
    // Offline or failed — keep using fallback/last cached version
  }
  updateCatalogDbBadge();
}

// Fetch catalog on load (non-blocking)
fetchModelCatalog();

// ─── Installed models cache ──────────────────────────
let installedModelNames = [];

// ─── Model Catalog Functions ──────────────────────────
async function loadModelCatalog() {
  const installedList = $('catalogInstalledList');
  const browseList = $('catalogBrowseList');

  // Load installed models
  if (installedList) {
    installedList.innerHTML = '<div class="catalog-loading">Loading installed models...</div>';
    try {
      const models = await API.getInstalledModels();
      const modelList = models?.models || [];
      installedModelNames = modelList.map(m => m.name || m.model || '');

      if (modelList.length === 0) {
        installedList.innerHTML = '<div class="catalog-loading">No models installed yet. Search above to find and pull models.</div>';
      } else {
        installedList.innerHTML = modelList.map(m => {
          const name = m.name || m.model || '';
          const size = m.size ? formatBytes(m.size) : '';
          const family = m.details?.family || '';
          const quant = m.details?.quantization_level || '';
          const paramSize = m.details?.parameter_size || '';
          const meta = [family, paramSize, quant].filter(Boolean).join(' · ');
          const dbEntry = MODEL_DATABASE.find(d => name.includes(d.name.split(':')[0]));
          const badges = [];
          if (dbEntry) {
            if (dbEntry.tools) badges.push('<span class="catalog-badge catalog-badge-tools">🔧 Tools</span>');
            if (dbEntry.thinking) badges.push('<span class="catalog-badge catalog-badge-think">🧠 Thinking</span>');
            if (dbEntry.vision) badges.push('<span class="catalog-badge catalog-badge-vision">👁 Vision</span>');
          }
          return `<div class="catalog-model-card catalog-installed" onclick="showModelDetail('${esc(name)}')" title="Click for details">
            <div class="catalog-model-icon">🧠</div>
            <div class="catalog-model-info">
              <div class="catalog-model-name">${esc(name)}</div>
              <div class="catalog-model-meta">${esc(meta)}</div>
              <div class="catalog-model-badges">${badges.join('')}<span class="catalog-badge catalog-badge-installed">✓ Installed</span>${size ? '<span class="catalog-badge catalog-badge-size">' + esc(size) + '</span>' : ''}</div>
            </div>
          </div>`;
        }).join('');
      }
    } catch (e) {
      installedList.innerHTML = `<div class="catalog-loading">Failed to load: ${esc(String(e))}</div>`;
    }
  }

  // Also populate browse if there's a search
  const searchVal = $('catalogSearchInput')?.value?.trim() || '';
  if (searchVal) {
    filterBrowseModels(searchVal);
  } else {
    if (browseList) browseList.innerHTML = '<div class="catalog-loading">Type to search models...</div>';
    const countEl = $('catalogBrowseCount');
    if (countEl) countEl.textContent = '';
  }
}

function filterBrowseModels(query) {
  const browseList = $('catalogBrowseList');
  const countEl = $('catalogBrowseCount');
  if (!browseList) return;

  const q = query.toLowerCase();
  const results = MODEL_DATABASE.filter(m => {
    return m.name.toLowerCase().includes(q)
      || m.family.toLowerCase().includes(q)
      || (m.description || '').toLowerCase().includes(q)
      || (m.uncensored && 'uncensored abliterated'.includes(q))
      || (m.tools && 'tools tool calling'.includes(q))
      || (m.thinking && 'thinking reasoning'.includes(q))
      || (m.vision && 'vision image multimodal'.includes(q));
  });

  if (countEl) countEl.textContent = results.length + ' model' + (results.length !== 1 ? 's' : '');

  if (results.length === 0) {
    browseList.innerHTML = `<div class="catalog-loading">No models found for "${esc(query)}". Try different keywords.</div>`;
    return;
  }

  browseList.innerHTML = results.map(m => {
    const isInstalled = installedModelNames.some(n => n.startsWith(m.name.split(':')[0]));
    const badges = [];
    if (m.tools) badges.push('<span class="catalog-badge catalog-badge-tools">🔧 Tools</span>');
    if (m.thinking) badges.push('<span class="catalog-badge catalog-badge-think">🧠 Thinking</span>');
    if (m.vision) badges.push('<span class="catalog-badge catalog-badge-vision">👁 Vision</span>');
    if (m.uncensored) badges.push('<span class="catalog-badge" style="background:rgba(239,68,68,0.12);color:#f87171;">🔓 Uncensored</span>');

    return `<div class="catalog-model-card" onclick="showModelDetail('${esc(m.name)}')" title="Click for details">
      <div class="catalog-model-icon">${m.uncensored ? '🔓' : '🧠'}</div>
      <div class="catalog-model-info">
        <div class="catalog-model-name">${esc(m.name)}</div>
        <div class="catalog-model-meta">${esc(m.family)} · ${esc(m.params)}</div>
        <div class="catalog-model-badges">${badges.join('')}</div>
      </div>
      <button class="catalog-model-pull-btn ${isInstalled ? 'catalog-pull-installed' : ''}"
        onclick="event.stopPropagation(); ${isInstalled ? '' : `pullModelFromCatalog('${esc(m.name)}')`}"
        ${isInstalled ? 'disabled' : ''}>${isInstalled ? '✓ Installed' : '📥 Pull'}</button>
    </div>`;
  }).join('');
}

function showModelDetail(modelName) {
  const modal = $('modelDetailModal');
  if (!modal) return;

  // Find in database
  const dbEntry = MODEL_DATABASE.find(m => m.name === modelName);
  // Find in installed
  const isInstalled = installedModelNames.some(n => n === modelName || n.startsWith(modelName.split(':')[0]));

  const nameEl = $('detailModalName');
  const familyEl = $('detailModalFamily');
  const iconEl = $('detailModalIcon');
  const capEl = $('detailCapabilities');
  const descEl = $('detailDescription');
  const quantEl = $('detailQuantizations');
  const variantEl = $('detailVariants');
  const sizeEl = $('detailSizes');
  const pullBtn = $('detailPullBtn');
  const pullStatus = $('detailPullStatus');
  const pullStatusText = $('detailPullStatusText');

  if (nameEl) nameEl.textContent = modelName;
  if (iconEl) iconEl.textContent = dbEntry?.uncensored ? '🔓' : '🧠';

  if (familyEl) {
    if (dbEntry) {
      familyEl.textContent = dbEntry.family + ' · ' + dbEntry.params;
    } else {
      familyEl.textContent = 'Community model';
    }
  }

  // Capabilities
  if (capEl) {
    if (dbEntry) {
      capEl.innerHTML = `
        <div class="detail-cap-badge ${dbEntry.tools ? 'cap-yes' : 'cap-no'}">🔧 Tools: ${dbEntry.tools ? 'Yes' : 'No'}</div>
        <div class="detail-cap-badge ${dbEntry.thinking ? 'cap-yes' : 'cap-no'}">🧠 Thinking: ${dbEntry.thinking ? 'Yes' : 'No'}</div>
        <div class="detail-cap-badge ${dbEntry.vision ? 'cap-yes' : 'cap-no'}">👁 Vision: ${dbEntry.vision ? 'Yes' : 'No'}</div>
        ${dbEntry.uncensored ? '<div class="detail-cap-badge cap-no" style="border:1px solid rgba(239,68,68,0.3);">🔓 Uncensored</div>' : ''}
      `;
    } else {
      capEl.innerHTML = '<div class="detail-cap-badge cap-no">⚠️ Unknown capabilities — not in built-in database</div>';
    }
  }

  // Description
  if (descEl) {
    descEl.innerHTML = dbEntry
      ? `<div class="detail-section-title">About</div><p style="font-size:13px;color:var(--text);line-height:1.5;margin:0;">${esc(dbEntry.description)}</p>`
      : '';
  }

  // Quantizations
  if (quantEl) {
    const quants = dbEntry?.quantizations || ['Q4_K_M', 'Q8_0', 'FP16'];
    const defQuant = dbEntry?.defaultQuant || 'Q4_K_M';
    const installedQuants = installedModelNames.filter(n => n.startsWith(modelName.split(':')[0]));
    quantEl.innerHTML = `<div class="detail-section-title">Available Quantizations</div>
      <div class="detail-quant-grid">${quants.map(q => {
        const isDef = q === defQuant;
        const isInst = installedQuants.some(n => n.toLowerCase().includes(q.toLowerCase()));
        return `<div class="detail-quant-chip ${isInst ? 'detail-quant-installed' : ''}">${q}${isDef ? ' \u2605' : ''}${isInst ? ' \u2713' : ''}</div>`;
      }).join('')}</div>
      <div style="font-size:11px;color:var(--text-dim);margin-top:6px;">\u2605 = default \xb7 \u2713 = installed</div>`;
  }

  // Variants (uncensored, coder, etc.)
  if (variantEl) {
    const baseName = modelName.split(':')[0].replace(/^huihui\//, '');
    const variants = MODEL_DATABASE.filter(m => {
      const mName = m.name.split(':')[0].replace(/^huihui\//, '');
      return mName === baseName && m.name !== modelName;
    });
    if (variants.length > 0) {
      variantEl.innerHTML = `<div class="detail-section-title">Similar Models & Variants</div>
        <div class="detail-variant-list">${variants.map(v => {
          const isInst = installedModelNames.some(n => n === v.name);
          return `<div class="detail-variant-item" onclick="showModelDetail('${esc(v.name)}')">
            <span>${esc(v.name)} — ${v.params}${v.uncensored ? ' 🔓' : ''}</span>
            <span>${isInst ? '<span class="detail-variant-tag" style="color:#4ade80;">Installed</span>' : '<span class="detail-variant-tag">' + (v.tools ? '🔧' : '') + (v.thinking ? '🧠' : '') + (v.vision ? '👁' : '') + '</span>'}</span>
          </div>`;
        }).join('')}</div>`;
    } else {
      variantEl.innerHTML = '';
    }
  }

  // Sizes
  if (sizeEl) {
    const sizes = ['0.5B', '1B', '1.7B', '3B', '4B', '7B', '8B', '11B', '12B', '14B', '26B', '27B', '31B', '32B', '35B', '70B', '123B', '235B'];
    const baseName = modelName.split(':')[0];
    const familyModels = MODEL_DATABASE.filter(m => {
      const mName = m.name.split(':')[0];
      return mName === baseName || (dbEntry && m.family === dbEntry.family);
    });
    if (familyModels.length > 1) {
      sizeEl.innerHTML = `<div class="detail-section-title">Available Sizes</div>
        <div class="detail-variant-list">${familyModels.map(m => {
          const isCur = m.name === modelName;
          const isInst = installedModelNames.some(n => n === m.name);
          return `<div class="detail-variant-item ${isCur ? 'detail-quant-installed' : ''}" onclick="showModelDetail('${esc(m.name)}')">
            <span>${esc(m.name)}</span>
            <span style="display:flex;gap:4px;">${isCur ? '<span class="detail-variant-tag" style="color:#60a5fa;">Current</span>' : ''}${isInst ? '<span class="detail-variant-tag" style="color:#4ade80;">Installed</span>' : '<span class="detail-variant-tag">' + m.params + '</span>'}</span>
          </div>`;
        }).join('')}</div>`;
    } else {
      sizeEl.innerHTML = '';
    }
  }

  // Pull button
  if (pullBtn) {
    if (isInstalled) {
      pullBtn.textContent = '✓ Already Installed';
      pullBtn.disabled = true;
      pullBtn.style.opacity = '0.5';
    } else {
      pullBtn.textContent = '📥 Pull ' + modelName;
      pullBtn.disabled = false;
      pullBtn.style.opacity = '1';
      pullBtn.onclick = () => pullModelFromCatalog(modelName);
    }
  }
  if (pullStatus) pullStatus.style.display = 'none';

  modal.style.display = 'flex';
}

function closeModelDetail() {
  const modal = $('modelDetailModal');
  if (modal) modal.style.display = 'none';
}

// ─── Pull Model ──────────────────────────────────────
let pullInProgress = false;

async function pullModelFromCatalog(modelName) {
  if (pullInProgress) return;
  pullInProgress = true;

  const status = $('pullModelStatus');
  const statusText = $('pullModelStatusText');
  const bar = $('pullModelBar');

  if (status) status.style.display = 'block';
  if (statusText) statusText.textContent = 'Downloading ' + modelName + '... This may take a while for large models.';
  if (bar) { bar.style.width = '30%'; bar.style.background = ''; }

  try {
    const result = await API.pullModel(modelName);
    if (result.error) {
      if (statusText) statusText.textContent = '❌ Failed: ' + result.error;
      if (bar) bar.style.width = '0%';
    } else {
      if (statusText) statusText.textContent = '✅ ' + modelName + ' pulled successfully!';
      if (bar) { bar.style.width = '100%'; bar.style.background = '#22c55e'; }
      loadModelCatalog(); // Refresh lists
      // Refresh detail modal if open
      const modal = $('modelDetailModal');
      if (modal && modal.style.display !== 'none') {
        showModelDetail(modelName);
      }
    }
  } catch (e) {
    if (statusText) statusText.textContent = '❌ Failed: ' + e.message;
    if (bar) bar.style.width = '0%';
  }

  pullInProgress = false;
}

function formatBytes(bytes) {
  if (!bytes) return '';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return gb.toFixed(1) + ' GB';
  const mb = bytes / (1024 * 1024);
  return mb.toFixed(0) + ' MB';
}

// ─── Catalog Event Listeners ──────────────────────────
$('catalogSearchInput')?.addEventListener('input', (e) => {
  const query = e.target.value.trim();
  if (query) {
    filterBrowseModels(query);
  } else {
    const browseList = $('catalogBrowseList');
    if (browseList) browseList.innerHTML = '<div class="catalog-loading">Type to search models...</div>';
    const countEl = $('catalogBrowseCount');
    if (countEl) countEl.textContent = '';
  }
});

$('catalogRefreshBtn')?.addEventListener('click', loadModelCatalog);

$('detailModalClose')?.addEventListener('click', closeModelDetail);
$('detailModalCancelBtn')?.addEventListener('click', closeModelDetail);
$('modelDetailModal')?.addEventListener('click', (e) => {
  if (e.target === $('modelDetailModal')) closeModelDetail();
});

// KV Cache GPU/RAM button clicks
$('kvOptionGpu')?.addEventListener('click', () => {
  ollamaSettings.kvCacheOffload = true;
  updateKvOffloadCards();
  updateOllamaSaveBtn();
});

$('kvOptionRam')?.addEventListener('click', () => {
  ollamaSettings.kvCacheOffload = false;
  updateKvOffloadCards();
  updateOllamaSaveBtn();
});

function updateKvOffloadCards() {
  const gpuCard = $('kvOptionGpu');
  const ramCard = $('kvOptionRam');
  if (gpuCard) gpuCard.classList.toggle('ollama-option-active', ollamaSettings.kvCacheOffload);
  if (ramCard) ramCard.classList.toggle('ollama-option-active', !ollamaSettings.kvCacheOffload);
  // Update all dependent UI instantly
  updateKvVramEstimate();
  updateQuantCards();
  updateCtxMemoryEstimate();
}

function updateKvVramEstimate() {
  const bar = $('kvVramEstimateBar');
  const text = $('kvVramEstimateText');
  const maxText = $('kvVramEstimateMax');
  if (!bar || !text) return;
  const isGpu = ollamaSettings.kvCacheOffload;
  const storageLabel = isGpu ? 'VRAM' : 'RAM';
  // When in RAM mode, use system RAM total; when GPU, use VRAM
  const totalMb = isGpu ? (ollamaGpuInfo?.memTotal || 8192) : (ollamaRamInfo?.total ? Math.round(ollamaRamInfo.total / (1024 * 1024)) : 32768);
  const kvMb = isGpu ? (BASELINE_KV_VRAM_MB[ollamaSettings.kvCacheType] || 1024) : (BASELINE_KV_VRAM_MB[ollamaSettings.kvCacheType] || 1024);
  const pct = Math.min(100, (kvMb / totalMb) * 100);
  bar.style.width = pct + '%';
  if (isGpu) bar.style.background = '';
  else bar.style.background = 'var(--accent)';
  text.textContent = '~' + (kvMb >= 1024 ? (kvMb / 1024).toFixed(1) + ' GB' : kvMb + ' MB');
  if (maxText) maxText.textContent = 'of ' + (totalMb >= 1024 ? (totalMb / 1024).toFixed(0) + ' GB' : totalMb + ' MB') + ' ' + storageLabel;
  const label = $('kvEstimateLabel');
  if (label) label.textContent = 'Estimated ' + storageLabel + ' for context cache (' + ollamaSettings.kvCacheType + '):';
}
document.querySelectorAll('.ollama-quant-card').forEach(card => {
  card.addEventListener('click', () => {
    ollamaSettings.kvCacheType = card.dataset.quant;
    updateQuantCards();
    updateKvVramEstimate();
    updateCtxMemoryEstimate();
    updateOllamaSaveBtn();
  });
});

function updateQuantCards() {
  const isGpu = ollamaSettings.kvCacheOffload;
  const storageLabel = isGpu ? 'VRAM' : 'RAM';
  document.querySelectorAll('.ollama-quant-card').forEach(card => {
    card.classList.toggle('ollama-quant-selected', card.dataset.quant === ollamaSettings.kvCacheType);
    // Update per-card storage labels
    const metaSpans = card.querySelectorAll('.ollama-quant-meta span');
    if (metaSpans.length >= 2) {
      const quantName = card.dataset.quant;
      const ratio = (BASELINE_KV_VRAM_MB[quantName] || 1024) / BASELINE_KV_VRAM_MB.f32;
      metaSpans[1].textContent = storageLabel + ': ' + ratio.toFixed(2) + 'x baseline';
    }
  });
  // Update description text to match storage mode
  const desc = $('kvQuantDesc');
  if (desc) desc.textContent = 'How precisely the conversation context is stored. Lower precision = less ' + storageLabel + ' used, but slightly lower quality on very long conversations.';
  const label = $('kvQuantLabel');
  const bar = $('kvQuantBar');
  const savings = $('kvQuantSavingsText');
  const free = $('kvQuantFreeText');
  if (label) label.textContent = ollamaSettings.kvCacheType;
  const ratio = (BASELINE_KV_VRAM_MB[ollamaSettings.kvCacheType] || 1024) / BASELINE_KV_VRAM_MB.f32;
  if (bar) bar.style.width = (ratio * 100) + '%';
  if (savings) savings.textContent = Math.round(ratio * 100) + '% of f32';
  if (free) {
    const saved = BASELINE_KV_VRAM_MB.f32 - (BASELINE_KV_VRAM_MB[ollamaSettings.kvCacheType] || 1024);
    free.textContent = saved > 0 ? 'Saves ~' + (saved >= 1024 ? (saved / 1024).toFixed(1) + ' GB' : saved + ' MB') + ' ' + storageLabel : 'No savings';
  }
}

// Context presets
document.querySelectorAll('.ollama-ctx-preset').forEach(btn => {
  btn.addEventListener('click', () => {
    const val = parseInt(btn.dataset.val);
    ollamaSettings.defaultNumCtx = val;
    $('numCtxSlider').value = val;
    $('numCtxValue').textContent = val === 0 ? 'Auto' : formatNumCtx(val);
    updateCtxPresets();
    updateCtxMemoryEstimate();
    updateOllamaSaveBtn();
  });
});

// Context slider
$('numCtxSlider')?.addEventListener('input', (e) => {
  const val = parseInt(e.target.value);
  ollamaSettings.defaultNumCtx = val;
  $('numCtxValue').textContent = val === 0 ? 'Auto' : formatNumCtx(val);
  updateCtxPresets();
  updateCtxMemoryEstimate();
  updateOllamaSaveBtn();
});

function formatNumCtx(tokens) {
  if (tokens >= 1024) return (tokens / 1024) + 'K';
  return tokens.toString();
}

function updateCtxPresets() {
  document.querySelectorAll('.ollama-ctx-preset').forEach(btn => {
    btn.classList.toggle('ollama-ctx-active', parseInt(btn.dataset.val) === ollamaSettings.defaultNumCtx);
  });
}

function updateCtxMemoryEstimate() {
  const bar = $('ctxMemBar');
  const text = $('ctxMemText');
  const max = $('ctxMemMax');
  if (!bar) return;
  const isGpu = ollamaSettings.kvCacheOffload;
  const storageLabel = isGpu ? 'VRAM' : 'RAM';
  const ctx = ollamaSettings.defaultNumCtx;
  // Rough estimate: 1K tokens ≈ 0.5 MB KV cache with f16
  const kvMb = ctx === 0 ? 0 : Math.round(ctx * 0.5 * (BASELINE_KV_VRAM_MB[ollamaSettings.kvCacheType] || 1024) / 1024);
  if (isGpu) {
    // GPU mode: show model weights + KV cache in VRAM
    const totalMb = kvMb + BASELINE_MODEL_VRAM_MB;
    const vramTotal = ollamaGpuInfo?.memTotal || 8192;
    const pct = Math.min(100, (totalMb / vramTotal) * 100);
    bar.style.width = pct + '%';
    bar.style.background = '';
    if (text) text.textContent = ctx === 0 ? 'Auto (model default)' : formatNumCtx(ctx) + ' context (' + ollamaSettings.kvCacheType + ') — ~' + (totalMb >= 1024 ? (totalMb / 1024).toFixed(1) + ' GB' : totalMb + ' MB');
    if (max) max.textContent = 'of ' + (vramTotal / 1024).toFixed(0) + ' GB VRAM (model + context)';
  } else {
    // RAM mode: KV cache in RAM, model weights stay in VRAM (not counted here)
    const ramTotalMb = ollamaRamInfo?.total ? Math.round(ollamaRamInfo.total / (1024 * 1024)) : 32768;
    const ramUsedMb = ollamaRamInfo?.used ? Math.round(ollamaRamInfo.used / (1024 * 1024)) : 16384;
    const pct = Math.min(100, (kvMb / ramTotalMb) * 100);
    bar.style.width = pct + '%';
    bar.style.background = 'var(--accent)';
    if (text) text.textContent = ctx === 0 ? 'Auto (model default)' : formatNumCtx(ctx) + ' context (' + ollamaSettings.kvCacheType + ') — ~' + (kvMb >= 1024 ? (kvMb / 1024).toFixed(1) + ' GB' : kvMb + ' MB');
    if (max) max.textContent = 'of ' + (ramTotalMb / 1024).toFixed(0) + ' GB RAM';
  }
}

function updateHardwareInfo() {
  const gpuName = $('hwGpuName');
  const vramBar = $('hwVramBar');
  const vramText = $('hwVramText');
  const ramBar = $('hwRamBar');
  const ramText = $('hwRamText');
  const rec = $('hwRecommendation');
  if (ollamaGpuInfo) {
    if (gpuName) gpuName.textContent = ollamaGpuInfo.name || 'NVIDIA GPU';
    if (vramBar) vramBar.style.width = Math.round((ollamaGpuInfo.memUsed / ollamaGpuInfo.memTotal) * 100) + '%';
    if (vramText) vramText.textContent = ollamaGpuInfo.memUsed + ' / ' + ollamaGpuInfo.memTotal + ' MB';
    if (rec) {
      const freeVram = ollamaGpuInfo.memTotal - ollamaGpuInfo.memUsed;
      if (freeVram < 2048) rec.textContent = '⚠️ Low VRAM free (' + (freeVram / 1024).toFixed(1) + ' GB). Consider disabling GPU offloading to free VRAM for model weights.';
      else if (freeVram < 4096) rec.textContent = '💡 Moderate VRAM available. f16 context cache recommended. Consider q8_0 if context feels tight.';
      else rec.textContent = '✅ Plenty of VRAM free (' + (freeVram / 1024).toFixed(1) + ' GB). GPU offloading with f16 is ideal.';
    }
  } else {
    if (gpuName) gpuName.textContent = 'No NVIDIA GPU detected';
    if (vramText) vramText.textContent = '—';
    if (rec) rec.textContent = '💡 No GPU detected. Context cache will run on RAM. Set context length to match your available system RAM.';
  }
  // RAM
  if (ollamaRamInfo) {
    if (ramBar) ramBar.style.width = ollamaRamInfo.usagePercent + '%';
    if (ramText) ramText.textContent = (ollamaRamInfo.used / (1024 * 1024 * 1024)).toFixed(1) + ' / ' + (ollamaRamInfo.total / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  }
}

// Refresh status button
$('ollamaRefreshBtn')?.addEventListener('click', refreshOllamaStatus);

// Ollama sub-tabs
document.querySelectorAll('.ollama-subtab').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.ollamaTab;
    document.querySelectorAll('.ollama-subtab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.ollama-tab-content').forEach(c => c.style.display = 'none');
    const target = document.getElementById('ollama-tab-' + tab);
    if (target) target.style.display = '';
  });
});

// Save & Restart button
$('ollamaSaveBtn')?.addEventListener('click', async () => {
  const btn = $('ollamaSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  // First save to backend settings
  try {
    await API.saveSettings({
      kvCacheOffload: ollamaSettings.kvCacheOffload,
      kvCacheType: ollamaSettings.kvCacheType,
      defaultNumCtx: ollamaSettings.defaultNumCtx,
    });
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Save & Restart';
    alert('Failed to save settings: ' + e.message);
    return;
  }

  // Now check if restart is needed
  const status = await API.getOllamaStatus();
  const modelsInterrupted = status.loadedModels && status.loadedModels.length > 0;

  if (modelsInterrupted) {
    // Show confirmation dialog
    const modal = $('ollamaRestartModal');
    const msg = $('ollamaRestartMsg');
    const hint = $('ollamaRestartHint');
    msg.textContent = `Model(s) currently loaded: ${status.loadedModels.map(m => m.name || m.model).join(', ')}. Restarting will interrupt any in-progress generation.`;
    hint.textContent = status.ownedByUs
      ? 'Ollama was started by this app and will be restarted automatically.'
      : 'Ollama was started externally. It will be killed and restarted with new settings.';
    modal.style.display = 'flex';

    // Wire up confirm button
    $('ollamaRestartConfirmBtn').onclick = async () => {
      modal.style.display = 'none';
      await doOllamaRestart(true);
    };
  } else {
    // No models loaded — restart directly
    await doOllamaRestart(false);
  }
});

async function doOllamaRestart(confirm) {
  const btn = $('ollamaSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Restarting Ollama...';

  try {
    const result = await API.applyOllamaSettings({
      kvCacheOffload: ollamaSettings.kvCacheOffload,
      kvCacheType: ollamaSettings.kvCacheType,
      confirm,
    });

    if (result.success) {
      btn.textContent = '✓ Restarted!';
      // Update snapshot so unsaved-changes flag resets
      ollamaSettingsSnapshot = { ...ollamaSettings };
      setTimeout(() => {
        btn.textContent = 'Save & Restart';
        btn.disabled = false;
        refreshOllamaStatus();
      }, 2000);
    } else if (result.modelsInterrupted && !confirm) {
      // Need confirmation — shouldn't happen since we checked above
      btn.textContent = 'Save & Restart';
      btn.disabled = false;
    } else {
      btn.textContent = 'Restart Failed';
      alert('Ollama restart failed: ' + (result.error || 'Unknown error'));
      setTimeout(() => {
        btn.textContent = 'Save & Restart';
        btn.disabled = false;
      }, 2000);
    }
  } catch (e) {
    btn.textContent = 'Restart Failed';
    alert('Ollama restart failed: ' + e.message);
    setTimeout(() => {
      btn.textContent = 'Save & Restart';
      btn.disabled = false;
    }, 2000);
  }
}

// ═══ Ollama Unsaved Changes Modal ═══
function showOllamaUnsavedModal() {
  const modal = $('ollamaUnsavedModal');
  if (modal) modal.style.display = 'flex';
}

function closeOllamaUnsavedModal() {
  const modal = $('ollamaUnsavedModal');
  if (modal) modal.style.display = 'none';
  pendingOllamaTargetView = null;
}

// Discard button — discard changes and switch to the pending view
$('ollamaUnsavedDiscardBtn')?.addEventListener('click', () => {
  // Restore snapshot
  if (ollamaSettingsSnapshot) {
    ollamaSettings.kvCacheOffload = ollamaSettingsSnapshot.kvCacheOffload;
    ollamaSettings.kvCacheType = ollamaSettingsSnapshot.kvCacheType;
    ollamaSettings.defaultNumCtx = ollamaSettingsSnapshot.defaultNumCtx;
  }
  closeOllamaUnsavedModal();
  // Now switch to the pending view
  const target = pendingOllamaTargetView;
  if (target) switchView(target);
});

// Save & Restart button — save, restart Ollama, then switch
$('ollamaUnsavedSaveBtn')?.addEventListener('click', async () => {
  closeOllamaUnsavedModal();
  const target = pendingOllamaTargetView;
  // Trigger the save flow
  const btn = $('ollamaSaveBtn');
  if (btn) {
    btn.click();
  }
  // After a brief delay, switch to the target view
  setTimeout(() => {
    if (target) switchView(target);
  }, 500);
});

// Close modal on X button
$('ollamaUnsavedClose')?.addEventListener('click', closeOllamaUnsavedModal);
// Close modal on overlay click
$('ollamaUnsavedModal')?.addEventListener('click', (e) => {
  if (e.target === $('ollamaUnsavedModal')) closeOllamaUnsavedModal();
});
