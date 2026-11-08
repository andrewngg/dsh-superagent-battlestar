package com.superbutler.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/**
 * 提醒闹钟的接收器（exported=false，只由 AlarmManager 的显式 PendingIntent 触发）。
 *
 * <p>收到闹钟后：</p>
 * <ol>
 *   <li>按提醒的 {@code notifyStyle} 发系统通知（gentle → {@code butler_reminders}；alarm → {@code butler_reminders_alarm}，
 *       USAGE_ALARM 提示音 + 长震动 + CATEGORY_ALARM），点击打开 MainActivity 并切到提醒页；</li>
 *   <li>更新本地缓存：重复提醒推进 dueAt 并重排下一次闹钟，one-shot 提醒置 enabled=false；</li>
 *   <li>在后台线程 POST {@code /api/reminders/:id/fire} 回写 Hub（失败静默，
 *       等下一次 snapshot 轮询或页面同步校正；本机闹钟已按推进后的 dueAt 排好，不会丢提醒）。</li>
 * </ol>
 */
public class ReminderReceiver extends BroadcastReceiver {

    private static final String TAG = "SuperButlerReminder";
    private static final String PREFS_NAME = "butler_config";
    private static final String KEY_HUB = "hub_url";
    private static final String KEY_TOKEN = "admin_token";
    private static final String OPEN_TAB = "open_tab";
    private static final String OPEN_TAB_REMINDERS = "reminders";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null) return;
        String action = intent.getAction();
        if (action != null && !ReminderScheduler.ACTION_FIRE.equals(action)) return;

        final String id = intent.getStringExtra(ReminderScheduler.EXTRA_REMINDER_ID);
        if (id == null || id.isEmpty()) return;
        final String fallbackTitle = intent.getStringExtra(ReminderScheduler.EXTRA_TITLE);
        final String fallbackNote = intent.getStringExtra(ReminderScheduler.EXTRA_NOTE);
        final String fallbackStyle = intent.getStringExtra(ReminderScheduler.EXTRA_NOTIFY_STYLE);
        final int extraNotifyId = intent.getIntExtra(ReminderScheduler.EXTRA_NOTIFY_ID, -1);

        final Context app = context.getApplicationContext();
        final PendingResult pendingResult = goAsync();
        Thread worker = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    // 优先使用本地缓存里的最新标题/正文（Hub 可能在排程后更新过）
                    JSONObject cached = ReminderScheduler.findCached(app, id);
                    String title = cached == null ? fallbackTitle : cached.optString("title", fallbackTitle);
                    String note = cached == null ? fallbackNote : cached.optString("note", fallbackNote);
                    // 通知方式以缓存为准（同步后可能已改），缓存缺失时回退到排程时的 extra，缺省 gentle
                    String style = cached == null
                            ? ReminderScheduler.normalizeNotifyStyle(fallbackStyle)
                            : ReminderScheduler.normalizeNotifyStyle(
                                    cached.optString("notifyStyle", fallbackStyle));
                    int notifyId = extraNotifyId > 0 ? extraNotifyId : ReminderScheduler.notificationIdFor(id);

                    postNotification(app, id, title, note, notifyId, style);
                    ReminderScheduler.markFired(app, id);
                    ReminderScheduler.rescheduleAll(app);
                    postFire(app, id);
                } catch (Exception e) {
                    Log.w(TAG, "handle reminder failed", e);
                } finally {
                    try {
                        pendingResult.finish();
                    } catch (Exception ignored) {
                        // ignore
                    }
                }
            }
        }, "butler-reminder-fire");
        try {
            worker.start();
        } catch (Exception e) {
            Log.w(TAG, "start reminder worker failed", e);
            try {
                pendingResult.finish();
            } catch (Exception ignored) {
                // ignore
            }
        }
    }

    // ------------------------------------------------------------------
    // 系统通知
    // ------------------------------------------------------------------

    private static void postNotification(Context context, String id, String title, String note,
                                         int notifyId, String notifyStyle) {
        if (Build.VERSION.SDK_INT >= 33
                && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            Log.w(TAG, "skip reminder notification: POST_NOTIFICATIONS not granted");
            return;
        }
        // Receiver 可能在 App 进程被杀后独立启动，两个渠道都要确保已创建
        ReminderScheduler.ensureChannels(context);
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm == null) return;
        String heading = title == null || title.trim().isEmpty() ? "提醒" : title.trim();
        String text = note == null || note.trim().isEmpty() ? "提醒时间到了" : note.trim();
        if (text.length() > 500) text = text.substring(0, 500) + "…";
        boolean alarm = ReminderScheduler.isAlarmStyle(notifyStyle);
        String channelId = ReminderScheduler.channelFor(notifyStyle);

        Intent open = new Intent(context, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        open.putExtra(OPEN_TAB, OPEN_TAB_REMINDERS);
        PendingIntent contentIntent = PendingIntent.getActivity(context, notifyId, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification notification = new Notification.Builder(context, channelId)
                .setSmallIcon(android.R.drawable.ic_popup_reminder)
                .setContentTitle(heading)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setContentIntent(contentIntent)
                .setAutoCancel(true)
                .setCategory(alarm ? Notification.CATEGORY_ALARM : Notification.CATEGORY_REMINDER)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setShowWhen(true)
                .setWhen(System.currentTimeMillis())
                .build();
        try {
            nm.notify(notifyId, notification);
        } catch (Exception e) {
            Log.w(TAG, "post reminder notification failed (id=" + id + ")", e);
        }
    }

    // ------------------------------------------------------------------
    // 回写 Hub：POST /api/reminders/:id/fire
    // ------------------------------------------------------------------

    private static void postFire(Context context, String id) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String hub = normalizeHub(prefs.getString(KEY_HUB, ""));
        String token = prefs.getString(KEY_TOKEN, "");
        if (hub == null || token == null || token.trim().isEmpty()) {
            Log.w(TAG, "skip fire callback: hub not configured");
            return;
        }
        HttpURLConnection conn = null;
        try {
            URL url = new URL(hub + "/api/reminders/" + URLEncoder.encode(id, "UTF-8") + "/fire");
            conn = (HttpURLConnection) url.openConnection();
            // 控制在 goAsync() 的广播超时内：连接 4s + 读取 4s
            conn.setConnectTimeout(4000);
            conn.setReadTimeout(4000);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Accept", "application/json");
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            conn.setRequestProperty("X-Butler-Token", token.trim());
            JSONObject body = new JSONObject();
            body.put("firedAt", ReminderScheduler.isoUtc(System.currentTimeMillis()));
            byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(payload.length);
            OutputStream os = conn.getOutputStream();
            os.write(payload);
            os.flush();
            os.close();
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) {
                Log.w(TAG, "fire reminder HTTP " + code + " (id=" + id + ")");
                drain(conn.getErrorStream());
            } else {
                drain(conn.getInputStream());
            }
        } catch (Exception e) {
            // 失败静默：下一次 snapshot / 页面同步会带回服务端真实状态并校正
            Log.w(TAG, "fire reminder failed (id=" + id + ")", e);
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static void drain(InputStream input) {
        if (input == null) return;
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[2048];
            int read;
            while ((read = input.read(buffer)) >= 0) out.write(buffer, 0, read);
            input.close();
        } catch (Exception ignored) {
            // ignore
        }
    }

    private static String normalizeHub(String hub) {
        if (hub == null) return null;
        String value = hub.trim();
        if (value.isEmpty()) return null;
        if (!value.startsWith("http://") && !value.startsWith("https://")) value = "http://" + value;
        while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
        return value.isEmpty() ? null : value;
    }
}
