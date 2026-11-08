# BattleStar Android APK（WebView 客户端）

纯 Java、无 Gradle / 无 Android Studio / 无 AndroidX 的 Android 客户端：首次启动自动扫描局域网 Hub，
之后直接加载 Hub 的手机控制台 `/m?token=<token>`。构建完全基于本地已下载的 Android 工具链，可离线重复执行。

- 包名：`com.superbutler.app`
- 名称：**BattleStar**
- 版本：`versionCode 4` / `versionName 0.1.3`
- minSdk **26**（Android 8.0）/ targetSdk **36**
- 产物：`dist/BattleStar-0.1.3.apk`（约 **0.12 MB**，远低于 5 MB 目标）
- 自动发现：扫描当前 Wi-Fi `/24` 的 7317 端口，找到 Hub 后只填令牌
- 任务通知：通知栏进度条、完成/失败提醒；设置中可开启**常驻通知**，空闲时显示在线/待命主机数
- 提醒通知：原生 `AlarmManager` 精确/非精确闹钟 + `BroadcastReceiver`，App 被杀后仍能到点弹通知并回写 Hub
- 任务页默认筛选：打开「任务」时默认选中「进行中」（APK 与浏览器控制台一致；用户仍可手动切到其它筛选）

---

## 1. 产物与目录

```
android/
├─ AndroidManifest.xml          # 包名/版本/权限/主题/launcher activity
├─ build-apk.ps1                # 一键构建流水线（aapt2→javac→d8→jar→zipalign→apksigner）
├─ generate-icons.py            # 用 Pillow 生成 mipmap 图标与 dist/icon-512.png
├─ src/com/superbutler/app/
│  ├─ MainActivity.java         # WebView 宿主 + JS Bridge + 通知
│  ├─ ButlerNotificationService.java  # 常驻通知前台服务（5s 轮询 Hub）
│  ├─ ReminderScheduler.java    # 提醒缓存（SharedPreferences）+ AlarmManager 排程
│  ├─ ReminderReceiver.java     # 提醒到点：弹通知 → 推进下次时间 → POST 回写 Hub
│  ├─ BootReceiver.java         # 开机 / 应用更新后从本地缓存重排提醒
│  └─ HubDiscovery.java         # 局域网 Hub 自动发现（7317 端口扫描）
├─ assets/
│  └─ setup.html                # 首次启动的 Hub 配置页（品牌页 + 测试连接 + 保存）
├─ res/
│  ├─ values/{strings,colors,styles}.xml
│  ├─ drawable/bg_brand.xml     # 深蓝紫渐变启动背景
│  └─ mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png  (48/72/96/144/192)
├─ keystore/superbutler.keystore  # 测试签名密钥库（首次构建自动生成）
└─ build/                       # 中间产物（可删除，构建时重建）

dist/
├─ BattleStar-0.1.3.apk        # 可安装 APK
└─ icon-512.png                 # 512×512 商店/展示图
```

## 2. 工具链布局

构建脚本按以下结构定位工具（可用环境变量 `BUTLER_TOOLCHAIN` 指到别处，默认 `..\toolchain`）：

```
toolchain/
├─ jdk/                                   # Temurin JDK 17.0.21+9
│  └─ bin/{java,javac,jar,keytool}.exe
└─ android-sdk/
   ├─ build-tools/36.0.0/                 # aapt2.exe / zipalign.exe / dexdump.exe
   │  └─ lib/{d8.jar, apksigner.jar}
   └─ platforms/android-36/android.jar
```

> 本仓库的 `toolchain/downloads/*.zip` 解压后顶层目录分别为 `jdk-17.0.21+9`、`android-16`
> （内容为 build-tools 36.0.0）、`android-36`。规范化时只需把这 3 个目录移动为上面的布局，
> 不要重复解压或下载：
>
> ```powershell
> $tc = "$PWD\toolchain"
> Move-Item "$tc\extract-jdk\jdk-17.0.21+9"        "$tc\jdk"
> New-Item -ItemType Directory -Force "$tc\android-sdk\build-tools" | Out-Null
> Move-Item "$tc\extract-buildtools\android-16"     "$tc\android-sdk\build-tools\36.0.0"
> New-Item -ItemType Directory -Force "$tc\android-sdk\platforms" | Out-Null
> Move-Item "$tc\extract-platform\android-36"       "$tc\android-sdk\platforms\android-36"
> ```

