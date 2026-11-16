# 目标-任务整合 + 自主管家大脑（BattleStar 设计约定）

本文件是本次改动的唯一契约来源（Lead / web-ui / verifier 共同遵守）。改动目标是三件事：

1. **任务流程整合进长期目标**：任意已有任务（含 Agnes 拆分计划）可以关联到目标，目标详情页展示关联任务及其子任务进度；关联计划父任务时，子任务继承归属上下文，父任务结束把计划结论写回目标。
2. **目标页面复制 Goal ID**：与任务详情一致（`copyText(goal.id, '目标 ID 已复制')`）。
3. **自主大脑（autonomous brain）**：Hub 内置一个定时思考的 Agent，读取目标/任务/设备/待确认状态，调用 LLM 决策并执行白名单动作（重试、续做、建任务、关联目标），决策记录在控制台“自主大脑”卡片和详情抽屉里可见。

## 1. 后端：目标 ↔ 任务

### 1.1 `hub.linkGoalTask(goalId, taskId)` 增强（hub/lib/hub.js:1163）
- 保持现有行为：`task.goalId = goal.id`，`goal.taskIds` 追加（去重、上限 50），终态任务写 `checks/lastSummary/lastCheckAt/lastTaskId`，活动任务写 `goal.runningTaskId`。
- **新增**：若 `task.isPlan`，给每个子任务补 `child.context = {...child.context, goalId: goal.id}`（仅归属上下文，不写 `child.goalId`，避免每个子任务都回写目标检查）。
- **新增**：若 `goal.runningTaskId` 为空且任务仍在进行（或已有关联计划正在运行），设置 `goal.runningTaskId = task.id`。
- 广播 `goal.updated` + `task.updated`，写日志：`长期目标关联任务：${goalId} ← ${taskId}`。

### 1.2 新增 `hub.unlinkGoalTask(goalId, taskId)`
- 清 `task.goalId`；移除 `goal.taskIds` 中的 id；若 `goal.runningTaskId === taskId` 置空；若计划父任务，清子任务 `context.goalId`。
- 广播 `goal.updated` + `task.updated`，持久化。

### 1.3 新增 `hub.listGoalTasks(goalId)`
返回该目标关联的**顶层任务**摘要数组（计划父任务包含 `childProgress`，不再单独列出子任务）；非关联任务不返回。字段：
```
{ id, instruction(截断 400), status, goalId, isPlan, parentTaskId:null,
  threadId, createdAt, updatedAt, startedAt, finishedAt, assignedDeviceName,
  progress: {message,percent,waiting,question,at} | null,
  error(截断 300) | null,
  childProgress: {total, completed, failed, running, waiting} | null,
  planStep, planTitle,
  lastEvent: {at,type,message} | null }
```
排序：创建时间倒序。

### 1.4 `goalToJson` 增补（在 `listGoals`/`getGoal` 调用侧计算，避免纯函数依赖 Hub）
- `linkedStats`: `{ total, running, completed, failed, waiting, planTotal, planCompleted }`（从 `goal.taskIds` 对应的任务计算；`planTotal/planCompleted` 取最大的关联计划父任务的子任务数/完成数）。
- `getGoal` 保持纯 `goalToJson`（HTTP 详情接口负责附带 tasks）。

### 1.5 任务创建侧的归属继承
- `createFollowUp(source, input)`：新任务带 `goalId: source.goalId`，并把新任务 id 加入 `source.goalId` 对应目标的 `taskIds`（若目标存在）。这样“继续此任务”的后续流程不会脱离目标。
- `createPlanTask(input)`：父任务带 `goalId: input.goalId`；子任务 `context.goalId = parent.goalId`（不写 `child.goalId`）。父任务完成后 `_goalTaskFinished` 回写目标。
- `_goalTaskFinished(task)`：
  - 保持原有检查回写逻辑。
  - 若 `task.isPlan` 且 `task.output` 为空：用子任务结果合成摘要，格式 `计划「title」共 N 步：完成 X，失败 Y（失败步骤：第 k 步 ...）`，写入 `checks.summary/lastSummary`。
  - 若目标还有其它关联任务处于活动状态（且 `goal.runningTaskId !== task.id`），不清空 `goal.runningTaskId`。

## 2. 后端：自主大脑（hub/lib/brain.js，新文件）

### 2.1 默认状态
```js
{ enabled: true, mode: 'auto',        // 'auto' | 'suggest'
  intervalSec: 180,                   // 60..3600
  maxActions: 2,                      // 1..3
  model: null,                        // null => 环境变量
  lastThinkAt: null, lastError: null, lastSummary: '',
  decisions: [] }                     // 上限 30
```
`mode='suggest'`：只记录建议，不执行任何变更；`auto`：执行白名单动作。

