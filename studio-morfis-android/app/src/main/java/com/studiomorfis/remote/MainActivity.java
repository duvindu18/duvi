package com.studiomorfis.remote;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.DhcpInfo;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Map;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;

/**
 * Studio Morfis on Android: the Studio Morfis app of a computer on the same network, on the phone.
 * The computer serves the whole interface (Settings > Desktop app > Phone access); this app finds the computer,
 * shows its pages, and does what only a phone can: choose files to upload, save downloads, and open links.
 *
 * The pages are shown under a fixed address of their own (http://studio.morfis), fetched from the computer when it
 * answers and kept on the phone, so the app opens and works with no connection, and what the page keeps for
 * offline use (its copy of the projects and folder names, and the changes waiting to be sent) survives the
 * computer's network address changing. The page talks to the computer directly, with this phone's key.
 */
public class MainActivity extends Activity {
    private static final String CONNECT = "file:///android_asset/connect.html";
    private static final String ORIGIN = "http://studio.morfis";
    private static final String HOST = "studio.morfis";
    private static final int PICK_FILES = 7;
    private static final int DISCOVERY_PORT = 47821;

    private WebView web;
    private SharedPreferences prefs;
    private ValueCallback<Uri[]> pickCallback;
    private volatile String currentUrl = "";
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Set<Long> ourDownloads = new HashSet<>();

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("morfis", MODE_PRIVATE);
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0A0A10"));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportMultipleWindows(false);
        s.setUserAgentString(s.getUserAgentString() + " StudioMorfisAndroid/" + version());
        CookieManager.getInstance().setAcceptCookie(true);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        web.addJavascriptInterface(new Bridge(), "MorfisAndroid");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.setDownloadListener((url, userAgent, disposition, mime, length) -> download(url, userAgent, disposition, mime));

        IntentFilter f = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(downloaded, f, Context.RECEIVER_EXPORTED);
        else registerReceiver(downloaded, f);