已验证版本：Java `17.0.21`、aapt2 `2.20-13193326`、D8 `8.10.9`、apksigner `0.9`、Pillow `12.3.0`。
`build-apk.ps1` 已保存为 **UTF-8 with BOM**（Windows PowerShell 5.1 解析中文所必需）；本机已分别用
`powershell.exe`（5.1）与 `pwsh`（7）各跑通一次。若用编辑器另存为「UTF-8 无 BOM」，请改用 `pwsh` 运行或重新加 BOM。

## 3. 构建

```powershell
cd "C:\path\to\super-butler"
powershell -ExecutionPolicy Bypass -File android\build-apk.ps1
```

可选参数：

```powershell
# 工具链不在默认位置 / 指定用于生成图标的 Python（需 Pillow）
powershell -ExecutionPolicy Bypass -File android\build-apk.ps1 `
  -ToolchainDir "D:\android-toolchain" `
  -PythonExe "C:\Python311\python.exe"
```

脚本步骤（可重复执行，每步失败即抛错退出）：

1. 定位工具链（`jdk/`、`android-sdk/build-tools/36.0.0/`、`android-sdk/platforms/android-36/android.jar`）
2. 检查 5 档 `ic_launcher.png`；缺失时调用 `generate-icons.py`（Pillow）补齐
3. 清理 `android/build/`
4. `aapt2 compile --dir res -o build/res.zip`
5. `aapt2 link ... --min-sdk-version 26 --target-sdk-version 36` → 未签名 APK + `build/gen/**/R.java`
6. `javac -source 8 -target 8 -bootclasspath android.jar` → `build/classes/`
7. `d8 --release --min-api 26 --lib android.jar --output build/dex` → `classes.dex`
8. `jar uf app-unsigned.apk classes.dex`（JDK 自带 jar 把 dex 写入 APK 根）
9. `zipalign -f 4` → `apksigner sign`（keystore 不存在时用 `keytool` 生成）→ 复制到 `dist/`

图标可单独重新生成：

```powershell
& "C:\path\to\python.exe" android\generate-icons.py
```

## 4. 构建输出摘要（本机实测）

```
JDK          : ...\super-butler\toolchain\jdk
Build-Tools  : ...\super-butler\toolchain\android-sdk\build-tools\36.0.0
Platform JAR : ...\super-butler\toolchain\android-sdk\platforms\android-36\android.jar

package: name='com.superbutler.app' versionCode='4' versionName='0.1.3' ... compileSdkVersion='36'
minSdkVersion:'26'
targetSdkVersion:'36'
uses-permission: name='android.permission.INTERNET'
uses-permission: name='android.permission.POST_NOTIFICATIONS'
uses-permission: name='android.permission.FOREGROUND_SERVICE'
uses-permission: name='android.permission.FOREGROUND_SERVICE_DATA_SYNC'
uses-permission: name='android.permission.RECEIVE_BOOT_COMPLETED'
uses-permission: name='android.permission.SCHEDULE_EXACT_ALARM'
application-label:'BattleStar'
launchable-activity: name='com.superbutler.app.MainActivity'  label='BattleStar'

Signer #1 certificate DN: CN=Super Butler, OU=Home Lab, O=Super Butler, L=KL, C=MY
Signer #1 certificate SHA-256 digest: 45658ac253be038ab8dc6da60a99743afc7a3a5ac9c6b04d9f498cb7f914bb5a

APK : dist\BattleStar-0.1.3.apk
大小: 127923 bytes (0.12 MB)    # 上限目标 5 MB
```

APK 关键条目（`jar tf dist/BattleStar-0.1.3.apk`）：

```
AndroidManifest.xml
res/drawable/bg_brand.xml
res/mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}-v4/ic_launcher.png
resources.arsc
assets/setup.html
classes.dex
META-INF/{MANIFEST.MF,SUPERBUT.SF,SUPERBUT.RSA}
```

签名校验（`apksigner verify -v`）：

```
Verifies
Verified using v1 scheme (JAR signing): true   # minSdk 26 时默认只校验 v2/v3，用 --min-sdk-version 23 可看到 v1=true
Verified using v2 scheme (APK Signature Scheme v2): true
Verified using v3 scheme (APK Signature Scheme v3): true
```

对齐校验：`zipalign -c -v 4 dist\BattleStar-0.1.3.apk` → `Verification successful`。