### 2.2 导出（纯函数，便于单测）
- `DEFAULT_BRAIN`, `BRAIN_MODES`, `BRAIN_ACTIONS`（`retry_task | resume_thread | create_task | link_task | none`）
- `normalizeBrainPatch(patch, base, { nowMs })` → `{ok, value}` 或 `{ok:false, errors}`；校验 enabled/mode/intervalSec/maxActions/model。
- `restoreBrain(raw)` → 完整默认结构（容错；`thinking` 恢复为 false）。
- `brainToJson(brain, { decisions = 10 } = {})` → 对外 JSON（`nextThinkAt` 根据 lastThinkAt+intervalSec 计算；`decisions` 取最近 N 条；附 `configured` 布尔：是否找到 API key）。
- `recordBrainDecision(brain, decision)` → 写入并裁剪到 30 条。
- `buildBrainPrompt(snapshot)` → `{ system, user }`；snapshot 结构见 2.4。系统提示：你是 BattleStar 的自主管家大脑，只能输出严格 JSON；先理解用户目标与正在跑的任务，再决定最小动作；禁止臆造设备/任务 id；没有必要时 `actions: []`。
- `parseBrainReply(text)` → `{ summary, actions: [...] }`；容忍 ```json 围栏；校验 action 白名单、taskId/goalId 为字符串、confidence 0..1；非法 JSON 抛错（错误信息含 `大脑返回不是合法 JSON`）。actions 最多 3 条。
- `createBrainThinker(config)` → `async ({ system, user }) => string`；config 解析：
  - key: `BRAIN_API_KEY || AGNES_API_KEY || BUTLER_AGNES_API_KEY`
  - baseUrl: `BRAIN_BASE_URL || AGNES_BASE_URL || https://apihub.agnes-ai.com/v1`
  - model: `config.model || BRAIN_MODEL || AGNES_MODEL || 'agnes-2.5-flash'`
  - timeout: `BRAIN_TIMEOUT_MS || 60000`
  - POST `${baseUrl}/chat/completions`，`temperature: 0.2, max_tokens: 2000, stream: false`，`Authorization: Bearer <key>`；无 key 时调用抛错 `未配置自主大脑模型（BRAIN_API_KEY / AGNES_API_KEY）`。
- 决策记录结构：
```js
{ id:'brain_xxx', at:'ISO', trigger:'manual|schedule', mode:'auto|suggest',
  model, durationMs, summary, actions:[{ action, taskId, goalId, instruction, reason,
  confidence, executed:boolean, skippedReason:string|null, error:string|null }],
  error: null }
```

### 2.3 Hub 集成（hub/lib/hub.js）
- 构造器：`this.brainThink = typeof options.brainThink === 'function' ? options.brainThink : null;`（测试注入）；`this.brainTickMs = clampInt(options.brainTickMs, 30000, 5000, 600000)`；`this.brain = restoreBrain(null)`。
- `init()`：`this.brain = restoreBrain(savedObj.brain)`；启动 `this._brainTimer = setInterval(() => this.runBrainCycle(), this.brainTickMs)`（unref），`close()` 里 clear；序列化 `serializeState()` 增加 `brain: { enabled, mode, intervalSec, maxActions, model, lastThinkAt, lastError, lastSummary, decisions }`。
- 方法：
  - `getBrain()` → `brainToJson(this.brain)` + `{ thinking, configured }`。
  - `updateBrain(patch)` → 归一化、保存、广播 `brain.updated`、重新计算下一次思考时间、持久化；返回 `getBrain()`。
  - `listBrainDecisions(limit)`。
  - `runBrainCycle()`（自动，30s 定时器调用）：`enabled && !thinking && now >= nextThinkAt && !this._closed` 才真正思考；返回 Promise；内部错误只记录不抛出。
  - `requestBrainThink({ trigger = 'manual' } = {})`：强制立刻思考一次（忽略 nextThinkAt，思考中则复用/拒绝），返回 decision。
  - `_runBrainThink(trigger)`：构造 snapshot → 调 `this.brainThink({system,user})`（懒创建 `createBrainThinker({model: this.brain.model})`）→ `parseBrainReply` → 按 mode 执行/记录 → `recordBrainDecision` → 更新 `lastThinkAt/lastError/lastSummary` → 广播 `brain.updated`（data `{ brain: getBrain() }`）→ `schedulePersist()`。
  - `_applyBrainActions(decision)`：仅在 `mode==='auto'` 执行；最多 `maxActions` 条；每条动作独立 try/catch，失败写 `error` 不中断其它动作：
    - `retry_task`：任务存在且状态 `failed/timeout/cancelled` 且 `attempts < maxAttempts` → `retryTask(task)`。
    - `resume_thread`：任务终态且 `instruction` 非空（默认 `继续此任务并推进下一步`）→ `createFollowUp(task, { instruction })`。
    - `create_task`：`instruction` 非空且长度 ≥ 4；若已有活动任务 instruction 前 40 字相同则跳过（`skippedReason:'duplicate'`）；否则 `createTask({ instruction, goalId, priority: 5, context: { brain: true, reason } })`。
    - `link_task`：`goalId + taskId` 均存在 → `linkGoalTask`。
    - 其它/`none` → skipped。
    - 置信度 `< 0.6` 的 auto 动作跳过并记 `skippedReason:'low-confidence'`。
