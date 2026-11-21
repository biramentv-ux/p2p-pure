package bg.p2pmessenger.app;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattServer;
import android.bluetooth.BluetoothGattServerCallback;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.pm.PackageManager;
import android.net.wifi.aware.AttachCallback;
import android.net.wifi.aware.DiscoverySessionCallback;
import android.net.wifi.aware.PeerHandle;
import android.net.wifi.aware.PublishConfig;
import android.net.wifi.aware.PublishDiscoverySession;
import android.net.wifi.aware.SubscribeConfig;
import android.net.wifi.aware.SubscribeDiscoverySession;
import android.net.wifi.aware.WifiAwareManager;
import android.net.wifi.aware.WifiAwareSession;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * П5 (experiment): the radio under the mesh (src/mesh). Moves opaque pieces (fragment.ts) to
 * phones nearby and back; routing, TTL, dedupe and everything secret stay in the web code.
 *
 *  - BLE: every phone is both a GATT server (peers write pieces to IN) and a client (it writes
 *    to the peers it finds). It advertises the mesh service UUID with a rotating 6-byte id as
 *    service data, which the web code changes every 15 minutes (setRotatingId). The id is
 *    random, not derived from the identity.
 *  - Wi-Fi Aware (Android 8+, hardware dependent): publish and subscribe "p2pmesh"; pieces go
 *    as discovery messages (255 bytes at most), which reach further than BLE.
 *
 * Events: "peer" {id, via, up}, "piece" {from, data}. Neighbour ids are the radio's own handles
 * (a BLE address, which Android itself randomises, or "aware:<n>"), never shown to anyone.
 *
 * Not built or run in CI (no Android SDK there); the permissions are BlePairingPlugin's plus
 * NEARBY_WIFI_DEVICES for Wi-Fi Aware. Off unless the mesh experiment is turned on.
 */
@SuppressLint("MissingPermission")
@CapacitorPlugin(name = "MeshRadio")
public class MeshRadioPlugin extends Plugin {
    private static final UUID SERVICE = UUID.fromString("5e1f0c2a-0b7d-4f43-9a35-6d6573680001");
    private static final UUID IN = UUID.fromString("5e1f0c2a-0b7d-4f43-9a35-6d6573680002");
    private static final String AWARE_SERVICE = "p2pmesh";
    private static final int MAX_PIECE = 512;

    private final Handler main = new Handler(Looper.getMainLooper());
    private BluetoothAdapter adapter;
    private BluetoothGattServer server;
    private BluetoothLeAdvertiser advertiser;
    private AdvertiseCallback advertising;
    private BluetoothLeScanner scanner;
    private ScanCallback scanning;
    private byte[] rotatingId = new byte[6];
    private final Map<String, BluetoothGatt> clients = Collections.synchronizedMap(new HashMap<>());
    private final Map<String, BluetoothGattCharacteristic> clientIn = Collections.synchronizedMap(new HashMap<>());
    private WifiAwareSession aware;
    private PublishDiscoverySession awarePub;
    private SubscribeDiscoverySession awareSub;
    private final Map<String, PeerHandle> awarePeers = Collections.synchronizedMap(new HashMap<>());
    private int awareMsgId = 1;

    @PluginMethod
    public void start(PluginCall call) {
        BluetoothManager bm = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        adapter = bm == null ? null : bm.getAdapter();
        if (adapter == null || !adapter.isEnabled()) {
            call.reject("Bluetooth is off");
            return;
        }
        String id = call.getString("rotatingId", "");
        if (id != null && !id.isEmpty()) rotatingId = Base64.decode(id, Base64.NO_WRAP);
        startGattServer(bm);
        startAdvertising();
        startScanning();
        startAware();
        JSObject out = new JSObject();
        out.put("aware", aware != null || hasAware());
        call.resolve(out);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopAll();
        call.resolve();
    }

