package com.indie.watchtime.update;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
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
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.UnknownHostException;

/**
 * Downloads a release APK and hands it to the system installer, matching
 * src/lib/updates/installer.ts.
 *
 * This is the GitHub Releases update path. It is not a Play Store flow, and
 * Play does not allow an app to update itself this way: this class and the
 * REQUEST_INSTALL_PACKAGES permission have to be removed from a Play build
 * (docs/backup-and-updates.md, item 6).
 *
 * What it does not do is decide anything or install silently. The web layer
 * says which release to fetch; Android shows its own confirmation before
 * installing, and refuses a package signed with a different key from the
 * installed app, which is what makes a tampered download harmless.
 *
 * Error codes passed back in reject(): OFFLINE, DOWNLOAD_FAILED,
 * NOT_AN_UPDATE, NOT_DOWNLOADED, INSTALL_BLOCKED, NO_INSTALLER. The web layer
 * turns each into its own message.
 */
@CapacitorPlugin(name = "WatchTimeUpdater")
public class UpdateInstallerPlugin extends Plugin {

    /**
     * The only place a download may come from. Checked here as well as in
     * the web layer, so nothing that reaches this plugin can point it at
     * another host. GitHub redirects the asset to its own storage host;
     * that redirect is followed, but the starting URL has to be this one.
     */
    private static final String ASSET_PREFIX = "https://github.com/AtharvaK14/WatchTime/releases/download/";

    private static final String UPDATE_DIR = "updates";
    private static final String UPDATE_FILE = "WatchTime-update.apk";
    private static final String APK_MIME = "application/vnd.android.package-archive";

    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 30_000;
    /** Progress events are sent no more often than this, so a fast download does not flood the bridge. */
    private static final long PROGRESS_INTERVAL_MS = 250;

    private volatile boolean downloading = false;

    private File updateFile() {
        // Cache, not files: a downloaded installer is disposable, the system
        // may reclaim it, and res/xml/file_paths.xml already exposes the cache
        // directory through the FileProvider.
        return new File(new File(getContext().getCacheDir(), UPDATE_DIR), UPDATE_FILE);
    }

    /** Whether Android will let this app start an install. Always true before Android 8. */
    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject result = new JSObject();
        result.put("allowed", installsAllowed());
        call.resolve(result);
    }

    private boolean installsAllowed() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        return getContext().getPackageManager().canRequestPackageInstalls();
    }

    /**
     * Opens the "Install unknown apps" switch for this app. There is no
     * runtime dialog for this permission; the settings screen is the only
     * way to grant it.
     */
    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        Context context = getContext();
        try {
            Intent intent;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + context.getPackageName()));
            } else {
                intent = new Intent(Settings.ACTION_SECURITY_SETTINGS);
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("No settings screen for installing apps on this device.", "NO_INSTALLER");
        }
    }

    /**
     * Downloads the APK at `url` into the cache. Emits "progress" events
     * ({ received, total }, total -1 when the server does not say) and
     * resolves once the file is complete and has been checked.
     */
    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !url.startsWith(ASSET_PREFIX)) {
            call.reject("Not a WatchTime release download.", "DOWNLOAD_FAILED");
            return;
        }
        if (downloading) {
            call.reject("A download is already in progress.", "DOWNLOAD_FAILED");
            return;
        }
        downloading = true;
        new Thread(() -> {
            try {
                File file = fetch(url);
                String problem = checkPackage(file);
                if (problem != null) {
                    // Not something to leave lying around for install() to pick up.
                    file.delete();
                    call.reject(problem, "NOT_AN_UPDATE");
                    return;
                }
                call.resolve();
            } catch (UnknownHostException e) {
                call.reject("No connection.", "OFFLINE");
            } catch (InterruptedIOException e) {
                // Connect or read timed out.
                call.reject("The download timed out.", "DOWNLOAD_FAILED");
            } catch (IOException e) {
                call.reject("The download failed.", "DOWNLOAD_FAILED");
            } finally {
                downloading = false;
            }
        }, "watchtime-update-download").start();
    }

    private File fetch(String url) throws IOException {
        File target = updateFile();
        File dir = target.getParentFile();
        if (dir == null || (!dir.isDirectory() && !dir.mkdirs())) throw new IOException("cannot create update folder");
        // Download under another name, so a half-finished file is never the
        // one install() would hand to Android.
        File partial = new File(dir, UPDATE_FILE + ".part");

        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setInstanceFollowRedirects(true);
        try {
            int status = connection.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK) throw new IOException("unexpected status " + status);
            long total = connection.getContentLengthLong();
            long received = 0;
            long lastEvent = 0;
            byte[] buffer = new byte[64 * 1024];
            try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(partial)) {
                int read;
                while ((read = in.read(buffer)) != -1) {
                    out.write(buffer, 0, read);
                    received += read;
                    long now = System.currentTimeMillis();
                    if (now - lastEvent >= PROGRESS_INTERVAL_MS) {
                        lastEvent = now;
                        notifyProgress(received, total);
                    }
                }
            }
            if (total > 0 && received != total) throw new IOException("download was cut short");
            notifyProgress(received, total);
            if (target.exists() && !target.delete()) throw new IOException("cannot replace earlier download");
            if (!partial.renameTo(target)) throw new IOException("cannot finish download");
            return target;
        } catch (IOException e) {
            partial.delete();
            throw e;
        } finally {
            connection.disconnect();
        }
    }

    private void notifyProgress(long received, long total) {
        JSObject event = new JSObject();
        event.put("received", received);
        event.put("total", total);
        notifyListeners("progress", event);
    }

    /**
     * A reason this file must not be offered for install, or null if it is
     * fine: it has to be a readable package, for this app, and not older
     * than the one installed. The signature is Android's to check.
     */
    private String checkPackage(File file) {
        PackageManager pm = getContext().getPackageManager();
        PackageInfo downloaded = pm.getPackageArchiveInfo(file.getAbsolutePath(), 0);
        if (downloaded == null) return "The downloaded file is not an Android package.";
        if (!getContext().getPackageName().equals(downloaded.packageName)) {
            return "The downloaded file is not a WatchTime package.";
        }
        try {
            PackageInfo installed = pm.getPackageInfo(getContext().getPackageName(), 0);
            if (versionCode(downloaded) < versionCode(installed)) {
                return "The downloaded version is older than the one installed.";
            }
        } catch (PackageManager.NameNotFoundException e) {
            // This app is not installed, while running. Nothing to compare against.
        }
        return null;
    }

    private static long versionCode(PackageInfo info) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
    }

    /** Hands the downloaded APK to the system installer, which asks the user to confirm. */
    @PluginMethod
    public void install(PluginCall call) {
        File file = updateFile();
        if (!file.isFile()) {
            call.reject("Nothing has been downloaded.", "NOT_DOWNLOADED");
            return;
        }
        if (!installsAllowed()) {
            call.reject("Installing apps from WatchTime is not allowed yet.", "INSTALL_BLOCKED");
            return;
        }
        Context context = getContext();
        try {
            Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, APK_MIME);
            // The installer is another app; this is what lets it read the file.
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException | IllegalArgumentException e) {
            call.reject("This device has no installer for the downloaded file.", "NO_INSTALLER");
        }
    }
}
