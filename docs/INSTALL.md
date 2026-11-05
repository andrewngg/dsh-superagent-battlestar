# 安装指南：母机与工作机

BattleStar采用「一台母机 + 多台工作机」结构：

| 角色 | 跑什么 | 作用 |
| --- | --- | --- |
| **母机（Hub）** | `hub/server.js` | 设备注册、能力清单、在线检测、任务路由、任务历史、Web/手机控制台、SSE |
| **工作机（Worker）** | `device-agent/agent.js` | 申报自己的能力（models/profiles/gateways/skills），领任务并通过本机执行器执行 |
| **手机工作机（Mika）** | 手机上的 Mika + 电脑上的桥接代理 | 作为工作机，执行 App / 网页 / 手机操作任务 |
| **手机控制端** | APK / 浏览器 | 查看设备状态、发指令、看任务进度（不执行 AI 任务） |

母机可以是一台常开的 NAS、小主机或旧笔记本；工作机是实际跑 AI/ComfyUI/Mika 的电脑或手机桥。
**Mika 手机属于工作机**；BattleStar APK 属于控制端，两者是不同角色（可以在同一部手机上）。
所有组件零 npm 依赖，只需 Node.js ≥ 18。

---

## 一、安装母机（Hub）

### 1. 准备

- 一台常开的设备（Windows / Linux / macOS），Node.js ≥ 18；
- 家庭内网固定 IP（推荐路由器 DHCP 保留），例如 `192.168.1.10`；
- 不需要公网端口；不要把 7317 暴露到公网。

### 2. 获取项目

```bash
git clone https://github.com/andrewngg/dsh-superagent-battlestar.git super-butler
cd super-butler
```

也可以直接下载 Release 源码包解压。

### 3. 启动母机

```bash
node hub/server.js --port 7317 --host 0.0.0.0 --data-dir hub/data
```

首次启动会打印：

```
管理员令牌  adm_...
加入码      join_...
手机控制台  http://192.168.1.10:7317/m?token=adm_...
本机控制台  http://127.0.0.1:7317/?token=adm_...
数据目录    .../hub/data
```

- **管理员令牌**：手机/Web 控制台与 API 使用；
- **加入码**：工作机注册使用；
- 令牌与加入码保存在 `hub/data/state.json`，请备份，不要提交到 Git。

### 4. 验证

```bash
curl http://192.168.1.10:7317/api/health
curl -H "X-Butler-Token: <管理员令牌>" http://192.168.1.10:7317/api/devices
```

浏览器打开控制台：

```
http://192.168.1.10:7317/?token=<管理员令牌>
http://192.168.1.10:7317/m?token=<管理员令牌>
```

### 5. 开机自启（可选）

**Windows（任务计划程序）**：程序 `node`，参数 `"C:\path\to\super-butler\hub\server.js" --port 7317`，起始目录为项目根。

**Linux（systemd）**：

```ini
[Unit]
Description=BattleStar Hub
After=network-online.target

[Service]
WorkingDirectory=/opt/super-butler
ExecStart=/usr/bin/node hub/server.js --host 0.0.0.0 --port 7317
Restart=always
Environment=BUTLER_ADMIN_TOKEN=change-me
Environment=BUTLER_JOIN_CODE=home-join

[Install]
WantedBy=multi-user.target
```

### 6. 安装 DSH 插件（可选，推荐）

在装有 DeepSeek Harness 的母机上，把 `dsh-plugin/` 安装为 bundle：

```
plugin_manager(action: "install_bundle", target: "<abs>/super-butler/dsh-plugin")
```

刷新 DSH 页面后，侧边栏出现「BattleStar」，可在插件面板里：
- 启动/停止/查看 Hub；
- 管理设备与任务、发指令；
- 保存 GitHub / 模型 API 密钥（Harness credentials，非项目文件）。

插件配置里的 `projectRoot` 应指向本项目目录；不填时默认 `~/super-butler`，也可设置环境变量
`SUPER_BUTLER_PROJECT_ROOT`。详见 [DSH-PLUGIN.md](DSH-PLUGIN.md)。

---

## 二、安装工作机（Worker）

> 想让工作机上的 AI 自动完成配置？直接让它读取 [WORKER-SETUP.md](WORKER-SETUP.md)；
> 它会检查环境、选执行器、写配置、注册到母机并验证。你只需要提供母机 URL、加入码和角色。

工作机按能力选择执行器。以下任选一种或组合。

### 通用步骤

1. 安装 Node.js ≥ 18；
2. 复制/克隆项目到工作机（至少需要 `device-agent/` 与 `shared/`，推荐整个项目）；
3. 复制对应的示例配置并修改；
4. 用母机的加入码启动代理；
5. 到母机控制台确认设备在线与能力清单。

```bash
node device-agent/agent.js \
  --hub http://<母机IP>:7317 \
  --join-code <加入码> \
  --config device-agent/configs/<你的配置>.json \
  --state-dir device-agent/.state/<设备名>
```

设备令牌保存在 `.state/`，重启不会重复占号。

### 工作机 A：本机 AI CLI（Hermes / OpenCode / shell）

适合装有 Hermes CLI、OpenCode CLI 或其它本机 Agent 的电脑。执行器 `cli` 会真实调用 CLI，
不是模拟。

