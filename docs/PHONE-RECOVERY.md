# 手机 Mika 失效恢复手册（USB ADB）

> **一句话结论：手机桥在线 ≠ 手机可控，`connection=ok` 也不代表能给手机派活。**
> 手机上真正决定「Mika 能不能操作 App」的是两件事：**无障碍服务已启用并绑定**、**手机助手（`:helper`）在跑**。
> 这两样任何一个失效，任务都会报 `phone_unavailable` / `NO_ACCESSIBILITY` / `NO_PHONE_HELPER`。
> 本文件讲的就是：怎么用母机的 USB ADB 把这两样恢复回来，以及设备代理如何**自动**做这件事并继续原任务。

本手册配套内容：

- 设备代理内建自愈：`device-agent\lib\mika-recovery.js`（**唯一实现**）+ `device-agent\lib\executors.js`（Mika 执行器接入）
- 手工/运维 CLI：`scripts\mika-phone-recovery.js`（`node` 直接跑，与代理共用同一份逻辑）
- 旧入口（保留兼容）：`scripts\restore-mika-phone.ps1`（薄包装，转发给上面的 Node CLI，修完再跑 `mika connect` + `doctor` 验收）
- 接入/配置/发任务： [MIKA-PHONE.md](MIKA-PHONE.md)

实测环境（2026-11-18）：Windows 11 + Windows PowerShell 5.1 / pwsh 7，adb 37.0.1，Node v24.4.0，
Python 3.14.6，手机（OPPO / ColorOS / Android 12 一类的国内 ROM），Mika APK `server_version=0.1.37`。

---

## 1. 先判断：到底是哪一层坏了

「手机工作机」不是手机上的 agent，而是**母机上的 Mika 桥**（`worker-workspace\phone-mika.json`，
`executor.type=mika`）。链路是：

```
管家 Hub → 母机上的设备代理 → mika CLI → USB ADB → 手机上的 Mika → 无障碍/手机助手 → 后台操作 App
```

按顺序看四个信号：

| 信号 | 怎么取 | 含义 |
| --- | --- | --- |
| 桥进程在线 | 管家设备列表 / `start-workers.ps1` 窗口 | 代理没挂，但任务仍可能失败 |
| CLI 连接可用 | `mika doctor --json` 的 `connection` | `ok` 才说明能读到 Mika 的本地连接信息（`mcp-usb.json`） |
| 手机可执行 | `device_state.device.ready` | `true` 才说明屏幕/锁屏状态允许 Mika 干活 |
| **手机控制通道** | `device_state.device.helper_available` | `true` 才说明**手机助手在跑**；CLI 看不到无障碍状态，需用 ADB 查 |

一句话：**`connection` 失败优先查休眠/锁屏/Mika 进程；`ready=false` 优先查锁屏；
任务报 `NO_PHONE_HELPER`/`NO_ACCESSIBILITY` 优先跑本手册的自检。**

---

## 2. 自检：8 个检查项

跑一遍只读自检（不改手机）：

```powershell
# 在仓库根目录；adb 在 PATH 里可以省略 --adb，否则指向自己的 platform-tools\adb.exe
node .\scripts\mika-phone-recovery.js --check `
  --adb "C:\path\to\platform-tools\adb.exe" `
  --serial <手机序列号>
```

输出示例（健康）：

```
[ OK ] adb 连接：设备在线
[ OK ] 无障碍总开关：accessibility_enabled=1
[ OK ] 无障碍服务在列表里：...
[ OK ] 无障碍服务未崩溃：Crashed services 里没有它
[ OK ] 无障碍服务已绑定：Bound services 里有 Mika
[ OK ] 手机助手（Mika 操作 App 的通道）：运行中 pid=5298
[ OK ] Mika App 进程：pid=18269
[ OK ] 无线调试：关着（…）（参考项）
```

