// Android in-app self-update bridge — talks to the native ApkUpdaterPlugin
// (android/app/src/main/java/com/aichat/mobile/ApkUpdaterPlugin.java).
//
// Flow: GitHub /releases/latest → compare versions → downloadApk (progress
// events) → installApk hands the APK to the system installer. Android always
// shows its own install confirmation; the one-time "install unknown apps"
// grant is requested on demand.

import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { GITHUB_REPO } from '../config';

export interface ApkUpdaterPluginInterface {
  getVersion(): Promise<{ version: string; build: number }>;
  canRequestInstall(): Promise<{ allowed: boolean }>;
  requestInstallPermission(): Promise<void>;
  downloadApk(opts: { url: string }): Promise<{ path: string; size: number }>;
  installApk(opts: { path: string }): Promise<void>;
  addListener(
    eventName: 'apkDownloadProgress',
    listener: (data: { percent: number; received: number; total: number }) => void,
  ): Promise<PluginListenerHandle>;
}

const ApkUpdater = registerPlugin<ApkUpdaterPluginInterface>('ApkUpdater');

/** True only on a real Android build (not a desktop browser / Electron). */
export function isAndroidApp(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

/** Version of the INSTALLED app, straight from the OS (not the JS bundle). */
export async function getInstalledApkVersion(): Promise<string> {
  const { version } = await ApkUpdater.getVersion();
  return version;
}

/** Latest GitHub release version + its APK download URL, or null. */
export async function getLatestApkRelease(): Promise<{ version: string; url: string } | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github.v3+json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const version = String(data.tag_name || '').replace(/^v/i, '');
    const asset = (data.assets || []).find(
      (a: { name: string; browser_download_url: string }) =>
        a.name.toLowerCase().endsWith('.apk'),
    );
    if (!version || !asset) return null;
    return { version, url: asset.browser_download_url };
  } catch {
    return null;
  }
}

/** Numeric version compare ("0.11.0" vs "0.10.15") — >0 when a is newer. */
export function compareApkVersions(a: string, b: string): number {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

export interface ApkUpdateAvailability {
  updateAvailable: boolean;
  latestVersion: string;
  downloadUrl: string;
  currentVersion: string;
}

/** One call the UpdateBanner needs on Android: is there a newer APK on GitHub? */
export async function checkApkUpdate(): Promise<ApkUpdateAvailability | null> {
  const [current, latest] = await Promise.all([getInstalledApkVersion(), getLatestApkRelease()]);
  if (!current || !latest) return null;
  return {
    updateAvailable: compareApkVersions(latest.version, current) > 0,
    latestVersion: latest.version,
    downloadUrl: latest.url,
    currentVersion: current,
  };
}

/** Download with progress; resolves with the local file path. */
export async function downloadApk(
  url: string,
  onPercent: (p: number) => void,
): Promise<{ path: string }> {
  const handle = await ApkUpdater.addListener('apkDownloadProgress', (d) => onPercent(d.percent));
  try {
    return await ApkUpdater.downloadApk({ url });
  } finally {
    handle.remove();
  }
}

/** Ensure the install permission, then hand the APK to the system installer. */
export async function installApk(path: string): Promise<void> {
  const { allowed } = await ApkUpdater.canRequestInstall();
  if (!allowed) {
    await ApkUpdater.requestInstallPermission();
    // The user lands in system settings; the actual install happens when
    // they come back and tap "Install" again.
    throw new Error('Grant "Install unknown apps" for Kasalix, then tap Install again.');
  }
  await ApkUpdater.installApk({ path });
}
