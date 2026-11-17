# BattleStar · Web / 手机控制台

零依赖、无构建步骤的原生 HTML/CSS/JS 前端，由 Hub 静态服务（`hub/web`），桌面 `/` 与手机 `/m` 共用同一份响应式页面。

## 文件

| 文件 | 说明 |
| --- | --- |
| `index.html` | 单页应用骨架：连接页、主控制台、设备/任务详情抽屉、确认弹窗、Toast、SVG 图标 |
| `assets/app.js` | 全部逻辑：连接与令牌记忆、`/api/snapshot`、SSE + 轮询兜底、设备/任务/指令渲染、路由结果、XSS 安全 Markdown |
| `assets/style.css` | 深蓝紫渐变 + 玻璃拟态暗色主题；状态色、桌面/手机响应式、safe-area、底部 Tab |
| `dev-server.js` | 独立 mock API + 静态服务器（端口 7399），用于脱离真实 Hub 开发与截图 |

## 启动

```bash
# 1) 独立开发 / 截图：mock API（3 台在线 + 1 台离线，5 个示例任务，SSE 每 3s 推送）
node hub/web/dev-server.js
#   http://127.0.0.1:7399/?token=demo       桌面
#   http://127.0.0.1:7399/m?token=demo     手机

# 2) 真实 Hub
node hub/server.js --port 7317
#   启动日志会打印 http://<lan-ip>:7317/m?token=<adminToken>
```

## 连接与 URL 参数

- `?token=<adminToken>`：自动连接；成功后写入 `localStorage`（`sb.hub.token` / `sb.hub.base`），并清理地址栏中的 token。
- `?base=<url>`（可选）：指定跨源 Hub 地址；同源（由 Hub 自己提供页面）时留空即可。
- `?open=device:<deviceId>` / `?open=task:<taskId>` / `?open=reminders:<reminderId>`：连接后自动打开对应详情/编辑抽屉。
- 分类 hash（桌面分类导航与手机底部 Tab 共用）：`#overview`、`#tasks`、`#brain`、`#goals`、`#reminders`、`#developer`；大脑二级视图写作 `#brain:journal`、`#brain:brainstorm`（`#brain` 等价于 `#brain:card`）。旧 hash（`#status`、`#command`、`#journal`、`#brainstorm`、`#mind`）仍可打开，会自动映射到新分类。
- 桌面端「设置」不再是平铺在页面里的分类，点右上角齿轮（或 `#settings`）打开设置抽屉；手机端仍在底部 Tab 里打开设置页。
- 连接页可手动填写 Hub 地址与管理员令牌；设置面板可退出并清除本机令牌。

## 主页分类

桌面主页原来是所有面板平铺的长滚动页面，现改为「一次只显示一类」的分类控制台，顶栏下方是置顶的胶囊分类导航：

| 分类 | 内容 |
| --- | --- |
| 概览 `overview` | 总体指标、设备列表、「快速入口」（任务 / 大脑 / 目标 / 提醒，带进行中任务数、上次思考时间、未完成目标数、启用提醒数）、实时动态 |
| 任务 `tasks` | 任务筛选与任务列表（主列）+ 发指令表单（右栏；手机端把发指令排到最前） |
| 大脑 `brain` | 二级切换：自主大脑卡片 / 心路 journal / 头脑风暴 brainstorm |
| 目标 `goals` | 长期目标列表（主列）+ 每日复盘（右栏） |
| 提醒 `reminders` | 提醒列表与增删改查 |
| 开发 `developer` | Developer Mode（与右上角终端按钮一致） |
| 设置 `settings` | 仅手机端底部 Tab；桌面端改为右上角设置抽屉 |

- 分类导航会保持置顶，右栏在分类页里自动下移避开导航；「快速入口」按钮直接跳到对应分类。
- 手机端底部导航只保留 5 个一级分类（概览 / 任务 / 大脑 / 目标 / 提醒），其余功能收进「更多」二级菜单（执行记录 / 开发 / 设置）；一级分类共 6 个等分按钮，不再需要横向滚动，分类导航自动隐藏。
- 手机端「大脑」的二级切换栏（自主大脑 / 心路 / 头脑风暴）吸顶，长内容下无需滚回顶部切换。
- 手机端「心路」每条记录与每日复盘默认折叠，只留标题栏（类型 / 时间 / 标题）；点标题栏或右侧箭头展开，展开状态在重新渲染后保留。
- 面板内的业务逻辑（SSE、懒加载、抽屉）不变：目标/提醒/心路/头脑风暴仍按进入分类时懒加载，大脑卡片仍由 `/api/brain` 驱动。

