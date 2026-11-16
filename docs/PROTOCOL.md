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
  "name": "书房工作站",              // 必填，1-64 字符；设备自报的机器名，每次上报都会刷新
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

- 重派是**幂等**的：同一 `attempt` 的重投复用同一个命令 `id`（设备按 `id` 去重）。设备心跳 `status=busy`、`load.running>0` 或 `taskIds` 非空时，Hub **不得**因 ack 超时而重派，而是重投原命令并按退避等待（等待窗口默认 `max(4×ackTimeout, 10min)`），期间任务保持 `assigned`、不消耗 `attempts`。
- Hub 维护“绝对派发预算”：`attempts >= maxAttempts` 时不再派发，直接 `failed`（`dispatch budget exhausted`），即使发生自重启/超时重排也不会绕过。

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
设备应在**收到 `run_task` 时立即 ack**（允许排队等待执行槽位），而不是等真正开始执行才 ack；排队期间用 `progress({keepalive:true})` 续期。Hub 依据心跳里的 `status`/`load.running`/`taskIds` 判断设备是否忙碌：忙碌时按上面的幂等重投处理，绝不因 ack 超时重派给同一设备。

`POST /api/devices/:id/tasks/:taskId/progress`
Body: `{ message:"正在解析表格…", percent?:0-100, logs?:["…"] }` → `{ ok:true }`
Body（保活）: `{ keepalive:true }` → `{ ok:true }`；只续期该任务的超时窗口（见 §4），不写入进度、不广播事件。
设备在任务执行期间应周期性发送（建议间隔 ≤ timeoutSec/2，默认 15s），Hub 以此判断“设备还活着”。

`POST /api/devices/:id/tasks/:taskId/result`
Body: `{ ok:true|false, output?:{ text?, markdown?, artifacts?:[{name,url?,path?}], data?:any }, error?:string, durationMs?:number }`
→ `{ ok:true, ignored:false, task }`；正常完成后广播。
→ `{ ok:true, ignored:true, task, reason? }`：结果被**收敛忽略**（任务已到终态，或结果来自已被重新派发的旧 attempt）。设备端应把 `ignored` 视为“无需重试”，只记日志/指标，不再重发。

`POST /api/devices/:id/unregister` → `{ ok:true }`（标记离线并移除；调试用）

### 5.4 手机/控制台（管理员令牌）

- `GET /api/snapshot?limit=50` → `{ server:{version,uptimeSec,hubTime}, settings:{language}, stats:{...}, devices:[Device], tasks:[Task], goals:[Goal], reminders:[Reminder], events:[Event] }`
- `GET /api/settings` → `{ settings:{ language }, supportedLanguages:['zh-CN','en'], hubTime }`
- `PATCH|PUT /api/settings` body `{ language:'zh-CN'|'en' }` → `{ settings, hubTime }`；持久化到 `<dataDir>/settings.json`，并广播 SSE `settings.updated`。
- `GET /api/goals?status=` → `{ goals:[Goal], hubTime }`
- `POST /api/goals` body `{ title, nickname?, description?, schedule?, requirements? }` → `{ goal, hubTime }`
  - `nickname`: 目标昵称（≤40 字，可选）；控制台卡片、提醒与每日总结优先用昵称称呼目标，留空则显示 `title`。
  - `schedule`: `{ type:'daily', time:'HH:mm' }`（默认）或 `{ type:'interval', minutes:5..10080 }`；缺省为每天 09:00。
  - 生命周期：`active | paused | stopped | completed`；创建默认 `active`，并按计划计算 `nextCheckAt`。
