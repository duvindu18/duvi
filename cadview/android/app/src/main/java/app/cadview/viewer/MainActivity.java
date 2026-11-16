package app.cadview.viewer;

import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.os.Build;
import android.os.Bundle;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebView;
import androidx.core.content.IntentCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Locale;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {

    /** safe-area insets in CSS px (camera cutout), handed to the web UI as --st/--sr/--sb/--sl */
    private float insetTop, insetRight, insetBottom, insetLeft;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // CAD-aware file picker (see CadFileChooser)
        getBridge().getWebView().setWebChromeClient(new CadFileChooser(getBridge()));

        // Full screen: draw behind the system bars and into the camera cutout, then hide the bars.
        Window window = getWindow();
        WindowCompat.setDecorFitsSystemWindows(window, false);
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams lp = window.getAttributes();
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            window.setAttributes(lp);
        }
        hideSystemBars();

        WebView web = getBridge().getWebView();
        ViewCompat.setOnApplyWindowInsetsListener(web, (v, insets) -> {
            float d = getResources().getDisplayMetrics().density;
            Insets cut = insets.getInsets(WindowInsetsCompat.Type.displayCutout());
            insetTop = cut.top / d;
            insetRight = cut.right / d;
            insetBottom = cut.bottom / d;
            insetLeft = cut.left / d;
            // The keyboard no longer resizes the page in full-screen mode, so make room for it here.
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            v.setPadding(0, 0, 0, ime.bottom);
            pushInsets();
            return insets;
        });
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public void onPageLoaded(WebView webView) {
                pageLoaded = true;
                pushInsets();
                deliverIncoming();
            }
        });
        handleIncoming(getIntent());
    }

    // ---------------- files shared to the app ("Share" sheet) or opened with it ("Open with") ----------------

    private boolean pageLoaded = false;
    private String pendingIncoming = null; // JSON {name, path} or {error}

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIncoming(intent);
    }

    /** Copies the shared/opened file into the app cache (streamed, so large files are fine) and hands it to the web UI. */
    private void handleIncoming(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        Uri uri = null;
        if (Intent.ACTION_SEND.equals(action)) {
            uri = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri.class);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> list = IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri.class);
            if (list != null && !list.isEmpty()) uri = list.get(0); // one drawing at a time
        } else if (Intent.ACTION_VIEW.equals(action)) {
            uri = intent.getData();
        }
        if (uri == null) return;
        setIntent(new Intent()); // don't reopen it after a rotation or restart
        final Uri src = uri;
        new Thread(() -> {
            String result;
            try {
                String name = displayName(src);
                File dir = new File(getCacheDir(), "incoming");
                if (dir.exists()) {
                    File[] old = dir.listFiles();
                    if (old != null) for (File f : old) f.delete();
                } else dir.mkdirs();
                File out = new File(dir, name);
                try (InputStream in = getContentResolver().openInputStream(src); OutputStream os = new FileOutputStream(out)) {
                    if (in == null) throw new Exception("The file could not be read");
                    byte[] buf = new byte[1 << 16];
                    int n;
                    while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                }
                result = new JSONObject().put("name", name).put("path", out.getAbsolutePath()).toString();
            } catch (Exception e) {
                try { result = new JSONObject().put("error", String.valueOf(e.getMessage())).toString(); } catch (Exception ignored) { result = "{\"error\":\"unreadable\"}"; }
            }
            final String json = result;
            runOnUiThread(() -> { pendingIncoming = json; deliverIncoming(); });
        }).start();
    }

    private void deliverIncoming() {
        if (pendingIncoming == null || !pageLoaded) return;
        String js = "window.__cadviewIncoming=" + pendingIncoming + ";window.dispatchEvent(new Event('cadview-incoming'));";
        pendingIncoming = null;
        WebView web = getBridge().getWebView();
        web.post(() -> web.evaluateJavascript(js, null));
    }

    private String displayName(Uri uri) {
        String name = null;
        if ("content".equals(uri.getScheme())) {
            try (Cursor c = getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                if (c != null && c.moveToFirst()) name = c.getString(0);
            } catch (Exception ignored) {}
        }
        if (name == null) name = uri.getLastPathSegment();
        if (name == null || name.isEmpty()) name = "shared-file";
        name = name.replaceAll("[\\\\/:*?\"<>|]", "_");
        int slash = name.lastIndexOf('/');
        return slash >= 0 ? name.substring(slash + 1) : name;
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars(); // re-hide after dialogs, the share sheet or the file picker
    }

    private void hideSystemBars() {
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        c.hide(WindowInsetsCompat.Type.systemBars());
    }

    private void pushInsets() {
        String js = String.format(Locale.US,
            "(function(s){s.setProperty('--st','%.1fpx');s.setProperty('--sr','%.1fpx');s.setProperty('--sb','%.1fpx');s.setProperty('--sl','%.1fpx');})(document.documentElement.style)",
            insetTop, insetRight, insetBottom, insetLeft);
        WebView web = getBridge().getWebView();
        web.post(() -> web.evaluateJavascript(js, null));
    }
}
