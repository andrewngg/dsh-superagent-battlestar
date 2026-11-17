/* BattleStar · DSH Web Client
 * 侧边栏「BattleStar」入口 + 主面板：设备/任务控制台与私人密钥设置。
 * 纯 JS（无 TS 构建），React 由 Harness 模块表提供。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-super-butler',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo } = React

    const NS = 'superButler'
    const PANEL_ID = 'super-butler'
    const ROOT = '/super-butler'
    const API = `${ROOT}/api`

    const zh = {
      panel: 'BattleStar', title: 'BattleStar', subtitle: '多设备 AI 管家 · 控制台与密钥',
      edit: '编辑', rename: '重命名', saveName: '保存', cancelEdit: '取消',
      hubNickname: '母机昵称', connection: '连接', outbound: '主动连接', endpoint: '端点',
      deviceRenamed: '设备昵称已更新', deviceNicknameCleared: '设备昵称已清除', hubNicknameSaved: '母机昵称已更新', nameRequired: '名称不能为空',
      machineName: '机器名', nicknamePlaceholder: '例如：书房工作站（写代码）', nicknameClearHint: '留空保存即清除昵称，回退显示机器名',
      removeDevice: '移除', removeDeviceConfirm: '确定从 Hub 移除此设备吗？在线设备下次心跳可能重新注册。', deviceRemoved: '设备已移除',
      disableDevice: '禁用', enableDevice: '启用', disabled: '已禁用', deviceDisabled: '设备已禁用，不再接收任务', deviceEnabled: '设备已启用',
      dashboard: '仪表盘', console: '控制台', settings: '设置', refresh: '刷新', start: '启动 Hub', stop: '停止 Hub',
      restartHub: '重启 Hub', hubRestarting: 'Hub 正在重启，约 15 秒后自动刷新…', restartHubFailed: '重启 Hub 失败',
      restartNeedsRestart: '插件 Host 还没加载「重启 Hub」路由：请完全退出并重新打开 DeepSeek Harness 后重试。',
      restartHubHint: '让 Hub 重新加载代码（约 15 秒，会先通知在线设备）',
      restartExternalHint: '这个 Hub 是外部进程：在这里让它原地重启即可加载新代码',
      stopExternalHint: 'Hub 由外部终端启动，插件不能停止它；请用「重启 Hub」或到对应终端停止',
      openConsole: '在浏览器打开控制台', openConsoleHint: '任务下发、设备管理与任务详情请在浏览器控制台里操作',
      recentTasks: '最近任务',
      guide: '教程',
      guideIntro: '母机 Hub 负责调度，工作机负责执行。PC 和手机都能接入成工作机；手机还可以当控制端查看进度、发指令。',
      guideHint: '命令里的 Hub 地址与加入码已按当前 Hub 自动填好，可直接复制；配置文件名可按需修改。',
      addPc: '添加 PC 工作机',
      pcStep1: '先在工作机安装 Node.js 18 或更高版本，确认 node -v 能输出版本号。',
      pcStep2: '把本仓库克隆到工作机（或直接复制整个目录）。',
      pcStep3: '复制一份执行器配置，按本机情况修改 name 与 executor 里的路径（Windows 用 copy，macOS/Linux 用 cp）。',
      pcStep4: '在工作机上启动设备代理；--name 改成这台机器的用途，--config 换成上一步的配置。',
      pcStep5: '回到仪表盘，设备卡片出现这台机器并显示绿点即接入成功；用途昵称可在浏览器控制台的设备详情里改。',
      pcStep6: '可选：把启动命令保存成 .cmd/.sh 放进开机启动项或计划任务；--state-dir 会记住设备令牌，重启不会重复占用名额。',
      addPhoneWorker: '添加手机工作机（Mika）',
      phoneStep1: '手机安装 Mika（Android 11+），在 Settings › Model 配置模型，并按提示完成无障碍 / 无线调试。',
      phoneStep2: '在 Mika 的 Settings › Connect a computer 选择连接方式：USB（开启 USB 调试）或 Wi-Fi（记下地址与 token 文件）。',
      phoneStep3: '在桥电脑安装 Mika CLI 与 platform-tools，用 mika doctor 确认能连上手机。',
      phoneStep4: '复制手机执行器配置，按实际填写 device（USB SERIAL）或 url + tokenFile（Wi-Fi）。',
      phoneStep5: '在桥电脑启动代理（手机本身不用装 Node，由桥电脑代注册）；上线后能力里应出现 phone-control / app-automation / apk-search 等 skills。',
      phoneStep6: '手机同一时间只做一件事；支付、验证码与手机接管需要你在手机上处理。',
      phoneControl: '手机当控制端（查看进度 / 发指令）',
      ctrlStep1: '手机浏览器打开手机控制台，可添加到主屏幕。',
      ctrlStep2: '或安装 APK（Android 8+），首次打开会自动扫描同一 Wi-Fi 下的 Hub，只需填管理员令牌。',
      ctrlStep3: '控制端只负责查看设备、发指令、看进度，本身不执行 AI 任务。',
      guideTrouble: '接不上？先查这三项',
      troubleOffline: '设备一直离线：确认工作机能访问 Hub 地址、7317/TCP 没被防火墙拦住、PC 与手机在同一 Wi-Fi。',
      troubleJoinCode: '提示加入码无效：重载 Hub 后加入码会刷新，从「设置」页或 Hub 启动日志复制新的加入码。',
      troubleRouting: '任务没有派到设备：到浏览器控制台的设备详情看 skills / models / 并发负载，或在任务里指定目标设备。',
      guideDocs: '更多细节：docs/WORKER-SETUP.md（让工作机上的 AI 自动配置）、docs/MIKA-PHONE.md（手机工作机）、docs/APK.md（APK 构建与安装）。',
      running: '运行中', stopped: '未运行', owned: '插件托管', external: '外部进程',
      devices: '设备', tasks: '任务', online: '在线', offline: '离线',
      runningTasks: '运行中', completed: '已完成', failed: '失败/超时', queued: '排队',
      noDevices: '暂无设备。启动第一台工作机后，这里会显示它的能力与状态。',
      noTasks: '暂无任务。发送一条指令试试。',
      command: '发送指令', instructionPlaceholder: '告诉管家要做什么，例如：运行 node -v，并只回答版本号',
      profile: '路由 profile', profileAuto: '自动', model: '模型（可选）', skills: '技能（逗号分隔，可选）',
      device: '目标设备（可选）', priority: '优先级', timeout: '超时（秒）', send: '发送',
      sending: '发送中…', sent: '已创建任务', route: '路由结果', assigned: '已派发',
      cancel: '取消', retry: '重试', output: '输出', error: '错误', events: '事件',
      archive: '归档', unarchive: '取消归档', delete: '删除', deleteConfirm: '确定删除这个任务吗？删除后不可恢复。',
      archived: '已归档', subtasks: 'Agnes 子任务', plan: 'Agnes 长任务拆分',
      followUp: '继续', followUpPrompt: '输入下一步或修正要求（会带上一步上下文）：', followUpCreated: '已创建下一步任务', thread: '任务线程', steps: '步',
      answer: '回答 Mika', answerPrompt: 'Mika 需要你的回答：', answerSent: '回答已发送，Mika 继续执行', waitingAnswer: '等待回答',
      hubSettings: 'Hub 设置', projectRoot: '项目目录', hubPort: 'Hub 端口', autoStart: 'DSH 启动时自动启动 Hub',
      devWorkspacePath: '开发指令工作区',
      devWorkspaceHint: '留空自动选择包含项目目录的 DSH 工作区；APK 开发指令创建的会话会归到这里',
      defaultModel: '默认模型', githubUser: 'GitHub 用户名', keys: '私人账号与密钥',
      keysHint: '密钥保存在 Harness credentials 服务，不写入项目文件；留空表示不修改。',
      githubToken: 'GitHub Token', deepseekApiKey: 'DeepSeek API Key', agnesApiKey: 'Agnes AI API Key',
      doubaoApiKey: '豆包 / 火山方舟 API Key', opencodeApiKey: 'OpenCode API Key',
      configured: '已配置', notConfigured: '未配置', clear: '清除', save: '保存设置', saving: '保存中…',
      testToken: '测试 Token', testing: '测试中…', testOk: '可用', testInvalid: '无效', testUnverified: '无法判定',
      saved: '设置已保存', joinCode: '设备加入码', copy: '复制', copied: '已复制',
      openExternal: '在浏览器打开', loadFailed: '加载失败', retryLoad: '重试', apiUnavailable: '无法连接管家 Hub',
      startHubFailed: '启动 Hub 失败', stopHubFailed: '停止 Hub 失败', settingsFailed: '保存设置失败',
      taskFailed: '任务操作失败', cancelConfirm: '确定取消这个任务吗？',
      load: '负载', models: '模型', profiles: 'Profiles', gateways: 'Gateways', skillsChips: 'Skills',
      lastSeen: '最后心跳', justNow: '刚刚', minutesAgo: '分钟前', hoursAgo: '小时前',
      hubLog: 'Hub 日志', adminTokenHidden: '管理令牌由插件代理，不在页面暴露',
      devTools: '开发工具', gitPush: 'Git Push',
      gitPushHint: '点击后会在母机仓库执行 git push，只推送已经提交的提交，不会暂存或修改任何文件。',
      gitPushing: '正在推送…', gitPushOk: '推送完成', gitPushFailed: '推送失败',
      gitPushNeedsRestart: '插件 Host 还没加载 Git Push 路由：请重启一次 DeepSeek Harness 后重试。',
      gitRepo: '仓库', gitBranch: '分支', gitRemote: '远端', gitUpstream: '上游',
      gitNoUpstream: '未设置（首次推送会自动设置）', gitRepoUnknown: '正在读取仓库信息…',
      credentialsFallback: 'Harness credentials 服务当前不可用，密钥会改为保存在插件本地文件（仅本机可读），保存和测试仍然可用；重启 DeepSeek Harness 后如果服务恢复，插件会优先使用 Harness 凭据。',
      credentialsLocalBadge: '本机文件',
      emptySecrets: '尚未配置任何私人密钥',
      taskId: '任务 ID', copyId: '复制 ID', copiedId: '任务 ID 已复制', copyInstruction: '复制指令',
      copiedInstruction: '指令已复制', copyFailed: '复制失败，请手动选择文本',
      detail: '详情', showDetail: '展开任务详情', hideDetail: '收起任务详情',
      statusLabel: '状态', deviceLabel: '执行设备', priorityLabel: '优先级', timeoutLabel: '超时',
      attemptsLabel: '尝试次数', createdLabel: '创建时间', startedLabel: '开始时间',
      finishedLabel: '结束时间', threadStepLabel: '线程步骤', routeReason: '路由结果', noRoute: '暂无路由信息',
      manualStatus: '手动改状态', markCompleted: '标记完成', markFailed: '标记失败', requeue: '重新排队',
      statusNotePlaceholder: '备注（可选）：备注会作为新的输出/错误，留空保留原输出',
      applyStatus: '应用', statusUpdated: '任务状态已更新',
      statusChangeHint: '进行中的任务会先取消设备执行，再改成手动状态；设备之后上报的结果会被忽略。',
      overwriteHint: '该任务已有结果，改状态会覆盖现有输出/错误（备注为空时保留原输出）。',
      planStatusHint: 'Agnes 长任务拆分的状态由子任务汇总，只能取消，不能手动改状态。',
      inputRequired: '请先填写内容',
      statusRouteNeedsRestart: 'Host 插件还未提供手动改状态接口，请重启 DSH 后重试',
      followUpHint: '继续会创建一个新任务，并自动带上当前任务的结果作为上下文。',
      activeFollowUpHint: '任务还在进行中，结束后才能继续；也可以先取消任务再继续。',
      cancelTaskTitle: '取消任务', dialogOk: '确定', dialogCancel: '取消', close: '关闭',
      mind: '心智', mindTitle: '心智（Soul / Skill）',
      mindHint: '灵魂与工作流程会随每轮思考的快照一起交给模型，影响它的表达方式与做事习惯。这部分配置已从 Web 控制台迁移到本插件面板。',
      soulField: '灵魂 Soul', skillField: '工作流程 Skill',
      soulHint: '模型的长期身份、语气与表达风格；留空会提示补全。',
      skillHint: '模型做事的工作流程、检查清单与交付标准。',
      mindDefaultBadge: '使用默认内容', mindCustomBadge: '自定义内容',
      mindSave: '保存心智', mindSaving: '保存中…', mindSaved: '心智已保存', mindSaveFailed: '保存心智失败',
      mindReset: '恢复默认', mindResetAll: '全部恢复默认', mindResetDone: '已恢复默认内容',
      mindUpdatedAt: '最后更新', mindNeverUpdated: '尚未修改（使用默认内容）',
      mindLoadFailed: '加载心智失败',
      mindLoadNeedsRestart: '插件 Host 尚未加载心智接口（Host 代码不热更新，需完全重启 DSH 才会注册 /api/mind）。心智数据保存在 Hub，没有丢失；请完全退出并重新打开 DeepSeek Harness 后重试。',
    }
    const en = {
      panel: 'BattleStar', title: 'BattleStar', subtitle: 'Multi-device AI butler · console and keys',
      edit: 'Edit', rename: 'Rename', saveName: 'Save', cancelEdit: 'Cancel',
      hubNickname: 'Hub nickname', connection: 'Connection', outbound: 'outbound', endpoint: 'endpoint',
      deviceRenamed: 'Device nickname saved', deviceNicknameCleared: 'Device nickname cleared', hubNicknameSaved: 'Hub nickname saved', nameRequired: 'Name is required',
      machineName: 'Machine name', nicknamePlaceholder: 'e.g. Study workstation (coding)', nicknameClearHint: 'Save an empty value to clear it and fall back to the machine name',
      removeDevice: 'Remove', removeDeviceConfirm: 'Remove this device from the hub? An online device may re-register on its next heartbeat.', deviceRemoved: 'Device removed',
      disableDevice: 'Disable', enableDevice: 'Enable', disabled: 'Disabled', deviceDisabled: 'Device disabled; it will no longer receive tasks', deviceEnabled: 'Device enabled',
      dashboard: 'Dashboard', console: 'Console', settings: 'Settings', refresh: 'Refresh', start: 'Start hub', stop: 'Stop hub',
      restartHub: 'Restart hub', hubRestarting: 'Hub is restarting, the panel refreshes in about 15 seconds…', restartHubFailed: 'Failed to restart hub',
      restartNeedsRestart: 'The plugin Host has not loaded the Restart hub route yet. Quit and reopen DeepSeek Harness, then try again.',
      restartHubHint: 'Reload the Hub code (about 15 seconds; online devices are notified first)',
      restartExternalHint: 'This hub is an external process: restart it here to load the new code',
      stopExternalHint: 'This hub was started from a terminal, so the plugin cannot stop it; use Restart hub or stop it there',
      openConsole: 'Open console in browser', openConsoleHint: 'Send tasks, manage devices and open task details in the browser console',
      recentTasks: 'Recent tasks',
      guide: 'Guide',
      guideIntro: 'The hub schedules work and worker machines execute it. PCs and phones can both join as workers; a phone can also act as a control client to watch progress and send instructions.',
      guideHint: 'The hub address and join code are filled in from the running hub, so the commands can be copied as-is; rename the config files if you like.',
      addPc: 'Add a PC worker',
      pcStep1: 'Install Node.js 18 or newer on the worker and confirm node -v prints a version.',
      pcStep2: 'Clone this repository on the worker machine (or copy the whole folder).',
      pcStep3: 'Copy a worker executor config and adjust name and the executor paths (copy on Windows, cp on macOS/Linux).',
      pcStep4: 'Start the device agent on the worker; change --name to this machine\u2019s purpose and point --config at the config from the previous step.',
      pcStep5: 'Back on the dashboard the device card appears with a green dot once connected; set its usage nickname from the device details in the browser console.',
      pcStep6: 'Optional: save the start command as a .cmd/.sh file in startup or a scheduled task; --state-dir remembers the device token so restarts do not claim a new slot.',
      addPhoneWorker: 'Add a phone worker (Mika)',
      phoneStep1: 'Install Mika on the phone (Android 11+), configure a model in Settings \u203a Model, and finish the accessibility / wireless debugging setup it asks for.',
      phoneStep2: 'In Mika\u2019s Settings \u203a Connect a computer choose USB (enable USB debugging) or Wi-Fi (note the address and token file).',
      phoneStep3: 'Install the Mika CLI and platform-tools on the bridge PC, then confirm the connection with mika doctor.',
      phoneStep4: 'Copy the phone executor config and fill in device (USB serial) or url + tokenFile (Wi-Fi).',
      phoneStep5: 'Start the agent on the bridge PC (the phone does not need Node; the bridge registers for it); skills such as phone-control, app-automation and apk-search should appear once online.',
      phoneStep6: 'The phone handles one task at a time; payments, verification codes and phone takeover must be handled on the phone.',
      phoneControl: 'Use a phone as a control client (watch progress / send instructions)',
      ctrlStep1: 'Open the mobile console in the phone browser and add it to the home screen if you like.',
      ctrlStep2: 'Or install the APK (Android 8+); on first launch it scans the same Wi-Fi for a hub, then only asks for the admin token.',
      ctrlStep3: 'The control client only views devices, sends instructions and watches progress; it does not execute AI tasks itself.',
      guideTrouble: 'Not connecting? Check these three things',
      troubleOffline: 'Device stays offline: make sure the worker can reach the hub address, port 7317/TCP is not blocked by a firewall, and PC and phone are on the same Wi-Fi.',
      troubleJoinCode: 'Invalid join code: it changes when the hub restarts; copy the new one from the Settings tab or the hub startup log.',
      troubleRouting: 'Tasks never reach the device: check skills / models / concurrency in the browser console device details, or target the device explicitly when creating the task.',
      guideDocs: 'More: docs/WORKER-SETUP.md (let an AI on the worker configure itself), docs/MIKA-PHONE.md (phone worker), docs/APK.md (APK build and install).',
      running: 'Running', stopped: 'Stopped', owned: 'plugin-managed', external: 'external process',
      devices: 'Devices', tasks: 'Tasks', online: 'online', offline: 'offline',
      runningTasks: 'Running', completed: 'Completed', failed: 'Failed/timeout', queued: 'Queued',
      noDevices: 'No devices yet. Start the first worker machine to see its capabilities.',
      noTasks: 'No tasks yet. Send an instruction.',
      command: 'Send instruction', instructionPlaceholder: 'e.g. Run node -v and answer with the version only',
      profile: 'Routing profile', profileAuto: 'Auto', model: 'Model (optional)', skills: 'Skills (comma separated)',
      device: 'Target device (optional)', priority: 'Priority', timeout: 'Timeout (s)', send: 'Send',
      sending: 'Sending…', sent: 'Task created', route: 'Route', assigned: 'assigned',
      cancel: 'Cancel', retry: 'Retry', output: 'Output', error: 'Error', events: 'Events',
      archive: 'Archive', unarchive: 'Unarchive', delete: 'Delete', deleteConfirm: 'Delete this task permanently?',
      archived: 'Archived', subtasks: 'Agnes subtasks', plan: 'Agnes task split',
      followUp: 'Continue', followUpPrompt: 'Enter the next step or correction (previous context will be included):', followUpCreated: 'Follow-up task created', thread: 'Task thread', steps: 'steps',
      answer: 'Answer Mika', answerPrompt: 'Mika needs your answer:', answerSent: 'Answer sent; Mika continues', waitingAnswer: 'Waiting for answer',
      hubSettings: 'Hub settings', projectRoot: 'Project root', hubPort: 'Hub port', autoStart: 'Start hub with DSH',
      devWorkspacePath: 'Developer-mode workspace',
      devWorkspaceHint: 'Leave blank to auto-pick the DSH workspace containing the project root; APK developer instructions will be grouped there',
      defaultModel: 'Default model', githubUser: 'GitHub username', keys: 'Private accounts and keys',
      keysHint: 'Keys are stored in the Harness credential service, not project files. Leave blank to keep.',
      githubToken: 'GitHub token', deepseekApiKey: 'DeepSeek API key', agnesApiKey: 'Agnes AI API key',
      doubaoApiKey: 'Doubao / Ark API key', opencodeApiKey: 'OpenCode API key',
      configured: 'configured', notConfigured: 'not configured', clear: 'Clear', save: 'Save settings', saving: 'Saving…',
      testToken: 'Test token', testing: 'Testing…', testOk: 'valid', testInvalid: 'invalid', testUnverified: 'unverified',
      saved: 'Settings saved', joinCode: 'Device join code', copy: 'Copy', copied: 'Copied',
      openExternal: 'Open in browser', loadFailed: 'Load failed', retryLoad: 'Retry', apiUnavailable: 'Cannot reach the butler hub',
      startHubFailed: 'Failed to start hub', stopHubFailed: 'Failed to stop hub', settingsFailed: 'Failed to save settings',
      taskFailed: 'Task action failed', cancelConfirm: 'Cancel this task?',
      load: 'Load', models: 'Models', profiles: 'Profiles', gateways: 'Gateways', skillsChips: 'Skills',
      lastSeen: 'Last seen', justNow: 'just now', minutesAgo: 'm ago', hoursAgo: 'h ago',
      hubLog: 'Hub log', adminTokenHidden: 'Admin token stays in the plugin proxy',
      devTools: 'Dev tools', gitPush: 'Git Push',
      gitPushHint: 'Runs git push in the hub repository; it only pushes existing commits and never stages or edits files.',
      gitPushing: 'Pushing…', gitPushOk: 'Push complete', gitPushFailed: 'Push failed',
      gitPushNeedsRestart: 'The plugin Host has not loaded the Git Push route yet. Restart DeepSeek Harness once and try again.',
      gitRepo: 'Repository', gitBranch: 'Branch', gitRemote: 'Remote', gitUpstream: 'Upstream',
      gitNoUpstream: 'not set (the first push sets it)', gitRepoUnknown: 'Reading repository info…',
      credentialsFallback: 'The Harness credentials service is unavailable right now, so keys are stored in the plugin local file instead (readable only on this machine); saving and testing still work. After restarting DeepSeek Harness, the plugin will use the Harness credential service again once it recovers.',
      credentialsLocalBadge: 'local file',
      emptySecrets: 'No private keys configured yet',
      taskId: 'Task ID', copyId: 'Copy ID', copiedId: 'Task ID copied', copyInstruction: 'Copy instruction',
      copiedInstruction: 'Instruction copied', copyFailed: 'Copy failed; select the text manually',
      detail: 'Details', showDetail: 'Show task details', hideDetail: 'Hide task details',
      statusLabel: 'Status', deviceLabel: 'Device', priorityLabel: 'Priority', timeoutLabel: 'Timeout',
      attemptsLabel: 'Attempts', createdLabel: 'Created', startedLabel: 'Started',
      finishedLabel: 'Finished', threadStepLabel: 'Thread step', routeReason: 'Route', noRoute: 'No route info',
      manualStatus: 'Change status manually', markCompleted: 'Mark completed', markFailed: 'Mark failed', requeue: 'Re-queue',
      statusNotePlaceholder: 'Optional note: it becomes the new output/error; leave blank to keep the old output',
      applyStatus: 'Apply', statusUpdated: 'Task status updated',
      statusChangeHint: 'Active tasks are cancelled on the device first, then switched to the manual status; later device reports are ignored.',
      overwriteHint: 'This task already has a result; changing its status overwrites the output/error (leave the note blank to keep the old output).',
      planStatusHint: 'An Agnes plan status is derived from its subtasks; it can only be cancelled, not changed manually.',
      inputRequired: 'Please enter a value first',
      statusRouteNeedsRestart: 'The host plugin has no manual status route yet; restart DSH and retry',
      followUpHint: 'Continue creates a new task with the current result as context.',
      activeFollowUpHint: 'The task is still active; it can continue after it ends. You can cancel it first.',
      cancelTaskTitle: 'Cancel task', dialogOk: 'OK', dialogCancel: 'Cancel', close: 'Close',
      mind: 'Mind', mindTitle: 'Mind (Soul / Skill)',
      mindHint: 'Soul and workflow are handed to the model with each thinking snapshot, shaping its tone and habits. This configuration has moved from the Web console to this plugin panel.',
      soulField: 'Soul', skillField: 'Workflow (Skill)',
      soulHint: 'Long-term identity, tone and expression style of the model. Empty values are rejected.',
      skillHint: 'Workflow, checklists and delivery standards the model should follow.',
      mindDefaultBadge: 'Using default', mindCustomBadge: 'Customized',
      mindSave: 'Save mind', mindSaving: 'Saving…', mindSaved: 'Mind saved', mindSaveFailed: 'Failed to save mind',
      mindReset: 'Reset to default', mindResetAll: 'Reset all to default', mindResetDone: 'Default content restored',
      mindUpdatedAt: 'Last updated', mindNeverUpdated: 'Not modified yet (using defaults)',
      mindLoadFailed: 'Failed to load mind',
      mindLoadNeedsRestart: 'The plugin host has not loaded the mind route yet (host code does not hot-reload; DSH must be fully restarted to register /api/mind). The mind data lives in the Hub and is not lost — quit DeepSeek Harness completely, reopen it, then retry.',
    }

    const COLORS = {
      bg: 'var(--dsw-alias-bg-base)',
      layer: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      text: 'var(--dsw-alias-label-primary)',
      sub: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      err: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    }

    const card = {
      background: COLORS.layer,
      border: `1px solid ${COLORS.border}`,
      borderRadius: 12,
      padding: 16,
      boxSizing: 'border-box',
    }
    const row = { display: 'flex', alignItems: 'center', gap: 10 }
    const wrap = { display: 'flex', flexWrap: 'wrap', gap: 10 }
    const inputStyle = {
      width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8,
      border: `1px solid ${COLORS.border2}`, background: COLORS.layer2, color: COLORS.text,
      font: 'inherit', outline: 'none',
    }
    const ACCENT = '#2f6bff'
    const btn = (primary, disabled) => ({
      padding: '7px 14px', borderRadius: 8,
      border: `1px solid ${primary ? ACCENT : COLORS.border2}`,
      // 主按钮用固定蓝底白字，避免暗色主题里 brand-primary 与文字同为白色导致不可读；
      // 次按钮透明底 + 主题文字色，明暗主题都可见。
      background: primary ? ACCENT : 'transparent',
      color: primary ? '#ffffff' : COLORS.text,
      cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.55 : 1, font: 'inherit', fontWeight: 500,
    })
    const chip = (tone) => ({
      display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 999,
      fontSize: 12, color: tone === 'ok' ? COLORS.ok : tone === 'err' ? COLORS.err : tone === 'warn' ? COLORS.warn : COLORS.sub,
      background: COLORS.layer2, border: `1px solid ${COLORS.border}`,
    })
    const muted = { color: COLORS.sub, fontSize: 12 }
    // 命令/日志输出统一用等宽块显示。
    const preStyle = {
      margin: '8px 0 0', padding: '10px 12px', borderRadius: 8, background: COLORS.layer2,
      border: `1px solid ${COLORS.border}`, color: COLORS.text, overflow: 'auto',
      whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.55, fontSize: 12,
      maxHeight: 240, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    }

    async function call(path, options) {
      const res = await fetch(`${API}${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      })
      let data = null
      try {
        data = await res.json()
      } catch {
        data = null
      }
      if (!res.ok) {
        const message = data && data.error && data.error.message ? data.error.message : `HTTP ${res.status}`
        throw new Error(message)
      }
      return data
    }

    // 插件 Host 代码没有热更新：新路由要重启 DSH 才会注册，之前会以 404「未知路由」返回。
    function isRouteMissingError(err) {
      return /未知路由|not_found|unknown route|HTTP 404|404/i.test(String((err && err.message) || err || ''))
    }

    function timeAgo(iso, t) {
      if (!iso) return ''
      const ms = Date.now() - Date.parse(iso)
      if (!Number.isFinite(ms) || ms < 60_000) return t('justNow')
      if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} ${t('minutesAgo')}`
      return `${Math.floor(ms / 3_600_000)} ${t('hoursAgo')}`
    }

    function statusTone(status) {
      if (status === 'completed') return 'ok'
      if (status === 'failed' || status === 'timeout' || status === 'cancelled') return 'err'
      if (status === 'running' || status === 'assigned' || status === 'waiting') return 'warn'
      return 'idle'
    }

    function ButlerIcon({ size }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
        h('path', { d: 'M4 7.5c0-1.1.9-2 2-2h12c1.1 0 2 .9 2 2v9c0 1.1-.9 2-2 2H6c-1.1 0-2-.9-2-2z' }),
        h('path', { d: 'M9 3.5v4M15 3.5v4' }),
        h('circle', { cx: 9.5, cy: 11.5, r: 1 }),
        h('circle', { cx: 14.5, cy: 11.5, r: 1 }),
        h('path', { d: 'M9.5 15c1.5 1 3.5 1 5 0' }),
      )
    }

    function Badge({ tone, children }) {
      return h('span', { style: chip(tone) }, children)
    }

    function Field({ label, hint, children }) {
      return h('label', { style: { display: 'block', marginBottom: 12 } },
        h('div', { style: { fontSize: 13, fontWeight: 500, marginBottom: 6 } }, label),
        children,
        hint ? h('div', { style: { ...muted, marginTop: 4 } }, hint) : null,
      )
    }

    // 只读设备卡：面板只展示概况，改名/禁用/删除等操作统一去浏览器控制台。
    function DeviceCard({ device, t }) {
      const caps = device.capabilities || {}
      const load = device.load || {}
      const displayName = device.nickname || device.name || device.id || '-'
      const offline = !device.online || device.disabled
      const stateLabel = device.disabled ? t('disabled') : device.online ? t('online') : t('offline')
      const tone = device.disabled ? 'idle' : device.online ? 'ok' : 'err'
      return h('div', { style: { ...card, padding: 12, minWidth: 220, flex: '1 1 260px' } },
        h('div', { style: { ...row, gap: 8 } },
          h('span', {
            'aria-hidden': true,
            style: { width: 9, height: 9, borderRadius: 999, flex: 'none', background: offline ? COLORS.idle : COLORS.ok },
          }),
          h('strong', {
            style: { fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            title: device.name ? `${t('machineName')}: ${device.name}` : undefined,
          }, displayName),
          h('span', { style: { marginLeft: 'auto', flex: 'none' } }, h(Badge, { tone }, stateLabel)),
        ),
        device.nickname && device.name && device.nickname !== device.name
          ? h('div', { style: { ...muted, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `${t('machineName')}: ${device.name}`)
          : null,
        h('div', { style: { ...muted, marginTop: 6 } },
          `${device.platform || '-'} · ${device.kind || '-'} · ${t('load')} ${load.running != null ? `${load.running}/${load.max}` : '-'}`,
        ),
        h('div', { style: { ...muted, marginTop: 2 } }, `${t('lastSeen')} ${timeAgo(device.lastSeenAt, t)}`),
        caps.models && caps.models.length
          ? h('div', { style: { ...wrap, marginTop: 8 } },
              ...caps.models.slice(0, 3).map((m) => h('span', { key: `m-${m.id}`, style: chip() }, m.id)),
              caps.models.length > 3 ? h('span', { style: chip() }, `+${caps.models.length - 3}`) : null,
            )
          : null,
      )
    }

    // 最近任务只读行：只给状态和标题，任务详情与操作去浏览器控制台。
    function RecentTaskRow({ task, t }) {
      const tone = statusTone(task.status)
      const color = tone === 'ok' ? COLORS.ok : tone === 'err' ? COLORS.err : tone === 'warn' ? COLORS.warn : COLORS.sub
      const raw = String(task.instruction || task.id || '').replace(/\s+/g, ' ').trim()
      const title = raw.length > 90 ? `${raw.slice(0, 90)}…` : raw
      return h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, padding: '7px 0', borderBottom: `1px solid ${COLORS.border}` } },
        h('span', { style: { flex: 'none', fontSize: 12, fontWeight: 600, minWidth: 54, color } }, t(task.status) || task.status),
        h('span', {
          style: { flex: 1, minWidth: 0, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          title: raw,
        }, title),
        h('span', { style: { ...muted, flex: 'none' } },
          `${task.assignedDeviceName || task.assignedDeviceId || '-'} · ${timeAgo(task.updatedAt || task.createdAt, t)}`),
      )
    }

    // 仪表盘：只读概况 + 「在浏览器打开完整控制台」入口。
    function ConsoleTab({ status, snapshot, t, busy, message, messageTone, hubOrigin, onRefresh, onHub, onGuide }) {
      const hub = (status && status.hub) || {}
      const devices = (snapshot && snapshot.devices) || []
      const stats = (snapshot && snapshot.stats) || {}
      const allTasks = (snapshot && snapshot.tasks) || []
      const tasks = allTasks.filter((task) => !task.parentTaskId && !task.replyToTaskId)
      const recentTasks = tasks.slice(0, 6)
      const origin = hub.origin || hubOrigin || ''
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
        h('div', { style: { ...card, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 } },
          h('div', { style: { ...row, gap: 10, flexWrap: 'wrap' } },
            h(Badge, { tone: hub.running ? 'ok' : 'err' }, hub.running ? t('running') : t('stopped')),
            h('span', { style: muted }, `${origin}${hub.owned ? ` · ${t('owned')}` : hub.running ? ` · ${t('external')}` : ''}`),
          ),
          h('div', { style: { ...row, gap: 8, flexWrap: 'wrap' } },
            h('a', {
              href: `${ROOT}/api/dsh/open`,
              target: '_blank',
              rel: 'noopener noreferrer',
              title: t('openConsoleHint'),
              style: { ...btn(true), textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 },
            }, t('openConsole')),
            h('button', { style: btn(false), onClick: onGuide, title: t('guide') }, t('guide')),
            h('button', { style: btn(false, busy), onClick: onRefresh }, t('refresh')),
            h('button', {
              style: btn(false, busy),
              onClick: () => onHub('restart'),
              disabled: busy,
              title: hub.owned ? t('restartHubHint') : t('restartExternalHint'),
            }, t('restartHub')),
            hub.running
              ? h('button', { style: btn(false, busy || !hub.owned), onClick: () => onHub('stop'), disabled: busy || !hub.owned, title: hub.owned ? '' : t('stopExternalHint') }, t('stop'))
              : h('button', { style: btn(true, busy), onClick: () => onHub('start'), disabled: busy }, t('start')),
          ),
        ),
        message
          ? h('div', {
              style: { ...muted, color: messageTone === 'error' ? COLORS.err : COLORS.sub, lineHeight: 1.5 },
              role: messageTone === 'error' ? 'alert' : 'status',
            }, message)
          : null,
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 } },
          h(Stat, { label: t('online'), value: `${stats.devicesOnline ?? 0}/${stats.devicesTotal ?? devices.length}` }),
          h(Stat, { label: t('runningTasks'), value: (stats.tasksRunning ?? 0) + (stats.tasksWaiting ?? 0) }),
          h(Stat, { label: t('queued'), value: stats.tasksQueued ?? 0 }),
          h(Stat, { label: t('completed'), value: stats.tasksCompleted ?? 0 }),
          h(Stat, { label: t('failed'), value: stats.tasksFailed ?? 0, tone: 'err' }),
        ),
        h('section', null,
          h('h3', { style: { fontSize: 14, margin: '0 0 10px' } }, `${t('devices')} (${devices.length})`),
          devices.length
            ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 12 } },
                ...devices.map((d) => h(DeviceCard, { key: d.id, device: d, t })))
            : h('div', { style: { ...card, ...muted } }, t('noDevices')),
        ),
        h('section', { style: card },
          h('div', { style: { ...row, justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 6 } },
            h('h3', { style: { fontSize: 14, margin: 0 } }, `${t('recentTasks')} (${tasks.length})`),
            h('span', { style: muted }, t('openConsoleHint')),
          ),
          recentTasks.length
            ? h('div', { style: { display: 'flex', flexDirection: 'column' } },
                ...recentTasks.map((task) => h(RecentTaskRow, { key: task.id, task, t })))
            : h('div', { style: muted }, t('noTasks')),
        ),
      )
    }

    function Stat({ label, value, tone }) {
      return h('div', { style: { ...card, padding: 14 } },
        h('div', { style: { ...muted, fontSize: 12 } }, label),
        h('div', { style: { fontSize: 24, fontWeight: 650, marginTop: 4, color: tone === 'err' ? COLORS.err : COLORS.text } }, String(value)),
      )
    }

    // 命令块：等宽展示 + 一键复制；剪贴板不可用时保持可选中的纯文本。
    function CodeBlock({ text, t }) {
      const [copied, setCopied] = useState(false)
      const copy = () => {
        const write = typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText
        if (!write) return
        void navigator.clipboard.writeText(String(text)).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }).catch(() => {})
      }
      return h('div', { style: { position: 'relative', marginTop: 6 } },
        h('pre', { style: { ...preStyle, margin: 0 } }, text),
        h('button', {
          onClick: copy,
          title: t('copy'),
          style: {
            position: 'absolute', top: 6, right: 6, padding: '2px 8px', fontSize: 11,
            borderRadius: 6, border: `1px solid ${COLORS.border}`, background: COLORS.layer,
            color: COLORS.sub, cursor: 'pointer',
          },
        }, copied ? t('copied') : t('copy')),
      )
    }

    // 教程里的编号步骤：标题是一句可读的说明，children 放命令块或补充说明。
    function Step({ index, text, children }) {
      return h('div', { style: { marginTop: 12 } },
        h('div', { style: { fontSize: 13, fontWeight: 600, lineHeight: 1.6 } }, `${index}. ${text}`),
        children ? h('div', null, children) : null,
      )
    }

    // 教程：把 PC / 手机接成工作机的分步指南，命令里的 Hub 地址与加入码按当前状态自动填。
    function GuideTab({ t, hubOrigin, joinCode }) {
      const hub = hubOrigin || 'http://<母机IP>:7317'
      const code = joinCode || '<加入码>'
      const sectionCard = { ...card }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
        h('section', { style: sectionCard },
          h('h3', { style: { fontSize: 14, margin: '0 0 8px' } }, t('guide')),
          h('p', { style: { ...muted, margin: 0, lineHeight: 1.7 } }, t('guideIntro')),
          h('div', { style: { ...muted, marginTop: 6, lineHeight: 1.6 } }, t('guideHint')),
        ),
        h('section', { style: sectionCard },
          h('h3', { style: { fontSize: 14, margin: 0 } }, t('addPc')),
          h(Step, { index: 1, text: t('pcStep1') }),
          h(Step, { index: 2, text: t('pcStep2') },
            h(CodeBlock, { t, text: 'git clone https://github.com/andrewngg/dsh-superagent-battlestar.git super-butler' })),
          h(Step, { index: 3, text: t('pcStep3') },
            h(CodeBlock, { t, text: 'copy device-agent\\configs\\cli-machine.example.json device-agent\\configs\\cli-machine.json' })),
          h(Step, { index: 4, text: t('pcStep4') },
            h(CodeBlock, { t, text: `node device-agent/agent.js --hub ${hub} --join-code ${code} --name "书房工作站" --config device-agent/configs/cli-machine.json --state-dir device-agent/.state/study-pc` })),
          h(Step, { index: 5, text: t('pcStep5') }),
          h(Step, { index: 6, text: t('pcStep6') }),
        ),
        h('section', { style: sectionCard },
          h('h3', { style: { fontSize: 14, margin: 0 } }, t('addPhoneWorker')),
          h(Step, { index: 1, text: t('phoneStep1') }),
          h(Step, { index: 2, text: t('phoneStep2') }),
          h(Step, { index: 3, text: t('phoneStep3') },
            h(CodeBlock, { t, text: "pipx install 'git+https://github.com/wangzan101/Mika.git@<tag>#subdirectory=tools/mika'\nmika doctor --json" })),
          h(Step, { index: 4, text: t('phoneStep4') },
            h(CodeBlock, { t, text: 'copy device-agent\\configs\\phone-mika.example.json device-agent\\configs\\phone-mika.json' })),
          h(Step, { index: 5, text: t('phoneStep5') },
            h(CodeBlock, { t, text: `node device-agent/agent.js --hub ${hub} --join-code ${code} --name "手机工作机 Mika" --config device-agent/configs/phone-mika.json --state-dir device-agent/.state/phone-mika` })),
          h(Step, { index: 6, text: t('phoneStep6') }),
        ),
        h('section', { style: sectionCard },
          h('h3', { style: { fontSize: 14, margin: 0 } }, t('phoneControl')),
          h(Step, { index: 1, text: t('ctrlStep1') },
            h(CodeBlock, { t, text: `${hub}/m?token=<管理员令牌>` })),
          h(Step, { index: 2, text: t('ctrlStep2') },
            h(CodeBlock, { t, text: 'dist/BattleStar-0.1.5.apk' })),
          h(Step, { index: 3, text: t('ctrlStep3') }),
        ),
        h('section', { style: sectionCard },
          h('h3', { style: { fontSize: 14, margin: 0 } }, t('guideTrouble')),
          h('ul', { style: { margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.7, color: COLORS.sub, fontSize: 12.5 } },
            h('li', null, t('troubleOffline')),
            h('li', null, t('troubleJoinCode')),
            h('li', null, t('troubleRouting')),
          ),
          h('div', { style: { ...muted, marginTop: 10, lineHeight: 1.6 } }, t('guideDocs')),
        ),
      )
    }

    function SettingsTab({ settings, secrets, status, credentials, t, onSave, busy, message }) {
      const s = settings || {}
      const hub = status && status.hub ? status.hub : {}
      const [form, setForm] = useState({
        projectRoot: s.projectRoot || '', hubPort: s.hubPort || 7317, autoStart: s.autoStart !== false,
        devWorkspacePath: s.devWorkspacePath || '',
        githubUser: s.githubUser || '', defaultModel: s.defaultModel || 'deepseek-chat',
        hubNickname: s.hubNickname || '',
      })
      const [keys, setKeys] = useState({ githubToken: '', deepseekApiKey: '', agnesApiKey: '', doubaoApiKey: '', opencodeApiKey: '' })
      const [tests, setTests] = useState({})
      const [localMsg, setLocalMsg] = useState('')
      const [gitInfo, setGitInfo] = useState(null)
      const [gitBusy, setGitBusy] = useState(false)
      const [gitResult, setGitResult] = useState(null)
      const [gitError, setGitError] = useState('')
      useEffect(() => {
        let alive = true
        call('/dsh/git-push')
          .then((info) => { if (alive) setGitInfo(info) })
          .catch((err) => { if (alive && isRouteMissingError(err)) setGitError(t('gitPushNeedsRestart')) })
        return () => { alive = false }
      }, [])
      useEffect(() => {
        setForm({
          projectRoot: s.projectRoot || '', hubPort: s.hubPort || 7317, autoStart: s.autoStart !== false,
          devWorkspacePath: s.devWorkspacePath || '',
          githubUser: s.githubUser || '', defaultModel: s.defaultModel || 'deepseek-chat',
          hubNickname: s.hubNickname || '',
        })
      }, [s.projectRoot, s.hubPort, s.autoStart, s.devWorkspacePath, s.githubUser, s.defaultModel, s.hubNickname])
      const set = (k, v) => setForm((prev) => ({ ...prev, [k]: v }))
      const save = async () => {
        const payload = { settings: { ...form, hubPort: Number(form.hubPort) || 7317 }, secrets: {} }
        for (const [k, v] of Object.entries(keys)) if (v.trim()) payload.secrets[k] = v.trim()
        const res = await onSave(payload)
        setKeys({ githubToken: '', deepseekApiKey: '', agnesApiKey: '', doubaoApiKey: '', opencodeApiKey: '' })
        if (res && res.cleared) setLocalMsg(t('saved'))
      }
      const clear = async (key) => {
        await onSave({ settings: {}, secrets: {}, clearSecrets: [key] })
        setLocalMsg(`${key} ${t('clear')}`)
      }
      const testKey = async (key) => {
        setTests((prev) => ({ ...prev, [key]: { loading: true } }))
        try {
          const result = await call('/test-credential', { method: 'POST', body: JSON.stringify({ key }) })
          setTests((prev) => ({ ...prev, [key]: result }))
        } catch (err) {
          setTests((prev) => ({ ...prev, [key]: { ok: false, status: 'error', message: err.message || String(err) } }))
        }
      }
      const keyFields = [
        ['githubToken', 'githubToken'], ['deepseekApiKey', 'deepseekApiKey'],
        ['agnesApiKey', 'agnesApiKey'], ['doubaoApiKey', 'doubaoApiKey'], ['opencodeApiKey', 'opencodeApiKey'],
      ]
      const runGitPush = async () => {
        setGitBusy(true)
        setGitResult(null)
        setGitError('')
        try {
          const result = await call('/dsh/git-push', { method: 'POST', body: '{}' })
          setGitResult(result)
          if (result && result.repo) setGitInfo(result)
        } catch (err) {
          setGitError(isRouteMissingError(err) ? t('gitPushNeedsRestart') : (err.message || String(err)))
        } finally {
          setGitBusy(false)
        }
      }
      const secretMap = Object.fromEntries((secrets || []).map((x) => [x.key, x]))
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
        h('section', { style: card },
          h('h3', { style: { fontSize: 14, margin: '0 0 12px' } }, t('hubSettings')),
          h('div', { style: { ...muted, marginBottom: 8 } }, t('devWorkspaceHint')),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 } },
            h(Field, { label: t('projectRoot') }, h('input', { value: form.projectRoot, onChange: (e) => set('projectRoot', e.target.value), style: inputStyle })),
            h(Field, { label: t('devWorkspacePath') }, h('input', { value: form.devWorkspacePath, onChange: (e) => set('devWorkspacePath', e.target.value), style: inputStyle, placeholder: 'C:\\Users\\<you>\\Documents\\super ai' })),
            h(Field, { label: t('hubNickname') }, h('input', { value: form.hubNickname, onChange: (e) => set('hubNickname', e.target.value), style: inputStyle, placeholder: 'BattleStar母机' })),
            h(Field, { label: t('hubPort') }, h('input', { value: form.hubPort, onChange: (e) => set('hubPort', e.target.value), style: inputStyle, inputMode: 'numeric' })),
            h(Field, { label: t('githubUser') }, h('input', { value: form.githubUser, onChange: (e) => set('githubUser', e.target.value), style: inputStyle, placeholder: 'octocat' })),
            h(Field, { label: t('defaultModel') }, h('input', { value: form.defaultModel, onChange: (e) => set('defaultModel', e.target.value), style: inputStyle, placeholder: 'deepseek-chat' })),
          ),
          h('label', { style: { ...row, gap: 8, marginTop: 4, fontSize: 13 } },
            h('input', { type: 'checkbox', checked: form.autoStart, onChange: (e) => set('autoStart', e.target.checked) }),
            t('autoStart'),
          ),
          h('div', { style: { ...muted, marginTop: 8 } }, `${t('joinCode')}: ${hub.joinCode || hub.joinCodeMasked || '-'}`),
        ),
        h('section', { style: card },
          h('h3', { style: { fontSize: 14, margin: '0 0 6px' } }, t('keys')),
          h('div', { style: { ...muted, marginBottom: 12 } }, t('keysHint')),
          credentials && credentials.available === false
            ? h('div', { style: { ...muted, marginBottom: 12, lineHeight: 1.6, color: COLORS.warn } }, t('credentialsFallback'))
            : null,
          ...keyFields.map(([key, labelKey]) => {
            const info = secretMap[key] || {}
            const tested = tests[key]
            return h('div', { key, style: { marginBottom: 12 } },
              h('div', { style: { ...row, justifyContent: 'space-between', marginBottom: 4 } },
                h('span', { style: { fontSize: 13, fontWeight: 500 } }, t(labelKey)),
                h('span', { style: { ...row, gap: 6 } },
                  h(Badge, { tone: info.configured ? 'ok' : 'idle' }, info.configured ? t('configured') : t('notConfigured')),
                  info.source === 'plugin-local' ? h('span', { style: { ...muted, fontSize: 11 } }, t('credentialsLocalBadge')) : null,
                  info.configured
                    ? h('button', {
                        style: { ...btn(false), padding: '2px 8px', fontSize: 12 },
                        disabled: Boolean(tested && tested.loading),
                        onClick: () => void testKey(key),
                      }, tested && tested.loading ? t('testing') : t('testToken'))
                    : null,
                  info.configured ? h('button', { style: btn(false), onClick: () => clear(key) }, t('clear')) : null,
                ),
              ),
              h('input', {
                type: 'password', value: keys[key], autoComplete: 'off', placeholder: info.configured ? '••••••••' : '',
                onChange: (e) => setKeys((prev) => ({ ...prev, [key]: e.target.value })), style: inputStyle,
              }),
              tested && !tested.loading
                ? h('div', {
                    style: {
                      ...muted, marginTop: 4,
                      color: tested.ok ? COLORS.ok : tested.status === 'invalid' ? COLORS.err : COLORS.warn,
                    },
                  }, `${tested.ok ? t('testOk') : tested.status === 'unverified' ? t('testUnverified') : t('testInvalid')}${tested.httpStatus ? ` (HTTP ${tested.httpStatus})` : ''}${tested.latencyMs != null ? ` · ${tested.latencyMs}ms` : ''}${tested.message ? ` · ${tested.message}` : ''}`)
                : null,
            )
          }),
        ),
        h('section', { style: card },
          h('h3', { style: { fontSize: 14, margin: '0 0 8px' } }, t('devTools')),
          h('div', { style: { ...muted, marginBottom: 8, lineHeight: 1.6 } }, t('gitPushHint')),
          h('div', { style: { ...muted, marginBottom: 10, lineHeight: 1.6 } },
            gitInfo
              ? `${t('gitRepo')}: ${gitInfo.repo || '—'}${gitInfo.branch ? ` · ${t('gitBranch')}: ${gitInfo.branch}` : ''}${gitInfo.remote ? ` · ${t('gitRemote')}: ${gitInfo.remote}` : ''}${gitInfo.remote ? ` · ${t('gitUpstream')}: ${gitInfo.upstream || t('gitNoUpstream')}` : ''}`
              : t('gitRepoUnknown')),
          h('button', {
            style: btn(true, gitBusy), disabled: gitBusy, onClick: () => void runGitPush(),
          }, gitBusy ? t('gitPushing') : t('gitPush')),
          gitResult
            ? h('div', { style: { marginTop: 10 } },
                h('div', { style: { ...muted, fontWeight: 600, color: gitResult.ok ? COLORS.ok : COLORS.err } },
                  `${gitResult.ok ? t('gitPushOk') : t('gitPushFailed')}${gitResult.message ? ` · ${gitResult.message}` : ''}${gitResult.branch ? ` · ${gitResult.branch}` : ''}`),
                gitResult.output ? h('pre', { style: preStyle }, gitResult.output) : null,
              )
            : null,
          gitError ? h('div', { style: { marginTop: 10, color: COLORS.err } }, gitError) : null,
        ),
        h('div', { style: { ...row, justifyContent: 'flex-end' } },
          h('button', { style: btn(true, busy), disabled: busy, onClick: save }, busy ? t('saving') : t('save')),
        ),
        (message || localMsg) ? h('div', { style: { ...muted, textAlign: 'right' } }, message || localMsg) : null,
        h('div', { style: { ...muted } }, t('adminTokenHidden')),
      )
    }

    // 心智（Soul / Skill）编辑已从 Web 控制台迁移到本插件面板；数据仍由 Hub 的 /api/mind 持久化。
    function MindTab({ t }) {
      const [mind, setMind] = useState(null)
      const [soul, setSoul] = useState('')
      const [skill, setSkill] = useState('')
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      // Host 代码不热更新：DSH 里跑的是旧插件时 /api/mind 会 404「未知路由」。
      // 此时把“需要重启”做成醒目的横幅，避免空白输入框被误读成“心智数据丢了”。
      const [hostStale, setHostStale] = useState(false)

      const apply = useCallback((next) => {
        if (!next) return
        setMind(next)
        setSoul(String(next.soul || ''))
        setSkill(String(next.skill || ''))
      }, [])

      const load = useCallback(async () => {
        try {
          const res = await call('/mind')
          apply(res && res.mind ? res.mind : res)
          setHostStale(false)
          setError('')
        } catch (err) {
          const missing = isRouteMissingError(err)
          setHostStale(missing)
          setError(missing ? t('mindLoadNeedsRestart') : (err.message || t('mindLoadFailed')))
        }
      }, [apply, t])

      useEffect(() => { void load() }, [load])

      const limits = (mind && mind.limits) || { soul: 6000, skill: 12000 }

      const patch = async (body, key, doneKey) => {
        setBusy(key)
        setError('')
        setNotice('')
        try {
          const res = await call('/mind', { method: 'PATCH', body: JSON.stringify(body) })
          apply(res && res.mind ? res.mind : res)
          setNotice(t(doneKey))
        } catch (err) {
          const missing = isRouteMissingError(err)
          if (missing) setHostStale(true)
          setError(missing ? t('mindLoadNeedsRestart') : (err.message || t('mindSaveFailed')))
        } finally {
          setBusy('')
        }
      }

      const dirty = Boolean(mind) && (soul !== String(mind.soul || '') || skill !== String(mind.skill || ''))
      const badge = (isDefault) => h(Badge, { tone: isDefault ? 'idle' : 'ok' },
        isDefault ? t('mindDefaultBadge') : t('mindCustomBadge'))
      const updatedAt = mind && mind.updatedAt
        ? `${t('mindUpdatedAt')} ${timeAgo(mind.updatedAt, t)}`
        : t('mindNeverUpdated')
      const textareaStyle = {
        ...inputStyle, resize: 'vertical', lineHeight: 1.6, minHeight: 150,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12,
      }

      const fieldBlock = (label, hint, value, onChange, isDefault, charCount, limit, resetBody, resetKey) =>
        h(Field, { label, hint }, h('div', null,
          h('textarea', {
            value, rows: 10, spellCheck: false, readOnly: hostStale,
            placeholder: hostStale ? t('mindLoadNeedsRestart') : undefined,
            style: textareaStyle, onChange: (e) => onChange(e.target.value),
          }),
          h('div', { style: { ...row, justifyContent: 'space-between', marginTop: 6, gap: 8, flexWrap: 'wrap' } },
            h('span', { style: muted }, `${charCount} / ${limit}`),
            h('span', { style: { ...row, gap: 6 } },
              badge(isDefault),
              h('button', {
                style: btn(false, Boolean(busy)), disabled: Boolean(busy) || hostStale,
                onClick: () => void patch(resetBody, resetKey, 'mindResetDone'),
              }, t('mindReset')),
            ),
          ),
        ))

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
        h('section', { style: card },
          h('div', { style: { ...row, justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' } },
            h('h3', { style: { fontSize: 14, margin: 0 } }, t('mindTitle')),
            h('span', { style: muted }, updatedAt),
          ),
          h('div', { style: { ...muted, margin: '8px 0 14px', lineHeight: 1.6 } }, t('mindHint')),
          hostStale
            ? h('div', {
                role: 'status',
                style: {
                  margin: '0 0 14px', padding: '10px 12px', borderRadius: 8,
                  border: `1px solid ${COLORS.warn}`, background: COLORS.layer2,
                  color: COLORS.warn, fontSize: 12, lineHeight: 1.6,
                },
              }, t('mindLoadNeedsRestart'))
            : null,
          fieldBlock(t('soulField'), t('soulHint'), soul, setSoul, mind ? mind.soulIsDefault : true, soul.length, limits.soul, { resetSoul: true }, 'reset-soul'),
          fieldBlock(t('skillField'), t('skillHint'), skill, setSkill, mind ? mind.skillIsDefault : true, skill.length, limits.skill, { resetSkill: true }, 'reset-skill'),
          h('div', { style: { ...row, justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' } },
            h('button', {
              style: btn(false, Boolean(busy)), disabled: Boolean(busy),
              onClick: () => void patch({ resetSoul: true, resetSkill: true }, 'reset-all', 'mindResetDone'),
            }, t('mindResetAll')),
            h('button', {
              style: btn(true, Boolean(busy) || !dirty || hostStale), disabled: Boolean(busy) || !dirty || hostStale,
              onClick: () => void patch({ soul, skill }, 'save', 'mindSaved'),
            }, busy === 'save' ? t('mindSaving') : t('mindSave')),
          ),
          (error || notice)
            ? h('div', { style: { ...muted, textAlign: 'right', marginTop: 10, color: error ? COLORS.err : COLORS.ok } }, error || notice)
            : null,
        ),
      )
    }

    function Panel({ ctx }) {
      const t = ctx.locale.bind(NS)
      const [tab, setTab] = useState('console')
      const [status, setStatus] = useState(null)
      const [snapshot, setSnapshot] = useState(null)
      const [settingsData, setSettingsData] = useState(null)
      const [busy, setBusy] = useState(false)
      const [message, setMessage] = useState('')
      const [messageTone, setMessageTone] = useState('')
      const [error, setError] = useState('')
      const hubDisplayName = (settingsData && settingsData.settings && settingsData.settings.hubNickname) || t('title')

      const load = useCallback(async () => {
        try {
          const [statusRes, snapshotRes, settingsRes] = await Promise.all([
            call('/status'),
            call('/snapshot?limit=80').catch(() => null),
            call('/settings').catch(() => null),
          ])
          setStatus(statusRes)
          if (snapshotRes) setSnapshot(snapshotRes)
          if (settingsRes) setSettingsData(settingsRes)
          setError('')
        } catch (err) {
          setError(err.message || t('apiUnavailable'))
        }
      }, [])

      useEffect(() => {
        let alive = true
        const run = () => { if (alive) void load() }
        run()
        const timer = setInterval(run, 5000)
        return () => { alive = false; clearInterval(timer) }
      }, [load])

      const notify = (text, tone = '') => {
        setMessage(String(text || ''))
        setMessageTone(tone)
      }

      const withBusy = async (fn) => {
        setBusy(true)
        notify('')
        try {
          await fn()
        } catch (err) {
          notify(err.message || t('taskFailed'), 'error')
        } finally {
          setBusy(false)
        }
      }

      const onHub = (action) => withBusy(async () => {
        let res
        try {
          res = await call(`/hub/${action}`, { method: 'POST', body: '{}' })
        } catch (err) {
          // 旧 Host 没有「重启 Hub」路由时，直接告诉用户需要重启 DSH，而不是抛出「未知路由」。
          if (action === 'restart' && isRouteMissingError(err)) throw new Error(t('restartNeedsRestart'))
          throw err
        }
        if (action === 'restart') {
          if (res && res.ok === false) {
            notify(res.reason || t('restartHubFailed'), 'error')
            return
          }
          notify(t('hubRestarting'))
          await new Promise((resolve) => setTimeout(resolve, 3000))
          await load()
          return
        }
        await load()
        notify(action === 'start' ? t('running') : t('stopped'))
      })

      const onSave = async (payload) => {
        setBusy(true)
        notify('')
        try {
          const res = await call('/settings', { method: 'POST', body: JSON.stringify(payload) })
          await load()
          notify(t('saved'))
          return res
        } catch (err) {
          notify(err.message || t('settingsFailed'), 'error')
          return null
        } finally {
          setBusy(false)
        }
      }

      const header = h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' } },
        h('div', { style: { ...row, gap: 12 } },
          h('div', { style: { width: 42, height: 42, borderRadius: 12, background: COLORS.layer2, border: `1px solid ${COLORS.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center' } },
            h(ButlerIcon, { size: 24 }),
          ),
          h('div', null,
            h('h1', { style: { fontSize: 20, margin: 0 } }, hubDisplayName),
            h('div', { style: { ...muted } }, t('subtitle')),
          ),
        ),
        h('div', { style: { ...row, gap: 8 } },
          h(Badge, { tone: status && status.hub && status.hub.running ? 'ok' : 'err' },
            status && status.hub && status.hub.running ? t('running') : t('stopped')),
        ),
      )

      const tabs = h('div', { style: { display: 'flex', gap: 6, marginTop: 16, borderBottom: `1px solid ${COLORS.border}`, paddingBottom: 8 } },
        ['console', 'guide', 'mind', 'settings'].map((key) => h('button', {
          key, onClick: () => setTab(key), style: {
            ...btn(tab === key), fontWeight: 600,
          },
        }, key === 'console' ? t('dashboard') : key === 'guide' ? t('guide') : key === 'mind' ? t('mind') : t('settings'))),
      )

      return h('div', { style: { height: '100%', overflow: 'auto', boxSizing: 'border-box', padding: '22px 26px', background: COLORS.bg, color: COLORS.text, font: 'inherit' } },
        h('div', { style: { maxWidth: 1080, margin: '0 auto' } },
          header,
          tabs,
          error ? h('div', { style: { ...card, marginTop: 16, borderColor: COLORS.err, color: COLORS.err } }, `${t('loadFailed')}: ${error}`) : null,
          h('div', { style: { marginTop: 16 } },
            tab === 'console'
              ? h(ConsoleTab, {
                  status, snapshot, t, busy, message, messageTone,
                  hubOrigin: status && status.hub ? status.hub.origin : '',
                  onRefresh: () => void load(), onHub, onGuide: () => setTab('guide'),
                })
              : tab === 'guide'
                ? h(GuideTab, {
                    t,
                    hubOrigin: status && status.hub ? status.hub.origin : '',
                    joinCode: status && status.hub ? status.hub.joinCode : '',
                  })
                : tab === 'mind'
                  ? h(MindTab, { t })
                  : h(SettingsTab, {
                    settings: settingsData && settingsData.settings, secrets: settingsData && settingsData.secrets,
                    credentials: settingsData && settingsData.credentials,
                    status, t, busy, message, onSave,
                  }),
          ),
        ),
      )
    }

    function PanelSlot() {
      // ctx is captured by the closure created in apply()
      return h(Panel, { ctx: PanelSlot.ctx })
    }
    PanelSlot.ctx = null

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        PanelSlot.ctx = ctx
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'super-butler: dictionaries')
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: PANEL_ID, locale: NS, inject: () => ({}) },
          PanelSlot,
        )), 'super-butler: main panel')
        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 5, label: () => t('panel'), locale: NS },
          ButlerIcon,
        )), 'super-butler: sidebar entry')
      },
    }
  },
})
