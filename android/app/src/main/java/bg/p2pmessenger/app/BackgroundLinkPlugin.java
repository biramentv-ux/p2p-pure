package bg.p2pmessenger.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.provider.Settings;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * П3: notifications without a push server (docs/NOTIFICATIONS.md).
 *
 *  - start/stop: LinkKeeperService, so links stay up with the screen off (costs battery);
 *  - notify: a system notification for a new message (the web code decides when and what);
 *  - permission/askPermission: POST_NOTIFICATIONS on Android 13+;
 *  - batterySettings: opens the system list where the user may exempt the app from battery
 *    optimisation (no special permission: the user decides there).
 */
@CapacitorPlugin(
    name = "BackgroundLink",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class BackgroundLinkPlugin extends Plugin {
    private int nextId = 100;

    @PluginMethod
    public void start(PluginCall call) {
        Intent i = new Intent(getContext(), LinkKeeperService.class);
        i.putExtra(LinkKeeperService.EXTRA_TITLE, call.getString("title", "P2P Messenger"));
        i.putExtra(LinkKeeperService.EXTRA_TEXT, call.getString("text", ""));
        try {
            ContextCompat.startForegroundService(getContext(), i);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), LinkKeeperService.class));
        call.resolve();
    }

    @SuppressLint("MissingPermission") // granted() checks POST_NOTIFICATIONS first
    @PluginMethod
    public void notify(PluginCall call) {
        if (!granted()) {
            call.resolve();
            return;
        }
        LinkKeeperService.ensureChannels(getContext());
        String tag = call.getString("tag", "");
        NotificationCompat.Builder b = new NotificationCompat.Builder(getContext(), LinkKeeperService.CHANNEL_MESSAGES)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(call.getString("title", ""))
                .setContentText(call.getString("body", ""))
                .setAutoCancel(true)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setContentIntent(LinkKeeperService.openApp(getContext()))
                .setPriority(NotificationCompat.PRIORITY_HIGH);
        try {
            // One notification per chat: the same tag replaces the previous one.
            NotificationManagerCompat.from(getContext()).notify(tag, tag.isEmpty() ? nextId++ : 1, b.build());
        } catch (SecurityException e) {
            // permission revoked meanwhile
        }
        call.resolve();
    }

    private boolean granted() {
        if (!NotificationManagerCompat.from(getContext()).areNotificationsEnabled()) return false;
        return Build.VERSION.SDK_INT < 33
                || ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    @PluginMethod
    public void permission(PluginCall call) {
        JSObject out = new JSObject();
        if (granted()) out.put("state", "granted");
        else if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") == PermissionState.PROMPT) out.put("state", "default");
        else out.put("state", "denied");
        call.resolve(out);
    }

    @PluginMethod
    public void askPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "afterAsk");
            return;
        }
        permission(call);
    }

    @PermissionCallback
    private void afterAsk(PluginCall call) {
        permission(call);
    }

    @PluginMethod
    public void batterySettings(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }
}
