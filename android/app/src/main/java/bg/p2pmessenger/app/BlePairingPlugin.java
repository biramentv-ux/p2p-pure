package bg.p2pmessenger.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattServer;
import android.bluetooth.BluetoothGattServerCallback;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.BluetoothStatusCodes;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.util.Base64;
import androidx.core.content.ContextCompat;
import androidx.core.location.LocationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Bluetooth Low Energy first-contact pairing: moves the invitation between two phones
 * that stand next to each other, instead of scanning a QR code.
 *
 * Roles (fixed by the JS side, src/platform/mobile/blePairing*.ts):
 *   - INITIATOR = GATT peripheral: advertises the service UUID, the 4-character tag goes
 *     into the scan response as service data (ASCII bytes). The Bluetooth adapter name is
 *     never changed.
 *   - RESPONDER = GATT central: scans with a service UUID filter, reads the tag from the
 *     service data (fallback: local name "P2P-XXXX"), connects, asks for MTU 517, discovers
 *     the service and enables notifications on TX.
 *
 * GATT layout: service SERVICE; RX (central writes, WRITE with response); TX (peripheral
 * NOTIFY, with a CCCD). The link is NOT encrypted or bonded at the BLE level. Everything
 * sent over it must be protected by the pairing protocol on top.
 *
 * Threading: Capacitor calls the plugin methods on its own thread and Android calls the GATT
 * callbacks on binder threads. Every entry point hops to the main looper, so all state below
 * is only touched from the main thread.
 *
 * Copied into android/ by scripts/mobile/sync-overlays.mjs. Compiling it needs the Android
 * SDK; the repository tests check its contract without compiling it.
 */
@SuppressLint("MissingPermission")
@CapacitorPlugin(
    name = "BlePairing",
    permissions = {
        @Permission(
            alias = "bleModern",
            strings = {
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_ADVERTISE,
                Manifest.permission.BLUETOOTH_CONNECT
            }
        ),
        @Permission(
            alias = "bleLegacy",
            strings = {
                Manifest.permission.BLUETOOTH,
                Manifest.permission.BLUETOOTH_ADMIN,
                Manifest.permission.ACCESS_FINE_LOCATION
            }
        )
    }
)
public class BlePairingPlugin extends Plugin {

    private static final UUID SERVICE_UUID = UUID.fromString("3da7960c-96f3-4d14-a3c8-b842772e603e");
    private static final UUID RX_UUID = UUID.fromString("7b8af345-7943-48e4-9134-e268f787d5cf");
    private static final UUID TX_UUID = UUID.fromString("ae4c0870-c466-48e6-af14-d814739213db");
    private static final UUID CCCD_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    private static final String NAME_PREFIX = "P2P-";
    private static final int TAG_LENGTH = 4;
    private static final int WANTED_MTU = 517;
    private static final int DEFAULT_MTU = 23;
    private static final long CONNECT_TIMEOUT_MS = 20000;
    private static final long SEND_TIMEOUT_MS = 10000;
    private static final long DEVICE_FOUND_REPEAT_MS = 1500;

    private final Handler main = new Handler(Looper.getMainLooper());

    private BluetoothManager manager;
    private BluetoothAdapter adapter;

    // Peripheral (initiator) state
    private BluetoothGattServer server;
    private BluetoothGattCharacteristic serverTx;
    private BluetoothLeAdvertiser advertiser;
    private AdvertiseCallback advertiseCallback;
    private AdvertiseData pendingAdvData;
    private AdvertiseData pendingScanResponse;
    private PluginCall pendingStart;
    private BluetoothDevice central;
    private boolean centralSubscribed = false;
    private final Map<String, Integer> centralMtus = new HashMap<>();

    // Central (responder) state
    private BluetoothLeScanner scanner;
    private ScanCallback scanCallback;
    private final Map<String, Long> lastFound = new HashMap<>();
    private final Map<String, String> lastTag = new HashMap<>();
    private BluetoothGatt client;
    private BluetoothGattCharacteristic clientRx;
    private BluetoothGattCharacteristic clientTx;
    private boolean clientReady = false;
    private int clientMtu = DEFAULT_MTU;
    private PluginCall pendingConnect;
    private final Runnable connectTimeout = new Runnable() {
        @Override
        public void run() {
            failConnect("Bluetooth connection timed out");
        }
    };

