# @local/dsh-super-butler

DSH bundle for the Super Butler project. It registers a **超级管家** sidebar panel and main page inside
the Harness Web UI, manages the local butler Hub process, and stores private account credentials through
the Harness credential service.

- Host: starts/detects `hub/server.js`, proxies snapshot/task APIs under `/super-butler/api/*`,
  reads/updates settings, resolves credentials by reference.
- Client: sidebar icon + full page with live device/task status, command composer and a settings form.
- Install: `plugin_manager` → `install_bundle` with this directory as target.