## 已实现交互

- 顶部：品牌、在线/总数、运行/排队、SSE 连接状态（绿点）、刷新、设置、退出。
- 统计卡：在线设备、运行任务、排队任务、已完成、失败/超时。
- 设备卡：在线圆点与状态、平台/kind/tags、负载条 `running/max`、最后心跳相对时间、models/profiles/gateways/skills chips（折叠 `+N`）；点击打开详情抽屉（完整能力清单、resources、metrics、endpoint、最近任务、禁用/删除）。
- 指令区：大输入框 + 模型/目标设备下拉 + 技能多选 chips + 优先级/超时；发送后展示路由结果（选中设备、候选分数、excluded 原因），无匹配时明确提示「已排队，等待设备上线」。
- 项目归属：指令区新增「项目（可选）」输入（项目名或绝对路径），随 `requirements.project` 下发；决定本机 Hermes CLI 任务归入哪个 Hermes 项目（留空则用设备默认项目/设备名），任务详情 requirements chips 会显示「项目 …」。
- 任务区：最新在上、状态徽章与颜色、设备、耗时、进度条（含 indeterminate）、实时执行步骤（运行中显示「子任务：… / 正在执行：工具 / 执行步骤：…」，来源于设备侧 `progress` 事件）、输出 Markdown 渲染（GFM 表格：对齐、表头、斑马纹、横向滚动，窄屏转卡片式；任务输出可切「渲染 / 原文」）、错误、事件时间线展开、取消/重试、任务详情抽屉。
- 任务筛选：默认只看「进行中」（`state.taskFilter = 'active'`），可切换「全部 / 已完成 / 失败 / 已归档」，各 chip 实时显示计数。
- 任务详情：指令若含 Markdown（标题 / 列表 / 表格 / 代码块等）会像输出一样渲染为可视化视图，并可「渲染 / 原文」切换；指令超过约 6 行（或 280 字符）时默认折叠并渐隐，右上角「展开指令 / 收起指令」切换（`aria-expanded` 同步），让输出结果成为视觉重心。输出区同样保持「渲染 / 原文」切换。任务信息网格新增「执行器 / 模型」与运行中的「已运行」时长（本机 CLI 会显示 `本机 CLI（opencode/hermes/shell）`），超时/卡死/无进度/硬上限类错误下方追加提示：建议拆成 2–3 个更小任务或把 `timeoutSec` 调到 900–1800 秒后重试，卡死类失败在尝试次数内会自动重排一次。
- 子任务与恢复（手机端友好）：任务卡片收起时仍显示「子任务 N/M」+ 失败数徽章与恢复按钮（`taskRecoveryStrip`：重试失败子任务 / 重试 / 继续任务）；任务详情新增「子任务」「任务线程」区块，可查看每个子任务状态/错误、单条重试、一键重试全部失败子任务、或从某一步继续（`retryFailedChildren` / `childTasksSection` / `threadStepsSection`）；列表顶部展示「N 个失败任务可重试或继续」提示，可一键切到「失败」筛选（`#task-recovery-hint`）。
- SSE：`EventSource /api/events?token=`，断线指数退避重连，不可用时 5s 轮询 `/api/snapshot` 兜底；页面重新可见/网络恢复时补一次快照。
- 安全：所有服务端数据均通过 `textContent` / DOM 节点渲染；Markdown 表格/列表等只构造 DOM 或输出转义后的 HTML（链接白名单），不把未转义的用户数据插入 HTML。任务记录抽屉与任务输出共用同一套表格解析（`parseTableAt` / `md-table`），保证两侧呈现一致。
- 开发 Tab（Developer Mode）：DSH 的回复按 Markdown 渲染（标题 / 列表 / 代码块 / GFM 表格，复用任务输出的同一套安全 DOM 渲染），手机端阅读更舒适；用户消息与错误提示仍以纯文本展示。

## 长期目标（Goals）

