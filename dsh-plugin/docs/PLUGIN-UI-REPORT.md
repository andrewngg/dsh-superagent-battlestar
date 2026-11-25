# DSH 插件界面汇总报告 —— BattleStar

> 报告对象：仓库 `super-butler` 中的 DSH 插件 `dsh-plugin/`（包名 `@local/dsh-super-butler`）。
> 报告范围：本次允许修改范围仅 `dsh-plugin/**`；本报告只新增文档，未改动插件代码。
> 数据来源：`dsh-plugin/client.js`、`dsh-plugin/index.js`、`dsh-plugin/package.json`、`dsh-plugin/cordis.patch.yml`、`dsh-plugin/test/*.test.mjs`，以及 2026-11-19 在本机 DSH Web 上做的实时接口探针（未做浏览器截图，详见第 7.4 节）。
> 公开化约定：本报告不含真实序列号、真机型号、个人账号、私钥或带用户名的绝对路径。

---

## 0. 结论摘要

| 维度 | 结论 |
| --- | --- |
| 插件加载 | ✅ 已在 DSH `desktop` profile 以本地 link 安装并随 DSH 启动；Host 前缀路由 `/super-butler/*` 实际可用（实时探针 200） |
| 界面结构 | ✅ 侧边栏入口 + DSH 主页面板，面板内含「仪表盘 / 教程 / 心智 / 设置」四个标签，共 14 个界面组件 |
| 核心能力 | ✅ 只读仪表盘（Hub/设备/任务统计）、新手教程、Soul/Skill 心智编辑、Hub 与密钥设置、Git Push、跳转浏览器控制台 |
| 安全边界 | ✅ 管理令牌不出现在页面；`/api/dsh/*` 与 Hub 控制仅 loopback；密钥只写不读、可测试、可清除 |
| 测试 | ✅ 45 项测试：44 通过、0 失败、1 跳过（真实 `git push` 受本机沙箱命名管道限制），耗时约 2.36s |
| 视觉验收 | ⏳ 未截图：DSH Web 页面需要访问令牌，本会话无法在浏览器内打开面板；建议人工补 4 张截图 |
| 文档一致性 | ⚠️ `dsh-plugin/README.md` 仍描述已删除的任务控制台，与代码不符；`docs/DSH-PLUGIN.md` 与代码一致 |

**总判定：功能与接口层面成功。** 界面本身不只读、四标签齐全、Host API 真实可用、测试通过；待补的是「视觉截图验收」与「README 同步」两项收尾工作，不影响功能结论。

---

## 1. 插件定位与安装形态

### 1.1 包元数据（`dsh-plugin/package.json`）

| 字段 | 值 |
| --- | --- |
| name | `@local/dsh-super-butler` |
| version | `0.1.0`（`private: true`，license MIT） |
| type | `module`（ESM） |
| description | 「BattleStar：在 DSH 里管理多设备管家 Hub、私人账号/模型密钥与控制台面板」 |
| exports | `.`→`./index.js`（Host）、`./client`→`./client.js`（浏览器端）、`./locale/*.json`、`./icon`→`./icon.svg` |
| files | `index.js`、`client.js`、`cordis.patch.yml`、`locale/*.json`、`icon.svg`、`LICENSE`、`README.md` |
| dsh.bundle.patch | `./cordis.patch.yml` |
| dsh.client | `platform: "web"`、`immediately: true`、`inject: ["@deepseek-ai/dsh-client-ui-layout", "@deepseek-ai/dsh-client-ui-sidebar"]` |

### 1.2 安装与加载

- 安装方式：本地 link 安装，DSH profile `desktop` 的依赖中为 `"@local/dsh-super-butler": "link:<插件目录>"`，同时出现在该 profile 的 `bundles` 列表中，属于「随 DSH 启动即加载」。
- 布局注入：`cordis.patch.yml` 以 `insert` 注入 `id: super-butler`，配置为 `hubPort: 7317`、`autoStart: true`，`projectRoot` 留空（可用环境变量 `SUPER_BUTLER_PROJECT_ROOT` 覆盖）。
- 生命周期：Host 插件在 `apply` 后注册前缀路由，并按设置做 Hub 自动启动与 DSH bridge 同步；插件卸载/DSH 退出时停止 bridge 定时器和它自己拉起的 Hub 进程（`SIGTERM`）。
- 客户端渲染时机：`immediately: true` 表示面板模块随 Web UI 一起加载，不依赖打开面板动作。

### 1.3 双端结构

```
dsh-plugin/
├─ index.js            Host 侧（1425 行）：/super-butler 前缀路由、Hub 进程管理、
│                      设置与密钥存取、DSH bridge、Git Push、快照代理
├─ client.js           浏览器侧（1015 行）：单文件模块，内置 zh/en 字典与样式，
│                      渲染侧边栏入口与主页面板（无外部构建产物）
├─ cordis.patch.yml    插入式 bundle patch（端口/自动启动/项目目录）
├─ package.json        ESM 包声明 + dsh.client 声明 + 测试脚本
├─ icon.svg            面板图标（侧边栏与面板头部共用）
├─ locale/{zh,en}.json 仅包含 bundle 级 meta（title/description），非界面文案
└─ test/*.test.mjs     5 个测试文件（VM 渲染 + 真实 Hub 集成）
```

