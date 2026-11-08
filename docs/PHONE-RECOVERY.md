# 手机 Mika 失效恢复手册（USB ADB）

> **一句话结论：手机桥在线 ≠ 手机可控。** 失败时先看 `mika doctor` 的 `connection` 与
> `device_state.device.ready`，再看手机是不是**休眠/锁屏**——大多数「Mika 不应答」都是这两件事，
> 不需要重装配对、更不需要无线调试。

本文件是「手机 Mika 操控失效 → 用母机 USB ADB 恢复」的运维手册；接入/配置/发任务的完整说明见
[MIKA-PHONE.md](MIKA-PHONE.md)，本文件不重复大段内容。

- 配套脚本：[scripts/restore-mika-phone.ps1](../scripts/restore-mika-phone.ps1)
- 适用：手机已用 USB 连到「Mika 桥」电脑（本机 Windows），`adb devices` 能看到它
- 实测环境：Windows 11 + PowerShell 7.6.9 / Windows PowerShell 5.1，adb 37.0.1，Python 3.14.6（2026-11-08）

---

## 1. 先判断：到底是哪一层坏了

「手机工作机」不是手机上的 agent，而是**母机上的 Mika 桥**（`worker-workspace\phone-mika.json`，
`executor.type=mika`）。链路是：

```
管家 Hub → 母机上的设备代理 → mika CLI → USB ADB → 手机上的 Mika → 后台操作 App
```

因此「设备在线/心跳正常」只说明**代理在跑**，不代表 CLI 能连上手机、更不代表手机能执行任务。

按顺序看三个信号：

| 信号 | 命令 | 含义 |
| --- | --- | --- |
| 桥进程在线 | 管家设备列表 / `start-workers.ps1` 窗口 | 代理没挂，但任务仍可能失败 |
| CLI 连接可用 | `mika doctor --json` 的 `connection` | `ok` 才说明能读到 Mika 的本地连接信息 |
| 手机可执行 | `device_state.device.ready` | `true` 才说明屏幕/锁屏状态允许 Mika 干活 |

再对照一句话：**`connection` 失败优先查休眠/锁屏/Mika 进程；`ready=false` 优先查锁屏**。

---

## 2. 症状速查表

`mika doctor --json` / `mika connect --json` 失败时会返回 `{"error":{"code":...,"message":...}}`。
常见错误码与第一步动作：

