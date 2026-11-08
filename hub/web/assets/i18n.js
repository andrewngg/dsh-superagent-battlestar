'use strict';

/**
 * BattleStar 控制台多语言（简体中文 / English）。
 *
 * 设计：
 *  - 新功能（执行记录、语言设置）用 key-based `t('records.title')`；
 *  - 既有界面用「中文原文 → English」短语表 + 少量正则模式做运行时本地化，
 *    避免一次性重写 3600 行 app.js；默认中文时完全不做任何处理。
 *  - 任务原文/输出/事件等“数据”不翻译（通过 skip 选择器跳过）。
 *
 * 用法：
 *   ButlerI18n.t('records.title')
 *   ButlerI18n.getLang() / ButlerI18n.setLang('en') / ButlerI18n.apply(document.body)
 *   ButlerI18n.effectiveLang(serverDefault)   // URL ?lang= > localStorage > 服务端默认
 */

(function (global) {
  const DEFAULT_LANG = 'zh-CN';
  const STORAGE_KEY = 'butler.lang';
  const LANGUAGES = [
    { id: 'zh-CN', label: '简体中文' },
    { id: 'en', label: 'English' },
  ];
  const LANG_IDS = LANGUAGES.map((item) => item.id);

  const MESSAGES = {
    'zh-CN': {
      'records.title': '执行记录',
      'records.subtitle': '每个任务的完整执行记录（Markdown）',
      'records.open': '执行记录',
      'records.openHint': '查看任务的完整执行记录（事件时间线 / 耗时 / 路由 / 日志）',
      'records.searchPlaceholder': '搜索任务 ID / 指令 / 设备 / 错误…',
      'records.filterAll': '全部状态',
      'records.refresh': '刷新',
      'records.loading': '正在载入执行记录…',
      'records.empty': '没有匹配的执行记录',
      'records.count': '共 {n} 条',
      'records.back': '返回列表',
      'records.copy': '复制 Markdown',
      'records.download': '下载 .md',
      'records.copied': '记录已复制',
      'records.downloaded': '已开始下载记录',
      'records.copyFailed': '复制失败，请手动选择',
      'records.file': '文件',
      'records.size': '大小',
      'records.updatedAt': '文件更新时间',
      'records.device': '执行设备',
      'records.duration': '耗时',
      'records.createdAt': '创建时间',
      'records.status': '状态',
      'records.error': '错误',
      'records.task': '任务',
      'records.missing': '执行记录不存在（任务可能已被删除，或记录尚未生成）',
      'records.noFile': '记录文件尚未生成（任务可能仍在执行）',
      'records.loadFailed': '执行记录载入失败',
      'records.unavailable': '当前 Hub 未启用执行记录',
      'records.settingsHint': '任务执行记录保存在 Hub 的 task-records 目录，可在右上角时钟按钮进入浏览。',
      'settings.languageSection': '系统默认语言',
      'settings.languageLabel': '默认语言',
      'settings.languageHint': '影响所有客户端首次打开控制台时的界面语言；本机切换后会记住。任务原文/输出保持原样。',
      'settings.languageSaved': '系统默认语言已更新',
      'settings.languageFailed': '语言设置保存失败',
      'settings.openRecords': '浏览执行记录',
      'settings.recordsHint': '查看每个任务的完整执行记录（Markdown）。',
      'common.refresh': '刷新',
      'common.close': '关闭',
      'common.cancel': '取消',
      'common.confirm': '确认',
      'common.back': '返回',
      'common.details': '详情',
      'status.queued': '排队中',
      'status.assigned': '已派发',
      'status.running': '执行中',
      'status.waiting': '等待回答',
      'status.completed': '已完成',
      'status.failed': '失败',
      'status.timeout': '超时',
      'status.cancelled': '已取消',
    },
    en: {
      'records.title': 'Execution records',
      'records.subtitle': 'Full per-task execution record (Markdown)',
      'records.open': 'Records',
      'records.openHint': 'Browse full task records (timeline / durations / routing / logs)',
      'records.searchPlaceholder': 'Search task id / instruction / device / error…',
      'records.filterAll': 'All statuses',
      'records.refresh': 'Refresh',
      'records.loading': 'Loading execution records…',
      'records.empty': 'No matching records',
      'records.count': '{n} record(s)',
      'records.back': 'Back to list',
      'records.copy': 'Copy Markdown',
      'records.download': 'Download .md',
      'records.copied': 'Record copied',
      'records.downloaded': 'Download started',
      'records.copyFailed': 'Copy failed, please select manually',
      'records.file': 'File',
      'records.size': 'Size',
      'records.updatedAt': 'File updated',
      'records.device': 'Device',
      'records.duration': 'Duration',
      'records.createdAt': 'Created',
      'records.status': 'Status',
      'records.error': 'Error',
      'records.task': 'Task',
      'records.missing': 'Record not found (task may be deleted or the record has not been generated yet)',
      'records.noFile': 'Record file not generated yet (task may still be running)',
      'records.loadFailed': 'Failed to load execution records',
      'records.unavailable': 'Execution records are not enabled on this Hub',
      'records.settingsHint': 'Task records live in the Hub task-records directory; open them from the clock button in the header.',
      'settings.languageSection': 'System language',
      'settings.languageLabel': 'Default language',
      'settings.languageHint': 'Applied to every client on first load; this browser remembers your choice. Task instructions/outputs are kept as-is.',
      'settings.languageSaved': 'System default language updated',
      'settings.languageFailed': 'Failed to save language setting',
      'settings.openRecords': 'Browse execution records',
      'settings.recordsHint': 'Browse the full execution record (Markdown) of each task.',
      'common.refresh': 'Refresh',
      'common.close': 'Close',
      'common.cancel': 'Cancel',
      'common.confirm': 'Confirm',
      'common.back': 'Back',
      'status.queued': 'Queued',
      'status.assigned': 'Assigned',
      'status.running': 'Running',
      'status.waiting': 'Waiting for answer',
      'status.completed': 'Completed',
      'status.failed': 'Failed',
      'status.timeout': 'Timed out',
      'status.cancelled': 'Cancelled',
    },
  };

  /** 既有界面的「中文原文 → English」短语表（运行时按文本节点/属性精确匹配）。 */
  const PHRASES = {
    en: {
      /* ---------- 连接页 ---------- */
      '多设备智能管家': 'Multi-device AI butler',
      '家庭 AI 中枢': 'Home AI hub',
      '多设备智能管家控制台': 'Multi-device AI butler console',
      'BattleStar · 控制台': 'BattleStar · Console',
      '连接到中枢': 'Connect to the Hub',
      '输入 Hub 地址与管理员令牌。手机 APK / WebView 内访问时，地址留空即使用当前入口。':
        'Enter the Hub address and admin token. In the APK/WebView, leave the address empty to use the current origin.',
      'Hub 地址': 'Hub address',
      '留空 = 当前页面地址（推荐，同源无需跨域）。': 'Leave empty = current page origin (recommended, same-origin).',
      '管理员令牌': 'Admin token',
      'adminToken（见 hub 启动日志）': 'adminToken (see Hub startup log)',
      '显示令牌': 'Show token',
      '显示/隐藏令牌': 'Show/hide token',
      '隐藏令牌': 'Hide token',
      '令牌只保存在本机 localStorage，不会上传到其他服务。': 'The token stays in this browser (localStorage) and is never uploaded.',
      '测试并连接': 'Test & connect',
      '协议 v1': 'Protocol v1',
      '零依赖 · 局域网': 'Zero-dependency · LAN',
      'SSE 实时': 'SSE live',
      '提示：也可用 <code>?token=…</code> 直接进入；连接成功后会记住本机。':
        'Tip: you can also open with <code>?token=…</code>; this browser will be remembered.',
      '打开导航': 'Open navigation',
      '关闭导航': 'Close navigation',
      /* ---------- 顶栏 / 面板 ---------- */
      '在线': 'Online',
      '离线': 'Offline',
      '运行': 'Running',
      '排队': 'Queued',
      '关键指标': 'Key metrics',
      '实时事件流状态': 'Live event stream status',
      '刷新数据 (R)': 'Refresh data (R)',
      '刷新数据': 'Refresh data',
      '执行记录': 'Records',
      '打开执行记录': 'Open execution records',
      '设置': 'Settings',
      '打开设置': 'Open settings',
      '退出': 'Sign out',
      '设备': 'Devices',
      '正在加载…': 'Loading…',
      '任务': 'Tasks',
      '全部': 'All',
      '进行中': 'Active',
      '已完成': 'Completed',
      '失败': 'Failed',
      '已归档': 'Archived',
      '任务筛选': 'Task filter',
      '发指令': 'Command',
      '描述任务，中枢自动挑选设备': 'Describe a task; the Hub picks a device',
      '继续任务': 'Continue task',
      '取消': 'Cancel',
      '指令内容': 'Instruction',
      '例如：把本周的开销记录整理成一份 Word 报告，并附上汇总表格':
        'e.g. Turn this week’s expense records into a Word report with a summary table',
      '发送': 'Send',
      '添加附件': 'Add attachment',
      '小文件 ≤2MB，最多 3 个': 'Small files ≤2MB, up to 3',
      '模型要求': 'Model',
      '不限模型': 'Any model',
      '目标设备': 'Target device',
      '自动路由（全部在线）': 'Auto route (all online)',
      '技能要求': 'Skills',
      '可多选': 'Multi-select',
      '优先级': 'Priority',
      '超时': 'Timeout',
      '9 · 紧急': '9 · Urgent',
      '7 · 高': '7 · High',
      '5 · 普通': '5 · Normal',
      '3 · 低': '3 · Low',
      '1 · 后台': '1 · Background',
      '自动路由：等待在线设备…': 'Auto route: waiting for online devices…',
      '指定设备：': 'Device: ',
      '（当前离线，任务将排队）': ' (offline, task will queue)',
      '匹配要求的在线设备：': 'Matching online devices: ',
      '自动路由：': 'Auto route: ',
      ' · 将排队等待设备': ' · will queue for a device',
      '未开启。开启后通知栏会常驻显示管家状态。': 'Off. When enabled, the notification bar shows butler status.',
      '已开启：通知栏会常驻显示任务进度或在线/待命统计。':
        'On: the notification bar shows task progress or online/standby counts.',
      '已开启，但通知权限未授予；请在系统设置中允许「BattleStar」通知。':
        'On, but notification permission is not granted. Allow BattleStar notifications in system settings.',
      '无法读取通知设置': 'Cannot read notification settings',
      '附件': 'Attachment',
      '发送指令': 'Send instruction',
      '实时动态': 'Live activity',
      '等待事件…': 'Waiting for events…',
      '设置': 'Settings',
      '连接、令牌与本机信息': 'Connection, token and local info',
      'Developer Mode': 'Developer Mode',
      '直接和 DeepSeek Harness 沟通，修改 BattleStar 仓库':
        'Talk to DeepSeek Harness directly to modify the BattleStar repo',
      '新会话': 'New session',
      '开发者模式': 'Developer mode',
      '只允许修改 super-butler 仓库；不要输出或提交私人 token、密钥、个人资料。修改会直接生效，请自行确认测试结果。':
        'Only the super-butler repo may be modified; never output or commit private tokens/keys/personal data. Changes apply immediately — verify test results yourself.',
      '告诉 DSH 要改什么，例如：把任务卡片的按钮改成两列，并修复移动端溢出。':
        'Tell DSH what to change, e.g. make task actions two columns and fix mobile overflow.',
      '改动对象': 'Change scope',
      '全局 · 整套系统': 'Global · whole system',
      'DSH 插件 · dsh-plugin': 'DSH plugin · dsh-plugin',
      'APK · android': 'APK · android',
      'Localhost 界面 · hub/web': 'Localhost UI · hub/web',
      '描述要修改的功能、bug 或重构要求…': 'Describe the feature, bug or refactor…',
      '只修改当前 BattleStar 仓库': 'Only modifies the current BattleStar repo',
      '发送给 DSH': 'Send to DSH',
      '状态': 'Status',
      '指令': 'Command',
      '开发': 'Dev',
      /* ---------- 状态 / 事件标签 ---------- */
      '排队中': 'Queued',
      '等待分配': 'Waiting to assign',
      '等待设备接受…': 'Waiting for device…',
      '已派发': 'Assigned',
      '等待设备': 'Waiting for device',
      '运行中': 'Running',
      '执行中': 'Running',
      '等待回答': 'Waiting for answer',
      '完成': 'Completed',
      '已取消': 'Cancelled',
      '创建': 'Created',
      '路由': 'Routing',
      '分配': 'Assigned',
      '接受': 'Accepted',
      '进度': 'Progress',
      '重试': 'Retry',
      '重新提交': 'Resubmitted',
      '重新排队': 'Requeued',
      '失败 / 超时': 'Failed / timeout',
      '运行 / 等待': 'Running / waiting',
      '空闲': 'Idle',
      '忙碌': 'Busy',
      '降级': 'Degraded',
      '已禁用': 'Disabled',
      '启用': 'Enabled',
      '禁用': 'Disabled',
      '未连接': 'Disconnected',
      '连接中…': 'Connecting…',
      '实时已连接': 'Live connected',
      '重连中…': 'Reconnecting…',
      '轮询 5s': 'Polling 5s',
      '已断开': 'Disconnected',
      /* ---------- 通用按钮 / 字段 ---------- */
      '详情': 'Details',
      '关闭': 'Close',
      '确认': 'Confirm',
      '刷新': 'Refresh',
      '复制': 'Copy',
      '删除': 'Delete',
      '归档': 'Archive',
      '取消归档': 'Unarchive',
      '重试': 'Retry',
      '取消任务': 'Cancel task',
      '重新连接': 'Reconnect',
      '重新连接失败': 'Reconnect failed',
      '复制诊断信息': 'Copy diagnostics',
      '打开手机版 /m': 'Open mobile /m',
      '会话与令牌': 'Session & token',
      '存储位置': 'Storage',
      '重试': 'Retry',
      '重启会先通知所有在线设备代理自我重启，随后 Hub 自动重启；运行中的任务会自动重新排队（不占用重试次数）。':
        'All online device agents will restart first, then the Hub restarts automatically; running tasks are requeued without consuming retries.',
      '将通知所有在线设备代理自我重启，随后 Hub 自动重启；运行中的任务会自动重新排队。确定继续？':
        'All online device agents will restart, then the Hub restarts automatically; running tasks will be requeued. Continue?',
      '连接': 'Connection',
      '系统维护': 'Maintenance',
      '关于': 'About',
      '手机通知（APK）': 'Phone notifications (APK)',
      '启用常驻通知栏': 'Enable persistent notification',
      '重启整套系统': 'Restart whole system',
      '立即重启': 'Restart now',
      '等价接口：POST /api/system/restart（管理员令牌）。':
        'Equivalent API: POST /api/system/restart (admin token).',
      '任务 ID': 'Task ID',
      '设备 ID': 'Device ID',
      '创建时间': 'Created',
      '开始时间': 'Started',
      '结束时间': 'Finished',
      '耗时': 'Duration',
      '尝试次数': 'Attempts',
      '执行设备': 'Device',
      '错误': 'Error',
      '进度': 'Progress',
      '输出': 'Output',
      '事件时间线': 'Event timeline',
      '收起事件': 'Collapse events',
      '展开输出': 'Expand output',
      '收起输出': 'Collapse output',
      '任务信息': 'Task info',
      '任务详情': 'Task details',
      '任务负载': 'Task load',
      '运行状态': 'Runtime status',
      '运行时长': 'Uptime',
      '最近任务': 'Recent tasks',
      '路由结果': 'Routing result',
      '路由': 'Routing',
      '暂无路由信息。': 'No routing info.',
      '模型': 'Models',
      '技能': 'Skills',
      '网关': 'Gateways',
      '标签': 'Tags',
      '平台': 'Platform',
      '未知平台': 'Unknown platform',
      '操作系统': 'OS',
      '内存': 'Memory',
      '负载': 'Load',
      '最大并发': 'Max concurrency',
      '资源与限制': 'Resources & limits',
      '能力清单': 'Capabilities',
      '代理版本': 'Agent version',
      '服务器版本': 'Server version',
      '协议版本': 'Protocol version',
      '连接状态': 'Connection status',
      '实时通道': 'Live channel',
      '运行时长': 'Uptime',
      '注册时间': 'Registered',
      '最后心跳': 'Last heartbeat',
      '能力': 'Capabilities',
      '模型网关': 'Model gateways',
      '配置 Profile': 'Profiles',
      '自定义': 'Custom',
      '其他': 'Other',
      '在线设备': 'Online devices',
      '未知设备': 'Unknown device',
      '未配置模型网关。': 'No model gateway configured.',
      '未申报 DSH profile。': 'No DSH profile declared.',
      '未申报技能。': 'No skills declared.',
      '未申报模型，只能接收不限模型的任务。': 'No models declared; only tasks without a model requirement can be routed here.',
      '无特殊要求': 'No special requirements',
      '一切正常。': 'All good.',
      '暂无排队': 'Nothing queued',
      '暂无实时动态': 'No activity yet',
      '暂无事件记录': 'No events yet',
      '还没有任务': 'No tasks yet',
      '还没有设备接入': 'No devices yet',
      '还没有已完成的任务': 'No completed tasks yet',
      '没有进行中的任务': 'No active tasks',
      '没有失败的任务': 'No failed tasks',
      '没有已归档的任务': 'No archived tasks',
      '没有可用技能': 'No skills available',
      '在设备上启动 device-agent 并填写加入码，设备会自动出现在这里。':
        'Start device-agent on a device with the join code and it will appear here.',
      '在右侧（手机端「指令」页）输入指令并发送，任务会实时出现在这里。':
        'Send an instruction on the right (Command tab on mobile) and tasks will appear here live.',
      '任务卡片上的「归档」会把它移到这里。': 'Archived tasks from the task list appear here.',
      '设备执行完任务后会显示在这里。': 'Completed device tasks appear here.',
      '这台设备还没有执行过任务。': 'This device has not run any task yet.',
      '当前没有排队、已分配或运行中的任务。': 'No queued, assigned or running tasks.',
      '当前没有满足要求的在线设备，任务已进入队列；设备上线或能力变化后会自动重新路由。':
        'No online device matches; the task is queued and will be routed automatically when a device comes online.',
      '提示：设备恢复在线后，Hub 会自动重新路由该任务。':
        'Tip: the Hub will route the task again once a device comes back online.',
      '暂无在线设备，发送后将排队等待上线': 'No online devices; the task will queue until one comes online',
      '等待在线设备接单': 'Waiting for an online device',
      '等待设备上线': 'Waiting for devices',
      '等待连接 Hub…': 'Waiting for Hub…',
      '正在连接中枢…': 'Connecting to Hub…',
      '正在通过令牌连接中枢…': 'Connecting with token…',
      '正在恢复上次连接…': 'Restoring previous session…',
      '已连接到 BattleStar': 'Connected to BattleStar',
      '已重新连接实时通道': 'Live channel reconnected',
      '已退出并清除本机令牌': 'Signed out and cleared local token',
      '数据已刷新': 'Data refreshed',
      '诊断信息已复制': 'Diagnostics copied',
      '指令已复制': 'Instruction copied',
      '创建': 'Created',
      '生成中…': 'Generating…',
      '处理中…': 'Working…',
      '发送中…': 'Sending…',
      'DSH 等待执行…': 'DSH pending…',
      'DSH 正在修改代码…': 'DSH is editing code…',
      'DSH 已完成修改': 'DSH finished editing',
      'DSH 执行失败': 'DSH failed',
      'DSH 智能体': 'DSH agent',
      'DSH 任务状态丢失': 'DSH task state lost',
      'DSH 插件': 'DSH plugin',
      'BattleStar 控制台诊断': 'BattleStar console diagnostics',
      'BattleStar 控制台 · 零依赖静态前端，同源加载 Hub 资源。设备能力、任务路由与事件流遵循协议 v1。':
        'BattleStar console · zero-dependency static UI that loads Hub resources from the same origin. Device capabilities, routing and events follow protocol v1.',
      '手机端：底部 Tab 切换「状态 / 任务 / 指令 / 设置」，桌面端可通过右上角设置按钮打开本面板。':
        'Mobile: use the bottom tabs (Status / Tasks / Command / Settings). Desktop: open this panel from the gear button.',
      'SSE 断开时会自动重连（指数退避），期间降级为每 5 秒轮询 /api/snapshot。':
        'SSE reconnects automatically with exponential backoff and falls back to polling /api/snapshot every 5s.',
      '令牌仅保存在本机浏览器；清除后需重新输入 Hub 启动日志中的 adminToken。':
        'The token is stored in this browser only; after clearing you must re-enter the adminToken from the Hub log.',
      '将从本机 localStorage 删除管理员令牌与 Hub 地址，需要重新输入才能连接。':
        'This removes the admin token and Hub address from localStorage; you will need to enter them again.',
      '任务进行中显示进度条；没有任务时显示在线 / 待命主机数量。':
        'Shows task progress while running, or online/standby device counts when idle.',
      /* ---------- 常见确认/提示 ---------- */
      '确认操作': 'Confirm action',
      '退出并清除令牌？': 'Sign out and clear token?',
      '退出并清除令牌': 'Sign out and clear token',
      '手动标记任务为成功？': 'Mark task as successful?',
      '删除设备？': 'Delete device?',
      '删除这个任务吗？删除后不可恢复。': 'Delete this task? This cannot be undone.',
      '确定删除这个任务吗？删除后不可恢复。': 'Delete this task? This cannot be undone.',
      '删除设备': 'Delete device',
      '配置': 'Config',
      '未保存': 'Unsaved',
      '已复制': 'Copied',
      '复制失败，请手动选择文本': 'Copy failed, select the text manually',
      '读取附件失败': 'Failed to read attachment',
      '移除附件': 'Remove attachment',
      '附件总大小超过 4MB': 'Attachments exceed 4MB in total',
      '请输入管理员令牌': 'Enter the admin token',
      '请输入管理员令牌（见 Hub 启动日志）': 'Enter the admin token (see Hub startup log)',
      '请输入指令内容': 'Enter an instruction',
      '请先输入指令内容': 'Enter an instruction first',
      'Hub 地址格式不正确': 'Invalid Hub address',
      'Hub 地址需以 http:// 或 https:// 开头': 'Hub address must start with http:// or https://',
      '仅支持 http / https 地址': 'Only http/https addresses are supported',
      '连接失败，请检查 Hub 地址': 'Connection failed; check the Hub address',
      '无法连接 Hub，请检查地址与网络': 'Cannot reach Hub; check address and network',
      '请求超时，请检查 Hub 地址与网络': 'Request timed out; check Hub address and network',
      '管理员令牌无效或已过期，请重新输入': 'Admin token is invalid or expired; enter it again',
      '管理员令牌无效，请检查后重试': 'Invalid admin token; check and retry',
      '管理员令牌已失效，请重新连接': 'Admin token expired; reconnect',
      '没有权限执行该操作': 'Not allowed',
      '操作失败': 'Action failed',
      '发送失败': 'Send failed',
      '刷新失败': 'Refresh failed',
      '删除失败': 'Delete failed',
      '归档失败': 'Archive failed',
      '取消失败': 'Cancel failed',
      '重试失败': 'Retry failed',
      '设置失败': 'Update failed',
      '重置失败': 'Reset failed',
      '重启失败': 'Restart failed',
      '退出': 'Sign out',
      '未知设备': 'Unknown device',
      '设备不存在或已被移除': 'Device not found or removed',
      '任务不存在或已被清理': 'Task not found or cleaned up',
      '任务已删除': 'Task deleted',
      '任务已归档': 'Task archived',
      '任务已取消归档': 'Task unarchived',
      '任务已手动标记为完成': 'Task marked complete manually',
      '任务已重新排队并路由': 'Task requeued and routed',
      '设备已启用': 'Device enabled',
      '设备已禁用': 'Device disabled',
      '设备已删除': 'Device deleted',
      '设备信息已刷新': 'Device info refreshed',
      '已创建下一步任务': 'Next step task created',
      '已开始新会话': 'New session started',
      '取消请求已发送': 'Cancel requested',
      '回答已发送，Mika 继续执行': 'Answer sent; Mika continues',
      '回答 Mika': 'Answer Mika',
      '回答内容不能为空': 'Answer cannot be empty',
      '发送回答失败': 'Failed to send answer',
      'Mika 需要你的回答': 'Mika needs your answer',
      '机器人正在等待你回答，回答后继续执行': 'The agent is waiting for your answer to continue',
      '手动标记失败': 'Manual mark failed',
      '任务更新': 'Task updated',
      '设备更新': 'Device updated',
      '设备上线': 'Device online',
      '设备离线': 'Device offline',
      '已上线': 'Online',
      '已离线': 'Offline',
      '在线': 'Online',
      '离线': 'Offline',
      '任务完成': 'Task completed',
      '任务失败': 'Task failed',
      '重新连接': 'Reconnect',
      '正在执行': 'Running',
      '等待执行': 'Waiting to run',
      '等待设备接受…': 'Waiting for device…',
      '等待分配': 'Waiting to assign',
      '立即重启': 'Restart now',
      '批量操作': 'Bulk actions',
      '排队任务': 'Queued tasks',
      '本次累计完成': 'Completed this session',
      '可在任务列表重试': 'Retry from the task list',
      '选择技能（可多选）': 'Choose skills (multi-select)',
      '暂无可选技能': 'No skills available',
      '继续此任务': 'Continue this task',
      '复制指令': 'Copy instruction',
      '编辑重发': 'Edit & resend',
      '移除': 'Remove',
      '等待在线设备接单': 'Waiting for an online device',
      '暂无排队': 'Nothing queued',
      'Agnes 规划器': 'Agnes planner',
      '收起事件': 'Collapse events',
      '基于上一步结果，输入下一步要做什么，或直接修正要求…': 'Based on the previous result, describe the next step or adjust the requirement…',
      '描述要修改的功能、bug 或重构要求…': 'Describe the feature, bug, or refactor you want…',
      '告诉 DSH 要改什么，例如：把任务卡片的按钮改成两列，并修复移动端溢出。': 'Tell DSH what to change, e.g. make task card buttons two columns and fix mobile overflow.',
      /* ---------- 长期目标 ---------- */
      '长期目标': 'Long-term goals',
      '新建目标': 'New goal',
      '编辑目标': 'Edit goal',
      '目标': 'Goals',
      '目标详情': 'Goal details',
      '还没有长期目标': 'No long-term goals yet',
      '创建一个目标，Hub 会按计划定时自动检查进度并给出建议。':
        'Create a goal and the Hub will periodically check progress and offer suggestions.',
      '正在载入目标…': 'Loading goals…',
      '目标载入失败': 'Failed to load goals',
      '当前 Hub 暂不支持长期目标，请更新后端后再试。':
        'This Hub does not support long-term goals yet. Update the backend and retry.',
      '立即跟进': 'Check now',
      '暂停': 'Pause',
      '恢复': 'Resume',
      '停止': 'Stop',
      '编辑': 'Edit',
      '跟进中…': 'Checking…',
      '已创建跟进任务，请稍候查看建议': 'Follow-up task created; suggestions will appear shortly.',
      '已有跟进任务正在执行，请稍候': 'A follow-up task is already running; please wait.',
      '目标已创建': 'Goal created',
      '目标已保存': 'Goal saved',
      '目标已暂停': 'Goal paused',
      '目标已恢复': 'Goal resumed',
      '目标已停止': 'Goal stopped',
      '目标已删除': 'Goal deleted',
      '删除目标': 'Delete goal',
      '停止目标': 'Stop goal',
      '删除后无法恢复，已有的检查历史也会一并删除。':
        'This cannot be undone; the check history will be deleted as well.',
      '目标标题': 'Goal title',
      '目标标题不能为空': 'Goal title is required',
      '例如：三个月内学会日语 N3': 'e.g. Reach JLPT N3 in three months',
      '描述（可选）': 'Description (optional)',
      '描述目标背景与衡量标准，越详细越好': 'Describe the background and success criteria; the more specific the better.',
      '检查计划': 'Check schedule',
      '每天': 'Daily',
      '每 N 小时': 'Every N hours',
      '执行时间': 'Run time',
      '间隔小时数': 'Interval (hours)',
      '保存': 'Save',
      '上次建议': 'Last suggestion',
      '上次检查': 'Last check',
      '下次跟进': 'Next check',
      '检查成功': 'Check succeeded',
      '检查失败': 'Check failed',
      '检查中': 'Check running',
      '检查超时': 'Check timed out',
      '检查已取消': 'Check cancelled',
      '还没有检查记录，点击「立即跟进」查看建议。':
        'No checks yet. Press “Check now” to get suggestions.',
      '检查历史': 'Check history',
      '最近建议': 'Latest suggestion',
      '基础信息': 'Overview',
      '计划': 'Schedule',
      '最近更新': 'Updated',
      '停止时间': 'Stopped at',
      '目标 ID': 'Goal ID',
      '暂无检查记录': 'No checks yet',
      '点击查看执行记录': 'Open execution record',
      '未设置计划': 'No schedule',
      '即将跟进': 'due soon',
      'Hub 会按计划定时创建任务检查进度并给出建议。':
        'The Hub periodically creates tasks to check progress and suggest next steps.',
      '目标已停止，无法立即跟进': 'This goal is stopped and cannot be checked.',
      '跟进任务执行中，可稍后在执行记录中查看结果。':
        'The follow-up task is running; check the records later for the result.',
      '已暂停': 'Paused',
      '已停止': 'Stopped',
      '描述': 'Description',
      '检查结果': 'Check result',
      '按 Hub 本机时间每天执行': 'Runs daily on the Hub local time',
      '最小 1 小时': 'Minimum 1 hour',
      '目标不存在或已删除': 'This goal no longer exists.',
      '立即跟进失败': 'Failed to check the goal.',
      '保存目标失败': 'Failed to save the goal.',
      '创建目标失败': 'Failed to create the goal.',
      '未命名目标': 'Untitled goal',
    },
  };

  /** 动态文本模式（中文 → English），用于带数字的时长/时间/计数等。 */
  const PATTERNS = [
    [/^刚刚$/, 'just now'],
    [/^(\d+) 秒前$/, '$1s ago'],
    [/^(\d+) 分钟前$/, '$1m ago'],
    [/^(\d+) 小时前$/, '$1h ago'],
    [/^(\d+) 天前$/, '$1d ago'],
    [/^(\d+) 毫秒$/, '$1 ms'],
    [/^(\d+(?:\.\d+)?) 秒$/, '$1s'],
    [/^(\d+) 分 (\d+) 秒$/, '$1m $2s'],
    [/^(\d+) 分钟$/, '$1 min'],
    [/^(\d+) 小时 (\d+) 分$/, '$1h $2m'],
    [/^(\d+) 小时$/, '$1h'],
    [/^(\d+) 天 (\d+) 小时$/, '$1d $2h'],
    [/^(\d+) 月 (\d+) 日$/, '$2/$1'],
    [/^(\d+) 月 (\d+) 日 (\d{2}:\d{2})$/, '$2/$1 $3'],
    [/^(\d+) 个任务$/, '$1 task(s)'],
    [/^(\d+) 个设备$/, '$1 device(s)'],
    [/^(\d+) 台在线 · 共 (\d+) 台注册$/, '$1 online · $2 registered'],
    [/^(\d+) 台在线$/, '$1 online'],
    [/^在线 (\d+) \/ (\d+)$/, 'online $1 / $2'],
    [/^(\d+) \/ (\d+)$/, '$1 / $2'],
    [/^已通知 (\d+) 台设备，Hub 约 (\d+) 秒后重启…$/, 'Notified $1 device(s); Hub restarts in ~$2s…'],
    [/^已通知 (\d+) 台设备$/, 'Notified $1 device(s)'],
    [/^任务数 (\d+)（(.*)）$/, '$1 task(s) ($2)'],
    [/^任务已创建：(.+)$/, 'Task created: $1'],
    [/^任务已完成：(.+)$/, 'Task completed: $1'],
    [/^任务失败：(.+)$/, 'Task failed: $1'],
    [/^任务超时：(.+)$/, 'Task timed out: $1'],
    [/^并发已满（(\d+)\/(\d+)）$/, 'At capacity ($1/$2)'],
    [/^缺少 (.+)$/, 'Missing $1'],
    [/^在 (\d+) 台候选设备中选中 (.+)（(\d+) 分）$/, 'Picked $2 among $1 candidates ($3 pts)'],
    [/^无匹配设备：(.+)$/, 'No matching device: $1'],
    [/^(\d+) \/ (\d+) 台$/, '$1 / $2 devices'],
    [/^共 (\d+) 台注册$/, '$1 registered'],
    [/^已分配 (\d+) · 排队 (\d+) · 等待 (\d+)$/, '$1 assigned · $2 queued · $3 waiting'],
    [/^已分配 (\d+) · 排队 (\d+)$/, '$1 assigned · $2 queued'],
    [/^(\d+) 个任务 · 进行中 (\d+)$/, '$1 tasks · $2 active'],
    [/^最近 (\d+) 条$/, 'Last $1'],
    [/^可多选 · (\d+) 项可用$/, 'Multi-select · $1 available'],
    [/^任务线程 · (\d+) 步$/, 'Task thread · $1 step(s)'],
    [/^事件 (\d+)$/, '$1 event(s)'],
    [/^Agnes 拆分的子任务 (\d+)\/(\d+)$/, 'Agnes subtasks $1/$2'],
    [/^心跳 刚刚$/, 'Heartbeat just now'],
    [/^心跳 (\d+) 秒前$/, 'Heartbeat $1s ago'],
    [/^心跳 (\d+) 分钟前$/, 'Heartbeat $1m ago'],
    [/^心跳 (\d+) 小时前$/, 'Heartbeat $1h ago'],
    [/^心跳 (\d+) 天前$/, 'Heartbeat $1d ago'],
    [/^心跳 (.+)$/, 'Heartbeat $1'],
    [/^(.+) · 空闲$/, '$1 · Idle'],
    [/^(.+) · 忙碌$/, '$1 · Busy'],
    [/^(.+) · 降级$/, '$1 · Degraded'],
    [/^(.+) · 离线$/, '$1 · Offline'],
    [/^(.+) · 已禁用$/, '$1 · Disabled'],
    [/^每天 (\d{2}:\d{2})$/, 'Daily $1'],
    [/^每 (\d+) 小时$/, 'Every $1h'],
    [/^每 (\d+) 分钟$/, 'Every $1m'],
    [/^不到 1 分钟后$/, 'in <1m'],
    [/^(\d+) 分钟后$/, 'in $1m'],
    [/^(\d+) 小时后$/, 'in $1h'],
    [/^(\d+) 天后$/, 'in $1d'],
    [/^(\d+) 个目标$/, '$1 goal(s)'],
    [/^(\d+) 个进行中 · 共 (\d+) 个目标$/, '$1 active · $2 goal(s)'],
    [/^(\d+) 个进行中$/, '$1 active'],
    [/^删除目标「(.+)」？$/, 'Delete goal “$1”?'],
    [/^停止目标「(.+)」？$/, 'Stop goal “$1”?'],
    [/^停止后将不再自动检查「(.+)」。$/, 'Automatic checks will stop for “$1”.'],
    [/^目标已创建：(.+)$/, 'Goal created: $1'],
  ];

  const SKIP_SELECTOR =
    '[data-i18n-skip], pre, code, textarea, .activity-list, .dev-chat-log, .record-markdown, .task-instruction, .task-output, .instruction-text';

  let current = DEFAULT_LANG;
  let serverDefault = DEFAULT_LANG;
  let observer = null;
  let applying = false;
  let applyTimer = 0;
  const listeners = new Set();

  function isLang(value) {
    return LANG_IDS.includes(String(value || '').trim());
  }

  function getLanguages() {
    return LANGUAGES.map((item) => ({ ...item }));
  }

  function getLang() {
    return current;
  }

  function normalizeLang(value, fallback = DEFAULT_LANG) {
    const text = typeof value === 'string' ? value.trim() : '';
    return LANG_IDS.includes(text) ? text : fallback;
  }

  function readStoredLang() {
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      return isLang(value) ? value : '';
    } catch {
      return '';
    }
  }

  function storeLang(lang) {
    try {
      if (isLang(lang)) localStorage.setItem(STORAGE_KEY, lang);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  /** 生效语言：URL ?lang= > localStorage > 服务端默认 > zh-CN。 */
  function effectiveLang(serverLang) {
    if (isLang(serverLang)) serverDefault = String(serverLang).trim();
    try {
      const fromUrl = new URLSearchParams(window.location.search).get('lang');
      if (isLang(fromUrl)) return String(fromUrl).trim();
    } catch {
      /* ignore */
    }
    const stored = readStoredLang();
    if (stored) return stored;
    return normalizeLang(serverDefault);
  }

  function t(key, vars) {
    const table = MESSAGES[current] || MESSAGES[DEFAULT_LANG];
    const fallback = MESSAGES[DEFAULT_LANG] || {};
    let text = table[key] !== undefined ? table[key] : fallback[key] !== undefined ? fallback[key] : key;
    if (vars && typeof vars === 'object') {
      for (const [name, value] of Object.entries(vars)) {
        text = String(text).split(`{${name}}`).join(String(value));
      }
    }
    return text;
  }

  function normalizeText(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function translateLegacy(value) {
    if (current === DEFAULT_LANG) return null;
    const key = normalizeText(value);
    if (!key) return null;
    const table = PHRASES.en || {};
    if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
    for (const [re, replacement] of PATTERNS) {
      if (re.test(key)) return key.replace(re, replacement);
    }
    return null;
  }

  function isSkipped(node) {
    try {
      const element = node && node.nodeType === 3 ? node.parentElement : node;
      if (!element || typeof element.closest !== 'function') return true;
      return Boolean(element.closest(SKIP_SELECTOR));
    } catch {
      return true;
    }
  }

  function translateTextNode(node) {
    if (!node || node.nodeType !== Node.TEXT_NODE) return;
    if (isSkipped(node)) return;
    if (current === DEFAULT_LANG) {
      if (node.__i18nZh !== undefined) {
        if (node.data !== node.__i18nZh) node.data = node.__i18nZh;
        delete node.__i18nZh;
      }
      return;
    }
    const original = node.__i18nZh !== undefined ? node.__i18nZh : node.data;
    const translated = translateLegacy(original);
    if (translated === null || translated === original) {
      if (node.__i18nZh !== undefined) delete node.__i18nZh;
      return;
    }
    node.__i18nZh = original;
    if (node.data !== translated) node.data = translated;
  }

  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];

  function translateElementAttrs(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return;
    const inSkipZone =
      element.matches(SKIP_SELECTOR) ||
      (element.parentElement && element.parentElement.closest(SKIP_SELECTOR));
    // 文本框内容属于用户数据不翻译，但 placeholder/title 等提示属性是 UI 文案，仍应翻译。
    if (inSkipZone && element.tagName !== 'TEXTAREA') return;
    if (!element.__i18nAttrs) element.__i18nAttrs = {};
    for (const attr of ATTRS) {
      const value = element.getAttribute(attr);
      if (!value) continue;
      if (current === DEFAULT_LANG) {
        const original = element.__i18nAttrs[attr];
        if (original !== undefined && value !== original) element.setAttribute(attr, original);
        continue;
      }
      const original = element.__i18nAttrs[attr] !== undefined ? element.__i18nAttrs[attr] : value;
      const translated = translateLegacy(original);
      if (translated === null) continue;
      element.__i18nAttrs[attr] = original;
      if (value !== translated) element.setAttribute(attr, translated);
    }
  }

  function apply(root = document.body) {
    if (!root) return;
    if (applying) return;
    applying = true;
    const hadObserver = Boolean(observer);
    if (hadObserver) observer.disconnect();
    try {
      if (document.title) {
        if (current === DEFAULT_LANG) {
          if (document.__i18nTitle !== undefined) {
            document.title = document.__i18nTitle;
            delete document.__i18nTitle;
          }
        } else {
          const original = document.__i18nTitle !== undefined ? document.__i18nTitle : document.title;
          const translated = translateLegacy(original);
          if (translated !== null) {
            document.__i18nTitle = original;
            document.title = translated;
          }
        }
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      const textNodes = [];
      let node = walker.nextNode();
      while (node) {
        textNodes.push(node);
        node = walker.nextNode();
      }
      for (const textNode of textNodes) translateTextNode(textNode);
      const elements = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const element of elements) translateElementAttrs(element);
      if (root.nodeType === Node.ELEMENT_NODE) translateElementAttrs(root);
    } finally {
      applying = false;
      if (hadObserver) observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
  }

  function scheduleApply() {
    if (observer) observer.disconnect();
    clearTimeout(applyTimer);
    applyTimer = setTimeout(() => {
      applyTimer = 0;
      if (current === DEFAULT_LANG) {
        if (observer) observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        return;
      }
      apply(document.body);
    }, 16);
  }

  function notify() {
    for (const listener of listeners) {
      try {
        listener(current);
      } catch {
        /* ignore */
      }
    }
  }

  function setLang(lang, { persist = true } = {}) {
    const next = normalizeLang(lang);
    if (persist) storeLang(next);
    if (next === current) {
      apply(document.body);
      return current;
    }
    current = next;
    document.documentElement.lang = current;
    apply(document.body);
    notify();
    return current;
  }

  function onChange(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function init(options = {}) {
    const initial = options.initialLang ? normalizeLang(options.initialLang) : effectiveLang(options.serverLang);
    current = initial;
    document.documentElement.lang = current;
    if (typeof MutationObserver === 'function' && document.body) {
      observer = new MutationObserver(() => {
        if (current === DEFAULT_LANG) return;
        scheduleApply();
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
    apply(document.body);
    return current;
  }

  global.ButlerI18n = {
    DEFAULT_LANG,
    LANGUAGES,
    STORAGE_KEY,
    getLanguages,
    getLang,
    normalizeLang,
    effectiveLang,
    t,
    apply,
    setLang,
    onChange,
    init,
    translateLegacy,
    _phrases: PHRASES,
    _messages: MESSAGES,
  };
})(window);