---

## 2. 界面总览

### 2.1 入口

- **侧边栏**：`sidebar.panellist` 插槽注册一个入口，`id: super-butler`、`order: 5`、图标为 `ButlerIcon`（机器人脸 SVG，`aria-hidden`），文案取 `t('panel')`（BattleStar）。
- **主页面板**：`main` 插槽注册 key `super-butler`，点击侧边栏入口后在 DSH 主区域打开 `Panel`。

### 2.2 布局骨架

```
┌───────────────────────────────────────────────────────────────┐
│ [42px 图标块]  BattleStar 母机                   ● 运行中       │
│                多设备 AI 管家 · 控制台与密钥                    │
│ [ 仪表盘 ] [ 教程 ] [ 心智 ] [ 设置 ]          ← 4 个标签按钮   │
├───────────────────────────────────────────────────────────────┤
│  ┌ Hub 状态卡 ─────────────────────────────────────────────┐  │
│  │ ● 运行中    http://127.0.0.1:7317 · 外部进程            │  │
│  │ [在浏览器打开控制台] [教程] [刷新] [重启 Hub] [停止 Hub]│  │
│  └─────────────────────────────────────────────────────────┘  │
│  消息条（错误红 / 状态灰）                                      │
│  ┌统计磁贴┐┌统计磁贴┐┌统计磁贴┐┌统计磁贴┐┌统计磁贴┐          │
│  │在线 3/3││运行 0  ││排队 0  ││完成 135││失败 4 │          │
│  └────────┘└────────┘└────────┘└────────┘└────────┘          │
│  设备 (3)   [设备卡] [设备卡] [设备卡]                          │
│  最近任务 (N)   ○ 指令摘要…  设备 · 2 分钟前                    │
└───────────────────────────────────────────────────────────────┘
```

容器：`height: 100%`、`overflow: auto`、内边距 `22px 26px`、内容最大宽度 `1080px`、背景取主题 token；面板只用 Web 桌面宽度，无移动端专门适配。

### 2.3 四标签导航

| key | 文案 | 组件 | 数据来源 |
| --- | --- | --- | --- |
| `console`（默认） | 仪表盘 | `ConsoleTab` | `GET /api/status`、`GET /api/snapshot?limit=80` |
| `guide` | 教程 | `GuideTab` | 复用父级 `status`（Hub origin、joinCode），无独立请求 |
| `mind` | 心智 | `MindTab` | `GET /api/mind`，写 `PATCH /api/mind` |
| `settings` | 设置 | `SettingsTab` | `GET /api/settings`，写 `POST /api/settings`，另有 `/api/test-credential`、`/api/dsh/git-push` |

标签用普通按钮实现，激活项套用主按钮样式（蓝底白字）；面板 `state.tab` 默认 `console`，切换不重新挂载其他标签的数据逻辑（各 Tab 自己管请求）。

### 2.4 视觉规范

主题适配：颜色全部走 DSH 主题 CSS 变量（深浅色主题自动跟随），仅主按钮用固定品牌蓝。

| token | 变量 | 用途 |
| --- | --- | --- |
| bg | `--dsw-alias-bg-base` | 面板背景 |
| layer | `--dsw-alias-bg-layer-1` | 卡片背景 |
| layer2 | `--dsw-alias-bg-layer-2` | 内层块/次级区域 |
| border | `--dsw-alias-border-l1` | 卡片描边 |
| border2 | `--dsw-alias-border-l2` | 分隔线 |
| text | `--dsw-alias-label-primary` | 主文本 |
| sub | `--dsw-alias-label-secondary` | 次要文本 |
| brand | `--dsw-alias-brand-primary` | 品牌色 |
| ok / warn / err / idle | `--dsw-alias-state-*` | 状态色 |

- 主按钮固定色 `ACCENT = #2f6bff`：代码注释说明暗色主题下 `brand-primary` 与白字同色导致不可读，因此主按钮固定蓝底白字。
- 尺寸规范：卡片圆角 12px、内边距 16px；按钮圆角 8px、内边距 `7px 14px`；输入框圆角 8px、内边距 `8px 10px`；chip 圆角 999；代码块等宽 12px、最大高度 240px；统计数值 24px。

状态色映射（`statusTone`）：

| 任务状态 | 颜色 |
| --- | --- |
| completed | ok（绿） |
| failed / timeout / cancelled | err（红） |
| running / assigned / waiting | warn（黄） |
| 其他（queued 等） | idle（灰） |

时间显示：`< 60s` →「刚刚」，`< 1h` →「N 分钟前」，否则「N 小时前」。

### 2.5 组件清单（14 个）

| 组件 | 行号（client.js） | 职责 |
| --- | --- | --- |
| `ButlerIcon` | 329 | 侧边栏/面板图标（24 视窗 SVG） |
| `Badge` | 342 | 状态胶囊 |
| `Field` | 346 | 表单字段（label + 控件） |
| `DeviceCard` | 355 | 只读设备卡 |
| `RecentTaskRow` | 391 | 只读任务行 |
| `Stat` | 476 | 统计磁贴 |
| `ConsoleTab` | 408 | 仪表盘 |
| `CodeBlock` | 484 | 带复制按钮的命令块 |
| `Step` | 509 | 教程步骤 |
| `GuideTab` | 517 | 教程页 |
| `SettingsTab` | 571 | 设置页 |
| `MindTab` | 728 | 心智页 |
| `Panel` | 846 | 面板外壳（头部/标签/轮询） |
| `PanelSlot` | 992 | 插槽入口包装（`__ModuleLoader__.load`） |

