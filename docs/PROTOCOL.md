# BattleStar 协议 v1（Hub ⇄ Device ⇄ Phone）

本文件是 **唯一接口契约**。Hub、设备代理、Web/手机端、模拟器与测试都必须遵循它。
协议版本：`1`。所有时间为 ISO-8601 UTC 字符串；所有 ID 为 `前缀_随机串`，例如 `dev_ab12cd34`。
默认端口：`7317`。所有 JSON 均为 UTF-8，请求体上限 1 MiB。

## 1. 角色

```
┌──────────────┐   REST(心跳/命令/结果)    ┌──────────────┐   REST + SSE   ┌─────────────┐
│  设备代理     │ ───────────────────────▶ │  管家中枢 Hub │ ◀───────────── │ 手机 APK/Web │
│ device-agent │ ◀─────────────────────── │  (Node.js)    │ ─────────────▶ │ 控制台       │
└──────────────┘   长轮询 / heartbeat 回包  └──────────────┘                └─────────────┘
```

- **Hub**：设备注册表、能力清单、在线检测、任务编排、事件流、静态 Web 控制台。零第三方依赖。
- **Device Agent**：运行在每台家庭设备上，向 Hub 申报能力（models / profiles / gateways / skills），上报心跳，领取命令，执行并回报。
- **Phone/Web**：查看设备与智能体状态、发指令、看任务进度。Android APK 内嵌 WebView，加载 Hub 的 `/m`。

## 2. 鉴权

| 凭据 | 用途 | 传递方式 |
| --- | --- | --- |
| 管理员令牌 `adminToken` | Web/手机端所有管理接口 | `X-Butler-Token: <token>` 或 `?token=`（仅 SSE/静态页） |
| 加入码 `joinCode` | 新设备首次注册 | `X-Butler-Join-Code: <code>` |
| 设备令牌 `deviceToken` | 已注册设备的心跳/命令/回报 | `X-Butler-Device-Token: <token>` |

- Hub 首次启动生成 `adminToken` 与 `joinCode`，保存到 `hub/data/state.json`，并在控制台启动日志打印。也可用环境变量 `BUTLER_ADMIN_TOKEN` / `BUTLER_JOIN_CODE` 固定。
- 错误格式统一：`{ "error": { "code": "unauthorized|forbidden|not_found|bad_request|conflict|rate_limited|internal", "message": "..." } }`，HTTP 状态码对应 401/403/404/400/409/429/500。
- 设备令牌只能访问自己的 `/api/devices/:id/*` 路径；管理员令牌可访问全部。

## 3. 设备能力申报（Manifest）

设备注册时提交，之后可通过 `POST /api/devices/:id/manifest` 更新。字段：

```jsonc
{
  "name": "书房工作站",              // 必填，1-64 字符
  "platform": "windows",            // windows | macos | linux | android | other
  "kind": "dsh",                    // dsh | ollama | openai-gateway | multi | custom
  "agentVersion": "0.1.0",
  "endpoint": "http://192.168.1.20:7788",  // 可选，设备本地服务地址（供展示/直连）
  "tags": ["书房", "夜间可跑"],       // 可选
  "models": [                       // 可用模型（决定任务能否路由到这里）
    { "id": "deepseek-chat", "provider": "deepseek", "contextWindow": 128000,
      "strengths": ["code", "reasoning"], "available": true }
  ],
  "profiles": [                     // DSH profile / 运行配置
    { "id": "desktop", "name": "DSH Desktop", "plugins": ["@deepseek-ai/dsh-web-app"] }
  ],
  "gateways": [                     // 模型网关 / 代理
    { "id": "openai-gateway", "kind": "openai-compatible",
      "baseUrl": "http://127.0.0.1:8787/v1", "models": ["gpt-4o-mini"] }
  ],
  "skills": [                       // 可执行技能（office/docx、家居、下载……）
    { "id": "office-docx", "name": "Word 文档", "version": "1.2.0" }
  ],
  "resources": { "cpuCores": 12, "memoryGB": 32, "gpu": "RTX 4070", "os": "Windows 11" },
  "limits": { "maxConcurrentTasks": 2 }
}
```

规范化规则（Hub 实现于 `shared/protocol.js`）：

