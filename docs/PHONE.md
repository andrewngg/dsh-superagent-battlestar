# 手机设备接入计划（phone-control）

本文件说明「手机操作」能力如何从当前临时方案，演进为管家的正式设备。

## 1. 现状（临时方案）

- 当前由 **豆包桌面版** 人工/半自动操纵手机，检索 APK。
- 手机通过 USB/ADB 连接本机（`platform-tools` 中的 `adb`，例如 `C:\path\to\android-sdk\platform-tools\adb.exe`）。
- 这部分**暂不纳入管家路由**：第一台工作机的能力清单不申报 `phone-control`，
  避免管家把手机任务误派给没有手机在线的机器。
- 本机 manifest 中保留了 `doubao` profile（名称「豆包桌面（手机操控，临时）」），仅作能力展示。

## 2. 目标形态

第二台手机作为独立设备接入 Hub，申报自己的手机操作能力；管家按能力把 `phone-*` 任务派给它：

```
手机（Android）
  ├─ Super Butler 设备代理（Termux 或专用 APK）
  ├─ 申报 skills: phone-control, apk-search, screenshot, tap, input, install
  ├─ 心跳 + 长轮询领取命令
  └─ 执行器：ADB / Android 无障碍 / 自动化脚本
        ▲
        │ 内网 REST + SSE
   Hub（首台工作机或 NAS）
        ▲
        │
   用户手机 APK（Super Butler）→ 看状态、发指令
```

需要时管家发给手机设备的指令示例：

```json
{
  "instruction": "在应用商店/网页中搜索「XX APK」，下载并安装，然后截图回报",
  "requirements": { "skills": ["apk-search", "phone-control"] },
  "timeoutSec": 600
}
```

## 3. 接入方式（二选一）

### A. Termux + Node 设备代理（最快）

1. 手机安装 Termux，`pkg install nodejs`。
2. 把 `device-agent/`、`shared/` 复制到手机（或下次提供自包含单文件包）。
3. 写手机能力配置（示例）：

```json
{
  "name": "手机 Pixel 8",
  "platform": "android",
  "kind": "multi",
  "tags": ["随身", "手机操控"],
  "models": [
    { "id": "deepseek-chat", "provider": "deepseek", "strengths": ["general"] },
    { "id": "doubao", "provider": "doubao", "strengths": ["phone-operation"] }
  ],
  "profiles": [{ "id": "doubao", "name": "豆包（手机操控）" }],
  "gateways": [{ "id": "deepseek-api", "kind": "openai-compatible", "models": ["deepseek-chat"] }],
  "skills": [
    { "id": "phone-control", "name": "手机操控" },
    { "id": "apk-search", "name": "APK 检索与安装" },
    { "id": "screenshot", "name": "截屏" }
  ],
  "limits": { "maxConcurrentTasks": 1 },
  "executor": { "type": "shell", "shell": { "command": "bash ~/phone-task.sh {instruction}" } }
}
```

4. 启动：

```bash
JOIN_CODE=<Hub 加入码> node device-agent/agent.js \
  --hub http://<Hub内网IP>:7317 --join-code "$JOIN_CODE" \
  --config phone.json --state-dir ~/.super-butler
```

5. 手机侧的 `phone-task.sh` 用 ADB（无线调试）或 Android 自动化工具执行具体动作。

### B. 专用 Android APK（与 dsh-Go 类似的宿主）

在现有 Super Butler APK 基础上增加「作为设备」模式：内嵌 Node/PTY 或直接调用无障碍服务，
把手机能力注册到 Hub。工程量较大，但体验最好，后续再做。

## 4. 上线前检查

- 手机与 Hub 同一 Wi-Fi / 虚拟内网；Hub 端口仅内网可达。
- 手机设备 `limits.maxConcurrentTasks: 1`（手机同一时间只做一件事）。
- 任务超时 ≥ 5 分钟（下载/安装 APK 较慢），并在手机上保留「停止」能力。
- 敏感操作（安装未知来源 APK、支付、删除文件）建议在手机端二次确认，不交给 LLM 全自动。
- 接入后先跑一条 smoke 任务：`截屏并返回当前前台应用名称`，确认链路与权限正常。

## 5. 过渡期约定

在手机设备接入前：

- 手机操作类任务仍由人工通过豆包处理；
- 不要向管家发 `phone-control` 任务（当前没有设备申报该技能，会保持 `queued` 并给出 `route.excluded` 原因，这是预期行为）；
- 手机接入后，把 `phone-control` / `apk-search` 加入手机 manifest，即可自动参与路由。
