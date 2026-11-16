# 任务回收站（Task Trash）设计

> 目标：失败/终态任务可以「回收」进垃圾桶；垃圾桶里可以「恢复」或「彻底删除」。
> 状态：实现中（本文件是后端/前端/测试的共同契约）。

## 1. 数据模型

- 任务新增字段 `trashedAt`（ISO 字符串或 null），持久化到 `state.json`，并通过 `taskToJson` 输出；
  计算字段 `trashed = Boolean(trashedAt)`，前端只读。
- 只有**终态任务**可以回收：`completed / failed / timeout / cancelled`；进行中（queued/assigned/running/waiting）调用返回 400「只能回收已结束的任务」。
- 回收**不删除**任何任务数据、事件或执行记录文件，只是从常规列表、统计、大脑快照中隐藏。
- 回收按线程生效：同一 `threadId` 的任务与该任务的计划子任务（`parentTaskId === task.id`）一起回收（与归档的线程语义一致）。
- 已归档任务可以回收；回收时同时清掉 `archived`（避免「归档 + 回收站」状态叠加）。恢复时保持未归档（用户可再手动归档）。
- **彻底删除**只允许回收站中的任务：删除任务本身、同线程任务与计划子任务；清理长期目标里的引用
  （`goal.taskIds` / `goal.runningTaskId` / `goal.lastTaskId`）；尽力删除对应 `task-records/**.md`；广播 `task.deleted`。

## 2. Hub 方法（hub/lib/hub.js）

```js
hub.trashTask(task)      // -> task（回收；非终态抛 badRequest/conflict）
hub.restoreTask(task)    // -> task（从回收站恢复；不在回收站抛 400）
hub.purgeTask(task)      // -> {taskId, deleted:[...]}（彻底删除；不在回收站抛 400）
hub.listTasks({ status, deviceId, includeArchived, includeTrashed, limit })
```

- `listTasks` 默认同时排除归档与回收站任务；`includeTrashed: true` 时包含回收站任务。
- `snapshot()` 返回的 tasks 中**包含**回收站任务（前端垃圾桶视图需要），但：
  - `stats()`、`_brainWorkload()`、`_brainHasNewSignalsSince()`、`_finishTask` 等统计/大脑逻辑都排除回收站任务；
  - 回收站任务不参与路由、不参与目标进度统计。
- 事件（task.events）与广播：
  - 回收：`task.updated`，事件文案「任务移入回收站」；
  - 恢复：`task.updated`，事件文案「任务已恢复」；
  - 彻底删除：`task.deleted`，事件「任务已彻底删除」（删除前写入，随任务消失）。

## 3. HTTP 路由（hub/lib/http.js）

| 方法 | 路径 | 说明 | 成功响应 |
| --- | --- | --- | --- |
| POST | `/api/tasks/:id/trash` | 回收（终态任务） | `{ok:true, task}` |
| POST | `/api/tasks/:id/restore` | 从回收站恢复 | `{ok:true, task}` |
| POST | `/api/tasks/:id/purge` | 彻底删除（仅回收站） | `{ok:true, deleted:[ids]}` |
| GET | `/api/tasks?includeTrashed=1` | 列表包含回收站任务 | `{tasks:[...]}` |

- 全部需要管理员令牌（`x-butler-token` 请求头，`?token=` 不适用于 admin 路由）。
- 错误：非终态回收 → 400 `只能回收已结束的任务`；非回收站恢复/彻底删除 → 400；
  任务不存在 → 404 `任务不存在`。

## 4. Web UI（hub/web）

- 任务筛选行新增 chip：`data-filter="trash"`，文案「垃圾桶」，计数 = 回收站根任务数。
- 失败筛选视图的提示条（现有「N 个任务失败」区域）新增按钮「回收全部失败任务」：
  对当前筛出的失败/超时/取消根任务逐个调用回收（二次确认），完成后刷新。
- 任务卡操作区：终态任务（未在回收站）新增「回收」；
  回收站视图中的任务卡显示「恢复」「彻底删除」，「彻底删除」用 `confirmDialog`（danger）二次确认。
- 任务详情抽屉底部：终态任务显示「回收」；回收站任务显示「恢复」「彻底删除」。
- 回收站任务不得出现在「进行中 / 已完成 / 失败 / 全部 / 已归档」筛选中；统计卡与筛选计数排除回收站任务。
- i18n（i18n.js 同时补 zh/en）：
  `trash.title` 垃圾桶、`trash.empty` 回收站是空的、`trash.count` 共 N 个、
  `trash.confirmTitle` 彻底删除任务？、`trash.confirmPurge` 将永久删除该任务（含同线程与子任务），无法恢复。、
  `trash.confirmPurgeAll` 将回收全部失败任务，可在垃圾桶恢复。、
  `trash.trashed` 已移入回收站、`trash.restored` 已恢复、`trash.purged` 已彻底删除、
  `action.trash` 回收、`action.restore` 恢复、`action.purge` 彻底删除。
- 缓存版本号统一升到 `v=20261116h`（style.css / i18n.js / app.js）。

## 5. 测试与文档

- `hub/test/trash.test.js`：非终态回收失败、终态回收后列表/统计隐藏、恢复、`trash` 线程与子任务联动、
  `purge` 清理 goal 引用与记录文件、HTTP 三个路由 + 404/400、持久化后重启仍生效、快照包含回收站任务。
- `docs/ARCHITECTURE.md`：任务生命周期小节补「回收站」；`docs/PROTOCOL.md`：任务 API 表补三个路由；
  `README.md`：任务章节补一段用法。

## 6. 文件归属

- Lead：`hub/lib/hub.js`、`hub/lib/http.js`、`docs/TASK-TRASH-DESIGN.md`
- web-ui：`hub/web/index.html`、`hub/web/assets/app.js`、`hub/web/assets/i18n.js`、`hub/web/assets/style.css`
- verifier：`hub/test/trash.test.js`、`docs/ARCHITECTURE.md`、`docs/PROTOCOL.md`、`README.md`
