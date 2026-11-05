# Android APK：安装、使用与构建

产物：`dist/SuperButler-0.1.0.apk`（111,540 bytes，约 0.11 MB）
包名：`com.superbutler.app` · minSdk 26（Android 8.0+）· targetSdk 36 · versionName 0.1.0

App 是一个轻量原生 WebView 壳：首次启动配置 Hub 地址与管理员令牌，之后直接加载 Hub 的手机控制台 `/m?token=...`。
所有设备/任务/指令功能都在 Hub 的 Web 控制台里，APK 负责安全保存配置、免 CORS 测试连接与快速进入。

---

## 1. 安装

### 方式 A：adb（推荐调试）

```bash
adb devices
adb install -r dist/SuperButler-0.1.0.apk
```

### 方式 B：手机直接安装

1. 把 APK 传到手机（微信文件传输 / 数据线 / 局域网 HTTP）。
2. 点击安装，系统提示「未知来源应用」时允许该来源。
3. 若手机安装过不同签名的旧测试包，先卸载旧版再安装（签名不同无法覆盖，卸载会清空应用配置）。

> 本 APK 使用**测试签名**（`android/keystore/superbutler.keystore`，alias/pass 均为 `superbutler`），
> 仅适合家庭内网自用；正式分发请替换为自己的发布签名并妥善保管 keystore。

## 2. 首次使用

1. 确保手机与 Hub 在同一 Wi-Fi / 内网（或已加入 Tailscale 等虚拟内网）。
2. 打开「超级管家」，填写：
   - **Hub 地址**：`http://<Hub 内网 IP>:7317`，例如 `http://192.168.1.10:7317`
   - **管理员令牌**：Hub 启动日志里的「管理员令牌」（形如 `adm_...`）
3. 点「测试连接」——通过原生 `HttpURLConnection` 请求 `GET /api/health`，不依赖浏览器 CORS。
4. 点「保存并进入」→ WebView 加载 `<hub>/m?token=<token>`。

之后每次启动自动直连。加载失败会显示本地错误页，可「重试」或「修改配置」。
应用内「设置 → 退出连接」会清除本机保存的地址与令牌。

> Hub 地址必须是手机能直接访问的地址：不要填 `127.0.0.1`（那是手机自己）；
> Windows 防火墙首次运行需允许「专用网络」。

## 3. 功能

- **状态**：在线/离线设备、负载、最后心跳、models / profiles / gateways / skills 能力标签。
- **指令**：输入自然语言指令，可选要求（模型 / 技能 / 目标设备 / 优先级 / 超时），发送后显示路由到哪台设备及原因；无匹配时显示排队与排除原因。
- **任务**：实时进度、输出、事件时间线、取消/重试。
- **实时**：SSE 推送，断线自动重连；不可用时降级 5 秒轮询。

## 4. 从源码构建

构建不依赖 Gradle / Android Studio / AndroidX，用 JDK + Android build-tools 手工流水线。

### 4.1 工具链

需要：

- **JDK 17**（Temurin 17 已验证：`jdk-17.0.21+9`）
- **Android build-tools 36.0.0**（`aapt2`、`d8`、`zipalign`、`apksigner`）
- **Android platform android-36**（`android.jar`）
- 可选：Python + Pillow（重新生成图标）

目录布局（可用环境变量 `BUTLER_TOOLCHAIN` 指向别处）：

```
toolchain/
├─ jdk/                              # JAVA_HOME 指向这里
├─ android-sdk/
│  ├─ build-tools/36.0.0/
│  └─ platforms/android-36/android.jar
└─ downloads/                        # 原始 zip（可保留）
```

下载参考（本机已验证可用）：

```powershell
# Temurin JDK 17 (Windows x64)
curl.exe -L -o toolchain/downloads/jdk17.zip "https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse"
# Android build-tools 36 + platform 36
curl.exe -L -o toolchain/downloads/build-tools_r36-windows.zip "https://dl.google.com/android/repository/build-tools_r36-windows.zip"
curl.exe -L -o toolchain/downloads/platform-36_r02.zip "https://dl.google.com/android/repository/platform-36_r02.zip"
```