- `snapshot()` 增加 `brain: this.getBrain()`。

### 2.4 大脑输入快照（`_brainSnapshot()`）
```
{ now, stats, devices:[{id,name,kind,online,tags,load}],
  goals:[{id,title,nickname,status,schedule,nextCheckAt,lastCheckStatus,lastSummary(400),
          guidance(最近3条),taskIds,runningTaskId,pendingApproval,linkedStats}],
  tasks: 最近 24h + 全部活动任务，最多 40 条:
          [{id,instruction(300),status,goalId,isPlan,parentTaskId,threadId,attempts,maxAttempts,
            createdAt,updatedAt,finishedAt,error(300),progress,planStep,planTotal,
            childProgress,assignedDeviceName,lastEvent}],
  approvals: [{goalId,goalTitle,createdAt,reason}] }
```
任务只保留与“可能值得行动”相关：failed/timeout/cancelled、waiting、queued/running、最近完成。已归档任务不进入。

### 2.5 HTTP（hub/lib/http.js）
- `GET /api/brain` → `{ brain, decisions, hubTime }`（decisions 默认 20 条，`?decisions=` 可调，范围 1..30）。
- `PATCH /api/brain` → body 同 `updateBrain`，返回 `{ brain, hubTime }`。
- `POST /api/brain/think` → 强制思考，返回 `{ decision, brain, hubTime }`；未配置模型时返回 400（message 含 `BRAIN_API_KEY`）或 `{decision:null, error}`，二选一但需在实现中固定。
- `GOAL_ADMIN_RE` 增加 `unlink`：`/^\/api\/goals\/([^/]+)(?:\/(check|link|unlink|approve|reject|skip|guidance))?$/`；`POST /api/goals/:id/unlink` body `{taskId}` → `unlinkGoalTask`。
- `GET /api/goals/:id` 返回 `{ goal, tasks: listGoalTasks(goalId), linkedStats, hubTime }`。

## 3. Web 控制台（hub/web/assets/app.js + index.html + style.css）

所有 UI 文案使用现有中文风格；不改 DSH 插件（只读面板）；移动端共用同一套资源。

### 3.1 目标卡片（goalCard 2512）
- 新增一行（有 `linkedStats.total > 0` 时）：`关联任务 N · 计划 x/y · k 进行中`（无计划则省略计划部分）。
- 保留原有“最近进度/下次执行”。

### 3.2 目标详情抽屉（openGoalDrawer 3341 / renderGoalDrawer 3359）
- 基础信息：`目标 ID` 行保持等宽显示，**加复制按钮**（图标/文字“复制”，点击 `copyText(goal.id, '目标 ID 已复制')`）。
- 底部操作区增加 `复制目标 ID` 按钮（与任务详情的“复制任务 ID”一致）。
- 新增 **关联任务** 区块（基础信息之后）：
  - 标题 + `关联任务` 按钮（打开任务选择抽屉）。
  - 列表项：状态徽标、指令摘要（`shorten(instruction,100)`）、计划进度 `子任务 3/5`、设备名/进度消息、`打开`、`取消关联`。
  - 空态：`还没有关联任务。把正在进行的任务关联进来，目标页就能看到它的进度。`
  - 数据：打开抽屉时 `GET /api/goals/:id` 拉取（缓存到 `state.goalDetail`），SSE `goal.updated` / `task.updated` 时若该抽屉打开则刷新。
- 任务选择抽屉：列出可选任务（`state.tasks` 中未归档、`goalId` 为空或非当前目标，按 created 倒序，最多 50），显示状态+摘要；点击 → `POST /api/goals/:id/link {taskId}` → 刷新。
- `取消关联` → `POST /api/goals/:id/unlink {taskId}`。

### 3.3 任务详情抽屉（buildTaskBody 5594 / taskFooterNodes 5785）
- 任务信息区新增 `关联目标` 行（有 goalId 时）：目标显示名 + `打开目标`；点击打开目标抽屉。
- 底部操作区（非终态或任意状态均可）：`关联到目标` 按钮 → 目标选择抽屉 → `POST /api/goals/:goalId/link {taskId}`。
- 已关联时底部显示 `取消关联目标`（可选，与 3.2 一致）。

