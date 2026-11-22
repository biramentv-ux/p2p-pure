package bg.p2pmessenger.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

/**
 * П3: keeps the app's process (and so the WebView with its live links) running while the screen
 * is off, without any push server. A foreground service with a quiet, permanent notification,
 * a partial wake lock and a Wi-Fi lock. The price is battery; the setting says so.
 *
 * Nothing runs here but the keep-alive: the links, the encryption and the decision to notify
 * stay in the web code, which calls BackgroundLinkPlugin.notify() for each new message.
 */
public class LinkKeeperService extends Service {
    static final String CHANNEL_LINK = "p2p-link";
    static final String CHANNEL_MESSAGES = "p2p-messages";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_TEXT = "text";
    private static final int ONGOING_ID = 1;

    private PowerManager.WakeLock wake;
    private WifiManager.WifiLock wifi;

    static void ensureChannels(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel link = new NotificationChannel(CHANNEL_LINK, "Връзка във фона", NotificationManager.IMPORTANCE_LOW);
        link.setShowBadge(false);
        nm.createNotificationChannel(link);
        NotificationChannel msgs = new NotificationChannel(CHANNEL_MESSAGES, "Съобщения", NotificationManager.IMPORTANCE_HIGH);
        msgs.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        nm.createNotificationChannel(msgs);
    }

    static PendingIntent openApp(Context ctx) {
        Intent open = new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        ensureChannels(this);
        String title = intent != null && intent.getStringExtra(EXTRA_TITLE) != null ? intent.getStringExtra(EXTRA_TITLE) : "P2P Messenger";
        String text = intent != null && intent.getStringExtra(EXTRA_TEXT) != null ? intent.getStringExtra(EXTRA_TEXT) : "";
        Notification n = new NotificationCompat.Builder(this, CHANNEL_LINK)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(title)
                .setContentText(text)
                .setOngoing(true)
                .setSilent(true)
                .setContentIntent(openApp(this))
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
        int type = Build.VERSION.SDK_INT >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING : 0;
        ServiceCompat.startForeground(this, ONGOING_ID, n, type);
        if (wake == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "p2p:link");
                wake.setReferenceCounted(false);
                wake.acquire();
            }
        }
        if (wifi == null) {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                int mode = Build.VERSION.SDK_INT >= 29 ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                wifi = wm.createWifiLock(mode, "p2p:link");
                wifi.setReferenceCounted(false);
                wifi.acquire();
            }
        }
        // Not sticky: without the WebView a restarted service would hold nothing.
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        if (wake != null && wake.isHeld()) wake.release();
        if (wifi != null && wifi.isHeld()) wifi.release();
        wake = null;
        wifi = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
