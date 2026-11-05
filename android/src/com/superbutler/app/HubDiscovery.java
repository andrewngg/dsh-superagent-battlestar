package com.superbutler.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Enumeration;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/**
 * 局域网 Hub 自动发现：对每个本机 IPv4 /24 网段的 1..254 扫描指定端口的 /api/health。
 * 只要求手机与母机在同一 Wi-Fi/热点；不会访问公网，也不需要管理员令牌。
 */
public class HubDiscovery {

    private static final int DEFAULT_PORT = 7317;
    private static final int THREADS = 32;
    private static final int CONNECT_TIMEOUT_MS = 450;
    private static final int READ_TIMEOUT_MS = 700;

    private volatile boolean running = false;
    private volatile int port = DEFAULT_PORT;
    private volatile int scanned = 0;
    private volatile String error = "";
    private final List<JSONObject> results = new CopyOnWriteArrayList<>();

    public synchronized String start(int requestedPort) {
        if (running) return snapshot();
        results.clear();
        scanned = 0;
        error = "";
        port = requestedPort > 0 && requestedPort <= 65535 ? requestedPort : DEFAULT_PORT;
        running = true;
        Thread thread = new Thread(new Runnable() {
            @Override
            public void run() {
                scan();
            }
        }, "hub-discovery");
        thread.setDaemon(true);
        thread.start();
        return snapshot();
    }

    public String snapshot() {
        JSONObject out = new JSONObject();
        try {
            out.put("ok", true);
            out.put("running", running);
            out.put("port", port);
            out.put("scanned", scanned);
            out.put("error", error);
            JSONArray array = new JSONArray();
            for (JSONObject item : results) array.put(item);
            out.put("results", array);
        } catch (Exception e) {
            return "{\"ok\":false,\"message\":\"发现状态读取失败\"}";
        }
        return out.toString();
    }

    private void scan() {
        try {
            List<String> targets = localTargets();
            if (targets.isEmpty()) {
                error = "未检测到局域网 IPv4 地址，请确认手机已连接 Wi-Fi/热点";
                return;
            }
            List<Callable<JSONObject>> tasks = new ArrayList<>();
            for (final String ip : targets) {
                tasks.add(new Callable<JSONObject>() {
                    @Override
                    public JSONObject call() {
                        return probe(ip);
                    }
                });
            }
            ExecutorService pool = Executors.newFixedThreadPool(THREADS);
            try {
                List<Future<JSONObject>> futures = pool.invokeAll(tasks, 20, TimeUnit.SECONDS);
                for (Future<JSONObject> future : futures) {
                    scanned += 1;
                    try {
                        if (!future.isCancelled() && future.get() != null) results.add(future.get());
                    } catch (Exception ignored) {
                        // 单个地址失败不影响整体扫描
                    }
                }
            } finally {
                pool.shutdownNow();
            }
            Collections.sort(results, new Comparator<JSONObject>() {
                @Override
                public int compare(JSONObject a, JSONObject b) {
                    return a.optString("ip", "").compareTo(b.optString("ip", ""));
                }
            });
            if (results.isEmpty()) error = "未发现 Hub，请确认母机已启动、端口正确且在同一局域网";
        } catch (Exception e) {
            error = "扫描失败：" + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
        } finally {
            running = false;
        }
    }

    private List<String> localTargets() throws Exception {
        Set<String> targets = new LinkedHashSet<>();
        Set<String> own = new LinkedHashSet<>();
        Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
        while (interfaces != null && interfaces.hasMoreElements()) {
            NetworkInterface nif = interfaces.nextElement();
            try {
                if (!nif.isUp() || nif.isLoopback()) continue;
            } catch (Exception ignored) {
                continue;
            }
            Enumeration<InetAddress> addresses = nif.getInetAddresses();
            while (addresses.hasMoreElements()) {
                InetAddress address = addresses.nextElement();
                if (!(address instanceof Inet4Address)) continue;
                String host = address.getHostAddress();
                if (host == null || host.startsWith("127.") || host.startsWith("169.254.")) continue;
                String[] parts = host.split("\\.");
                if (parts.length != 4) continue;
                own.add(host);
                String prefix = parts[0] + "." + parts[1] + "." + parts[2] + ".";
                for (int i = 1; i <= 254; i++) targets.add(prefix + i);
            }
        }
        targets.removeAll(own);
        return new ArrayList<>(targets);
    }

    private JSONObject probe(String ip) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL("http://" + ip + ":" + port + "/api/health");
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Accept", "application/json");
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) return null;
            String body = readStream(conn.getInputStream());
            JSONObject health = new JSONObject(body);
            if (!health.optBoolean("ok", false)) return null;
            int protocol = health.optInt("protocol", 0);
            if (protocol <= 0) return null;
            JSONObject item = new JSONObject();
            item.put("ip", ip);
            item.put("url", "http://" + ip + ":" + port);
            item.put("name", health.optString("name", "BattleStar"));
            item.put("version", health.optString("version", ""));
            item.put("protocol", protocol);
            return item;
        } catch (Exception e) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String readStream(InputStream input) throws Exception {
        if (input == null) return "";
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[2048];
        int read;
        while ((read = input.read(buffer)) >= 0) out.write(buffer, 0, read);
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }
}
