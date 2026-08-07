const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('serverAPI', {
  // ─── Server Control ────────────────────────
  startServer: (httpMode) => ipcRenderer.invoke('server-start', httpMode),
  stopServer: () => ipcRenderer.invoke('server-stop'),
  getServerStatus: () => ipcRenderer.invoke('server-status'),
  isPortOpen: (port) => ipcRenderer.invoke('server-is-port-open', port),

  // ─── System Stats ──────────────────────────
  getStats: () => ipcRenderer.invoke('get-stats'),
  getIPs: () => ipcRenderer.invoke('get-ips'),

  // ─── Ollama ────────────────────────────────
  getOllamaModels: () => ipcRenderer.invoke('get-ollama-models'),
  checkOllama: () => ipcRenderer.invoke('check-ollama'),

  // ─── Bun / Ollama / FFmpeg Auto-Install ───────
  checkBun: () => ipcRenderer.invoke('check-bun'),
  installBun: () => ipcRenderer.invoke('install-bun'),
  installOllama: () => ipcRenderer.invoke('install-ollama'),
  checkFfmpeg: () => ipcRenderer.invoke('check-ffmpeg'),
  installFfmpeg: () => ipcRenderer.invoke('install-ffmpeg'),
  onInstallProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('install-progress', handler);
    return () => ipcRenderer.removeListener('install-progress', handler);
  },

  // ─── Downloads ─────────────────────────────
  openDownload: (url) => ipcRenderer.invoke('open-download', url),

  // ─── App Info ──────────────────────────────
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),

  // ─── Real-time Updates (main → renderer) ───
  onDashboardUpdate: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('dashboard-update', handler);
    return () => ipcRenderer.removeListener('dashboard-update', handler);
  },
  onServerLog: (callback) => {
    const handler = (_event, text) => callback(text);
    ipcRenderer.on('server-log', handler);
    return () => ipcRenderer.removeListener('server-log', handler);
  },
  onServerStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('server-status', handler);
    return () => ipcRenderer.removeListener('server-status', handler);
  },
  onBunNotFound: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('bun-not-found', handler);
    return () => ipcRenderer.removeListener('bun-not-found', handler);
  },

  // ─── Window Control ──────────────────────────
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),

  // ─── GUI Settings Persistence ─────────────────
  saveGuiSettings: (settings) => ipcRenderer.invoke('save-gui-settings', settings),
  loadGuiSettings: () => ipcRenderer.invoke('load-gui-settings'),

  // ─── Icon Picker ───────────────────────────────
  pickIcon: () => ipcRenderer.invoke('pick-icon'),

  // ─── Settings Password ─────────────────────────
  authSettings: (password) => ipcRenderer.invoke('auth-settings', password),
  changeSettingsPassword: (current, next) => ipcRenderer.invoke('change-settings-password', current, next),
  resetSettingsPassword: () => ipcRenderer.invoke('reset-settings-password'),

  // ─── User Management ───────────────────────────
  getUsers: () => ipcRenderer.invoke('get-users'),

  // ─── Model Settings ────────────────────────────
  getInstalledModels: () => ipcRenderer.invoke('get-installed-models'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (payload) => ipcRenderer.invoke('save-settings', payload),

  // ─── Speed Test ─────────────────────────────────
  runSpeedTests: () => ipcRenderer.invoke('speedtest-run'),
  getSpeedTestResults: () => ipcRenderer.invoke('speedtest-results'),
  deleteSpeedTestResult: (id) => ipcRenderer.invoke('speedtest-delete', id),

  // ─── Download Manager ─────────────────────────
  downloadRelease: (assetName) => ipcRenderer.invoke('download-release', assetName),
  getReleaseFiles: () => ipcRenderer.invoke('get-release-files'),
  checkGitHubRelease: () => ipcRenderer.invoke('check-github-release'),

  onDownloadProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('download-progress', handler);
    return () => ipcRenderer.removeListener('download-progress', handler);
  },
});