---

## 3. 逐页说明

### 3.1 仪表盘（ConsoleTab）

**Hub 状态卡**

- 状态徽章：`运行中` / `未运行`。
- 说明文字：Hub origin（如 `http://127.0.0.1:7317`）+ 归属：插件托管时为「· 插件托管」，外部进程启动时为「· 外部进程」。
- 按钮矩阵：

| 条件 | 按钮 | 行为 |
| --- | --- | --- |
| 始终 | **在浏览器打开控制台**（主按钮，`<a target="_blank">`） | 打开 `/super-butler/api/dsh/open`，Host 302 跳转到 Hub 控制台并自动带上管理员令牌 |
| 始终 | 教程 | 切到「教程」标签 |
| 始终（请求中禁用） | 刷新 | 重新 `load()`（并行拉 status/snapshot/settings） |
| 始终（请求中禁用） | 重启 Hub | `POST /api/hub/restart`；成功提示「Hub 正在重启，约 15 秒后自动刷新…」，3 秒后自动重载 |
| 运行中 | **停止 Hub**（仅插件托管可用） | `POST /api/hub/stop`；外部进程时按钮禁用，提示需在外部终端停止 |
| 未运行 | **启动 Hub**（主按钮） | `POST /api/hub/start` |

- 按钮 `title` 会解释：重启插件托管/外部 Hub 的差别、外部 Hub 无法被插件停止等。
- 请求失败/成功的提示显示为消息条：错误时红色 `role="alert"`，普通提示 `role="status"`；重启返回 `ok:false` 时显示 `reason`。
- Host 缺路由（旧版本 DSH 未加载插件）时，重启按钮给出明确文案：需完全退出并重新打开 DeepSeek Harness。

**统计磁贴（5 个）**

响应式网格 `auto-fit minmax(140px, 1fr)`，数值来自 `snapshot.stats`：

| 磁贴 | 数据 | 说明 |
| --- | --- | --- |
| 在线设备 | `devicesOnline / devicesTotal` | — |
| 运行中 | `tasksRunning + tasksWaiting` | 合并「执行中 + 等待中」 |
| 排队 | `tasksQueued` | — |
| 已完成 | `tasksCompleted` | — |
| 失败/超时 | `tasksFailed` | 数值用错误色 |

**设备区**

- 标题 `设备 (N)`；卡片 flex 换行，单卡最小 220px、基准 260px。
- `DeviceCard` 字段：9px 在线状态点；昵称（回退机器名/ID）；徽章 `在线`/`离线`/`已禁用`；机器名副行（与昵称不同时）；`平台 · kind · 负载 running/max`；「最后心跳 + 相对时间」；最多 3 个模型 chip，多余显示 `+N` 计数。
- 卡片**完全只读**：不可改名、不可禁用、不可删除（这些操作在浏览器控制台侧完成）。
- 空态：「暂无设备。启动第一台工作机后…」（附教程入口）。

**最近任务**

- 标题 `最近任务 (N)`，右侧提示「任务下发、追问与结果查看在浏览器控制台」。
- 先过滤掉 `parentTaskId` / `replyToTaskId` 的子任务与回复任务，再取前 **6** 条。
- 行结构：状态色标签（最小宽 54）→ 指令摘要（90 字截断，`title` 保留全文）→ `设备名/ID · 相对时间`。
- 空态：「暂无任务。发送一条指令试试。」

**加载与错误态**

- 首次进入与每 5 秒并行请求 `/status`、`/snapshot?limit=80`、`/settings`。
- `snapshot`/`settings` 单独失败时保留旧数据（`catch → null`），不打断页面；`status` 失败时面板顶部显示「加载失败: <原因>」错误卡，5 秒后自动重试。
- 面板没有显式骨架屏，首次加载期间为空白区域 + 最终错误卡/数据。

### 3.2 教程（GuideTab）

- 顶部说明卡：解释母机 Hub 负责调度、工作机负责执行，并说明页面上的地址与加入码已按当前状态自动填好。
- 三组步骤卡（`Step` 序号 + 说明 + `CodeBlock` 命令）：

| 分组 | 步数 | 内容要点 |
| --- | --- | --- |
| 添加 PC 工作机 | 6 | 克隆仓库 → 复制 `cli-machine.example.json` → `node device-agent/agent.js --hub <Hub 地址> --join-code <加入码> --name "<工作机名>" --config … --state-dir …` → 在控制台确认上线 |
| 手机 Mika 工作机 | 6 | Mika App（Android 11+）→ Settings › Model → Connect a computer（USB/Wi-Fi）→ `pipx install 'git+https://…/Mika.git@<tag>#subdirectory=tools/mika'` + `mika doctor --json` → 复制 `phone-mika.example.json` → 在桥接电脑运行 agent |
| 手机控制端 | 3 | 浏览器打开 `<Hub 地址>/m?token=<管理员令牌>` → 安装 `dist/BattleStar-0.1.5.apk`（Android 8+，扫码后自动扫描）→ 控制端只做查看与发指令，执行在工作机 |

