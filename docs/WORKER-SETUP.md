# 工作机 AI 自动配置指南（WORKER-SETUP）

> **给工作机上的 AI Agent 读的文件。**
> 目标：在本机自动完成「检查环境 → 选择执行器 → 写配置 → 注册到母机 → 验证在线 → 设置自启 → 汇报」。
> 只把本机接入母机；Hub **不需要**知道工作机的 IP 或开放端口。

---

## 0. 先向用户要这几项（只问一次，不要猜）

| 变量 | 必填 | 示例 | 说明 |
| --- | --- | --- | --- |
| `HUB_URL` | 是 | `http://192.168.1.10:7317` | 母机地址，工作机必须能访问 |
| `JOIN_CODE` | 是 | `join_xxxxxxxx` | 母机启动日志里的「加入码」 |
| `ROLE` | 是 | `cli` / `comfyui` / `mika` / `ollama` / `http` | 本机要承担的工作机类型 |
| `DEVICE_NAME` | 否 | `书房工作站` | 默认用主机名 |
| `ADMIN_TOKEN` | 否 | `adm_...` | 仅用于**验证**设备是否上线、发测试任务；保存时不要打印 |
| 本机 IP / 端口 | **不需要** | — | 工作机主动连母机，Hub 不反向连接工作机 |

> 如果用户只给了 `HUB_URL` 和 `JOIN_CODE`，没有 `ADMIN_TOKEN`，也能完成注册；验证步骤改为看代理日志，并请用户在母机控制台确认。

**母机接口**（默认同源，工作机不需要单独配置 API 路径，设备代理已封装）：

| 用途 | 方法与路径 |
| --- | --- |
| 健康检查 | `GET <HUB_URL>/api/health` |
| 注册（首次，带加入码） | `POST <HUB_URL>/api/devices/register` |
| 心跳 | `POST <HUB_URL>/api/devices/:id/heartbeat` |
| 长轮询领命令 | `GET <HUB_URL>/api/devices/:id/commands?waitMs=25000` |
| 回报 ack / progress / result | `POST <HUB_URL>/api/devices/:id/tasks/:taskId/...` |

**不会需要的**：母机对工作机的入站连接、端口映射、工作机公网 IP。只有 Mika 桥需要本机连手机（ADB/Wi-Fi），ComfyUI 需要本机访问 `127.0.0.1:8188`，都与母机无关。

---

## 1. 读取仓库内这些文件

在工作机上的本仓库根目录，先读：

1. `README.md` — 项目与安装总览；
2. `docs/INSTALL.md` — 母机/工作机安装流程；
3. `docs/PROTOCOL.md` §3（manifest 字段）与 §5.2/§5.3（注册、心跳、命令）；
4. `device-agent/README.md` — 代理参数与执行器；
5. 对应执行器的示例配置：
   - CLI：`device-agent/configs/cli-machine.example.json`
   - ComfyUI：`device-agent/configs/comfyui-machine.example.json`
   - Mika：`device-agent/configs/phone-mika.example.json`
   - Ollama / HTTP：`device-agent/config.example.json`
6. 完成后再读 `device-agent/lib/executors.js` 的相关执行器实现（只在排错时读，不要修改）。
   `device-agent/cli-worker.js` 是 CLI 执行器的实际调度器。

---

## 2. 检查本机环境

```powershell
# Windows
node -v
npm -v
Get-Command node | Select-Object Source
Test-Path device-agent/agent.js
Test-Path shared/protocol.js
```

```bash
# Linux / macOS
node -v
test -f device-agent/agent.js && test -f shared/protocol.js && echo repo-ok
```

要求 Node.js ≥ 18。若工作机只复制了部分文件，至少需要：

```
device-agent/
shared/protocol.js
```

推荐复制/克隆整个仓库：

```bash
git clone https://github.com/andrewngg/dsh-superagent-battlestar.git super-butler
cd super-butler
```

---

## 3. 连通性检查（先于注册）