- `GET /api/goals/:id` → `{ goal }`
- `PATCH|PUT /api/goals/:id` body `{ title?, nickname?, description?, schedule?, status?, pausedUntil? }` → `{ goal }`；`nickname` 传空字符串可清除昵称；恢复为 `active` 时从当前时间重新排期，不补跑错过的检查。`pausedUntil` 仅在 `status='paused'` 时有意义：ISO 时间字符串表示到点自动恢复，`null` 表示一直暂停、等你手动恢复（最长 366 天）；暂停中的目标可只传 `pausedUntil` 修改恢复时间，其它状态传该字段返回 400。
- `POST /api/goals/:id/skip` → `{ goal, hubTime }`：跳过下一次自动跟进（保持 `active`），把 `nextCheckAt` 推进一个计划周期（每天计划顺延到下一次同时刻，间隔计划顺延一个间隔），并清空该目标待确认的 `pendingApproval`；非 `active` 目标返回 409。
- `POST /api/goals/:id/guidance` body `{ text }` → `{ goal, hubTime }`：给目标追加一条「新的指导指令」（trim 后 1–2000 字，最多保留最近 20 条）；之后每次自动跟进任务都会按时间顺序带上最近 6 条（越靠后越新、优先遵守），已有待确认提案时同步刷新其指令；空文本或超长返回 400。
- `POST /api/goals/:id/check` → `{ goal, task, hubTime }`：立即创建一次跟进任务（`task.goalId` 指向目标），视为用户已同意执行；该目标已有执行中的跟进任务时返回 409。
- `POST /api/goals/:id/link` body `{ taskId }` → `{ goal, task, hubTime }`：把已有任务关联到目标（`task.goalId` 指向目标、加入 `goal.taskIds`）。任务已结束时同步写入 `goal.lastCheckAt/lastCheckStatus/lastTaskId/lastSummary` 并追加一条 `checks`（同一任务不会重复追加），下一次跟进任务会带着这段结论继续；关联执行中的任务则登记为 `goal.runningTaskId`。
- `POST /api/goals/:id/approve` → `{ goal, task, hubTime }`：同意该目标的待确认跟进，立即创建跟进任务并清空 `pendingApproval`；没有待确认提案时返回 409。
- `POST /api/goals/:id/reject` → `{ goal, hubTime }`：否决待确认跟进，清空 `pendingApproval`、把目标置为 `paused` 并清空 `nextCheckAt`（等用户下一步指令）；没有待确认提案时返回 409。
- `GET /api/approvals` → `{ approvals:[{ goalId, goalTitle, createdAt, approval }], hubTime }`：所有等待用户确认的跟进提案（按创建时间升序）。
- `GET /api/nightly-review` → `{ review, hubTime }`：每晚总结的状态与内容（`enabled/time/date/taskId/status/startedAt/finishedAt/summary/error/task`）。
- `POST /api/nightly-review/run` → `{ task, review, hubTime }`：立即创建一次每日总结任务（强制触发，忽略开关与到点判断）；已有总结任务执行中时返回 `{ task:null, review }`。
- `DELETE /api/goals/:id` → `{ ok:true }`（已创建的历史任务保留）。
  - Hub 每 `goalTickMs`（默认 30s）扫描到点的 active 目标，先生成一条 `pendingApproval` 提案（不会直接执行）；只有用户批准（`approve`）或手动 `check` 后才创建跟进任务。既有提案未处理时不会重复生成。
  - 目标执行前必须获得用户同意；用户否决后目标暂停（`paused`），不再排期，等用户恢复或给出下一步指令。
  - 「暂停止」：`skip` 只跳过下一次自动跟进、保持 `active`；`pausedUntil` 表示暂停到指定时间，Hub 调度器每 tick 检查到点自动恢复为 `active` 并重排 `nextCheckAt`（暂停期间手动 `check` 仍可用，但不会自动派发）；不带 `pausedUntil` 的 `paused` 一直等你手动恢复。
- 「恢复自动跟进」：`paused` 与 `stopped` 的目标都可以通过 `PATCH /api/goals/:id` body `{ status: "active" }` 恢复——清空 `stoppedAt`/`pausedUntil`、从当前时间重新排 `nextCheckAt`、清空待确认提案；`completed` 目标的「重新激活」走同一分支。
  - 跟进任务是普通任务（`goalId` 关联），优先级手动 7 / 定时 4，`timeoutSec=600`、`maxAttempts=2`，消耗一条设备并发槽位。
  - 每晚总结：Hub 每天本地时间 `nightlyReviewTime`（默认 22:00，`BUTLER_NIGHTLY_REVIEW_TIME` 或构造参数可改）自动创建一条总结任务，复盘所有目标、最近 24h 任务与子任务进度，并给出明天工作方向与目标下一步细节；完成后的 Markdown 摘要通过 `nightly.review.updated` 推送并在控制台展示。可用 `BUTLER_NIGHTLY_REVIEW=0` 关闭自动触发（手动接口仍可强制运行）。
