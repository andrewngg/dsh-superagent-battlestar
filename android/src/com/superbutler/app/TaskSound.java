package com.superbutler.app;

import android.app.NotificationManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

/**
 * 任务提示音：任务开始（第一次出现进度）与任务结束（完成/失败/超时/取消）时播放系统通知音。
 *
 * <p>免打扰优先：只有系统不处于免打扰（{@link NotificationManager#getCurrentInterruptionFilter()}
 * 为 {@code INTERRUPTION_FILTER_ALL}）且铃声不是静音模式时才播放。后台「任务提示音」开关
 * （Hub 设置里的 {@code taskSoundEnabled}）关闭后完全静音。</p>
 *
 * <p>使用独立播放而不是通知渠道声音，原因是渠道声音一旦创建就不可修改，无法满足
 * 「后台一键静音 / 免打扰自动静音」的即时需求。{@code notify()} 仍不带声音，避免双重响铃。</p>
 */
final class TaskSound {

    private static final String TAG = "SuperButlerSound";
    private static final String PREFS_NAME = "butler_config";
    /** 与 Hub 设置的 taskSoundEnabled 对应；默认开启。 */
    static final String KEY_TASK_SOUND = "task_sound_enabled";
    /**
     * 同一事件（任务 + 类型）的去重窗口：WebView 页面与常驻服务可能先后触发，
     * 服务轮询间隔 5 秒，窗口取 8 秒覆盖一个轮询周期。
     */
    private static final long DEDUPE_MS = 8000L;
    /** 最近播放过的事件 key → 时间；多槽位避免页面/服务交错触发时误判。 */
    private static final java.util.Map<String, Long> RECENT = new java.util.HashMap<>();

    private TaskSound() {}

    static boolean isEnabled(Context context) {
        if (context == null) return false;
        try {
            return prefs(context).getBoolean(KEY_TASK_SOUND, true);
        } catch (Exception e) {
            return true;
        }
    }

    static void setEnabled(Context context, boolean enabled) {
        if (context == null) return;
        try {
            prefs(context).edit().putBoolean(KEY_TASK_SOUND, enabled).apply();
        } catch (Exception e) {
            Log.w(TAG, "save task sound setting failed", e);
        }
    }

    /** 系统是否处于免打扰/静音，需要跳过提示音。 */
    static boolean isDndActive(Context context) {
        if (context == null) return false;
        try {
            NotificationManager nm = context.getSystemService(NotificationManager.class);
            if (nm != null) {
                int filter = nm.getCurrentInterruptionFilter();
                if (filter == NotificationManager.INTERRUPTION_FILTER_NONE
                        || filter == NotificationManager.INTERRUPTION_FILTER_ALARMS
                        || filter == NotificationManager.INTERRUPTION_FILTER_PRIORITY) {
                    return true;
                }
            }
        } catch (Exception e) {
            // 个别 ROM 在无 DND 访问权时会抛异常：按非免打扰处理，声音仍受系统音量/渠道策略约束。
            Log.w(TAG, "read interruption filter failed", e);
        }
        try {
            AudioManager am = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
            if (am != null && am.getRingerMode() == AudioManager.RINGER_MODE_SILENT) return true;
        } catch (Exception ignored) {
            // ignore
        }
        return false;
    }

    /** 任务开始：同一任务只响一次（页面/服务都可能触发，由 track 的 first 标记与去重兜底）。 */
    static void playStart(Context context, String taskId) {
        play(context, "start:" + safeId(taskId));
    }

    /** 任务结束（完成/失败/超时/取消）。 */
    static void playFinished(Context context, String taskId) {
        play(context, "done:" + safeId(taskId));
    }

    private static String safeId(String taskId) {
        return taskId == null ? "" : taskId;
    }

    private static void play(Context context, String key) {
        if (context == null || key.endsWith(":")) return;
        if (!isEnabled(context) || isDndActive(context)) return;
        final Context app;
        try {
            app = context.getApplicationContext() == null ? context : context.getApplicationContext();
        } catch (Exception e) {
            return;
        }
        try {
            long now = System.currentTimeMillis();
            synchronized (RECENT) {
                Long last = RECENT.get(key);
                if (last != null && now - last < DEDUPE_MS) return;
                RECENT.put(key, now);
                if (RECENT.size() > 20) {
                    java.util.Iterator<java.util.Map.Entry<String, Long>> it = RECENT.entrySet().iterator();
                    while (it.hasNext()) {
                        if (now - it.next().getValue() > DEDUPE_MS * 4) it.remove();
                    }
                }
            }
        } catch (Exception e) {
            // 去重失败也继续尝试播放
        }
        new Handler(Looper.getMainLooper()).post(new Runnable() {
            @Override
            public void run() {
                try {
                    Uri uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
                    if (uri == null) return;
                    Ringtone ringtone = RingtoneManager.getRingtone(app, uri);
                    if (ringtone == null) return;
                    if (Build.VERSION.SDK_INT >= 21) {
                        ringtone.setAudioAttributes(new AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                                .build());
                    }
                    ringtone.play();
                } catch (Exception e) {
                    Log.w(TAG, "play task sound failed", e);
                }
            }
        });
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }
}