- 目标卡片/详情支持「立即跟进、暂停止、恢复自动跟进、停止、编辑、删除」；待确认提案行有「同意 / 跳过这次 / 否决」。暂停或已停止的目标都可点「恢复自动跟进」，恢复后从当前时间重排下一次跟进。
- 「新的指导指令」：详情「描述」下方有指导列表与输入框，写下方向后调用 `POST /api/goals/:id/guidance`（trim 后 1–2000 字，最多 20 条）；之后的每次自动跟进任务都会带上最近 6 条（越靠后越新），已有待确认提案也会同步刷新，输入成功会提示「将在下次自动跟进时生效」。
- 「暂停止」抽屉提供四种方式：跳过下一次（保持进行中，`POST /api/goals/:id/skip`，下次跟进顺延一个计划周期并清空待确认提案）、暂停 1 天、暂停到指定时间（`datetime-local`，默认明天此刻）、一直暂停（手动恢复）。暂停到点后 Hub 自动恢复为进行中并重排下一次，无需手动操作。
- 卡片显示「已暂停至 … · 到点自动恢复」或「已暂停 · 等你手动恢复」；详情基础信息另显示「自动恢复时间」。暂停期间不会自动创建跟进提案，但「立即跟进」仍可手动执行。

## 自主大脑（Brain）

- 大脑分类下的「自主大脑」视图（以及大脑抽屉）展示最近一次六步思考、当前节律与「需要主人决定」的问题；问题带选项时卡片/抽屉直接渲染可点按钮（2–4 个，来自 `brain.ownerAsk.options`），点选调用 `POST /api/brain/owner-ask/choose`，成功后提示「已选择：…，下一轮思考会据此推进」；没有选项时保留「知道了」（`PATCH /api/brain {ownerAskAck:true}`）。
- 手机 APK 的决策通知栏也复用同一接口：通知栏最多 3 个选项按钮；点通知正文打开 `/m?open=brain`（App 内为 `open_tab=brain`），会切到大脑分类并高亮「自主大脑」卡片。
- 真实模型不可用/未配置 key 时，卡片会提示配置 `BRAIN_API_KEY`/`AGNES_API_KEY`/`DEEPSEEK_API_KEY`。
- 大脑可用 `consult_worker` 向「项目 ↔ 主机」映射里的设备发只读咨询任务，回答写入「咨询记录」并在下一轮提示词中出现；长期约定用 `remember` 写入「管家记忆」。控制台展示的六步思考与决策历史会带出这些上下文，方便核对大脑为什么这样判断。

## 提醒（Reminders）

控制台「提醒」分类（桌面独立分类页，手机底部 Tab 含「提醒」）支持提醒的增删改查与启用/停用：

- 列表按到期时间升序，展示标题、备注、到期时间（本机时区）、重复方式（不重复/每天/每周）、通知方式（温和通知/闹钟）与状态（已过期/已停用/已提醒）；点击卡片或「编辑」打开抽屉表单。
- 新建/编辑抽屉：标题（必填，≤80 字）、备注（≤500 字）、日期时间（`datetime-local`，新建默认当前 +10 分钟）、重复方式、通知方式（温和通知/闹钟，默认温和通知）、启用开关；保存后增量更新列表并提示。
- 删除使用确认弹窗；启用/停用与删除均调用 `/api/reminders` 系列接口，Hub 未启用提醒（404）时页面降级提示「暂不支持」并禁用新建按钮。
- **通知只在手机 APK 内生效**：浏览器仅做管理，不会弹出系统通知。页面在加载列表及每次增删改/启停后调用 `window.ButlerBridge.syncReminders(JSON.stringify({reminders:[…]}))`，每项包含 `notifyStyle`（`gentle` 普通通知 / `alarm` 闹钟式），由 APK 用原生 AlarmManager 调度并选择通知渠道；APK 返回 `permissionGranted=false` 时页面提示去系统设置开启通知权限。浏览器（无 `ButlerBridge`）中自动跳过同步并显示说明。
- 无构建、无新依赖；文案全部走 `i18n.js` 的 `reminders.*` key（中英双语）。

## 派发与母机（Settings → 派发与母机）

- 设置面板新增「派发与母机」：下拉选择母机设备或「本机（自动识别）」，调用 `PATCH /api/settings {mainDeviceId}`；保存成功后立即生效并写入 Hub `state.json`，未知设备由 Hub 返回 400「主设备不存在：…」。
- 派发优先级：显式设备要求 > 项目上次成功设备（项目亲和）> 同一线程上次执行的主机 > 母机 > 常规能力评分；首选主机离线或并发已满时任务排队等待（「亲和等待：…」），不会改派给没有项目上下文的设备；失败任务手动重试会继续留在原主机。
- 与「系统默认语言」同属 Hub 级设置；设备排序按用途昵称/机器名展示。

## 头脑风暴（Brainstorm）

大脑分类下的「头脑风暴」视图与管家大脑多轮讨论，支持把文件一起带进对话：

