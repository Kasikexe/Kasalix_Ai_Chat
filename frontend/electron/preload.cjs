const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  /** Whether this is running inside the Electron desktop app */
  isElectron: true,

  // ─── Auto-Update ────────────────────────────
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateAvailable: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('update-available', handler);
    return () => ipcRenderer.removeListener('update-available', handler);
  },
  onUpdateDownloadProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('update-download-progress', handler);
    return () => ipcRenderer.removeListener('update-download-progress', handler);
  },
  onUpdateDownloaded: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('update-downloaded', handler);
    return () => ipcRenderer.removeListener('update-downloaded', handler);
  },
  onUpdateError: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('update-error', handler);
    return () => ipcRenderer.removeListener('update-error', handler);
  },

  // ─── Update Preference ──────────────────────
  getUpdatePreference: () => ipcRenderer.invoke('get-update-preference'),
  setUpdatePreference: (enabled) => ipcRenderer.invoke('set-update-preference', enabled),

  // ─── Server Config ──────────────────────────
  getBackendUrl: () => ipcRenderer.invoke('get-backend-url'),
  setBackendUrl: (url) => ipcRenderer.invoke('set-backend-url', url),
  checkServerHealth: () => ipcRenderer.invoke('check-server-health'),
  testServerUrl: (url) => ipcRenderer.invoke('test-server-url', url),

  // ─── Folder Dialog ───────────────────────────
  openFolderDialog: () => ipcRenderer.invoke('open-folder-dialog'),

  // ─── Network Detection ──────────────────────
  detectIPs: () => ipcRenderer.invoke('detect-ips'),
  scanSubnet: () => ipcRenderer.invoke('scan-subnet'),

  // ─── Local File Operations ──────────────────
  getDefaultWorkspace: () => ipcRenderer.invoke('get-default-workspace'),
  listDir: (dirPath) => ipcRenderer.invoke('list-dir', dirPath),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('write-file', filePath, content),
  deleteFile: (filePath) => ipcRenderer.invoke('delete-file', filePath),
});
