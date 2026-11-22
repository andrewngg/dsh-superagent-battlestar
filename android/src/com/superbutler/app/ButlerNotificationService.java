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
    /** 自主大脑需要主人决定时的通知（通道 + 固定 id）。 */
    private static final String DECISION_CHANNEL_ID = "butler_decision";
    private static final int DECISION_NOTIFICATION_ID = 7600;
    private static final long POLL_MS = 5000L;
    private static final String PREFS_NAME = "butler_config";
    private static final String KEY_HUB = "hub_url";
    private static final String KEY_TOKEN = "admin_token";
    /** 上一次观察到的活动任务 id：用于后台播报「开始」与「完成」提示音。 */
    private static final String KEY_LAST_ACTIVE_TASK = "task_sound_last_active";

    private volatile boolean running = true;
    private Thread worker;
    private SharedPreferences prefs;
    private NotificationManager notificationManager;
    /** 上一次已发布的决策问题签名：内容没变就不重复弹通知。 */
    private volatile String lastDecisionSignature = "";

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

    /**
     * Android 15+：前台服务超时回调（例如 dataSync 的 6 小时/24 小时上限）。
     * 主动 stopSelf()，避免系统在宽限期后抛 RemoteServiceException 直接杀进程。
     * 正常路径（Android 14+ 用 specialUse）没有该超时限制，此回调只作兜底。
     */
    @Override
    public void onTimeout(int startId, int fgsType) {
        Log.w(TAG, "foreground service timeout, stopping (fgsType=" + fgsType + ")");
        running = false;
        stopSelf();
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
        // 大脑需要主人决定时：高优先级，允许提示音/横幅（内容由 Hub 的 ownerAsk 驱动）
        NotificationChannel decision = new NotificationChannel(
                DECISION_CHANNEL_ID, "BattleStar 管家决策", NotificationManager.IMPORTANCE_HIGH);
        decision.setDescription("自主大脑需要你决定时提醒，可直接在通知栏点选");
        decision.setShowBadge(true);
        notificationManager.createNotificationChannel(decision);
    }

    private void startForegroundCompat(Notification notification) {
        if (Build.VERSION.SDK_INT >= 34) {
            // Android 14+：常驻状态通知用 specialUse —— dataSync 在 Android 15 有
            // 6 小时/24 小时硬上限，超时未停会被系统抛异常杀死整个 App 进程。
            startForeground(NOTIFICATION_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else if (Build.VERSION.SDK_INT >= 29) {
            // Android 10-13：没有 specialUse 常量，且旧系统没有前台服务超时限制，回退 dataSync。
            startForeground(NOTIFICATION_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
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

        // 后台也遵循 Hub 的「任务提示音」开关：页面没打开时设置依然生效
        syncTaskSoundSetting(snapshot);

        // 每次 snapshot 轮询顺便把提醒同步到原生闹钟（App 停在后台也能排程）
        syncReminders(snapshot);

        // 大脑需要主人决定时，发一条可点选的通知
        syncBrainAsk(snapshot);

        JSONArray tasks = snapshot.optJSONArray("tasks");
        // 任务通知兜底：先清过期/遗留通知，再按 snapshot 修正「任务已结束但通知仍卡在进行中」
        TaskNotificationTracker.sweep(this);
        reconcileTaskNotifications(tasks);
        JSONObject active = findActiveTask(tasks);
        // 后台提示音：页面在后台/被系统回收时，也由这里播报任务开始与结束
        playTaskSounds(active);
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

    /**
     * 后台任务提示音：snapshot 里出现「新的活动任务」时播开始音；上一个活动任务从活动位
     * 消失（完成/失败/超时/取消，或换成了下一个任务）时播完成音并清除记录。
     * 与页面侧的提示音使用同一套去重窗口，避免同时响两次。
     */
    private void playTaskSounds(JSONObject active) {
        try {
            String activeId = active == null ? "" : active.optString("id", "");
            String lastId = prefs.getString(KEY_LAST_ACTIVE_TASK, "");
            if (!activeId.isEmpty()) {
                if (!activeId.equals(lastId)) {
                    if (!lastId.isEmpty()) TaskSound.playFinished(this, lastId);
                    TaskSound.playStart(this, activeId);
                    prefs.edit().putString(KEY_LAST_ACTIVE_TASK, activeId).apply();
                }
            } else if (!lastId.isEmpty()) {
                TaskSound.playFinished(this, lastId);
                prefs.edit().remove(KEY_LAST_ACTIVE_TASK).apply();
            }
        } catch (Exception e) {
            Log.w(TAG, "play task sounds failed", e);
        }
    }

    /** 把 Hub 设置里的 taskSoundEnabled 同步到本地；未下发时保持原设置。 */
    private void syncTaskSoundSetting(JSONObject snapshot) {
        try {
            JSONObject settings = snapshot.optJSONObject("settings");
            if (settings == null || !settings.has("taskSoundEnabled")) return;
            TaskSound.setEnabled(this, settings.optBoolean("taskSoundEnabled", true));
        } catch (Exception e) {
            Log.w(TAG, "sync task sound setting failed", e);
        }
    }

    /**
     * 页面刷新/重启会丢掉「任务已结束」事件，导致进度通知一直卡住；这里用 snapshot 兜底：
     * 已跟踪的「进行中」通知，只要对应任务在 snapshot 中已是终态，就直接取消。
     * 已被完成事件覆盖的通知（finished=true）不动，其余仍由超时机制兜底。
     */
    private void reconcileTaskNotifications(JSONArray tasks) {
        try {
            if (tasks == null) return;
            java.util.Map<String, String> statusById = new java.util.HashMap<>();
            for (int i = 0; i < tasks.length(); i++) {
                JSONObject task = tasks.optJSONObject(i);
                if (task == null) continue;
                String id = task.optString("id", "");
                if (id.isEmpty()) continue;
                statusById.put(id, task.optString("status", ""));
            }
            if (statusById.isEmpty()) return;
            for (TaskNotificationTracker.Entry entry : TaskNotificationTracker.snapshot(this)) {
                if (entry.finished) continue;
                String status = statusById.get(entry.taskId);
                if (status == null || !isTerminalStatus(status)) continue;
                TaskNotificationTracker.cancelTask(this, entry.taskId, true);
            }
        } catch (Exception e) {
            Log.w(TAG, "reconcile task notifications failed", e);
        }
    }

    private static boolean isTerminalStatus(String status) {
        return "completed".equals(status) || "failed".equals(status)
                || "timeout".equals(status) || "cancelled".equals(status);
    }

    /** snapshot 里的 reminders 数组交给 ReminderScheduler 全量同步（失败不影响常驻通知）。 */
    private void syncReminders(JSONObject snapshot) {
        try {
            JSONArray reminders = snapshot == null ? null : snapshot.optJSONArray("reminders");
            if (reminders == null) return;
            ReminderScheduler.sync(this, reminders);
        } catch (Exception e) {
            Log.w(TAG, "sync reminders failed", e);
        }
    }

    /**
     * 自主大脑提出 ownerAsk 时，发一条「管家需要你决定」通知：前 3 个选项做成通知动作按钮，
     * 点击直接回写 Hub；没有选项时提供一个「打开决策」按钮，点进 App 的大脑海报。
     * ownerAsk 被处理（选项被点/「知道了」）后取消通知。
     */
    private void syncBrainAsk(JSONObject snapshot) {
        try {
            JSONObject brain = snapshot == null ? null : snapshot.optJSONObject("brain");
            JSONObject ask = brain == null ? null : brain.optJSONObject("ownerAsk");
            String text = ask == null ? "" : ask.optString("text", "").trim();
            if (text.isEmpty()) {
                lastDecisionSignature = "";
                if (notificationManager != null) {
                    try {
                        notificationManager.cancel(DECISION_NOTIFICATION_ID);
                    } catch (Exception ignored) {
                        // ignore
                    }
                }
                return;
            }
            JSONArray options = ask.optJSONArray("options");
            String signature = text + "|" + (options == null ? "" : options.toString());
            if (signature.equals(lastDecisionSignature)) return;
            lastDecisionSignature = signature;
            publishBrainAsk(text, options);
        } catch (Exception e) {
            Log.w(TAG, "sync brain ask failed", e);
        }
    }

    private void publishBrainAsk(String text, JSONArray options) {
        if (notificationManager == null) return;
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        open.putExtra("open_tab", "brain");
        PendingIntent contentIntent = PendingIntent.getActivity(this, DECISION_NOTIFICATION_ID, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = new Notification.Builder(this, DECISION_CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle("管家需要你决定")
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setContentIntent(contentIntent)
                .setAutoCancel(false)
                .setOnlyAlertOnce(true)
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setShowWhen(true)
                .setWhen(System.currentTimeMillis());
        int actionCount = 0;
        if (options != null) {
            for (int i = 0; i < options.length() && actionCount < 3; i++) {
                JSONObject option = options.optJSONObject(i);
                if (option == null) continue;
                String id = option.optString("id", "").trim();
                String label = option.optString("label", "").trim();
                if (id.isEmpty() || label.isEmpty()) continue;
                Intent choose = new Intent(this, DecisionActionReceiver.class);
                choose.setAction(DecisionActionReceiver.ACTION_CHOOSE);
                choose.putExtra(DecisionActionReceiver.EXTRA_OPTION_ID, id);
                choose.putExtra(DecisionActionReceiver.EXTRA_OPTION_LABEL, label);
                choose.putExtra(DecisionActionReceiver.EXTRA_NOTIFICATION_ID, DECISION_NOTIFICATION_ID);
                PendingIntent pending = PendingIntent.getBroadcast(this, DECISION_NOTIFICATION_ID + 1 + actionCount, choose,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                builder.addAction(android.R.drawable.ic_menu_send, label, pending);
                actionCount += 1;
            }
        }
        if (actionCount == 0) {
            builder.addAction(android.R.drawable.ic_menu_view, "打开决策", contentIntent);
        }
        try {
            notificationManager.notify(DECISION_NOTIFICATION_ID, builder.build());
        } catch (Exception e) {
            Log.w(TAG, "post brain ask notification failed", e);
        }
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