| # | 检查 id | 读的是什么 | 失败说明 |
| --- | --- | --- | --- |
| 1 | `adb` | `adb devices` | 线/授权/端口问题；`adb-no-device` / `device-offline` / `adb-error` |
| 2 | `a11y-master-off` | `settings get secure accessibility_enabled` | 无障碍**总开关被系统关掉**（ColorOS 休眠/更新后常见）→ Mika 无法读屏/点按 |
| 3 | `service-not-listed` | `settings get secure enabled_accessibility_services` | 列表里没有 Mika 服务（可能被用户或系统停用） |
| 4 | `service-crashed` | `dumpsys accessibility` 的 `Crashed services` | 服务崩溃过、被系统标记，**不会自己恢复绑定** |
| 5 | `service-not-bound` | `dumpsys accessibility` 的 `Bound services` | 服务在列表里但没绑定（`EnabledNotRunning`）→ 同样不可用 |
| 6 | `helper-not-running` | `pidof <包名>:helper` | **手机助手没跑**：Mika 打不开手机上的 App（`NO_PHONE_HELPER`） |
| 7 | `app-not-running` | `pidof <包名>` | App 进程没在（参考项：任务时会自动拉起） |
| 8 | `wireless-debugging-off` | `settings get global adb_wifi_enabled` | 参考项，见 §7；USB 直连模式不影响 |

要点：

- **短形式/全名都认**：`com.wangzan101.mika/.a11y.MikaAccessibilityService` 与
  `com.wangzan101.mika/com.wangzan101.mika.a11y.MikaAccessibilityService` 是同一个组件，
  自检会先归一化再比较（Mika 自己也这么做：`AccessibilityList.expand()`）。
- **不要用界面文案判状态**：服务详情页修复后仍可能残留「此服务出现故障。」，以 settings/dumpsys 为准。
- `dumpsys accessibility` 的 `Bound services` 条目只有 `label=Mika`，没有组件名 → 绑定判定用 label。
- 总开关读出来是 `null` 表示从未设置过，等价于关。

退出码：`0` 全通过；`2` 有故障；`1` 参数错误。

---

## 3. 修复：`--repair` 做了什么

```powershell
node .\scripts\mika-phone-recovery.js --repair --adb <adb路径> --serial <序列号>
# 自检已通过也想强制重来一遍（例如怀疑绑定是假活）：
node .\scripts\mika-phone-recovery.js --repair --force --adb <adb路径> --serial <序列号>
```

修复顺序与依据（全部照 Mika 自己的恢复语义，见 §3.1）：

1. **先自检**；健康且没加 `--force` 直接退出 0，不动手机。
2. `wake`：`input keyevent 224` + `wm dismiss-keyguard`（安全锁屏解不开，见 §10）。
3. `battery-whitelist`：`cmd deviceidle whitelist` 里没有就 `+<包名>`（防休眠被杀）。
4. `grant-secure-settings`：`pm grant <包名> android.permission.WRITE_SECURE_SETTINGS`（best-effort；
   ColorOS 上**必失败**，见 §3.2，失败不致命）。
5. **无障碍修复**（仅当第 2–5 项有任何失败）：
   - 先试 `repairBySettings`：需要重绑时「先摘掉再放回」——`enabled_accessibility_services` 去掉 Mika、
     等 `rebindGapMs`（默认 700ms）、再写回，最后 `accessibility_enabled=1`。
   - 写设置被系统拒绝（`SecurityException: Permission denial ... WRITE_SECURE_SETTINGS`）→
     **改走系统设置界面自动化** `repairByUi`：`am start -a android.settings.ACCESSIBILITY_SETTINGS` →
     `uiautomator dump` 找 Mika 行 → 点进服务详情页 → 若开关是开着的先关掉并确认「停止」（清掉崩溃标记）→
     再打开 → 用 `settings`/`dumpsys` 复验。
6. `launch`：`monkey -p <包名> -c android.intent.category.LAUNCHER 1`，失败回退
   `cmd package resolve-activity --brief` + `am start -n <组件>`。
7. **手机助手**（`helper-not-running` 时）：`adb shell sh /sdcard/Android/data/<包名>/files/usb-start.sh`
   → 按 Mika 的三态文案判定（`Mika helper starting...` / `already running` / `did not start`）→
   复查 `pidof <包名>:helper`。脚本缺失/口令过期时 `am force-stop` 冷启动 App（App 会重写脚本）后重试，最多 3 次。