```powershell
Invoke-RestMethod http://<HUB_URL>/api/health
```

期望：

```json
{"ok":true,"name":"BattleStar","version":"0.1.0","protocol":1}
```

失败时按顺序检查：

- 母机 Hub 是否运行、端口是否为 7317；
- 工作机与母机是否同网段 / 同一 VPN（Tailscale、WireGuard）；
- 母机防火墙是否放行 7317（Windows 专用网络）；
- `HUB_URL` 是否写成了 `127.0.0.1`（工作机上不能用回环地址访问母机）。

---

## 4. 选择角色并写配置

复制对应模板到 `device-agent/configs/worker.json`（或 `<角色>.json`），**所有路径用绝对路径**。

### 4.1 CLI 工作机（Hermes / OpenCode / shell）

```powershell
Copy-Item device-agent/configs/cli-machine.example.json device-agent/configs/worker.json
```

需要修改：

- `name` → `DEVICE_NAME`；
- `executor.cli.workdir` → 任务工作目录（如 `C:/work`）；
- `executor.cli.hermes.home` / `exe` → 本机 Hermes 安装位置（没有就留空/删除）；
- `executor.cli.opencode.exe` → 本机 OpenCode 可执行文件（没有就留空/删除）；
- 是否允许 shell：`allowShell` 默认 `false`；只有用户明确允许本机命令时才改 `true`；
- 不再使用的模型/技能可删除，保留本机真实具备的。

自检：

```powershell
node -e "const {normalizeManifest}=require('./shared/protocol.js'); const c=JSON.parse(require('fs').readFileSync('device-agent/configs/worker.json','utf8')); const r=normalizeManifest(c); console.log(r.errors, r.warnings)"
```

### 4.2 ComfyUI 工作机

```powershell
Copy-Item device-agent/configs/comfyui-machine.example.json device-agent/configs/worker.json
```

需要修改：

- `executor.comfyui.baseUrl` → 本机 ComfyUI（默认 `http://127.0.0.1:8188`）；
- `executor.comfyui.workflowFile` → ComfyUI **API 格式**工作流 JSON 的绝对路径；
- `promptNodeId` / `negativeNodeId` / `seedNodeId` → 工作流 API JSON 里对应节点的键；
- `executor.comfyui.outputDir` → 生成图片保存目录（绝对路径）；
- `name`、`resources` 按实际填写。

先在浏览器/curl 验证 ComfyUI：

```powershell
Invoke-RestMethod http://127.0.0.1:8188/system_stats
```

### 4.3 手机工作机（Mika）

Mika 手机是工作机；本机是「Mika 桥」。先按 `docs/MIKA-PHONE.md` 完成：

```powershell
mika devices --json
mika connect --device <SERIAL> --json
mika doctor --device <SERIAL> --json
```

然后：

```powershell
Copy-Item device-agent/configs/phone-mika.example.json device-agent/configs/worker.json
```

修改：

- `executor.mika.device` → ADB serial（USB 模式）；
- 或 `executor.mika.url` + `executor.mika.tokenFile`（Wi-Fi 模式）；
- 如果只用 Mika 仓库里的脚本：`command: "py"`, `commandArgs: ["-3", "C:\\path\\to\\mika_cli.py"]`；
- `name` 改成手机名，如 `手机工作机 · Pixel`。

### 4.4 Ollama / HTTP

- Ollama：`executor.type = "ollama"`，代理会自动探测 `http://127.0.0.1:11434/api/tags`；
- 已有本地 Agent 服务：`executor.type = "http"`，`url` 指向本机服务；
- 配置写法参考 `device-agent/config.example.json`。

---

## 5. 注册到母机

> 注册是工作机发起的出站 HTTP 请求：`POST <HUB_URL>/api/devices/register`，携带加入码。
> Hub 不会连接工作机。

```powershell
# 前台启动（先验证）
node device-agent/agent.js `
  --hub "<HUB_URL>" `
  --join-code "<JOIN_CODE>" `
  --config device-agent/configs/worker.json `
  --state-dir device-agent/.state/worker
```