| 错误码 / 症状 | 典型消息（节选） | 含义 | 第一步动作 |
| --- | --- | --- | --- |
| `connection` | `Could not read a valid response from Mika; check the connection and run mika connect.` | CLI 能跟手机说上话，但读不到 Mika 本地服务的有效响应。**最常见根因：手机休眠/锁屏、Mika 进程被杀、服务未起。** | 先看 `adb devices` 是否 `device`；唤醒屏幕（`input keyevent 224`）→ 拉起 Mika → 重跑 `mika connect` |
| `stale_connection` | `The phone has rebooted; run mika connect to obtain current connection information.` | 手机重启过，CLI 缓存的 boot/端口信息过期 | 直接 `mika connect --device <SERIAL> --json`，然后 `doctor` 复验 |
| `adb_unavailable` | `adb was not found or cannot be run. Install Android platform-tools or provide a runnable --adb path.` | adb 不存在/不可执行 | 确认 `-Adb` 路径（本机 `%USERPROFILE%\Documents\doubao\phone_adb\platform-tools\adb.exe`）；装 platform-tools |
| `unauthorized` | `The phone has not authorized this computer. Unlock the phone, accept the USB debugging prompt, then retry.` | 手机没信任本机 RSA 指纹 | 解锁手机，在弹窗点「允许」（建议勾选「始终允许」）；没有弹窗就拔插数据线/重开 USB 调试 |
| `connection_info` | `Mika's connection information is invalid. Unlock the phone, open Mika once, then retry connect.` | 手机端连接信息文件缺失/损坏（常见于锁屏状态下首次启动 Mika） | 解锁手机 → 打开一次 Mika → 再 `connect` |
| `incompatible_api` | `This Mika APK does not advertise task API v1; ...` | 手机上的 Mika APK 太旧，不支持 CLI 任务 API v1 | 更新 Mika APK（不是 adb 能修的） |
| `waiting_on_phone` / `waiting_for_answer` | 任务状态，不是连接错误 | Mika 在等人在手机上处理（支付、验证码、接管、回答） | 在手机上处理/接管；处理完任务会继续（或重发任务）。不是恢复脚本的职责 |
| `device_offline`（`state=offline`） | `The phone is offline. Reconnect the cable ...` | 手机在 adb 里被标记 offline | 重新插拔 USB、重开 USB 调试、`adb kill-server` 后重试 |
| `device_offline`（`state=unauthorized`） | 同上（unauthorized 专用消息） | 等同于上面的 `unauthorized` | 在手机上允许 USB 调试授权 |
| `device_offline`（`state=unknown`） | `The selected phone is not online; the CLI will not switch devices.` | `adb devices` 里找不到该序列号（线/口/授权问题） | 核对 `-Serial`；`adb devices -l`；换线/换 USB 口 |
| `device_selection` | `Expected one online phone. Run mika devices and choose --device SERIAL.` | 多台设备且没指定序列号 | 加 `--device <SERIAL>`（本仓库配置已写死序列号） |
| `adb` | `ADB did not complete; ...` / `ADB server could not start; ...` | adb 命令本身失败/服务起不来 | `adb kill-server` 后 `adb start-server`；检查 platform-tools 完整性 |
| `outcome_unknown` | `The phone may have accepted the operation, but its response was not received. ...` | 操作可能已在手机上生效，但没收到响应（**不要盲目重试任务**） | 用 `mika task status/list --json` 查状态，再决定是否重发 |
| 设备离线（管家侧） | 设备列表无手机 / 任务 `route.excluded` | 桥代理没跑或没连上 Hub | 检查桥电脑、Hub IP、加入码、防火墙（见 MIKA-PHONE.md §6） |

> 错误消息以 CLI 实际返回为准；`--json` 模式下错误 JSON 可能打到 stderr，脚本两种流都会捕获。

---

## 3. 一键流程

脚本：`scripts\restore-mika-phone.ps1`（UTF-8 with BOM；Windows PowerShell 5.1 / pwsh 7 均可；
无第三方依赖；中文输出）。

### 3.1 只读诊断 `-Check`（默认行为，不改手机）

```powershell
# 在仓库根目录执行；不带参数默认就是 -Check
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\restore-mika-phone.ps1 -Check

# 或 pwsh 7
pwsh -NoProfile -File .\scripts\restore-mika-phone.ps1 -Check
```

检查项（共 10 项，输出 `[OK]` / `[FAIL]` 表格）：

1. `adb` 路径存在、Mika CLI 路径存在、`py -3` 可用
2. `adb start-server` 成功、`adb devices` 中目标序列号状态为 `device`
3. 无障碍服务 `enabled_accessibility_services` 含目标服务、`accessibility_enabled=1`
4. `pidof com.wangzan101.mika` 进程存活
5. `mika doctor --json`：`connection=ok` 且 `device_state.device.ready=true`

退出码：`0` = 全部通过；`2` = 存在故障；`1` = 参数错误。

### 3.2 执行修复 `-Restore`（会改手机状态）

```powershell
# 确认诊断有故障、且手机已 USB 连接后再执行
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\restore-mika-phone.ps1 -Restore
```

`-Restore` 的实际动作（每步打印命令与结果）：

1. 先跑一遍完整诊断；**如果已经健康，直接退出 0，不做任何修改**
2. 唤醒屏幕：`adb shell input keyevent 224`（WAKEUP）→ `adb shell wm dismiss-keyguard`
   （失败不致命；**安全锁屏无法用 adb 解开**，见第 7 节）
