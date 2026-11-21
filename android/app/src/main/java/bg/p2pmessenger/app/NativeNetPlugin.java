package bg.p2pmessenger.app;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.os.ParcelFileDescriptor;
import android.system.Os;
import android.system.OsConstants;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * П4 (experiment): the Android shell's half of the native transport (src/native/bridge.ts).
 * UDP sockets, an SSDP search and HTTP to a router on the LAN; nothing else. STUN, punching and
 * the encryption stay in the web code. Same contract as electron/nativeNet.mjs and
 * src-tauri/src/native_net.rs.
 *
 * Not built or run in CI yet (no Android SDK there): try it on the device farm (docs/DEVICE-FARM.md).
 */
@CapacitorPlugin(name = "NativeNet")
public class NativeNetPlugin extends Plugin {
    private static final int MAX_SOCKETS = 300; // a birthday punch opens 256
    private static final int MAX_DATAGRAM = 2048;
    private static final int MAX_HTTP_ANSWER = 64 * 1024;

    private final Map<Integer, DatagramSocket> sockets = new ConcurrentHashMap<>();
    private final AtomicInteger nextId = new AtomicInteger(1);
    private final ExecutorService io = Executors.newCachedThreadPool();

    @PluginMethod
    public void open(PluginCall call) {
        if (sockets.size() >= MAX_SOCKETS) {
            call.reject("too many sockets");
            return;
        }
        try {
            final DatagramSocket sock = new DatagramSocket(0);
            final int id = nextId.getAndIncrement();
            sockets.put(id, sock);
            io.execute(() -> receive(id, sock));
            JSObject out = new JSObject();
            out.put("id", id);
            out.put("port", sock.getLocalPort());
            String lan = lanAddress();
            if (lan != null) out.put("lanAddress", lan);
            call.resolve(out);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    private void receive(int id, DatagramSocket sock) {
        byte[] buf = new byte[MAX_DATAGRAM];
        while (!sock.isClosed()) {
            try {
                DatagramPacket p = new DatagramPacket(buf, buf.length);
                sock.receive(p);
                JSObject d = new JSObject();
                d.put("id", id);
                d.put("data", Base64.encodeToString(buf, 0, p.getLength(), Base64.NO_WRAP));
                d.put("host", p.getAddress().getHostAddress());
                d.put("port", p.getPort());
                notifyListeners("datagram", d);
            } catch (Exception e) {
                if (sock.isClosed()) return;
            }
        }
    }

    @PluginMethod
    public void send(PluginCall call) {
        final Integer id = call.getInt("id");
        final String host = call.getString("host");
        final Integer port = call.getInt("port");
        final String data = call.getString("data");
        final int ttl = call.getInt("ttl", 0);
        final DatagramSocket sock = id == null ? null : sockets.get(id);
        if (sock == null || host == null || port == null || port < 1 || port > 65535 || data == null) {
            call.reject("bad send");
            return;
        }
        io.execute(() -> {
            try {
                byte[] bytes = Base64.decode(data, Base64.NO_WRAP);
                if (bytes.length > MAX_DATAGRAM) {
                    call.reject("too large");
                    return;
                }
                InetAddress addr = InetAddress.getByName(host);
                if (!(addr instanceof Inet4Address)) {
                    call.reject("IPv4 only");
                    return;
                }
                synchronized (sock) {
                    if (ttl > 0 && ttl < 64) setTtl(sock, ttl);
                    sock.send(new DatagramPacket(bytes, bytes.length, addr, port));
                    if (ttl > 0 && ttl < 64) setTtl(sock, 64);
                }
                call.resolve();
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    /** Java has no unicast TTL setter; the socket option goes straight to the file descriptor. */
    private static void setTtl(DatagramSocket sock, int ttl) {
        try (ParcelFileDescriptor pfd = ParcelFileDescriptor.fromDatagramSocket(sock)) {
            Os.setsockoptInt(pfd.getFileDescriptor(), OsConstants.IPPROTO_IP, OsConstants.IP_TTL, ttl);
        } catch (Exception ignored) {
            // Without a low TTL the punch still works, only less politely.
        }
    }

    @PluginMethod
    public void close(PluginCall call) {
        Integer id = call.getInt("id");
        DatagramSocket sock = id == null ? null : sockets.remove(id);
        if (sock != null) sock.close();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        for (DatagramSocket s : sockets.values()) s.close();
        sockets.clear();
        io.shutdownNow();
    }

    /** M-SEARCH for an Internet Gateway Device; the raw answers (at most 20). */
    @PluginMethod
    public void ssdp(PluginCall call) {
        final int timeoutMs = Math.max(200, Math.min(5000, call.getInt("timeoutMs", 1500)));
        io.execute(() -> {
            JSArray answers = new JSArray();
            WifiManager wifi = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            WifiManager.MulticastLock lock = wifi == null ? null : wifi.createMulticastLock("p2p-ssdp");
            try (DatagramSocket s = new DatagramSocket(0)) {
                if (lock != null) lock.acquire();
                byte[] q = ("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\n"
                        + "ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n").getBytes(StandardCharsets.US_ASCII);
                s.send(new DatagramPacket(q, q.length, InetAddress.getByName("239.255.255.250"), 1900));
                long deadline = System.currentTimeMillis() + timeoutMs;
                byte[] buf = new byte[4096];
                while (answers.length() < 20) {
                    long left = deadline - System.currentTimeMillis();
                    if (left <= 0) break;
                    s.setSoTimeout((int) left);
                    DatagramPacket p = new DatagramPacket(buf, buf.length);
                    try {
                        s.receive(p);
                    } catch (SocketTimeoutException e) {
                        break;
                    }
                    answers.put(new String(buf, 0, p.getLength(), StandardCharsets.UTF_8));
                }
            } catch (Exception ignored) {
                // no multicast on this network: no UPnP
            } finally {
                if (lock != null && lock.isHeld()) lock.release();
            }
            JSObject out = new JSObject();
            out.put("locations", answers);
            call.resolve(out);
        });
    }

    /**
     * GET a description or POST a SOAP call to the router: http, private IPv4 only, 3 s, 64 KB.
     * Plain sockets on purpose: the router speaks cleartext HTTP, which Android's HTTP stack
     * refuses by default, and this must not open cleartext to anything else.
     */
    @PluginMethod
    public void lanHttp(PluginCall call) {
        final String url = call.getString("url", "");
        final String method = "POST".equals(call.getString("method")) ? "POST" : "GET";
        final String soapAction = call.getString("soapAction", "");
        final String body = call.getString("body", "");
        io.execute(() -> {
            try {
                if (!url.startsWith("http://")) throw new Exception("only http to a LAN address");
                String rest = url.substring(7);
                int slash = rest.indexOf('/');
                String hostPort = slash < 0 ? rest : rest.substring(0, slash);
                String path = slash < 0 ? "/" : rest.substring(slash);
                int colon = hostPort.lastIndexOf(':');
                String host = colon < 0 ? hostPort : hostPort.substring(0, colon);
                int port = colon < 0 ? 80 : Integer.parseInt(hostPort.substring(colon + 1));
                if (!isPrivateV4(host) || port < 1 || port > 65535 || path.matches(".*[\\r\\n ].*") || soapAction.matches(".*[\\r\\n].*")) {
                    throw new Exception("only http to a LAN address");
                }
                byte[] bodyBytes = body.getBytes(StandardCharsets.UTF_8);
                String req = "POST".equals(method)
                        ? "POST " + path + " HTTP/1.1\r\nHost: " + host + ":" + port + "\r\nContent-Type: text/xml; charset=\"utf-8\"\r\nSOAPAction: "
                                + soapAction + "\r\nContent-Length: " + bodyBytes.length + "\r\nConnection: close\r\n\r\n"
                        : "GET " + path + " HTTP/1.1\r\nHost: " + host + ":" + port + "\r\nConnection: close\r\n\r\n";
                try (Socket s = new Socket()) {
                    s.connect(new InetSocketAddress(host, port), 3000);
                    s.setSoTimeout(3000);
                    OutputStream out = s.getOutputStream();
                    out.write(req.getBytes(StandardCharsets.UTF_8));
                    if ("POST".equals(method)) out.write(bodyBytes);
                    out.flush();
                    InputStream in = s.getInputStream();
                    ByteArrayOutputStream answer = new ByteArrayOutputStream();
                    byte[] buf = new byte[4096];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        answer.write(buf, 0, n);
                        if (answer.size() > MAX_HTTP_ANSWER) throw new Exception("answer too large");
                    }
                    String text = answer.toString("UTF-8");
                    String[] first = text.split("\r\n", 2)[0].split(" ");
                    int status = first.length > 1 ? Integer.parseInt(first[1]) : 0;
                    int head = text.indexOf("\r\n\r\n");
                    JSObject res = new JSObject();
                    res.put("status", status);
                    res.put("text", head < 0 ? "" : text.substring(head + 4));
                    call.resolve(res);
                }
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    static boolean isPrivateV4(String host) {
        String[] p = host.split("\\.");
        if (p.length != 4) return false;
        int[] o = new int[4];
        try {
            for (int i = 0; i < 4; i++) {
                if (!p[i].matches("\\d{1,3}")) return false;
                o[i] = Integer.parseInt(p[i]);
                if (o[i] > 255) return false;
            }
        } catch (NumberFormatException e) {
            return false;
        }
        return o[0] == 10 || (o[0] == 192 && o[1] == 168) || (o[0] == 172 && o[1] >= 16 && o[1] <= 31);
    }

    private static String lanAddress() {
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a instanceof Inet4Address && isPrivateV4(a.getHostAddress())) return a.getHostAddress();
                }
            }
        } catch (Exception ignored) {
            // no interfaces: no port mapping
        }
        return null;
    }
}