- 输入框下方「附件」按钮可一次选择多个文本文件（最多 6 个、单个 ≤256KB；浏览器 `file.text()` 读取为文本），选中的文件以 chips 展示、可逐个移除；
- 也可以直接在消息正文里写 Hub 本机绝对路径（Windows `C:\…`、UNC `\\…`，或 `/…`）；发送时后端会自动识别并读取这些路径。Quoted 路径（引号/反引号）同样支持，中文标点后紧跟路径也能识别；
- 发送 `POST /api/brainstorm/chat` 时请求体带 `attachments:[{name,text}]`（上传文本）或 `[{path}]`（本机路径，供 API 调用方直接使用）；Hub 会把文件内容注入提示词「用户提供的文件」段，并在 user 消息上保存附件元数据（名称/路径/大小，不保存正文）；
- 安全：Hub 拒绝读取疑似密钥/凭据文件（`.env`、`id_rsa`、`*.pem`、`*.key` 等）与二进制文件；单个文件 >512KB 或总量超过 160K 字会截断，读取失败只在提示词中注明，不阻断对话；
- 模型：默认 Agnes 做常规分析；本轮带附件、提到本机文件路径或已读到文件时，自动切到 DeepSeek（`DEEPSEEK_API_KEY`、`deepseek-chat`）读取并回答，普通对话不受影响；文件模式可用 `BRAINSTORM_FILE_MODEL` / `BRAINSTORM_FILE_BASE_URL` / `BRAINSTORM_FILE_API_KEY` 单独覆盖。只设置 `DEEPSEEK_API_KEY` 时整体自动切到 DeepSeek，也可用 `BRAINSTORM_MODEL` / `BRAINSTORM_BASE_URL` / `BRAINSTORM_API_KEY` 单独覆盖头脑风暴（变量可写在仓库根目录或 `hub/.env`，启动时自动加载且只记录键名）；
- 无构建、无新依赖；文案走 `i18n.js` 的 `brainstorm.*` key（中英双语）。

## 开发期验证记录

本会话沙箱禁止 Chromium 创建 Mojo 命名管道，**Chrome headless 无法启动**（`FATAL:mojo...platform_channel.cc Access is denied`，Chrome/Edge/headless-shell 均失败，且无法申请更高权限），因此 `screenshots/*.png` 未生成。等价的功能验证使用了真实 `index.html + app.js` 的 DOM 级测试（linkedom，不入库）：

- mock dev-server + 桌面/手机 DOM 自检：47/47 通过（布局 DOM、抽屉、表单、路由结果、取消/重试、事件展开、XSS、手机 Tab）。
- 真实 Hub + 3 台模拟设备（`scripts/simulate-devices.js`）：27/27 通过（SSE 首帧/增量、任务完成、真实能力、排队 excluded、XSS、`/m`）。
- 连接流程：13/13 通过（错误令牌、手动连接、localStorage 记忆、自动重连、退出清理、地址栏 token 清理、不可达 Hub 提示）。
- 真实 Hub 静态检查：`/`、`/m`、`/assets/app.js`、`/assets/style.css` 200 且与本地文件 SHA256 一致；无 token 401、缺失资源/路径穿越 404。

### 2026-11-17 主页分类重构

- 静态一致性校验（临时脚本，不入库）：`data-cat-view` / `data-tab` / `data-brain-view` / `data-brain-panel` / `data-goto` 与 `app.js` 的 `CATS` / `BRAIN_VIEWS` 全覆盖、无未知值；无 `data-tab-panel` 残留、无重复 id、静态资源版本号统一；`app.js` 引用的静态 id 均存在于 `index.html`。
- 分类/hash 纯函数运行期测试（从 `app.js` 抽取真实代码执行，13 条用例）：`currentTabFromHash` 覆盖空 hash、7 个分类、`#brain:journal` / `#brain:brainstorm` 与旧 hash 兼容；`syncTabHash` / `normalizeTab` / `brainViewOrDefault` 回写与兜底正确。
- 真实 Hub（7317）冒烟：`/` 200 且包含分类导航与快速入口、`/assets/app.js?v=20261117c` 含 `CATS`、`/assets/style.css?v=20261117c` 含 `.cat-nav`；`node hub/test/static.test.js` 2/2 通过。
- 沙箱仍无法启动 Chrome/Edge headless（Mojo 命名管道 Access denied），本轮未生成截图。

### 2026-11-17 手机端二级导航与心路折叠

