package com.indie.watchtime.widget;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Poster artwork for widget rows.
 *
 * The app shows TMDB images by URL and lets the WebView handle the rest. A
 * widget cannot: RemoteViews carries bitmaps across a process boundary, so the
 * artwork has to be fetched and decoded here. Two caches sit in front of the
 * network - an in-memory LRU for the current process and a disk cache under
 * the app's own cache directory - because a RemoteViewsFactory rebuilds every
 * row on each refresh and re-downloading a poster every half hour for a widget
 * that has not changed would be indefensible.
 *
 * Every call happens on a background thread, which is why the network read is
 * synchronous here.
 *
 * Public, and shared with com.indie.watchtime.notify: a release notification
 * needs the very same poster as its large icon. Going through this rather than
 * fetching separately means a show already drawn on a widget costs nothing to
 * put on a notification, and there is one place that knows how to size and
 * cache TMDB artwork rather than two that can drift.
 */
public final class PosterCache {

    /** Widget posters are drawn at ~36dp; anything larger is wasted transfer and memory. */
    private static final int MAX_DIMENSION = 180;
    private static final int CONNECT_TIMEOUT_MS = 8000;
    private static final int READ_TIMEOUT_MS = 8000;
    private static final int MEMORY_ENTRIES = 24;
    /** Disk entries older than this are refetched; TMDB does change artwork. */
    private static final long DISK_TTL_MS = 14L * 24 * 60 * 60 * 1000;

    private static final Map<String, Bitmap> MEMORY = new LinkedHashMap<String, Bitmap>(
            MEMORY_ENTRIES, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, Bitmap> eldest) {
            return size() > MEMORY_ENTRIES;
        }
    };

    private PosterCache() {}

    /** The poster for a URL, or null if it cannot be had. Callers fall back to the placeholder drawable. */
    public static Bitmap get(Context context, String url) {
        if (url == null || url.isEmpty()) return null;
        String key = Integer.toHexString(url.hashCode());

        synchronized (MEMORY) {
            Bitmap cached = MEMORY.get(key);
            if (cached != null && !cached.isRecycled()) return cached;
        }

        File file = new File(cacheDir(context), key + ".jpg");
        if (file.exists() && System.currentTimeMillis() - file.lastModified() < DISK_TTL_MS) {
            Bitmap fromDisk = decode(file);
            if (fromDisk != null) {
                remember(key, fromDisk);
                return fromDisk;
            }
        }

        Bitmap downloaded = download(url, file);
        if (downloaded != null) remember(key, downloaded);
        return downloaded;
    }

    private static void remember(String key, Bitmap bitmap) {
        synchronized (MEMORY) {
            MEMORY.put(key, bitmap);
        }
    }

    private static File cacheDir(Context context) {
        File dir = new File(context.getCacheDir(), "widget_posters");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    private static Bitmap decode(File file) {
        // Two-pass decode: measure first, then load at a sample size that gets
        // close to MAX_DIMENSION. Decoding a full-size poster straight into a
        // RemoteViews bitmap risks the hard size limit the framework imposes on
        // what a widget may hand the launcher.
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(file.getAbsolutePath(), bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null;

        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight);
        return BitmapFactory.decodeFile(file.getAbsolutePath(), options);
    }

    private static int sampleSize(int width, int height) {
        int sample = 1;
        while (width / (sample * 2) >= MAX_DIMENSION && height / (sample * 2) >= MAX_DIMENSION) {
            sample *= 2;
        }
        return sample;
    }

    private static Bitmap download(String url, File destination) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setInstanceFollowRedirects(true);
            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) return null;

            try (InputStream in = connection.getInputStream();
                 FileOutputStream out = new FileOutputStream(destination)) {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = in.read(buffer)) != -1) {
                    out.write(buffer, 0, read);
                }
            }
            return decode(destination);
        } catch (Exception e) {
            // Offline, a TMDB hiccup, or no space. The row renders with its
            // placeholder, exactly as the app does for a title with no poster.
            destination.delete();
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }
}
