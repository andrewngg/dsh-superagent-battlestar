package com.superbutler.app;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * BattleStar 手机端。
 *
 * <p>首次启动加载本地 {@code file:///android_asset/setup.html} 配置 Hub 地址与管理员令牌；
 * 配置完成后直接加载 {@code <hub>/m?token=<token>}。所有页面在无边框 WebView 中展示。</p>
 *
 * <p>安全边界：JS Bridge 仅在本地页面与已配置 Hub 同主机页面注入；所有 Bridge 方法都会
 * 再次检查 {@link #bridgeAllowed}，非受信页面无法读写配置或发起网络探测。</p>
 */
public class MainActivity extends Activity {

    private static final String TAG = "SuperButler";
    private static final String APP_VERSION = "0.1.5";
    private static final String SETUP_URL = "file:///android_asset/setup.html";
    private static final String ERROR_BASE = "file:///android_asset/error.html";
    private static final String ASSET_BASE = "file:///android_asset/";
    private static final String BRIDGE_NAME = "ButlerBridge";

    private static final String PREFS_NAME = "butler_config";
    private static final String KEY_HUB = "hub_url";
    private static final String KEY_TOKEN = "admin_token";
    private static final String KEY_PERSISTENT_NOTIFY = "persistent_notification";

    private static final String TASK_PROGRESS_CHANNEL = "butler_task_progress";
    private static final String TASK_DONE_CHANNEL = "butler_task_done";
    private static final String DECISION_CHANNEL = "butler_decision";
    private static final int REQ_POST_NOTIFICATIONS = 7301;
    private static final int REQ_FILE_CHOOSER = 7302;
    private static final int TASK_NOTIFY_BASE = 7300;

    /** APK 兜底：任务页默认「进行中」——Web 控制台默认已是「进行中」，注入仅用于兼容旧版 Hub 页面。 */
    private static final String TASK_FILTER_DEFAULT_JS =
            "(function(){try{"
                    + "var chip=document.querySelector('#task-filters .filter-chip[data-filter=\"active\"]');"
                    + "if(!chip)return 'missing';"
                    + "if(chip.classList.contains('is-active'))return 'active';"
                    + "chip.click();"
                    + "return 'ok';"
                    + "}catch(e){return 'error';}})()";
    private static final int TASK_FILTER_RETRY_MAX = 8;
    private static final long TASK_FILTER_RETRY_MS = 400L;

    /**
     * APK 兜底：让「N 个失败任务可重试」提示与「失败」筛选里实际可见的卡片数量一致。
     *
     * <p>Web 控制台的提示按 state.tasks 里所有失败任务计数，但「失败」列表只渲染根任务
     * （子任务/后续步骤属于父任务卡片），因此可能出现“提示说 N 个、点进去却没有”或数量偏多。
     * 这里在页面里监听（包裹）控制台自己的 /api/snapshot 响应，用与列表相同的根任务/线程分组
     * 规则重算；若失败卡片为 0 就把提示隐藏并清空，否则只校正提示开头的数字。
     * 只改 APK 内的 WebView，桌面浏览器不受影响。</p>
     */
    private static final String TASK_HINT_FIX_JS = String.join("\n",
            "(function(){try{",
            "if(window.__butlerHintFix)return 'already';",
            "window.__butlerHintFix='installed';",
            "var cache=null;",
            "var origFetch=window.fetch;",
            "if(typeof origFetch==='function'){",
            "window.fetch=function(){",
            "var url='';",
            "try{url=String(arguments[0]&&arguments[0].url?arguments[0].url:arguments[0]);}catch(e){}",
            "var p=origFetch.apply(this,arguments);",
            "if(url.indexOf('/api/snapshot')>=0){",
            "try{p.then(function(r){",
            "try{r.clone().json().then(function(d){if(d&&Array.isArray(d.tasks))cache=d.tasks;}).catch(function(){});}catch(e2){}",
            "}).catch(function(){});}catch(e3){}",
            "}",
            "return p;",
            "};",
            "}",
            "var RETRY={failed:1,timeout:1,cancelled:1};",
            "function hitStatus(t){return !!RETRY[String((t&&t.status)||'').toLowerCase()];}",
            "function failedRoots(tasks){",
            "var roots=[];",
            "for(var i=0;i<tasks.length;i++){var t=tasks[i];if(t&&!t.parentTaskId&&!t.replyToTaskId)roots.push(t);}",
            "var n=0;",
            "for(var a=0;a<roots.length;a++){",
            "var key=roots[a].threadId||roots[a].id;",
            "var hit=false;",
            "for(var j=0;j<tasks.length;j++){var t2=tasks[j];if(t2&&((t2.threadId||t2.id)===key)&&!t2.archived&&hitStatus(t2)){hit=true;break;}}",
            "if(hit)n++;",
            "}",
            "return n;",
            "}",
            "function apply(){",
            "var host=document.getElementById('task-recovery-hint');",
            "if(!host||host.hidden||!Array.isArray(cache))return;",
            "var n=failedRoots(cache);",
            "if(n<=0){host.hidden=true;try{host.replaceChildren();}catch(e){while(host.firstChild)host.removeChild(host.firstChild);}return;}",
            "var t=host.querySelector('.recovery-hint-text');",
            "if(!t)return;",
            "var s=String(t.textContent||'');",
            "if(/^\\d+/.test(s)){var next=s.replace(/^\\d+/,String(n));if(next!==s)t.textContent=next;}",
            "}",
            "setInterval(apply,1200);",
            "setTimeout(apply,600);",
            "apply();",
            "return 'installed';",
            "}catch(e){return 'error';}})()");

    private static final int BRAND_BG = Color.parseColor("#141026");
    private static final int BRAND_DARK = Color.parseColor("#0B0818");

    private SharedPreferences prefs;
    private WebView webView;
    private Bridge bridge;
    private final HubDiscovery hubDiscovery = new HubDiscovery();
    private volatile boolean bridgeAllowed = false;
    private boolean bridgeAdded = false;
    private boolean showingError = false;
    private boolean pendingClearHistory = false;
    private ValueCallback<Uri[]> pendingFileCallback;
    /** 通知点击带来的待切换 tab（ReminderReceiver 的 open_tab=reminders）。 */
    private String pendingOpenTab;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        getWindow().setStatusBarColor(BRAND_DARK);
        getWindow().setNavigationBarColor(BRAND_DARK);

        bridge = new Bridge();
        webView = new WebView(this);
        webView.setBackgroundColor(BRAND_BG);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        configureSettings(webView.getSettings());
        webView.setWebViewClient(new ButlerWebViewClient());
        webView.setWebChromeClient(new ButlerWebChromeClient());

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BRAND_BG);
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        applyEdgeToEdgeInsets(root);
        setContentView(root);

        createNotificationChannels();
        requestNotificationPermissionIfNeeded();
        if (prefs.getBoolean(KEY_PERSISTENT_NOTIFY, false)) {
            startPersistentNotificationService();
        }
        handleOpenTabIntent(getIntent());
        loadInitial();
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 首页/前台也主动拉一次提醒并重排闹钟（即使页面暂未调用 Bridge、或常驻服务未开启）
        syncRemindersFromHubAsync();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleOpenTabIntent(intent);
        applyPendingOpenTab();
    }

    // ------------------------------------------------------------------
    // 提醒：通知点击后切到「提醒」tab
    // ------------------------------------------------------------------

    private void handleOpenTabIntent(Intent intent) {
        if (intent == null) return;
        String tab = intent.getStringExtra("open_tab");
        if (tab != null && !tab.trim().isEmpty()) pendingOpenTab = tab.trim();
    }

    /** 页面加载完成后（或已有实例收到 onNewIntent 时）切到提醒 tab。 */
    private void applyPendingOpenTab() {
        String tab = pendingOpenTab;
        if (tab == null || webView == null || showingError) return;
        String url = webView.getUrl();
        // 页面尚未加载出实际内容（本地配置页/错误页/加载中）：保留待处理标记，等 onPageFinished
        if (url == null || url.startsWith(ASSET_BASE) || webView.getProgress() < 100) return;
        if ("reminders".equals(tab)) {
            try {
                webView.evaluateJavascript("try{window.location.hash='#reminders';}catch(e){}", null);
            } catch (Exception e) {
                Log.w(TAG, "switch to reminders tab failed", e);
            }
        } else if ("brain".equals(tab)) {
            // 大脑决策通知：切到状态页，稍后滚动并高亮大脑卡片（等待 tab 切换渲染完成）
            try {
                webView.evaluateJavascript("try{window.location.hash='#status';}catch(e){}", null);
            } catch (Exception e) {
                Log.w(TAG, "switch to status tab failed", e);
            }
            final WebView target = webView;
            target.postDelayed(new Runnable() {
                @Override
                public void run() {
                    if (target != webView || showingError) return;
                    try {
                        target.evaluateJavascript(
                                "try{var c=document.querySelector('#brain-card');"
                                        + "if(c){c.classList.add('is-flash');"
                                        + "setTimeout(function(){c.classList.remove('is-flash');},2400);"
                                        + "c.scrollIntoView({behavior:'smooth',block:'center'});}}catch(e){}",
                                null);
                    } catch (Exception e) {
                        Log.w(TAG, "focus brain card failed", e);
                    }
                }
            }, 500L);
        }
        pendingOpenTab = null;
    }

    // ------------------------------------------------------------------
    // 任务页：默认「进行中」（Web 控制台默认已一致；此注入为旧版 Hub 页面的兜底）
    // ------------------------------------------------------------------

    /**
     * 兜底：若任务页打开时「进行中」筛选 chip 未选中（如旧版 Hub 页面仍默认「全部」），就点一下。
     * 新版控制台默认已是「进行中」，此时仅确认状态；用户手动切到其它筛选仍照常生效。
     */
    private void applyTaskFilterDefault() {
        final WebView view = webView;
        if (view == null || showingError) return;
        String url;
        try {
            url = view.getUrl();
        } catch (Exception e) {
            return;
        }
        if (url == null || url.startsWith(ASSET_BASE) || !isTrustedUrl(url)) return;
        attemptTaskFilterDefault(view, url, 0);
    }

    private void attemptTaskFilterDefault(final WebView view, final String startedUrl, final int attempt) {
        if (view != webView || showingError) return;
        String current;
        try {
            current = view.getUrl();
        } catch (Exception e) {
            return;
        }
        // 页面已跳走（重定向/错误页）就停止，避免在别的页面误点
        if (current == null || !current.equals(startedUrl)) return;
        try {
            view.evaluateJavascript(TASK_FILTER_DEFAULT_JS, new ValueCallback<String>() {
                @Override
                public void onReceiveValue(String value) {
                    if (attempt >= TASK_FILTER_RETRY_MAX) return;
                    if (value == null || value.contains("missing") || value.contains("error")) {
                        view.postDelayed(new Runnable() {
                            @Override
                            public void run() {
                                attemptTaskFilterDefault(view, startedUrl, attempt + 1);
                            }
                        }, TASK_FILTER_RETRY_MS);
                    }
                }
            });
        } catch (Exception e) {
            Log.w(TAG, "apply default task filter failed", e);
        }
    }

    // ------------------------------------------------------------------
    // 任务页：失败提示数量与「失败」列表对齐（APK 专属兜底）
    // ------------------------------------------------------------------

    /** 在受信 Hub 页面上安装失败提示校正脚本（幂等，重复加载仅安装一次）。 */
    private void applyTaskHintFix() {
        final WebView view = webView;
        if (view == null || showingError) return;
        String url;
        try {
            url = view.getUrl();
        } catch (Exception e) {
            return;
        }
        if (url == null || url.startsWith(ASSET_BASE) || !isTrustedUrl(url)) return;
        try {
            view.evaluateJavascript(TASK_HINT_FIX_JS, null);
        } catch (Exception e) {
            Log.w(TAG, "apply task hint fix failed", e);
        }
    }

    // ------------------------------------------------------------------
    // 提醒：App 前台时从 Hub 拉取并同步（Bridge 同步之外的兜底）
    // ------------------------------------------------------------------

    private void syncRemindersFromHubAsync() {
        final String hub = normalizeHubUrl(prefs.getString(KEY_HUB, ""));
        final String token = prefs.getString(KEY_TOKEN, "");
        if (hub == null || token == null || token.trim().isEmpty()) return;
        final String trimmedToken = token.trim();
        Thread thread = new Thread(new Runnable() {
            @Override
            public void run() {
                JSONArray reminders = fetchReminders(hub, trimmedToken);
                if (reminders != null) {
                    ReminderScheduler.sync(MainActivity.this, reminders);
                }
            }
        }, "butler-reminders-sync");
        thread.setDaemon(true);
        try {
            thread.start();
        } catch (Exception e) {
            Log.w(TAG, "start reminder sync failed", e);
        }
    }

    /** GET /api/reminders（失败返回 null，静默等待下次同步）。 */
    private JSONArray fetchReminders(String hub, String token) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(hub + "/api/reminders");
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(6000);
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Accept", "application/json");
            conn.setRequestProperty("X-Butler-Token", token);
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) {
                Log.w(TAG, "fetch reminders HTTP " + code);
                return null;
            }
            JSONObject body = new JSONObject(readStream(conn.getInputStream()));
            return body.optJSONArray("reminders");
        } catch (Exception e) {
            Log.w(TAG, "fetch reminders failed", e);
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void configureSettings(WebSettings s) {
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setUseWideViewPort(false);
        s.setLoadWithOverviewMode(false);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setAllowContentAccess(false);
        String ua = s.getUserAgentString();
        if (ua == null) ua = "";
        if (!ua.contains("SuperButlerApp/")) {
            s.setUserAgentString(ua + " SuperButlerApp/" + APP_VERSION);
        }
    }

    /** targetSdk 36 在 Android 15+ 强制 edge-to-edge，这里给根布局补系统栏内边距。 */
    private void applyEdgeToEdgeInsets(FrameLayout root) {
        if (Build.VERSION.SDK_INT < 35) return;
        root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override
            public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
                int left = insets.getSystemWindowInsetLeft();
                int top = insets.getSystemWindowInsetTop();
                int right = insets.getSystemWindowInsetRight();
                int bottom = insets.getSystemWindowInsetBottom();
                v.setPadding(left, top, right, bottom);
                return insets;
            }
        });
    }

    // ------------------------------------------------------------------
    // 导航
    // ------------------------------------------------------------------

    private void loadInitial() {
        String hub = normalizeHubUrl(prefs.getString(KEY_HUB, ""));
        String token = prefs.getString(KEY_TOKEN, "");
        if (hub != null && token != null && !token.trim().isEmpty()) {
            loadDashboard();
        } else {
            loadSetup();
        }
    }

    private void loadSetup() {
        showingError = false;
        syncBridgeForUrl(SETUP_URL);
        webView.loadUrl(SETUP_URL);
    }

    private void loadDashboard() {
        String hub = normalizeHubUrl(prefs.getString(KEY_HUB, ""));
        String token = prefs.getString(KEY_TOKEN, "");
        if (hub == null || token == null || token.trim().isEmpty()) {
            loadSetup();
            return;
        }
        showingError = false;
        pendingClearHistory = true;
        String url = hub + "/m?token=" + Uri.encode(token.trim());
        syncBridgeForUrl(url);
        webView.loadUrl(url);
    }

    private void showErrorPage(String title, String detail) {
        if (isFinishing()) return;
        showingError = true;
        syncBridgeForUrl(ERROR_BASE);
        webView.loadDataWithBaseURL(ASSET_BASE, buildErrorPage(title, detail),
                "text/html", "utf-8", null);
    }

    private String currentHub() {
        String hub = normalizeHubUrl(prefs.getString(KEY_HUB, ""));
        return hub == null ? "" : hub;
    }

    // ------------------------------------------------------------------
    // Bridge 注入策略：仅本地页面与已配置 Hub 同主机页面
    // ------------------------------------------------------------------

    private void syncBridgeForUrl(String url) {
        boolean allow = isTrustedUrl(url);
        bridgeAllowed = allow;
        if (allow) {
            if (!bridgeAdded) {
                webView.addJavascriptInterface(bridge, BRIDGE_NAME);
                bridgeAdded = true;
            }
        } else if (bridgeAdded) {
            webView.removeJavascriptInterface(BRIDGE_NAME);
            bridgeAdded = false;
        }
    }

    private boolean isTrustedUrl(String url) {
        if (url == null) return false;
        if (url.startsWith(ASSET_BASE)) return true;
        if (url.startsWith("data:text/html")) return true;
        String hub = currentHub();
        if (hub.isEmpty()) return false;
        Uri target;
        try {
            target = Uri.parse(url);
        } catch (Exception e) {
            return false;
        }
        String scheme = target.getScheme();
        if (scheme == null) return false;
        scheme = scheme.toLowerCase(Locale.ROOT);
        if (!"http".equals(scheme) && !"https".equals(scheme)) return false;
        String targetHost = target.getHost();
        if (targetHost == null || targetHost.isEmpty()) return false;
        String hubHost = Uri.parse(hub).getHost();
        if (hubHost == null) return false;
        // 家庭内网：同一主机（允许 http/https 与端口变化，Hub 可能反代/跳转）
        return targetHost.equalsIgnoreCase(hubHost);
    }

    private boolean isHubHost(Uri uri) {
        if (uri == null) return false;
        String scheme = uri.getScheme();
        if (scheme == null) return false;
        scheme = scheme.toLowerCase(Locale.ROOT);
        if (!"http".equals(scheme) && !"https".equals(scheme)) return false;
        String host = uri.getHost();
        String hub = currentHub();
        if (host == null || hub.isEmpty()) return false;
        String hubHost = Uri.parse(hub).getHost();
        return hubHost != null && host.equalsIgnoreCase(hubHost);
    }

    private void openExternally(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception e) {
            Log.w(TAG, "no activity for " + uri.getScheme(), e);
            Toast.makeText(this, "无法打开链接", Toast.LENGTH_SHORT).show();
        }
    }

    // ------------------------------------------------------------------
    // 返回键
    // ------------------------------------------------------------------

    @Override
    public void onBackPressed() {
        if (showingError) {
            super.onBackPressed();
            return;
        }
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            try {
                webView.removeJavascriptInterface(BRIDGE_NAME);
                webView.stopLoading();
                webView.destroy();
            } catch (Exception e) {
                Log.w(TAG, "destroy webview failed", e);
            }
            webView = null;
        }
        super.onDestroy();
    }

    // ------------------------------------------------------------------
    // WebViewClient
    // ------------------------------------------------------------------

    private final class ButlerWebChromeClient extends WebChromeClient {

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> filePathCallback,
                                         FileChooserParams params) {
            if (pendingFileCallback != null) {
                pendingFileCallback.onReceiveValue(null);
            }
            pendingFileCallback = filePathCallback;
            Intent intent;
            try {
                intent = params.createIntent();
            } catch (Exception e) {
                intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
            }
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            intent.setType("*/*");
            try {
                startActivityForResult(intent, REQ_FILE_CHOOSER);
            } catch (Exception e) {
                pendingFileCallback = null;
                Toast.makeText(MainActivity.this, "无法打开文件选择器", Toast.LENGTH_SHORT).show();
                return false;
            }
            return true;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE_CHOOSER) {
            if (pendingFileCallback == null) return;
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                ClipData clip = data.getClipData();
                if (clip != null && clip.getItemCount() > 0) {
                    results = new Uri[clip.getItemCount()];
                    for (int i = 0; i < clip.getItemCount(); i++) {
                        results[i] = clip.getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    results = new Uri[]{data.getData()};
                }
            }
            pendingFileCallback.onReceiveValue(results);
            pendingFileCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    private final class ButlerWebViewClient extends WebViewClient {

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (uri == null) return true;
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            String url = uri.toString();
            if ("http".equals(scheme) || "https".equals(scheme)) {
                if (isHubHost(uri)) {
                    syncBridgeForUrl(url);
                    return false;
                }
                openExternally(uri);
                return true;
            }
            if ("file".equals(scheme) && url.startsWith(ASSET_BASE)) {
                syncBridgeForUrl(url);
                return false;
            }
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            super.onPageStarted(view, url, favicon);
            if (url != null) syncBridgeForUrl(url);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            if (pendingClearHistory) {
                pendingClearHistory = false;
                view.clearHistory();
            }
            // 从提醒通知打开：等管家页面加载完成后再切到提醒 tab（本地配置页/错误页不切）
            if (!showingError && url != null && !url.startsWith(ASSET_BASE)) {
                applyPendingOpenTab();
                applyTaskFilterDefault();
                applyTaskHintFix();
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request != null && request.isForMainFrame()) {
                String desc = error == null || error.getDescription() == null
                        ? "" : error.getDescription().toString();
                int code = error == null ? 0 : error.getErrorCode();
                showErrorPage("无法连接管家",
                        "网络错误（" + code + "）：" + desc + "\n" + shortUrl(request.getUrl()));
            }
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                        WebResourceResponse errorResponse) {
            if (request != null && request.isForMainFrame()
                    && errorResponse != null && errorResponse.getStatusCode() >= 400) {
                showErrorPage("请求被拒绝",
                        "HTTP " + errorResponse.getStatusCode() + " "
                                + safe(errorResponse.getReasonPhrase())
                                + "\n" + shortUrl(request.getUrl()));
            }
        }

        @Override
        public void onReceivedSslError(WebView view, android.webkit.SslErrorHandler handler,
                                       android.net.http.SslError error) {
            if (handler != null) handler.cancel();
            showErrorPage("HTTPS 证书错误",
                    "无法验证 Hub 的 TLS 证书。\n家庭内网请优先使用 http:// 地址，"
                            + "或为 Hub 配置受信任证书。\n"
                            + shortUrl(error == null ? null : Uri.parse(error.getUrl())));
        }
    }

    // ------------------------------------------------------------------
    // 任务通知（进度条 / 完成通知）
    // ------------------------------------------------------------------

    private NotificationManager notificationManager() {
        return getSystemService(NotificationManager.class);
    }

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = notificationManager();
        if (nm == null) return;
        NotificationChannel progress = new NotificationChannel(
                TASK_PROGRESS_CHANNEL, "BattleStar 任务进度", NotificationManager.IMPORTANCE_LOW);
        progress.setDescription("正在执行的任务进度（常驻通知栏）");
        progress.setShowBadge(false);
        NotificationChannel done = new NotificationChannel(
                TASK_DONE_CHANNEL, "BattleStar 任务完成", NotificationManager.IMPORTANCE_DEFAULT);
        done.setDescription("任务完成、失败或超时提醒");
        // 自主大脑需要主人决定：高优先级，通知栏直接展示可点选项
        NotificationChannel decision = new NotificationChannel(
                DECISION_CHANNEL, "BattleStar 管家决策", NotificationManager.IMPORTANCE_HIGH);
        decision.setDescription("自主大脑需要你决定时提醒，可直接在通知栏点选");
        nm.createNotificationChannel(progress);
        nm.createNotificationChannel(done);
        nm.createNotificationChannel(decision);
        // 提醒事项渠道：gentle（butler_reminders）+ alarm（butler_reminders_alarm），
        // Receiver/开机重排里也会确保创建（进程被杀后 Receiver 可能先于 Activity 运行）
        ReminderScheduler.ensureChannels(this);
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        try {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_POST_NOTIFICATIONS);
        } catch (Exception e) {
            Log.w(TAG, "request notification permission failed", e);
        }
    }

    private boolean notificationPermissionGranted() {
        if (Build.VERSION.SDK_INT < 33) return true;
        return checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private void startPersistentNotificationService() {
        try {
            Intent intent = new Intent(this, ButlerNotificationService.class);
            intent.setAction(ButlerNotificationService.ACTION_START);
            startForegroundService(intent);
        } catch (Exception e) {
            Log.w(TAG, "start persistent notification service failed", e);
        }
    }

    private void stopPersistentNotificationService() {
        try {
            stopService(new Intent(this, ButlerNotificationService.class));
        } catch (Exception e) {
            Log.w(TAG, "stop persistent notification service failed", e);
        }
    }

    private void applyPersistentNotification(boolean enabled) {
        prefs.edit().putBoolean(KEY_PERSISTENT_NOTIFY, enabled).apply();
        if (enabled) startPersistentNotificationService();
        else stopPersistentNotificationService();
    }

    private static String taskStatusLabel(String status) {
        if ("queued".equals(status)) return "排队中";
        if ("assigned".equals(status)) return "已派发";
        if ("running".equals(status)) return "执行中";
        if ("completed".equals(status)) return "任务完成";
        if ("failed".equals(status)) return "任务失败";
        if ("timeout".equals(status)) return "任务超时";
        if ("cancelled".equals(status)) return "已取消";
        return "任务进行中";
    }

    private static String truncateText(String text, int max) {
        String s = text == null ? "" : text.replace('\n', ' ').trim();
        return s.length() > max ? s.substring(0, max) + "…" : s;
    }

    private PendingIntent taskPendingIntent(int id) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, id, intent, flags);
    }

    /** 由 JS Bridge 调用；只更新本应用的任务通知，不影响其它通知。 */
    private void postTaskNotification(JSONObject obj, boolean finished) {
        try {
            if (Build.VERSION.SDK_INT >= 33
                    && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                return;
            }
            String taskId = obj.optString("id", "");
            if (taskId.isEmpty()) return;
            String status = obj.optString("status", "running");
            String instruction = obj.optString("instruction", "");
            String message = obj.optString("message", "");
            String device = obj.optString("device", "");
            int percent = obj.optInt("percent", -1);
            if (percent > 100) percent = 100;
            int notifyId = TASK_NOTIFY_BASE + (Math.abs(taskId.hashCode()) % 10000);
            String label = taskStatusLabel(status);
            String channel = finished ? TASK_DONE_CHANNEL : TASK_PROGRESS_CHANNEL;
            int icon = finished
                    ? ("completed".equals(status) ? android.R.drawable.stat_sys_download_done
                    : android.R.drawable.stat_notify_error)
                    : android.R.drawable.stat_sys_download;
            String detail = truncateText(instruction, 110);
            if (!device.isEmpty()) detail = detail + " · " + device;
            if (!message.isEmpty()) detail = detail + "\n" + truncateText(message, 110);

            Notification.Builder b = new Notification.Builder(this, channel)
                    .setSmallIcon(icon)
                    .setContentTitle("BattleStar · " + label)
                    .setContentText(truncateText(instruction, 90))
                    .setStyle(new Notification.BigTextStyle().bigText(detail))
                    .setContentIntent(taskPendingIntent(notifyId))
                    .setCategory(finished ? Notification.CATEGORY_STATUS : Notification.CATEGORY_PROGRESS)
                    .setVisibility(Notification.VISIBILITY_PUBLIC)
                    .setShowWhen(true)
                    .setWhen(System.currentTimeMillis());
            if (!finished) {
                b.setOngoing(true).setOnlyAlertOnce(true);
                if (percent >= 0) {
                    b.setProgress(100, percent, false).setSubText(percent + "%");
                } else {
                    b.setProgress(0, 0, true).setSubText("等待中…");
                }
            } else {
                b.setOngoing(false).setAutoCancel(true).setOnlyAlertOnce(false).setProgress(0, 0, false);
                if ("completed".equals(status)) b.setDefaults(Notification.DEFAULT_SOUND);
            }
            NotificationManager nm = notificationManager();
            if (nm != null) nm.notify(notifyId, b.build());
        } catch (Exception e) {
            Log.w(TAG, "postTaskNotification failed", e);
        }
    }

    // ------------------------------------------------------------------
    // JS Bridge（仅本地页面/同主机 Hub 页面可调用）
    // ------------------------------------------------------------------

    // 必须为 public：WebView 的 JavaBridge 通过反射调用 @JavascriptInterface 方法，
    // 非 public 内部类会让 Method.invoke 抛 IllegalAccessException。
    public final class Bridge {

        @JavascriptInterface
        public void copyText(String text) {
            if (!bridgeAllowed) return;
            final String value = text == null ? "" : text;
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    ClipboardManager manager = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                    if (manager != null) manager.setPrimaryClip(ClipData.newPlainText("BattleStar", value));
                }
            });
        }

        @JavascriptInterface
        public String getConfig() {
            JSONObject o = new JSONObject();
            try {
                String hub = prefs.getString(KEY_HUB, "");
                String token = prefs.getString(KEY_TOKEN, "");
                o.put("ok", true);
                o.put("configured", hub != null && !hub.isEmpty()
                        && token != null && !token.isEmpty());
                o.put("hubUrl", hub == null ? "" : hub);
                o.put("token", token == null ? "" : token);
                o.put("appVersion", APP_VERSION);
                int hubPort = 7317;
                try {
                    if (hub != null && !hub.isEmpty()) {
                        URL parsed = new URL(hub);
                        if (parsed.getPort() > 0) hubPort = parsed.getPort();
                    }
                } catch (Exception ignored) {
                    // keep default port
                }
                o.put("hubPort", hubPort);
            } catch (Exception e) {
                return errorJson("internal", "读取配置失败");
            }
            return o.toString();
        }

        @JavascriptInterface
        public String saveConfig(String hubUrl, String token) {
            if (!bridgeAllowed) return errorJson("forbidden", "仅允许在本地配置页调用");
            String base = normalizeHubUrl(hubUrl);
            String tk = token == null ? "" : token.trim();
            if (base == null) return errorJson("bad_url", "请输入有效的 http(s) Hub 地址，例如 http://192.168.1.10:7317");
            if (tk.isEmpty()) return errorJson("bad_token", "请输入管理员令牌");
            boolean saved = prefs.edit().putString(KEY_HUB, base).putString(KEY_TOKEN, tk).commit();
            if (!saved) return errorJson("internal", "配置保存失败");
            JSONObject o = new JSONObject();
            try {
                o.put("ok", true);
                o.put("hubUrl", base);
            } catch (Exception ignored) {
                return "{\"ok\":true}";
            }
            return o.toString();
        }

        @JavascriptInterface
        public String testConnection(String hubUrl, String token) {
            if (!bridgeAllowed) return errorJson("forbidden", "仅允许在本地配置页调用");
            String base = normalizeHubUrl(hubUrl);
            if (base == null) return errorJson("bad_url", "请输入有效的 http(s) Hub 地址");
            return testConnectionInternal(base, token == null ? "" : token.trim());
        }

        @JavascriptInterface
        public void clearConfig() {
            if (!bridgeAllowed) return;
            prefs.edit().clear().apply();
        }

        @JavascriptInterface
        public void openDashboard() {
            if (!bridgeAllowed) return;
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    loadDashboard();
                }
            });
        }

        @JavascriptInterface
        public void openSetup() {
            if (!bridgeAllowed) return;
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    prefs.edit().remove(KEY_HUB).remove(KEY_TOKEN).apply();
                    loadSetup();
                }
            });
        }

        @JavascriptInterface
        public String appVersion() {
            return APP_VERSION;
        }

        @JavascriptInterface
        public String startDiscovery(String port) {
            if (!bridgeAllowed) return errorJson("forbidden", "仅允许在本地配置页调用");
            int value = 7317;
            try {
                if (port != null && !port.trim().isEmpty()) value = Integer.parseInt(port.trim());
            } catch (Exception ignored) {
                value = 7317;
            }
            try {
                return hubDiscovery.start(value);
            } catch (Exception e) {
                return errorJson("internal", "启动局域网扫描失败");
            }
        }

        @JavascriptInterface
        public String getDiscovery() {
            if (!bridgeAllowed) return errorJson("forbidden", "仅允许在本地配置页调用");
            return hubDiscovery.snapshot();
        }

        @JavascriptInterface
        public void toast(String message) {
            if (!bridgeAllowed) return;
            final String msg = message == null ? ""
                    : (message.length() > 200 ? message.substring(0, 200) : message);
            if (msg.isEmpty()) return;
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public void taskProgress(String json) {
            if (!bridgeAllowed) return;
            try {
                postTaskNotification(new JSONObject(json), false);
            } catch (Exception e) {
                Log.w(TAG, "taskProgress bridge failed", e);
            }
        }

        @JavascriptInterface
        public void taskFinished(String json) {
            if (!bridgeAllowed) return;
            try {
                postTaskNotification(new JSONObject(json), true);
            } catch (Exception e) {
                Log.w(TAG, "taskFinished bridge failed", e);
            }
        }

        @JavascriptInterface
        public String getNotificationSettings() {
            JSONObject o = new JSONObject();
            try {
                o.put("ok", true);
                o.put("enabled", prefs.getBoolean(KEY_PERSISTENT_NOTIFY, false));
                o.put("permissionGranted", notificationPermissionGranted());
            } catch (Exception e) {
                return errorJson("internal", "读取通知设置失败");
            }
            return o.toString();
        }

        @JavascriptInterface
        public String setPersistentNotification(boolean enabled) {
            if (!bridgeAllowed) return errorJson("forbidden", "仅允许在管家页面调用");
            try {
                applyPersistentNotification(enabled);
                JSONObject o = new JSONObject();
                o.put("ok", true);
                o.put("enabled", enabled);
                o.put("permissionGranted", notificationPermissionGranted());
                return o.toString();
            } catch (Exception e) {
                return errorJson("internal", "设置常驻通知失败");
            }
        }

        /**
         * 页面把提醒全量同步给原生层：参数为 {@code {"reminders":[...]}}（也接受裸数组）。
         * 每项可带 {@code notifyStyle}（{@code gentle}/{@code alarm}，缺省 gentle）；未知字段原样保留在缓存里。
         * 原生层写入 SharedPreferences 缓存并重排 AlarmManager 闹钟；
         * 返回 {@code {ok,scheduled,total,permissionGranted,exact,channel,channels}}。
         */
        @JavascriptInterface
        public String syncReminders(String json) {
            if (!bridgeAllowed) return errorJson("forbidden", "仅允许在管家页面调用");
            JSONArray reminders;
            try {
                String raw = json == null ? "" : json.trim();
                if (raw.isEmpty()) {
                    reminders = new JSONArray();
                } else if (raw.startsWith("[")) {
                    reminders = new JSONArray(raw);
                } else {
                    JSONObject payload = new JSONObject(raw);
                    reminders = payload.optJSONArray("reminders");
                    if (reminders == null) reminders = payload.optJSONArray("items");
                    if (reminders == null) reminders = new JSONArray();
                }
            } catch (Exception e) {
                return errorJson("bad_json", "提醒数据格式错误");
            }
            // 页面首次同步提醒时顺便申请通知权限（必须回到 UI 线程）
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    requestNotificationPermissionIfNeeded();
                }
            });
            return ReminderScheduler.sync(MainActivity.this, reminders).toString();
        }

        /** 提醒能力状态：已排程数量、通知权限、精确闹钟是否可用、两个通知渠道。 */
        @JavascriptInterface
        public String getReminderStatus() {
            JSONObject o = new JSONObject();
            try {
                o.put("ok", true);
                o.put("scheduled", ReminderScheduler.countEnabled(MainActivity.this));
                o.put("permissionGranted", notificationPermissionGranted());
                o.put("exact", ReminderScheduler.exactAlarmsAvailable(MainActivity.this));
                o.put("channel", ReminderScheduler.CHANNEL_ID);
                o.put("alarmChannel", ReminderScheduler.CHANNEL_ID_ALARM);
                o.put("channels", ReminderScheduler.channelsJson());
                o.put("appVersion", APP_VERSION);
            } catch (Exception e) {
                return errorJson("internal", "读取提醒状态失败");
            }
            return o.toString();
        }
    }

    // ------------------------------------------------------------------
    // 网络探测（在 JS Bridge 线程执行，不阻塞 UI）
    // ------------------------------------------------------------------

    private String testConnectionInternal(String base, String token) {
        JSONObject out = new JSONObject();
        HttpURLConnection conn = null;
        try {
            URL url = new URL(base + "/api/health");
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(6000);
            conn.setReadTimeout(6000);
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Accept", "application/json");
            if (!token.isEmpty()) conn.setRequestProperty("X-Butler-Token", token);
            int code = conn.getResponseCode();
            InputStream is = (code >= 200 && code < 300) ? conn.getInputStream() : conn.getErrorStream();
            String body = readStream(is);
            String name = "";
            String version = "";
            int protocol = 0;
            String hubTime = "";
            try {
                JSONObject j = new JSONObject(body);
                name = j.optString("name", "");
                version = j.optString("version", "");
                protocol = j.optInt("protocol", 0);
                hubTime = j.optString("hubTime", "");
            } catch (Exception ignored) {
                // 非 JSON 响应：保留状态码信息即可
            }
            out.put("ok", code == 200);
            out.put("status", code);
            out.put("name", name);
            out.put("version", version);
            out.put("protocol", protocol);
            out.put("hubTime", hubTime);
            if (code != 200) {
                out.put("message", "HTTP " + code
                        + (code == 401 || code == 403 ? "（令牌无效或权限不足）" : ""));
                if (body != null && !body.isEmpty()) {
                    out.put("body", body.length() > 200 ? body.substring(0, 200) : body);
                }
            }
        } catch (Exception e) {
            try {
                out.put("ok", false);
                out.put("status", 0);
                out.put("message", e.getClass().getSimpleName() + ": " + safe(e.getMessage()));
            } catch (Exception ignored) {
                return "{\"ok\":false,\"status\":0,\"message\":\"连接失败\"}";
            }
        } finally {
            if (conn != null) conn.disconnect();
        }
        return out.toString();
    }

    private static String readStream(InputStream is) throws Exception {
        if (is == null) return "";
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = is.read(buf)) > 0) {
            bos.write(buf, 0, n);
            if (bos.size() > 256 * 1024) break;
        }
        is.close();
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }

    // ------------------------------------------------------------------
    // URL 校验
    // ------------------------------------------------------------------

    /** 规范化 Hub 地址：只接受 http(s)，去掉尾部 / 与查询串；非法返回 null。 */
    private static String normalizeHubUrl(String raw) {
        if (raw == null) return null;
        String s = raw.trim();
        if (s.isEmpty() || s.length() > 2048) return null;
        if (!s.matches("(?i)^[a-z][a-z0-9+.-]*://.*")) {
            s = "http://" + s;
        }
        Uri u;
        try {
            u = Uri.parse(s);
        } catch (Exception e) {
            return null;
        }
        String scheme = u.getScheme();
        if (scheme == null) return null;
        scheme = scheme.toLowerCase(Locale.ROOT);
        if (!"http".equals(scheme) && !"https".equals(scheme)) return null;
        String host = u.getHost();
        if (host == null || host.isEmpty()) return null;
        if (u.getUserInfo() != null) return null;
        StringBuilder sb = new StringBuilder();
        sb.append(scheme).append("://").append(host);
        int port = u.getPort();
        if (port > 0 && port <= 65535) sb.append(':').append(port);
        String path = u.getPath();
        if (path != null) {
            String trimmed = path;
            while (trimmed.endsWith("/")) {
                trimmed = trimmed.substring(0, trimmed.length() - 1);
            }
            if (!trimmed.isEmpty() && !"/".equals(trimmed)) sb.append(trimmed);
        }
        return sb.toString();
    }

    // ------------------------------------------------------------------
    // 本地错误页
    // ------------------------------------------------------------------

    private String buildErrorPage(String title, String detail) {
        String hub = currentHub();
        String hint = hub.isEmpty() ? "尚未配置 Hub 地址" : "当前 Hub：" + hub;
        StringBuilder sb = new StringBuilder(4096);
        sb.append("<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">")
          .append("<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">")
          .append("<title>连接失败</title><style>")
          .append(":root{color-scheme:dark}html,body{height:100%;margin:0}")
          .append("body{background:radial-gradient(120% 90% at 50% 0%,#2b1b63 0%,#171031 45%,#0b0818 100%);")
          .append("color:#f2efff;font-family:-apple-system,Roboto,'PingFang SC','Microsoft YaHei',sans-serif;")
          .append("display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}")
          .append(".card{width:100%;max-width:420px;background:rgba(255,255,255,.06);")
          .append("border:1px solid rgba(255,255,255,.12);border-radius:22px;padding:26px 22px;")
          .append("box-shadow:0 20px 60px rgba(0,0,0,.45);text-align:center;box-sizing:border-box}")
          .append(".logo{width:56px;height:56px;margin:0 auto 14px;border-radius:16px;")
          .append("background:linear-gradient(140deg,#7c5cff,#3c2a8c);display:flex;align-items:center;")
          .append("justify-content:center;font:700 30px Georgia,serif}")
          .append("h1{font-size:19px;margin:0 0 8px}")
          .append(".detail{font-size:13px;line-height:1.6;color:#c9c2ee;white-space:pre-wrap;")
          .append("word-break:break-all;background:rgba(0,0,0,.22);border-radius:12px;padding:12px;margin:12px 0 18px}")
          .append("button{width:100%;padding:13px;border:0;border-radius:12px;font-size:15px;font-weight:600;")
          .append("background:linear-gradient(135deg,#8b6bff,#6a4df0);color:#fff;margin-bottom:10px;cursor:pointer}")
          .append("button.ghost{background:transparent;border:1px solid rgba(255,255,255,.2);color:#dcd6ff}")
          .append(".hint{font-size:11px;color:#8f87b8;margin:10px 0 0;word-break:break-all}")
          .append("</style></head><body><div class=\"card\"><div class=\"logo\">S</div><h1>")
          .append(escapeHtml(title)).append("</h1><div class=\"detail\">")
          .append(escapeHtml(detail)).append("</div>")
          .append("<button onclick=\"retry()\">重试</button>")
          .append("<button class=\"ghost\" onclick=\"openSetup()\">修改 Hub 配置</button>")
          .append("<div class=\"hint\">").append(escapeHtml(hint)).append("</div></div>")
          .append("<script>function retry(){try{if(window.ButlerBridge){ButlerBridge.openDashboard();return;}}catch(e){}")
          .append("try{location.reload();}catch(e){}}")
          .append("function openSetup(){try{if(window.ButlerBridge){ButlerBridge.openSetup();}}catch(e){}}</script>")
          .append("</body></html>");
        return sb.toString();
    }

    private static String escapeHtml(String s) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder(s.length() + 16);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '&': sb.append("&amp;"); break;
                case '<': sb.append("&lt;"); break;
                case '>': sb.append("&gt;"); break;
                case '"': sb.append("&quot;"); break;
                case '\'': sb.append("&#39;"); break;
                default: sb.append(c);
            }
        }
        return sb.toString();
    }

    private static String shortUrl(Uri uri) {
        if (uri == null) return "";
        String s = uri.toString();
        return s.length() > 160 ? s.substring(0, 160) + "…" : s;
    }

    private static String safe(String s) {
        return s == null ? "" : s;
    }

    private static String errorJson(String code, String message) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", false);
            o.put("code", code);
            o.put("message", message);
        } catch (Exception ignored) {
            return "{\"ok\":false,\"code\":\"" + code + "\"}";
        }
        return o.toString();
    }
}