3. 拉起 Mika：`adb shell monkey -p com.wangzan101.mika 1`；失败则用
   `cmd package resolve-activity --brief` 找到入口再 `am start -n <组件>`
4. 无障碍服务未启用时：读取现有列表，**保留已有服务**、仅追加目标服务，再
   `settings put secure accessibility_enabled 1`，并复检确认
5. 重跑 `mika connect --json`；失败时再跑 `doctor --json` 收集证据
6. 最后以 `doctor` 验收：只有 `device_state.device.ready=true` 才退出 `0`

退出码：`0` = 修复后 ready；`2` = 仍有故障（按输出继续人工处理）；`1` = 参数错误。

> 适用边界：ADB 只能修「手机休眠/锁屏可唤醒」「Mika 没在前台/进程被停」「无障碍服务被关」
> 「连接信息过期」这几类。**USB 调试被关、锁屏密码、APK 太旧、无线调试配对码**都不在自动修复范围内。

### 3.3 参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `-Adb` | `%USERPROFILE%\Documents\doubao\phone_adb\platform-tools\adb.exe` | adb 可执行文件 |
| `-Serial` | 环境变量 `MIKA_PHONE_SERIAL`（未设置时必须显式传入） | 手机序列号（`adb devices` 第一列） |
| `-Cli` | `...\super-butler\worker-workspace\Mika\tools\mika\scripts\mika_cli.py` | Mika CLI 脚本 |
| `-Package` | `com.wangzan101.mika` | Mika 包名 |
| `-Service` | `com.wangzan101.mika/com.wangzan101.mika.a11y.MikaAccessibilityService` | 无障碍服务组件名 |
| `-TimeoutSec` | `120` | 传给 `--request-timeout`（CLI 允许 1–120 秒） |
| `-Check` | 默认 | 只读诊断，二选一 |
| `-Restore` | 关闭 | 执行修复，二选一（与 `-Check` 互斥） |

示例（自定义路径）：

```powershell
.\scripts\restore-mika-phone.ps1 -Check -Adb 'D:\platform-tools\adb.exe' -Serial YOUR_PHONE_SERIAL
```

---

## 4. 手工命令清单（脚本坏了也能修）

以下命令按「诊断 → 修复 → 验收」顺序。先设好变量（PowerShell 5.1 同样可用）：

```powershell
$ADB    = "$env:USERPROFILE\Documents\doubao\phone_adb\platform-tools\adb.exe"
$SERIAL = 'YOUR_PHONE_SERIAL'
$CLI    = '.\worker-workspace\Mika\tools\mika\scripts\mika_cli.py'   # 按实际检出位置填写
```

### 4.1 ADB 连接

```powershell
& $ADB start-server
& $ADB devices
& $ADB devices -l          # 需要更多信息（model/transport_id）时
```

预期输出：

```
List of devices attached
YOUR_PHONE_SERIAL	device
```

- 显示 `unauthorized`：解锁手机点「允许 USB 调试」；仍不行 → 开发者选项里「撤销 USB 调试授权」后重插
- 显示 `offline`：重新插拔数据线/换 USB 口，`& $ADB kill-server` 后重试
- 什么都不显示：数据线是「仅充电线」、USB 口坏、或 USB 调试被关（后者只能手动开）

### 4.2 无障碍服务

```powershell
& $ADB -s $SERIAL shell settings get secure enabled_accessibility_services
& $ADB -s $SERIAL shell settings get secure accessibility_enabled
```

预期（健康时）：

```
com.wangzan101.mika/com.wangzan101.mika.a11y.MikaAccessibilityService
1
```

修复（**保留已有服务**，用冒号分隔追加；空列表时只填目标服务；不要把别的服务删掉）：

```powershell
# 先读出来，人工确认，例如原值：com.other.app/com.other.app.Svc
& $ADB -s $SERIAL shell settings put secure enabled_accessibility_services `
  'com.other.app/com.other.app.Svc:com.wangzan101.mika/com.wangzan101.mika.a11y.MikaAccessibilityService'