- `CodeBlock`：右上角复制按钮，`navigator.clipboard` 可用时写入并在 1.5s 内显示「已复制」；不可用时文本保持可手动选中复制（降级不报错）。
- 排错卡 3 条：工作机离线、加入码不匹配、任务路由异常；底部 `guideDocs` 指引到 `docs/WORKER-SETUP.md`、`docs/MIKA-PHONE.md`、`docs/APK.md`。
- 地址/加入码为空时回退占位：`http://<母机IP>:7317`、`<加入码>`。

### 3.3 心智（MindTab）

- 两个多行文本框：**Soul（灵魂）** 与 **Skill（工作流程）**，`rows=10`、等宽 12px、纵向可拉伸。
- 字数上限：Soul 6000 / Skill 12000（来自 `mind.limits`，缺省即 6000/12000），显示 `n / limit`。
- 每个字段：徽章「使用默认内容 / 自定义内容」+「恢复默认」按钮；页头显示「最后更新时间 / 尚未修改」。
- 底部：**全部恢复默认** 与 **保存心智**（无改动、保存中、或 Host 过期时禁用）。
- 请求：挂载时 `GET /api/mind`；保存 `PATCH /api/mind`，正文 `{ soul, skill }` 或 `{ resetSoul: true }` / `{ resetSkill: true }`；成功/失败以消息条反馈。
- `hostStale`（Host 返回 404 未知路由，说明 DSH 里跑的还是旧插件）：显示黄色横幅提示重启 DSH，同时文本框置只读、保存按钮禁用，避免把改写覆盖到错误状态。

### 3.4 设置（SettingsTab）

**Hub 设置**

| 字段 | 说明 |
| --- | --- |
| 项目目录 `projectRoot` | BattleStar 仓库路径（Hub 与 Git Push 的根） |
| 开发指令工作区 `devWorkspacePath` | Developer Mode 会话归属的可选覆盖；留空则按 projectRoot 自动选 |
| 母机昵称 `hubNickname` | 显示在面板标题，缺省「BattleStar」 |
| Hub 端口 `hubPort` | 默认 7317 |
| GitHub 用户名 `githubUser` | Git Push 使用的远端账号提示 |
| 默认模型 `defaultModel` | Hub 侧默认模型 |
| 自动启动 `autoStart` | 复选框：DSH 启动时是否顺带拉起 Hub |
| 加入码 | 只读展示当前 Hub joinCode（供工作机接入） |

- 顶部提示：Developer Mode 的会话工作区归属规则（按 projectRoot 自动选择工作区）。
- 保存：`POST /api/settings`（`settings` + `secrets` 一起提交），成功后重新拉取状态并提示「设置已保存」。
- 变更生效范围：端口/项目目录需重启 Hub 才生效；Host 端代码改动需重启 DSH；客户端改动需刷新页面。
- 安全提示：管理令牌由插件代理，不在页面暴露（`adminTokenHidden`）。

**私人账号与密钥（5 项）**

| 字段 | 语义 | 测试端点（只读 GET） |
| --- | --- | --- |
| `githubToken` | GitHub Token | `https://api.github.com/user` |
| `deepseekApiKey` | DeepSeek | `https://api.deepseek.com/models` |
| `agnesApiKey` | Agnes | `https://apihub.agnes-ai.com/v1/models` |
| `doubaoApiKey` | 豆包/火山方舟（环境变量 `ARK_API_KEY`） | `https://ark.cn-beijing.volces.com/api/v3/models` |
| `opencodeApiKey` | OpenCode Zen | `https://opencode.ai/zen/v1/models` |

- 输入框为 password、`autoComplete="off"`、占位 `••••••••`，**不回显已保存的密钥**；每项只显示「已配置 / 未配置」徽章。
- 存储来源：优先 DSH credentials 服务；来源为插件本地回退文件时额外显示「本机文件」小字（回退文件权限 0600，位于 Hub 数据目录，已被仓库忽略）。
- 操作：「测试 Token」（已配置时可用）→ `POST /api/test-credential`，结果显示「可用 / 无效 / 无法判定」+ HTTP 状态码 + 延迟 ms + 错误信息，按结果着色；「清除」→ 走 `POST /api/settings` 的 `clearSecrets`。
- 当 credentials 服务不可用，页面顶部出现黄色回退提示，说明密钥会存到本机插件文件。
- 提示文案：密钥保存于 Harness credentials、不写入项目文件；输入框留空表示不修改。

**开发工具：Git Push**

- 进入页面时 `GET /api/dsh/git-push` 读取仓库信息：仓库、分支、远端、上游（无上游显示「未设置（首次推送会自动设置）」），读取中显示「正在读取仓库信息…」。
- 点击「Git Push」→ `POST /api/dsh/git-push`，按钮变「Git 推送中…」；结果「推送完成 / 推送失败」+ message + branch + 命令输出（`<pre>`，红色错误文本）。
- Host 侧行为：从 `projectRoot` 向上定位 `.git`；无 upstream 时自动 `git push --set-upstream <remote> <branch>`；超时 120s；错误码覆盖 `no_repo` / `no_remote` / `detached_head` / `timeout` / `spawn_failed`；输出写临时文件，不使用子进程管道。
- 失败若是「未知路由」，页面直接提示重启 DSH（说明插件 Run-time 尚未加载该路由）。

