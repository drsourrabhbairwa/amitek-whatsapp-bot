package com.amitek.leads;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Amitek Leads: the phone app UI (assets/www/index.html, same as apps-script/App.html) in a WebView.
 * Calls to the Apps Script web app go through {@link Bridge#post} so Google's redirect is followed natively.
 */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private WebView web;
    private final Handler main = new Handler(Looper.getMainLooper());

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web.setWebViewClient(new WebViewClientCompat() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (HOST.equals(uri.getHost())) return false;
                openExternal(uri);  // tel:, wa.me and other links open in the phone's own apps
                return true;
            }
        });
        web.addJavascriptInterface(new Bridge(), "AmitekNative");
        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl("https://" + HOST + "/assets/www/index.html");
    }

    private void openExternal(Uri uri) {
        try {
            Intent i = new Intent("tel".equals(uri.getScheme()) ? Intent.ACTION_DIAL : Intent.ACTION_VIEW, uri);
            startActivity(i);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "No app found to open this", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // Let the page close a sheet or go back from a lead first.
        web.evaluateJavascript(
                "(function(){var b=document.getElementById('sheetBg');" +
                "if(b&&!b.classList.contains('hidden')){closeSheet();return 1}" +
                "if(window.S&&S.lead){goBack();return 1}return 0})()",
                value -> { if (!"1".equals(value)) MainActivity.super.onBackPressed(); });
    }

    /** JavaScript bridge: AmitekNative.post(id, url, body) -> window.__nativeDone(id, ok, text). */
    private class Bridge {
        @JavascriptInterface
        public void post(final String id, final String url, final String body) {
            new Thread(() -> {
                boolean ok;
                String text;
                try {
                    text = request(url, body);
                    ok = true;
                } catch (Exception e) {
                    ok = false;
                    text = "Cannot reach the script. Check the link and your internet. (" + e.getClass().getSimpleName() + ")";
                }
                final String js = "window.__nativeDone(" + JSONObject.quote(id) + "," + ok + "," + JSONObject.quote(text) + ")";
                main.post(() -> web.evaluateJavascript(js, null));
            }).start();
        }
    }

    /** POST to Apps Script, then follow its redirect (a GET to googleusercontent.com) to read the answer. */
    static String request(String url, String body) throws Exception {
        if (!url.startsWith("https://")) throw new IllegalArgumentException("https only");
        String method = "POST";
        for (int hop = 0; hop < 6; hop++) {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(20000);
            c.setReadTimeout(60000);
            c.setRequestMethod(method);
            if ("POST".equals(method)) {
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "text/plain;charset=utf-8");
                try (OutputStream o = c.getOutputStream()) { o.write(body.getBytes(StandardCharsets.UTF_8)); }
            }
            int code = c.getResponseCode();
            if (code >= 300 && code < 400) {
                String next = c.getHeaderField("Location");
                c.disconnect();
                if (next == null) throw new IllegalStateException("redirect without location");
                url = new URL(new URL(url), next).toString();
                method = "GET";
                continue;
            }
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            if (in != null) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                in.close();
            }
            c.disconnect();
            return out.toString("UTF-8");
        }
        throw new IllegalStateException("too many redirects");
    }
}
