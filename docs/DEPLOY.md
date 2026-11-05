# 部署指南（家庭内网）

BattleStar是**私有部署**：一台常开设备跑 Hub，其余设备跑设备代理，手机通过 APK 或浏览器接入。
全部组件零 npm 依赖，只需要 Node.js ≥ 18。

## 1. 网络拓扑建议

```
                    家庭路由器 / Wi-Fi
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
   Hub（NAS/小主机）    书房工作站         客厅媒体中心
   固定 IP .10          .20                .30
   7317 端口            设备代理            设备代理
        │
   手机（同一 Wi-Fi / Tailscale）
```

- 给 Hub 设**固定 IP**（路由器 DHCP 保留），手机与设备都用这个地址。
- 设备代理只主动连 Hub（出站），不需要在设备上开端口。
- 不在同一网段时，可用 Tailscale / WireGuard / ZeroTier 组虚拟内网，把 Hub 地址换成虚拟 IP。
- **不要把 7317 直接映射到公网**；如需外网访问，用反向代理 + HTTPS + 强令牌。

## 2. Hub 部署

### 2.1 准备

- 任意 Windows / Linux / macOS 设备，Node.js ≥ 18（推荐 20 LTS+）。
- 项目目录：把整个 `super-butler/` 复制到 Hub 设备（或 `git clone` 后进入目录）。

### 2.2 启动

```bash
# Windows PowerShell
node hub\server.js --port 7317 --host 0.0.0.0

# Linux / macOS
node hub/server.js --port 7317 --host 0.0.0.0
```

启动日志会打印：

```
  BattleStar Hub  已启动
  控制台     http://127.0.0.1:7317/?token=<adminToken>
  手机端     http://192.168.1.10:7317/m?token=<adminToken>
  局域网     http://192.168.1.10:7317
  加入码     <joinCode>
  数据目录   .../hub/data
```

首次启动自动生成 `adminToken` 与 `joinCode`，保存在 `hub/data/state.json`（请备份并妥善保管）。

### 2.3 环境变量（可选）

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `BUTLER_ADMIN_TOKEN` | 固定管理员令牌（便于自动化/部署） | 首次随机生成 |
| `BUTLER_JOIN_CODE` | 固定设备加入码 | 首次随机生成 |
| `BUTLER_PORT` / `BUTLER_HOST` | 监听端口/地址 | `7317` / `0.0.0.0` |
| `BUTLER_DATA_DIR` | 数据目录 | `hub/data` |
| `BUTLER_TTL_MS` | 设备离线判定 TTL | `30000` |

### 2.4 开机自启

**Windows（任务计划程序）**

1. 任务计划程序 → 创建任务 → 触发器「登录时」/「启动时」。
2. 操作：程序 `node`，参数 `"C:\path\to\super-butler\hub\server.js" --port 7317`，起始于 `C:\path\to\super-butler`。
3. 勾选「不管用户是否登录都要运行」（需要时）与「失败后重启」。

**Linux（systemd）**

```ini
# /etc/systemd/system/super-butler.service
[Unit]
Description=BattleStar Hub
After=network-online.target

[Service]
WorkingDirectory=/opt/super-butler
ExecStart=/usr/bin/node hub/server.js --host 0.0.0.0 --port 7317
Restart=always
Environment=BUTLER_ADMIN_TOKEN=change-me-please
Environment=BUTLER_JOIN_CODE=home-join-code

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now super-butler
sudo systemctl status super-butler
```

**防火墙**：放行内网 7317/TCP。Windows 首次运行会弹防火墙提示，选择「专用网络」允许。

### 2.5 健康检查

```bash
curl http://192.168.1.10:7317/api/health
# {"ok":true,"name":"BattleStar","version":"0.1.0","protocol":1,...}
```

## 3. 设备接入（每台 AI 设备一次）

### 3.1 复制代理

把 `device-agent/` 与 `shared/` 目录复制到设备（保持相对位置），或直接复制整个项目。
设备需要 Node.js ≥ 18。

### 3.2 生成配置

```bash
# 先看示例
cat device-agent/config.example.json
```

`config.example.json` 关键字段：

```jsonc
{
  "hub": "http://192.168.1.10:7317",
  "joinCode": "<启动日志里的加入码>",
  "name": "书房工作站",
  "executor": { "type": "simulate" },          // 演示用；真实设备改成 cli / dsh-cli / http / ollama
  "capabilities": {
    "models": [{ "id": "deepseek-chat", "provider": "deepseek", "strengths": ["code"] }],
    "profiles": [{ "id": "desktop" }],
    "gateways": [{ "id": "openai-gateway", "kind": "openai-compatible" }],
    "skills": [{ "id": "office-docx", "name": "Word 文档" }],
    "limits": { "maxConcurrentTasks": 2 }
  }
}
```

