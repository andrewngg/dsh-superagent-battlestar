# DSH 插件：BattleStar

把「BattleStar」做成 DeepSeek Harness 的持久化插件：在 Web UI 侧边栏查看只读仪表盘，
并在插件设置里统一管理 Hub、私人账号与模型密钥。

- 插件包：`super-butler/dsh-plugin/`（`@local/dsh-super-butler@0.1.0`）
- 安装 profile 示例：`desktop`（`~/.dsh/profiles/<profile>/package.json` 的 bundle 列表）
- 入口：侧边栏「BattleStar」图标（order 5）
- 面板：`main` 槽位的 `super-butler` 页，含「仪表盘 / 教程 / 设置」三个标签；仪表盘顶部提供
  「在浏览器打开控制台」入口，任务下发、设备管理与任务详情都在浏览器控制台完成

## 1. 安装

在目标 profile 中安装后刷新 DSH 页面即可看到侧边栏入口。安装命令：

```text
plugin_manager(action: "install_bundle", target: "<abs>/super-butler/dsh-plugin")
```

安装后刷新 DSH Web 页面即可看到侧边栏图标。插件目录通过 `link:` 链接安装，
修改 `client.js` / `index.js` 后重新加载页面即可；Host 代码变更需要重启 Harness。

## 2. 面板功能

### 仪表盘（只读）

- Hub 状态：运行中/未运行、Hub 地址（`origin`）、是否由插件托管；右侧「启动 / 停止 Hub」与「刷新」
  （停止只对插件自己启动的 Hub 生效；外部终端启动的 Hub 用 **「重启 Hub」**——插件调用 Hub 的
  自重启接口 `POST /api/system/restart`，进程原地 re-exec 并加载新代码，不需要知道启动命令）；
- **「在浏览器打开控制台」**：跳转 `GET /super-butler/api/dsh/open`，Host 读取 Hub 管理员令牌后
  302 到 `http://<hub>/?token=<adminToken>`，浏览器打开完整 Web 控制台（任务下发、任务详情、
  设备管理、改用途昵称都在那里操作）；
- 任务统计磁贴：在线设备 / 运行中 / 排队 / 已完成 / 失败 / 超时（来自 `snapshot.stats`）；
- 设备卡（只读）：在线状态、**用途昵称**（保存在 Hub，设备重报机器名不会覆盖）、平台/kind、
  负载、最后心跳、最多 3 个模型 chips；不提供改名/禁用/删除入口；
- 最近任务（只读前 6 条）：状态、指令摘要、执行设备与相对时间，不提供取消/重试；
- 每 5 秒自动刷新（插件内不依赖 iframe，使用 Harness 主题 token 原生渲染）。

### 教程（接入工作机）

- 面板第二个标签，把母机 Hub 之外的机器接成工作机的分步指南；
- **添加 PC 工作机**：Node 18+、克隆仓库、复制 `device-agent/configs/cli-machine.example.json`、
  用 `--hub` / `--join-code` / `--name` / `--config` / `--state-dir` 启动 `device-agent/agent.js`，
  回到仪表盘看到绿点即接入成功；
- **添加手机工作机（Mika）**：安装 Mika（Android 11+，Settings › Model）、在
  Settings › Connect a computer 选 USB/Wi-Fi、桥电脑安装 Mika CLI 并用 `mika doctor` 验证、
  复制 `phone-mika.example.json` 后由桥电脑启动代理（手机本身不用装 Node）；
- **手机当控制端**：浏览器打开 `<hub>/m?token=<管理员令牌>` 或安装
  `dist/BattleStar-0.1.2.apk`（Android 8+，首次自动扫描同 Wi-Fi Hub，只填令牌）；
- 命令块里的 **Hub 地址与设备加入码取自当前 `/status`**（`hub.origin` / `hub.joinCode`），
  可直接一键复制；教程还列出「设备一直离线 / 加入码无效 / 任务没有派到设备」三项排错与
  `docs/WORKER-SETUP.md`、`docs/MIKA-PHONE.md`、`docs/APK.md` 指引。

### 设置

- **Hub**：项目目录、端口、是否随 DSH 启动自动启动、默认模型、GitHub 用户名；
- **私人账号与密钥**：GitHub Token、DeepSeek API Key、Agnes AI API Key、
  豆包/火山方舟 API Key、OpenCode API Key；
- 每个已配置密钥旁有 **「测试 Token」**：调用各自的只读接口（GitHub `/user`、
  模型服务 `/models`）检查 Token 是否可用，显示 HTTP 状态、耗时与结果
  （`可用` / `无效` / `无法判定`，无法判定表示服务不支持该只读接口）；
- 密钥优先保存在 Harness **credentials 服务**（profile 的私有存储，`source: file`），
  不写入项目文件、不在页面回显；留空表示不修改，点「清除」删除已保存条目；