> 每次重新构建 APK 的 SHA-256 可能不同（zip 时间戳/签名块），以 `build-apk.ps1` 末尾打印的值为准。
>
> 清单校验：`aapt2 dump xmltree --file AndroidManifest.xml dist\BattleStar-0.1.3.apk` 中可见
> `.ReminderReceiver` 与 `.BootReceiver` 均声明为 `exported="false"`，并带 `BOOT_COMPLETED` /
> `MY_PACKAGE_REPLACED` intent-filter。

## 5. 安装与使用

APK 在本目录 `dist/BattleStar-0.1.3.apk`。安装方式（任选其一）：

```powershell
# 手机开启「开发者选项 → USB 调试」并连接后：
adb devices
adb install -r "dist\BattleStar-0.1.3.apk"
```

- 也可以把 APK 拷到手机（微信/网盘/数据线）直接点击安装，需允许「安装未知来源应用」。
- 构建机当前没有可用 adb 设备（`adb` 不在 PATH，无设备连接），因此本次只做了静态校验，未在真机安装运行。

首次启动流程：

1. 打开「BattleStar」，显示品牌配置页 `assets/setup.html`（深蓝紫主题）。
2. 填写 Hub 地址（提示 `http://192.168.1.10:7317`，省略 `http://` 会自动补全）与管理员令牌。
3. 点「测试连接」：通过 **JS Bridge + 原生 HttpURLConnection** 请求 `GET <hub>/api/health`（不依赖 CORS），
   成功提示 Hub 名称 / 版本 / 协议版本；失败提示 HTTP 状态或网络错误。
4. 点「保存并进入」：写入应用私有 `SharedPreferences`（`butler_config`），随后 WebView 加载
   `<hub>/m?token=<token>`。
5. 之后每次启动若已有配置，直接进入控制台；加载失败（断网、Hub 未启动、令牌错误、证书错误）会显示
   本地错误页，可「重试」或「修改 Hub 配置」。
6. 返回键：WebView 可后退则后退，否则退出；长按/双击返回等额外手势未实现（可选需求）。

## 6. 实现要点

- **WebView 配置**：JS、DOM storage、database、宽视口（`useWideViewPort` + `loadWithOverviewMode`）、
  混合内容 `MIXED_CONTENT_ALWAYS_ALLOW`、自定义 UA 追加 `SuperButlerApp/0.1.3`。
- **JS Bridge**（对象名 `ButlerBridge`）：`getConfig` / `saveConfig` / `clearConfig` / `openDashboard` /
  `openSetup` / `appVersion` / `toast` / `testConnection` / `setPersistentNotification` /
  `syncReminders(json)` / `getReminderStatus()`。
  - 仅在**本地 assets 页面**与**已配置 Hub 同主机页面**注入：`addJavascriptInterface` 前用
    `syncBridgeForUrl()` 判断并启停；页面切换时 `onPageStarted` 再次校正。
  - 每个方法内部再次检查 `bridgeAllowed`，非受信页面调用一律拒绝。
  - Hub 地址只接受 `http(s)`，拒绝 `javascript:`/`file:`/带 userinfo 的 URL、长度上限 2048；
    测试连接只请求 `<hub>/api/health`。
- **导航安全**：仅 Hub 同主机的 http(s) 在 WebView 内加载；其他 http(s) 链接交给系统浏览器；
  其余 scheme（`javascript:`、`intent:`、`file:` 等）直接拦截。
- **任务页默认筛选（APK 兜底）**：新版控制台本身已默认「进行中」（`hub/web/assets/app.js` 的
  `state.taskFilter = 'active'` 与 `index.html` 初始 `is-active` chip）。APK 仍保留一段兜底注入：
  `onPageFinished` 后若 `#task-filters .filter-chip[data-filter="active"]` 未选中就 `chip.click()`，
  用于兼容仍默认「全部」的旧版 Hub 页面；页面尚未就绪/未找到时最多重试 8 次（每次 400ms）。
  筛选状态只存在于当前 WebView 页面会话，重开 App / 刷新会重新应用；用户手动切换筛选照常生效。
  相关常量在 `MainActivity.TASK_FILTER_DEFAULT_JS`。
- **错误页**：`onReceivedError` / `onReceivedHttpError` / `onReceivedSslError` 触发本地内联错误页
  （深蓝紫卡片 + 重试 + 修改配置），按钮同样通过 Bridge 回调。