- 数组字段缺省为 `[]`；`models[].available` 缺省 `true`；`limits.maxConcurrentTasks` 缺省 `1`（1-8）。
- `id` 全局唯一（同一设备内）；重复项去重，保留先出现的。
- Hub 会补 `deviceId`、`registeredAt`、`lastSeenAt`、`online`、`status` 等运行字段，**不回写**设备申报内容。
- `models[].id` 与 `skills[].id` 是任务路由键；`profiles[].id`、`gateways[].id` 同理。

## 4. 生命周期

- 心跳间隔默认 10s，Hub 保留 30s（`ttlSec`）。超过 TTL 无心跳 → 标记 `online:false`，并广播 `device.offline`；恢复心跳 → `device.online`。
- 设备状态 `status`：`idle | busy | degraded | offline`。心跳中自报，Hub 只做展示与容量判断。
- 任务状态机：

```
queued ──route──▶ assigned ──ack──▶ running ──result──▶ completed
   ▲                 │                  │
   └──re-route◀──────┘ (ack 超时/设备离线)  └──result(ok:false)──▶ failed
queued/assigned/running ──cancel──▶ cancelled
assigned/running ──timeout──▶ retry（maxAttempts 内自动重排，取消旧执行）──▶ assigned
                              └─ 重试用尽 ──▶ timeout（可人工重试；超时窗口 = timeoutSec，设备 keepalive 可续期）
```

## 5. 端点

### 5.1 公共

`GET /api/health` → `{ ok:true, name:"BattleStar", version, protocol:1, uptimeSec, hubTime }`

### 5.2 设备注册

`POST /api/devices/register`
Headers: `X-Butler-Join-Code`（首次注册必需；携带已注册 `deviceId` + 有效设备令牌时视为更新 manifest，可不用加入码）
Body: manifest（见 §3）
Resp: `{ deviceId, deviceToken, heartbeatIntervalMs:10000, ttlSec:30, hubTime }`

### 5.3 设备运行时（设备令牌）

`POST /api/devices/:id/heartbeat`
Body: `{ status, load:{ running, max }, metrics:{ cpuPct?, memPct?, uptimeSec? }, taskIds?:[] }`
Resp: `{ ok:true, hubTime, heartbeatIntervalMs, ttlSec, commands:[Command] }`（把待执行命令顺带下发，减少延迟）

`POST /api/devices/:id/manifest` → `{ ok:true, device }`

`GET /api/devices/:id/commands?waitMs=25000&limit=5` — 长轮询：有命令立即返回，否则最多挂起 `waitMs`（上限 30000），超时返回空数组。
Resp: `{ commands:[Command] }`

`POST /api/devices/:id/tasks/:taskId/ack`
Body: `{ ok:true }` → `{ ok:true, task }`；幂等。ack 后任务 `assigned → running`。

`POST /api/devices/:id/tasks/:taskId/progress`
Body: `{ message:"正在解析表格…", percent?:0-100, logs?:["…"] }` → `{ ok:true }`
Body（保活）: `{ keepalive:true }` → `{ ok:true }`；只续期该任务的超时窗口（见 §4），不写入进度、不广播事件。
设备在任务执行期间应周期性发送（建议间隔 ≤ timeoutSec/2，默认 15s），Hub 以此判断“设备还活着”。

`POST /api/devices/:id/tasks/:taskId/result`
Body: `{ ok:true|false, output?:{ text?, markdown?, artifacts?:[{name,url?,path?}], data?:any }, error?:string, durationMs?:number }`
→ `{ ok:true, task }`；完成后广播。

`POST /api/devices/:id/unregister` → `{ ok:true }`（标记离线并移除；调试用）

### 5.4 手机/控制台（管理员令牌）