    /** New random id from the web code (every 15 minutes): advertising restarts with it. */
    @PluginMethod
    public void setRotatingId(PluginCall call) {
        String id = call.getString("rotatingId", "");
        if (id == null || id.isEmpty()) {
            call.reject("rotatingId");
            return;
        }
        rotatingId = Base64.decode(id, Base64.NO_WRAP);
        if (advertiser != null && advertising != null) advertiser.stopAdvertising(advertising);
        startAdvertising();
        call.resolve();
    }

    @PluginMethod
    public void send(PluginCall call) {
        String to = call.getString("to");
        byte[] data = Base64.decode(call.getString("data", ""), Base64.NO_WRAP);
        if (to == null || data.length == 0 || data.length > MAX_PIECE) {
            call.reject("bad piece");
            return;
        }
        if (to.startsWith("aware:")) {
            PeerHandle peer = awarePeers.get(to);
            if (peer != null && awarePub != null && data.length <= 255) awarePub.sendMessage(peer, awareMsgId++, data);
            else if (peer != null && awareSub != null && data.length <= 255) awareSub.sendMessage(peer, awareMsgId++, data);
            call.resolve();
            return;
        }
        BluetoothGatt g = clients.get(to);
        BluetoothGattCharacteristic in = clientIn.get(to);
        if (g == null || in == null) {
            call.reject("not connected");
            return;
        }
        if (Build.VERSION.SDK_INT >= 33) g.writeCharacteristic(in, data, BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
        else {
            in.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
            in.setValue(data);
            g.writeCharacteristic(in);
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        stopAll();
    }

    private void emitPiece(String from, byte[] data) {
        if (data == null || data.length == 0 || data.length > MAX_PIECE) return;
        JSObject d = new JSObject();
        d.put("from", from);
        d.put("data", Base64.encodeToString(data, Base64.NO_WRAP));
        notifyListeners("piece", d);
    }

    private void emitPeer(String id, String via, boolean up) {
        JSObject d = new JSObject();
        d.put("id", id);
        d.put("via", via);
        d.put("up", up);
        notifyListeners("peer", d);
    }

    /* ---------- BLE: server side (peers write to us) ---------- */

    private void startGattServer(BluetoothManager bm) {
        server = bm.openGattServer(getContext(), new BluetoothGattServerCallback() {
            @Override
            public void onCharacteristicWriteRequest(BluetoothDevice d, int requestId, BluetoothGattCharacteristic c, boolean prepared, boolean needsResponse, int offset, byte[] value) {
                if (needsResponse) server.sendResponse(d, requestId, BluetoothGatt.GATT_SUCCESS, 0, null);
                if (IN.equals(c.getUuid()) && offset == 0) emitPiece(d.getAddress(), value);
            }
        });
        if (server == null) return;
        BluetoothGattService s = new BluetoothGattService(SERVICE, BluetoothGattService.SERVICE_TYPE_PRIMARY);
        s.addCharacteristic(new BluetoothGattCharacteristic(IN, BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE | BluetoothGattCharacteristic.PROPERTY_WRITE, BluetoothGattCharacteristic.PERMISSION_WRITE));
        server.addService(s);
    }

    private void startAdvertising() {
        advertiser = adapter.getBluetoothLeAdvertiser();
        if (advertiser == null) return;
        AdvertiseSettings settings = new AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
                .setConnectable(true)
                .build();
        AdvertiseData data = new AdvertiseData.Builder()
                .setIncludeDeviceName(false)
                .addServiceUuid(new ParcelUuid(SERVICE))
                .build();
        AdvertiseData scanResponse = new AdvertiseData.Builder()
                .setIncludeDeviceName(false)
                .addServiceData(new ParcelUuid(SERVICE), rotatingId)
                .build();
        advertising = new AdvertiseCallback() {};
        advertiser.startAdvertising(settings, data, scanResponse, advertising);
    }

    /* ---------- BLE: client side (we write to the peers we find) ---------- */

    private void startScanning() {
        scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) return;
        ScanFilter filter = new ScanFilter.Builder().setServiceUuid(new ParcelUuid(SERVICE)).build();
        ScanSettings settings = new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_BALANCED).build();
        scanning = new ScanCallback() {
            @Override
            public void onScanResult(int type, ScanResult r) {
                final BluetoothDevice d = r.getDevice();
                final String addr = d.getAddress();
                if (clients.containsKey(addr) || clients.size() >= 7) return; // Android's practical limit
                clients.put(addr, d.connectGatt(getContext(), false, new BluetoothGattCallback() {
                    @Override
                    public void onConnectionStateChange(BluetoothGatt g, int status, int state) {
                        if (state == BluetoothProfile.STATE_CONNECTED) g.requestMtu(247);
                        else if (state == BluetoothProfile.STATE_DISCONNECTED) {
                            clients.remove(addr);
                            clientIn.remove(addr);
                            g.close();
                            emitPeer(addr, "ble", false);
                        }
                    }

                    @Override
                    public void onMtuChanged(BluetoothGatt g, int mtu, int status) {
                        g.discoverServices();
                    }

                    @Override
                    public void onServicesDiscovered(BluetoothGatt g, int status) {
                        BluetoothGattService s = g.getService(SERVICE);
                        BluetoothGattCharacteristic in = s == null ? null : s.getCharacteristic(IN);
                        if (in == null) {
                            g.disconnect();
                            return;
                        }
                        clientIn.put(addr, in);
                        emitPeer(addr, "ble", true);
                    }
                }, BluetoothDevice.TRANSPORT_LE));
            }
        };
        scanner.startScan(Collections.singletonList(filter), settings, scanning);
    }

