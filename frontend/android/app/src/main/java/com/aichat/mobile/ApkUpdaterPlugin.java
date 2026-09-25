package com.aichat.mobile;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * ApkUpdater — in-app self-update for the Android client.
 *
 * Downloads the release APK from GitHub into the app's private cache, then
 * hands it to the Android package installer via FileProvider. Android always
 * shows its own install confirmation (silent install is impossible for a
 * normal app); the one-time "install unknown apps" grant is requested on
 * demand before the first install.
 */
@CapacitorPlugin(name = "ApkUpdater")
public class ApkUpdaterPlugin extends Plugin {

    /** Installed app version — compared against the GitHub release tag. */
    @PluginMethod
    public void getVersion(PluginCall call) {
        try {
            PackageInfo pi = getContext().getPackageManager()
                    .getPackageInfo(getContext().getPackageName(), 0);
            JSObject ret = new JSObject();
            ret.put("version", pi.versionName);
            ret.put("build", Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("getVersion failed: " + e.getMessage());
        }
    }

    /** Whether this app may install packages (user granted "install unknown apps"). */
    @PluginMethod
    public void canRequestInstall(PluginCall call) {
        JSObject ret = new JSObject();
        boolean allowed = true; // Android < 8 allows installs by default
        if (Build.VERSION.SDK_INT >= 26) {
            try {
                allowed = getContext().getPackageManager().canRequestPackageInstalls();
            } catch (Exception ignored) {
                allowed = false;
            }
        }
        ret.put("allowed", allowed);
        call.resolve(ret);
    }

    /** Open the system settings page where the user grants install permission. */
    @PluginMethod
    public void requestInstallPermission(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getContext().getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("requestInstallPermission failed: " + e.getMessage());
        }
    }

    /** Hand a downloaded APK to the system installer (install confirmation follows). */
    @PluginMethod
    public void installApk(PluginCall call) {
        String path = call.getString("path", "");
        try {
            File apk = new File(path);
            if (!apk.exists()) {
                call.reject("APK file not found: " + path);
                return;
            }
            Uri uri = FileProvider.getUriForFile(getContext(),
                    getContext().getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("installApk failed: " + e.getMessage());
        }
    }

    /**
     * Download the APK in the background into cache/apk_updates/, emitting
     * apkDownloadProgress events. Resolves with the local file path.
     */
    @PluginMethod
    public void downloadApk(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.startsWith("https://") && !url.startsWith("http://")) {
            call.reject("Invalid download URL");
            return;
        }
        final String name = url.substring(url.lastIndexOf('/') + 1).split("\\?")[0];
        File dir = new File(getContext().getCacheDir(), "apk_updates");
        if (!dir.exists()) dir.mkdirs();
        // Remove stale downloads — only the newest APK is ever kept.
        File[] old = dir.listFiles();
        if (old != null) for (File f : old) f.delete();
        final File dest = new File(dir, name);
        final String finalUrl = url;

        Thread t = new Thread(() -> {
            try {
                HttpURLConnection conn = (HttpURLConnection) new URL(finalUrl).openConnection();
                conn.setInstanceFollowRedirects(true);
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(60000);
                conn.setRequestProperty("User-Agent", "Kasalix-Android/1.0");
                int code = conn.getResponseCode();
                // One manual redirect hop (GitHub's browser_download_url hops to the CDN)
                if (code >= 300 && code < 400) {
                    String loc = conn.getHeaderField("Location");
                    conn.disconnect();
                    if (loc == null) {
                        call.reject("Download failed: redirect without Location");
                        return;
                    }
                    conn = (HttpURLConnection) new URL(loc).openConnection();
                    conn.setInstanceFollowRedirects(true);
                    conn.setRequestProperty("User-Agent", "Kasalix-Android/1.0");
                    code = conn.getResponseCode();
                }
                if (code != 200) {
                    call.reject("Download failed: HTTP " + code);
                    return;
                }
                long total = conn.getContentLength();
                long received = 0;
                int read;
                byte[] buf = new byte[16384];
                try (InputStream in = conn.getInputStream(); FileOutputStream out = new FileOutputStream(dest)) {
                    while ((read = in.read(buf)) != -1) {
                        out.write(buf, 0, read);
                        received += read;
                        if (total > 0) {
                            JSObject prog = new JSObject();
                            prog.put("percent", (int) Math.round(received * 100.0 / total));
                            prog.put("received", received);
                            prog.put("total", total);
                            notifyListeners("apkDownloadProgress", prog);
                        }
                    }
                }
                JSObject ret = new JSObject();
                ret.put("path", dest.getAbsolutePath());
                ret.put("size", dest.length());
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Download failed: " + e.getMessage());
            }
        });
        t.setDaemon(true);
        t.start();
    }
}