### 3.4 自主大脑卡片（目标页顶部，#goal-list 之前）
- 卡片标题 `自主大脑` + 状态 chip（`自动`/`建议`/`已暂停`）+ 上次思考相对时间 + 下次思考时间。
- 一行最近决策摘要（`state.brain.lastSummary`，空时 `还没有思考记录`）。
- 按钮：`立即思考`（POST /api/brain/think，busy 态）、`设置`（打开大脑抽屉）、`暂停`/`启用`（PATCH enabled 取反）。
- SSE `brain.updated` → 更新 `state.brain` 并重绘卡片（保留滚动位置）。

### 3.5 大脑抽屉（openBrainDrawer）
- 设置：模式 select（auto=自动执行 / suggest=只给建议）、思考间隔分钟数 input、最多动作数 input、保存（PATCH）。
- 决策历史（最近 20 条）：时间、trigger、mode、摘要、每条动作 `action + 目标/任务 + 已执行/跳过原因 + 错误`，`置信度`。
- `立即思考` 按钮、错误信息展示（`state.brain.lastError`）。
- 刷新：GET /api/brain。

### 3.6 状态与请求
- `state.brain` 初始来自 snapshot.brain；`state.brainBusy`；`state.brainError`。
- WS/SSE 事件：`brain.updated`（新增），其它 goals 事件照旧。
- 提供统一的 `refreshBrain()`、`refreshGoalDetail(goalId)`。
- 样式加到 `style.css`：`.brain-card`、`.brain-chip`、`.brain-actions`、`.link-row`、`.kv-copy`、`.brain-decision` 等，复用现有变量（`--bg-*`/`--fg-*`/`--border` 等，见文件顶部变量）。

## 4. 测试与验收（verifier）

新增测试（命名/风格跟随 hub/test 现有文件）：
1. `hub/test/brain.test.js`：纯函数单测（normalizeBrainPatch 边界、restoreBrain 容错、parseBrainReply 合法/围栏/非法、buildBrainPrompt 含目标与失败任务、brainToJson nextThinkAt/decisions 裁剪）。
2. `hub/test/brain-hub.test.js`：`createHub` + 注入 `brainThink` fake：
   - auto 模式 `requestBrainThink` 返回 `link_task` + `retry_task`，断言任务 goalId/taskIds、任务被重新排队、决策记录 executed；
   - `suggest` 模式不产生任何变更；
   - 非法 JSON / LLM 异常只写 `lastError`，不抛到调用方；
   - `updateBrain` 校验与广播。
3. `hub/test/goals-link.test.js`：link 已有计划任务 → 子任务 `context.goalId` 继承、`listGoalTasks` 返回 childProgress、unlink 清理、`createFollowUp` 继承 goalId、HTTP `GET /api/goals/:id`、`POST /api/brain`（若启动真实 server 成本高，则复用现有 hub 测试的 HTTP helper）。
4. 全部现有测试不得回归：`node --test hub/test` 与仓库根 `npm test`。

文档：`docs/ARCHITECTURE.md` 增加「自主大脑」小节与目标-任务关联说明；根 `README.md` 功能列表补充“自主大脑”和“任务关联目标”。

## 5. 文件所有权（互不重叠）

| 范围 | 文件 |
| --- | --- |
| Lead | `hub/lib/brain.js`(新)、`hub/lib/journal.js`(新)、`hub/lib/hub.js`、`hub/lib/http.js`、`docs/GOAL-BRAIN-DESIGN.md` |
| web-ui | `hub/web/assets/app.js`、`hub/web/assets/i18n.js`、`hub/web/index.html`、`hub/web/assets/style.css` |
| verifier | `hub/test/brain*.test.js`、`hub/test/goals-link.test.js`、`hub/test/journal*.test.js`、`docs/ARCHITECTURE.md`、`README.md` |

## 6. 管家心路（journal）：思考与工作日志 + 每日实质推进

### 6.1 目标
- 自动记录管家的**思考**（自主大脑每次决策）与**工作**（任务/目标/计划的关键结果），按天聚合成时间线。
- 每天在本地时间 `summaryTime`（默认 `23:30`）自动生成一篇「每日总结」，回答：今天做了什么**实质推进**、遇到什么卡点、明天该干什么；也支持手动重新生成。
- 全部在控制台新增「管家心路」页面展示，并持久化到 `state.json` 的 `journal` 字段。