- 若 credentials 服务在插件运行期不可用（例如 Harness 升级后凭据 provider 尚未激活），
  插件会退回把密钥写入 `<dataDir>/plugin-secrets.json`（0600，默认在已 gitignore 的
  `hub/data/`），设置页会显示黄色提示并在每个密钥旁标注「本机文件」；重启 Harness 后
  若服务恢复，插件会重新优先使用 credentials 服务（可用 `GET /super-butler/api/status`
  的 `credentials.available` / `credentials.storage` 判断当前模式）；
- **开发工具 → Git Push**：在母机项目仓库执行 `git push`，只推送**已经提交**的内容
  （不暂存、不修改任何文件）；面板先显示检测到的仓库/分支/远端/上游，点击按钮后显示
  「推送完成 / 推送失败」与 git 原始输出；分支还没有上游（例如刚建好的 `master`）时
  自动执行 `git push --set-upstream origin master` 并提示「已推送并设置上游分支」；
  找不到 `.git`、没有远端、detached HEAD 或超时（2 分钟）都会给出可读提示；
- 插件启动 Hub 时会把已配置密钥解析为子进程环境变量：
  `GITHUB_TOKEN`、`DEEPSEEK_API_KEY`、`AGNES_API_KEY`、`ARK_API_KEY`、`OPENCODE_API_KEY`，
  供管家后续统筹各设备时使用。

## 3. Host 实现

`dsh-plugin/index.js`：

- `inject: ['webServer']`，通过 `plugin_manager` 安装为 Host 插件；
- 通过 `ctx.webServer.register({ kind: 'prefix', path: '/super-butler', handler })` 暴露：
  - `GET  /super-butler/api/status` — Hub 状态、设置、密钥配置状态，以及
    `credentials: { available, storage }`（`storage` 为 `harness` 或 `plugin-local`）；
  - `GET  /super-butler/api/settings` — 非敏感设置 + 密钥状态 + credentials 可用性；
  - `POST /super-butler/api/settings` — 保存设置 / 设置或清除密钥；保存结果里的
    `results[].storage` 标明该条目落在 Harness 凭据还是本机文件；
  - `GET  /super-butler/api/snapshot` — 代理 Hub 设备/任务快照；
  - `GET  /super-butler/api/dsh/open` — 读取 Hub 管理员令牌后 302 到 Web 控制台
    （`http://<hub>/?token=...`，`Cache-Control: no-store`）；仅接受本机 loopback 调用，
    其他来源返回 403 `forbidden`，避免令牌被局域网页面借道；
  - `GET  /super-butler/api/dsh/git-push` — 从 `projectRoot` 向上定位 git 仓库，
    返回 `{ repo, branch, remote, upstream }`（`upstream` 为空表示分支还没设置跟踪上游）；
  - `POST /super-butler/api/dsh/git-push` — 在仓库目录执行 `git push`，返回
    `{ ok, code, message, output, repo, branch, remote, upstream, setUpstream }`；
    分支没有上游时自动改用 `git push --set-upstream <remote> <branch>`（首次推送不会
    再报 `The current branch has no upstream branch`）；没有远端或处于 detached HEAD 时
    返回可读的 `no_remote` / `detached_head` 提示；命令用临时文件收集输出
    （不给子进程开管道），2 分钟超时；同样仅接受本机 loopback，其他来源 403；
  - DSH bridge 地址自动同步：桌面版 DSH 每次启动的 Web 端口可能不同，插件启动时读取
    `ctx.webServer.getOrigin()`，把 `<origin>/super-butler/api/dsh` 写进 Hub 的
    `<dataDir>/dsh-bridge.json`，并 `POST <hub>/api/dsh/bridge` 通知运行中的 Hub；
    插件自己启动 Hub 时还会通过环境变量 `DSH_BRIDGE_URL` 直接注入。Hub 代理失败但磁盘
    地址已更新时会自动重试一次，所以手机开发页不会再因为 DSH 换端口而 `fetch failed`；
  - `POST /super-butler/api/tasks` — 代理建任务；
  - `PATCH /super-butler/api/devices/:id` — 代理修改设备昵称 / 标签 / 禁用状态；`DELETE` 代理移除设备；
  - `POST /super-butler/api/tasks/:id/cancel|retry` — 代理取消/重试；
  - `POST /super-butler/api/hub/start|stop` — 启动/停止 Hub（停止仅对插件托管的进程生效）；
  - `POST /super-butler/api/hub/restart` — 重启 Hub：运行中时调用 Hub 自重启接口
    `POST /api/system/restart`（外部进程也可用，进程 re-exec 后加载新代码）；Hub 没在运行时
    直接拉起；旧 Hub 不支持自重启且不是插件托管时返回 409 与可读原因；以上 hub 控制路由都只接受本机 loopback；
- 自动检测 7317 上是否已有 Hub；没有且 `autoStart` 为真时，用 `node hub/server.js` 启动，
  日志写入 `hub/data/plugin-hub.log`；