- 手机底部导航 8 项改为「5 个一级分类 + 更多」：`#nav-more` 打开悬浮二级菜单（执行记录 / 开发 / 设置），点外部、滚动或按 Esc 自动关闭；当前分类属于二级菜单时「更多」高亮。
- 心路条目（`journalEntryNode`）与每日复盘卡（`journalSummaryCard`）在手机端默认折叠：正文包进 `.journal-entry-body` / `.journal-summary-body`，`is-open` 类控制显隐（桌面始终展开）；点标题栏或箭头按钮切换，展开状态记在 `state.journalOpen`，重新渲染后恢复。
- 静态校验脚本 `tmp/check-mobile-d.mjs`（临时，不入库）：导航 5 个一级项 + 3 个二级项、无遗留 `data-action="records"`、CSS 折叠规则、`app.js` 绑定、i18n 文案、版本号一致，全部通过。
- 真实 Hub（7317）冒烟：`/`、`/m`、`/assets/app.js?v=20261117d`、`/assets/style.css?v=20261117d`、`/assets/i18n.js?v=20261117d` 均 200 且命中新标记（`nav-more` / `toggleMobileMore` / `.mobile-more-menu` / `'更多'`）。
- 沙箱无头浏览器限制同上，未生成手机截图；建议在真机/浏览器手机模拟器里确认折叠与二级菜单手感。

### 2026-11-17 大脑直接回复窗口

- 大脑卡与大脑抽屉新增常驻「直接告诉大脑」输入框（`#brain-reply-form` / `brainReplyFormNode()`）：有 `ownerAsk` 提问时仍显示最多 4 个选项按钮，没有提问时也能主动给方向（如「选 B，先手动补投递」）。
- 回复走 `POST /api/brain/owner-ask/reply {text}`（≤1000 字，空文本 400「缺少回复内容」），写入 `brain.ownerReply` 并清空 `ownerAsk`；下一轮思考提示词出现「## 主人对上次提问的回复 / 我的回答：…」。
- 回复后在卡片与抽屉显示回显「已回复：…（时间）」；提交中禁用按钮，401 走统一登录失效处理。
- 选项细节（v=20261117f/g）：`ownerAsk.options` 支持 `{label, detail}`，后端 `MAX_OWNER_OPTION_DETAIL = 240`（`hub/lib/brain.js`），提示词要求每个选项写清「做什么/大概多久/成功或失败会怎样」、`ownerAsk.text` 自带背景，没有细节先查清再问；控制台选项按钮改为「标签 + 细节说明」两行铺开。
- 「让大脑把每个选项的细节讲清楚」按钮（`#brain-ask-detail`，v=20261117g）：问题已过期/没有选项时也能点，把该请求作为主人回复发给大脑，下一轮思考会带细节重新提问（需配合「立即思考」或等下一轮自动思考）。
- 静态校验脚本 `tmp/check-brain-reply.mjs`（临时，不入库）：回复表单/回显/CSS/i18n 7 个 key/后端路由与提示词小节/新测试用例、版本号一致，全部通过；`node hub/test/brain-hub.test.js` 20/20、`node hub/test/brain.test.js` 23/23、`node hub/test/static.test.js` 2/2。
- 真实 Hub（7317，已重启加载新后端）：`/` 含 `brain-tell-form` 与 `brain-ask-detail` 且版本 `v=20261117g`；`POST /api/brain/owner-ask/reply` 空文本带 token → 400「缺少回复内容」，无 token → 401；`/m`、`/assets/style.css?v=20261117g`、`/assets/i18n.js?v=20261117g` 均 200。

## 截图命令（在有可用 Chrome 的环境执行）

```powershell
# 先启动 mock dev-server（端口 7399，若已运行可跳过）
node hub/web/dev-server.js

& "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --disable-gpu --hide-scrollbars `
  --window-size=1440,900 --virtual-time-budget=5000 `
  --screenshot="screenshots\desktop.png" `
  "http://127.0.0.1:7399/?token=demo"

& "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --disable-gpu --hide-scrollbars `
  --window-size=390,844 --virtual-time-budget=5000 `
  --screenshot="screenshots\mobile.png" `
  "http://127.0.0.1:7399/m?token=demo"

& "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --disable-gpu --hide-scrollbars `
  --window-size=390,844 --virtual-time-budget=5000 `
  --screenshot="screenshots\mobile-tasks.png" `
  "http://127.0.0.1:7399/m?token=demo#tasks"
```

## 已知限制

- 跨源填写 Hub 地址时依赖 Hub 的 CORS 配置；推荐直接访问 Hub 自身提供的 `/` 或 `/m`（同源）。
- 极旧浏览器不支持 `backdrop-filter` / `color-mix` 时自动回退为纯色/半透明，不影响可读性。
- 安全边界同 `docs/PROTOCOL.md` §9：仅家用局域网使用，不要把 Hub 端口暴露公网。