        if (state != null) web.restoreState(state);
        else {
            String server = prefs.getString("server", "");
            if (server.isEmpty()) web.loadUrl(CONNECT);
            else web.loadUrl(ORIGIN + "/app");
        }
    }

    private String version() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return "1"; }
    }

    private String server() { return prefs.getString("server", ""); }
    private String key() { return prefs.getString("key", ""); }

    /** The app's own pages (the connect page, and the computer's pages under the app's address) may use the bridge. */
    private boolean trusted() {
        String u = currentUrl;
        return u.startsWith(CONNECT) || u.equals(ORIGIN) || u.startsWith(ORIGIN + "/");
    }

    /* ----- the computer's pages under the app's own address: fetched when it answers, kept for offline ----- */
    private File cacheFile(String path, String ext) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-1");
            StringBuilder h = new StringBuilder();
            for (byte b : md.digest(path.getBytes(StandardCharsets.UTF_8))) h.append(String.format("%02x", b));
            File dir = new File(getFilesDir(), "pages");
            if (!dir.exists()) dir.mkdirs();
            return new File(dir, h + ext);
        } catch (Exception e) { return null; }
    }
    private static byte[] readAll(InputStream in) throws java.io.IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        in.close();
        return out.toByteArray();
    }
    private WebResourceResponse response(String type, int code, InputStream body) {
        String mime = type == null ? "application/octet-stream" : type.split(";")[0].trim(), charset = null;
        if (type != null && type.toLowerCase().contains("charset=")) charset = type.substring(type.toLowerCase().indexOf("charset=") + 8).trim();
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-store");
        return new WebResourceResponse(mime, charset, code, code == 200 ? "OK" : code == 206 ? "Partial Content" : "Status", h, body);
    }
    private WebResourceResponse fromPhone(String path) {
        File body = cacheFile(path, ".body"), meta = cacheFile(path, ".type");
        if (body == null || !body.exists()) return null;
        try {
            String type = meta != null && meta.exists() ? new String(readAll(new FileInputStream(meta)), StandardCharsets.UTF_8) : "application/octet-stream";
            return response(type, 200, new FileInputStream(body));
        } catch (Exception e) { return null; }
    }
    private WebResourceResponse fromComputer(WebResourceRequest req) {
        Uri u = req.getUrl();
        String path = (u.getEncodedPath() == null ? "/" : u.getEncodedPath()) + (u.getEncodedQuery() == null ? "" : "?" + u.getEncodedQuery());
        boolean stream = path.startsWith("/__file/") || path.startsWith("/dl/");
        String srv = server();
        if (srv.isEmpty()) return null;
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(srv + path).openConnection();
            c.setConnectTimeout(3000);
            c.setReadTimeout(stream ? 60000 : 15000);
            c.setInstanceFollowRedirects(false);
            if (!key().isEmpty()) c.setRequestProperty("x-morfis-key", key());
            String range = req.getRequestHeaders() == null ? null : req.getRequestHeaders().get("Range");
            if (range != null) c.setRequestProperty("Range", range);
            int code = c.getResponseCode();
            if (code == 302 || code == 301) {
                String loc = c.getHeaderField("Location");
                c.disconnect();
                Map<String, String> h = new HashMap<>();
                h.put("Location", loc == null ? "/app" : loc);
                return new WebResourceResponse("text/html", "utf-8", 302, "Found", h, new ByteArrayInputStream(new byte[0]));
            }
            String type = c.getContentType();
            if (stream) {
                WebResourceResponse r = response(type, code, code >= 400 ? c.getErrorStream() : c.getInputStream());
                Map<String, String> h = new HashMap<>(r.getResponseHeaders());
                for (String k : new String[] { "Content-Range", "Accept-Ranges", "Content-Length" }) { String v = c.getHeaderField(k); if (v != null) h.put(k, v); }
                r.setResponseHeaders(h);
                return r;
            }
            byte[] bytes = readAll(code >= 400 ? c.getErrorStream() : c.getInputStream());
            boolean pairPage = "pair".equals(c.getHeaderField("x-morfis-page"));
            if (code == 200 && !pairPage) {
                File body = cacheFile(path, ".body"), meta = cacheFile(path, ".type");
                if (body != null && meta != null) {
                    try (FileOutputStream o = new FileOutputStream(body)) { o.write(bytes); }
                    try (FileOutputStream o = new FileOutputStream(meta)) { o.write((type == null ? "application/octet-stream" : type).getBytes(StandardCharsets.UTF_8)); }
                }
            }
            return response(type, code, new ByteArrayInputStream(bytes));
        } catch (Exception e) {
            /* the computer is away: the copy kept on the phone, if there is one */
            return stream ? null : fromPhone(path);
        }
    }

    private boolean ours(Uri uri) {
        String srv = server();
        if (srv.isEmpty() || uri == null) return false;
        Uri s = Uri.parse(srv);
        return "http".equals(uri.getScheme()) && s.getHost() != null && s.getHost().equals(uri.getHost()) && s.getPort() == uri.getPort();
    }

    private void showConnect(String error) {
        String url = CONNECT + (error == null ? "" : "?error=" + Uri.encode(error));
        web.loadUrl(url);
    }

    private void openOutside(String url) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "No app on this phone opens that link.", Toast.LENGTH_SHORT).show();
        }
    }

    /* ----- pages ----- */
    private class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (!HOST.equals(u.getHost()) || !"GET".equalsIgnoreCase(req.getMethod())) return null;
            return fromComputer(req);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (CONNECT.equals(u.toString().split("\\?")[0]) || HOST.equals(u.getHost()) || ours(u)) return false;
            openOutside(u.toString());
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) { currentUrl = url == null ? "" : url; }

        @Override
        public void onPageFinished(WebView view, String url) {
            currentUrl = url == null ? "" : url;
            CookieManager.getInstance().flush();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
            if (!req.isForMainFrame() || req.getUrl().toString().startsWith("file:")) return;
            showConnect("Could not reach " + server() + ", and the app has not been opened with it yet. Check that the computer is on, Studio Morfis is open with phone access allowed, and both are on the same network.");
        }
    }

    /* ----- choosing files to send to the computer ----- */
    private class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (pickCallback != null) pickCallback.onReceiveValue(null);
            pickCallback = callback;
            Intent i = new Intent(Intent.ACTION_GET_CONTENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("*/*");
            i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
            try {
                startActivityForResult(Intent.createChooser(i, "Choose files"), PICK_FILES);
            } catch (ActivityNotFoundException e) {
                pickCallback = null;
                callback.onReceiveValue(null);
                return false;
            }
            return true;
        }
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != PICK_FILES || pickCallback == null) return;
        Uri[] out = null;
        if (result == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null) {
                out = new Uri[clip.getItemCount()];
                for (int k = 0; k < clip.getItemCount(); k++) out[k] = clip.getItemAt(k).getUri();
            } else if (data.getData() != null) out = new Uri[] { data.getData() };
        }
        pickCallback.onReceiveValue(out);
        pickCallback = null;
    }

    /* ----- downloads: exports, PDFs and files opened from the computer ----- */
    private void download(String url, String userAgent, String disposition, String mime) {
        if (!ours(Uri.parse(url))) { openOutside(url); return; }
        try {
            String name = URLUtil.guessFileName(url, disposition, mime);
            DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
            if (!key().isEmpty()) r.addRequestHeader("x-morfis-key", key());
            r.addRequestHeader("User-Agent", userAgent);
            if (mime != null && !mime.isEmpty()) r.setMimeType(mime);
            r.setTitle(name);
            r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "Studio Morfis/" + name);
            DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            synchronized (ourDownloads) { ourDownloads.add(dm.enqueue(r)); }
            Toast.makeText(this, "Downloading " + name, Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "Could not download: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    /** A finished download opens in the phone's own viewer (PDF, image, drawing...). */
    private final BroadcastReceiver downloaded = new BroadcastReceiver() {
        @Override
        public void onReceive(Context c, Intent intent) {
            long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
            synchronized (ourDownloads) { if (!ourDownloads.remove(id)) return; }
            DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            Uri file = dm.getUriForDownloadedFile(id);
            if (file == null) { Toast.makeText(c, "The download did not finish.", Toast.LENGTH_LONG).show(); return; }
            Intent v = new Intent(Intent.ACTION_VIEW);
            v.setDataAndType(file, dm.getMimeTypeForDownloadedFile(id));
            v.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            try { startActivity(v); } catch (ActivityNotFoundException e) { Toast.makeText(c, "Saved in Downloads/Studio Morfis.", Toast.LENGTH_LONG).show(); }
        }
    };

    /* ----- what the pages can ask the app ----- */
    private class Bridge {
        /** Ask the network for computers running Studio Morfis; answers arrive in window.onMorfisFound(list). */
        @JavascriptInterface
        public void discover() {
            if (!trusted()) return;
            new Thread(() -> {
                JSONArray found = new JSONArray();
                Set<String> seen = new HashSet<>();
                WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                WifiManager.MulticastLock lock = wifi != null ? wifi.createMulticastLock("morfis") : null;
                try (DatagramSocket sock = new DatagramSocket()) {
                    if (lock != null) lock.acquire();
                    sock.setBroadcast(true);
                    sock.setSoTimeout(300);
                    byte[] ask = "MORFIS?".getBytes(StandardCharsets.UTF_8);
                    Set<InetAddress> targets = new HashSet<>();
                    targets.add(InetAddress.getByName("255.255.255.255"));
                    InetAddress subnet = subnetBroadcast(wifi);
                    if (subnet != null) targets.add(subnet);
                    long end = System.currentTimeMillis() + 2500;
                    int round = 0;
                    byte[] buf = new byte[2048];
                    while (System.currentTimeMillis() < end) {
                        if (round++ % 4 == 0) for (InetAddress t : targets) sock.send(new DatagramPacket(ask, ask.length, t, DISCOVERY_PORT));
                        DatagramPacket p = new DatagramPacket(buf, buf.length);
                        try { sock.receive(p); } catch (SocketTimeoutException e) { continue; }
                        try {
                            JSONObject j = new JSONObject(new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8));
                            if (!"studio-morfis".equals(j.optString("app"))) continue;
                            String url = "http://" + p.getAddress().getHostAddress() + ":" + j.optInt("port", 47820);
                            if (!seen.add(url)) continue;
                            JSONObject o = new JSONObject();
                            o.put("url", url);
                            o.put("name", j.optString("name", "Studio Morfis"));
                            o.put("host", j.optString("host", ""));
                            found.put(o);
                        } catch (Exception ignore) { /* not one of ours */ }
                    }
                } catch (Exception e) {
                    /* no network: an empty list */
                } finally {
                    if (lock != null && lock.isHeld()) lock.release();
                }
                final String js = "window.onMorfisFound && window.onMorfisFound(" + found.toString() + ")";
                ui.post(() -> web.evaluateJavascript(js, null));
            }).start();
        }

        /** Connect to a computer: "192.168.1.20", "192.168.1.20:47820" or a full http:// address. */
        @JavascriptInterface
        public void connect(String address) {
            if (!trusted()) return;
            String a = address == null ? "" : address.trim();
            if (a.isEmpty()) return;
            if (!a.startsWith("http://") && !a.startsWith("https://")) a = "http://" + a;
            Uri u = Uri.parse(a);
            if (u.getHost() == null) return;
            final String url = u.getScheme() + "://" + u.getHost() + ":" + (u.getPort() > 0 ? u.getPort() : 47820);
            new Thread(() -> {
                String id = null;
                try {
                    HttpURLConnection c = (HttpURLConnection) new URL(url + "/ping").openConnection();
                    c.setConnectTimeout(4000);
                    c.setReadTimeout(4000);
                    JSONObject j = new JSONObject(new String(readAll(c.getInputStream()), StandardCharsets.UTF_8));
                    if ("studio-morfis".equals(j.optString("app"))) id = j.optString("id", "");
                } catch (Exception ignore) { /* not reachable */ }
                if (id == null) { ui.post(() -> showConnect("No Studio Morfis answered at " + url + ".")); return; }
                SharedPreferences.Editor e = prefs.edit().putString("server", url);
                /* another computer: this phone pairs with it, and keeps nothing of the last one's key */
                if (!id.equals(prefs.getString("serverId", ""))) e.putString("serverId", id).putString("key", "");
                e.apply();
                ui.post(() -> web.loadUrl(ORIGIN + "/app"));
            }).start();
        }

        /** The computer's address, its id, and this phone's key for it. */
        @JavascriptInterface
        public String server() { return trusted() ? MainActivity.this.server() : ""; }

        @JavascriptInterface
        public String key() { return trusted() ? MainActivity.this.key() : ""; }

        @JavascriptInterface
        public String serverId() { return trusted() ? prefs.getString("serverId", "") : ""; }

        /** Given by the computer when the PIN was right. */
        @JavascriptInterface
        public void setKey(String k, String id) {
            if (!trusted() || k == null || !k.matches("[a-f0-9]{64}")) return;
            SharedPreferences.Editor e = prefs.edit().putString("key", k);
            if (id != null && !id.isEmpty()) e.putString("serverId", id);
            e.apply();
        }

        /** The computer no longer knows this phone: pair again. */
        @JavascriptInterface
        public void unpaired() {
            if (!trusted()) return;
            prefs.edit().putString("key", "").apply();
            ui.post(() -> web.loadUrl(ORIGIN + "/app"));
        }

        /** Save a file from the computer to the phone's Downloads. */
        @JavascriptInterface
        public void download(String url) {
            if (!trusted() || url == null) return;
            ui.post(() -> MainActivity.this.download(url, web.getSettings().getUserAgentString(), null, null));
        }

        /** Back to the list of computers (the pairing with this one is kept). */
        @JavascriptInterface
        public void disconnect() {
            if (!trusted()) return;
            ui.post(() -> showConnect(null));
        }

        @JavascriptInterface
        public String lastServer() { return trusted() ? MainActivity.this.server() : ""; }

        @JavascriptInterface
        public void openExternal(String url) {
            if (!trusted() || url == null || !(url.startsWith("https://") || url.startsWith("mailto:"))) return;
            ui.post(() -> openOutside(url));
        }
    }

    @SuppressWarnings("deprecation")
    private InetAddress subnetBroadcast(WifiManager wifi) {
        try {
            if (wifi == null) return null;
            DhcpInfo d = wifi.getDhcpInfo();
            if (d == null || d.ipAddress == 0) return null;
            int b = (d.ipAddress & d.netmask) | ~d.netmask;
            byte[] q = new byte[4];
            for (int k = 0; k < 4; k++) q[k] = (byte) ((b >> (k * 8)) & 0xFF);
            return InetAddress.getByAddress(q);
        } catch (Exception e) { return null; }
    }

    /* ----- the phone's Back button: the page closes what is open first ----- */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (currentUrl.startsWith(CONNECT)) { super.onBackPressed(); return; }
        web.evaluateJavascript("(function(){try{return !!(window.__morfisBack&&window.__morfisBack())}catch(e){return false}})()", (v) -> {
            if ("true".equals(v)) return;
            if (web.canGoBack()) web.goBack(); else moveTaskToBack(true);
        });
    }

    @Override
    protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }

    @Override
    protected void onPause() { super.onPause(); CookieManager.getInstance().flush(); }

    @Override
    protected void onDestroy() {
        try { unregisterReceiver(downloaded); } catch (Exception ignore) { /* not registered */ }
        web.destroy();
        super.onDestroy();
    }
}