### 6.2 数据模型（`hub/lib/journal.js`，纯函数）
- 常量：`JOURNAL_KINDS = ['thought','work','milestone','daily']`；`MAX_ENTRIES = 800`；`MAX_DAYS = 180`；`MAX_TEXT = 4000`；`DEFAULT_SUMMARY_TIME = '23:30'`；`DEFAULT_JOURNAL = { enabled:true, summaryTime:'23:30', lastSummaryDate:null, entries:[], days:{} }`。
- Entry：`{ id:'jrn_xxx', at:ISO, date:'YYYY-MM-DD', kind, title, text, refs:{taskId?,goalId?,decisionId?}, meta:{} }`。
- Day：`{ date, summary (markdown), highlights:[{text,category}], stats:{thought,work,milestone,total,completedTasks,failedTasks}, generatedAt, model, entryCount, error? }`。
- 导出：`journalDefaults`、`normalizeJournalPatch(patch, base)`（enabled 布尔、summaryTime `HH:MM` 校验）、`restoreJournal(raw)`（容错 + 裁剪）、`appendJournalEntry(journal, entry)`（归一化/截断/上限）、`journalToJson(journal,{entries=200,days=60,date,nowMs})`、`dayKey(date, timeZone)` / `localDateKey(nowMs, timeZone)` / `localTimeKey(nowMs, timeZone)`（`Intl.DateTimeFormat`，默认系统时区）、`journalStatsForDay(entries)`、`buildDailySummaryPrompt({date,entries,stats,goals,tasks})`、`parseDailySummary(text)`（JSON/围栏容错，退化为整段 summary）、`fallbackDailySummary({date,entries,stats})`（模型不可用时的确定性总结）。
- 每日总结模型：复用 `brain.js` 的 `createBrainThinker`/`brainModelConfig`（同一 `BRAIN_*`/`AGNES_*` 配置）；无 key 时用 fallback 文案并写 `error`。

### 6.3 Hub 集成（`hub/lib/hub.js`）
- 构造器：`this.journal = restoreJournal(options.journal)`；`this._journalThinking = null`。
- `init()`：`savedObj.journal` 存在则恢复；`journal.entries` 为空时用**当天**已有任务（当天完成的）与 `brain.decisions` 回填一次（`_seedJournalFromHistory()`）；复用 `_goalTimer` 每 tick 调用 `runJournalCycle()`。
- `serializeState()` 增加 `journal: this._journalStateForPersist()`（entry/day 上限裁剪）。
- 事件记录（`appendJournalEntry` + SSE `journal.updated`，`broadcast(..., {record:false})`，不写普通 events；`journal.enabled=false` 时 `_journalEntry` 直接跳过，所有 hook 不再写入，手动 `POST /api/journal/summary` 仍可用）：
  - 思考：`_runBrainThink` 的 finally 里把本次决策写成 `kind:'thought'`（标题用 summary 截断，正文列出每个动作 + 理由 + 执行/跳过原因；失败时标题 `思考失败：<error>`）。
  - 工作：`_finishTask` 终态后写 `kind:'work'`（完成/失败/超时/取消 + 指令摘要 + 输出/错误摘要 + 设备 + 目标 refs）；`_reconcileParent` 首次出现卡点时写 `kind:'milestone'`（计划卡点）；`_goalTaskFinished` 写 `kind:'work'`（目标名称 + 检查结论摘要）；`linkGoalTask`/`unlinkGoalTask` 写 `kind:'work'`。
  - 设置变更：`updateJournal(patch)` 的 `journal.updated` 广播同样 `{record:false}`，不写普通 events（避免系统设置操作污染事件流）。
- `runJournalCycle()`：未启用/已生成今日总结/未到 `summaryTime` 时直接返回；否则调用 `generateJournalSummary({date: today}).catch(log)`。
- `async generateJournalSummary({date=今天, force=false}={})`：取当天 entries + 目标/任务统计 → 模型总结（fallback）→ 写 `journal.days[date]` 并追加一条 `kind:'daily'` entry → 广播 `journal.updated` → persist；**模型失败不抛给调用方**，返回 `{day, error}`。
- `getJournal({entries,days,date})`、`listJournalDays(limit)`、`updateJournal(patch)`、`appendJournalEntry(entry)`、`journalWork({...})`。

### 6.4 HTTP（`hub/lib/http.js`）
- `GET /api/journal?days=60&entries=300&date=YYYY-MM-DD` → `{ journal:{enabled,summaryTime,lastSummaryDate,days:[day...]}, entries:[...], hubTime }`。
- `PATCH /api/journal` body `{enabled?, summaryTime?}` → `{journal, hubTime}`（校验失败 400）。
- `POST /api/journal/summary` body `{date?, force?}` → `{day, error?, hubTime}`（date 默认今天；force 默认 true；模型不可用仍 200，`day.error` 说明原因）。
- 鉴权沿用 `requireAdmin`；SSE 新增 `journal.updated`（payload `{entry?, day?, dayKey?, at}`）。