- **edge-to-edge**：targetSdk 36 在 Android 15+ 强制 edge-to-edge，代码按系统栏 insets 给根布局加内边距。
- **返回键**：`android:enableOnBackInvokedCallback="false"` 显式关闭预测性返回，保证 `onBackPressed` 生效。
- **主题**：`android:Theme.Material.NoActionBar`，窗口背景深蓝紫渐变（`bg_brand.xml`），无 ActionBar。
- **图标**：Pillow 生成深蓝紫渐变圆角方块 + 白色衬线「S」+ 光晕/细描边，5 档 mipmap 自动按 LANCZOS 缩放，
  另出 `dist/icon-512.png` 展示图。

### 提醒通知（AlarmManager + BroadcastReceiver）

提醒事项（`title` / `note` / `dueAt` / `repeat` / `enabled`）由 Hub 管理，**通知只在 APK 内发出**（浏览器没有
`ButlerBridge`），因此原生层独立承担排程与到点通知：

- **两种通知方式**（每条提醒的 `notifyStyle`，缺省 `gentle`；渠道创建后属性不可变，因此拆成两个渠道）：
  - `gentle` → `butler_reminders`：`IMPORTANCE_HIGH`，系统默认提示音 + 普通震动，温和的日常提醒；
  - `alarm` → `butler_reminders_alarm`：`IMPORTANCE_HIGH`，`AudioAttributes` 使用 **USAGE_ALARM** 闹钟音频流、
    长震动模式、通知 `CATEGORY_ALARM`，响亮如闹钟，适合重要事项（受系统勿扰/媒体音量影响，见第 8 节）。
  两个渠道都与任务通知 `butler_task_progress` / `butler_task_done` 分开，用户可单独静音/关闭。
- **本地缓存**：`ReminderScheduler` 把整份提醒数组写入 `SharedPreferences`（`butler_reminders` / `items`），
  开机或 App 重建后无需联网即可恢复排程。`sync()` 为全量同步：先取消旧闹钟，再按新列表重排，
  已删除/已禁用的提醒不会残留。
- **排程**：每条启用且 `dueAt` 有效的提醒注册一个显式 `PendingIntent.getBroadcast`（指向 `ReminderReceiver`）。
  `requestCode` / 通知 id 用 `7500 + |id.hashCode()| % 400` 的稳定映射（带线性探测去重），避开任务通知的
  7300 段与常驻通知的 7400，重复同步或重启后 id 不变。
- **精确闹钟**：`AlarmManager.canScheduleExactAlarms()` 为 true 时用 `setExactAndAllowWhileIdle`，
  否则回退 `setAndAllowWhileIdle`（Doze 下可能延迟数分钟，且系统可能批量合并）。见第 8 节已知限制。
- **App 被杀后仍生效**：排程在系统 `AlarmManager` 中，不依赖 WebView 或前台服务存活；到点由
  `ReminderReceiver`（`exported="false"`，只接受应用内显式广播）接管。
- **到点处理**（`ReminderReceiver`，`goAsync()` + 后台线程）：
  1. 按该提醒缓存里的 `notifyStyle` 选渠道与 category（`alarm` → `butler_reminders_alarm` + `CATEGORY_ALARM`；
     其余 → `butler_reminders` + `CATEGORY_REMINDER`）发高优先级通知（标题 + 备注，点击打开 App 并带
     `open_tab=reminders`，尝试切到页面「提醒」tab）；Receiver 可能在 App 进程被杀后独立启动，因此两个渠道都会在此确保创建；
  2. `repeat=daily` 时把 `dueAt` 推进 1 天、`weekly` 推进 7 天，循环直到晚于当前时间；
     `repeat=none` 则标记 `enabled=false`；
  3. 按新状态重排该提醒的下一次闹钟（并持久化缓存）；
  4. `POST /api/reminders/:id/fire`（`X-Butler-Token`，body `{"firedAt": ISO}`）回写 Hub，
     Hub 侧据此更新 `lastFiredAt` / `fireCount` 并在重复提醒时把 `dueAt` 对齐到下一次；
     网络失败**静默忽略**，等下次 snapshot 轮询/同步校正（以 Hub 为准）。
