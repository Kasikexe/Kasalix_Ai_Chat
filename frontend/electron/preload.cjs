const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  /** Whether this is running inside the Electron desktop app */
  isElectron: true,

  // ─── Server Config ──────────────────────────
  getBackendUrl: () => ipcRenderer.invoke('get-backend-url'),
  setBackendUrl: (url) => ipcRenderer.invoke('set-backend-url', url),
  checkServerHealth: () => ipcRenderer.invoke('check-server-health'),
  testServerUrl: (url) => ipcRenderer.invoke('test-server-url', url),

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