8. 终验：再跑一遍自检，全绿才算修好。

每一步都会打印（`--repair` 时）：

```
[步骤] helper-start-1 ...
```

### 3.1 为什么是这几步（Mika 自己的「指导」）

| 现象 | Mika 内部对应 | 出处 |
| --- | --- | --- |
| 无障碍总开关关 | `AccessibilityState.Off` → 建议 `TurnOnAccessibility` | `app/src/main/java/com/wangzan101/mika/selfcheck/AndroidSelfCheck.kt:130` |
| 服务在列表却没绑定 | `EnabledNotRunning` → 建议 `RestartAccessibility` | 同上 `:131` |
| 服务没连上 | `Advice.RestartAccessibility` | 同上 `:194` |
| 任务缺无障碍 | `throw PhoneUnavailable(NO_ACCESSIBILITY)` | `app/src/main/java/com/wangzan101/mika/task/TaskRun.kt:585` |
| 任务缺手机助手 | `throw PhoneUnavailable(NO_PHONE_HELPER / NO_PHONE_HELPER_USB)` | 同上 `:579` |
| 重绑语义 | 不在列表就加入；在列表却没绑定 → 摘掉、等、再放回 | `core/src/main/kotlin/com/wangzan101/mika/core/shell/RecoveryPermissions.kt`（`restartAccessibility`） |
| 电池白名单 | `cmd deviceidle whitelist +<包名>` | 同上（`RecoveryCapability.BatteryWhitelist`） |
| 手机助手怎么拉 | `adb shell sh .../usb-start.sh` 拉 `app_process` 起 `<包名>:helper` | `core/src/main/kotlin/com/wangzan101/mika/core/shell/HelperHandoff.kt` |

App 内「设置 › 恢复与修复」的四个开关（无障碍 / 电池白名单 / 重启后恢复 / 自动开无线调试）默认都开着；
它们要生效依赖 Mika 自己有写安全设置权限，而本机没有（见下）。

### 3.2 本机的两个硬限制（ColorOS）

1. **adb shell 不能写安全设置**：`settings put secure ...` 报
   `java.lang.SecurityException: Permission denial: writing to settings requires:android.permission.WRITE_SECURE_SETTINGS`；
   `settings put system ...` 报 `com.android.shell was not granted  this permission: android.permission.WRITE_SETTINGS.`；
   `pm grant` 报 `grantRuntimePermission: Neither user 2000 nor current process has android.permission.GRANT_RUNTIME_PERMISSIONS`。
   **虽然** `dumpsys package com.android.shell` 里这几个权限显示 `granted=true`——这是 ColorOS 的额外权限监控/
   「USB 调试(安全设置)」开关没开导致的，属设备安全策略，自动流程**不去改它**（会削弱设备安全，需人工决定）。
2. **因此无障碍修复必须有 UI 自动化兜底**；只靠 `settings put` 的旧版脚本在本机必然失败。

可用且流程依赖的能力：`input keyevent/tap/swipe`、`uiautomator dump` + `cat`、`am start`、
`monkey`、`cmd deviceidle whitelist`、`dumpsys`、`sh <usb-start.sh>`。

---

## 4. 修复后验收

1. `node .\scripts\mika-phone-recovery.js --check` 全绿（退出码 0）。
2. 刷新连接信息 + 端到端验收（`restore-mika-phone.ps1 -Restore` 会自动做这两步）：

```powershell
py -3 .\worker-workspace\Mika\tools\mika\scripts\mika_cli.py --device <序列号> --adb <adb路径> --json connect
py -3 .\worker-workspace\Mika\tools\mika\scripts\mika_cli.py --device <序列号> --adb <adb路径> --json doctor
```

`doctor` 健康输出（2026-11-18 实测）：