& $ADB -s $SERIAL shell settings put secure accessibility_enabled 1
```

> 值里不能有空格；`settings put` 失败通常是权限/服务名写错，先 `settings get` 核对。

### 4.3 Mika 进程与前台状态

```powershell
& $ADB -s $SERIAL shell pidof com.wangzan101.mika
& $ADB -s $SERIAL shell dumpsys window | Select-String 'mCurrentFocus'
& $ADB -s $SERIAL shell dumpsys power | Select-String 'mWakefulness|mScreenOn'
```

预期：`pidof` 输出数字 PID（如 `25839`）；`mWakefulness=Awake`；`mCurrentFocus` 是 Mika 或桌面。
`pidof` 无输出 = 进程被系统杀了（常见于省电策略），需要拉起 Mika 并加电池白名单。

### 4.4 唤醒屏幕 / 解锁

```powershell
& $ADB -s $SERIAL shell input keyevent 224     # KEYCODE_WAKEUP
& $ADB -s $SERIAL shell wm dismiss-keyguard    # 只能去掉非安全锁屏；安全锁屏会失败
```

预期：屏幕亮起；`dismiss-keyguard` 无输出通常表示已解锁/无 keyguard。
**如果手机设了 PIN/密码/图案，adb 无法解锁**，必须人工解锁或用 Mika 远程解锁（默认关闭）。

### 4.5 拉起 Mika

```powershell
& $ADB -s $SERIAL shell monkey -p com.wangzan101.mika 1
```

预期（成功）：

```
Events injected: 1
Monkey finished
```

如果报找不到 activity，先查入口再 `am start`：

```powershell
& $ADB -s $SERIAL shell cmd package resolve-activity --brief com.wangzan101.mika
# 输出最后一行形如：priority=0 ... com.wangzan101.mika/.MainActivity
& $ADB -s $SERIAL shell am start -n com.wangzan101.mika/.MainActivity
```

### 4.6 Mika 连接与验收

```powershell
& py -3 $CLI --device $SERIAL --adb $ADB --json --request-timeout 120 connect
& py -3 $CLI --device $SERIAL --adb $ADB --json --request-timeout 120 doctor
```

`connect` 成功会返回 `{"connected":true,...}`（并已包含一次 API 验证）。
`doctor` 健康输出（本机 2026-11-08 实测）：

```json
{"connection":"ok","transport":"adb","device":"YOUR_PHONE_SERIAL","api_version":1,
 "device_state":{"status":"state","enabled":false,"credential_configured":false,
 "attempt_blocked":false,
 "device":{"interactive":true,"keyguard_showing":false,"device_locked":false,
 "secure":false,"helper_available":true,"user_unlocked":true,"ready":true}},
 "model_configuration":"unverified"}
