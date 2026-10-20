package bg.p2pmessenger.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register before super.onCreate so the bridge loads the plugin.
        registerPlugin(PasskeyBridgePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
