package com.superbutler.app;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * 通知栏里「大脑需要你决定」的选项按钮接收器（exported=false，只由本应用的通知 PendingIntent 触发）。
 *
 * <p>用户点击某个选项后：后台 POST {@code /api/brain/owner-ask/choose} 回写 Hub，
 * 成功后取消决策通知。失败不弹错误（下次 snapshot 轮询会重新同步；通知仍保留原状态）。</p>
 */
public class DecisionActionReceiver extends BroadcastReceiver {

    public static final String ACTION_CHOOSE = "com.superbutler.app.DECISION_CHOOSE";
    public static final String EXTRA_OPTION_ID = "option_id";
    public static final String EXTRA_OPTION_LABEL = "option_label";
    public static final String EXTRA_NOTIFICATION_ID = "notification_id";

    private static final String TAG = "SuperButlerDecision";
    private static final String PREFS_NAME = "butler_config";
    private static final String KEY_HUB = "hub_url";
    private static final String KEY_TOKEN = "admin_token";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null) return;
        String action = intent.getAction();
        if (action != null && !ACTION_CHOOSE.equals(action)) return;

        final String optionId = intent.getStringExtra(EXTRA_OPTION_ID);
        if (optionId == null || optionId.trim().isEmpty()) return;
        final String optionLabel = intent.getStringExtra(EXTRA_OPTION_LABEL);
        final int notifyId = intent.getIntExtra(EXTRA_NOTIFICATION_ID, 7600);

        final Context app = context.getApplicationContext();
        final PendingResult pendingResult = goAsync();
        Thread worker = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    boolean ok = postChoice(app, optionId, optionLabel);
                    if (ok) {
                        NotificationManager nm = app.getSystemService(NotificationManager.class);
                        if (nm != null) {
                            try {
                                nm.cancel(notifyId);
                            } catch (Exception e) {
                                Log.w(TAG, "cancel decision notification failed", e);
                            }
                        }
                    }
                } catch (Exception e) {
                    Log.w(TAG, "choose decision option failed", e);
                } finally {
                    try {
                        pendingResult.finish();
                    } catch (Exception ignored) {
                        // ignore
                    }
                }
            }
        }, "butler-decision-choice");
        try {
            worker.start();
        } catch (Exception e) {
            Log.w(TAG, "start decision worker failed", e);
            try {
                pendingResult.finish();
            } catch (Exception ignored) {
                // ignore
            }
        }
    }

    private static boolean postChoice(Context context, String optionId, String optionLabel) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String hub = normalizeHub(prefs.getString(KEY_HUB, ""));
        String token = prefs.getString(KEY_TOKEN, "");
        if (hub == null || token == null || token.trim().isEmpty()) {
            Log.w(TAG, "skip choice callback: hub not configured");
            return false;
        }
        HttpURLConnection conn = null;
        try {
            URL url = new URL(hub + "/api/brain/owner-ask/choose");
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(4000);
            conn.setReadTimeout(4000);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Accept", "application/json");
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            conn.setRequestProperty("X-Butler-Token", token.trim());
            JSONObject body = new JSONObject();
            body.put("optionId", optionId);
            byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(payload.length);
            OutputStream os = conn.getOutputStream();
            os.write(payload);
            os.flush();
            os.close();
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) {
                Log.w(TAG, "choose option HTTP " + code + " (option=" + optionId + ")");
                drain(conn.getErrorStream());
                return false;
            }
            drain(conn.getInputStream());
            Log.i(TAG, "decision recorded: " + optionLabel + " (" + optionId + ")");
            return true;
        } catch (Exception e) {
            Log.w(TAG, "choose option request failed", e);
            return false;
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