- `GET /api/reminders` → `{ reminders:[Reminder], hubTime }`：按 `dueAt` 升序（相同再按 `createdAt`）。
- `POST /api/reminders` body `{ title, note?, dueAt, repeat?, notifyStyle?, enabled? }` → `{ reminder, hubTime }`
  - `title`: 1–80 字；`note`: ≤500 字，可选；`dueAt`: 到期时间，epoch 毫秒（整数）；`repeat`: `none`（默认）/`daily`/`weekly`；`notifyStyle`: `gentle`（默认，普通系统通知）/`alarm`（闹钟式：响亮提示音 + 长震动，仅 APK 生效）；`enabled`: 默认 `true`。
- `GET /api/reminders/:id` → `{ reminder, hubTime }`
- `PATCH|PUT /api/reminders/:id` body 为上面的部分字段 → `{ reminder, hubTime }`；改 `dueAt` 只更新数据，不补发错过的提醒。
- `DELETE /api/reminders/:id` → `{ deleted:true, reminderId, hubTime }`
- `POST /api/reminders/:id/fire` body `{ firedAt?:ISO }` → `{ reminder, hubTime }`：手机 APK 到点回写；`lastFiredAt` 用 Hub 服务器时间 ISO 写入、`fireCount` +1；`repeat=none` 时 `enabled=false`，`daily/weekly` 时以 `max(firedAt, 当前时间)` 计算并把 `dueAt` 推进到下一次（保证 > 当前时间）且保持启用。`firedAt` 可选，只用于计算下一次（避免手机时钟偏差），Hub 不做提醒轮询、不补发，通知完全由 APK 原生闹钟负责。
- `GET /api/records?q=&status=&limit=&offset=` → `{ records:[{ taskId,status,createdAt,durationMs,device,summary,error,hasFile,size,updatedAt,file,parentTaskId,isPlan,archived }], total, limit, offset, recordDir }`
- `GET /api/records/:taskId` → `{ record:{ taskId, file, markdown, size, updatedAt, task? } }`；`?format=md` 直接返回 `text/markdown`（附件下载）。
- `GET /api/devices` → `{ devices:[Device], hubTime }`
- `GET /api/devices/:id` → `{ device:Device }`
- `PATCH /api/devices/:id` body `{ name?, nickname?, tags?, disabled? }` → `{ device }`
  - `nickname`: 用户在 Hub 侧给设备起的用途昵称（≤40 字，保存在 Hub 的 state.json）；传空字符串可清除。设备重报 manifest 只更新 `name`，不会覆盖 `nickname`。控制台与任务展示优先用昵称，没有昵称时回退到 `name`。