### 6.5 Web UI（`hub/web/*`）
- 新增 tab `journal`：`TABS` 集合、index.html 底部 `.mobile-tab[data-tab="journal"]`（label 心路）、`section.panel[data-tab-panel="journal"]`。
- 页面：标题 `管家心路` + 副标题 `思考、动作与每日实质推进`；操作 `生成今日总结`、过滤器（全部/思考/工作/里程碑/每日总结）、设置行（自动记录开关 + 总结时间，PATCH）。
- 天分组倒序：日期 + 星期 + 条数；有总结则 markdown 卡片（含 highlights chips 与 stats），没有则 `尚未总结` + `生成总结`（POST force）。条目倒序：kind 图标/标签（思考/工作/里程碑/总结）、`HH:mm`、标题、正文（markdown 或 pre-wrap）、`taskId`/`goalId` 引用 chip（点击打开任务/目标抽屉）。
- 状态：`state.journal/journalBusy/journalError/journalFilter/journalDays`；进入 tab/`journal.updated` 时加载；空态与错误态文案齐全；缓存戳升级。

### 6.6 测试与文档
- `hub/test/journal.test.js`：纯函数单测（默认值、normalizeJournalPatch、restore、append/上限、dayKey/timeZone、parseDailySummary、fallbackDailySummary、prompt 含当天条目）。
- `hub/test/journal-hub.test.js`：注入 `brainThink`（思考条目落盘）、任务完成后写 work 条目、计划卡点写 milestone、`generateJournalSummary` 用注入模型生成 day + daily entry、无 key 时 fallback 且不抛、HTTP GET/PATCH/POST summary、SSE 不记录普通 events、持久化恢复。
- 文档：`docs/ARCHITECTURE.md` 增加「管家心路」小节与数据模型；`README.md` 功能列表与测试计数更新；`docs/GOAL-BRAIN-DESIGN.md` 本节即契约。

## 7. 头脑风暴（对话大脑）

### 7.1 目标与数据模型
- 控制台新增「头脑风暴」页：与自主大脑多轮对话，用来梳理方向、拆解目标、评估取舍；任意一条大脑回复可一键转成任务（可同时关联到长期目标）。
- 数据持久化在 `state.json` 的 `brainstorm` 字段：`{ activeId:null, sessions:[{id,title,createdAt,updatedAt,messages:[{id,role:'user'|'assistant',at,text,model?,error?}]}] }`。
- 上限：`sessions` 30、每会话 `messages` 200、单条 `text` 8000 字符；标题取首条用户消息截断 40 字；无模型配置时对话仍保存并返回错误提示，不抛给调用方。

### 7.2 模块 `hub/lib/brainstorm.js`（纯函数，无 I/O）
- 导出：`DEFAULT_BRAINSTORM = {activeId:null, sessions:[]}`、`MAX_SESSIONS=30`、`MAX_MESSAGES=200`、`MAX_TEXT=8000`、`restoreBrainstorm(raw)`、`createSession({title?})`、`appendMessage(session, {role,text,error?})`（越界裁剪、更新 `updatedAt`、首条用户消息定标题）、`sessionSummary(session)` → `{id,title,createdAt,updatedAt,messageCount,lastMessageAt,preview}`、`brainstormToJson(brainstorm,{messages=100,sessionId})` → `{activeId, sessions:[summary], session?}`、`normalizeChatRequest(body)` → `{ok,value|errors}`（`sessionId<=80`、`message` 非空 <=8000）、`buildBrainstormPrompt({history,userMessage,context})` → `{system,user}`。
- 提示词：中文、markdown 为主、区分事实/假设、给 2–3 个方案并推荐一个、指出风险与下一步；不要求 JSON。用户侧 prompt 包含管家上下文（长期目标、进行中/失败任务、最近心路总结）与最近 12 条对话。
- 模型配置复用 `brain.js` 的 `brainModelConfig()/createBrainThinker()`（同一 `BRAIN_*`/`AGNES_*` 环境变量），不新增配置项。