- **开机/更新重排**：`BootReceiver`（`exported="false"`）监听 `BOOT_COMPLETED` 与 `MY_PACKAGE_REPLACED`，
  从 `SharedPreferences` 缓存重排全部闹钟；通知渠道也在此确保创建（部分系统重启后渠道配置会重置）。
- **同步入口（三路兜底）**：
  - WebView 页面加载/增删改后调用 `window.ButlerBridge.syncReminders(json)`（JSON 为
    `{"reminders":[...]}` 或裸数组；每项可带 `notifyStyle`，未知字段原样保留在缓存中），原生写缓存并重排，返回
    `{ok,scheduled,total,permissionGranted,exact,channel,channels}`（`channels` 为
    `{"gentle":"butler_reminders","alarm":"butler_reminders_alarm"}`）；`getReminderStatus()` 可查询当前状态
    （含 `alarmChannel` 与 `channels`）；
  - App 回前台（`onResume`）主动 `GET /api/reminders` 后同步一次；
  - 常驻通知前台服务每次轮询 `/api/snapshot` 时读取其中的 `reminders` 数组同步（未开启常驻通知则退化为前两路）。
- **权限**：
  - `POST_NOTIFICATIONS`（Android 13+ 运行时权限，首次同步提醒时会触发申请；未授权时只排程、不弹通知）；
  - `RECEIVE_BOOT_COMPLETED`（开机重排）；
  - `SCHEDULE_EXACT_ALARM`（Android 12+ 特殊权限，用户可在系统设置中撤销；撤销后自动走非精确闹钟）。
  - 闹钟方式（`notifyStyle=alarm`）使用 `USAGE_ALARM` 音频流，仍受系统勿扰模式、闹钟音量与「请勿打扰」例外名单影响；
    若渠道被用户关闭或通知权限被拒绝，则到点不显示通知（排程与回写 Hub 仍照常）。
  两个 Receiver 均为 `exported="false"`，不暴露给其他应用。

## 7. 签名说明

- 构建脚本首次运行会生成测试密钥库（之后复用，不覆盖）：
  - 文件：`android/keystore/superbutler.keystore`（PKCS12，JDK 17 默认格式）
  - alias：`superbutler`，storepass / keypass：`superbutler`
  - `CN=Super Butler, OU=Home Lab, O=Super Butler, L=KL, C=MY`，RSA 2048，有效期 10000 天
- **该密钥库仅供家庭内网测试/覆盖安装使用**，口令公开，不能用于应用商店或真实分发；
  正式发布请用 `keytool` 生成新 keystore，并把 `build-apk.ps1` 中的 `$Keystore` / 口令 / alias 改为新值。
- 签名方案：v1 + v2 + v3（minSdk 26 设备实际使用 v2/v3 校验）。证书指纹见上一节。
- 安装包未做混淆/压缩优化（无 ProGuard/R8 shrink），本身体积已远小于 5 MB。

## 8. 已知限制

- **无 Gradle / Android Studio / AndroidX**：纯手工流水线，缺少依赖管理、AAPT2 daemon、增量编译等；
  首次构建约数秒，属预期。
- **未在真机/模拟器实际运行**（构建机无 adb 设备）：已验证编译、打包、签名、清单/资源/dex 与 HTML 静态正确性，
  但 WebView 运行期行为（返回键、错误页、Bridge 注入时序）仍需在真机点验。
- **HTTPS 自签名证书不被接受**：`onReceivedSslError` 直接取消并展示错误页。家庭内网请用 `http://`；
  若 Hub 上 TLS，需配置系统信任的证书。
- **明文 HTTP**：为家用 LAN 场景显式开启 `usesCleartextTraffic="true"`，请勿把 Hub 端口暴露到公网。
- **令牌暴露面**：管理员令牌按协议 §5.6 放在 `/m?token=` 查询串中，可能出现在 WebView 历史/日志；
  同时明文存于应用私有 `SharedPreferences`（协议 §9 约定）。请勿截图分享含 token 的 URL。
- **Bridge 信任边界按「同主机」判定**（而非严格同 scheme+port），以兼容 http↔https 跳转/反代；
  风险范围为家庭 LAN 内同主机页面。
