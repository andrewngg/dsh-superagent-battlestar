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
- `?open=device:<deviceId>` / `?open=task:<taskId>`：连接后自动打开对应详情抽屉。
- 手机端 Tab 支持 hash：`#status`、`#tasks`、`#command`、`#settings`。
- 连接页可手动填写 Hub 地址与管理员令牌；设置面板可退出并清除本机令牌。

## 已实现交互

- 顶部：品牌、在线/总数、运行/排队、SSE 连接状态（绿点）、刷新、设置、退出。
- 统计卡：在线设备、运行任务、排队任务、已完成、失败/超时。
- 设备卡：在线圆点与状态、平台/kind/tags、负载条 `running/max`、最后心跳相对时间、models/profiles/gateways/skills chips（折叠 `+N`）；点击打开详情抽屉（完整能力清单、resources、metrics、endpoint、最近任务、禁用/删除）。
- 指令区：大输入框 + 模型/目标设备下拉 + 技能多选 chips + 优先级/超时；发送后展示路由结果（选中设备、候选分数、excluded 原因），无匹配时明确提示「已排队，等待设备上线」。
- 任务区：最新在上、状态徽章与颜色、设备、耗时、进度条（含 indeterminate）、输出 Markdown、错误、事件时间线展开、取消/重试、任务详情抽屉。
- SSE：`EventSource /api/events?token=`，断线指数退避重连，不可用时 5s 轮询 `/api/snapshot` 兜底；页面重新可见/网络恢复时补一次快照。
- 安全：所有服务端数据均通过 `textContent` / DOM 节点渲染；Markdown 只构造 DOM（白名单链接），不使用 `innerHTML` 插入用户数据。

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