- `GET /api/snapshot?limit=50` → `{ server:{version,uptimeSec,hubTime}, settings:{language}, stats:{...}, devices:[Device], tasks:[Task], goals:[Goal], events:[Event] }`
- `GET /api/settings` → `{ settings:{ language }, supportedLanguages:['zh-CN','en'], hubTime }`
- `PATCH|PUT /api/settings` body `{ language:'zh-CN'|'en' }` → `{ settings, hubTime }`；持久化到 `<dataDir>/settings.json`，并广播 SSE `settings.updated`。
- `GET /api/goals?status=` → `{ goals:[Goal], hubTime }`
- `POST /api/goals` body `{ title, description?, schedule?, requirements? }` → `{ goal, hubTime }`
  - `schedule`: `{ type:'daily', time:'HH:mm' }`（默认）或 `{ type:'interval', minutes:5..10080 }`；缺省为每天 09:00。
  - 生命周期：`active | paused | stopped | completed`；创建默认 `active`，并按计划计算 `nextCheckAt`。
- `GET /api/goals/:id` → `{ goal }`
- `PATCH|PUT /api/goals/:id` body `{ title?, description?, schedule?, status? }` → `{ goal }`；恢复为 `active` 时从当前时间重新排期，不补跑错过的检查。
- `POST /api/goals/:id/check` → `{ goal, task, hubTime }`：立即创建一次跟进任务（`task.goalId` 指向目标）；该目标已有执行中的跟进任务时返回 409。
- `DELETE /api/goals/:id` → `{ ok:true }`（已创建的历史任务保留）。
  - Hub 每 `goalTickMs`（默认 30s）扫描到点的 active 目标，自动创建跟进任务；任务结束后把输出写回目标的 `checks/lastSummary` 并重排下一次。
  - 跟进任务是普通任务（`goalId` 关联），优先级手动 7 / 定时 4，`timeoutSec=600`、`maxAttempts=2`，消耗一条设备并发槽位。
- `GET /api/records?q=&status=&limit=&offset=` → `{ records:[{ taskId,status,createdAt,durationMs,device,summary,error,hasFile,size,updatedAt,file,parentTaskId,isPlan,archived }], total, limit, offset, recordDir }`
- `GET /api/records/:taskId` → `{ record:{ taskId, file, markdown, size, updatedAt, task? } }`；`?format=md` 直接返回 `text/markdown`（附件下载）。
- `GET /api/devices` → `{ devices:[Device], hubTime }`
- `GET /api/devices/:id` → `{ device:Device }`
- `PATCH /api/devices/:id` body `{ name?, tags?, disabled? }` → `{ device }`
- `DELETE /api/devices/:id` → `{ ok:true }`
- `POST /api/tasks` body `{ instruction, requirements?, priority?, timeoutSec?, maxAttempts? }` → `{ task }`
  - `requirements`: `{ model?, skills?:[], profile?, gateway?, tags?:[], deviceId? }`，全部可选；`deviceId` 显式指定设备（仍须在线）。
  - `priority`: 0-9，默认 5；`timeoutSec`: 30-3600，默认 300；`maxAttempts`: 1-3，默认 2。
  - 创建后立即路由；若无匹配设备，任务留在 `queued` 并记录原因，之后设备上线/能力变化时自动重新路由。
- `GET /api/tasks?status=&deviceId=&limit=100` → `{ tasks:[Task] }`
- `GET /api/tasks/:id` → `{ task:Task }`
- `POST /api/tasks/:id/cancel` → `{ task }`
- `POST /api/tasks/:id/retry` → `{ task }`（`failed|timeout|cancelled` 可重试，重新入队路由；超时任务在 `maxAttempts` 内会自动重试，无需人工调用）
- `POST /api/system/restart` body `{ reason? }` → `202 { ok:true, restarting:true, devices:N, delayMs }`
  - 整套系统自重启：先向在线设备下发 `restart_agent`，`delayMs`（默认 12s，覆盖设备心跳周期）后 Hub 进程自行重启。
  - Hub 以自重启语义恢复：运行中/等待回答的任务自动重新排队，不占用重试次数；规划父任务保持 running 等待子任务收尾。
  - 重复调用幂等（返回 `alreadyRequested:true`）；未启用自重启时返回 409。
- `GET /api/health` 额外返回 `features:{ progressKeepalive, autoRetryOnTimeout, selfRestart, restartedFromSelf }`，便于客户端确认能力。

### 5.5 事件流

`GET /api/events?token=<adminToken>` — `text/event-stream`。
连接后先发一条 `event: snapshot`，data 同 `/api/snapshot`；随后事件：