```json
{"connection":"ok","transport":"adb","device":"<序列号>","api_version":1,
 "device_state":{"status":"state","enabled":false,"credential_configured":false,"attempt_blocked":false,
 "device":{"interactive":true,"keyguard_showing":false,"device_locked":false,"secure":false,
 "helper_available":true,"user_unlocked":true,"ready":true}},
 "model_configuration":"unverified"}
```

- `state.enabled=false`、`credential_configured=false` → Mika 的远程亮屏/解锁默认关闭，**不是故障**。
- `device_locked=true` / `keyguard_showing=true` / `ready=false` → 锁屏了，见 §10。
- **`doctor` 只证明连接，不证明能操作 App**：无障碍坏了 `connection` 仍是 `ok`。所以第 1 步的自检不能省。

3. 真机小任务验收（无副作用）：

```powershell
$goal = New-TemporaryFile
'现在手机上是几点？直接读手机时间回答。' | Set-Content -Encoding utf8 $goal
py -3 .\worker-workspace\Mika\tools\mika\scripts\mika_cli.py --device <序列号> --adb <adb路径> --json `
  task run --goal-file $goal
# 拿到 task_id 后轮询（--timeout 允许 1..50 秒）：
py -3 .\worker-workspace\Mika\tools\mika\scripts\mika_cli.py --device <序列号> --adb <adb路径> --json `
  task wait <task_id> --timeout 45
```

`status:"done"` 且 `answer` 有实际内容 = 手机控制链路真的通了。

---

## 5. 设备代理的自愈（自动修、修完继续原任务）

`super-butler` 的设备代理在**派发 Mika 任务时自动做上面这些事**，不需要人工介入：

| 时机 | 行为 |
| --- | --- |
| 派发前 preflight | `recovery.diagnose()` **发现无障碍不健康**（总开关/列表/崩溃/绑定）→ 先自愈再派发（进度里可见「先自愈再派发」）。只有手机助手没跑时不提前修：实测本机不少任务在无助手时仍能跑完（Mika 退化到纯无障碍操作），提前拉起要多花十几秒，留到真失败再修 |
| 派发前连接预检 | `connectPreflight`（默认开启，需配 `adb`）：把指令发给手机之前，先在母机侧跑一次 `mika connect`（进度「正在通过母机 ADB 检查并修复 Mika 连接…」）。报 `bootstrap did not complete / Unlock the phone` 时先唤醒 + 拉起 Mika 再试一次；仍失败则**不把指令发到手机**，任务直接失败并提示「Mika 连接未就绪（已在母机执行 ADB 修复仍失败…）；本次指令没有发送到手机，请解锁手机并打开 Mika 后重试」 |
| 任务报手机类错误 | 命中 `phone_unavailable` / `NO_ACCESSIBILITY` / `NO_PHONE_HELPER` / `UsbHelperStopped` / `stale_connection` / `connection_info` / `connection`（CLI 报 `Could not read a valid response from Mika; … run mika connect` 也属于这类）/ `adb_unavailable` / `device_offline` 等 → 自愈（此时连同手机助手一起修）→ `mika connect` 刷新连接信息 → **重试一次原任务** |
| 刷新连接时被息屏/锁屏挡住 | `mika connect` 报 `Mika's phone bootstrap did not complete. Unlock the phone, open Mika once, then retry connect.` → 先 `wake`（唤醒屏幕 + 解除 keyguard）并拉起 Mika，再 `mika connect` 一次；仍失败则进度提示「请解锁手机并保持 Mika 在前台」。有 PIN/图案锁时 adb 解不开，仍需人工解锁（§10） |
| 自愈后仍失败 | 原错误追加「（已通过 USB ADB 自愈并重试 N 次仍失败；可运行 `node scripts/mika-phone-recovery.js --check` 查看手机状态）」 |
| 没配 `adb` | 不启用 adb 自愈；若 CLI 仍配置了 `--adb`（例如 `recovery.enabled=false`），连接类错误会先 `mika connect` 刷新一次再重试；纯 Wi-Fi 模式（无 adb）与旧版一致 |

配置项（`worker-workspace\phone-mika.json` 的 `executor.mika` 下）：

