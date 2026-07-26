/// <reference types="vite/client" />

declare module '*.css';

interface ElectronAPI {
  isElectron: boolean;
  getServerUrl: () => Promise<string>;
  checkServerHealth: () => Promise<{ online: boolean }>;
}

interface Window {
  electronAPI?: ElectronAPI;
}
