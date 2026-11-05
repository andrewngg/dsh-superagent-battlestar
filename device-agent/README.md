# BattleStar 设备代理（device-agent）

零依赖、Node 18+、CommonJS。遵循 `docs/PROTOCOL.md` 与 `shared/protocol.js`，向 Hub 申报能力、心跳、领任务并执行。

## 快速开始

```powershell
# 1. 启动 Hub（另一个终端）
node hub/server.js

# 2. 用 Hub 启动日志里的加入码注册设备（自动探测本机 DSH / Ollama 能力）
node device-agent/agent.js --hub http://127.0.0.1:7317 --join-code <加入码> --name 书房工作站

# 演示执行器（不真正调用外部服务），指定能力清单与执行器
node device-agent/agent.js --hub http://127.0.0.1:7317 --join-code <加入码> `
  --name 书房工作站 --config device-agent/config.example.json

# 单次运行（注册→心跳→领一次命令→执行→退出），适合调试/CI
node device-agent/agent.js --hub http://127.0.0.1:7317 --join-code <加入码> --once
```

一键 Demo（自动启动 Hub + 3 台模拟设备，打印控制台/手机 URL）：

```powershell
node scripts/demo.js                    # Hub + 3 台设备
node scripts/demo.js --no-hub           # 仅设备（Hub 已运行）
node scripts/demo.js --port 7318 --no-sample
node scripts/demo.js --duration 10      # 自动化验证：10 秒后自动退出
```

## CLI 参数

| 参数 | 说明 |
| --- | --- |
| `--hub <url>` | Hub 地址，默认 `http://127.0.0.1:7317` |
| `--join-code <code>` | 首次注册加入码（或环境变量 `BUTLER_JOIN_CODE`） |
| `--name <name>` | 设备名，默认主机名 |
| `--config <file>` | JSON 配置（能力覆盖 / 执行器 / 探测开关） |
| `--state-dir <dir>` | 状态目录，默认 `~/.super-butler`（环境变量 `BUTLER_STATE_DIR`） |
| `--state-file <file>` | 直接指定状态文件 |
| `--interval <ms>` | 心跳间隔，默认 10000 |
| `--poll-wait <ms>` | 空闲长轮询等待，默认 25000（上限 30000） |
| `--once` / `--once-wait <ms>` | 单次运行与长轮询等待 |
| `--executor <type>` | `simulate`（默认）/ `cli` / `dsh-cli` / `shell` / `http` / `ollama` / `comfyui` / `mika` |
| `--kind/--platform/--tag` | 覆盖 manifest 字段（`--tag` 可重复） |
| `--no-dsh` / `--no-ollama` | 跳过对应能力探测 |
| `--dsh-home` / `--ollama-host` | 覆盖 `DSH_HOME` / `OLLAMA_HOST` |
| `--log-level <level>` | `debug` / `info` / `warn` / `error` / `silent` |

SIGINT（Ctrl+C）会优雅注销设备后退出；发送两次强制退出（退出码 130）。

## 能力探测（lib/discovery.js）

- **DSH**：扫描 `~/.dsh`（`DSH_HOME` 可覆盖）：
  - `profiles/<id>/package.json`（`dsh.profile.bundles` + `dependencies`）与 `cordis*.yml` 的 `name:` 插件名；
  - `cordis.patch.yml` / `settings*.yaml` 中的 `provider:` / `model:` 字段（启发式，不解析完整 YAML）；
  - `openai-gateway/`（默认 `http://127.0.0.1:8787/v1`，可用 `DSH_OPENAI_GATEWAY_URL`/`OPENAI_GATEWAY_URL` 覆盖；会探测 `/models`）；
  - `skills/` 目录（`SKILL.md` / `package.json`）。
- **Ollama**：`GET {OLLAMA_HOST:-http://127.0.0.1:11434}/api/tags`，成功则把模型并入 `models`（provider=`ollama`）。
- 探测失败只产生 `warnings`，不会崩；`--config` 显式字段优先，数组按 `id` 合并去重，`replaceArrays` 可整组替换。

## 执行器（lib/executors.js）

统一接口：`run({ task, command, device, signal, progress, log }) -> { output, error? }`。

