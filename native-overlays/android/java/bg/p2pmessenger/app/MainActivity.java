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
        // П3: notifications and an optional foreground service that keeps links up (no push server).
        registerPlugin(BackgroundLinkPlugin.class);
        // П6 (experiment): Tor through Arti; idle unless the APK carries libp2ptor.so and "Tor only" is on.
        registerPlugin(TorPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
