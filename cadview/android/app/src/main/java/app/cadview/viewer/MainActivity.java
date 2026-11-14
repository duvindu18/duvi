package app.cadview.viewer;

import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import java.util.Locale;

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
                pushInsets();
            }
        });
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