```json
"recovery": {
  "enabled": true,        // false = 关闭内建自愈（仍可手工跑 CLI）
  "preflight": true,      // false = 只在任务失败后才修（无障碍）
  "connectPreflight": true, // false = 派发前不先跑 mika connect；默认开启，需配 adb
  "timeoutMs": 20000,     // 单条 adb 命令超时
  "rebindGapMs": 700,     // 无障碍「摘掉→放回」之间的间隔
  "retries": 1            // 自愈后重试任务的次数（0..3）
}
```

其它字段：`recovery.adb`（默认沿用 `executor.mika.adb`）、`recovery.serial`（默认沿用 `device`）、
`recovery.packageName` / `recovery.appLabel`（默认 Mika 官方包名与 `Mika`）。

### 电脑文件与手机 Download

Mika 的远程任务接口**只传文本**（`task run --goal-file`），没有附件参数；Mika 的沙箱也读不到
`/sdcard`（工具访问工作区外文件会返回 `path_outside_workspace`）。所以电脑上发起的任务如果引用了
电脑本地文件（例如 `C:\Users\…\Downloads\resume.pdf`），设备代理会：

1. 用 adb 把该文件推到手机的 `/sdcard/Download/<文件名>`（手机 App 的文件选择器能看到 Download）；
2. 把任务指令里的电脑路径改写为「手机『下载/Download』文件夹里的 resume.pdf」，并追加一句
   「你在 Android 手机上执行，无法访问电脑路径」。

这样 Mika 在手机上操作投递类 App 时，可以从文件选择器里选 Download 里的 PDF；不要指望 Mika
用读文件工具直接读 `/sdcard`。adb 不可用时只做文案改写，需要人工先把文件放进手机 Download。

真机实测（2026-11-18，同一天内逐项验过）：

| 场景 | 结果 |
| --- | --- |
| 助手被 `kill` 掉 | `--check` 报 `helper-not-running`（exit 2）→ `--repair` 走 `helper-launch`/`helper-start`/`helper-verify` 拉起 pid=5298（exit 0） |
| 用 UI 把 Mika 无障碍关掉（enabled=0、列表空） | `--repair`：写设置被拒 → 自动转 UI 自动化（开页/关掉崩溃标记/再打开/复验）→ enabled=1 且已绑定（exit 0） |
| 真机任务 | `task run` → `task wait` → `status:"done"`，answer 是手机当前时间 |
| **执行器端到端（真机）** | 杀助手后直接调用执行器（当时的 preflight 会连助手一起修）：自愈步骤 `wake/battery-whitelist/grant-secure-settings/launch/helper-start-1/helper-verify(pid=7346)` → 刷新连接 → 任务 `done`（20.1s） |
| 执行器端到端（真机，收窄 preflight 后） | 无障碍正常、只有助手没跑：不提前修，任务 3.1s 直接 `done`（Mika 退化到纯无障碍操作）；真失败时走「自愈 + 重试」路径（单测覆盖） |
| 全量测试 | `node --test`（51 个测试文件）**424/424 通过**，含新增的 recovery/executor 自愈用例 |

---

## 6. 症状速查表

`mika doctor --json` / `mika connect --json` 失败时返回 `{"error":{"code":...,"message":...}}`。