---

## 4. Host API 与数据流

### 4.1 调用链

```
DSH Web UI（浏览器）
   │  同源 fetch：/super-butler/api/*
   ▼
Host 插件（index.js，ctx.webServer.register 前缀 /super-butler）
   │  注入管理员令牌，代理到 Hub
   ▼
Hub（http://127.0.0.1:7317，令牌来自 hub/data/state.json）
   │
   ├─ 设备心跳 / 任务队列 / 结果
   └─ DSH bridge：Host 写 <dataDir>/dsh-bridge.json 并 POST /api/dsh/bridge

「在浏览器打开控制台」：GET /super-butler/api/dsh/open → 302 → Hub 控制台（带令牌、no-store）
```

### 4.2 路由清单

以下路由均挂在 `/super-butler` 前缀下（Host 内 `routeHandler`，仅处理 `/super-butler/*`）。

| 方法 | 路径 | 用途 | 备注 |
| --- | --- | --- | --- |
| GET | `/api/status` | 插件总状态 | Hub 运行状态/健康/origin/joinCode（掩码）、settings、secrets 配置标记、credentials 模式 |
| GET | `/api/settings` | 读取设置 | secrets 只返回 `configured/source` |
| POST | `/api/settings` | 保存设置 | 支持 `settings`、`secrets`、`clearSecrets`；返回 `results[].storage` |
| POST | `/api/test-credential` | 测试密钥 | 仅 GET 只读端点，避免写操作 |
| GET | `/api/mind` | 读取 Soul/Skill | 代理 Hub |
| PATCH / PUT | `/api/mind` | 保存 / 重置心智 | 代理 Hub |
| GET | `/api/snapshot?limit=` | 设备+任务快照 | limit 限制 1–200，默认 50；面板用 80 |
| POST | `/api/tasks` | 下发任务 | 代理 Hub |
| POST | `/api/tasks/:id/cancel` / `retry` / `archive` / `unarchive` | 任务操作 | 代理 Hub |
| POST | `/api/tasks/:id/follow-up` | 追问 | 代理 Hub |
| POST | `/api/tasks/:id/answer` | 回答 Mika 提问 | 代理 Hub |
| POST | `/api/tasks/:id/status` | 手动改任务状态 | 见 4.4 |
| DELETE | `/api/tasks/:id` | 删除任务 | 代理 Hub |
| PATCH / DELETE | `/api/devices/:id` | 设备改名/禁用/删除 | 代理 Hub（面板未暴露入口） |
| POST | `/api/hub/start` / `stop` / `restart` | Hub 进程控制 | 仅 loopback；stop 只对插件托管进程生效 |
| GET | `/api/dsh/status` | bridge 状态 | 仅 loopback；返回会话/工作区/运行中 job |
| POST | `/api/dsh/chat` | 从 Hub 向 DSH 发指令 | 仅 loopback；`message` 非空且 ≤20000 字符，202 返回 job |
| GET | `/api/dsh/jobs` / `/api/dsh/job/:id` | 查询 job | 仅 loopback；列表保留最近 20 条 |
| POST | `/api/dsh/reset` | 清空 DSH 会话 | 仅 loopback |
| GET | `/api/dsh/open` | 打开 Hub 控制台 | 仅 loopback；302 + 自动带管理员令牌 + `Cache-Control: no-store` |
| GET / POST | `/api/dsh/git-push` | 查询仓库 / 执行推送 | 仅 loopback |
| GET | `/`（前缀根） | 能力声明 | 返回 `{ name: "BattleStar", routes: [15 条], features: ["task-status-manual","task-status-cancel-first","hub-restart","mind-proxy"] }` |

其他约定：未知路由返回 404 `{ error: { code: "not_found", message: "未知路由：<METHOD> <sub>" } }`；异常统一 500 `battlestar_error`；POST 正文上限 1MB。

### 4.3 安全边界

| 边界 | 实现 |
| --- | --- |
| 管理令牌 | 由 Host 从 `hub/data/state.json` 读取后代理注入 Hub 请求；面板侧只显示「已隐藏」，不提供查看/编辑入口 |
| 控制台跳转 | `GET /api/dsh/open` 仅 loopback，302 带令牌但 `no-store`，避免令牌留在浏览器缓存/Referer |
| Developer Mode 接口 | `/api/dsh/*`（status/chat/jobs/reset/git-push/open）非 loopback 一律 403「Developer Mode 只允许本机访问」 |
| Hub 进程控制 | `/api/hub/start|stop|restart` 非 loopback 403「Hub 控制只允许本机访问」 |
| 密钥 | 只写不读：接口只返回 configured/source；输入框不回显；写入优先 credentials 服务，回退为本机文件（0600，gitignore） |
| 密钥注入 | 仅在插件自身拉起 Hub 子进程时注入环境变量（`GITHUB_TOKEN`、`DEEPSEEK_API_KEY`、`AGNES_API_KEY`、`ARK_API_KEY`、`OPENCODE_API_KEY`）；外部终端启动的 Hub 不会自动获得 |
| Git 命令 | 不使用 shell 拼接，参数数组传参；输出经临时文件收集（不依赖子进程管道） |

