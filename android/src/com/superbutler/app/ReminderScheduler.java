package com.superbutler.app;

import android.Manifest;
import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;

/**
 * 提醒排程器：把 Hub 下发（WebView Bridge / 常驻服务 snapshot 轮询）的提醒全量写入本地缓存，
 * 并用 {@link AlarmManager} 为每条启用的提醒安排系统闹钟；闹钟由 {@link ReminderReceiver} 接收并发通知。
 *
 * <p>设计要点：</p>
 * <ul>
 *   <li>缓存放在 SharedPreferences {@code butler_reminders} 的 {@code items}（JSON 数组字符串），
 *       即使 App 进程被杀，提醒数据仍在；开机后由 {@link BootReceiver} 重排。</li>
 *   <li>两个通知渠道：{@link #CHANNEL_ID}（gentle，普通系统通知）与 {@link #CHANNEL_ID_ALARM}
 *       （alarm，USAGE_ALARM 提示音 + 长震动 + CATEGORY_ALARM）；渠道创建后属性不可变，故按 notifyStyle 分渠道。</li>
 *   <li>每次 {@link #sync} 先按旧缓存取消全部已排闹钟，再按新缓存重排，从而自然清理已删除/停用的提醒。</li>
 *   <li>精确闹钟：Android 12+ 权限 {@code SCHEDULE_EXACT_ALARM} 可能被用户撤销，
 *       用 {@link AlarmManager#canScheduleExactAlarms()} 判断，不可用时回退
 *       {@link AlarmManager#setAndAllowWhileIdle}（可能延迟数分钟，但不会崩）。</li>
 *   <li>requestCode / 通知 id 使用稳定 hash 落在 {@code [7500, 7900)}，避开任务通知 7300 与常驻通知 7400；
 *       同一时刻若 hash 冲突则按 id 排序后线性探测下一个空位，映射只由当前缓存决定，可重复计算。</li>
 * </ul>
 */
public final class ReminderScheduler {

    private static final String TAG = "SuperButlerReminder";

    /** 提醒缓存（独立于 butler_config，避免被「清除配置」误删）。 */
    public static final String PREFS_NAME = "butler_reminders";
    public static final String KEY_ITEMS = "items";

    /** 高重要性提醒通知渠道（gentle：温和普通通知，系统默认提示音）。 */
    public static final String CHANNEL_ID = "butler_reminders";
    /** 闹钟式提醒渠道（alarm：USAGE_ALARM 提示音、长震动、CATEGORY_ALARM）。渠道创建后属性不可变，故与 gentle 分开。 */
    public static final String CHANNEL_ID_ALARM = "butler_reminders_alarm";

    /** 每条提醒的通知方式：{@link #STYLE_GENTLE}（默认）或 {@link #STYLE_ALARM}。 */
    public static final String STYLE_GENTLE = "gentle";
    public static final String STYLE_ALARM = "alarm";

    /** 闹钟式渠道的震动模式：震 800ms、停 400ms、重复。 */
    private static final long[] ALARM_VIBRATION = new long[]{0L, 800L, 400L, 800L, 400L, 800L, 400L, 1200L};

    /** 闹钟 Intent 额外数据（Receiver 从 extras 取 id/标题/正文/通知 id/通知方式）。 */
    public static final String ACTION_FIRE = "com.superbutler.app.REMINDER_FIRE";
    public static final String EXTRA_REMINDER_ID = "reminder_id";
    public static final String EXTRA_TITLE = "reminder_title";
    public static final String EXTRA_NOTE = "reminder_note";
    public static final String EXTRA_NOTIFY_ID = "reminder_notify_id";
    public static final String EXTRA_NOTIFY_STYLE = "reminder_notify_style";

    /** 通知 id / PendingIntent requestCode 基数与范围：7500..7899（避开 7300 任务通知与 7400 常驻通知）。 */
    public static final int NOTIFY_BASE = 7500;
    public static final int NOTIFY_SPAN = 400;

    private static final long DAY_MS = 24L * 60L * 60L * 1000L;
    private static final long WEEK_MS = 7L * DAY_MS;
    /** dueAt 已过（例如开机后补发 / 离线期间错过的提醒）时延迟 2 秒立即触发一次。 */
    private static final long IMMEDIATE_DELAY_MS = 2000L;
    private static final int MAX_ITEMS = 500;