成功日志应包含：

```
设备已注册：<设备名>（deviceId=dev_...，令牌保存至 ...）
已连接 Hub <HUB_URL>｜心跳 10000ms｜长轮询 25000ms｜并发上限 ...
```

首次注册后，设备令牌保存在 `device-agent/.state/worker/`；重启会复用，不会重复占号。

### 保持运行（推荐）

- Windows：`Start-Process node -ArgumentList ... -WindowStyle Hidden`，或任务计划程序；
- Linux：systemd 服务（见 `docs/INSTALL.md`）；
- 验证阶段可先放前台；确认后再设置自启。

---

## 6. 验证

### 有 ADMIN_TOKEN 时

```powershell
$headers = @{ 'X-Butler-Token' = '<ADMIN_TOKEN>' }
$devices = Invoke-RestMethod "<HUB_URL>/api/devices" -Headers $headers
$devices.devices | Select-Object name, online, kind, platform, @{n='models';e={$_.capabilities.models.Count}}, @{n='skills';e={$_.capabilities.skills.Count}}
```

应看到本设备 `online: true`，且 models / profiles / gateways / skills 与配置一致。

发一条烟雾任务：

```powershell
$body = @{
  instruction = "回复：worker online"
  requirements = @{ skills = @("<本机真实技能，例如 cli-exec>") }
  timeoutSec = 60
} | ConvertTo-Json -Depth 5
Invoke-RestMethod "<HUB_URL>/api/tasks" -Method POST -Headers $headers -ContentType 'application/json' -Body $body
```

### 没有 ADMIN_TOKEN 时

- 代理前台日志出现「设备已注册」+「已连接 Hub」即可；
- 请用户在母机控制台 / `/api/devices` 确认在线；
- 不要为了验证去猜测或索要管理员令牌。

---

## 7. 汇报格式（完成后发给用户）

```text
工作机配置完成
- 设备名：<DEVICE_NAME>
- deviceId：dev_...
- 角色/执行器：cli|comfyui|mika|ollama|http
- Hub：<HUB_URL>
- 能力：models=... / profiles=... / gateways=... / skills=...
- 配置：device-agent/configs/worker.json
- 状态文件：device-agent/.state/worker/
- 启动方式：前台已验证 / 已设置自启
- 验证：日志已连接 / API 显示 online / 测试任务 completed
- 未完成/需要用户操作：<如有>
```

---

## 8. 完成标准

- [ ] `HUB_URL` 的 `/api/health` 返回 ok；
- [ ] `worker.json` 通过 `normalizeManifest` 校验（errors 为空）；
- [ ] 代理日志显示注册成功并保持心跳；
- [ ] 母机 `/api/devices` 显示设备在线且能力正确；
- [ ] 至少一条测试任务完成；
- [ ] 需要时已设置开机自启；
- [ ] 没有把 `hub/data`、`.state/`、API Key、加入码写入仓库或日志。

---

## 9. 不要做的事

- 不要让工作机暴露入站端口给 Hub；Hub 只通过工作机主动发起的连接通信；
- 不要把 `JOIN_CODE`、管理员令牌、模型 API Key 写进 README、截图或提交到 Git；
- 不要默认打开 `allowShell` 或 Hermes `--yolo`；需要时由用户明确同意；
- 不要用 `simulate` 冒充真实执行器做验收；
- 不要在未确认 ComfyUI 工作流节点 ID 的情况下直接发图任务。

---

## 10. 复制给 AI 的启动提示

```text
读取本仓库的 docs/WORKER-SETUP.md，把本机配置成BattleStar的「工作机」并自动注册到母机。
母机：http://<HUB_IP>:7317
加入码：<JOIN_CODE>
角色：cli（或 comfyui / mika / ollama / http）
设备名：<DEVICE_NAME>
可选管理员令牌（仅用于验证）：<ADMIN_TOKEN 或留空>
按文件里的步骤执行，完成后按第 7 节格式汇报。
```