### 4.4 手动任务状态 API（面板未暴露）

Host 保留 `POST /api/tasks/:id/status`，供浏览器控制台/APK 等前端使用；语义如下：

| 目标状态 | 行为 |
| --- | --- |
| `completed` / `failed` | 若任务处于 active（queued/assigned/running/waiting）先取消设备执行，再写 external-result；取消失败且仍 active 则透传错误 |
| `cancelled` | 直接取消 |
| `queued` | 重新排队（retry） |
| `note` 为空 | 保留原有输出/错误文本，使用默认文案「管理员在 DSH 面板手动标记完成/失败」 |
| 计划父任务 | 非 cancelled 一律 409「长任务拆分的状态由子任务汇总，只能取消」 |

> 说明：`dsh-plugin/README.md` 仍宣称面板内可「标记完成/失败、重新排队、继续追问」，但当前 `client.js` 已不含这些按钮与 `TaskRow/TaskDetail/Dialog` 组件（测试也显式断言其不存在）。面板是**只读仪表盘**，任务操作统一跳浏览器控制台。此 API 能力保留并通过集成测试，属于「能力在、入口不在」。

---

## 5. 运行时行为与降级策略

| 场景 | 表现 |
| --- | --- |
| 正常 | 进入面板即拉数据；之后每 5s 轮询一次；切换标签不重复拉 `/status`（快照/设置仍由 `Panel.load` 定时刷新） |
| Hub 未运行 | 状态徽章「未运行」，统计/设备/任务可能为空或旧值；「启动 Hub」可用；「停止 Hub」禁用 |
| Hub 由外部终端启动 | 归属显示「外部进程」；停止按钮禁用并提示去外部终端停止；重启可用（走 `/api/hub/restart`） |
| 旧版 Host 未加载插件路由 | 请求 404「未知路由」→ 页面提示重启 DSH；心智页进入只读 + 横幅；Git Push 同样提示重启 |
| `/snapshot` 或 `/settings` 失败 | 静默保留旧数据，不打断页面，下个轮询周期自动重试 |
| `/status` 失败 | 顶部「加载失败: …」错误卡，每 5s 重试 |
| 重启 Hub | 提示约 15 秒恢复，3 秒后自动重载；若返回 `ok:false` 显示原因 |
| 剪贴板不可用 | 复制按钮不报错，代码块文本仍可手动选中 |
| API 异常 | `call()` 解析 `error.message` 后抛出，由各页面转成消息条/错误卡 |

---

## 6. 主题与国际化

### 6.1 主题

- 12 个语义色 token 全部映射 DSH 主题变量，深浅色主题自动适配；主按钮例外（固定 `#2f6bff`）以避免暗色下白字与品牌色同色。
- 面板背景随主题（`--dsw-alias-bg-base`），卡片用 layer-1 + 1px border，未硬编码白色/黑色，无「亮色写死」问题。
- 图标为内联 SVG（`currentColor` 语义由上下文文本色决定），无外部图片资源。

### 6.2 国际化

- 命名空间 `superButler`，注册方式 `locale.register(NS, { zh, en })`；`client.js` 内置两份字典，**各 240 键，键集合完全一致（无单边键）**。
- `locale/zh.json`、`locale/en.json` 仅提供 bundle 级 `meta.title` / `meta.description`，不承载界面文案。
- **死键问题**：按「键名是否在 `client.js` 中以带引号字符串出现」的启发式统计，240 键中约 **99 键（≈41%）未被引用**，典型残留：`taskId`、`manualStatus`、`markCompleted`、`markFailed`、`requeue`、`followUp`、`answer`、`detail`、`dialogOk`、`removeDevice`、`disableDevice`、`edit/rename/saveName`、`command/send/sent` 等 —— 来自已删除的任务控制台与设备编辑 UI。测试只校验字典中存在这些键，因此不会报错。
- 影响：包体偏大、误导后续维护（以为面板有这些功能）；不影响运行。

---

## 7. 测试与验收证据

### 7.1 安装证据

- DSH `desktop` profile 的 `package.json` 中依赖包含 `@local/dsh-super-butler`（`link:` 指向本仓库 `dsh-plugin`），且该 profile 的 `bundles` 列表包含 `@local/dsh-super-butler`。
- 说明插件是「已安装 + 已启用」状态，而非仅存在于源码目录。

### 7.2 插件测试

执行方式（直接调用 node，绕过 npm.ps1 的命名管道限制）：

```
node --test --test-isolation=none test/client-module.test.mjs test/client-render.test.mjs \
  test/status-route.test.mjs test/status-route-integration.test.mjs test/dev-workspace.test.mjs
```

结果：**45 项，44 通过，0 失败，1 跳过，耗时 2361.4ms**。