解压后按上面布局重命名（build-tools 压缩包内顶层目录名可能是 `android-16`，platform 是 `android-36`）。

### 4.2 一键构建

```powershell
cd super-butler
powershell -ExecutionPolicy Bypass -File android\build-apk.ps1
```

脚本会：`aapt2 compile` → `aapt2 link` → `javac` → `d8` → `jar` 写入 `classes.dex` → `zipalign` → `apksigner sign`，
输出 `dist/SuperButler-0.1.0.apk`，并打印 badging、签名校验与大小。首次运行会自动生成测试 keystore。

可选参数：

```powershell
powershell -ExecutionPolicy Bypass -File android\build-apk.ps1 `
  -ToolchainDir "D:\android-toolchain" `
  -PythonExe "C:\Python311\python.exe"
```

图标单独重新生成：

```powershell
python android\generate-icons.py
```

> 构建脚本保存为 UTF-8 with BOM（Windows PowerShell 5.1 解析中文必需）。若另存为无 BOM，请用 `pwsh` 运行。

### 4.3 校验

```powershell
# 包名 / 版本 / SDK / launcher
toolchain\android-sdk\build-tools\36.0.0\aapt2.exe dump badging dist\SuperButler-0.1.0.apk

# 签名
toolchain\jdk\bin\java.exe -jar toolchain\android-sdk\build-tools\36.0.0\lib\apksigner.jar verify --print-certs --verbose dist\SuperButler-0.1.0.apk

# 对齐
toolchain\android-sdk\build-tools\36.0.0\zipalign.exe -c -v 4 dist\SuperButler-0.1.0.apk
```

本机实测（2026-11-05）：

| 检查 | 结果 |
| --- | --- |
| package / version | `com.superbutler.app` / versionCode 1 / versionName 0.1.0 |
| minSdk / targetSdk | 26 / 36 |
| INTERNET / cleartext / exported | 均正确 |
| apksigner verify | v1/v2/v3 有效 |
| zipalign | Verification successful |
| 体积 | 111,540 bytes |

## 5. 实现说明

- 单 Activity + WebView，纯 Java（无 Kotlin/AndroidX）。
- 首启加载 `file:///android_asset/setup.html`；配置保存到应用私有 `SharedPreferences`。
- JS Bridge：`getConfig / saveConfig / clearConfig / openDashboard / openSetup / testConnection / appVersion / toast`；
  只在本地配置页与「已配置 Hub 的同主机页面」注入，方法内部再次校验来源，URL 仅接受 http(s)。
- 测试连接走原生 `HttpURLConnection`，避免 `file://` → `http://` 的 CORS 问题。
- WebView 开启 JS / DOM storage / 宽视口 / mixed content；UA 追加 `SuperButlerApp/0.1.0`。
- 错误页（加载失败）提供「重试 / 修改配置」；返回键可后退则后退，否则退出。
- targetSdk 36 已做 Android 15+ edge-to-edge insets 适配。

## 6. 故障排查

| 现象 | 处理 |
| --- | --- |
| 安装失败 `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | 手机上有不同签名的旧包，先卸载再装 |
| 测试连接失败 | Hub IP/端口不对；手机与 Hub 不同网段；Windows 防火墙未放行 7317 |
| 页面一直加载失败 | 用手机浏览器直接打开 `http://<hub>:7317/m?token=<token>` 排查网络；确认 Hub 在运行 |
| 页面能开但提示 401 | 令牌错误或已重置（Hub 删除 state.json 后令牌会变），在 App「设置」里更新令牌 |
| 页面功能正常但没有设备 | 设备代理未启动/加入码错误；到 Hub 控制台检查设备在线状态 |
| 杀进程后无法覆盖安装 | 用同一 keystore 重新构建（`android/keystore/` 不要丢失） |

## 7. 已知限制

- 自签名/私有 CA 的 HTTPS 会被 WebView 拒绝；家庭内网建议直接用 http（APK 已允许 cleartext）。
- 无推送通知、离线缓存、下拉刷新、自适应图标、扫码配对（v1 范围）。
- 无 AndroidX，UI 依赖系统 Material 主题。
- 本机无 Android 真机/模拟器，仅完成静态校验与代码审查；首次真机安装后建议按第 2 节点验一遍。
