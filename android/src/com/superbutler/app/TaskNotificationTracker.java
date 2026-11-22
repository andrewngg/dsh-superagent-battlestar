package com.superbutler.app;

import android.app.NotificationManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.service.notification.StatusBarNotification;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 任务通知跟踪与超时清理。
 *
 * <p>背景：任务通知由 WebView 控制台通过 {@code ButlerBridge.taskProgress / taskFinished}
 * 驱动。页面刷新、WebView 重启或任务从快照前 40 条滚出时，控制台可能来不及发完成事件，
 * 于是「进行中」通知（{@code setOngoing(true)}，用户无法划掉）会一直卡在通知栏。</p>
 *
 * <p>这里在原生侧兜底：每次 {@code notify()} 都把通知 id、任务 id、发出时间与到期时间记入
 * 内存表并持久化到 SharedPreferences；到期后由 {@link #sweep(Context)} 主动取消。
 * 同时 {@code postTaskNotification} 会调用 {@link Notification.Builder#setTimeoutAfter(long)}，
 * 即使 App 进程被杀、本类不再运行，系统也会在到期时自动移除通知。</p>
 *
 * <p>超时策略：</p>
 * <ul>
 *   <li>进行中通知：最后一次进度更新后 {@link #PROGRESS_TTL_MS}（30 分钟）无更新则消失；</li>
 *   <li>完成/失败/超时/取消通知：{@link #FINISHED_TTL_MS}（10 分钟）后消失；</li>
 *   <li>旧版本遗留的未跟踪任务通知（id 落在 7300 段）：发出超过 30 分钟后由
 *       {@link #sweep(Context)} 一并清掉。</li>
 * </ul>
 */
final class TaskNotificationTracker {

    /** 任务通知 id 基址：与 MainActivity 中 notifyId 的算法一致。 */
    static final int TASK_NOTIFY_BASE = 7300;
    /** 任务通知 id 可用段长度（基于 taskId.hashCode() % 10000）。 */
    static final int TASK_NOTIFY_COUNT = 10000;

    /** 进行中通知的存活时间：30 分钟无更新自动消失。 */
    static final long PROGRESS_TTL_MS = 30L * 60 * 1000;
    /** 终态（完成/失败/超时/取消）通知的存活时间：10 分钟。 */
    static final long FINISHED_TTL_MS = 10L * 60 * 1000;

    private static final String TAG = "SuperButlerNotify";
    private static final String PREFS_NAME = "butler_config";
    private static final String KEY_ENTRIES = "task_notifications";
    private static final int MAX_ENTRIES = 100;

    private static final Object LOCK = new Object();
    private static final Map<Integer, Entry> ENTRIES = new LinkedHashMap<>();
    private static boolean loaded = false;

    private TaskNotificationTracker() {}

    /** 单条任务通知的跟踪记录。 */
    static final class Entry {
        int notifyId;
        String taskId = "";
        String status = "";
        long postedAt;
        long expiresAt;
        boolean finished;
    }

    static long ttlFor(boolean finished) {
        return finished ? FINISHED_TTL_MS : PROGRESS_TTL_MS;
    }

    /**
     * 记录/刷新一次任务通知，重置其超时计时。
     *
     * @return true 表示这是该通知 id 第一次被跟踪（可用于「任务开始」提示音只响一次）
     */
    static boolean track(Context context, int notifyId, String taskId, String status, boolean finished) {
        if (context == null || !isTaskNotifyId(notifyId)) return false;
        synchronized (LOCK) {
            ensureLoaded(context);
            boolean first = !ENTRIES.containsKey(notifyId);
            removeLocked(notifyId);
            Entry entry = new Entry();
            entry.notifyId = notifyId;
            entry.taskId = taskId == null ? "" : taskId;
            entry.status = status == null ? "" : status;
            entry.postedAt = System.currentTimeMillis();
            entry.expiresAt = entry.postedAt + ttlFor(finished);
            entry.finished = finished;
            ENTRIES.put(notifyId, entry);
            trimLocked();
            persistLocked(context);
            return first;
        }
    }

    /** 移除跟踪记录（不取消通知本身）。 */
    static void untrack(Context context, int notifyId) {
        synchronized (LOCK) {
            ensureLoaded(context);
            if (removeLocked(notifyId) != null) persistLocked(context);
        }
    }

    /**
     * 清理过期与旧版本遗留的任务通知：
     * <ol>
     *   <li>跟踪表中到期（或已过期的终态）的通知 → 取消；</li>
     *   <li>通知栏中实际存在、但不在跟踪表里的任务通知，若发出已超过 30 分钟 → 取消
     *       （覆盖 0.1.5 及更早版本遗留的卡住通知）。</li>
     * </ol>
     *
     * @return 本次取消的通知数量
     */
    static int sweep(Context context) {
        if (context == null) return 0;
        int cancelled = 0;
        synchronized (LOCK) {
            ensureLoaded(context);
            long now = System.currentTimeMillis();
            NotificationManager nm = context.getSystemService(NotificationManager.class);

            Iterator<Map.Entry<Integer, Entry>> it = ENTRIES.entrySet().iterator();
            while (it.hasNext()) {
                Entry entry = it.next().getValue();
                if (entry.expiresAt > now) continue;
                it.remove();
                cancelQuietly(nm, entry.notifyId);
                cancelled += 1;
            }

            // 跟踪表之外的 7300 段任务通知：只清超过「进行中」TTL 的，避免误伤刚发出的通知。
            try {
                if (nm != null) {
                    StatusBarNotification[] active = nm.getActiveNotifications();
                    if (active != null) {
                        for (StatusBarNotification sbn : active) {
                            if (sbn == null) continue;
                            int id = sbn.getId();
                            if (!isTaskNotifyId(id) || ENTRIES.containsKey(id)) continue;
                            if (now - sbn.getPostTime() < PROGRESS_TTL_MS) continue;
                            cancelQuietly(nm, id);
                            cancelled += 1;
                        }
                    }
                }
            } catch (Exception e) {
                // 部分 ROM 的 getActiveNotifications 可能抛异常：忽略，超时仍由系统 timeoutAfter 兜底
                Log.w(TAG, "scan active notifications failed", e);
            }

            if (cancelled > 0) persistLocked(context);
        }
        return cancelled;
    }

    /**
     * 取消某任务已跟踪的通知（例如从 Hub 轮询中确认任务已经结束）。
     *
     * @param onlyUnfinished true 时只取消仍在「进行中」的通知，保留已发出的完成/失败通知
     */
    static int cancelTask(Context context, String taskId, boolean onlyUnfinished) {
        if (context == null || taskId == null || taskId.isEmpty()) return 0;
        int cancelled = 0;
        synchronized (LOCK) {
            ensureLoaded(context);
            NotificationManager nm = context.getSystemService(NotificationManager.class);
            Iterator<Map.Entry<Integer, Entry>> it = ENTRIES.entrySet().iterator();
            while (it.hasNext()) {
                Entry entry = it.next().getValue();
                if (!taskId.equals(entry.taskId)) continue;
                if (onlyUnfinished && entry.finished) continue;
                it.remove();
                cancelQuietly(nm, entry.notifyId);
                cancelled += 1;
            }
            if (cancelled > 0) persistLocked(context);
        }
        return cancelled;
    }

    /** 当前跟踪快照（按发出时间先后）。 */
    static List<Entry> snapshot(Context context) {
        synchronized (LOCK) {
            ensureLoaded(context);
            return new ArrayList<>(ENTRIES.values());
        }
    }

    static boolean isTaskNotifyId(int notifyId) {
        return notifyId >= TASK_NOTIFY_BASE && notifyId < TASK_NOTIFY_BASE + TASK_NOTIFY_COUNT;
    }

    private static void cancelQuietly(NotificationManager nm, int notifyId) {
        if (nm == null) return;
        try {
            nm.cancel(notifyId);
        } catch (Exception e) {
            Log.w(TAG, "cancel task notification " + notifyId + " failed", e);
        }
    }

    private static Entry removeLocked(int notifyId) {
        return ENTRIES.remove(notifyId);
    }

    private static void trimLocked() {
        while (ENTRIES.size() > MAX_ENTRIES) {
            Iterator<Integer> it = ENTRIES.keySet().iterator();
            if (!it.hasNext()) return;
            Integer oldest = it.next();
            it.remove();
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private static void ensureLoaded(Context context) {
        if (loaded || context == null) return;
        loaded = true;
        String raw = prefs(context).getString(KEY_ENTRIES, "");
        if (raw == null || raw.isEmpty()) return;
        long now = System.currentTimeMillis();
        try {
            JSONArray array = new JSONArray(raw);
            for (int i = 0; i < array.length(); i++) {
                JSONObject o = array.optJSONObject(i);
                if (o == null) continue;
                int id = o.optInt("id", -1);
                if (!isTaskNotifyId(id)) continue;
                long expiresAt = o.optLong("expiresAt", 0L);
                if (expiresAt <= 0L) continue;
                // 已过期的记录也保留：进程重启后通知可能仍在通知栏，下一次 sweep 会用它把通知取消。
                Entry entry = new Entry();
                entry.notifyId = id;
                entry.taskId = o.optString("taskId", "");
                entry.status = o.optString("status", "");
                entry.postedAt = o.optLong("postedAt", now);
                entry.expiresAt = expiresAt;
                entry.finished = o.optBoolean("finished", false);
                ENTRIES.put(id, entry);
            }
        } catch (Exception e) {
            Log.w(TAG, "load task notification records failed", e);
        }
    }

    private static void persistLocked(Context context) {
        try {
            JSONArray array = new JSONArray();
            for (Entry entry : ENTRIES.values()) {
                JSONObject o = new JSONObject();
                o.put("id", entry.notifyId);
                o.put("taskId", entry.taskId);
                o.put("status", entry.status);
                o.put("postedAt", entry.postedAt);
                o.put("expiresAt", entry.expiresAt);
                o.put("finished", entry.finished);
                array.put(o);
            }
            prefs(context).edit().putString(KEY_ENTRIES, array.toString()).apply();
        } catch (Exception e) {
            Log.w(TAG, "persist task notification records failed", e);
        }
    }
}