```

判读：

- `connection=ok` 且 `device_state.device.ready=true` → 连接与手机状态都正常，可以发任务验收
- `state.enabled=false`、`credential_configured=false` → Mika 的「远程亮屏/解锁」功能默认关闭，
  **不是故障**；要远程解锁需在手机 Mika 的电脑连接设置页本地配置凭据
- `device_locked=true` / `keyguard_showing=true` / `ready=false` → 手机锁屏了，人工解锁或配置远程解锁
- `status=unsupported`（无 `device` 字段）→ APK 不支持 device_state，升级 Mika

---

## 5. 为什么会这样（2026-11-08 案例）

- 现象：任务失败，错误 `Mika：connection: Could not read a valid response from Mika;
  check the connection and run mika connect.`
- 根因：手机在 **08:59–11:30:40 休眠**，Mika 本地服务不应答；任务**从未提交到手机**。
- 记录：`task-records\2026-11-08\task_k15azjb7.md`（Hub 记 UTC 03:30:11 失败，1.3s 即失败），
  重试 1m5.9s 后改派其他工作机，最终 cancelled。
- 同类失败 11-06 也出现过（复发性）→ 重点在**防休眠**与「失败先看 doctor」。

因此恢复思路不是「重装/重配对」，而是：**唤醒手机 → 让 Mika 回到前台 → 确保无障碍在 → 重连**。

---

## 6. 无线调试 / 配对码：为什么通常不需要

- 本仓库的桥配置是 **USB ADB**（`phone-mika.json` 只填了 `adb` + `device`，`url`/`tokenFile` 为空），
  CLI 通过 `adb forward` 访问手机上的 Mika 本地服务，**整个恢复流程只依赖 USB**。
- 「无线调试」是另一种传输方式；它失效或配对码过期，不影响 USB 连接。
- 无线调试的 **6 位配对码由手机现场生成、有时效**，无法自动化；而且开了无线调试也不需要它来恢复 USB。
- 只有当手机**没有 USB**（或 USB 口坏）时，才需要走无线；这时也建议先用 USB 配一次。

### 需要 Wi-Fi ADB 时怎么做（可选项）

前提：手机与母机同一局域网，且**先用 USB 连上**（Android 11+ 的「无线调试」如果要求配对，
`adb pair IP:PORT` + 手机屏幕上的 6 位码需要人工输入一次，无法自动化）。

```powershell
# 1) USB 连着时，让手机在 5555 端口监听（adb tcpip 5555）
& $ADB -s $SERIAL tcpip 5555

# 2) 查手机 wlan IP（或看 设置 › WLAN › 当前网络；不同系统命令略有差异）
& $ADB -s $SERIAL shell ip -f inet addr show wlan0
# 看不到时依次试：& $ADB -s $SERIAL shell ip addr show wlan0
#               & $ADB -s $SERIAL shell ip route

# 3) 拔掉 USB，连接（adb connect IP:端口；IP 换成上一步的）
& $ADB connect 192.168.1.30:5555
& $ADB devices          # 应出现 192.168.1.30:5555  device
```

恢复 USB 模式：`& $ADB usb`（或拔线重插）。

风险与注意：

- 明文 ADB，**同一网段的人可能连上手机**；只在可信内网/私有 VPN 使用，用完 `adb disconnect`
- 手机重启后 `tcpip` 失效，需要重新用 USB 开一次；IP 也可能变（建议路由器固定 IP）
- 不要用公网 IP/端口映射暴露 ADB
- 这与 Mika 自己的 Wi-Fi 模式（`mika --url http://IP:8765 --token-file ...`）是两回事：
  后者是 Mika 的 HTTP 服务 + token，前者是 adb 传输；本恢复脚本不走 Wi-Fi 模式

---

## 7. 人工解锁边界（adb 做不到的事）

- `input keyevent 224` 只能**点亮屏幕**；`wm dismiss-keyguard` 只能去掉**非安全**锁屏（滑动/无锁）。
- **PIN/密码/图案锁屏无法用 adb 解开**（adb shell 没有解锁权限）；Mika 的远程解锁也默认关闭。
- 已明确不支持的解锁方式（Mika 上游文档）：图案、SIM PIN、未知厂商凭据页；
  也不支持「重启后首次解锁前」启动 Mika MCP。
- 因此：**锁屏密码只能人工输入**；如果希望远程解锁，需在手机 Mika「Connect a computer」设置页
  本地配置 PIN/密码凭据（4–16 位数字或 4–64 位可打印 ASCII），并自行评估安全风险。
- 同理：**USB 调试开关被关掉后，adb 无法远程打开**，必须人工到开发者选项里开。

---

## 8. 验收标准

恢复后按顺序确认：

1. `-Check` 全 `[OK]`（或手工 `doctor` 的 `connection=ok` 且 `device_state.device.ready=true`）
2. 发一条**小任务**，确认任务真的到达手机并完成：
   - 手机侧能看到 Mika 收到任务/开始执行
   - 管家侧任务记录（`task-records\<日期>\task_*.md`）出现提交/执行/完成事件，而不是秒失败