| event | data |
| --- | --- |
| `device.updated` | `{ device }` |
| `device.online` / `device.offline` | `{ deviceId, name, at }` |
| `task.created` / `task.updated` / `task.completed` / `task.failed` | `{ task }` |
| `settings.updated` | `{ settings, at }` |
| `goal.created` / `goal.updated` | `{ goal, at }` |
| `goal.deleted` | `{ goalId, at }` |
| `log` | `{ level, message, at }` |
| `ping` | `{ hubTime }`（每 15s，防代理断流） |

### 5.6 静态页面

- `GET /` → `hub/web/index.html`（桌面控制台；支持 `?token=`）
- `GET /m` → 手机控制台（`hub/web/index.html` 响应式即可；若存在 `hub/web/m/index.html` 则优先）
- `GET /assets/*` → 静态资源
- APK 首次启动要求用户填写 Hub 地址与管理员令牌；随后 WebView 加载 `http://<hub>/m?token=<token>`。

## 6. 数据结构

### Device（Hub 返回）

```jsonc
{
  "id":"dev_ab12cd34", "name":"书房工作站", "platform":"windows", "kind":"dsh",
  "agentVersion":"0.1.0", "endpoint":"http://192.168.1.20:7788",
  "tags":["书房"], "online":true, "status":"idle",
  "registeredAt":"2026-11-05T08:00:00.000Z", "lastSeenAt":"2026-11-05T08:00:10.000Z",
  "disabled":false,
  "load":{"running":0,"max":2},
  "metrics":{"cpuPct":12,"memPct":48,"uptimeSec":3600},
  "capabilities":{
    "models":[/* §3 */], "profiles":[], "gateways":[], "skills":[],
    "resources":{}, "limits":{"maxConcurrentTasks":2}
  }
}
```

### Task

```jsonc
{
  "id":"task_x1y2z3", "instruction":"把本周开销整理成 Word 报告",
  "requirements":{"skills":["office-docx"]}, "priority":5,
  "status":"running", "assignedDeviceId":"dev_ab12cd34", "assignedDeviceName":"书房工作站",
  "createdAt":"...", "updatedAt":"...", "startedAt":"...", "finishedAt":null,
  "attempts":1, "maxAttempts":2, "timeoutSec":300,
  "output":null, "error":null,
  "goalId":null,
  "route":{"reason":"matched 2 candidates; picked dev_ab12cd34 (score 118)",
           "candidates":[{"deviceId":"dev_ab12cd34","score":118,"matched":["skill:office-docx"]}],
           "excluded":[{"deviceId":"dev_z","reason":"missing model:deepseek-chat"}]},
  "events":[{"at":"...","type":"created","message":"任务已创建"}]
}
```

### Goal（长期目标）

```jsonc
{
  "id":"goal_a1b2c3",
  "title":"持续跟进求职进展",
  "description":"每周整理投递与面试结果，给出下一步建议",
  "status":"active",                       // active | paused | stopped | completed
  "schedule":{"type":"daily","time":"09:30"}, // 或 {"type":"interval","minutes":120}
  "requirements":null,
  "nextCheckAt":"2026-11-09T01:30:00.000Z",
  "lastCheckAt":null, "lastCheckStatus":null, "lastSummary":"",
  "lastTaskId":null, "runningTaskId":null,
  "taskIds":[],
  "checks":[{"at":"...","taskId":"task_x","status":"completed","summary":"当前进度…","error":null}],
  "createdAt":"...", "updatedAt":"...", "stoppedAt":null
}
```

### Command（下发给设备）

```jsonc
{
  "id":"cmd_9f8e", "type":"run_task", "taskId":"task_x1y2z3",
  "createdAt":"...", "payload":{
    "instruction":"...", "requirements":{...}, "priority":5, "timeoutSec":300,
    "context":{"deviceName":"...", "requestedAt":"..."}
  }
}
```

| type | 说明 |
| --- | --- |
| `run_task` | 执行任务（ack → progress/keepalive → result） |
| `cancel_task` | 中止任务；设备执行器应收到 abort |
| `answer_task` | 把用户回答交给等待中的任务 |
| `restart_agent` | 设备代理自重启：拉起新进程后优雅退出（不受并发槽位限制，优先处理） |

