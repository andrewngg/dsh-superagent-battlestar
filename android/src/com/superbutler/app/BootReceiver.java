package com.superbutler.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * 开机 / 应用更新后从本地缓存重排提醒闹钟。
 *
 * <p>AlarmManager 的闹钟在设备重启后会丢失，必须在 {@code BOOT_COMPLETED}
 * （以及覆盖安装后的 {@code MY_PACKAGE_REPLACED}）之后调用
 * {@link ReminderScheduler#rescheduleAll(Context)} 从 SharedPreferences 恢复。
 * 该 Receiver 不导出（exported=false），只有系统广播能触发。</p>
 */
public class BootReceiver extends BroadcastReceiver {

    private static final String TAG = "SuperButlerReminder";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            return;
        }
        Context app = context.getApplicationContext();
        try {
            ReminderScheduler.ensureChannels(app);
            ReminderScheduler.rescheduleAll(app);
            Log.i(TAG, "reminders rescheduled after " + action);
        } catch (Exception e) {
            Log.w(TAG, "reschedule reminders after boot failed", e);
        }
    }
}
