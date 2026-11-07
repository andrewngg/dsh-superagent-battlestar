# @local/dsh-super-butler

DSH bundle for the BattleStar project. It registers a **BattleStar** sidebar panel and main page inside
the Harness Web UI, manages the local butler Hub process, and stores private account credentials through
the Harness credential service.

- Host: starts/detects `hub/server.js`, proxies snapshot/task APIs under `/super-butler/api/*`,
  reads/updates settings, resolves credentials by reference.
- Client: sidebar icon + full page with live device/task status, command composer and a settings form.
- Install: `plugin_manager` → `install_bundle` with this directory as target.

## Task console

Each task row is clickable: it expands a detail panel that shows the full **task ID** (copyable, together
with the instruction), status/device/attempts/timestamps, the route reason and the recent event timeline.
From that panel the status can be changed manually:

- **标记完成 / 标记失败** push the task to a terminal status through the Hub `external-result` admin API
  (an optional note becomes the task output/error and is written to the event timeline);
- **重新排队** re-queues failed/timeout/cancelled tasks; **取消** cancels active tasks.

**继续** always opens an in-panel dialog (Electron does not implement `window.prompt`), so follow-up tasks,
Mika answers, cancel/delete confirmations and manual status notes all work in the DSH desktop shell.

Host route added for this feature: `POST /super-butler/api/tasks/:id/status` with
`{ status: "completed" | "failed" | "cancelled" | "queued", note?: string }`.
Client-only changes apply after refreshing the DSH page; the new Host route needs a DSH restart.

## Tests

```bash
npm test   # node --test --test-isolation=none test/*.test.mjs
```

The tests load `client.js` in a VM with a stubbed React (render smoke tests for `TaskRow`, `TaskDetail`,
`Dialog`, `ConsoleTab`) and exercise the Host `/status` route against a stubbed Hub.