| 错误码 / 症状 | 典型消息（节选） | 含义 | 第一步动作 |
| --- | --- | --- | --- |
| `phone_unavailable` / `NO_ACCESSIBILITY` | 任务记录里的 `phone_unavailable`，Mika 自检建议「重新开启无障碍」 | 无障碍服务不可用 | `--check` → `--repair`（本手册 §2/§3） |
| `phone_unavailable` / `NO_PHONE_HELPER(_USB)` | — | 手机助手没跑 | `--check` 应报 `helper-not-running`；`--repair` 会跑 `usb-start.sh` |
| `UsbHelperStopped` | 手机侧重启/被清理后助手停了 | 同上 | 同上；若反复出现看 §11 |
| `connection` | `Could not read a valid response from Mika; check the connection and run mika connect.` | CLI 说不上话：休眠/锁屏/Mika 进程被杀 | 设备代理会自动唤醒屏幕/拉起 Mika → `mika connect` → 重试一次（§5）；手工排查：`-Check` → 唤醒手机 → 拉起 Mika → `mika connect` |
| `stale_connection` | `The phone has rebooted; run mika connect ...` | 手机重启过，连接信息过期 | `mika connect` 刷新（代理自愈时会自动做） |
| `connection_info` | `Mika's connection information is invalid. Unlock the phone, open Mika once, then retry connect.` | 手机端连接信息文件缺失/损坏 | 解锁 → 打开一次 Mika → `connect` |
| `adb_unavailable` | `adb was not found or cannot be run.` | adb 路径不对 | 检查 `-Adb` / `recovery.adb` |
| `unauthorized` / `device_offline` | 同 CLI 原文（见 §8） | 未授权/离线 | 人工在手机上点「允许 USB 调试」/换线换口 |
| `incompatible_api` | `This Mika APK does not advertise task API v1; ...` | 手机 APK 太旧 | 升级 Mika APK（adb 修不了） |
| `waiting_on_phone` / `waiting_for_answer` | 任务状态，不是连接错误 | Mika 在等人在手机上处理 | 人工处理/接管；不是恢复脚本职责 |
| `outcome_unknown` | `The phone may have accepted the operation, but its response was not received.` | 可能已生效 | 先 `task status/list` 查，别盲目重发 |

---

## 7. 无线调试 / 配对码：为什么通常不需要

- 本仓库的桥是 **USB ADB**（`phone-mika.json` 只填 `adb` + `device`），CLI 用 `adb forward` 访问手机上的
  Mika 服务，**整个恢复流程只依赖 USB**。
- Mika App「设置 › 手机操作」显示 **「无线调试已关」** 是 Mika 的另一条手机控制路径没开，
  **不影响 USB 直连**；它只在「用无线调试配对」这种模式下才是必需项。
- 「无线调试」失效或配对码过期不影响 USB；6 位配对码由手机现场生成、有时效，无法自动化。
- 需要 Wi-Fi ADB 时的做法见 [MIKA-PHONE.md](MIKA-PHONE.md)（`adb tcpip 5555` + `adb connect IP:5555`），
  注意明文 ADB 的暴露风险，只在可信内网用。

---

## 8. 手工命令清单（脚本坏了也能修）

```powershell
$ADB    = 'C:\path\to\platform-tools\adb.exe'   # 或直接 'adb'（已在 PATH）
$SERIAL = '<手机序列号>'
$PKG    = 'com.wangzan101.mika'
$CLI    = '.\worker-workspace\Mika\tools\mika\scripts\mika_cli.py'
```

### 8.1 ADB 连接

```powershell
& $ADB start-server
& $ADB devices -l
```

- `unauthorized`：解锁手机点「允许 USB 调试」，建议勾「始终允许」
- `offline`：换线/换口，`& $ADB kill-server` 后重试
- 什么都没显示：仅充电线 / USB 口坏 / USB 调试被关（只能人工开）

### 8.2 看手机控制状态（一次写清）

```powershell
& $ADB -s $SERIAL shell 'settings get secure accessibility_enabled; settings get secure enabled_accessibility_services; pidof com.wangzan101.mika; pidof com.wangzan101.mika:helper'
& $ADB -s $SERIAL shell dumpsys accessibility | Select-String -Pattern 'Bound services|Enabled services|Crashed services'
```

健康样貌：

```
1
com.wangzan101.mika/com.wangzan101.mika.a11y.MikaAccessibilityService
18269
5298
Bound services:{Service[label=Mika, ...]}
Crashed services:{}
```

### 8.3 拉起手机助手（最常用的救命命令）

```powershell
& $ADB -s $SERIAL shell sh /sdcard/Android/data/com.wangzan101.mika/files/usb-start.sh
```

- `Mika helper starting... Open Mika to confirm phone control is ready.` → 成功，2 秒后 `pidof` 应出现 pid
- `Mika helper already running. Nothing to do.` → 已经连着
- `Mika helper did not start. Open Mika once, then run this command again.` → 先 `monkey -p $PKG 1` 打开一次 Mika 再重跑

