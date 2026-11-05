package com.superbutler.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * 常驻通知前台服务：任务进行中显示进度条；没有任务时显示在线/待命主机数量。
 * 由 APK 设置页的「常驻通知」开关控制，状态保存在 SharedPreferences。
 */
public class ButlerNotificationService extends Service {

    public static final String ACTION_START = "com.superbutler.app.PERSISTENT_NOTIFY";
    private static final String TAG = "SuperButlerNotify";
    private static final String CHANNEL_ID = "butler_persistent";
    private static final int NOTIFICATION_ID = 7400;
    private static final long POLL_MS = 5000L;
    private static final String PREFS_NAME = "butler_config";
    private static final String KEY_HUB = "hub_url";
    private static final String KEY_TOKEN = "admin_token";

    private volatile boolean running = true;
    private Thread worker;
    private SharedPreferences prefs;
    private NotificationManager notificationManager;

    @Override
    public void onCreate() {
        super.onCreate();
        prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        notificationManager = getSystemService(NotificationManager.class);
        createChannel();
        startForegroundCompat(buildNotification("BattleStar", "正在连接管家…", "常驻通知已开启", -1));
        worker = new Thread(new Runnable() {
            @Override
            public void run() {
                pollLoop();
            }
        }, "butler-persistent-notify");
        worker.setDaemon(true);
        worker.start();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (worker != null) worker.interrupt();
        stopForeground(STOP_FOREGROUND_REMOVE);
        if (notificationManager != null) notificationManager.cancel(NOTIFICATION_ID);
        super.onDestroy();
    }

    private void createChannel() {
        if (notificationManager == null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "BattleStar 常驻状态", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("任务进度、在线与待命主机数量");
        channel.setShowBadge(false);
        channel.setSound(null, null);
        notificationManager.createNotificationChannel(channel);
    }

    private void startForegroundCompat(Notification notification) {
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void pollLoop() {
        while (running) {
            try {
                updateFromHub();
            } catch (Exception e) {
                Log.w(TAG, "poll failed", e);
                publish("BattleStar", "无法连接 Hub", "点击打开控制台", -1);
            }
            try {
                Thread.sleep(POLL_MS);
            } catch (InterruptedException e) {
                break;
            }
        }
    }

    private void updateFromHub() {
        String hub = prefs.getString(KEY_HUB, "");
        String token = prefs.getString(KEY_TOKEN, "");
        hub = normalizeHub(hub);
        if (hub == null || token == null || token.trim().isEmpty()) {
            publish("BattleStar", "未配置 Hub，请打开 App 连接", "常驻通知已开启", -1);
            return;
        }

        JSONObject snapshot = fetchSnapshot(hub, token.trim());
        if (snapshot == null) {
            publish("BattleStar", "无法连接 Hub", hub, -1);
            return;
        }

        JSONArray tasks = snapshot.optJSONArray("tasks");
        JSONObject active = findActiveTask(tasks);
        if (active != null) {
            String instruction = active.optString("instruction", "任务执行中");
            String status = active.optString("status", "running");
            String device = active.optString("assignedDeviceName", "");
            int percent = progressOf(active);
            String sub = (percent >= 0 ? percent + "%" : statusLabel(status))
                    + (device.isEmpty() ? "" : " · " + device);
            publish("BattleStar · 任务执行中", instruction, sub, percent);
            return;
        }

        JSONArray devices = snapshot.optJSONArray("devices");
        JSONObject stats = snapshot.optJSONObject("stats");
        int online = stats != null ? stats.optInt("devicesOnline", 0) : 0;
        int total = stats != null ? stats.optInt("devicesTotal", 0) : 0;
        int idle = 0;
        if (devices != null) {
            for (int i = 0; i < devices.length(); i++) {
                JSONObject d = devices.optJSONObject(i);
                if (d == null || !d.optBoolean("online", false)) continue;
                String status = d.optString("status", "");
                JSONObject load = d.optJSONObject("load");
                int running = load == null ? 0 : load.optInt("running", 0);
                if ("idle".equals(status) || (running == 0 && !"busy".equals(status))) idle += 1;
            }
        }
        if (total <= 0) total = online;
        String text = online + " 台在线 · " + idle + " 台待命";
        if (total > online) text += "（共 " + total + " 台）";
        publish("BattleStar · 待命中", text, "无进行中任务", -1);
    }

    private JSONObject fetchSnapshot(String hub, String token) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(hub + "/api/snapshot?limit=10");
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(8000);
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Accept", "application/json");
            conn.setRequestProperty("X-Butler-Token", token);
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) return null;
            return new JSONObject(readStream(conn.getInputStream()));
        } catch (Exception e) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private JSONObject findActiveTask(JSONArray tasks) {
        if (tasks == null) return null;
        for (int i = 0; i < tasks.length(); i++) {
            JSONObject task = tasks.optJSONObject(i);
            if (task == null) continue;
            String status = task.optString("status", "");
            if ("queued".equals(status) || "assigned".equals(status) || "running".equals(status)) {
                return task;
            }
        }
        return null;
    }

    private int progressOf(JSONObject task) {
        Object progress = task.opt("progress");
        if (progress instanceof Number) {
            return clampPercent(((Number) progress).intValue());
        }
        if (progress instanceof JSONObject) {
            JSONObject p = (JSONObject) progress;
            if (p.has("percent")) return clampPercent((int) Math.round(p.optDouble("percent", -1)));
        }
        JSONArray events = task.optJSONArray("events");
        if (events != null) {
            for (int i = events.length() - 1; i >= 0; i--) {
                JSONObject event = events.optJSONObject(i);
                if (event != null && event.has("percent")) {
                    return clampPercent((int) Math.round(event.optDouble("percent", -1)));
                }
            }
        }
        return -1;
    }

    private static int clampPercent(int value) {
        if (value < 0) return -1;
        return Math.min(100, value);
    }

    private String statusLabel(String status) {
        if ("queued".equals(status)) return "排队中";
        if ("assigned".equals(status)) return "已派发";
        return "执行中";
    }

    private static String normalizeHub(String hub) {
        if (hub == null) return null;
        String value = hub.trim();
        if (value.isEmpty()) return null;
        if (!value.startsWith("http://") && !value.startsWith("https://")) value = "http://" + value;
        while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
        return value;
    }

    private void publish(String title, String text, String sub, int percent) {
        Notification notification = buildNotification(title, text, sub, percent);
        if (notificationManager != null) notificationManager.notify(NOTIFICATION_ID, notification);
    }

    private Notification buildNotification(String title, String text, String sub, int percent) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pending = PendingIntent.getActivity(
                this, 7400, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setContentIntent(pending)
                .setCategory(Notification.CATEGORY_SERVICE)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false);
        if (percent >= 0) {
            builder.setProgress(100, percent, false).setSubText(sub == null ? percent + "%" : sub);
        } else if (sub != null && !sub.isEmpty()) {
            builder.setSubText(sub);
        }
        return builder.build();
    }

    private static String readStream(InputStream input) throws Exception {
        if (input == null) return "";
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int read;
        while ((read = input.read(buffer)) >= 0) out.write(buffer, 0, read);
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }
}
