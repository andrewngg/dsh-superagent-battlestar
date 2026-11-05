# 截图（可选）

本目录用于存放控制台 UI 截图（`desktop.png`、`mobile.png`、`mobile-tasks.png`、`apk-setup.png`）。

当前执行环境（DSH 沙箱）禁止 Chromium 创建 Mojo 命名管道，`chrome --headless` 无法启动，
因此仓库内暂未包含截图。功能已通过真实 Hub 的 DOM 级验证（见 `hub/web/README.md`）。

## 生成方式

在允许运行 Chrome 的普通终端执行：

```powershell
# 终端 1：启动 mock 数据源（不占用 7317）
node hub/web/dev-server.js

# 终端 2：桌面
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --disable-gpu --hide-scrollbars `
  --window-size=1440,900 --virtual-time-budget=6000 `
  --screenshot="screenshots/desktop.png" "http://127.0.0.1:7399/?token=demo"

# 手机
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --disable-gpu --hide-scrollbars `
  --window-size=390,844 --virtual-time-budget=6000 `
  --screenshot="screenshots/mobile.png" "http://127.0.0.1:7399/?token=demo#status"

# 手机 · 任务页
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --disable-gpu --hide-scrollbars `
  --window-size=390,844 --virtual-time-budget=6000 `
  --screenshot="screenshots/mobile-tasks.png" "http://127.0.0.1:7399/?token=demo#tasks"
```

真实 Hub 截图把地址换成 `http://<hub>:7317/?token=<adminToken>`，并先 `node scripts/demo.js` 让设备在线。

APK 配置页截图（可选）：

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --disable-gpu --hide-scrollbars `
  --window-size=420,900 --virtual-time-budget=4000 `
  --screenshot="screenshots/apk-setup.png" "file:///C:/path/to/super-butler/android/assets/setup.html"
```

> 截图只用于展示，不参与构建；不要提交包含真实令牌或内网地址的截图。
