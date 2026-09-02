package com.indie.watchtime.widget;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.webkit.WebViewAssetLoader;

import com.getcapacitor.CapConfig;

/**
 * The episode detail overlay a widget row opens.
 *
 * Tapping a widget row must not take the user into the app, so this is a
 * translucent, full-screen activity whose only content is a WebView. The page
 * it loads is the app's own build with ?wtpanel=episode, which renders nothing
 * but EpisodeDetailsPanel over a transparent background - so what appears is a
 * pop-up over the home screen, drawn by the same component the app uses, and
 * the user is never navigated to the app's home screen.
 *
 * The important detail is the ORIGIN. The page is served over
 * https://localhost, the same scheme and hostname Capacitor serves MainActivity
 * from (both read from CapConfig below rather than hardcoded, so they cannot
 * drift). Same origin in the same app means the same IndexedDB, so this
 * overlay reads and writes the real library. Marking an episode watched here
 * is a genuine write, which is why the widget can be refreshed immediately
 * instead of queueing an intention for the app to replay later.
 *
 * It deliberately does not extend BridgeActivity: BridgeActivity forces its own
 * opaque theme in onCreate, which would make the overlay a solid screen rather
 * than a pop-up. The small amount of Capacitor this page needs is replaced by
 * the JavascriptInterface below.
 */
public class EpisodePanelActivity extends AppCompatActivity {

    public static final String EXTRA_SHOW_ID = "showId";
    public static final String EXTRA_EPISODE_KEY = "episodeKey";
    /** Coming Up rows pass this: an episode that has not aired cannot be marked watched. */
    public static final String EXTRA_READONLY = "readonly";

    private static final String INTERFACE_NAME = "WatchTimePanelHost";

    private WebView webView;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        int showId = getIntent().getIntExtra(EXTRA_SHOW_ID, 0);
        String episodeKey = getIntent().getStringExtra(EXTRA_EPISODE_KEY);
        boolean readonly = getIntent().getBooleanExtra(EXTRA_READONLY, false);
        if (episodeKey == null || episodeKey.isEmpty()) {
            finish();
            return;
        }

        CapConfig config = CapConfig.loadDefault(this);
        String scheme = config.getAndroidScheme();
        String hostname = config.getHostname();

        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .setDomain(hostname)
                .setHttpAllowed(!"https".equals(scheme))
                .addPathHandler("/", new PublicAssetsPathHandler(this))
                .build();

