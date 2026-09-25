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

// Reusable inline SVG icons (lucide-style) for UI text that used emoji.
const S_CHECK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const S_XCIRC = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
const S_WARN = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
const S_INFO = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
const S_CLOUD = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>';
const S_MONITOR = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';
const S_BULB = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/></svg>';
const S_STAR = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
const S_BUG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2l1.88 1.88"/><path d="M14.12 3.88L16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/></svg>';
const S_PLAY = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
const S_SQUARE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>';
const S_CHAT = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
const S_WRENCH = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>';
const S_CLIP = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/></svg>';
const S_FILE = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
const S_SEARCH = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
const S_BRAIN = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a4 4 0 0 0-4 4c0 .5.1 1 .3 1.4A3.5 3.5 0 0 0 5 11c0 1.3.7 2.4 1.6 3A3 3 0 0 0 6 17a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3 3 3 0 0 0-.6-3A3.5 3.5 0 0 0 19 11a3.5 3.5 0 0 0-3.3-3.6c.2-.4.3-.9.3-1.4a4 4 0 0 0-4-4z"/></svg>';
const S_RFRESH = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';
const S_SPARK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3z"/></svg>';
const S_LOCK = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
const S_PAUSE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
const S_TRASH = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const S_CAL = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
const S_DB = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>';
const S_ANTENNA = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10a16 16 0 0 1 16 0"/><path d="M6.4 14a10.5 10.5 0 0 1 11.2 0"/><circle cx="12" cy="18" r="1"/></svg>';
const S_PUZZLE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02z"/></svg>';
const S_EYE = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const S_ZAP = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>';
const S_TARGET = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>';
const S_X = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const S_TIMER = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5"/><path d="M9 2h6"/></svg>';

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
  }
  // Apply toggles
  httpToggle.classList.toggle('toggle-on', state.httpMode);
  autoStartToggle.classList.toggle('toggle-on', state.autoStart);
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

// ─── Missing Component Install (Bun / Ollama) ───────────────────
let installResolve = null;

function promptInstall(component) {
  // If a prompt is already showing, chain onto it so no caller hangs waiting
  // for a resolver that never gets called.
  if (installResolve) {
    return new Promise((resolve) => {
      const prevResolve = installResolve;
      installResolve = (answer) => { prevResolve(answer); resolve(answer); };
    });
  }
  return new Promise((resolve) => {
    installResolve = resolve;
    $('installModalTitle').textContent = 'Ollama is missing';
    $('installModalMsg').textContent = 'Ollama is required for AI model responses. I can install it for you. May I?';
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

// Module-level startup log (used by ensureOllama and runStartup)
function startupLogFn(text) {
  const el = document.getElementById('startupLog');
  if (el) {
    el.textContent += text + '\n';
    el.scrollTop = el.scrollHeight;
  }
}
const log = startupLogFn;

async function ensureOllama() {
  // 1. Check if Ollama is already running
  const check = await API.checkOllama();
  if (check.available) return true;

  // 2. Not running — try to start it
  log('Ollama not responding — trying to start it...');
  try {
    const startRes = await API.startOllama();
    if (startRes.success) {
      log('Ollama started ✓');
      return true;
    }
    log('Auto-start failed: ' + (startRes.error || 'unknown error'));
  } catch (e) {
    log('Auto-start failed: ' + e.message);
  }

  // 3. Ollama not running — show message in startup log + a Retry button
  log('');
  log('╔══════════════════════════════════════════╗');
  log('║     Ollama is not running                ║');
  log('║                                          ║');
  log('║  Please open the Ollama app from your    ║');
  log('║  Start menu or system tray, then click   ║');
  log('║  "Retry" below.                          ║');
  log('║                                          ║');
  log('║  Do not have Ollama? Download it from:    ║');
  log('║  https://ollama.com/download             ║');
  log('╚══════════════════════════════════════════╝');
  log('');
  showStartupRetry();
  return false;
}

// Show/hide the startup-overlay Retry button (used when Ollama isn't running).
function showStartupRetry() {
  const btn = $('startupRetryBtn');
  if (!btn) return;
  btn.style.display = 'inline-flex';
  btn.onclick = async () => {
    btn.style.display = 'none';
    btn.disabled = true;
    btn.textContent = 'Checking...';
    mark('check-deps', 'active');
    log('Retrying Ollama check...');
    try {
      const ok = await ensureOllama();
      if (ok) {
        mark('check-deps', 'done');
        updateOllamaBadge(true);
        log('Ollama is running ✓');
      } else {
        mark('check-deps', 'error');
        updateOllamaBadge(false);
        showStartupRetry();
      }
    } catch (e) {
      mark('check-deps', 'error');
      log('Ollama check failed: ' + e.message);
      showStartupRetry();
    }
    btn.disabled = false;
    btn.textContent = 'Retry Ollama check';
  };
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



  // Step 1: Check Ollama (non-blocking — server starts either way)
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

  // Step 2: Backend (self-contained exe — nothing to install)
  mark('check-ollama', 'active');
  log('Backend ready ✓');
  mark('check-ollama', 'done');

  // Enable start button (backend exe is self-contained — no extra runtime needed)
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
  // Remember for per-interface share links in the Network card
  updateIPs.currentUrl = url;
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
      const icon = mode === 'auto' ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>' : mode === 'local' ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>' : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>';
      const label = mode === 'auto' ? 'Auto' : mode === 'local' ? 'Local Only' : 'Cloud Only';
      const modeClass = `mode-${mode}`;
      $('modePillIcon').innerHTML = icon;
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
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>'; btn.classList.remove('copied'); }, 1500);
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
    <div class="ip-row ip-row-share" data-address="${ip.address}" title="Click to copy shareable URL for this network">
      <span class="ip-address">${ip.address}</span>
      <span class="ip-interface">${ip.interface || ''}</span>
    </div>
  `).join('') +
  (ips.length > 0 ? `<div class="ip-hint">Devices must be on the same network as the IP you share (VPN IPs only work for VPN members).</div>` : '');
  // Click a row to copy protocol://address:port for sharing over that network
  container.querySelectorAll('.ip-row-share').forEach((row) => {
    row.addEventListener('click', () => {
      const addr = row.dataset.address;
      const url = updateIPs.currentUrl ? updateIPs.currentUrl.replace('localhost', addr) : `http://${addr}:3001`;
      navigator.clipboard.writeText(url).then(() => {
        row.classList.add('copied');
        setTimeout(() => row.classList.remove('copied'), 1200);
      }).catch(() => {});
    });
  });
}
// Latest server URL (protocol + port) used to build per-interface share links
updateIPs.currentUrl = null;

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
    if (stats.gpu.estimateOnly) {
      // No live measurement available (no nvidia-smi / rocm-smi) — show the
      // total VRAM and say so, instead of a misleading "0% / 0 MB used".
      $('gpuValue').textContent = '—';
      $('gpuBar').style.width = '0%';
      $('gpuDetail').textContent = `VRAM: ${stats.gpu.memTotal} MB total (live usage unavailable)`;
    } else {
      $('gpuValue').textContent = stats.gpu.gpuUtil + '%';
      $('gpuBar').style.width = stats.gpu.gpuUtil + '%';
      $('gpuDetail').textContent = `VRAM: ${stats.gpu.memUsed} MB / ${stats.gpu.memTotal} MB`;
    }
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
  { icon: S_BUG, title: 'Report a bug', sub: 'Open a GitHub issue', url: FEEDBACK_CONFIG.issueUrl },
  { icon: S_BULB, title: 'Suggest an idea', sub: 'GitHub Discussions — Ideas', url: FEEDBACK_CONFIG.ideasUrl },
  null,
  { icon: S_STAR, title: 'Visit repository', sub: FEEDBACK_CONFIG.repoUrl.replace('https://', ''), url: FEEDBACK_CONFIG.repoUrl },
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