    // Shared
    private PluginCall pendingSend;
    private final Runnable sendTimeout = new Runnable() {
        @Override
        public void run() {
            rejectSend("Bluetooth send timed out");
        }
    };

    @Override
    public void load() {
        manager = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        adapter = manager != null ? manager.getAdapter() : null;
    }

    @Override
    protected void handleOnDestroy() {
        resetAll();
    }

    // ---------------------------------------------------------------- permissions

    private boolean hasBlePermissions() {
        Context ctx = getContext();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return (
                granted(ctx, Manifest.permission.BLUETOOTH_SCAN) &&
                granted(ctx, Manifest.permission.BLUETOOTH_ADVERTISE) &&
                granted(ctx, Manifest.permission.BLUETOOTH_CONNECT)
            );
        }
        return (
            granted(ctx, Manifest.permission.BLUETOOTH) &&
            granted(ctx, Manifest.permission.BLUETOOTH_ADMIN) &&
            granted(ctx, Manifest.permission.ACCESS_FINE_LOCATION)
        );
    }

    private static boolean granted(Context ctx, String permission) {
        return ContextCompat.checkSelfPermission(ctx, permission) == PackageManager.PERMISSION_GRANTED;
    }

    /** Overrides the Capacitor default so the JS side gets a plain { granted } answer. */
    @PluginMethod
    @Override
    public void requestPermissions(final PluginCall call) {
        main.post(new Runnable() {
            @Override
            public void run() {
                if (hasBlePermissions()) {
                    resolveGranted(call);
                    return;
                }
                String alias = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? "bleModern" : "bleLegacy";
                requestPermissionForAlias(alias, call, "blePermissionsCallback");
            }
        });
    }

    @PermissionCallback
    private void blePermissionsCallback(PluginCall call) {
        resolveGranted(call);
    }

    private void resolveGranted(PluginCall call) {
        JSObject out = new JSObject();
        out.put("granted", hasBlePermissions());
        call.resolve(out);
    }

    // ---------------------------------------------------------------- availability

    @PluginMethod
    public void checkAvailability(final PluginCall call) {
        final String role = call.getString("role"); // optional: "peripheral" | "central"
        main.post(new Runnable() {
            @Override
            public void run() {
                JSObject out = new JSObject();
                boolean hasLe = getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE);
                if (!hasLe || adapter == null) {
                    out.put("available", false);
                    out.put("reason", "unsupported");
                    call.resolve(out);
                    return;
                }
                if (!hasBlePermissions()) {
                    out.put("available", false);
                    out.put("reason", "unauthorized");
                    call.resolve(out);
                    return;
                }
                if (!adapter.isEnabled()) {
                    out.put("available", false);
                    out.put("reason", "off");
                    call.resolve(out);
                    return;
                }
                if ("peripheral".equals(role) && !adapter.isMultipleAdvertisementSupported()) {
                    out.put("available", false);
                    out.put("reason", "unsupported");
                    call.resolve(out);
                    return;
                }
                out.put("available", true);
                out.put("canAdvertise", adapter.isMultipleAdvertisementSupported());
                call.resolve(out);
            }
        });
    }

    /** Returns null when BLE can be used, otherwise a message for call.reject. */
    private String unavailableMessage(boolean needAdvertising) {
        if (adapter == null || !getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) {
            return "Bluetooth Low Energy is not supported on this device";
        }
        if (!hasBlePermissions()) {
            return "Bluetooth permission was not granted";
        }
        if (!adapter.isEnabled()) {
            return "Bluetooth is off";
        }
        if (needAdvertising && !adapter.isMultipleAdvertisementSupported()) {
            return "This device cannot advertise over Bluetooth Low Energy";
        }
        return null;
    }

    // ---------------------------------------------------------------- peripheral (initiator)

    @PluginMethod
    public void startPeripheral(final PluginCall call) {
        final String tag = call.getString("tag");
        main.post(new Runnable() {
            @Override
            public void run() {
                doStartPeripheral(call, tag);
            }
        });
    }

    private void doStartPeripheral(PluginCall call, String tag) {
        if (tag == null || tag.length() != TAG_LENGTH || !isAscii(tag)) {
            call.reject("tag must be " + TAG_LENGTH + " ASCII characters");
            return;
        }
        String problem = unavailableMessage(true);
        if (problem != null) {
            call.reject(problem);
            return;
        }
        resetAll();
        try {
            advertiser = adapter.getBluetoothLeAdvertiser();
            if (advertiser == null) {
                call.reject("Bluetooth advertiser is not available (is Bluetooth on?)");
                return;
            }
            server = manager.openGattServer(getContext(), serverCallback);
            if (server == null) {
                call.reject("Could not open the Bluetooth GATT server");
                resetAll();
                return;
            }

            BluetoothGattService service = new BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY);
            BluetoothGattCharacteristic rx = new BluetoothGattCharacteristic(
                RX_UUID,
                BluetoothGattCharacteristic.PROPERTY_WRITE,
                BluetoothGattCharacteristic.PERMISSION_WRITE
            );
            serverTx = new BluetoothGattCharacteristic(TX_UUID, BluetoothGattCharacteristic.PROPERTY_NOTIFY, 0);
            serverTx.addDescriptor(
                new BluetoothGattDescriptor(
                    CCCD_UUID,
                    BluetoothGattDescriptor.PERMISSION_READ | BluetoothGattDescriptor.PERMISSION_WRITE
                )
            );
            service.addCharacteristic(rx);
            service.addCharacteristic(serverTx);

            // Advertise data: flags + 128-bit service UUID (21 bytes). The tag goes into the
            // scan response as service data (22 bytes), so neither packet exceeds 31 bytes.
            ParcelUuid serviceParcel = new ParcelUuid(SERVICE_UUID);
            pendingAdvData = new AdvertiseData.Builder()
                .setIncludeDeviceName(false)
                .setIncludeTxPowerLevel(false)
                .addServiceUuid(serviceParcel)
                .build();
            pendingScanResponse = new AdvertiseData.Builder()
                .setIncludeDeviceName(false)
                .setIncludeTxPowerLevel(false)
                .addServiceData(serviceParcel, tag.getBytes(StandardCharsets.US_ASCII))
                .build();
            pendingStart = call;

            // Advertising starts in onServiceAdded.
            if (!server.addService(service)) {
                PluginCall c = pendingStart;
                pendingStart = null;
                resetAll();
                c.reject("Could not add the Bluetooth GATT service");
            }
        } catch (RuntimeException e) {
            pendingStart = null;
            resetAll();
            call.reject(messageOf(e, "Could not start Bluetooth advertising"));
        }
    }

    private void startAdvertising() {
        if (advertiser == null || pendingAdvData == null) return;
        advertiseCallback = new AdvertiseCallback() {
            @Override
            public void onStartSuccess(AdvertiseSettings settingsInEffect) {
                main.post(new Runnable() {
                    @Override
                    public void run() {
                        PluginCall c = pendingStart;
                        pendingStart = null;
                        if (c != null) c.resolve();
                    }
                });
            }

            @Override
            public void onStartFailure(final int errorCode) {
                main.post(new Runnable() {
                    @Override
                    public void run() {
                        PluginCall c = pendingStart;
                        pendingStart = null;
                        String msg = "Bluetooth advertising failed (code " + errorCode + ")";
                        resetAll();
                        if (c != null) c.reject(msg);
                        else emitError(msg);
                    }
                });
            }
        };
        AdvertiseSettings settings = new AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
            .setConnectable(true)
            .setTimeout(0)
            .build();
        try {
            advertiser.startAdvertising(settings, pendingAdvData, pendingScanResponse, advertiseCallback);
        } catch (RuntimeException e) {
            PluginCall c = pendingStart;
            pendingStart = null;
            resetAll();
            if (c != null) c.reject(messageOf(e, "Could not start Bluetooth advertising"));
        }
    }

    private void stopAdvertising() {
        if (advertiser != null && advertiseCallback != null) {
            try {
                advertiser.stopAdvertising(advertiseCallback);
            } catch (RuntimeException ignored) {
                // Bluetooth turned off or permission revoked: nothing left to stop.
            }
        }
        advertiseCallback = null;
    }

    private final BluetoothGattServerCallback serverCallback = new BluetoothGattServerCallback() {
        @Override
        public void onServiceAdded(final int status, final BluetoothGattService service) {
            main.post(new Runnable() {
                @Override
                public void run() {
                    if (server == null || pendingStart == null) return;
                    if (status != BluetoothGatt.GATT_SUCCESS) {
                        PluginCall c = pendingStart;
                        pendingStart = null;
                        resetAll();
                        c.reject("Could not add the Bluetooth GATT service (status " + status + ")");
                        return;
                    }
                    startAdvertising();
                }
            });
        }

        @Override
        public void onConnectionStateChange(final BluetoothDevice device, final int status, final int newState) {
            main.post(new Runnable() {
                @Override
                public void run() {
                    if (server == null) return;
                    if (newState == BluetoothProfile.STATE_CONNECTED) {
                        if (central == null) {
                            central = device;
                        } else if (!central.getAddress().equals(device.getAddress())) {
                            // Pairing is one-to-one: ignore a second phone.
                            try {
                                server.cancelConnection(device);
                            } catch (RuntimeException ignored) {}
                        }
                    } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                        centralMtus.remove(device.getAddress());
                        if (central != null && central.getAddress().equals(device.getAddress())) {
                            boolean wasSubscribed = centralSubscribed;
                            central = null;
                            centralSubscribed = false;
                            rejectSend("disconnected");
                            if (wasSubscribed) {
                                JSObject ev = new JSObject();
                                ev.put("reason", "status " + status);
                                notifyListeners("disconnected", ev);
                            }
                        }
                    }
                }
            });
        }

        @Override
        public void onMtuChanged(final BluetoothDevice device, final int mtu) {
            main.post(new Runnable() {
                @Override
                public void run() {
                    centralMtus.put(device.getAddress(), mtu);
                }
            });
        }

        @Override
        public void onCharacteristicReadRequest(
            final BluetoothDevice device,
            final int requestId,
            final int offset,
            final BluetoothGattCharacteristic characteristic
        ) {
            respond(device, requestId, BluetoothGatt.GATT_READ_NOT_PERMITTED, offset, null);
        }

        @Override
        public void onCharacteristicWriteRequest(
            final BluetoothDevice device,
            final int requestId,
            final BluetoothGattCharacteristic characteristic,
            final boolean preparedWrite,
            final boolean responseNeeded,
            final int offset,
            final byte[] value
        ) {
            main.post(new Runnable() {
                @Override
                public void run() {
                    if (server == null) return;
                    boolean ok =
                        RX_UUID.equals(characteristic.getUuid()) &&
                        !preparedWrite &&
                        offset == 0 &&
                        value != null &&
                        central != null &&
                        central.getAddress().equals(device.getAddress());
                    if (responseNeeded) {
                        respond(
                            device,
                            requestId,
                            ok ? BluetoothGatt.GATT_SUCCESS : BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED,
                            offset,
                            null
                        );
                    }
                    if (ok) emitData(value);
                }
            });
        }

        @Override
        public void onDescriptorReadRequest(
            final BluetoothDevice device,
            final int requestId,
            final int offset,
            final BluetoothGattDescriptor descriptor
        ) {
            main.post(new Runnable() {
                @Override
                public void run() {
                    if (server == null) return;
                    if (!CCCD_UUID.equals(descriptor.getUuid())) {
                        respond(device, requestId, BluetoothGatt.GATT_READ_NOT_PERMITTED, offset, null);
                        return;
                    }
                    boolean on = centralSubscribed && central != null && central.getAddress().equals(device.getAddress());
                    byte[] v = on
                        ? BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                        : BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE;
                    respond(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, v);
                }
            });
        }

        @Override
        public void onDescriptorWriteRequest(
            final BluetoothDevice device,
            final int requestId,
            final BluetoothGattDescriptor descriptor,
            final boolean preparedWrite,
            final boolean responseNeeded,
            final int offset,
            final byte[] value
        ) {
            main.post(new Runnable() {
                @Override
                public void run() {
                    if (server == null) return;
                    boolean isCccd =
                        CCCD_UUID.equals(descriptor.getUuid()) &&
                        TX_UUID.equals(descriptor.getCharacteristic().getUuid()) &&
                        !preparedWrite &&
                        value != null &&
                        value.length == 2;
                    boolean fromCentral = central != null && central.getAddress().equals(device.getAddress());
                    if (!isCccd || !fromCentral) {
                        if (responseNeeded) respond(device, requestId, BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED, offset, null);
                        return;
                    }
                    boolean enable = (value[0] & 0x01) != 0;
                    if (responseNeeded) respond(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value);
                    if (enable && !centralSubscribed) {
                        centralSubscribed = true;
                        // One phone is enough: stop being discoverable.
                        stopAdvertising();
                        Integer mtu = centralMtus.get(device.getAddress());
                        JSObject ev = new JSObject();
                        ev.put("mtu", mtu != null ? mtu : DEFAULT_MTU);
                        notifyListeners("subscribed", ev);
                    } else if (!enable && centralSubscribed) {
                        centralSubscribed = false;
                        rejectSend("unsubscribed");
                        JSObject ev = new JSObject();
                        ev.put("reason", "unsubscribed");
                        notifyListeners("disconnected", ev);
                    }
                }
            });
        }

        @Override
        public void onNotificationSent(final BluetoothDevice device, final int status) {
            main.post(new Runnable() {
                @Override
                public void run() {
                    if (status == BluetoothGatt.GATT_SUCCESS) resolveSend();
                    else rejectSend("Bluetooth notification failed (status " + status + ")");
                }
            });
        }
    };

    private void respond(final BluetoothDevice device, final int requestId, final int status, final int offset, final byte[] value) {
        main.post(new Runnable() {
            @Override
            public void run() {
                if (server == null) return;
                try {
                    server.sendResponse(device, requestId, status, offset, value);
                } catch (RuntimeException ignored) {}
            }
        });
    }

    // ---------------------------------------------------------------- central (responder)

    @PluginMethod
    public void startScan(final PluginCall call) {
        main.post(new Runnable() {
            @Override
            public void run() {
                doStartScan(call);
            }
        });
    }

    private void doStartScan(PluginCall call) {
        String problem = unavailableMessage(false);
        if (problem != null) {
            call.reject(problem);
            return;
        }
        // Up to Android 11 a scan returns nothing while the location switch is off.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            LocationManager lm = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
            if (lm != null && !LocationManagerCompat.isLocationEnabled(lm)) {
                call.reject("Location services must be on to scan for Bluetooth devices on this Android version");
                return;
            }
        }
        if (server != null || client != null) {
            call.reject("Bluetooth pairing is already running; call stop() first");
            return;
        }
        stopScan();
        try {
            scanner = adapter.getBluetoothLeScanner();
            if (scanner == null) {
                call.reject("Bluetooth scanner is not available (is Bluetooth on?)");
                return;
            }
            lastFound.clear();
            lastTag.clear();
            scanCallback = new ScanCallback() {
                @Override
                public void onScanResult(int callbackType, final ScanResult result) {
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            handleScanResult(result);
                        }
                    });
                }

                @Override
                public void onScanFailed(final int errorCode) {
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            emitError("Bluetooth scan failed (code " + errorCode + ")");
                        }
                    });
                }
            };
            ScanFilter filter = new ScanFilter.Builder().setServiceUuid(new ParcelUuid(SERVICE_UUID)).build();
            ScanSettings settings = new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build();
            scanner.startScan(java.util.Collections.singletonList(filter), settings, scanCallback);
            call.resolve();
        } catch (RuntimeException e) {
            stopScan();
            call.reject(messageOf(e, "Could not start the Bluetooth scan"));
        }
    }

    private void stopScan() {
        if (scanner != null && scanCallback != null) {
            try {
                scanner.stopScan(scanCallback);
            } catch (RuntimeException ignored) {}
        }
        scanner = null;
        scanCallback = null;
    }

    private void handleScanResult(ScanResult result) {
        if (scanCallback == null) return; // scan was stopped meanwhile
        ScanRecord record = result.getScanRecord();
        String tag = null;
        if (record != null) {
            byte[] data = record.getServiceData(new ParcelUuid(SERVICE_UUID));
            if (data != null && data.length == TAG_LENGTH) {
                String t = new String(data, StandardCharsets.US_ASCII);
                if (isAscii(t)) tag = t;
            }
            if (tag == null) {
                // Fallback: local name from the advertisement, not the cached adapter name.
                String name = record.getDeviceName();
                if (name != null && name.startsWith(NAME_PREFIX) && name.length() == NAME_PREFIX.length() + TAG_LENGTH) {
                    tag = name.substring(NAME_PREFIX.length());
                }
            }
        }
        if (tag == null) return;
        String id = result.getDevice().getAddress();
        long now = System.currentTimeMillis();
        Long last = lastFound.get(id);
        if (last != null && now - last < DEVICE_FOUND_REPEAT_MS && tag.equals(lastTag.get(id))) return;
        lastFound.put(id, now);
        lastTag.put(id, tag);
        JSObject ev = new JSObject();
        ev.put("deviceId", id);
        ev.put("tag", tag);
        ev.put("rssi", result.getRssi());
        notifyListeners("deviceFound", ev);
    }

    @PluginMethod
    public void connect(final PluginCall call) {
        final String deviceId = call.getString("deviceId");
        main.post(new Runnable() {
            @Override
            public void run() {
                doConnect(call, deviceId);
            }
        });
    }

    private void doConnect(PluginCall call, String deviceId) {
        if (deviceId == null || !BluetoothAdapter.checkBluetoothAddress(deviceId)) {
            call.reject("deviceId is required");
            return;
        }
        String problem = unavailableMessage(false);
        if (problem != null) {
            call.reject(problem);
            return;
        }
        if (client != null || pendingConnect != null || server != null) {
            call.reject("Bluetooth pairing is already connected or connecting");
            return;
        }
        stopScan();
        try {
            BluetoothDevice device = adapter.getRemoteDevice(deviceId);
            clientReady = false;
            clientMtu = DEFAULT_MTU;
            pendingConnect = call;
            main.postDelayed(connectTimeout, CONNECT_TIMEOUT_MS);
            client = device.connectGatt(getContext(), false, clientCallback, BluetoothDevice.TRANSPORT_LE);
            if (client == null) failConnect("Could not start the Bluetooth connection");
        } catch (RuntimeException e) {
            failConnect(messageOf(e, "Could not start the Bluetooth connection"));
        }
    }

    private void failConnect(String message) {
        main.removeCallbacks(connectTimeout);
        PluginCall c = pendingConnect;
        pendingConnect = null;
        closeClient();
        rejectSend("disconnected");
        if (c != null) c.reject(message);
    }

    private void closeClient() {
        BluetoothGatt g = client;
        client = null;
        clientRx = null;
        clientTx = null;
        clientReady = false;
        if (g != null) {
            try {
                g.disconnect();
            } catch (RuntimeException ignored) {}
            try {
                g.close();
            } catch (RuntimeException ignored) {}
        }
    }

    /** The link dropped (or setup failed) on the central side. */
    private void clientDown(String reason) {
        boolean wasReady = clientReady;
        if (pendingConnect != null) {
            failConnect("Bluetooth connection failed (" + reason + ")");
            return;
        }
        closeClient();
        rejectSend("disconnected");
        if (wasReady) {
            JSObject ev = new JSObject();
            ev.put("reason", reason);
            notifyListeners("disconnected", ev);
        }
    }

    private final BluetoothGattCallback clientCallback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(final BluetoothGatt gatt, final int status, final int newState) {
            main.post(new Runnable() {
                @Override
                public void run() {
                    if (gatt != client) {
                        try {
                            gatt.close();
                        } catch (RuntimeException ignored) {}
                        return;
                    }
                    if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                        try {
                            if (!gatt.requestMtu(WANTED_MTU) && !gatt.discoverServices()) {
                                clientDown("service discovery could not start");
                            }
                        } catch (RuntimeException e) {
                            clientDown(messageOf(e, "mtu request failed"));
                        }
                    } else {
                        clientDown("status " + status);
                    }
                }
            });
        }

        @Override
        public void onMtuChanged(final BluetoothGatt gatt, final int mtu, final int status) {
            main.post(new Runnable() {
                @Override
                public void run() {
                    if (gatt != client || clientReady || pendingConnect == null) return;
                    if (status == BluetoothGatt.GATT_SUCCESS) clientMtu = mtu;
                    try {
                        if (!gatt.discoverServices()) clientDown("service discovery could not start");
                    } catch (RuntimeException e) {
                        clientDown(messageOf(e, "service discovery failed"));
                    }
                }
            });
        }

        @Override
        public void onServicesDiscovered(final BluetoothGatt gatt, final int status) {
            main.post(new Runnable() {
                @Override
                public void run() {
                    if (gatt != client || pendingConnect == null) return;
                    if (status != BluetoothGatt.GATT_SUCCESS) {
                        failConnect("Bluetooth service discovery failed (status " + status + ")");
                        return;
                    }
                    BluetoothGattService service = gatt.getService(SERVICE_UUID);
                    BluetoothGattCharacteristic rx = service != null ? service.getCharacteristic(RX_UUID) : null;
                    BluetoothGattCharacteristic tx = service != null ? service.getCharacteristic(TX_UUID) : null;
                    BluetoothGattDescriptor cccd = tx != null ? tx.getDescriptor(CCCD_UUID) : null;
                    if (rx == null || tx == null || cccd == null) {
                        failConnect("The other phone does not offer the pairing service");
                        return;
                    }
                    clientRx = rx;
                    clientTx = tx;
                    try {
                        if (!gatt.setCharacteristicNotification(tx, true) || !writeCccd(gatt, cccd)) {
                            failConnect("Could not enable Bluetooth notifications");
                        }
                    } catch (RuntimeException e) {
                        failConnect(messageOf(e, "Could not enable Bluetooth notifications"));
                    }
                }
            });
        }

        @Override
        public void onDescriptorWrite(final BluetoothGatt gatt, final BluetoothGattDescriptor descriptor, final int status) {
            main.post(new Runnable() {
                @Override
                public void run() {
                    if (gatt != client || pendingConnect == null) return;
                    if (!CCCD_UUID.equals(descriptor.getUuid())) return;
                    if (status != BluetoothGatt.GATT_SUCCESS) {
                        failConnect("Could not enable Bluetooth notifications (status " + status + ")");
                        return;
                    }
                    main.removeCallbacks(connectTimeout);
                    clientReady = true;
                    PluginCall c = pendingConnect;
                    pendingConnect = null;
                    JSObject out = new JSObject();
                    out.put("mtu", clientMtu);
                    notifyListeners("connected", out);
                    c.resolve(out);
                }
            });
        }

        @Override
        public void onCharacteristicWrite(final BluetoothGatt gatt, final BluetoothGattCharacteristic characteristic, final int status) {
            main.post(new Runnable() {
                @Override
                public void run() {
                    if (gatt != client) return;
                    if (status == BluetoothGatt.GATT_SUCCESS) resolveSend();
                    else rejectSend("Bluetooth write failed (status " + status + ")");
                }
            });
        }

        // API 33+ delivers the value here. Older versions call the deprecated overload below.
        @Override
        public void onCharacteristicChanged(final BluetoothGatt gatt, final BluetoothGattCharacteristic characteristic, final byte[] value) {
            final byte[] copy = value != null ? value.clone() : null;
            main.post(new Runnable() {
                @Override
                public void run() {
                    if (gatt != client || !clientReady || copy == null) return;
                    if (TX_UUID.equals(characteristic.getUuid())) emitData(copy);
                }
            });
        }

        @Override
        @SuppressWarnings("deprecation")
        public void onCharacteristicChanged(final BluetoothGatt gatt, final BluetoothGattCharacteristic characteristic) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return; // handled by the overload above
            final byte[] copy = characteristic.getValue() != null ? characteristic.getValue().clone() : null;
            main.post(new Runnable() {
                @Override
                public void run() {
                    if (gatt != client || !clientReady || copy == null) return;
                    if (TX_UUID.equals(characteristic.getUuid())) emitData(copy);
                }
            });
        }
    };

    @SuppressWarnings("deprecation")
    private boolean writeCccd(BluetoothGatt gatt, BluetoothGattDescriptor cccd) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return gatt.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) == BluetoothStatusCodes.SUCCESS;
        }
        cccd.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
        return gatt.writeDescriptor(cccd);
    }

    // ---------------------------------------------------------------- send / data

    @PluginMethod
    public void send(final PluginCall call) {
        final String b64 = call.getString("data");
        main.post(new Runnable() {
            @Override
            public void run() {
                doSend(call, b64);
            }
        });
    }

    @SuppressWarnings("deprecation")
    private void doSend(PluginCall call, String b64) {
        if (b64 == null) {
            call.reject("data is required");
            return;
        }
        byte[] payload;
        try {
            payload = Base64.decode(b64, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            call.reject("data is not valid base64");
            return;
        }
        if (payload.length == 0) {
            call.reject("data is empty");
            return;
        }
        if (pendingSend != null) {
            call.reject("Another Bluetooth send is still in flight");
            return;
        }
        try {
            if (server != null) {
                // Peripheral: notify the subscribed central.
                if (central == null || !centralSubscribed || serverTx == null) {
                    call.reject("No phone is subscribed over Bluetooth");
                    return;
                }
                Integer mtu = centralMtus.get(central.getAddress());
                if (payload.length > (mtu != null ? mtu : DEFAULT_MTU) - 3) {
                    call.reject("Payload is larger than MTU - 3");
                    return;
                }
                pendingSend = call;
                boolean started;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    started = server.notifyCharacteristicChanged(central, serverTx, false, payload) == BluetoothStatusCodes.SUCCESS;
                } else {
                    serverTx.setValue(payload);
                    started = server.notifyCharacteristicChanged(central, serverTx, false);
                }
                if (!started) {
                    rejectSend("Bluetooth notification could not be queued");
                    return;
                }
            } else if (client != null && clientReady && clientRx != null) {
                // Central: write with response to RX.
                if (payload.length > clientMtu - 3) {
                    call.reject("Payload is larger than MTU - 3");
                    return;
                }
                pendingSend = call;
                boolean started;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    started =
                        client.writeCharacteristic(clientRx, payload, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothStatusCodes.SUCCESS;
                } else {
                    clientRx.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
                    clientRx.setValue(payload);
                    started = client.writeCharacteristic(clientRx);
                }
                if (!started) {
                    rejectSend("Bluetooth write could not be queued");
                    return;
                }
            } else {
                call.reject("Bluetooth link is not connected");
                return;
            }
            main.postDelayed(sendTimeout, SEND_TIMEOUT_MS);
        } catch (RuntimeException e) {
            if (pendingSend == call) rejectSend(messageOf(e, "Bluetooth send failed"));
            else call.reject(messageOf(e, "Bluetooth send failed"));
        }
    }

    private void resolveSend() {
        main.removeCallbacks(sendTimeout);
        PluginCall c = pendingSend;
        pendingSend = null;
        if (c != null) c.resolve();
    }

    private void rejectSend(String message) {
        main.removeCallbacks(sendTimeout);
        PluginCall c = pendingSend;
        pendingSend = null;
        if (c != null) c.reject(message);
    }

    private void emitData(byte[] value) {
        JSObject ev = new JSObject();
        ev.put("data", Base64.encodeToString(value, Base64.NO_WRAP));
        notifyListeners("data", ev);
    }

    private void emitError(String message) {
        JSObject ev = new JSObject();
        ev.put("message", message);
        notifyListeners("error", ev);
    }

    // ---------------------------------------------------------------- stop

    @PluginMethod
    public void stop(final PluginCall call) {
        main.post(new Runnable() {
            @Override
            public void run() {
                resetAll();
                call.resolve();
            }
        });
    }

    /** Stops advertising and scanning, closes both GATT roles, rejects pending calls. */
    private void resetAll() {
        main.removeCallbacks(connectTimeout);
        main.removeCallbacks(sendTimeout);
        stopAdvertising();
        stopScan();

        PluginCall start = pendingStart;
        PluginCall connect = pendingConnect;
        pendingStart = null;
        pendingConnect = null;
        pendingAdvData = null;
        pendingScanResponse = null;

        // Clear the references first so late callbacks from the closing objects are ignored.
        closeClient();
        BluetoothGattServer s = server;
        server = null;
        serverTx = null;
        advertiser = null;
        central = null;
        centralSubscribed = false;
        centralMtus.clear();
        lastFound.clear();
        lastTag.clear();
        if (s != null) {
            try {
                s.clearServices();
            } catch (RuntimeException ignored) {}
            try {
                s.close();
            } catch (RuntimeException ignored) {}
        }

        rejectSend("Bluetooth pairing stopped");
        if (start != null) start.reject("Bluetooth pairing stopped");
        if (connect != null) connect.reject("Bluetooth pairing stopped");
    }

    // ---------------------------------------------------------------- helpers

    private static boolean isAscii(String s) {
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c < 0x20 || c > 0x7e) return false;
        }
        return true;
    }

    private static String messageOf(Exception e, String fallback) {
        String m = e.getMessage();
        return m != null ? m : fallback;
    }
}