| 覆盖域 | 说明 |
| --- | --- |
| 模块契约（client-module） | manifest id、`apply` 注册 locale 与两个插槽、槽位 key/order、只读性质断言（无 `window.prompt`、无 `TaskRow/TaskDetail/Dialog`、无 `call('/tasks')`）、引用了 `/api/dsh/open`、`--join-code`、`/dsh/git-push` |
| 渲染（client-render，VM + React stub） | 仪表盘只读、统计磁贴、设备卡（昵称/离线/chips）、最近任务过滤、教程地址与加入码、设置页 Git Push 与凭据回退提示、心智页、重启外部 Hub |
| 工作区归属（dev-workspace） | 祖先工作区自动归属、sessionController 延迟解析、无 workspaceRegistry 回退 cwd、显式 devWorkspacePath 覆盖 |
| Host 路由（status-route） | 手动改状态（先取消再完成、保留 output、plan 父任务 409、取消失败透传）、loopback 403、git push（no_repo/no_remote/repo info）、Hub 自重启/外部重启、bridge URL 同步、设置回退/credentials 优先、密钥掩码与测试 |
| 真实 Hub 集成（status-route-integration） | 在内存/真实 Hub 上验证 queued 任务先取消再强制完成、强制失败、plan 父任务只允许取消 |

跳过项：`POST /api/dsh/git-push pushes the current branch to the configured remote`，原因是当前沙箱禁止 MSYS sh 创建命名对象，真实推送只能在沙箱外验证（属环境限制，非代码缺陷）。

### 7.3 实时接口探针（2026-11-19，本机 DSH Web）

| 请求 | 状态 | 关键观测 |
| --- | --- | --- |
| `GET /super-butler/` | 200 | `name: BattleStar`、`routes: 15`、`features: [task-status-manual, task-status-cancel-first, hub-restart, mind-proxy]` |
| `GET /super-butler/api/status` | 200 | Hub `running: true`、`owned: false`、port `7317`、origin `http://127.0.0.1:7317`、health ok、version `0.1.0`、protocol `1`、uptime ≈ 86934s（约 24.1h）、joinCode 掩码存在；settings 含 projectRoot/hubPort/hubHost/autoStart/dataDir/devWorkspacePath/githubUser/defaultModel/hubNickname；`adminTokenMasked` 为空 |
| `GET /super-butler/api/settings` | 200 | 5 个密钥项中 3 个 configured（source: file，即 credentials 服务），2 个未配置 |
| `GET /super-butler/api/snapshot?limit=5` | 200 | server version `0.1.0`；`stats = { devicesTotal: 3, devicesOnline: 3, tasksQueued: 0, tasksAssigned: 0, tasksRunning: 0, tasksWaiting: 0, tasksCompleted: 135, tasksFailed: 4 }`；3 台设备均在线 |

结论：插件 Host 路由已被 DSH Web 正常挂载并返回真实数据，界面所需的三类数据源（状态/快照/设置）全部可用。

### 7.4 视觉验收（未做）

- 原因：DSH Web 页面需要访问令牌（终端直接请求返回 401），本会话环境无法在浏览器中打开并截图；插件目录内也无现成面板截图（`screenshots/` 下 3 张是 Hub Web 控制台截图，不是 DSH 面板）。
- 建议人工复核步骤：打开 DSH Web → 侧边栏点 BattleStar → 依次截「仪表盘 / 教程 / 心智 / 设置」四张（深浅色主题各一轮更佳）→ 存入 `dsh-plugin/docs/screenshots/` 并在文档中引用。
- 未做视觉验收不影响代码/接口结论，但深色主题观感、窄窗口折行、真实数据下的空态等仍需肉眼确认。

---

## 8. 已知限制与风险

| # | 限制/风险 | 影响 | 现状/建议 |
| --- | --- | --- | --- |
| 1 | 仪表盘只读 | 面板内不能标记完成/失败、改需求、追问 | 设计如此，跳浏览器控制台（302 自动登录）；README 需同步 |
| 2 | 5 秒轮询，无 SSE/WebSocket | 状态最多滞后 5s，多客户端不同步 | 可接受；后续可评估事件推送 |
| 3 | 密钥仅注入插件拉起的 Hub | 外部终端启动的 Hub 无这些环境变量 | 文档已提示；可选择「重启 Hub 由插件托管」 |
| 4 | 端口/目录变更需重启 Hub；Host 改动需重启 DSH；client 改动需刷新页面 | 生效有延迟 | 页面已给出对应提示，属预期行为 |
| 5 | 视觉未截图验收 | 观感/折行未确认 | 见 7.4，建议补 4 张截图 |
| 6 | `dsh-plugin/README.md` 与代码漂移 | 读者以为面板仍有任务控制台 | 建议按本报告重写 README 的功能段（P1） |
| 7 | 99 个未引用 i18n 键（≈41%） | 包体冗余、误导维护 | 建议清理或恢复对应 UI（P1） |
| 8 | 标签页缺少 `role="tab"`/`aria-selected`，无键盘左右切换 | 可访问性一般 | 可改为语义化 tablist（P2） |
| 9 | 最近任务固定 6 条、无分页/搜索 | 任务多时需跳控制台 | 设计取舍，可接受 |
| 10 | 快照每 5s 拉 `limit=80` 全量 | 数据量大时带宽/解析开销增加（当前量级无感） | 可改增量或按需刷新（P2） |

---

## 9. 建议（按优先级）

**P1（收尾必做）**