        webView = new WebView(this);
        // Transparent all the way down: the activity window, this view, and the
        // page's html/body. Any opaque layer in that chain would hide the home
        // screen and turn the overlay back into a full screen.
        webView.setBackgroundColor(0x00000000);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        // localStorage, which the shared code reads for the OMDb key and the
        // stale-days threshold. IndexedDB needs no separate switch.
        settings.setDomStorageEnabled(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // The overlay is one page. Anything trying to navigate
                // elsewhere is not something a detail panel should be doing.
                return true;
            }
        });

        webView.addJavascriptInterface(new PanelHost(), INTERFACE_NAME);
        setContentView(webView);

        Uri url = new Uri.Builder()
                .scheme(scheme)
                .authority(hostname)
                .path("/index.html")
                .appendQueryParameter("wtpanel", "episode")
                .appendQueryParameter("showId", String.valueOf(showId))
                .appendQueryParameter("episodeKey", episodeKey)
                .appendQueryParameter("readonly", readonly ? "1" : "0")
                .build();
        webView.loadUrl(url.toString());
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            // Detach before destroying: a WebView left in the hierarchy can
            // outlive the activity and leak it.
            webView.removeJavascriptInterface(INTERFACE_NAME);
            setContentView(new android.view.View(this));
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    /**
     * The page's channel back to native. Three methods, matching
     * src/lib/widget/panelHost.ts.
     *
     * All are called on a WebView JavaScript thread, so anything touching the
     * activity or the widget manager is posted to the main thread.
     */
    private class PanelHost {

        @JavascriptInterface
        public void close() {
            runOnUiThread(() -> {
                finish();
                // No enter animation on the way out; the window animation from
                // the theme handles the fade.
                overridePendingTransition(0, android.R.anim.fade_out);
            });
        }

        /**
         * Stores a freshly computed snapshot and redraws every placed widget.
         *
         * This is what closes the loop the old queue could not: the page has
         * just written the watch to IndexedDB and recomputed Up Next from it,
         * so by the time the overlay closes the widget behind it already shows
         * the next episode. Nothing waits for the app to be launched.
         */
        @JavascriptInterface
        public void updateSnapshot(String snapshot) {
            if (snapshot == null || snapshot.isEmpty()) return;
            runOnUiThread(() -> {
                WidgetStore.writeSnapshot(getApplicationContext(), snapshot);
                BaseWidgetProvider.refreshAll(getApplicationContext());
            });
        }

        /**
         * Hands off to the main app on an explicit user action - tapping the
         * season/episode capsule or the episode title to see the show's full
         * episode list.
         *
         * This is the ONLY route out of the overlay and into the app, and it
         * exists precisely because the overlay must not do this on its own.
         * A widget row tap, and marking an episode watched, both stay here.
         *
         * The target goes through the same pending-deep-link slot a widget
         * header tap uses, rather than a new intent extra: MainActivity is
         * singleTask, so a launch may either cold-start the app or resume an
         * existing task, and the stored-target path is the one that already
         * handles both (the web layer drains it at mount AND on resume).
         */
        @JavascriptInterface
        public void openInApp(String target) {
            if (target == null || target.isEmpty()) return;
            runOnUiThread(() -> {
                android.content.Context context = getApplicationContext();
                WidgetStore.setPendingDeepLink(context, target);
                Intent openApp = new Intent(context, com.indie.watchtime.MainActivity.class);
                openApp.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                context.startActivity(openApp);
                // The overlay has served its purpose; leaving it behind the app
                // would put a stale panel on the back stack.
                finish();
                overridePendingTransition(0, android.R.anim.fade_out);
            });
        }
    }

    /**
     * Serves the built web app out of assets/public.
     *
     * WebViewAssetLoader's own AssetsPathHandler maps a URL path straight onto
     * the assets root, but Capacitor stages the web build one level down in
     * assets/public, so the prefix has to be applied here.
     */
    private static class PublicAssetsPathHandler implements WebViewAssetLoader.PathHandler {

        private static final String ASSET_ROOT = "public";

        private final android.content.Context context;

        PublicAssetsPathHandler(android.content.Context context) {
            this.context = context.getApplicationContext();
        }

        @Nullable
        @Override
        public WebResourceResponse handle(String path) {
            String assetPath = path.isEmpty() || path.endsWith("/") ? path + "index.html" : path;
            try {
                java.io.InputStream stream = context.getAssets().open(ASSET_ROOT + "/" + assetPath);
                return new WebResourceResponse(mimeTypeOf(assetPath), null, stream);
            } catch (java.io.IOException e) {
                // Missing asset: let the loader answer 404 rather than crash.
                return null;
            }
        }

        /**
         * Explicit map rather than URLConnection.guessContentTypeFromName,
         * which does not know .mjs or .wasm and returns null for them. A module
         * script served without a JavaScript MIME type is refused outright by
         * the WebView, which would leave the overlay blank.
         */
        private static String mimeTypeOf(String path) {
            if (path.endsWith(".html")) return "text/html";
            if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript";
            if (path.endsWith(".css")) return "text/css";
            if (path.endsWith(".json")) return "application/json";
            if (path.endsWith(".wasm")) return "application/wasm";
            if (path.endsWith(".svg")) return "image/svg+xml";
            if (path.endsWith(".woff2")) return "font/woff2";
            if (path.endsWith(".woff")) return "font/woff";
            if (path.endsWith(".png")) return "image/png";
            if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
            if (path.endsWith(".webp")) return "image/webp";
            if (path.endsWith(".ico")) return "image/x-icon";
            return "application/octet-stream";
        }
    }
}