- **无下拉刷新 / 无自适应图标 / 无多语言**：需求中列为可选项，未实现。刷新可通过重新进入控制台或页面内操作完成。
- **提醒通知依赖系统闹钟调度**：App 被杀、设备重启后仍会生效（`AlarmManager` + `BOOT_COMPLETED` 重排），
  但**精确闹钟权限 `SCHEDULE_EXACT_ALARM` 可被用户/系统撤销**（Android 12+ 默认按应用类别授予），
  撤销后自动回退 `setAndAllowWhileIdle`：Doze 深度休眠下可能延迟数分钟，系统也可能合并相邻闹钟。
  需要严格准点时请在系统设置「闹钟和提醒」中授予该应用精确闹钟权限。
- **闹钟方式的声音受限**：`notifyStyle=alarm` 用 `USAGE_ALARM` 音频流 + 长震动，但系统勿扰模式、静音/闹钟音量、
  「闹钟和提醒」例外名单、以及用户对 `butler_reminders_alarm` 渠道的单独设置都会影响实际响铃；渠道创建后属性不可变，
  如日后要调音效/震动需换新渠道 id。
- **通知权限被拒绝时不弹提醒**：Android 13+ 的 `POST_NOTIFICATIONS` 为运行时权限，拒绝后闹钟仍会排程、
  到点仍会推进下次时间并回写 Hub，只是不显示通知；可在系统设置中重新授予。
- **提醒以 Hub 为准**：本地 `SharedPreferences` 只是缓存。若在 Hub 上修改/删除提醒而 App 长时间离线，
  本地可能按旧数据触发一次；下次 snapshot 轮询或页面同步后自动校正。
- **WebView 内核版本取决于系统**：Android 8 的设备内核较旧（Chrome 60+），`setup.html` 已避免使用更新语法
  （仅 async/await 级别的 ES2017；`URL` 构造器 Android 4.4+ 已支持）。
- **任务页默认筛选依赖控制台 DOM**：Web 控制台默认「进行中」由 `hub/web/assets/app.js` 的 `state.taskFilter`
  与 `index.html` 的初始 `is-active` chip 决定；APK 注入仅对旧版 Hub 页面兜底。若控制台改版调整了筛选按钮的
  id/属性，注入会失效（旧版 Hub 页面回退默认「全部」，新版控制台不受影响），需要同步更新
  `MainActivity.TASK_FILTER_DEFAULT_JS`。
- **未覆盖任务边界外的文件**：本次默认筛选改动涉及 `hub/web/assets/app.js`、`hub/web/index.html`
  以及 `android/**`、`dist/**`、`toolchain/**`。

## 9. 故障排查

| 现象 | 处理 |
| --- | --- |
| `找不到 JDK` / `找不到 Android build-tools` | 检查 `toolchain/` 是否已规范化为第 2 节布局，或设 `BUTLER_TOOLCHAIN` |
| `未找到带 Pillow 的 Python` | 传 `-PythonExe <python.exe>`，或先手工运行 `generate-icons.py` 生成图标 |
| `badging 校验失败` | 确认 `AndroidManifest.xml` 中 `package`/`versionCode`/`versionName`/`minSdk`/`targetSdk` 未被改动 |
| `apksigner verify 失败` | 删除 `android/keystore/superbutler.keystore` 后重跑（会重新生成测试签名） |
| 安装时提示「签名不一致」 | 手机上已装的是不同签名版本，先 `adb uninstall com.superbutler.app` 再安装 |
| App 打开一直显示配置页 | 正常（还没有配置），填写 Hub 地址与令牌即可 |
| App 显示「无法连接管家」 | 确认手机与 Hub 同一局域网、Hub 已启动、地址/端口正确，可点「修改 Hub 配置」 |
| 提醒到点没有通知 | 检查通知权限（Android 13+ 需授予「通知」）、对应通知方式渠道（`butler_reminders` 温和 / `butler_reminders_alarm` 闹钟）是否被关闭；通知权限拒绝时仍会到点并回写 Hub，只是不显示 |
| 提醒比设定时间晚几分钟 | 精确闹钟权限 `SCHEDULE_EXACT_ALARM` 被撤销，已回退非精确闹钟；在系统设置「闹钟和提醒」中授予后可恢复准点 |
| 重启手机后提醒没有恢复 | 确认系统未限制应用自启动；打开 App 一次（或常驻通知服务运行中）会重新拉取 Hub 并重排 |
| 在 Hub 删除的提醒本机还弹了一次 | 本地缓存尚未同步；打开 App 或等常驻服务轮询 snapshot 后自动校正 |
