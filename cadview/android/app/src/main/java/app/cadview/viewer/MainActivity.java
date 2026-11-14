package app.cadview.viewer;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // CAD-aware file picker (see CadFileChooser)
        getBridge().getWebView().setWebChromeClient(new CadFileChooser(getBridge()));
    }
}