## 7. 路由评分（Hub 必须实现，测试可依赖）

1. 过滤：`disabled`、`!online`、`load.running >= limits.maxConcurrentTasks`、缺少所需能力 → 排除并记录原因。
2. 必配（requirements 非空时）：`model` ∈ models[].id（`available!==false`）；`skills` ⊆ skills[].id；`profile` ∈ profiles[].id；`gateway` ∈ gateways[].id；`tags` ⊆ device.tags；`deviceId` 完全相等。
3. 评分：基础 100；`loadRatio = running/max`；`-20*loadRatio`；指定 `deviceId` +15；匹配到 model.strengths 中含需求关键词 +5；最近心跳更近 +最多 3。
4. 取最高分；同分取 `lastSeenAt` 更新者。返回 `route.candidates`（前 5）与 `route.excluded`（最多 10）。

## 8. 设备代理行为约定

- 启动：读取配置 → 探测能力（DSH profile / Ollama / 配置覆盖）→ 注册（保存 deviceId/deviceToken 到本地状态文件）→ 心跳循环（10s）。
- 命令：优先通过心跳响应领取；空闲时用长轮询（25s）。收到 `run_task` 先 ack，再按 `maxConcurrentTasks` 并发执行，周期 progress（执行期间额外发送 `keepalive`），最后 result。
- 执行器（可插拔）：`simulate`（默认演示）、`cli`（本机 CLI：Hermes / OpenCode / shell）、`dsh-cli`（命令模板，如 `dsh run --print {instruction}`）、`shell`（命令模板）、`http`（POST 到设备本地服务）、`ollama`（`/api/generate`）、`comfyui`（提交工作流并下载生成图片）、`mika`（调用 Mika CLI 指挥 Android 手机）。
- 断线：后台指数退避重连（1s→30s）；重启后凭本地状态恢复注册，不重复占号。
- 超时语义：Hub 的单任务超时是“静默窗口”（默认 `timeoutSec`，设备 keepalive 会续期），设备失联或卡死才会超时；实际执行时长由执行器自身的 `timeoutMs` 约束。设备侧同样以 keepalive 续期看门狗，超时主动 result(ok:false, error:"timeout")。
- 自动重试：任务运行超时后，若 `autoRetry` 未显式关闭且 `attempts < maxAttempts`，Hub 会自动下发 `cancel_task` 并重新排队，无需人工点「重试」。
- 自重启：收到 `restart_agent` 时，设备代理立即拉起一个新代理进程（同参数/同环境/继承日志输出）再优雅退出；当前执行中的任务被中止，由 Hub 在自重启恢复时自动重新排队。
- 长任务拆分：规划器给子任务的 `timeoutSec` 低于 300s 时由 Hub 兜底到 300s（且不超过父任务预算），避免网页检索类子任务被过短超时误杀。

## 9. 安全边界（家用 LAN）

- 默认监听 `0.0.0.0:7317`，仅在家庭内网使用；文档说明不要把端口暴露公网，建议反代 + TLS。
- 设备令牌只授权自身；管理员令牌等同管理员，请勿写入截图/日志。
- Hub 不执行设备发来的任意代码；任务指令由设备端执行器决定，设备端可配置白名单/模拟模式。
- 手机端令牌存于 Android `SharedPreferences`（应用私有）；Web 端存 `localStorage`。

## 10. 验收清单

- [ ] `node hub/server.js` 启动后打印手机 URL（含 token）与加入码。
- [ ] 3 个模拟设备注册后 `/api/devices` 显示在线与完整能力。
- [ ] 停止一个设备 → 30s 内 `online:false`，SSE 收到 `device.offline`。
- [ ] 发送需要 `office-docx` 的任务 → 只路由到具备该技能且在线的设备。
- [ ] 设备回报 result → 任务 `completed`，快照与 SSE 同步。
- [ ] 无匹配设备 → `queued` + `route.excluded` 原因；设备上线后自动路由。
- [ ] 手机 `/m?token=` 可查看状态、发指令、看进度。
- [ ] APK 安装后可配置 Hub 地址与令牌并正常使用（见 docs/APK.md）。