> 有 DSH 的设备：代理默认会扫描 `~/.dsh`（profiles、gateways、skills、模型配置）自动申报，`config.capabilities` 只用于补充/覆盖。
> 装了 Ollama 的设备：代理会自动探测 `http://127.0.0.1:11434/api/tags`，把本地模型加入申报。

### 3.3 启动代理

```bash
node device-agent/agent.js --config device-agent/config.json
# 或纯命令行
node device-agent/agent.js --hub http://192.168.1.10:7317 --join-code <joinCode> --name "书房工作站"
```

首次注册后，`deviceId/deviceToken` 保存在状态文件（默认 `~/.super-butler/<name>.json`），重启自动恢复。

### 3.4 真实执行器配置

| 执行器 | 适用 | 配置 |
| --- | --- | --- |
| `simulate` | 演示 / 联调 | 默认，无需额外配置 |
| `cli` | 本机装有 Hermes / OpenCode CLI（推荐，见 [FIRST-MACHINE.md](FIRST-MACHINE.md)） | `"executor": {"type":"cli","cli":{"mode":"auto","workdir":"C:\\work","allowShell":false,"hermes":{"home":"C:\\Users\\me\\AppData\\Local\\hermes"},"opencode":{"model":"deepseek/deepseek-flash"},"fallbackToHermes":true}}` |
| `dsh-cli` | 设备上安装了 DeepSeek Harness CLI | `"executor": {"type":"dsh-cli","command":"dsh run --print {instruction}","timeoutSec":280}` |
| `http` | 设备上已有自己的 Agent 服务 | `"executor": {"type":"http","url":"http://127.0.0.1:7788/execute"}` |
| `ollama` | 本地 Ollama 模型 | `"executor": {"type":"ollama","model":"qwen2.5:7b"}` |
| `comfyui` | 本机 ComfyUI（图像/视频生成） | `"executor": {"type":"comfyui","comfyui":{"baseUrl":"http://127.0.0.1:8188","workflowFile":"...json","promptNodeId":"6"}}` |
| `mika` | 通过 Mika 指挥 Android 手机 | `"executor": {"type":"mika","mika":{"command":"mika","device":"SERIAL","timeoutMs":900000}}` |
| `shell` | 自定义脚本 | `"executor": {"type":"shell","command":"python C:\\scripts\\task.py {instruction}"}` |

`{instruction}` 会被替换为任务指令；命令模板由设备主自己控制，Hub 不会执行任意代码。

### 3.5 开机自启

- **Windows**：任务计划程序，程序 `node`，参数 `device-agent\agent.js --config device-agent\config.json`，起始目录为项目根。
- **Linux**：systemd 服务，`ExecStart=/usr/bin/node /opt/super-butler/device-agent/agent.js --config /opt/super-butler/device-agent/config.json`。

## 4. 手机接入

### 4.1 安装 APK

把 `dist/BattleStar-0.1.0.apk` 传到手机安装（允许「安装未知来源应用」）。
或使用 adb：

```bash
adb install -r dist/BattleStar-0.1.0.apk
```

### 4.2 首次连接

1. 打开「BattleStar」。
2. 填写 Hub 地址（如 `http://192.168.1.10:7317`）与管理员令牌（启动日志里的 `adminToken`）。
3. 点「测试连接」→「进入管家」。
4. 之后启动自动直连；在应用内「设置」可修改地址/令牌或退出。

### 4.3 也可以直接用浏览器

手机浏览器打开 `http://192.168.1.10:7317/m?token=<adminToken>`，可「添加到主屏幕」当 PWA 用。

## 5. 验证部署

```bash
# 1. Hub 健康
curl http://192.168.1.10:7317/api/health

# 2. 设备是否在线（需要管理员令牌）
curl -H "X-Butler-Token: <adminToken>" http://192.168.1.10:7317/api/devices

# 3. 发一个任务
curl -X POST http://192.168.1.10:7317/api/tasks \
  -H "X-Butler-Token: <adminToken>" -H "Content-Type: application/json" \
  -d '{"instruction":"整理本周家庭开支，生成 Word 报告","requirements":{"skills":["office-docx"]}}'
```

然后在手机或控制台观察任务从 `queued → assigned → running → completed`。

## 6. 故障排查

| 现象 | 排查 |
| --- | --- |
| 手机打不开页面 | Hub 是否监听 `0.0.0.0`；防火墙是否放行 7317；手机与 Hub 是否同网段 |
| 设备注册 401 | 加入码错误/过期；或该 `deviceId` 的本地令牌与 Hub 不一致（删除本地状态文件重新注册） |
| 设备显示离线 | 代理进程是否存活；心跳间隔是否被系统休眠；检查 Hub 日志与 TTL |
| 任务一直 queued | 看 `task.route.excluded` 的原因（缺 model/skill、设备离线、满载） |
| 任务失败 | 看任务事件时间线与设备代理日志；执行器命令模板是否正确 |
| 令牌泄露 | 停止 Hub，删除 `hub/data/state.json` 中对应令牌/重新生成（所有手机需重新输入） |
