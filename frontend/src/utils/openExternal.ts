import { isInCapacitor } from '../services/api';

export { REPO_URL, NEW_ISSUE_URL, IDEAS_URL } from '../config';

/**
 * Open a URL in the right place for the current client:
 * - Electron desktop  → system browser via IPC
 * - Android (Capacitor) → system browser via the WebView `_system` target
 * - Plain web          → new browser tab
 */
export function openExternal(url: string) {
  const api = (window as any).electronAPI;
  if (api?.openExternal) {
    api.openExternal(url);
    return;
  }
  if (isInCapacitor()) {
    window.open(url, '_system');
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}