    /* ---------- Wi-Fi Aware ---------- */

    private boolean hasAware() {
        return Build.VERSION.SDK_INT >= 26 && getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_WIFI_AWARE);
    }

    private void startAware() {
        if (!hasAware()) return;
        WifiAwareManager m = (WifiAwareManager) getContext().getSystemService(Context.WIFI_AWARE_SERVICE);
        if (m == null || !m.isAvailable()) return;
        m.attach(new AttachCallback() {
            @Override
            public void onAttached(WifiAwareSession session) {
                aware = session;
                DiscoverySessionCallback cb = new DiscoverySessionCallback() {
                    @Override
                    public void onPublishStarted(PublishDiscoverySession s) {
                        awarePub = s;
                    }

                    @Override
                    public void onSubscribeStarted(SubscribeDiscoverySession s) {
                        awareSub = s;
                    }

                    @Override
                    public void onServiceDiscovered(PeerHandle peer, byte[] info, java.util.List<byte[]> filter) {
                        String id = "aware:" + peer.hashCode();
                        if (awarePeers.put(id, peer) == null) emitPeer(id, "aware", true);
                    }

                    @Override
                    public void onMessageReceived(PeerHandle peer, byte[] message) {
                        String id = "aware:" + peer.hashCode();
                        if (awarePeers.put(id, peer) == null) emitPeer(id, "aware", true);
                        emitPiece(id, message);
                    }
                };
                session.publish(new PublishConfig.Builder().setServiceName(AWARE_SERVICE).build(), cb, main);
                session.subscribe(new SubscribeConfig.Builder().setServiceName(AWARE_SERVICE).build(), cb, main);
            }
        }, main);
    }

    private void stopAll() {
        if (scanner != null && scanning != null) scanner.stopScan(scanning);
        if (advertiser != null && advertising != null) advertiser.stopAdvertising(advertising);
        synchronized (clients) {
            for (BluetoothGatt g : clients.values()) if (g != null) g.close();
            clients.clear();
        }
        clientIn.clear();
        if (server != null) server.close();
        server = null;
        if (awarePub != null) awarePub.close();
        if (awareSub != null) awareSub.close();
        if (aware != null) aware.close();
        aware = null;
        awarePeers.clear();
    }
}
