package bg.p2pmessenger.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register before super.onCreate so the bridge loads the plugin.
        registerPlugin(PasskeyBridgePlugin.class);
        registerPlugin(BlePairingPlugin.class);
        // П4 (experiment): UDP sockets for the native transport; idle unless turned on in Settings.
        registerPlugin(NativeNetPlugin.class);
        // П5 (experiment): BLE / Wi-Fi Aware radio under the mesh; idle unless the mesh is turned on.
        registerPlugin(MeshRadioPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