脚本是 Mika 自己写的（带 24h 有效的口令）；App 冷启动后会重写。**别手改它**。

### 8.4 无障碍：写设置（本机大概率被拒）

```powershell
& $ADB -s $SERIAL shell settings put secure accessibility_enabled 1
```

被拒（ColorOS）就改用设置界面自动化，或直接跑 `node .\scripts\mika-phone-recovery.js --repair`：

```powershell
& $ADB -s $SERIAL shell am start -a android.settings.ACCESSIBILITY_SETTINGS
& $ADB -s $SERIAL shell uiautomator dump /sdcard/x.xml
& $ADB -s $SERIAL shell cat /sdcard/x.xml          # 单行 XML，找 text="Mika" 的节点与 bounds
& $ADB -s $SERIAL shell input tap <cx> <cy>        # 点进服务详情页
# 详情页里主开关是 android.widget.Switch，用 checked 属性判状态（不是 text）
# 开关已开却不可用 → 先点掉并在「要停用“Mika”吗？」里点「停止」，再点开
```

### 8.5 唤醒 / 拉起 Mika

```powershell
& $ADB -s $SERIAL shell input keyevent 224
& $ADB -s $SERIAL shell wm dismiss-keyguard
& $ADB -s $SERIAL shell monkey -p com.wangzan101.mika -c android.intent.category.LAUNCHER 1
& $ADB -s $SERIAL shell cmd package resolve-activity --brief com.wangzan101.mika   # 入口 = 最后一行
& $ADB -s $SERIAL shell am start -n com.wangzan101.mika/.ui.MainActivity
```

### 8.6 连接与验收

```powershell
& py -3 $CLI --device $SERIAL --adb $ADB --json connect
& py -3 $CLI --device $SERIAL --adb $ADB --json doctor
```

---

## 9. 旧入口 `restore-mika-phone.ps1`

保留给习惯 PowerShell 的运维/快捷方式，行为与 Node CLI 一致（同一份实现）：

```powershell
# 只读诊断（默认 -Check）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\restore-mika-phone.ps1 -Check -Serial <序列号>
# 修复：自检 → 自愈 → mika connect 刷新 → doctor 验收
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\restore-mika-phone.ps1 -Restore -Serial <序列号>
```

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `-Adb` | 依次取：`-Adb` 参数 → 环境变量 `MIKA_ADB` → 本地 `worker-workspace\phone-mika.json` 里配置的 `executor.mika.adb` → PATH 里的 `adb` | adb 可执行文件 |
| `-Serial` | 环境变量 `MIKA_PHONE_SERIAL` | 手机序列号（**未设置时必须显式传**） |
| `-Cli` | `worker-workspace\Mika\tools\mika\scripts\mika_cli.py` | 验收用的 Mika CLI |
| `-Package` | `com.wangzan101.mika` | Mika 包名 |
| `-Service` | — | 仅为兼容旧调用保留，已忽略（组件名会归一化处理） |
| `-TimeoutSec` | `120` | 单条 adb 命令超时（秒） |
| `-Check` / `-Restore` | `-Check` | 二选一 |

退出码：`0` 健康/修好；`2` 仍有故障；`1` 参数或依赖（node/python/CLI 缺失）错误。

---

## 10. 人工边界（adb 做不到的事）

- `input keyevent 224` 只能点亮屏幕；`wm dismiss-keyguard` 只能去掉**非安全**锁屏。
- **PIN/密码/图案锁屏无法用 adb 解开**；Mika 远程解锁默认关闭（要开需在手机 Mika 里本地配置凭据）。
  不支持：图案、SIM PIN、未知厂商凭据页；也不支持「重启后首次解锁前」启动 Mika MCP。
- **USB 调试开关被关掉后 adb 无法远程打开**，必须人工到开发者选项里开。
- **ColorOS 的「USB 调试(安全设置)/禁止权限监控」** 决定 adb 能否写安全设置；本流程不自动改（安全风险），
  需要时人工在开发者选项里开，之后 `--repair` 会优先走写设置（更快、不用扰动界面）。