    private static final Object LOCK = new Object();

    private ReminderScheduler() {
    }

    // ------------------------------------------------------------------
    // 渠道 / 权限
    // ------------------------------------------------------------------

    /** Receiver、开机重排等没有 Activity 的场景也要确保两个渠道都存在（重复调用无副作用）。 */
    public static void ensureChannels(Context context) {
        if (context == null || Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm == null) return;
        createGentleChannel(nm);
        createAlarmChannel(nm);
    }

    private static void createGentleChannel(NotificationManager nm) {
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "BattleStar 提醒（温和）", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("到点的提醒事项：普通系统通知，默认提示音，适合日常待办。");
        channel.enableVibration(true);
        channel.setShowBadge(true);
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(channel);
    }

    private static void createAlarmChannel(NotificationManager nm) {
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID_ALARM, "BattleStar 闹钟提醒", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("到点的提醒事项（闹钟式）：使用闹钟音频流并长时间震动，声音响亮，适合重要提醒。");
        AudioAttributes attributes = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
        channel.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM), attributes);
        channel.enableVibration(true);
        channel.setVibrationPattern(ALARM_VIBRATION);
        channel.setShowBadge(true);
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(channel);
    }

    /** 规范化通知方式：只接受 alarm，其余（含缺省/null/未知值）一律 gentle。 */
    public static String normalizeNotifyStyle(String style) {
        if (style == null) return STYLE_GENTLE;
        String value = style.trim().toLowerCase(Locale.ROOT);
        return STYLE_ALARM.equals(value) ? STYLE_ALARM : STYLE_GENTLE;
    }

    /** 通知方式对应的渠道 id。 */
    public static String channelFor(String notifyStyle) {
        return STYLE_ALARM.equals(normalizeNotifyStyle(notifyStyle)) ? CHANNEL_ID_ALARM : CHANNEL_ID;
    }

    /** 通知方式是否闹钟式（决定通知 CATEGORY_ALARM）。 */
    public static boolean isAlarmStyle(String notifyStyle) {
        return STYLE_ALARM.equals(normalizeNotifyStyle(notifyStyle));
    }

    public static boolean notificationsGranted(Context context) {
        if (context == null) return false;
        if (Build.VERSION.SDK_INT < 33) return true;
        return context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    /** 精确闹钟可用性：Android 12（API 31）以下默认可用；12+ 受 SCHEDULE_EXACT_ALARM 授权控制。 */
    public static boolean exactAlarmsAvailable(Context context) {
        if (context == null) return false;
        if (Build.VERSION.SDK_INT < 31) return true;
        try {
            AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            return am != null && am.canScheduleExactAlarms();
        } catch (Exception e) {
            Log.w(TAG, "canScheduleExactAlarms failed", e);
            return false;
        }
    }

    // ------------------------------------------------------------------
    // 缓存读写
    // ------------------------------------------------------------------

    public static SharedPreferences prefs(Context context) {
        return context.getApplicationContext()
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public static JSONArray load(Context context) {
        String raw;
        try {
            raw = prefs(context).getString(KEY_ITEMS, "");
        } catch (Exception e) {
            return new JSONArray();
        }
        if (raw == null || raw.trim().isEmpty()) return new JSONArray();
        try {
            JSONArray parsed = new JSONArray(raw);
            return parsed == null ? new JSONArray() : parsed;
        } catch (Exception e) {
            Log.w(TAG, "corrupted reminder cache, reset", e);
            return new JSONArray();
        }
    }

    private static void save(Context context, JSONArray items) {
        try {
            prefs(context).edit().putString(KEY_ITEMS, items == null ? "[]" : items.toString()).apply();
        } catch (Exception e) {
            Log.w(TAG, "save reminder cache failed", e);
        }
    }

    // ------------------------------------------------------------------
    // 全量同步
    // ------------------------------------------------------------------

    /**
     * 用 Hub 下发的最新提醒全量替换本地缓存并重排闹钟。
     *
     * @param incoming Hub 返回的 reminders 数组；null 视为空数组（清空提醒）
     * @return {@code {ok, scheduled, total, permissionGranted, exact, channel}}
     */
    public static JSONObject sync(Context context, JSONArray incoming) {
        JSONObject out = new JSONObject();
        if (context == null) {
            putQuietly(out, "ok", false);
            return out;
        }
        try {
            Context app = context.getApplicationContext();
            JSONArray items = normalize(incoming);
            synchronized (LOCK) {
                JSONArray previous = load(app);
                cancelAlarms(app, previous);
                save(app, items);
                ensureChannels(app);
                int scheduled = scheduleAll(app, items);
                putQuietly(out, "ok", true);
                putQuietly(out, "scheduled", scheduled);
                putQuietly(out, "total", items.length());
                putQuietly(out, "permissionGranted", notificationsGranted(app));
                putQuietly(out, "exact", exactAlarmsAvailable(app));
                putQuietly(out, "channel", CHANNEL_ID);
                putQuietly(out, "channels", channelsJson());
            }
        } catch (Exception e) {
            Log.w(TAG, "sync reminders failed", e);
            putQuietly(out, "ok", false);
            putQuietly(out, "scheduled", 0);
            putQuietly(out, "total", 0);
            putQuietly(out, "error", e.getClass().getSimpleName());
        }
        return out;
    }

    /** 从本地缓存重排全部闹钟（开机、应用更新、缓存被系统清理后恢复时使用）。 */
    public static JSONObject rescheduleAll(Context context) {
        if (context == null) return new JSONObject();
        JSONArray items = load(context.getApplicationContext());
        return sync(context, items);
    }

    /** 取消全部闹钟与提醒通知（保留缓存数据，便于下次 rescheduleAll 恢复）。 */
    public static void cancelAll(Context context) {
        if (context == null) return;
        Context app = context.getApplicationContext();
        synchronized (LOCK) {
            JSONArray items = load(app);
            cancelAlarms(app, items);
            NotificationManager nm = app.getSystemService(NotificationManager.class);
            if (nm != null) {
                for (Integer slot : buildSlots(items).values()) {
                    try {
                        nm.cancel(slot.intValue());
                    } catch (Exception ignored) {
                        // ignore
                    }
                }
            }
        }
    }

    private static int scheduleAll(Context context, JSONArray items) {
        if (items == null || items.length() == 0) return 0;
        Map<String, Integer> slots = buildSlots(items);
        long now = System.currentTimeMillis();
        int scheduled = 0;
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.optJSONObject(i);
            if (item == null || !item.optBoolean("enabled", false)) continue;
            String id = item.optString("id", "");
            long dueAt = item.optLong("dueAt", 0L);
            if (id.isEmpty() || dueAt <= 0L) continue;
            Integer slot = slots.get(id);
            if (slot == null) continue;
            long triggerAt = dueAt > now ? dueAt : now + IMMEDIATE_DELAY_MS;
            if (schedule(context, slot.intValue(), item, triggerAt)) scheduled += 1;
        }
        return scheduled;
    }

    // ------------------------------------------------------------------
    // 到点处理（由 ReminderReceiver 调用）
    // ------------------------------------------------------------------

    /**
     * 记录一条提醒在本机已触发：lastFiredAt/fireCount 更新；
     * 重复提醒把 dueAt 本地推进到下一次（daily +1d / weekly +7d，直到大于 now），
     * one-shot 提醒置 enabled=false。返回更新后的对象；id 不存在时返回 null。
     */
    public static JSONObject markFired(Context context, String id) {
        if (context == null || id == null || id.isEmpty()) return null;
        Context app = context.getApplicationContext();
        synchronized (LOCK) {
            JSONArray items = load(app);
            JSONObject found = findById(items, id);
            if (found == null) return null;
            long now = System.currentTimeMillis();
            JSONObject updated = normalizeItem(found);
            putQuietly(updated, "lastFiredAt", isoUtc(now));
            putQuietly(updated, "fireCount", updated.optInt("fireCount", 0) + 1);
            String repeat = updated.optString("repeat", "none");
            long dueAt = updated.optLong("dueAt", 0L);
            if ("daily".equals(repeat)) {
                long next = dueAt > 0L ? dueAt : now;
                while (next <= now) next += DAY_MS;
                putQuietly(updated, "dueAt", next);
                putQuietly(updated, "enabled", true);
            } else if ("weekly".equals(repeat)) {
                long next = dueAt > 0L ? dueAt : now;
                while (next <= now) next += WEEK_MS;
                putQuietly(updated, "dueAt", next);
                putQuietly(updated, "enabled", true);
            } else {
                putQuietly(updated, "enabled", false);
            }
            JSONArray nextItems = new JSONArray();
            for (int i = 0; i < items.length(); i++) {
                JSONObject item = items.optJSONObject(i);
                if (item == null) continue;
                if (id.equals(item.optString("id", ""))) {
                    nextItems.put(updated);
                } else {
                    nextItems.put(item);
                }
            }
            save(app, nextItems);
            return updated;
        }
    }

    // ------------------------------------------------------------------
    // 缓存查询
    // ------------------------------------------------------------------

    public static JSONObject findCached(Context context, String id) {
        if (context == null || id == null) return null;
        return findById(load(context.getApplicationContext()), id);
    }

    public static JSONObject findById(JSONArray items, String id) {
        if (items == null || id == null) return null;
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.optJSONObject(i);
            if (item != null && id.equals(item.optString("id", ""))) return item;
        }
        return null;
    }

    /** 已缓存且处于启用状态的提醒数量（用于 Bridge 状态回报）。 */
    public static int countEnabled(Context context) {
        if (context == null) return 0;
        JSONArray items = load(context.getApplicationContext());
        int count = 0;
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.optJSONObject(i);
            if (item != null && item.optBoolean("enabled", false) && item.optLong("dueAt", 0L) > 0L) {
                count += 1;
            }
        }
        return count;
    }

    // ------------------------------------------------------------------
    // 数据清洗
    // ------------------------------------------------------------------

    private static JSONArray normalize(JSONArray incoming) {
        JSONArray result = new JSONArray();
        if (incoming == null) return result;
        List<String> seen = new ArrayList<String>();
        for (int i = 0; i < incoming.length() && result.length() < MAX_ITEMS; i++) {
            JSONObject raw = incoming.optJSONObject(i);
            if (raw == null) continue;
            JSONObject item = normalizeItem(raw);
            String id = item.optString("id", "");
            if (id.isEmpty() || seen.contains(id)) continue;
            seen.add(id);
            result.put(item);
        }
        return result;
    }

    private static JSONObject normalizeItem(JSONObject raw) {
        JSONObject item = new JSONObject();
        if (raw == null) return item;
        // 先原样复制全部字段，避免丢弃 Hub 以后新增的未知字段（例如 notifyStyle 之外的扩展）
        Iterator<String> keys = raw.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            try {
                item.put(key, raw.opt(key));
            } catch (Exception ignored) {
                // 无法复制的字段直接跳过
            }
        }
        putQuietly(item, "id", raw.optString("id", "").trim());
        putQuietly(item, "title", clip(raw.optString("title", ""), 200));
        putQuietly(item, "note", clip(raw.optString("note", ""), 500));
        putQuietly(item, "dueAt", raw.optLong("dueAt", 0L));
        putQuietly(item, "repeat", normalizeRepeat(raw.optString("repeat", "none")));
        putQuietly(item, "enabled", raw.optBoolean("enabled", false));
        putQuietly(item, "notifyStyle", normalizeNotifyStyle(raw.optString("notifyStyle", STYLE_GENTLE)));
        putQuietly(item, "createdAt", raw.optString("createdAt", ""));
        putQuietly(item, "updatedAt", raw.optString("updatedAt", ""));
        putQuietly(item, "lastFiredAt", raw.optString("lastFiredAt", ""));
        putQuietly(item, "fireCount", raw.optInt("fireCount", 0));
        return item;
    }

    private static String normalizeRepeat(String repeat) {
        String value = repeat == null ? "none" : repeat.trim().toLowerCase(Locale.ROOT);
        if ("daily".equals(value) || "weekly".equals(value)) return value;
        return "none";
    }

    /** 渠道信息（Bridge 回报用）：gentle=butler_reminders，alarm=butler_reminders_alarm。 */
    public static JSONObject channelsJson() {
        JSONObject channels = new JSONObject();
        putQuietly(channels, STYLE_GENTLE, CHANNEL_ID);
        putQuietly(channels, STYLE_ALARM, CHANNEL_ID_ALARM);
        return channels;
    }

    private static String clip(String text, int max) {
        if (text == null) return "";
        if (text.length() <= max) return text;
        return text.substring(0, max);
    }

    private static void putQuietly(JSONObject target, String key, Object value) {
        try {
            target.put(key, value);
        } catch (Exception ignored) {
            // org.json 只会在 key 为 null 时抛错
        }
    }

    // ------------------------------------------------------------------
    // 闹钟排程
    // ------------------------------------------------------------------

    /** 计算 id → 通知 id/PendingIntent requestCode 的映射（7500..7899，冲突时线性探测）。 */
    static Map<String, Integer> buildSlots(JSONArray items) {
        Map<String, Integer> slots = new HashMap<String, Integer>();
        if (items == null || items.length() == 0) return slots;
        List<String> ids = new ArrayList<String>();
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.optJSONObject(i);
            if (item == null) continue;
            String id = item.optString("id", "");
            if (!id.isEmpty() && !ids.contains(id)) ids.add(id);
        }
        Collections.sort(ids);
        boolean[] used = new boolean[NOTIFY_SPAN];
        for (String id : ids) {
            int offset = id.hashCode() % NOTIFY_SPAN;
            if (offset < 0) offset = -offset;
            while (used[offset]) offset = (offset + 1) % NOTIFY_SPAN;
            used[offset] = true;
            slots.put(id, Integer.valueOf(NOTIFY_BASE + offset));
        }
        return slots;
    }

    /** 稳定的通知 id（缓存里取不到映射时的兜底：同一个 id 始终得到同一个值）。 */
    public static int notificationIdFor(String id) {
        if (id == null || id.isEmpty()) return NOTIFY_BASE;
        int offset = id.hashCode() % NOTIFY_SPAN;
        if (offset < 0) offset = -offset;
        return NOTIFY_BASE + offset;
    }

    private static boolean schedule(Context context, int requestCode, JSONObject item, long triggerAt) {
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return false;
        Intent intent = new Intent(context, ReminderReceiver.class);
        intent.setAction(ACTION_FIRE);
        intent.putExtra(EXTRA_REMINDER_ID, item.optString("id", ""));
        intent.putExtra(EXTRA_NOTIFY_ID, requestCode);
        intent.putExtra(EXTRA_TITLE, item.optString("title", ""));
        intent.putExtra(EXTRA_NOTE, item.optString("note", ""));
        intent.putExtra(EXTRA_NOTIFY_STYLE, normalizeNotifyStyle(item.optString("notifyStyle", STYLE_GENTLE)));
        PendingIntent pending;
        try {
            pending = PendingIntent.getBroadcast(context, requestCode, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        } catch (Exception e) {
            Log.w(TAG, "create reminder PendingIntent failed", e);
            return false;
        }
        try {
            if (exactAlarmsAvailable(context)) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pending);
            } else {
                // 精确闹钟被撤销：退化为可延迟（Doze 下可能晚几分钟）的非精确闹钟
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pending);
            }
            return true;
        } catch (SecurityException se) {
            Log.w(TAG, "exact alarm denied, fallback to inexact", se);
            try {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pending);
                return true;
            } catch (Exception e) {
                Log.w(TAG, "inexact alarm fallback failed", e);
                return false;
            }
        } catch (Exception e) {
            Log.w(TAG, "schedule reminder failed", e);
            return false;
        }
    }

    private static void cancelAlarms(Context context, JSONArray items) {
        if (items == null || items.length() == 0) return;
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        for (Integer slot : buildSlots(items).values()) {
            try {
                Intent intent = new Intent(context, ReminderReceiver.class);
                intent.setAction(ACTION_FIRE);
                PendingIntent pending = PendingIntent.getBroadcast(context, slot.intValue(), intent,
                        PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE);
                if (pending != null) {
                    am.cancel(pending);
                    pending.cancel();
                }
            } catch (Exception e) {
                Log.w(TAG, "cancel reminder alarm failed", e);
            }
        }
    }

    // ------------------------------------------------------------------
    // 工具
    // ------------------------------------------------------------------

    public static String isoUtc(long millis) {
        try {
            SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
            format.setTimeZone(TimeZone.getTimeZone("UTC"));
            return format.format(new Date(millis));
        } catch (Exception e) {
            return "";
        }
    }
}