3. 任务内容建议用无副作用的操作，例如「截屏并回报当前前台应用名称」。

发任务示例（PowerShell，令牌换成管理员令牌）：

```powershell
@'
{"instruction":"截屏并回报当前前台应用名称","requirements":{"skills":["phone-control"]},"timeoutSec":300}
'@ | Set-Content -Encoding utf8 .\phone-smoke.json

curl.exe -X POST http://127.0.0.1:7317/api/tasks `
  -H "X-Butler-Token: <管理员令牌>" `
  -H "Content-Type: application/json" `
  --data-binary "@phone-smoke.json"
```

> `doctor` 只证明连接可用，不证明任务能执行（见 [MIKA-PHONE.md](MIKA-PHONE.md) §2）；
> 所以第 2 步的小任务验收不能省。遇到 `waiting_on_phone`/`waiting_for_answer` 说明手机需要人工处理。

---

## 9. 复发预防（比恢复更重要）

- **保持供电与唤醒**：手机长期插 USB/充电；开发者选项开「不锁定屏幕/充电时屏幕常亮」；
  屏幕超时调长。
- **解除 Mika 的省电限制**：设置 › 电池 › 应用耗电管理 › Mika → 允许后台活动/不受限制；
  关闭「深度休眠/智能省电」对 Mika 的限制（OPPO/ColorOS 路径类似）。
- **保持 USB 连接稳定**：用数据线而不是仅充电线；固定 USB 口；避免 Hub 供电不足。
- **桥进程常驻**：`worker-workspace\start-workers.ps1` 启动的代理窗口不要关；
  代理挂了是「设备离线」，不是本文件的连接故障。
- **失败即诊断**：出现 `connection` 先跑 `-Check`，不要直接重发任务（避免重复提交）。

---

## 10. 与 MIKA-PHONE.md 的关系

| 文档 | 内容 | 何时看 |
| --- | --- | --- |
| [MIKA-PHONE.md](MIKA-PHONE.md) | 手机/电脑准备、CLI 安装、设备代理配置、发任务、故障排查表 | 首次接入、改配置、日常发任务 |
| 本文件 | 手机 Mika 失效时的 USB ADB 恢复：诊断脚本、手工命令、锁屏边界、验收 | 任务报 `connection` / `doctor` 不 ok / 手机休眠锁屏 |

- 错误码速查：MIKA-PHONE.md §6 是简表；本文件 §2 是运维版（含第一步动作与恢复边界）。
- 设备代理配置：`worker-workspace\phone-mika.json`（executor.mika：`device=YOUR_PHONE_SERIAL`、
  `adb=...\platform-tools\adb.exe`、`timeoutMs=900000`、`waitSeconds=45`）。
- Mika 远程亮屏/解锁能力与限制：`worker-workspace\Mika\docs\dev\remote-device-access-check.md`。
- CLI 实现（connect/doctor 错误码与消息）：`worker-workspace\Mika\tools\mika\scripts\mika_cli.py`。
- 手机设备接入的长期规划（与恢复无关）：[PHONE.md](PHONE.md)。

---

## 11. 本文件与脚本的验证记录

2026-11-08 在本机（手机健康状态）实测：

- `restore-mika-phone.ps1` 通过 PowerShell 7.6.9 与 Windows PowerShell 5.1 语法解析
- `-Check` 两种 PowerShell 均输出 **10/10 `[OK]`、退出码 0**；中文正常
- 默认无参数等价 `-Check`；`-TimeoutSec 0` 与 `-Check -Restore` 同时指定 → 退出码 1
- `-Check -Serial BADSERIAL`（只读）→ 6 项失败、退出码 2，正确解析 `device_offline`
- **未实测 `-Restore` 的修复分支**（当天手机健康，避免修改手机状态）；其逻辑按上文第 3.2 节，
  首次使用前建议先 `-Check` 并人工确认无障碍原值
