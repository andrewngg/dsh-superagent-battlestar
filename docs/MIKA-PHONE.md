# 手机工作机：Mika（通过管家指挥手机）

[Mika](https://github.com/wangzan101/Mika) 是 Android 上的开源 AI Agent（Apache-2.0），可以在后台屏幕操作 App、
浏览网页、处理文件，并提供 **CLI + Skill / MCP** 给电脑调用。本项目把 Mika 接入管家，作为「手机工作机」设备：

```
Hub（第一台电脑 / NAS）
  └── 设备代理（一台连着手机或同一 Wi-Fi 的电脑）
        └── mika CLI（USB/ADB 或 Wi-Fi 私有网络）
              └── 手机上的 Mika → 后台执行 App/网页任务 → 返回结果
```

> 手机本身不安装 Node 设备代理也可以：由一台电脑作为「Mika 桥」注册设备，但能力/任务都归属这台手机。
> 后续若手机可直接跑 Node（Termux），也可以把代理放到手机上，协议不变。

## 1. 手机准备

1. 从 [Mika Releases](https://github.com/wangzan101/Mika/releases/latest) 安装 APK（Android 11+；操作 App 建议 Android 14+）；
2. 打开 Mika，在 Settings › Model 配置模型（可用 DeepSeek / OpenRouter / 本地 Ollama 等）；
3. 要操作 App：按 Settings 里的「Set up phone control」完成无障碍/无线调试配对；
4. 打开 **Settings › Connect a computer**：
   - USB：开启 USB 调试并在电脑上允许授权；
   - Wi-Fi/私有网络：打开 network access，记下地址（如 `http://192.168.1.30:8765`）与私有 token 文件。
   - 两种连接各有开关与 token，不要暴露到公网。

## 2. 电脑准备 Mika CLI

任选一种：

```bash
# 方式 A：pipx 安装（需要 Python 3.10+、pipx、adb）
pipx install 'git+https://github.com/wangzan101/Mika.git@<tag>#subdirectory=tools/mika'
mika --version

# 方式 B：只用仓库里的 Skill 脚本
# 把 Mika 仓库的 tools/mika 文件夹复制到任意目录，运行：
py -3 C:\path\to\tools\mika\scripts\mika_cli.py --version
```

USB 模式需要 Android platform-tools（`adb devices` 能看到手机）。连接与检查：

```bash
mika devices --json
mika connect --device <SERIAL> --json
mika doctor --device <SERIAL> --json
```

Wi-Fi 模式：

```bash
mika --url http://192.168.1.30:8765 --token-file C:\path\to\mika-token.txt doctor --json
```

> `doctor` 只证明连接可用，不证明任务能执行；用一个简单任务验证。

## 3. 配置设备代理

复制 `device-agent/configs/phone-mika.example.json` 为 `phone-mika.json`，按实际修改：

```jsonc
{
  "name": "手机工作机 · Mika",
  "platform": "android",
  "executor": {
    "type": "mika",
    "mika": {
      "command": "mika",              // Skill 模式：command="py", commandArgs=["-3","C:\\...\\mika_cli.py"]
      "commandArgs": [],
      "device": "",                   // USB 模式填 SERIAL；留空则由 CLI 自动选择唯一设备
      "url": "",                      // Wi-Fi 模式填 http://PHONE:8765
      "tokenFile": "",                // Wi-Fi 模式必填
      "adb": "adb",
      "timeoutMs": 900000,
      "waitSeconds": 45
    }
  }
}
```

在「Mika 桥」电脑上启动代理：

```powershell
node device-agent\agent.js `
  --hub http://192.168.1.10:7317 `
  --join-code <Hub 加入码> `
  --config device-agent\configs\phone-mika.json `
  --state-dir device-agent\.state\phone-mika
```

设备上线后应看到 skills：`phone-control`、`app-automation`、`web-automation`、`android-ui`、`apk-search`、
`screenshot`、`messages`、`mika`。

## 4. 通过管家发指令

```powershell
curl.exe -X POST http://127.0.0.1:7317/api/tasks `
  -H "X-Butler-Token: <管理员令牌>" -H "Content-Type: application/json" `
  -d '{"instruction":"在手机应用商店/网页中搜索并安装最新版 XX APK，完成后截图回报","requirements":{"skills":["phone-control","apk-search"]},"timeoutSec":900}'
```

执行器会：

1. 把指令写入 UTF-8 goal 文件；
2. 调用 `mika task run --goal-file ... --json`，获得 `task_id`；
3. 循环 `mika task wait <id> --timeout 45 --json`，通过 `progress` 消息回报；
4. 完成时返回 Mika 的结果文本、`task_id`、`verified`（若手机提供）和附件；
5. 若 Mika 进入 `waiting_for_answer` 或 `waiting_on_phone`，任务会失败并说明需要在手机上处理
   （支付、登录验证码、手机接管等不会被远程自动批准）。

Mika 的 JSON 状态：`starting / queued / running / paused / waiting_for_answer / waiting_on_phone / done / failed / cancelled`。
任务超时后手机上的任务仍继续运行，可用 `mika task status <id> --json` 继续查询。

## 5. 注意事项

- **手机任务不会被自动批准支付/验证码/手机接管**：这些必须由你在手机上处理；
- 远程任务只能操作 Mika 能访问的 App/网页；系统限制的页面（密码、支付）需要接管；
- Wi-Fi 模式是明文 HTTP，只在可信内网/私有 VPN 使用；token 不要写进日志/截图；
- 单机并发上限 1（手机同一时间只做一件事）；
- Mika 的 `ask` 模式更安全；生产环境建议保留「花钱前确认」；
- Mika 为 Apache-2.0 外部项目，本项目不包含其代码/APK（见 [CREDITS.md](../CREDITS.md)）。

## 6. 故障排查

| 现象 | 处理 |
| --- | --- |
| `adb_unavailable` / `adb` | 安装 platform-tools，`adb devices` 能看到手机 |
| `unauthorized` | 手机上允许 USB 调试 |
| `stale_connection` | 手机重启过：重新 `mika connect` |
| `connection_info` | 解锁手机、打开一次 Mika，再 `connect` |
| `incompatible_api` | 更新 Mika APK（需要 task API v1） |
| 任务 409 / 需要回答 | 在手机上回答；或让管家重新发任务并带上完整约束 |
| 设备离线 | 检查桥电脑上的代理、Hub IP、加入码与防火墙 |