- `simulate`（默认）：按指令关键词生成 3-6 条中文进度与结构化结果（text/markdown/artifacts/data），默认总耗时 2-6s，可被 `executor.simulate` 配置缩短；
- `cli`：调用本机 CLI Agent（`device-agent/cli-worker.js`）：
  - `hermes`：`hermes --cli --yolo -z "<instruction>"`，可执行本机工具命令；
  - `opencode`：`opencode run "<instruction>" -m deepseek/deepseek-flash --format json`，失败可回退 Hermes；
  - `shell`：`pwsh -NoProfile -NonInteractive -Command "<instruction>"`（需 `allowShell: true`）；
  - 由 `requirements.profile`（`hermes` / `hermes-<profile>` / `opencode` / `cli-shell`）或指令前缀（`!` / `/run`）选择后端；输出写入任务 `output.data.backend`；
- `dsh-cli`：命令模板（默认 `dsh run --print {instruction}`），`{instruction}`、`{taskId}`、`{deviceName}`、`{model}`、`{outputFile}` 占位符；输出重定向到临时文件后截断（**不使用 pipe**，Windows 沙箱安全）；超时/取消会 kill 子进程树；
- `shell`：同命令模板机制（默认 `echo {instruction}`）；
- `http`：`POST` 设备本地/内网 endpoint（拒绝指向 Hub 自身），响应 `{ok?, output?, error?}`；
- `ollama`：`POST {OLLAMA_HOST}/api/generate`（`stream:false`）；
- `comfyui`：读取 ComfyUI API 格式工作流，注入正面/负面提示词与随机 seed，`POST /prompt` 后轮询
  `/history/{prompt_id}`，再通过 `/view` 下载图片到 `outputDir`，结果写入 `artifacts`；配置见
  `configs/comfyui-machine.example.json` 与 [docs/SECOND-MACHINE.md](../docs/SECOND-MACHINE.md)；
- `mika`：调用 [Mika](https://github.com/wangzan101/Mika) CLI（`mika task run/wait --json`），让 Android
  手机上的 Mika 执行手机任务，等待完成并返回结果；手机要求回答或接管时任务失败并说明原因，
  支付/验证码不会被远程自动批准。配置见 `configs/phone-mika.example.json` 与 [docs/MIKA-PHONE.md](../docs/MIKA-PHONE.md)。

并发上限取 `manifest.limits.maxConcurrentTasks`；progress 节流 ≥800ms；超时主动 `result(ok:false, error:"timeout")`；收到 `cancel_task` 中止执行并回报 `cancelled`。

## 配置示例

见 `device-agent/config.example.json`（完整能力 + 5 种执行器 + 探测开关）与 `device-agent/capabilities.example.json`（仅 manifest）。

```jsonc
{
  "name": "书房工作站",
  "kind": "dsh",
  "tags": ["书房"],
  "models": [{ "id": "deepseek-chat", "provider": "deepseek", "strengths": ["code"] }],
  "skills": [{ "id": "office-docx", "name": "Word 文档" }],
  "limits": { "maxConcurrentTasks": 2 },
  "executor": {
    "type": "simulate",
    "simulate": { "minDurationMs": 2000, "maxDurationMs": 6000, "minSteps": 3, "maxSteps": 6 },
    "dsh-cli": { "command": "dsh run --print {instruction}", "timeoutMs": 300000, "maxOutputChars": 16000 },
    "http": { "url": "http://127.0.0.1:7788/execute" },
    "ollama": { "baseUrl": "http://127.0.0.1:11434", "model": "qwen2.5" }
  },
  "discovery": { "dsh": true, "ollama": true, "gateway": true, "skills": true }
}
```

## 状态文件

默认 `~/.super-butler/<设备名>@<hub主机>.json`（`--state-dir`/`--state-file` 可覆盖），保存 `deviceId`/`deviceToken`。
重启后优先 `POST /api/devices/:id/manifest` 更新能力；令牌失效（401/403/404）自动回退为加入码重新注册。

## 测试

```powershell
# 标准方式（普通终端）
node --test device-agent/test

# 受限沙箱（DSH 文件沙箱不允许 node:test 子进程 pipe，需要同进程隔离）
node --test --test-isolation=none "device-agent/test/*.test.js"
```

覆盖：discovery 合并/覆盖/容错、state 持久化/损坏恢复、5 种执行器（含超时/截断/取消/节流）、
进程内 Mock Hub 全链路（注册→心跳→领命令→ack→progress→result）、状态恢复不重复占号、
cancel/timeout、令牌失效重注册、`--once`、并发上限。
