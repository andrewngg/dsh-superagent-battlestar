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
- 手机端 Tab 支持 hash：`#status`、`#tasks`、`#command`、`#goals`、`#reminders`、`#settings`。
- 连接页可手动填写 Hub 地址与管理员令牌；设置面板可退出并清除本机令牌。

## 已实现交互

- 顶部：品牌、在线/总数、运行/排队、SSE 连接状态（绿点）、刷新、设置、退出。
- 统计卡：在线设备、运行任务、排队任务、已完成、失败/超时。
- 设备卡：在线圆点与状态、平台/kind/tags、负载条 `running/max`、最后心跳相对时间、models/profiles/gateways/skills chips（折叠 `+N`）；点击打开详情抽屉（完整能力清单、resources、metrics、endpoint、最近任务、禁用/删除）。
- 指令区：大输入框 + 模型/目标设备下拉 + 技能多选 chips + 优先级/超时；发送后展示路由结果（选中设备、候选分数、excluded 原因），无匹配时明确提示「已排队，等待设备上线」。
- 项目归属：指令区新增「项目（可选）」输入（项目名或绝对路径），随 `requirements.project` 下发；决定本机 Hermes CLI 任务归入哪个 Hermes 项目（留空则用设备默认项目/设备名），任务详情 requirements chips 会显示「项目 …」。
- 任务区：最新在上、状态徽章与颜色、设备、耗时、进度条（含 indeterminate）、实时执行步骤（运行中显示「子任务：… / 正在执行：工具 / 执行步骤：…」，来源于设备侧 `progress` 事件）、输出 Markdown 渲染（GFM 表格：对齐、表头、斑马纹、横向滚动，窄屏转卡片式；任务输出可切「渲染 / 原文」）、错误、事件时间线展开、取消/重试、任务详情抽屉。
- 任务筛选：默认只看「进行中」（`state.taskFilter = 'active'`），可切换「全部 / 已完成 / 失败 / 已归档」，各 chip 实时显示计数。
- 任务详情：指令若含 Markdown（标题 / 列表 / 表格 / 代码块等）会像输出一样渲染为可视化视图，并可「渲染 / 原文」切换；指令超过约 6 行（或 280 字符）时默认折叠并渐隐，右上角「展开指令 / 收起指令」切换（`aria-expanded` 同步），让输出结果成为视觉重心。输出区同样保持「渲染 / 原文」切换。
- 子任务与恢复（手机端友好）：任务卡片收起时仍显示「子任务 N/M」+ 失败数徽章与恢复按钮（`taskRecoveryStrip`：重试失败子任务 / 重试 / 继续任务）；任务详情新增「子任务」「任务线程」区块，可查看每个子任务状态/错误、单条重试、一键重试全部失败子任务、或从某一步继续（`retryFailedChildren` / `childTasksSection` / `threadStepsSection`）；列表顶部展示「N 个失败任务可重试或继续」提示，可一键切到「失败」筛选（`#task-recovery-hint`）。
- SSE：`EventSource /api/events?token=`，断线指数退避重连，不可用时 5s 轮询 `/api/snapshot` 兜底；页面重新可见/网络恢复时补一次快照。
- 安全：所有服务端数据均通过 `textContent` / DOM 节点渲染；Markdown 表格/列表等只构造 DOM 或输出转义后的 HTML（链接白名单），不把未转义的用户数据插入 HTML。任务记录抽屉与任务输出共用同一套表格解析（`parseTableAt` / `md-table`），保证两侧呈现一致。
- 开发 Tab（Developer Mode）：DSH 的回复按 Markdown 渲染（标题 / 列表 / 代码块 / GFM 表格，复用任务输出的同一套安全 DOM 渲染），手机端阅读更舒适；用户消息与错误提示仍以纯文本展示。

## 长期目标（Goals）

