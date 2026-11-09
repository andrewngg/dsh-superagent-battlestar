# 事件记录：Android 15 前台服务超时导致 BattleStar 闪退

- 日期：2026-11-10
- 状态：已修复，已实机验证
- 影响版本：0.1.0 – 0.1.2（开启「常驻通知」时必现，约 6 小时后触发）
- 修复版本：0.1.3（versionCode 4）
- 复现设备：Infinix X6852，Android 15 / SDK 35，AP3A.240905.015.A2

## 1. 现象

BattleStar 在后台运行一段时间后**整个进程消失**，通知栏常驻通知也跟着没了，需要用手机重新打开 App 才恢复；没有 ANR，也没有 OOM。用户侧表现为“用着用着就崩了 / 后台莫名退出”。

## 2. 现场证据（adb）

安装信息：`versionName=0.1.2`、`versionCode=3`、targetSdk 36、minSdk 26，`lastUpdateTime=2026-11-08 21:51:01`。

崩溃进程已不在，`dumpsys activity services com.superbutler.app` 返回 `(nothing)`。

`adb logcat -b crash -d` 最近一次崩溃（2026-11-10 03:58:29.942，pid 7770）：

```
FATAL EXCEPTION: main
Process: com.superbutler.app, PID: 7770
android.app.RemoteServiceException$ForegroundServiceDidNotStopInTimeException: A foreground service of type dataSync did not stop within its timeout: ComponentInfo{com.superbutler.app/com.superbutler.app.ButlerNotificationService}
	at android.app.ActivityThread.generateForegroundServiceDidNotStopInTimeException(ActivityThread.java:2420)
	at android.app.ActivityThread.throwRemoteServiceException(ActivityThread.java:2382)
	at android.app.ActivityThread$H.handleMessage(ActivityThread.java:2707)
Caused by: android.app.StackTrace: Last startServiceCommon() call for this service was made here
	at android.app.ContextImpl.startServiceCommon(ContextImpl.java:2164)
	at android.app.ContextImpl.startForegroundService(ContextImpl.java:2108)
	at com.superbutler.app.MainActivity.startPersistentNotificationService(MainActivity.java:572)
	at com.superbutler.app.MainActivity.onCreate(MainActivity.java:114)
```

`adb shell dumpsys activity exit-info com.superbutler.app`：

```
timestamp=2026-11-10 03:58:30.142 pid=7770
process=com.superbutler.app reason=4 (APP CRASH(EXCEPTION)) subreason=0 (UNKNOWN) description=crash
```

`adb shell dumpsys dropbox --print` 里还有一条同因历史崩溃，说明不是偶发：

- 2026-11-08 06:17:51.333，0.1.0，`MainActivity.java:467` / `:111`
- 2026-11-10 03:58:30.064，0.1.2，`MainActivity.java:572` / `:114`

（两份 crash archive 的 Crash-Handler 均为 `org.chromium.base.JavaExceptionReporter`，Process-Runtime 约 20.6 小时，符合“后台常驻很久后触发”。）

## 3. 根因

`ButlerNotificationService`（「常驻通知」）做了三件事叠加在一起：

1. Manifest 里声明 `android:foregroundServiceType="dataSync"`；
2. 启动即 `startForeground()`，然后 worker 线程每 5 秒轮询一次 Hub `/api/snapshot`，**从不停自身**（`START_STICKY`，只有用户关闭开关才会 stop）；
3. 没有覆写 `onTimeout()`。

Android 15 对 `dataSync` 类型前台服务实施 **6 小时 / 24 小时** 运行上限（`mediaProcessing` 同理；`specialUse` 等类型没有该限制）。累计运行到上限后，系统回调 `Service.onTimeout()`；App 未在宽限期内停止服务，系统直接向进程抛 `RemoteServiceException$ForegroundServiceDidNotStopInTimeException`，进程被杀死，而且不会被自动拉起——所以 BattleStar 一旦崩过就一直处于“死掉”状态，直到用户再次打开。

0.1.2 之前每个版本都命中同一个文件，只是因为需要后台常驻约 6 小时才触发，所以看起来像“偶发闪退”。

## 4. 修复（0.1.3）

- `android/AndroidManifest.xml`
  - 新增 `<uses-permission android:name="android.permission.FOREGROUND_SERVICE_SPECIAL_USE" />`；
  - 服务改为 `android:foregroundServiceType="dataSync|specialUse"`，并声明子节点
    `<property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="BattleStar 常驻状态通知：本地轮询家庭 Hub 快照，展示任务进度与在线/待命设备数" />`。
- `android/src/com/superbutler/app/ButlerNotificationService.java`
  - `startForegroundCompat()`：SDK ≥ 34 用 `FOREGROUND_SERVICE_TYPE_SPECIAL_USE`（无 6 小时上限）；SDK 29–33 没有该常量且旧系统无超时限制，回退 `DATA_SYNC`；更早版本走无类型 `startForeground()`。
  - 新增 `onTimeout(int startId, int fgsType)` 兜底：记日志、置 `running=false`、`stopSelf()`。即使系统真的触发超时，也只是优雅停止服务并移除常驻通知，不再杀进程。
- 保留提醒/任务等其余行为不变；`dataSync` 权限仍保留，用于 Android 10–13 的运行时回退。

## 5. 构建与验证

构建（仓库自带工具链，无需 Gradle）：

```powershell
cd super-butler
powershell -ExecutionPolicy Bypass -File android\build-apk.ps1
```

产物：`dist/BattleStar-0.1.3.apk`，127,923 bytes，SHA256 `47FC088B5499BC65E3CFCF006C34DB9A9CC99DC40F2EF55DE14342A61E1DED62`；与已安装版本同签（测试 keystore），`adb install -r` 覆盖安装保留本地配置。

静态检查：

- `aapt2 dump badging`：versionCode 4 / versionName 0.1.3，含 `FOREGROUND_SERVICE_SPECIAL_USE` 权限与 `PROPERTY_SPECIAL_USE_FGS_SUBTYPE`；
- `aapt2 dump xmltree`：service `foregroundServiceType=0x40000001`（dataSync|specialUse）；
- `zipalign -c -v 4`：Verification successful；`apksigner verify --print-certs`：v1/v2/v3 有效。

实机验证（安装后启动 App，再按 Home 退到后台）：

- `dumpsys package`：versionName=0.1.3 / versionCode=4；
- `dumpsys activity services com.superbutler.app`：
  `isForeground=true foregroundId=7400 types=0x40000000`——运行时类型已是 `specialUse`（0x40000000），不是 `dataSync`；
- 常驻通知存在（channel `butler_persistent`，标题「BattleStar · 待命中」）；
- 退到后台后进程 pid 不变、服务仍在前台，`logcat -b crash` 无新记录，`exit-info` 最新仍为 03:58 的旧崩溃。

**验证局限**：6 小时超时无法现场模拟（需后台常驻约 6 小时）。判断依据是系统异常语义、`specialUse` 不受该超时约束、以及运行时类型已切换为 `specialUse`。

## 6. 后续建议

- 让手机上的 0.1.3 跑满 24 小时观察：不应该再出现此前“约 6 小时后闪退”的现象；若仍闪退，用下面命令复查。
- 若日后上架 Google Play，`specialUse` 类型需要在 Play Console 提交使用说明（本项目家用内网侧载，不受影响）。
- 排查备忘：
  ```bash
  adb logcat -b crash -d | grep -i "ForegroundService\|DidNotStop"
  adb shell dumpsys activity services com.superbutler.app | grep -E "isForeground|foregroundServiceType"
  adb shell dumpsys activity exit-info com.superbutler.app
  ```
