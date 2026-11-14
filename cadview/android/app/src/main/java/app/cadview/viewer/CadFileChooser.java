package app.cadview.viewer;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.webkit.ValueCallback;
import android.webkit.WebView;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;
import java.util.ArrayList;
import java.util.List;

/**
 * File picker for CAD files.
 *
 * Android's own type table lists .dxf and .dwg as "image/vnd.dxf" / "image/vnd.dwg", so the default
 * WebView handling of accept=".dxf,.dwg" opens the photo picker. Inputs marked with
 * "application/x-cadview" open the document picker instead, limited to the MIME types in the accept list.
 */
public class CadFileChooser extends BridgeWebChromeClient {

    private static final String MARKER = "application/x-cadview";
    private ValueCallback<Uri[]> pending;
    private final ActivityResultLauncher<Intent> launcher;

    public CadFileChooser(Bridge bridge) {
        super(bridge);
        launcher = bridge.registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
            Uri[] uris = null;
            Intent data = result.getData();
            if (result.getResultCode() == Activity.RESULT_OK && data != null && data.getData() != null) {
                uris = new Uri[] { data.getData() };
            }
            if (pending != null) pending.onReceiveValue(uris);
            pending = null;
        });
    }

    @Override
    public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> callback, FileChooserParams params) {
        List<String> types = new ArrayList<>();
        boolean ours = false;
        for (String t : params.getAcceptTypes()) {
            for (String part : t.split(",")) {
                String s = part.trim();
                if (s.equals(MARKER)) ours = true;
                else if (s.contains("/")) types.add(s); // MIME types only; extensions are for iOS and the web
            }
        }
        if (!ours) return super.onShowFileChooser(webView, callback, params);

        if (pending != null) pending.onReceiveValue(null);
        pending = callback;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, types.toArray(new String[0]));
        try {
            launcher.launch(intent);
        } catch (ActivityNotFoundException e) {
            pending = null;
            callback.onReceiveValue(null);
        }
        return true;
    }
}