- 目标卡片/详情支持「立即跟进、暂停止、恢复自动跟进、停止、编辑、删除」；待确认提案行有「同意 / 跳过这次 / 否决」。暂停或已停止的目标都可点「恢复自动跟进」，恢复后从当前时间重排下一次跟进。
- 「新的指导指令」：详情「描述」下方有指导列表与输入框，写下方向后调用 `POST /api/goals/:id/guidance`（trim 后 1–2000 字，最多 20 条）；之后的每次自动跟进任务都会带上最近 6 条（越靠后越新），已有待确认提案也会同步刷新，输入成功会提示「将在下次自动跟进时生效」。
- 「暂停止」抽屉提供四种方式：跳过下一次（保持进行中，`POST /api/goals/:id/skip`，下次跟进顺延一个计划周期并清空待确认提案）、暂停 1 天、暂停到指定时间（`datetime-local`，默认明天此刻）、一直暂停（手动恢复）。暂停到点后 Hub 自动恢复为进行中并重排下一次，无需手动操作。
- 卡片显示「已暂停至 … · 到点自动恢复」或「已暂停 · 等你手动恢复」；详情基础信息另显示「自动恢复时间」。暂停期间不会自动创建跟进提案，但「立即跟进」仍可手动执行。

## 提醒（Reminders）

控制台新增「提醒」Tab（桌面平铺在「长期目标」下方，手机底部 Tab 含「提醒」），支持提醒的增删改查与启用/停用：

- 列表按到期时间升序，展示标题、备注、到期时间（本机时区）、重复方式（不重复/每天/每周）、通知方式（温和通知/闹钟）与状态（已过期/已停用/已提醒）；点击卡片或「编辑」打开抽屉表单。
- 新建/编辑抽屉：标题（必填，≤80 字）、备注（≤500 字）、日期时间（`datetime-local`，新建默认当前 +10 分钟）、重复方式、通知方式（温和通知/闹钟，默认温和通知）、启用开关；保存后增量更新列表并提示。
- 删除使用确认弹窗；启用/停用与删除均调用 `/api/reminders` 系列接口，Hub 未启用提醒（404）时页面降级提示「暂不支持」并禁用新建按钮。
- **通知只在手机 APK 内生效**：浏览器仅做管理，不会弹出系统通知。页面在加载列表及每次增删改/启停后调用 `window.ButlerBridge.syncReminders(JSON.stringify({reminders:[…]}))`，每项包含 `notifyStyle`（`gentle` 普通通知 / `alarm` 闹钟式），由 APK 用原生 AlarmManager 调度并选择通知渠道；APK 返回 `permissionGranted=false` 时页面提示去系统设置开启通知权限。浏览器（无 `ButlerBridge`）中自动跳过同步并显示说明。
- 无构建、无新依赖；文案全部走 `i18n.js` 的 `reminders.*` key（中英双语）。

## 开发期验证记录

本会话沙箱禁止 Chromium 创建 Mojo 命名管道，**Chrome headless 无法启动**（`FATAL:mojo...platform_channel.cc Access is denied`，Chrome/Edge/headless-shell 均失败，且无法申请更高权限），因此 `screenshots/*.png` 未生成。等价的功能验证使用了真实 `index.html + app.js` 的 DOM 级测试（linkedom，不入库）：

- mock dev-server + 桌面/手机 DOM 自检：47/47 通过（布局 DOM、抽屉、表单、路由结果、取消/重试、事件展开、XSS、手机 Tab）。
- 真实 Hub + 3 台模拟设备（`scripts/simulate-devices.js`）：27/27 通过（SSE 首帧/增量、任务完成、真实能力、排队 excluded、XSS、`/m`）。
- 连接流程：13/13 通过（错误令牌、手动连接、localStorage 记忆、自动重连、退出清理、地址栏 token 清理、不可达 Hub 提示）。
- 真实 Hub 静态检查：`/`、`/m`、`/assets/app.js`、`/assets/style.css` 200 且与本地文件 SHA256 一致；无 token 401、缺失资源/路径穿越 404。

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