### 7.3 Hub 集成（`hub/lib/hub.js`）
- 构造器：`this.brainstorm = restoreBrainstorm(options.brainstorm)`；`_brainstormThinkInjected = typeof options.brainstormThink === 'function'`；`this.brainstormThink`；惰性 `_brainstormThinker`。
- `init()`：`savedObj.brainstorm` 存在则 `restoreBrainstorm`。
- `serializeState()` 增加 `brainstorm: this._brainstormStateForPersist()`。
- 方法：
  - `getBrainstorm({messages=100, sessionId}={})`：返回 `brainstormToJson`，`session` 缺省取 `activeId` 或最近更新的会话。
  - `listBrainstormSessions()`、`createBrainstormSession()`、`deleteBrainstormSession(id)`。
  - `async chatBrainstorm({sessionId, message})`：无会话则新建；追加 user 消息 → 组上下文（目标、活跃任务、最近 3 天心路总结）→ `buildBrainstormPrompt` → 大脑模型 → 追加 assistant 消息（模型失败时 assistant 消息带 `error`，不抛）→ `broadcast('brainstorm.updated',{session},{record:false})` → log/persist → 返回 `{session, reply, error}`。
  - `brainstormMessageToTask({sessionId, messageId, goalId})`：取 assistant 消息，用正文作为任务指令（标题取首行 80 字），`createTask({instruction, priority:6, context:{brainstorm:true, sessionId, messageId}, goalId})`；`goalId` 存在时自动登记关联（走 `_registerGoalTask`）。
- 事件：仅 SSE `brainstorm.updated`（`record:false`），不写常规 events。

### 7.4 HTTP（`hub/lib/http.js`）
- `GET /api/brainstorm?messages=1..200&session=<id>` → `{brainstorm:{activeId,sessions:[summary...]}, session, hubTime}`。
- `POST /api/brainstorm/chat` body `{sessionId?, message}` → `{session, reply, error?, hubTime}`；参数非法 400；模型未配置/失败仍 200，`error` 说明原因且 assistant 消息已带 error。
- `POST /api/brainstorm/sessions` → `{session, brainstorm:{activeId,sessions}, hubTime}`。
- `DELETE /api/brainstorm/sessions/:id` → `{ok:true, brainstorm, hubTime}`；不存在 404。
- `POST /api/brainstorm/to-task` body `{sessionId, messageId, goalId?}` → `{task, session, hubTime}`；消息不存在 400/404。

### 7.5 Web UI（`hub/web/*`）
- 新增 tab `brainstorm`（标签「对话」，移动端同为「对话」）：`TABS`、`section.panel[data-tab-panel="brainstorm"]`、移动端 `.mobile-tab[data-tab="brainstorm"]`。
- 页面：标题 `头脑风暴` + 副标题 `直接和大脑聊思路、拆目标、做取舍`；左侧会话列表（新建、删除、标题+预览+时间），右侧消息流（用户右侧强调色气泡；大脑左侧卡片，markdown 渲染，带 `复制 / 转成任务 / 关联目标` 操作），底部输入框 + 发送（Enter 发送，Shift+Enter 换行，busy 时禁用并显示「大脑思考中…」）。
- 空态：开场白 + 3 个建议问题按钮（示例：把「求职」目标拆成本周 3 个行动；评估自由职业先做哪个方向；指出当前计划里最可能失败的一步）。
- 状态：`state.brainstorm/brainstormBusy/brainstormError/brainstormSessions/brainstormSession`；进入 tab 拉取，SSE `brainstorm.updated` 刷新；缓存戳升级；i18n 增加 zh/en `brainstorm.*` 键。
- 「关联目标」从 `state.goals` 里选（目标 drawer 里已有 goalById，可复用）；转任务成功 toast 提示并可直接打开任务抽屉。

### 7.6 测试与文档
- `hub/test/brainstorm.test.js`：默认值/restore/上限裁剪/标题/appendMessage/sessionSummary/brainstormToJson/normalizeChatRequest/buildBrainstormPrompt（含上下文与历史）。
- `hub/test/brainstorm-hub.test.js`：注入 `brainstormThink` 的对话落盘、会话自动创建、模型抛错不抛、to-task 生成任务与目标关联、持久化恢复、HTTP GET/POST/DELETE/to-task、SSE 不写常规 events。
- 文档：`docs/ARCHITECTURE.md` 增加 §3.10 头脑风暴与 §4.8 数据模型；`README.md` 增加功能 bullet、API 示例、测试计数；本节即契约。
- 文件所有权：Lead 负责 `hub/lib/*`；web-ui 负责 `hub/web/*`（含 `i18n.js`）；verifier 负责 `hub/test/brainstorm*.test.js`、`docs/ARCHITECTURE.md`、`README.md`。

## 8. 自适应思考节律 + 六步思考协议

### 8.1 目标
- 没活干时降低思考频次（减少 LLM 调用与 token 消耗）；有活干时保持节奏。
- 每次思考固定走六步：现在有什么目标 → 进度在哪里 → 有什么更好的工作方式 → 我需要改进哪里 → 我可以做什么推进 → 是否要提醒主人做什么/参与哪部分可加速。

