package bg.p2pmessenger.app;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;

/**
 * П6 (experiment): Tor onion services on Android through Arti (libp2ptor.so, android-tor/).
 * The library is in the APK only when built by .github/workflows/android-tor.yml; otherwise
 * status() says "unavailable" and the app never shows the "Tor only" setting.
 * Same contract as the desktop commands (src-tauri/src/tor_net_cmd.rs, src/tor/torBridge.ts).
 */
@CapacitorPlugin(name = "Tor")
public class TorPlugin extends Plugin {
    private static final boolean LOADED = load();
    private final ExecutorService io = Executors.newCachedThreadPool();
    private volatile String onion;

    private static boolean load() {
        try {
            System.loadLibrary("p2ptor");
            return true;
        } catch (UnsatisfiedLinkError e) {
            return false;
        }
    }

    static native String nativeStart(String stateDir, String cacheDir);
    static native long nativeConnect(String onion);
    static native void nativeSend(long id, byte[] data);
    static native void nativeClose(long id);
    static native String nativeRecv(int waitMs);

    @PluginMethod
    public void status(PluginCall call) {
        if (!LOADED) {
            call.reject("unavailable");
            return;
        }
        JSObject out = new JSObject();
        out.put("started", onion != null);
        if (onion != null) out.put("onion", onion);
        call.resolve(out);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (!LOADED) {
            call.reject("unavailable");
            return;
        }
        io.execute(() -> {
            try {
                File base = new File(getContext().getNoBackupFilesDir(), "tor");
                onion = nativeStart(new File(base, "state").getAbsolutePath(), new File(base, "cache").getAbsolutePath());
                JSObject out = new JSObject();
                out.put("onion", onion);
                call.resolve(out);
            } catch (Throwable e) {
                call.reject(e.getMessage());
            }
        });
    }

    @PluginMethod
    public void connect(PluginCall call) {
        String to = call.getString("onion");
        if (!LOADED || to == null) {
            call.reject("unavailable");
            return;
        }
        io.execute(() -> {
            try {
                JSObject out = new JSObject();
                out.put("id", nativeConnect(to));
                call.resolve(out);
            } catch (Throwable e) {
                call.reject(e.getMessage());
            }
        });
    }

    @PluginMethod
    public void send(PluginCall call) {
        Long id = call.getLong("id");
        String data = call.getString("data");
        if (!LOADED || id == null || data == null) {
            call.reject("bad send");
            return;
        }
        io.execute(() -> {
            try {
                nativeSend(id, Base64.decode(data, Base64.NO_WRAP));
                call.resolve();
            } catch (Throwable e) {
                call.reject(e.getMessage());
            }
        });
    }

    @PluginMethod
    public void close(PluginCall call) {
        Long id = call.getLong("id");
        if (LOADED && id != null) io.execute(() -> nativeClose(id));
        call.resolve();
    }

    @PluginMethod
    public void recv(PluginCall call) {
        if (!LOADED) {
            call.reject("unavailable");
            return;
        }
        int waitMs = Math.max(0, Math.min(1000, call.getInt("waitMs", 500)));
        io.execute(() -> {
            try {
                JSObject out = new JSObject();
                out.put("events", new JSONArray(nativeRecv(waitMs)));
                call.resolve(out);
            } catch (Throwable e) {
                call.reject(e.getMessage());
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        io.shutdownNow();
    }
}