// Download progress updates (in-app banner updater downloads from GitHub)
API.onDownloadProgress((data) => {
  if (bannerUpdateRunning) {
    const b = $('updateBannerInstall');
    if (b) b.textContent = `Downloading… ${data.percent}%`;
  }
});


// ─── Admin Access ─────────────────────────────────────────────
// The settings password was removed: a one-click reset made it security
// theater, so every admin view is open. Securing the host is the operator's
// job (lock the PC / restrict who can reach the server).
const settingsAuthed = true;

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

// ══════════════════════════════════════════════════════
// Models View — Model Assignments
// ══════════════════════════════════════════════════════
const MODEL_KEYS = [
  'chat', 'chat_thinking', 'code', 'vision', 'extraction',
  'search',
];
const MODEL_LABELS = {
  chat: 'Chat',
  chat_thinking: 'Chat (Thinking)',
  code: 'Code Generation',
  vision: 'Vision Analysis',
  extraction: 'Memory Extraction',
  search: 'Web Search',
};
const MODEL_ICONS = {
  chat: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>', chat_thinking: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a4 4 0 0 0-4 4c0 .5.1 1 .3 1.4A3.5 3.5 0 0 0 5 11c0 1.3.7 2.4 1.6 3A3 3 0 0 0 6 17a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3 3 3 0 0 0-.6-3A3.5 3.5 0 0 0 19 11a3.5 3.5 0 0 0-3.3-3.6c.2-.4.3-.9.3-1.4a4 4 0 0 0-4-4z"/></svg>', code: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>', vision: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  extraction: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a4 4 0 0 0-4 4c0 .5.1 1 .3 1.4A3.5 3.5 0 0 0 5 11c0 1.3.7 2.4 1.6 3A3 3 0 0 0 6 17a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3 3 3 0 0 0-.6-3A3.5 3.5 0 0 0 19 11a3.5 3.5 0 0 0-3.3-3.6c.2-.4.3-.9.3-1.4a4 4 0 0 0-4-4z"/></svg>', search: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>',
};
const DEFAULT_ASSIGNMENTS = {
  chat: 'qwen3:4b',
  chat_thinking: 'qwen3:4b',
  code: 'qwen2.5-coder:7b',
  vision: 'qwen2.5vl:3b',
  extraction: 'qwen2.5:3b',
  search: 'qwen2.5:3b',
};

// Where each category is actually used, so the host can see what a
// reassignment affects. Keep in sync with backend/app — get_resolved_model()
// call sites in pipeline.py, routes/chat.py, search.py, extractor.py, agent.py.
const MODEL_USED_FOR = {
  chat: [
    'Regular chatting (Chat mode and inside Koding narration)',
    'Thinking ON — used when this model supports thinking itself',
    'Conversation titles (auto-generated from the first message)',
  ],
  chat_thinking: [
    'Thinking ON — only used when the Chat model itself can\'t think',
    'Unused when Chat supports thinking (the toggle just flips a flag on it)',
  ],
  code: [
    'Koding (agent) mode — the autonomous multi-tool loop',
    'Code generation and the visible Plan step in Koding',
    'Koding planning phase (when Plan mode is ON)',
    'Drawing images (draw_image) inside Koding',
  ],
  vision: [
    'Describing attached images in chat (read_image)',
    'Describing Koding preview screenshots — only when the Code model itself\n      can\'t see images',
  ],
  extraction: [
    'Memory extraction — deciding what to remember after each answer',
  ],
  search: [
    'Summarizing web-search results into answer context',
  ],
};

let installedModels = [];
let localAssignments = {};
let cloudAssignments = {};
let availableCloudModels = [];
let fetchingCloudModels = false;
let cloudModelsError = '';
// Fetched from GET /api/models/usage-map (source of truth); the built-in
// MODEL_USED_FOR is only a fallback for an older backend without the route.
let serverUsageMap = null;

async function fetchModelUsageMap() {
  try {
    const res = await API.getModelUsageMap();
    if (res && res.usage && typeof res.usage === 'object') serverUsageMap = res.usage;
  } catch { serverUsageMap = null; }
}

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
  await fetchModelUsageMap();
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

const S_CHEV = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