### 8.2 大脑状态新增字段（`brain.js` / `state.json.brain`）
- `adaptive`（布尔，默认 true）：是否启用自适应节律；关闭后一律用 `intervalSec`。
- `idleStreak`：连续空闲轮数（0 = 有活）。
- `effectiveIntervalSec`：下一次实际使用的间隔（`adaptive` 时 = `min(intervalSec * 2^idleStreak, MAX_IDLE_SEC=1800)`）。
- `nextThinkAt`：显式排期；存在时优先于 `lastThinkAt + intervalSec`。
- `skippedCycles`：自上次真实思考以来跳过的轮数（没有新信号时直接跳过模型调用）。
- `lastAssessment`：最近一次六步思考结论 `{goals, progress, betterWay, improvement, myMove, ownerAsk}`（各 ≤400 字）。
- `ownerAsk`：需要主人参与的事项 `{text, at, goalId?}`；PATCH `/api/brain {ownerAskAck:true}` 清除。
- `restoreBrain` 容错恢复以上字段；PATCH 支持 `adaptive`、`ownerAskAck`。

### 8.3 节律规则（Hub）
- `_brainWorkload()` 统计「有活」信号：执行中任务、可重试失败（attempts < maxAttempts）、待确认提案、近期到期的目标检查、有在线设备时的排队任务。
- `_brainHasNewSignalsSince(lastThinkAt)`：上次思考后任务/目标/审批/心路/头脑风暴是否有变化，或目标检查已到期。
- `runBrainCycle()`：到期后若 `busy=false` 且无新信号且已思考过 → **跳过模型调用**（`skippedCycles++`、间隔按 2 倍退避、广播 brain.updated、写 debug 日志），否则正常思考。
- `_runBrainThink()` 结束（finally）：`busy` 或执行了动作为 → `idleStreak=0`、`effectiveIntervalSec=intervalSec`；否则 `idleStreak++`、按 2 倍退避，封顶 1800s；`nextThinkAt = now + effectiveIntervalSec`；错误时重置为基准间隔并重排（配置错误尽快暴露）。
- 手动思考（`POST /api/brain/think`）不受跳过规则影响，但同样更新节律。

### 8.4 六步思考协议（提示词 + 解析）
- `buildBrainPrompt`：系统提示要求严格 JSON：
  `{"assessment":{"goals":"现在有什么目标","progress":"进度在哪里","betterWay":"有什么更好的工作方式","improvement":"我需要改进哪里","myMove":"我可以做什么推进进度","ownerAsk":"需要主人做什么（无则空字符串）"},"summary":"一句话结论","actions":[{...同现有}]}`
  并要求：先完成六步再给动作；`actions` 为空是合法且常见的；`ownerAsk` 只在确实需要主人决策/授权/提供信息时填写。
- `parseBrainReply` 返回 `{ summary, actions, assessment, ownerAsk }`；`assessment` 逐字段截断，`ownerAsk` 非空时归一化为 `{text, goalId?}`。
- 决策记录新增 `assessment`、`ownerAsk` 字段；`brain.lastAssessment`、`brain.ownerAsk` 同步，SSE `brain.updated` 携带。
- 心路：思考条目的正文包含六步摘要（有 `ownerAsk` 时写「需要主人：…」）。
- 控制台：自主大脑卡片/抽屉展示最近一次六步思考、需要主人的事项（可「知道了」清除）、当前节律（基准间隔 / 实际间隔 / 空闲连续轮数 / 跳过轮数 / 下次思考时间）。

### 8.5 测试
- `brain.test.js`：`normalizeAssessment`、`parseBrainReply`（含/不含 assessment、ownerAsk 归一化）、`restoreBrain` 新字段、`computeNextThinkAt` 优先 `nextThinkAt`、`brainToJson` 新字段、`normalizeBrainPatch`（adaptive/ownerAskAck）、提示词包含六步。
- `brain-hub.test.js`：空闲时 `runBrainCycle` 跳过模型调用且退避；有活时重置节律；执行动作后 `nextThinkAt` 按基准间隔；ownerAsk 落库与 ack 清除；心路包含六步。

### 8.6 与心智（Soul / Skill）的关系
- 每轮思考的系统提示由 `buildBrainPrompt(snapshot, { mind })` 组装：自主管家身份 + 六步要求 + **灵魂（Soul）** + **工作流程（Skill）** + 动作白名单/保守原则。
- 心智内容可在控制台「心智」页编辑，通过 `GET/PATCH /api/mind` 读写，持久化在 `state.json.mind`；详见 `docs/SOUL-SKILL-DESIGN.md` §9。
- 心智只影响判断与表达，不改变输出结构：`assessment` 六步与 `actions` 严格 JSON 保持不变；安全/授权约束仍然最高优先级。