- APK 太旧（`incompatible_api`）、无线调试配对码：不在自动修复范围。

---

## 11. 复发预防（比恢复更重要）

- **保持供电与唤醒**：长期插 USB/充电；开发者选项开「不锁定屏幕」；屏幕超时调长。
- **解除 Mika 省电限制**：设置 › 电池 › 应用耗电管理 › Mika → 允许后台活动/不受限制（`--repair` 也会加 `deviceidle` 白名单）。
- **USB 连接稳定**：数据线而非仅充电线；固定 USB 口；避免 Hub 供电不足。
- **桥进程常驻**：`worker-workspace\start-workers.ps1` 的代理窗口别关（代理挂了是「设备离线」，不是本文件的问题）。
- **失败即诊断**：出现手机类错误先跑 `mika-phone-recovery.js --check`；代理已会自动做，但人工跑一遍更直观。

---

## 12. 与其它文档的关系

| 文档 | 内容 | 何时看 |
| --- | --- | --- |
| [MIKA-PHONE.md](MIKA-PHONE.md) | 手机/电脑准备、CLI 安装、设备代理配置、发任务、故障排查 | 首次接入、改配置、日常发任务 |
| 本文件 | 手机 Mika 失效时的 USB ADB 自检/自愈：检查项、修法、内建自愈配置、锁屏边界、验收 | 任务报 `phone_unavailable` / `connection` / 助手没跑 |
| `device-agent\lib\mika-recovery.js` | 自愈实现（唯一实现，代理与 CLI 共用） | 改自愈行为、写测试 |
| `worker-workspace\Mika\core\...\RecoveryPermissions.kt` | Mika 自己的恢复语义 | 核对「为什么这样修」 |

---

## 13. 验证记录

2026-11-18 在本机真机（OPPO / ColorOS / Android 12）逐项验过：

- `node scripts/mika-phone-recovery.js --check`：健康时 8/8 `[ OK ]`、exit 0；人为制造故障时正确报 `[FAIL]`、exit 2
- 杀助手 → `--repair` 自动拉起（`helper-launch-1` → `helper-start-1` → `helper-verify` pid=5298）
- UI 关掉无障碍 → `--repair`：写设置被 SecurityException 拒 → 自动转设置界面自动化 → enabled=1 且已绑定
- `restore-mika-phone.ps1 -Check` / `-Restore`：均 exit 0，`-Restore` 末尾 `mika connect` 返回
  `{"connected":true,...,"server_version":"0.1.37"}`、`doctor` 返回 `helper_available:true,ready:true`
- 真机任务：`task run` → task_id `79d6cf59-...` → `task wait` → `status:"done"`，answer=手机当前时间
- 执行器端到端（真机，`worker-workspace\phone-mika.json` 真实配置）：杀掉手机助手后直接调用设备代理执行器，
  进度依次出现「手机自愈 wake / battery-whitelist / grant-secure-settings（ColorOS 拒绝，不致命）/ launch /
  helper-launch-1 / helper-start-1 / helper-verify：手机助手已运行 pid=7346」「手机控制已恢复，正在刷新 Mika 连接信息…」
  → 任务 `status:done`、answer 是手机时间，总耗时 20.1s
- 收窄 preflight（只有无障碍坏才提前修）后同一路径复测：无障碍正常、助手没跑时任务 3.1s 直接 `done`，
  不再为「可能不需要的助手」多花十几秒
- 全量测试：`node --test`（51 个测试文件，显式文件列表）**424/424 通过**；device-agent 新增 recovery 自愈用例覆盖
  「preflight 先修后派发」「无障碍正常时不提前修」「phone_unavailable 失败→自愈→重试成功」「自愈失败提示」「未配 adb 不自愈」

> 本机 `npm test` 在 Node v24 下不可用（`node --test <目录>` 会把目录当模块加载，报
> `Cannot find module ...\shared\test`）。临时办法：显式列出测试文件后
> `node --test (Get-ChildItem -Recurse -Filter *.test.js | % FullName)`。