function usedForHtml(key) {
  const items = (serverUsageMap && Array.isArray(serverUsageMap[key]) && serverUsageMap[key].length)
    ? serverUsageMap[key]
    : MODEL_USED_FOR[key];
  if (!items || !items.length) return '';
  const list = items.map((u) => `<li>${u.replace(/\n\s+/g, ' ')}</li>`).join('');
  return `
    <button class="model-used-toggle" data-usedkey="${key}" type="button" aria-expanded="false">${S_CHEV}<span>Where it's used</span></button>
    <ul class="model-used-list" data-usedlist="${key}" hidden>${list}</ul>`;
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
      ? '<div class="model-note">This model has no thinking mode — a separate Thinking model below is used while the Thinking toggle is on.</div>'
      : '';
    const thinkingRoleNote = key === 'chat_thinking'
      ? '<div class="model-note">Used only when the Thinking toggle is ON, because the Chat model above can\'t think.</div>'
      : '';
    const suggBtn = suggestion && suggestion !== cur
      ? `<button class="model-chip suggestion" data-key="${key}" data-model="${suggestion}">${S_SPARK} ${esc(suggestion)}</button>`
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
      ${usedForHtml(key)}
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
      ? `<div class="models-loading">${cloudModelsError ? S_WARN + ' ' + esc(cloudModelsError) : 'No Ollama Cloud models found. Check your endpoint and API key in the API Keys tab.'}</div>`
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
      ${usedForHtml(key)}
      <div class="model-chips">
        ${noneBtn}
        ${availableCloudModels.length ? chips : (fetchingCloudModels ? '<span class="models-loading-small">Loading…</span>' : '<span style="font-size:11px;color:var(--text-muted)">No Ollama Cloud models — configure endpoint and API key in API Keys tab</span>')}
      </div>
    </div>`;
  }).join('');

  grid.innerHTML = `
    <div class="models-section">
      <div class="models-section-header">
        <span class="section-icon">${S_MONITOR}</span>
        <div>
          <h3>Local Models (Ollama)</h3>
          <p>Pick from installed Ollama models on this machine</p>
        </div>
      </div>
      <div class="models-grid-inner">${localSection}</div>
    </div>
    <div class="models-section">
      <div class="models-section-header">
        <span class="section-icon">${S_CLOUD}</span>
        <div>
          <h3>Ollama Cloud</h3>
          <p>Pick from Ollama Cloud models (used when mode is Auto or Cloud)</p>
        </div>
        <button class="cloud-refresh-btn" id="refreshCloudModelsBtn" title="Refresh Ollama Cloud models"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> Refresh</button>
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

  // "Where it's used" expanders (delegated — survives grid re-renders).
  // IMPORTANT: scope the lookup to the button's own card — Local and Cloud
  // sections share the same data-usedkey values, so a document-wide
  // querySelector would always open the Local list instead of the Cloud one.
  grid.querySelectorAll('.model-used-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.model-card');
      const list = card && card.querySelector('.model-used-list');
      if (!list) return;
      const open = !list.hidden;
      list.hidden = open;
      btn.classList.toggle('open', !open);
      btn.setAttribute('aria-expanded', String(!open));
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
      refreshBtn.innerHTML = `${S_RFRESH} Loading…`;
      refreshBtn.disabled = true;
      await fetchAvailableCloudModels();
      renderModelsGrid();
      refreshBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> Refresh';
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
          <span class="speed-chip">${S_CAL} ${formatSpeedDate(r.date)}</span>
          <span class="speed-chip"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a4 4 0 0 0-4 4c0 .5.1 1 .3 1.4A3.5 3.5 0 0 0 5 11c0 1.3.7 2.4 1.6 3A3 3 0 0 0 6 17a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3 3 3 0 0 0-.6-3A3.5 3.5 0 0 0 19 11a3.5 3.5 0 0 0-3.3-3.6c.2-.4.3-.9.3-1.4a4 4 0 0 0-4-4z"/></svg> ${r.modelCount} models</span>
          ${isLatest ? '<span class="speed-chip latest-chip">Latest</span>' : ''}
        </div>
        <button class="speed-del" data-id="${r.id}" title="Delete result">${S_TRASH}</button>
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
  if (speedRunning) return;
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
  $('speedRunBtn').disabled = false;
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
      <div class="summary-card"><div class="sc-label">${S_TIMER} Total Duration</div><div class="sc-value">${formatDuration(r.totalDurationMs)}</div></div>
      <div class="summary-card"><div class="sc-label">${S_BRAIN} Models Tested</div><div class="sc-value">${r.modelCount}</div></div>
      <div class="summary-card"><div class="sc-label">${S_ZAP} Avg Response</div><div class="sc-value">${formatDuration(r.summary.avgResponseTimeMs)}</div></div>
      <div class="summary-card"><div class="sc-label">${S_TARGET} Avg Quality</div><div class="sc-value" style="color:${qualityColor(r.summary.avgQualityScore)}">${r.summary.avgQualityScore}%</div></div>
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
      <div class="chart-title">${S_TARGET} Quality Score by Test — check details below each bar</div>
      ${r.tests.map((t) => {
        const q = t.qualityScore || 0;
        const color = qualityColor(q);
        const checks = (t.qualityChecks || []).map((c) =>
          `<div class="qcheck ${c.passed ? 'pass' : 'fail'}"><span>${c.passed ? S_CHECK : S_X}</span> ${c.name}${c.details ? ` <span class="qc-detail">— ${c.details}</span>` : ''}</div>`
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
      <div class="chart-title">${S_CLIP} All Test Details</div>
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
              <td class="td-status">${t.success ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'}</td>
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
    ? `<div class="errors-block"><h4>${S_WARN} Errors</h4>${errors.map((t) => `<p><strong>${t.testName}:</strong> ${t.error || 'Unknown error'}</p>`).join('')}</div>`
    : '';

  $('speedModalBody').innerHTML =
    summary + modelCards +
    barChart('<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg> Response Time by Test', (t) => t.totalTimeMs, formatDuration, maxTime) +
    barChart('Tokens per Second', (t) => t.tokensPerSecond, (v) => v.toFixed(1) + ' tok/s', maxTps) +
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
  if ($locked) $locked.style.display = 'none';
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
    ? `<span class="plugin-badge plugin-badge-installed" title="Installed v${escapeHtml(p.installedVersion || p.version)}">${isEnabled ? S_CHECK + ' Enabled' : S_PAUSE + ' Disabled'}</span>`
    : `<span class="plugin-badge">${escapeHtml(p.version)}</span>`;
  const actions = p.installed
    ? (authed
        ? `<button class="btn btn-small btn-ghost" data-act="toggle" data-id="${escapeHtml(p.id)}" data-enabled="${isEnabled ? 'true' : 'false'}">${isEnabled ? 'Disable' : 'Enable'}</button>
           <button class="btn btn-small btn-ghost" data-act="update" data-id="${escapeHtml(p.id)}">Update</button>
           <button class="btn btn-small btn-danger" data-act="uninstall" data-id="${escapeHtml(p.id)}">Remove</button>`
        : `<span class="plugin-installed-note">Installed — unlock admin to manage</span>`)
    : (authed
        ? `<button class="btn btn-small btn-primary" data-act="install" data-id="${escapeHtml(p.id)}" data-source="${escapeHtml(p.source)}">Install</button>`
        : `<span class="plugin-installed-note">${S_LOCK} Unlock admin to install</span>`);
  return `<div class="plugin-card">
    <div class="plugin-icon">${p.icon ? escapeHtml(p.icon) : S_PUZZLE}</div>
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
    if ($locked) $locked.style.display = 'none';
  });
}

// Check GitHub release version on init
let updateAssetName = null;    // Windows installer asset of the latest release
let updateDownloaded = false;  // matching installer already on disk
let bannerUpdateRunning = false;

/** Compare dotted versions: >0 if a newer, <0 if older, 0 if equal. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function checkLatestRelease() {
  try {
    const [{ release, downloadedInstaller }, appInfo] = await Promise.all([
      API.getLatestRelease(),
      API.getAppInfo(),
    ]);
    if (!release || !release.version || !appInfo?.version) return;

    const latest = String(release.version).replace(/^v/i, '');
    const current = String(appInfo.version).replace(/^v/i, '');

    // Badge — only claim "available" when the release is strictly newer
    // than this build (dev builds ahead of the release must not nag)
    const badge = $('releaseVersion');
    if (badge) badge.textContent = compareVersions(latest, current) > 0 ? 'v' + latest + ' available' : '';

    // Compare versions — skip if the release is not strictly newer (never
    // offer a downgrade) or if dismissed this session
    if (compareVersions(latest, current) <= 0) return;
    if (sessionStorage.getItem('updateDismissed') === latest) return;

    // Find the Windows installer asset for the in-app updater
    const exeAsset = (release.assets || []).find(a => a.name.endsWith('.exe') && !a.name.endsWith('.exe.blockmap'));
    updateAssetName = exeAsset ? exeAsset.name : null;
    // A previously downloaded installer only counts if its version matches
    // the latest release (filename like ...-Setup-0.11.0.exe) — never install
    // a stale one by accident.
    const instVer = downloadedInstaller ? (downloadedInstaller.name.match(/(\d+\.\d+(?:\.\d+)?)/) || [])[1] : null;
    updateDownloaded = !!(downloadedInstaller && instVer === latest);

    // Show banner
    const banner = $('updateBanner');
    const versionEl = $('updateBannerVersion');
    const descEl = $('updateBannerDesc');
    const statusEl = $('updateBannerStatus');
    const installBtn = $('updateBannerInstall');
    if (banner && versionEl && installBtn) {
      versionEl.textContent = 'Update available: v' + latest + ' (you have v' + current + ')';
      if (descEl && release.name) descEl.textContent = release.name;
      if (updateDownloaded) {
        installBtn.textContent = 'Install now';
        installBtn.disabled = false;
      } else {
        installBtn.textContent = 'Download & install';
        installBtn.disabled = !updateAssetName;
        installBtn.title = updateAssetName ? '' : 'No Windows installer found in the latest release';
      }
      if (statusEl) statusEl.style.display = 'none';
      banner.style.display = 'block';
    }
  } catch {}
}

// In-app update: download (if needed) → silent NSIS install → app relaunch.
// The main process does the work; we surface progress and guard the button.
$('updateBannerInstall')?.addEventListener('click', async () => {
  if (bannerUpdateRunning) return;
  const btn = $('updateBannerInstall');
  const statusEl = $('updateBannerStatus');
  bannerUpdateRunning = true;
  btn.disabled = true;

  const showStatus = (text, ok) => {
    if (!statusEl) return;
    statusEl.style.display = 'inline';
    statusEl.style.color = ok === false ? 'var(--red, #e5484d)' : 'var(--green)';
    statusEl.textContent = text;
  };

  try {
    if (!updateDownloaded) {
      if (!updateAssetName) {
        showStatus('No installer found in the latest release', false);
        bannerUpdateRunning = false;
        btn.disabled = false;
        return;
      }
      btn.textContent = 'Downloading…';
      const dl = await API.downloadRelease(updateAssetName);
      if (!dl.success) {
        showStatus('❌ ' + (dl.error || 'Download failed'), false);
        bannerUpdateRunning = false;
        btn.disabled = false;
        btn.textContent = 'Download & install';
        return;
      }
    }
    showStatus('✓ Downloaded — installing…', true);
    btn.textContent = 'Installing…';
    const inst = await API.installRelease();
    if (!inst.success) {
      showStatus('❌ ' + (inst.error || 'Install failed'), false);
      bannerUpdateRunning = false;
      btn.disabled = false;
      btn.textContent = 'Install now';
      return;
    }
    showStatus('✓ Installing — the app will restart…', true);
    // Main process quits so the installer can swap files and relaunch.
  } catch (e) {
    showStatus('❌ ' + (e?.message || 'Update failed'), false);
    bannerUpdateRunning = false;
    btn.disabled = false;
    btn.textContent = 'Download & install';
  }
});

// ─── Init ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Load version
  API.getAppInfo().then((info) => {
    $('versionDisplay').textContent = 'v' + info.version;
  });

  // Bun is no longer required (self-contained Python backend) — no bun handler.

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
  const icons = { error: S_XCIRC, warning: S_WARN, success: S_CHECK, info: S_INFO };
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || S_INFO}</span>
    <span class="toast-text">${message}</span>
    <button class="toast-close" title="Dismiss">${S_X}</button>
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
 'run:start': S_PLAY, 'run:end': S_SQUARE, 'message': S_CHAT,
 'tool:call': S_WRENCH, 'tool:result': S_CLIP, 'plan': S_FILE,
 'plan:update': S_CHECK, 'verify': S_SEARCH, 'thinking': S_BRAIN,
 'stage': S_RFRESH, 'error': S_XCIRC,
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
let ollamaSettings = { kvCacheOffload: true, kvCacheType: 'f16', defaultNumCtx: 0, ollamaNumParallel: 0, ollamaMaxLoadedModels: 0, ollamaKeepAlive: '' };
let ollamaSettingsLoaded = false;
let ollamaGpuInfo = null; // { memTotal, memUsed, name }
let ollamaRamInfo = null; // { total, used, free, usagePercent }
let ollamaSettingsSnapshot = null; // snapshot when settings were loaded
let pendingOllamaTargetView = null; // view to switch to after discard/save

async function enterOllamaView() {
  // Load current settings
  if (!ollamaSettingsLoaded) {
    try {
      const settings = await API.getSettings();
      if (settings) {
        ollamaSettings.kvCacheOffload = settings.kvCacheOffload !== false;
        ollamaSettings.kvCacheType = settings.kvCacheType || 'f16';
        ollamaSettings.defaultNumCtx = settings.defaultNumCtx || 0;
        ollamaSettings.ollamaNumParallel = parseInt(settings.ollamaNumParallel, 10) || 0;
        ollamaSettings.ollamaMaxLoadedModels = parseInt(settings.ollamaMaxLoadedModels, 10) || 0;
        ollamaSettings.ollamaKeepAlive = settings.ollamaKeepAlive || '';
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
  // Apply cache location + quantization selects
  updateKvOffloadCards();
  const kvTypeSel = $('kvCacheTypeSelect');
  if (kvTypeSel) kvTypeSel.value = ollamaSettings.kvCacheType || 'f16';

  // Apply context length
  const numCtxSelect = $('numCtxSelect');
  if (numCtxSelect) {
    const cur = String(ollamaSettings.defaultNumCtx || 0);
    numCtxSelect.value = Array.from(numCtxSelect.options).some(o => o.value === cur) ? cur : '0';
  }

  // Apply concurrency & memory settings
  applyConcurrencySettings();

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
    || ollamaSettings.defaultNumCtx !== ollamaSettingsSnapshot.defaultNumCtx
    || ollamaSettings.ollamaNumParallel !== ollamaSettingsSnapshot.ollamaNumParallel
    || ollamaSettings.ollamaMaxLoadedModels !== ollamaSettingsSnapshot.ollamaMaxLoadedModels
    || ollamaSettings.ollamaKeepAlive !== ollamaSettingsSnapshot.ollamaKeepAlive;
}

async function refreshOllamaStatus() {
  const runningEl = $('ollamaRunningStatus');
  const ownershipEl = $('ollamaOwnershipStatus');
  const loadedEl = $('ollamaLoadedModels');
  const statusText = $('ollamaStatusText');

  try {
    const status = await API.getOllamaStatus();
    if (runningEl) runningEl.innerHTML = (status.running ? S_CHECK : S_XCIRC) + (status.running ? ' Running' : ' Stopped');
    if (ownershipEl) ownershipEl.textContent = status.ownedByUs ? 'Yes (app started)' : 'No (external)';
    if (loadedEl) {
      const models = status.loadedModels || [];
      loadedEl.textContent = models.length > 0
        ? models.map(m => m.name || m.model).join(', ')
        : 'None loaded';
    }
    // What the RUNNING Ollama was actually started with. An external Ollama
    // (tray autostart at PC boot) runs on ITS OWN env — the saved settings
    // only apply once Ollama is restarted via Save & Restart.
    const tuningEl = $('ollamaActiveTuning');
    const hintEl = $('ollamaTuningHint');
    if (tuningEl) {
      if (status.ownedByUs && status.effectiveEnv) {
        const e = status.effectiveEnv;
        const parts = [];
        parts.push('parallel: ' + (e.OLLAMA_NUM_PARALLEL || 'auto'));
        parts.push('max models: ' + (e.OLLAMA_MAX_LOADED_MODELS || 'auto'));
        parts.push('keep: ' + (e.OLLAMA_KEEP_ALIVE || 'auto(5m)'));
        parts.push('kv: ' + (e.LLAMA_ARG_CACHE_TYPE_K || 'f16'));
        if (e.OLLAMA_FLASH_ATTENTION === '1') parts.push('flash-attn: on');
        tuningEl.textContent = parts.join(' · ');
        tuningEl.style.color = 'var(--green)';
      } else {
        tuningEl.textContent = status.running ? 'unknown (external Ollama)' : '—';
        tuningEl.style.color = 'var(--yellow, #eab308)';
      }
    }
    if (hintEl) {
      if (status.running && !status.ownedByUs) {
        hintEl.style.display = 'block';
        hintEl.textContent = '⚠ Ollama was started outside this app (e.g. tray autostart at PC boot). The backend auto-applies saved settings to it at startup — if this banner persists, models were loaded (auto-apply skipped to avoid interruption) or the restart failed. Press "Save & Restart" to apply now.';
      } else {
        hintEl.style.display = 'none';
      }
    }
    // Some model architectures (e.g. qwen3.5) cannot serve parallel requests
    // in Ollama at all — OLLAMA_NUM_PARALLEL is inert for them and requests
    // queue no matter what the host picks. Say so instead of staying silent.
    const parLimitEl = $('parallelLimitHint');
    if (parLimitEl) {
      const archs = status.parallelUnsupportedArchs || [];
      if (status.running && archs.length > 0) {
        parLimitEl.style.display = 'block';
        parLimitEl.textContent = '⚠ ' + archs.join(', ') + '-family models do not support parallel generation in this Ollama version — requests will queue one-by-one regardless of the parallel slot setting. Multi-user concurrency works with other model families (e.g. llama3, qwen2.5).';
      } else {
        parLimitEl.style.display = 'none';
      }
    }
    if (statusText) statusText.textContent = status.running ? 'Connected' : 'Disconnected';
  } catch {
    if (runningEl) runningEl.innerHTML = S_XCIRC + ' Unreachable';
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
// Catalog icon SVGs (module scope to avoid template literal quote conflicts)
const _iconBrain = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a4 4 0 0 0-4 4c0 .5.1 1 .3 1.4A3.5 3.5 0 0 0 5 11c0 1.3.7 2.4 1.6 3A3 3 0 0 0 6 17a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3 3 3 0 0 0-.6-3A3.5 3.5 0 0 0 19 11a3.5 3.5 0 0 0-3.3-3.6c.2-.4.3-.9.3-1.4a4 4 0 0 0-4-4z"/></svg>';
const _iconUnlock = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>';
const _iconWrench = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>';
const _iconEye = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const _iconDownload = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
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
    badge.innerHTML = S_ANTENNA + ' ' + esc(v) + ' (remote)';
    badge.className = 'catalog-db-badge catalog-db-remote';
  } else {
    badge.innerHTML = S_DB + ' ' + esc(v) + ' (local)';
    badge.className = 'catalog-db-badge catalog-db-local';
  }
}

async function fetchModelCatalog(forceRefresh) {
  if (!forceRefresh) {
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
  } else {
    // Clear stale cache when force-refreshing
    localStorage.removeItem(CATALOG_CACHE_KEY);
  }

  try {
    // Add cache-buster to bypass CDN/proxy caches
    const bustUrl = CATALOG_URL + '?t=' + Date.now();
    const res = await fetch(bustUrl);
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
          const dbEntry = MODEL_DATABASE.find(d => name === d.name || name.startsWith(d.name + ':') || name.startsWith(d.name + '-'));
          const badges = [];
          if (dbEntry) {
            if (dbEntry.tools) badges.push('<span class="catalog-badge catalog-badge-tools"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg> Tools</span>');
            if (dbEntry.thinking) badges.push('<span class="catalog-badge catalog-badge-think"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a4 4 0 0 0-4 4c0 .5.1 1 .3 1.4A3.5 3.5 0 0 0 5 11c0 1.3.7 2.4 1.6 3A3 3 0 0 0 6 17a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3 3 3 0 0 0-.6-3A3.5 3.5 0 0 0 19 11a3.5 3.5 0 0 0-3.3-3.6c.2-.4.3-.9.3-1.4a4 4 0 0 0-4-4z"/></svg> Thinking</span>');
            if (dbEntry.vision) badges.push('<span class="catalog-badge catalog-badge-vision"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> Vision</span>');
            if (dbEntry.parallel !== false) badges.push('<span class="catalog-badge catalog-badge-par"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg> Parallel</span>');
            else badges.push('<span class="catalog-badge catalog-badge-nopar"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> No parallel</span>');
          }
          return `<div class="catalog-model-card catalog-installed" onclick="showModelDetail('${esc(name)}')" title="Click for details">
            <div class="catalog-model-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a4 4 0 0 0-4 4c0 .5.1 1 .3 1.4A3.5 3.5 0 0 0 5 11c0 1.3.7 2.4 1.6 3A3 3 0 0 0 6 17a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3 3 3 0 0 0-.6-3A3.5 3.5 0 0 0 19 11a3.5 3.5 0 0 0-3.3-3.6c.2-.4.3-.9.3-1.4a4 4 0 0 0-4-4z"/></svg></div>
            <div class="catalog-model-info">
              <div class="catalog-model-name">${esc(name)}</div>
              <div class="catalog-model-meta">${esc(meta)}</div>
              <div class="catalog-model-badges">${badges.join('')}<span class="catalog-badge catalog-badge-installed">${S_CHECK} Installed</span>${size ? '<span class="catalog-badge catalog-badge-size">' + esc(size) + '</span>' : ''}</div>
            </div>
          </div>`;
        }).join('');
      }
    } catch (e) {
      installedList.innerHTML = `<div class="catalog-loading">Failed to load: ${esc(String(e))}</div>`;
    }
  }

}

// ─── Search suggestions dropdown (browser-style) ──────
let catalogSuggestState = { results: [], active: -1, query: '' };

function highlightMatch(text, query) {
  if (!query) return esc(text);
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return esc(text);
  return esc(text.slice(0, idx)) + '<mark>' + esc(text.slice(idx, idx + query.length)) + '</mark>' + esc(text.slice(idx + query.length));
}

function closeCatalogSuggestions() {
  const dd = $('catalogSuggestions');
  if (dd) { dd.style.display = 'none'; dd.innerHTML = ''; }
  catalogSuggestState = { results: [], active: -1, query: '' };
}

function setActiveSuggestion(idx, scroll = true) {
  const dd = $('catalogSuggestions');
  if (!dd) return;
  catalogSuggestState.active = idx;
  dd.querySelectorAll('.catalog-suggestion-item').forEach((el, i) => {
    el.classList.toggle('catalog-suggestion-active', i === idx);
    if (i === idx && scroll) el.scrollIntoView({ block: 'nearest' });
  });
}

function openSuggestedModel(m) {
  closeCatalogSuggestions();
  const input = $('catalogSearchInput');
  if (input) input.value = '';
  showModelDetail(m.name);
}

function renderCatalogSuggestions(query) {
  const dd = $('catalogSuggestions');
  if (!dd) return;
  const q = query.trim().toLowerCase();
  if (!q) { closeCatalogSuggestions(); return; }

  const results = MODEL_DATABASE.filter(m => {
    return m.name.toLowerCase().includes(q)
      || m.family.toLowerCase().includes(q)
      || (m.description || '').toLowerCase().includes(q)
      || (m.uncensored && 'uncensored abliterated'.includes(q))
      || (m.tools && 'tools tool calling'.includes(q))
      || (m.thinking && 'thinking reasoning'.includes(q))
      || (m.vision && 'vision image multimodal'.includes(q))
      || (m.parallel !== false && 'parallel concurrent multiuser'.includes(q))
      || (m.parallel === false && 'no parallel queue single user serial'.includes(q));
  });
  catalogSuggestState = { results, active: -1, query: query.trim() };

  if (results.length === 0) {
    dd.innerHTML = '<div class="catalog-suggestion-empty">No models found for "' + esc(query) + '"</div>';
    dd.style.display = 'block';
    return;
  }

  // Icons-only mini badges (tooltips name them) — keeps rows compact
  const miniBadges = (m) => {
    let b = '';
    if (m.tools) b += '<span class="catalog-badge catalog-badge-tools" title="Tools">' + _iconWrench + '</span>';
    if (m.thinking) b += '<span class="catalog-badge catalog-badge-think" title="Thinking">' + _iconBrain + '</span>';
    if (m.vision) b += '<span class="catalog-badge catalog-badge-vision" title="Vision">' + _iconEye + '</span>';
    b += m.parallel !== false
      ? '<span class="catalog-badge catalog-badge-par" title="Supports parallel requests"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg></span>'
      : '<span class="catalog-badge catalog-badge-nopar" title="No parallel — requests queue"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span>';
    if (m.uncensored) b += '<span class="catalog-badge" style="background:rgba(239,68,68,0.12);color:#f87171;" title="Uncensored">' + _iconUnlock + '</span>';
    return b;
  };

  dd.innerHTML = results.map((m, i) => {
    const isInst = installedModelNames.some(n => n === m.name || n.startsWith(m.name + ':') || n.startsWith(m.name + '-'));
    return '<div class="catalog-suggestion-item' + (i === catalogSuggestState.active ? ' catalog-suggestion-active' : '') + '" data-idx="' + i + '">' +
      '<div class="catalog-suggestion-icon">' + (m.uncensored ? _iconUnlock : _iconBrain) + '</div>' +
      '<div class="catalog-suggestion-info">' +
        '<div class="catalog-suggestion-name">' + highlightMatch(m.name, catalogSuggestState.query) + '</div>' +
        '<div class="catalog-suggestion-sub">' + esc(m.family) + ' · ' + esc(m.params) + (isInst ? ' · installed' : '') + '</div>' +
      '</div>' +
      '<div class="catalog-suggestion-badges">' + miniBadges(m) + '</div>' +
    '</div>';
  }).join('') + '<div class="catalog-suggestion-footer"><span>' + results.length + ' result' + (results.length !== 1 ? 's' : '') + '</span><span><kbd>\u2191\u2193</kbd> navigate · <kbd>Enter</kbd> details · <kbd>Esc</kbd> close</span></div>';
  dd.style.display = 'block';

  dd.querySelectorAll('.catalog-suggestion-item').forEach(el => {
    el.addEventListener('click', () => {
      const m = catalogSuggestState.results[parseInt(el.dataset.idx, 10)];
      if (m) openSuggestedModel(m);
    });
    // Row highlight on hover is pure CSS (:hover) — a JS mousemove re-highlight
    // here caused per-pixel churn and contributed to dropdown flicker.
  });
}

function showModelDetail(modelName) {
  const modal = $('modelDetailModal');
  if (!modal) return;

  // Find in database
  const dbEntry = MODEL_DATABASE.find(m => m.name === modelName);
  // Find in installed
  const isInstalled = installedModelNames.some(n => n === modelName || n.startsWith(modelName + ':') || n.startsWith(modelName + '-'));

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
  if (iconEl) iconEl.innerHTML = dbEntry?.uncensored ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>' : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a4 4 0 0 0-4 4c0 .5.1 1 .3 1.4A3.5 3.5 0 0 0 5 11c0 1.3.7 2.4 1.6 3A3 3 0 0 0 6 17a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3 3 3 0 0 0-.6-3A3.5 3.5 0 0 0 19 11a3.5 3.5 0 0 0-3.3-3.6c.2-.4.3-.9.3-1.4a4 4 0 0 0-4-4z"/></svg>';

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
        <div class="detail-cap-badge ${dbEntry.tools ? 'cap-yes' : 'cap-no'}">${S_WRENCH} Tools: ${dbEntry.tools ? 'Yes' : 'No'}</div>
        <div class="detail-cap-badge ${dbEntry.thinking ? 'cap-yes' : 'cap-no'}">${S_BRAIN} Thinking: ${dbEntry.thinking ? 'Yes' : 'No'}</div>
        <div class="detail-cap-badge ${dbEntry.vision ? 'cap-yes' : 'cap-no'}">${S_EYE} Vision: ${dbEntry.vision ? 'Yes' : 'No'}</div>
        <div class="detail-cap-badge ${dbEntry.parallel !== false ? 'cap-yes' : 'cap-no'}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg> Parallel: ${dbEntry.parallel !== false ? 'Yes' : 'No — requests queue'}</div>
        ${dbEntry.uncensored ? '<div class="detail-cap-badge cap-no" style="border:1px solid rgba(239,68,68,0.3);">' + _iconUnlock + ' Uncensored</div>' : ''}
      `;
    } else {
      capEl.innerHTML = '<div class="detail-cap-badge cap-no"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> Unknown capabilities — not in built-in database</div>';
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
    const installedQuants = installedModelNames.filter(n => n === modelName || n.startsWith(modelName + ':') || n.startsWith(modelName + '-'));
    quantEl.innerHTML = `<div class="detail-section-title">Available Quantizations</div>
      <div class="detail-quant-grid">${quants.map(q => {
        const isDef = q === defQuant;
        const isInst = installedQuants.some(n => n.toLowerCase().includes(q.toLowerCase()));
        return `<div class="detail-quant-chip ${isInst ? 'detail-quant-installed' : ''}" ${isInst ? '' : `onclick="event.stopPropagation(); pullQuantFromDetail('${modelName}', '${q}')"`} title="${isInst ? 'Already installed' : 'Click to pull ' + q}">${q}${isDef ? ' \u2605' : ''}${isInst ? ' \u2713' : ''}</div>`;
      }).join('')}</div>
      <div style="font-size:11px;color:var(--text-dim);margin-top:6px;">\u2605 = default \xb7 \u2713 = installed \xb7 Click a quantization to pull it</div>`;
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
            <span>${esc(v.name)} — ${v.params}${v.uncensored ? ' <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>' : ''}</span>
            <span>${isInst ? '<span class="detail-variant-tag" style="color:#4ade80;">Installed</span>' : '<span class="detail-variant-tag">' + (v.tools ? S_WRENCH : '') + (v.thinking ? S_BRAIN : '') + (v.vision ? S_EYE : '') + '</span>'}</span>
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
      pullBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Pull ' + modelName;
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

function pullQuantFromDetail(modelName, quant) {
  // modelName is like 'qwen3:8b', quant is like 'Q4_K_M'
  // Ollama pull format: 'qwen3:8b-q4_k_m' for non-default quant
  // Default quant: just pull 'qwen3:8b' as-is
  const dbEntry = MODEL_DATABASE.find(m => m.name === modelName);
  const defQuant = dbEntry?.defaultQuant || 'Q4_K_M';
  if (quant === defQuant) {
    pullModelFromCatalog(modelName);
  } else {
    pullModelFromCatalog(modelName + '-' + quant.toLowerCase());
  }
}

// ─── Pull Model ──────────────────────────────────────
let pullInProgress = false;

async function pullModelFromCatalog(modelName) {
  if (pullInProgress) return;
  pullInProgress = true;

  // Elements: catalog bar
  const status = $('pullModelStatus');
  const statusText = $('pullModelStatusText');
  const bar = $('pullModelBar');
  // Elements: detail popup
  const detailStatus = $('detailPullStatus');
  const detailStatusText = $('detailPullStatusText');
  const detailBar = $('detailPullBar');

  if (status) status.style.display = 'block';
  if (statusText) statusText.textContent = 'Preparing download for ' + modelName + '...';
  if (bar) { bar.style.width = '5%'; bar.style.background = ''; bar.style.transition = 'width 0.3s'; }
  if (detailStatus) detailStatus.style.display = 'block';
  if (detailStatusText) detailStatusText.textContent = 'Preparing download...';
  if (detailBar) { detailBar.style.width = '5%'; detailBar.style.background = ''; }

  // Subscribe to streaming progress
  let lastStage = '';
  const unsub = API.onPullProgress((p) => {
    if (p.status === 'done') {
      if (statusText) statusText.textContent = '\u2705 ' + modelName + ' pulled successfully!';
      if (bar) { bar.style.width = '100%'; bar.style.background = '#22c55e'; }
      if (detailStatusText) detailStatusText.innerHTML = '\u2705 <span style="color:#4ade80;">Download complete!</span>';
      if (detailBar) { detailBar.style.width = '100%'; detailBar.style.background = '#22c55e'; }
      return;
    }
    if (p.status === 'error') {
      if (statusText) statusText.textContent = '\u274c Failed: ' + (p.error || 'Unknown error');
      if (bar) bar.style.width = '0%';
      if (detailStatusText) detailStatusText.innerHTML = '\u274c <span style="color:#f87171;">Failed: ' + esc(p.error || 'Unknown error') + '</span>';
      if (detailBar) detailBar.style.width = '0%';
      return;
    }
    // Progress update from Ollama: { status, digest, total, completed }
    if (p.total && p.completed != null) {
      const pct = Math.min(99, Math.round((p.completed / p.total) * 100));
      const totalMB = (p.total / 1024 / 1024).toFixed(0);
      const doneMB = (p.completed / 1024 / 1024).toFixed(0);
      if (bar) bar.style.width = pct + '%';
      if (statusText) statusText.textContent = 'Downloading ' + modelName + ' \u2022 ' + doneMB + ' / ' + totalMB + ' MB (' + pct + '%)';
      if (detailStatusText) detailStatusText.innerHTML = '\u2b07\ufe0f Downloading \u2022 <b>' + doneMB + ' / ' + totalMB + ' MB</b> (' + pct + '%)';
      if (detailBar) detailBar.style.width = pct + '%';
      lastStage = '';
    } else if (p.status && p.status !== lastStage) {
      lastStage = p.status;
      if (statusText) statusText.textContent = '\u21bb ' + p.status + (p.digest ? ' \u2022 ' + p.digest.slice(0, 12) + '...' : '');
      if (detailStatusText) detailStatusText.innerHTML = '\u21bb ' + esc(p.status);
    }
  });

  try {
    const result = await API.pullModel(modelName);
    if (result.error) {
      if (statusText) statusText.textContent = '\u274c Failed: ' + result.error;
      if (bar) bar.style.width = '0%';
      if (detailStatusText) detailStatusText.innerHTML = '\u274c <span style="color:#f87171;">Failed: ' + esc(result.error) + '</span>';
    }
  } catch (e) {
    if (statusText) statusText.textContent = '\u274c Failed: ' + e.message;
    if (bar) bar.style.width = '0%';
    if (detailStatusText) detailStatusText.innerHTML = '\u274c <span style="color:#f87171;">Failed: ' + esc(e.message) + '</span>';
    if (detailBar) detailBar.style.width = '0%';
  }

  if (unsub) unsub();

  setTimeout(() => {
    loadModelCatalog();
    const modal = $('modelDetailModal');
    if (modal && modal.style.display !== 'none') {
      showModelDetail(modelName);
    }
  }, 1000);

  pullInProgress = false;
}

// ─── Bar Color Helper ──────────────────────────
function usageBarColor(pct) {
  if (pct >= 85) return '#ef4444'; // red
  if (pct >= 60) return '#eab308'; // yellow
  return '#22c55e'; // green
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
  renderCatalogSuggestions(e.target.value || '');
});

// Keyboard navigation for the suggestions dropdown
$('catalogSearchInput')?.addEventListener('keydown', (e) => {
  const dd = $('catalogSuggestions');
  if (!dd || dd.style.display === 'none') return;
  const max = catalogSuggestState.results.length;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (max) setActiveSuggestion((catalogSuggestState.active + 1) % max);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (max) setActiveSuggestion((catalogSuggestState.active - 1 + max) % max);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const m = catalogSuggestState.results[catalogSuggestState.active >= 0 ? catalogSuggestState.active : 0];
    if (m) openSuggestedModel(m);
  } else if (e.key === 'Escape') {
    closeCatalogSuggestions();
  }
});

// Click outside closes the dropdown
document.addEventListener('click', (e) => {
  if (!e.target.closest('.catalog-search-wrap')) closeCatalogSuggestions();
});

$('catalogRefreshBtn')?.addEventListener('click', async () => {
  await fetchModelCatalog(true);
  loadModelCatalog();
});

$('detailModalClose')?.addEventListener('click', closeModelDetail);
$('detailModalCancelBtn')?.addEventListener('click', closeModelDetail);
$('modelDetailModal')?.addEventListener('click', (e) => {
  if (e.target === $('modelDetailModal')) closeModelDetail();
});

// Cache location select (GPU/RAM)
$('kvCacheLocationSelect')?.addEventListener('change', (e) => {
  ollamaSettings.kvCacheOffload = e.target.value !== 'ram';
  updateOllamaSaveBtn();
});

function updateKvOffloadCards() {
  const sel = $('kvCacheLocationSelect');
  if (sel) sel.value = ollamaSettings.kvCacheOffload ? 'gpu' : 'ram';
}

// Cache quantization select
$('kvCacheTypeSelect')?.addEventListener('change', (e) => {
  ollamaSettings.kvCacheType = e.target.value || 'f16';
  updateOllamaSaveBtn();
});

// Context window size select
$('numCtxSelect')?.addEventListener('change', (e) => {
  ollamaSettings.defaultNumCtx = parseInt(e.target.value, 10) || 0;
  updateOllamaSaveBtn();
});

// Concurrency & Memory — parallel slots
function applyConcurrencySettings() {
  const sel = $('numParallelSelect');
  if (sel) {
    const cur = String(ollamaSettings.ollamaNumParallel || 0);
    sel.value = Array.from(sel.options).some(o => o.value === cur) ? cur : '0';
  }
  const mlm = $('maxLoadedModelsSelect');
  if (mlm) {
    const cur = String(ollamaSettings.ollamaMaxLoadedModels || 0);
    mlm.value = Array.from(mlm.options).some(o => o.value === cur) ? cur : '0';
  }
  const ka = $('keepAliveSelect');
  if (ka) ka.value = ollamaSettings.ollamaKeepAlive;
}

$('numParallelSelect')?.addEventListener('change', (e) => {
  ollamaSettings.ollamaNumParallel = parseInt(e.target.value, 10) || 0;
  updateOllamaSaveBtn();
});

$('maxLoadedModelsSelect')?.addEventListener('change', (e) => {
  ollamaSettings.ollamaMaxLoadedModels = parseInt(e.target.value, 10) || 0;
  updateOllamaSaveBtn();
});

$('keepAliveSelect')?.addEventListener('change', (e) => {
  ollamaSettings.ollamaKeepAlive = e.target.value || '';
  updateOllamaSaveBtn();
});

function updateCtxPresets() {
  const sel = $('numCtxSelect');
  if (sel) {
    const cur = String(ollamaSettings.defaultNumCtx || 0);
    sel.value = Array.from(sel.options).some(o => o.value === cur) ? cur : '0';
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
    if (gpuName) gpuName.textContent = ollamaGpuInfo.name || 'GPU';
    if (vramBar) { const vpct = Math.round((ollamaGpuInfo.memUsed / ollamaGpuInfo.memTotal) * 100); vramBar.style.width = vpct + '%'; vramBar.style.background = usageBarColor(vpct); }
    if (vramText) vramText.textContent = ollamaGpuInfo.estimateOnly
      ? 'Live usage unavailable' + (ollamaGpuInfo.memTotal ? ' (' + (ollamaGpuInfo.memTotal / 1024).toFixed(0) + ' GB card)' : '')
      : ollamaGpuInfo.memUsed + ' / ' + ollamaGpuInfo.memTotal + ' MB';
    if (rec) {
      if (ollamaGpuInfo.estimateOnly) {
        rec.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/></svg> ' + (ollamaGpuInfo.name || 'GPU') + ' detected. Live VRAM monitoring needs rocm-smi (not installed) — Ollama still uses this GPU for inference.';
      } else {
      const freeVram = ollamaGpuInfo.memTotal - ollamaGpuInfo.memUsed;
      if (freeVram < 2048) rec.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> Low VRAM free (' + (freeVram / 1024).toFixed(1) + ' GB). Consider disabling GPU offloading to free VRAM for model weights.';
      else if (freeVram < 4096) rec.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/></svg> Moderate VRAM available. f16 context cache recommended. Consider q8_0 if context feels tight.';
      else rec.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Plenty of VRAM free (' + (freeVram / 1024).toFixed(1) + ' GB). GPU offloading with f16 is ideal.';
      }
    }
  } else {
    if (gpuName) gpuName.textContent = 'No dedicated GPU detected';
    if (vramText) vramText.textContent = '—';
    if (rec) rec.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/></svg> No GPU detected. Context cache will run on RAM. Set context length to match your available system RAM.';
  }
  // RAM
  if (ollamaRamInfo) {
    if (ramBar) { ramBar.style.width = ollamaRamInfo.usagePercent + '%'; ramBar.style.background = usageBarColor(ollamaRamInfo.usagePercent); }
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
      ollamaNumParallel: ollamaSettings.ollamaNumParallel,
      ollamaMaxLoadedModels: ollamaSettings.ollamaMaxLoadedModels,
      ollamaKeepAlive: ollamaSettings.ollamaKeepAlive,
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
    hint.textContent = 'Ollama was started by this app and will be restarted automatically.';
    modal.style.display = 'flex';

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
      defaultNumCtx: ollamaSettings.defaultNumCtx,
      ollamaNumParallel: ollamaSettings.ollamaNumParallel,
      ollamaMaxLoadedModels: ollamaSettings.ollamaMaxLoadedModels,
      ollamaKeepAlive: ollamaSettings.ollamaKeepAlive,
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
