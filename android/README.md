# 超级管家 Android APK（WebView 客户端）

纯 Java、无 Gradle / 无 Android Studio / 无 AndroidX 的 Android 客户端：首次启动配置 Hub 地址与管理员令牌，
之后直接加载 Hub 的手机控制台 `/m?token=<token>`。构建完全基于本地已下载的 Android 工具链，可离线重复执行。

- 包名：`com.superbutler.app`
- 版本：`versionCode 1` / `versionName 0.1.0`
- minSdk **26**（Android 8.0）/ targetSdk **36**
- 产物：`dist/SuperButler-0.1.0.apk`（约 **0.11 MB**，远低于 5 MB 目标）
- 任务通知：通知栏进度条、完成/失败提醒；设置中可开启**常驻通知**，空闲时显示在线/待命主机数

---

## 1. 产物与目录

```
android/
├─ AndroidManifest.xml          # 包名/版本/权限/主题/launcher activity
├─ build-apk.ps1                # 一键构建流水线（aapt2→javac→d8→jar→zipalign→apksigner）
├─ generate-icons.py            # 用 Pillow 生成 mipmap 图标与 dist/icon-512.png
├─ src/com/superbutler/app/
│  ├─ MainActivity.java         # WebView 宿主 + JS Bridge + 通知
│  └─ ButlerNotificationService.java  # 常驻通知前台服务（5s 轮询 Hub）
├─ assets/
│  └─ setup.html                # 首次启动的 Hub 配置页（品牌页 + 测试连接 + 保存）
├─ res/
│  ├─ values/{strings,colors,styles}.xml
│  ├─ drawable/bg_brand.xml     # 深蓝紫渐变启动背景
│  └─ mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png  (48/72/96/144/192)
├─ keystore/superbutler.keystore  # 测试签名密钥库（首次构建自动生成）
└─ build/                       # 中间产物（可删除，构建时重建）

dist/
├─ SuperButler-0.1.0.apk        # 可安装 APK
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

package: name='com.superbutler.app' versionCode='1' versionName='0.1.0' ... compileSdkVersion='36'
minSdkVersion:'26'
targetSdkVersion:'36'
uses-permission: name='android.permission.INTERNET'
application-label:'超级管家'
launchable-activity: name='com.superbutler.app.MainActivity'  label='超级管家'

Signer #1 certificate DN: CN=Super Butler, OU=Home Lab, O=Super Butler, L=KL, C=MY
Signer #1 certificate SHA-256 digest: 45658ac253be038ab8dc6da60a99743afc7a3a5ac9c6b04d9f498cb7f914bb5a

APK : dist\SuperButler-0.1.0.apk
大小: 115636 bytes (0.11 MB)    # 上限目标 5 MB
```

APK 关键条目（`jar tf dist/SuperButler-0.1.0.apk`）：

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

对齐校验：`zipalign -c -v 4 dist\SuperButler-0.1.0.apk` → `Verification successful`。

> 每次重新构建 APK 的 SHA-256 可能不同（zip 时间戳/签名块），以 `build-apk.ps1` 末尾打印的值为准。

## 5. 安装与使用

APK 在本目录 `dist/SuperButler-0.1.0.apk`。安装方式（任选其一）：

```powershell
# 手机开启「开发者选项 → USB 调试」并连接后：
adb devices
adb install -r "dist\SuperButler-0.1.0.apk"
```

- 也可以把 APK 拷到手机（微信/网盘/数据线）直接点击安装，需允许「安装未知来源应用」。
- 构建机当前没有可用 adb 设备（`adb` 不在 PATH，无设备连接），因此本次只做了静态校验，未在真机安装运行。

首次启动流程：

1. 打开「超级管家」，显示品牌配置页 `assets/setup.html`（深蓝紫主题）。
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
  混合内容 `MIXED_CONTENT_ALWAYS_ALLOW`、自定义 UA 追加 `SuperButlerApp/0.1.0`。
- **JS Bridge**（对象名 `ButlerBridge`）：`getConfig` / `saveConfig` / `clearConfig` / `openDashboard` /
  `openSetup` / `appVersion` / `toast` / `testConnection`。
  - 仅在**本地 assets 页面**与**已配置 Hub 同主机页面**注入：`addJavascriptInterface` 前用
    `syncBridgeForUrl()` 判断并启停；页面切换时 `onPageStarted` 再次校正。
  - 每个方法内部再次检查 `bridgeAllowed`，非受信页面调用一律拒绝。
  - Hub 地址只接受 `http(s)`，拒绝 `javascript:`/`file:`/带 userinfo 的 URL、长度上限 2048；
    测试连接只请求 `<hub>/api/health`。
- **导航安全**：仅 Hub 同主机的 http(s) 在 WebView 内加载；其他 http(s) 链接交给系统浏览器；
  其余 scheme（`javascript:`、`intent:`、`file:` 等）直接拦截。
- **错误页**：`onReceivedError` / `onReceivedHttpError` / `onReceivedSslError` 触发本地内联错误页
  （深蓝紫卡片 + 重试 + 修改配置），按钮同样通过 Bridge 回调。
- **edge-to-edge**：targetSdk 36 在 Android 15+ 强制 edge-to-edge，代码按系统栏 insets 给根布局加内边距。
- **返回键**：`android:enableOnBackInvokedCallback="false"` 显式关闭预测性返回，保证 `onBackPressed` 生效。
- **主题**：`android:Theme.Material.NoActionBar`，窗口背景深蓝紫渐变（`bg_brand.xml`），无 ActionBar。
- **图标**：Pillow 生成深蓝紫渐变圆角方块 + 白色衬线「S」+ 光晕/细描边，5 档 mipmap 自动按 LANCZOS 缩放，
  另出 `dist/icon-512.png` 展示图。

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
- **WebView 内核版本取决于系统**：Android 8 的设备内核较旧（Chrome 60+），`setup.html` 已避免使用更新语法
  （仅 async/await 级别的 ES2017；`URL` 构造器 Android 4.4+ 已支持）。
- **未覆盖任务边界外的文件**：本目录只涉及 `android/**`、`dist/**`、`toolchain/**`。

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
