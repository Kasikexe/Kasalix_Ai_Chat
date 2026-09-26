/// <reference types="vite/client" />

declare module '*.css';

interface ElectronAPI {
  isElectron: boolean;
  getServerUrl: () => Promise<string>;
  checkServerHealth: () => Promise<{ online: boolean }>;
  /** GitHub release list fetched by the main process (desktop changelog). */
  fetchGitHubReleases?: () => Promise<{ ok: boolean; data?: unknown; error?: string }>;
}

interface Window {
  electronAPI?: ElectronAPI;
}
