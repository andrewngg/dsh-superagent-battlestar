# DSH 插件：BattleStar

把「BattleStar」做成 DeepSeek Harness 的持久化插件：在 Web UI 侧边栏打开管家控制台，
并在插件设置里统一管理 Hub、私人账号与模型密钥。

- 插件包：`super-butler/dsh-plugin/`（`@local/dsh-super-butler@0.1.0`）
- 安装 profile 示例：`desktop`（`~/.dsh/profiles/<profile>/package.json` 的 bundle 列表）
- 入口：侧边栏「BattleStar」图标（order 5）
- 面板：`main` 槽位的 `super-butler` 页，含「控制台 / 设置」两个标签

## 1. 安装

在目标 profile 中安装后刷新 DSH 页面即可看到侧边栏入口。安装命令：

```text
plugin_manager(action: "install_bundle", target: "<abs>/super-butler/dsh-plugin")
```

安装后刷新 DSH Web 页面即可看到侧边栏图标。插件目录通过 `link:` 链接安装，
修改 `client.js` / `index.js` 后重新加载页面即可；Host 代码变更需要重启 Harness。

## 2. 面板功能

### 控制台

- Hub 状态：运行中/未运行、端口、是否由插件托管、设备加入码；
- **母机昵称**：标题旁「编辑」可修改并保存（插件设置）；
- 启动 / 停止 Hub（仅停止插件自己启动的 Hub；外部终端启动的 Hub 需在终端停止）；
- 设备卡：在线状态、**连接方式**（设备申报的 `endpoint`，或 `outbound → Hub`）、平台/kind、负载、
  最后心跳、models / skills chips；**点「编辑」可直接修改工作机昵称**；
- 任务列表：状态、执行设备、耗时、输出、取消/重试；
- 指令区：输入指令，可选 `profile`（hermes / opencode / cli-shell / 设备自定义 profile）、
  模型、目标设备、技能列表，发送后显示路由结果；
- 每 5 秒自动刷新（插件内不依赖 iframe，使用 Harness 主题 token 原生渲染）。

### 设置

- **Hub**：项目目录、端口、是否随 DSH 启动自动启动、默认模型、GitHub 用户名；
- **私人账号与密钥**：GitHub Token、DeepSeek API Key、Agnes AI API Key、
  豆包/火山方舟 API Key、OpenCode API Key；
- 每个已配置密钥旁有 **「测试 Token」**：调用各自的只读接口（GitHub `/user`、
  模型服务 `/models`）检查 Token 是否可用，显示 HTTP 状态、耗时与结果
  （`可用` / `无效` / `无法判定`，无法判定表示服务不支持该只读接口）；
- 密钥保存在 Harness **credentials 服务**（profile 的加密/私有存储，`source: file`），
  不写入项目文件、不在页面回显；留空表示不修改，点「清除」删除已保存条目；
- 插件启动 Hub 时会把已配置密钥解析为子进程环境变量：
  `GITHUB_TOKEN`、`DEEPSEEK_API_KEY`、`AGNES_API_KEY`、`ARK_API_KEY`、`OPENCODE_API_KEY`，
  供管家后续统筹各设备时使用。

## 3. Host 实现

`dsh-plugin/index.js`：

- `inject: ['webServer']`，通过 `plugin_manager` 安装为 Host 插件；
- 通过 `ctx.webServer.register({ kind: 'prefix', path: '/super-butler', handler })` 暴露：
  - `GET  /super-butler/api/status` — Hub 状态、设置、密钥配置状态；
  - `GET  /super-butler/api/settings` — 非敏感设置 + 密钥状态；
  - `POST /super-butler/api/settings` — 保存设置 / 设置或清除密钥；
  - `GET  /super-butler/api/snapshot` — 代理 Hub 设备/任务快照；
  - `POST /super-butler/api/tasks` — 代理建任务；
  - `POST /super-butler/api/tasks/:id/cancel|retry` — 代理取消/重试；
  - `POST /super-butler/api/hub/start|stop` — 启动/停止 Hub；
- 自动检测 7317 上是否已有 Hub；没有且 `autoStart` 为真时，用 `node hub/server.js` 启动，
  日志写入 `hub/data/plugin-hub.log`；
- 从 `hub/data/state.json` 读取管理员令牌与加入码，代理请求时自动附加，
  面板页面不接触管理员令牌；
- 插件卸载/禁用时终止由自己启动的 Hub 子进程（不动外部进程）。

## 4. Client 实现

`dsh-plugin/client.js`（浏览器模块，`window.__ModuleLoader__.load`）：

- `ctx.locale.register('superButler', { zh, en })`，注册中英文案；
- `ctx.slots.inject('sidebar.panellist', ...)` 注册侧边栏图标；
- `ctx.slots.inject('main', ...)` 注册 key 为 `super-butler` 的主面板；
- React 组件使用 `--dsw-alias-*` 主题 token，不引入 Harness Client 包，不操作 DOM/iframe；
- 所有数据通过同源 `/super-butler/api/*` 获取。

## 5. 验证记录（本机）

- `plugin_manager install_bundle` → `application: applied`；profile `package.json` 出现
  `"@local/dsh-super-butler": "link:..."`，bundle 列表包含该包；
- Host 路由实测 200：`/super-butler/api/status`、`/settings`、`/snapshot`（1 台设备、3 个任务）；
- 凭证持久化实测：设置测试 GitHub Token → `configured: true, source: file` → 清除 → `configured: false`；
- Client 槽位实测：`sidebar.panellist` 出现 `super-butler`（order 5, active），
  `main` 出现 key `super-butler`（active）；
- 由于当前会话无浏览器控制，面板视觉渲染（明暗主题、布局）未能截图验证；
  已做 JS 语法、manifest、live slot 与 Host 路由验证。

## 6. 已知限制

- 面板每 5 秒轮询快照，不是 WebSocket/SSE 实时流（DSH 内刷新足够，后续可加）；
- 密钥只对**插件启动的 Hub** 注入环境变量；当前 Hub 由终端启动时不会自动注入，
  需把 Hub 交给插件启动或手动设置环境变量；
- 修改 Hub 端口/项目目录后，需重启由插件托管的 Hub 才生效；
- 面板视觉未做真机/浏览器截图验收，建议刷新页面点一次侧边栏图标确认。
