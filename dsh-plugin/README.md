# @local/dsh-super-butler

DSH bundle for the BattleStar project. It registers a **BattleStar** sidebar panel and main page inside
the Harness Web UI, manages the local butler Hub process, and stores private account credentials through
the Harness credential service.

- Host: starts/detects `hub/server.js`, proxies snapshot/task APIs under `/super-butler/api/*`,
  reads/updates settings, resolves credentials by reference.
- Client: sidebar icon + full page with live device/task status, command composer and a settings form.
- Install: `plugin_manager` → `install_bundle` with this directory as target.

## Task console

Click a task title, its ▸ arrow, or the **详情** button to expand the detail panel. The collapsed row and the
detail panel both show the full **task ID** with a copy button; the detail panel adds
status/device/attempts/timestamps, the route reason and the recent event timeline.

Manual status changes from the detail panel:

- **标记完成 / 标记失败** force a terminal status through the Hub `external-result` admin API. An active task
  (queued/assigned/running/waiting) is cancelled on the device **first**, so the pending command is removed and
  no duplicate work keeps running. An optional note becomes the new output/error; with a blank note the previous
  output is preserved, and the note is recorded as the task output/error (the Hub event message is fixed:
  `已同步 Mika 最终结果`).
- **重新排队** re-queues failed/timeout/cancelled tasks; **取消** cancels active tasks.
- Agnes plan parents (`isPlan`) derive their status from subtasks, so they only expose **取消**.

**继续** always opens an in-panel dialog (Electron does not implement `window.prompt`), so follow-up tasks,
Mika answers, cancel/delete confirmations and manual status notes all work in the DSH desktop shell.
Required inputs show an inline error instead of silently doing nothing.

Host route for this feature: `POST /super-butler/api/tasks/:id/status` with
`{ status: "completed" | "failed" | "cancelled" | "queued", note?: string }`. The Host root
(`GET /super-butler/`) advertises `features: ["task-status-manual", "task-status-cancel-first"]`; the client
reads that flag and keeps 标记完成 / 标记失败 disabled (with a restart hint) on a Host that still runs the old
logic. Client changes apply after refreshing the DSH page; reload the plugin or restart DSH to pick up Host changes.

## Tests

```bash
npm test   # node --test --test-isolation=none "test/*.test.mjs"
```

Node ≥ 22.8 is required for the `--test-isolation=none` flag (the sandbox cannot spawn child test processes).
The tests load `client.js` in a VM with a stubbed React (render smoke tests for `TaskRow`, `TaskDetail`,
`Dialog`, `ConsoleTab`) and exercise the Host `/status` route against a stubbed Hub, including the
cancel-before-finish flow for active tasks and the plan-parent rejection.