1. 复制 [`device-agent/configs/cli-machine.example.json`](../device-agent/configs/cli-machine.example.json) 为 `cli-machine.json`；
2. 修改：
   - `name`：设备名；
   - `executor.cli.workdir`：任务工作目录；
   - `executor.cli.hermes.home` / `opencode.exe`：本机安装路径（按实际填写）；
   - `allowShell`：是否允许 `!命令` / `/run` 直接执行（默认建议 `false`，需要时再开）；
3. 启动代理。

示例配置已申报 `code-writing`、`cli-exec`、`research`、`office-*` 等技能。
需要在多台机器间区分 profile 时，通过任务 `requirements.profile` 指定。

> Hermes 使用 `--yolo` 自动批准工具调用、`allowShell` 会执行命令；只应在可信内网、
> 受控任务下启用。不要对公网暴露 Hub。

### 工作机 B：ComfyUI 图像/视频生成

适合有 GPU、跑了 ComfyUI 的电脑。

1. 在 ComfyUI 打开工作流 → 开发者模式 → **Save (API Format)** 导出 JSON；
2. 复制 [`device-agent/configs/comfyui-machine.example.json`](../device-agent/configs/comfyui-machine.example.json) 为 `comfyui-machine.json`；
3. 修改 `baseUrl`、`workflowFile`、`promptNodeId`、`negativeNodeId`、`seedNodeId`、`outputDir`；
4. 启动代理。

任务示例：

```bash
curl -X POST http://<母机IP>:7317/api/tasks \
  -H "X-Butler-Token: <管理员令牌>" -H "Content-Type: application/json" \
  -d '{"instruction":"生成一张赛博朋克风格的家庭客厅，16:9","requirements":{"skills":["image-generation"]},"timeoutSec":900}'
```

图片保存在 ComfyUI 工作机的 `outputDir`，任务结果列出本地路径；详见 [SECOND-MACHINE.md](SECOND-MACHINE.md)。

### 工作机 C：手机工作机（Mika）

适合用 [Mika](https://github.com/wangzan101/Mika) 操作 Android 手机。**这里是工作机**：手机本身运行 Mika，
一台连着手机（USB/ADB）或同一 Wi-Fi 的电脑运行「Mika 桥」设备代理。

1. 手机安装 Mika APK，配置模型，按需完成手机控制；打开 Settings › Connect a computer；
2. 电脑安装 Mika CLI（`pipx install ...` 或使用仓库里的 `tools/mika/scripts/mika_cli.py`）与 `adb`；
3. 验证：`mika devices --json` → `mika connect --device <SERIAL> --json` → `mika doctor ...`；
4. 复制 [`device-agent/configs/phone-mika.example.json`](../device-agent/configs/phone-mika.example.json)
   为 `phone-mika.json`，填写 `device` 或 `url`/`tokenFile`；
5. 启动代理。

任务示例：

```bash
curl -X POST http://<母机IP>:7317/api/tasks \
  -H "X-Butler-Token: <管理员令牌>" -H "Content-Type: application/json" \
  -d '{"instruction":"打开手机设置，查看当前电量并截图回报","requirements":{"skills":["phone-control","screenshot"]},"timeoutSec":600}'
```

需要回答、验证码、支付或手机接管时任务会明确失败/暂停，不会被远程自动批准；详见 [MIKA-PHONE.md](MIKA-PHONE.md)。

### 工作机 D：Ollama / 自定义 HTTP

- Ollama：`executor.type = "ollama"`，代理自动探测 `/api/tags`；
- 已有本地 Agent 服务：`executor.type = "http"`，POST 到该服务；
- 自定义命令：`executor.type = "shell"` 或 `dsh-cli`。

示例见 [DEPLOY.md](DEPLOY.md) 与 `device-agent/config.example.json`。

---

## 三、手机控制端（APK / 浏览器）接入

> 这里只是控制端，不执行任务；手机工作机是上面的 Mika。

两种方式：

1. 手机浏览器打开 `http://<母机IP>:7317/m?token=<管理员令牌>`，可添加到主屏幕；
2. 安装 APK：从 Releases 下载 `SuperButler-*.apk`，首次填写 Hub 地址与管理员令牌。

APK 构建与签名见 [APK.md](APK.md)。

---

## 四、验收清单

- [ ] `GET /api/health` 返回 `ok: true`
- [ ] 母机启动日志里的令牌/加入码已保存
- [ ] 至少一台工作机在线，`/api/devices` 能看到完整 capabilities
- [ ] 发一条需要技能的任务，落到正确工作机并完成
- [ ] 停掉工作机 30s 后控制台显示离线，任务可重派/排队
- [ ] 手机控制台能查看状态、发指令
- [ ] 不把 `hub/data`、`device-agent/.state`、`android/keystore`、`toolchain` 提交到 Git

## 五、安全基线

- 只在家庭内网/私有 VPN 使用，不要把 Hub 或 ComfyUI 暴露到公网；
- 管理员令牌、加入码、模型 API Key 不要写进仓库或截图；
- 设备执行器（`cli`/`shell`/ComfyUI）由设备主人配置，Hub 不下发任意代码；
- 手机 Mika 的支付、验证码、手机接管保留人工确认；
- 生产环境建议用反向代理 + HTTPS 访问 Hub，并限制来源 IP。