1. 同步 `dsh-plugin/README.md`：删除已不存在的任务控制台/手动状态/追问描述，改为「只读仪表盘 + 浏览器控制台」口径，并指向 `docs/DSH-PLUGIN.md` 与本报告。
2. 补 4 张面板截图（仪表盘/教程/心智/设置）并入库到 `dsh-plugin/docs/screenshots/`，完成视觉验收。
3. 清理 99 个死键（或明确保留并注释原因），让 i18n 体积与功能一致。

**P2（体验优化）**

4. 标签页语义化（`role="tablist"/"tab"/"tabpanel"` + 键盘左右键）。
5. 评估 SSE/WebSocket 替代 5s 轮询，降低数据滞后。
6. 统计/设备/任务区抽成可复用组件，减少 `client.js` 单文件体积（当前 1015 行）。
7. 英文文案审校（现有 en 字典与 zh 同结构，但部分术语可统一为 «hub / worker / task»）。

---

## 10. 验收清单

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| 插件已安装并随 DSH 加载 | ✅ | desktop profile 依赖 + bundles 列表；`/super-butler/` 200 |
| 侧边栏入口 + 主页面板 | ✅ | `apply` 注册 `main` 与 `sidebar.panellist`；client-module 测试 |
| 四标签可渲染且默认仪表盘 | ✅ | client-render 测试；Panel 代码 |
| 仪表盘只读（Hub/统计/设备/任务） | ✅ | 代码无写操作；测试断言无 TaskRow/Dialog/prompt |
| 跳转浏览器控制台（302 带令牌） | ✅ | `/api/dsh/open` 实现 + 探针 200 路由列表 |
| 教程三步指南 + 复制按钮 + 排错 | ✅ | GuideTab/CodeBlock 代码 + 渲染测试 |
| 心智读写、上限、恢复默认、过期只读 | ✅ | MindTab + status-route 代理测试 |
| 设置保存（Hub/密钥）与徽章 | ✅ | SettingsTab + settings 路由测试 |
| 密钥测试/清除、不回显 | ✅ | test-credential + 掩码实现 + 测试 |
| Git Push（仓库信息 + 推送） | ✅/⏳ | 路由与前端完成；真实推送测试 skip（沙箱） |
| Hub 启动/停止/重启（外部进程保护） | ✅ | status-route 测试覆盖外部/托管两种 |
| loopback 安全边界 | ✅ | 403 测试 + 代码 |
| 插件测试 | ✅ | 45 项 / 44 通过 / 1 跳过 / 0 失败 |
| 视觉截图验收 | ⏳ | 见 7.4，需人工补图 |
| README 与代码一致 | ⏳ | 见 8-6，建议 P1 修正 |

---

## 附录 A：文件清单（插件内）

| 文件 | 大小/行数 | 说明 |
| --- | --- | --- |
| `client.js` | 65616B / 1015 行 | 浏览器端单文件模块（四页 + 14 组件 + 主题 + 双语字典） |
| `index.js` | 56360B / 1425 行 | Host 路由、Hub 管理、设置/密钥、bridge、Git Push |
| `package.json` | 1044B / 39 行 | 包声明 + `dsh.client` + 测试脚本 |
| `cordis.patch.yml` | 298B / 8 行 | bundle 插入配置（hubPort/autoStart/projectRoot） |
| `README.md` | 3619B / 58 行 | ⚠️ 含过期功能描述（见 8-6） |
| `locale/zh.json` / `en.json` | 190B / 194B | 仅 `meta.title` / `meta.description` |
| `icon.svg` | — | 侧边栏与面板图标 |
| `test/client-module.test.mjs` | 4954B | 模块契约与只读断言 |
| `test/client-render.test.mjs` | 13380B / 300 行 | VM 渲染测试 |
| `test/status-route.test.mjs` | 27160B / 696 行 | Host 路由与安全测试 |
| `test/status-route-integration.test.mjs` | 5357B | 真实 Hub 集成测试 |
| `test/dev-workspace.test.mjs` | 8426B | 工作区归属测试 |

## 附录 B：复检命令

```bash
# 1) 插件测试（在 dsh-plugin/ 下）
node --test --test-isolation=none test/*.test.mjs

# 2) 探针（DSH Web 端口以实际为准；本机实测 53032）
curl http://127.0.0.1:<DSH 端口>/super-butler/
curl http://127.0.0.1:<DSH 端口>/super-butler/api/status
curl "http://127.0.0.1:<DSH 端口>/super-butler/api/snapshot?limit=5"
```

> 注：本机 PowerShell 下经管道调用 node 会被沙箱拒绝（命名管道限制），请直接执行 node 或用 `Start-Process` 重定向到文件；`npm test` 亦可能受此影响。

## 附录 C：术语

| 术语 | 含义 |
| --- | --- |
| 母机 Hub | 调度中心（默认端口 7317），维护设备、任务队列与状态 |
| 工作机 / 设备 | 执行任务的 PC 或手机（Mika） |
| Developer Mode | DSH 内的开发会话；插件按 `projectRoot`/`devWorkspacePath` 决定会话工作区归属 |
| 心智（Mind） | Hub 的 Soul（灵魂）与 Skill（工作流程）两段提示词 |
| DSH bridge | Hub 与 DSH 之间的双向通道（Host 写 `<dataDir>/dsh-bridge.json` 并 POST Hub） |

---

*报告生成：2026-11-19 · 编写范围：仅 `dsh-plugin/**` · 未执行 git push。*