- `DELETE /api/devices/:id` → `{ ok:true }`
- `POST /api/tasks` body `{ instruction, requirements?, priority?, timeoutSec?, maxAttempts? }` → `{ task }`
  - `requirements`: `{ model?, skills?:[], profile?, gateway?, project?, tags?:[], deviceId? }`，全部可选；`deviceId` 显式指定设备（仍须在线）；`project` 为 Hermes 项目归属（项目名或绝对路径，原样下发设备，由 `cli` 执行器解析并登记到 `$HERMES_HOME/projects.db`）。
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
- `GET /api/dsh/bridge` → `{ url }`；`POST /api/dsh/bridge` body `{ url }` → `{ url }`
  - 桌面版 DSH 每次启动的 Web 端口可能变化（手机「开发页」经 Hub 代理 `/api/dsh/*` 到 DSH 插件），插件启动时把这个地址同步进来，并持久化到 `<dataDir>/dsh-bridge.json`，Hub 重启后继续复用。
  - 读取优先级：内存 → `<dataDir>/dsh-bridge.json` → 环境变量 `DSH_BRIDGE_URL` → 历史默认 `http://127.0.0.1:50646/super-butler/api/dsh`。
  - 代理失败时若磁盘上的地址已更新，Hub 会自动换新地址重试一次（无需重启）；仍失败则返回 502 `{ error: { code: 'dsh_unavailable', message } }`，message 里包含当前地址与「在插件面板点一次重启 Hub」的提示。
  - `GET /api/snapshot` 响应额外带 `dshBridge: { url }`，便于排查手机开发页指向的地址。
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
| `reminder.created` / `reminder.updated` / `reminder.fired` | `{ reminder, at }` |
| `reminder.deleted` | `{ reminderId, at }` |
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
  "id":"dev_ab12cd34", "name":"书房工作站", "nickname":"书房主力机（写代码）", "platform":"windows", "kind":"dsh",
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
  "parentTaskId":null, "childTaskIds":[], "isPlan":false,   // 长任务拆分：父任务 isPlan=true 并带子任务 id
  "planStep":null, "planGroup":null, "planDependsOn":[], "planDependsOnTaskIds":[],  // 子任务的执行计划
  "plan":null,                                               // 父任务：{strategy,blockerPolicy,groups[]}
  "route":{"reason":"matched 2 candidates; picked dev_ab12cd34 (score 118)",
           "candidates":[{"deviceId":"dev_ab12cd34","score":118,"matched":["skill:office-docx"]}],
           "excluded":[{"deviceId":"dev_z","reason":"missing model:deepseek-chat"}]},
  "events":[{"at":"...","type":"created","message":"任务已创建"}]
}
```

### 执行计划（`isPlan` / `plan*` 字段）

- 规划器可返回 `execution = { strategy: "parallel" | "sequential" | "mixed", groups: [{ name, mode, subtaskIndexes }], blockerPolicy: "stop-and-ask" | "continue" }`，子任务可带 `dependsOn`（0 基、只能指向更早序号）与 `parallelGroup`。
- Hub 归一化后写入父任务 `plan` 与子任务 `planStep`（1 基）、`planGroup`、`planDependsOn`（0 基序号）、`planDependsOnTaskIds`（落库后的真实任务 id），并随 `state.json` 持久化、经 SSE 广播。
- 路由闸门：`planDependsOnTaskIds` 未全部 `completed` 时子任务保持 `queued`，`route.reason` 为「等待前置子任务：第 N 步…」；前序失败/超时/取消时 `route.reason` 为「卡点：…」且父任务 `progress.blocked=true`，并追加 `blocked` 事件；`blockerPolicy` 默认 `stop-and-ask`，重试失败子任务或回答等待中的问题后自动放行。
- 取消子任务会级联取消依赖它的后续排队子任务（`cancelTask` 内部 `skipDependents` 防递归）。

### Goal（长期目标）

```jsonc
{
  "id":"goal_a1b2c3",
  "title":"持续跟进求职进展",
  "description":"每周整理投递与面试结果，给出下一步建议",
  "status":"active",                       // active | paused | stopped | completed
  "schedule":{"type":"daily","time":"09:30"}, // 或 {"type":"interval","minutes":120}
  "requirements":null,
  "pausedUntil":null,                      // 仅 status='paused'：ISO 到点自动恢复；null=一直暂停
  "guidance":[                             // 追加式指导指令；之后每次自动跟进都会带上（最多 20 条）
    {"id":"gd_a1b2c3","text":"优先处理 A 项目，B 项目暂缓","createdAt":"..."}
  ],
  "nextCheckAt":"2026-11-09T01:30:00.000Z",
  "lastCheckAt":null, "lastCheckStatus":null, "lastSummary":"",
  "lastTaskId":null, "runningTaskId":null,
  "taskIds":[],
  "checks":[{"at":"...","taskId":"task_x","status":"completed","summary":"当前进度…","error":null}],
  "createdAt":"...", "updatedAt":"...", "stoppedAt":null
}
```

### Reminder（提醒）

```jsonc
{
  "id":"rem_a1b2c3",
  "title":"吃药",
  "note":"饭后",
  "dueAt":1794186000000,                 // epoch 毫秒（整数），不用 ISO 字符串
  "repeat":"daily",                      // none | daily | weekly
  "notifyStyle":"gentle",                // gentle（普通通知，默认） | alarm（闹钟式，仅 APK 生效）
  "enabled":true,
  "createdAt":"...", "updatedAt":"...",
  "lastFiredAt":null,                    // APK 回写后为 ISO 字符串
  "fireCount":0
}
```

- Hub 只持久化与广播提醒，不轮询调度；到点通知由 Android APK 的原生 `AlarmManager` + `BroadcastReceiver` 发送。
- `notifyStyle` 只影响 APK 的通知方式：`gentle` 走通知渠道 `butler_reminders`（普通系统提示音），`alarm` 走 `butler_reminders_alarm`（`USAGE_ALARM` 闹钟音 + 长震动）；Web 控制台仅展示与编辑该字段，不弹通知。
- 排序按 `dueAt` 升序；`enabled=false` 的提醒不排程。
- `repeat=none` 的提醒触发后自动 `enabled=false`；`daily/weekly` 触发后 Hub 把 `dueAt` 推进到下一次。

### Command（下发给设备）

```jsonc
{
  "id":"cmd_9f8e", "type":"run_task", "taskId":"task_x1y2z3",
  "createdAt":"...", "payload":{
    "instruction":"...", "requirements":{...}, "priority":5, "timeoutSec":300,
    "threadId":"thread_...", "replyToTaskId":null, "threadStep":1,
    "parentTaskId":"task_parent", "context":{
      "deviceName":"...", "requestedAt":"...", "taskId":"task_x1y2z3",
      "parentTaskId":"task_parent", "parentInstruction":"主任务目标（截断 4000 字符）",
      "planStep":2, "planTotal":3, "planTitle":"计划标题",
      "planSiblings":[{"id":"task_...","step":1,"status":"completed","instruction":"..."}]
    }
  }
}
```

- 计划子任务的 `parentTaskId` / `context.parentTaskId` 必须指向主任务，`context.parentInstruction` 携带主任务目标，`planStep/planTotal/planTitle/planSiblings` 描述它在计划中的位置与兄弟子任务。设备端据此在 prompt 中拼接「主任务背景」，不能依赖子任务指令里的“这里/该项目”之类指代。
- 计划子任务不共享父任务的 Hermes 会话：worker 以 `task:<taskId>` 作为会话键（普通任务/继续任务仍按 `threadId`），避免兄弟子任务之间的对话互相污染、越跑越偏。

| type | 说明 |
| --- | --- |
| `run_task` | 执行任务（ack → progress/keepalive → result） |
| `cancel_task` | 中止任务；设备执行器应收到 abort |
| `answer_task` | 把用户回答交给等待中的任务 |
| `restart_agent` | 设备代理自重启：拉起新进程后优雅退出（不受并发槽位限制，优先处理） |

## 7. 路由评分（Hub 必须实现，测试可依赖）

1. 过滤：`disabled`、`!online`、真实占用 `assigned+running+waiting` 达到 `limits.maxConcurrentTasks`、缺少所需能力 → 排除并记录原因。
2. 必配（requirements 非空时）：`model` ∈ models[].id（`available!==false`）；`skills` ⊆ skills[].id；`profile` ∈ profiles[].id；`gateway` ∈ gateways[].id；`tags` ⊆ device.tags；`deviceId` 完全相等。
3. 评分：基础 100；`loadRatio = running/max`；`-20*loadRatio`；指定 `deviceId` +15；匹配到 model.strengths 中含需求关键词 +5；最近心跳更近 +最多 3。
4. 取最高分；同分取 `lastSeenAt` 更新者。返回 `route.candidates`（前 5）与 `route.excluded`（最多 10）。

## 8. 设备代理行为约定

- 启动：读取配置 → 探测能力（DSH profile / Ollama / 配置覆盖）→ 注册（保存 deviceId/deviceToken 到本地状态文件）→ 心跳循环（10s）。
- 命令：优先通过心跳响应领取；空闲时用长轮询（25s）。收到 `run_task` **立即 ack**（含排队场景），再按 `maxConcurrentTasks` 并发执行；同一 `taskId` 在队列/执行中时再次收到派发必须丢弃（按 taskId 去重，而不是只看 command id）。排队上限 `maxQueueSize`（默认 8），超限时丢弃新命令且不 ack，等待 Hub 稍后重投；排队期间发送 `progress({keepalive:true})`。执行期间周期 progress（额外发送 `keepalive`），最后 result。收到 `{ ignored:true }` 的结果响应时不重试。
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
- [ ] 控制台「提醒」Tab 可增删改查提醒；APK 安装后到点弹系统通知，重复提醒触发后自动推进，`fire` 回写同步到 Hub。
- [ ] APK 安装后可配置 Hub 地址与令牌并正常使用（见 docs/APK.md）。