- 从 `hub/data/state.json` 读取管理员令牌与加入码，代理请求时自动附加，
  面板页面不接触管理员令牌；
- 插件卸载/禁用时终止由自己启动的 Hub 子进程（不动外部进程）。

### Developer Mode 会话的工作区归属

APK/控制台发送「开发指令」时，插件通过 `sessionController` 在 DSH 里创建（或复用）一个 Developer Mode 会话：

- 默认自动选择**包含项目目录（`projectRoot`）的最近工作区**作为会话归属：优先调用
  `session.create({ workspaceId })`。DSH 会以工作区目录为 cwd 创建会话并把它加入该工作区的
  `sessionIds`，因此侧边栏里会归到对应项目（例如 `super ai`），而不是「未分组」；
- 可用 `devWorkspacePath` 设置（设置页的「开发指令工作区」）显式指定工作区目录；
- 找不到匹配工作区、或 DSH 版本不支持 `workspaceId` 时，回退到旧的
  `create({ cwd: projectRoot })`：会话显示在「未分组」，但开发指令仍可执行；
- 会话归属可通过 `GET /super-butler/api/dsh/status` 的 `workspace*` / `sessionWorkspace*` 字段查看；
- 已有会话不会自动迁移（DSH 只允许 cwd 等于工作区目录的会话挂载到工作区）；改动归属设置后
  下一次开发指令会重新建会话，旧会话仍留在「未分组」，可手动删除。
- `sessionController` / `approval` / `workspaceRegistry` 都在**每次使用时重新解析**：Harness
  重启或升级后，这些 Host 服务可能比插件挂载晚激活，一次性捕获会把 undefined 永久缓存，
  开发指令就会一直报「DSH sessionController 不可用」；现在挂载后晚激活也能正常使用。

## 4. Client 实现

`dsh-plugin/client.js`（浏览器模块，`window.__ModuleLoader__.load`）：

- `ctx.locale.register('superButler', { zh, en })`，注册中英文案；
- `ctx.slots.inject('sidebar.panellist', ...)` 注册侧边栏图标；
- `ctx.slots.inject('main', ...)` 注册 key 为 `super-butler` 的主面板；
- 面板只渲染只读仪表盘（Hub 状态、统计磁贴、只读设备卡、最近任务）、接入教程与设置页；
  任务下发、任务详情、设备改名/禁用/删除等交互一律跳转浏览器控制台，
  客户端因此不再包含任务 composer、`TaskRow`/`TaskDetail` 与弹窗组件；
- React 组件使用 `--dsw-alias-*` 主题 token，不引入 Harness Client 包，不操作 DOM/iframe；
- 所有数据通过同源 `/super-butler/api/*` 获取。

## 5. 验证记录（本机）

- `plugin_manager install_bundle` → `application: applied`；profile `package.json` 出现
  `"@local/dsh-super-butler": "link:..."`，bundle 列表包含该包；
- Host 路由实测 200：`/super-butler/api/status`、`/settings`、`/snapshot`（1 台设备、3 个任务）；
- `GET /super-butler/api/dsh/git-push` 实测返回仓库/分支/远端；`POST` 在无 `.git` 时返回
  `{ ok: false, code: 'no_repo' }`，非 loopback 来源返回 403；
- 插件测试 44 项：`dsh-plugin/test` 43 通过 + 1 项真实 `git push` 集成测试在 DSH 文件沙箱下
  跳过（沙箱禁止 MSYS 的 `sh.exe` 创建命名对象；插件 Host 进程不受该沙箱限制）；
- 凭证持久化实测：设置测试 GitHub Token → `configured: true, source: file` → 清除 → `configured: false`；
- Client 槽位实测：`sidebar.panellist` 出现 `super-butler`（order 5, active），
  `main` 出现 key `super-butler`（active）；
- 由于当前会话无浏览器控制，面板视觉渲染（明暗主题、布局）未能截图验证；
  已做 JS 语法、manifest、live slot 与 Host 路由验证。

## 6. 已知限制

- 面板是**只读仪表盘**：不再提供任务下发、取消/重试、设备改名/禁用/删除等交互，
  这些操作请点「在浏览器打开控制台」到 Web 控制台完成；
- 面板每 5 秒轮询快照，不是 WebSocket/SSE 实时流（DSH 内刷新足够，后续可加）；
- 密钥只对**插件启动的 Hub** 注入环境变量；当前 Hub 由终端启动时不会自动注入，
  需把 Hub 交给插件启动或手动设置环境变量；
- 修改 Hub 端口/项目目录后，需重启由插件托管的 Hub 才生效；
- 修改插件 Host 代码（含 Developer Mode 会话归属逻辑）后需重启 DSH 才生效；
  已有的「未分组」开发会话无法迁移到工作区，只能删除后让新指令重建；
- 面板视觉未做真机/浏览器截图验收，建议刷新页面点一次侧边栏图标确认。
