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
      'reminders.title': '提醒',
      'reminders.new': '新建提醒',
      'reminders.loading': '正在载入提醒…',
      'reminders.sub': '{active} 个启用中 · 共 {total} 个提醒',
      'reminders.subEmpty': '还没有提醒',
      'reminders.loadFailed': '提醒载入失败',
      'reminders.retry': '重试',
      'reminders.unsupported': '当前 Hub 暂不支持提醒，请更新后端后再试。',
      'reminders.emptyTitle': '还没有提醒',
      'reminders.emptyDesc': '创建一个提醒，手机会在设定的时间通知你。',
      'reminders.untitled': '未命名提醒',
      'reminders.statusDisabled': '已停用',
      'reminders.statusOverdue': '已过期',
      'reminders.statusFired': '已提醒',
      'reminders.repeatNone': '不重复',
      'reminders.repeatDaily': '每天',
      'reminders.repeatWeekly': '每周',
      'reminders.cardAria': '编辑提醒：{title}',
      'reminders.editAria': '编辑“{title}”',
      'reminders.toggleAria': '启用或停用“{title}”',
      'reminders.deleteAria': '删除“{title}”',
      'reminders.edit': '编辑',
      'reminders.enable': '启用',
      'reminders.disable': '停用',
      'reminders.delete': '删除',
      'reminders.lastFiredLabel': '上次提醒',
      'reminders.hintBrowser': '浏览器内不会弹出通知：提醒通知只在手机 APK 内由系统闹钟发出。',
      'reminders.hintApk': '提醒由手机 APK 的原生通知发出，请保持 APK 在后台运行。',
      'reminders.hintPermission': '系统通知权限未开启，提醒不会弹出；请到系统设置中允许 BattleStar 的通知权限。',
      'reminders.hintSyncFailed': '同步到手机 APK 失败：{message}',
      'reminders.notFound': '提醒不存在或已被删除',
      'reminders.fieldTitle': '标题',
      'reminders.fieldTitleHint': '必填，最多 80 个字符。',
      'reminders.fieldTitlePlaceholder': '例如：给妈妈打电话',
      'reminders.fieldTitleRequired': '提醒标题不能为空',
      'reminders.fieldTitleTooLong': '标题不能超过 80 个字符',
      'reminders.fieldNote': '备注',
      'reminders.fieldNotePlaceholder': '可选，补充说明（最多 500 字）',
      'reminders.fieldNoteTooLong': '备注不能超过 500 个字符',
      'reminders.fieldDue': '日期时间',
      'reminders.fieldDueHint': '按本机时区。',
      'reminders.fieldDueRequired': '请选择提醒时间',
      'reminders.fieldRepeat': '重复',
      'reminders.fieldNotifyStyle': '通知方式',
      'reminders.notifyGentle': '温和通知',
      'reminders.notifyAlarm': '闹钟',
      'reminders.notifyStyleHint': '仅 APK 生效：闹钟会响亮提示并震动，温和为普通通知。',
      'reminders.badgeGentle': '温和通知',
      'reminders.badgeAlarm': '闹钟',
      'reminders.fieldEnabled': '启用',
      'reminders.fieldEnabledHint': '停用后不会触发通知',
      'reminders.formHint': '保存后会同步给手机 APK；浏览器内不会弹通知。',
      'reminders.save': '保存',
      'reminders.create': '创建',
      'reminders.saved': '提醒已保存',
      'reminders.created': '提醒已创建',
      'reminders.saveFailed': '保存提醒失败',
      'reminders.deleteTitle': '删除提醒',
      'reminders.deleteMessage': '删除后无法恢复；已同步到手机的通知也会一并移除。',
      'reminders.deleteOk': '删除',
      'reminders.deleted': '提醒已删除',
      'reminders.deleteFailed': '删除提醒失败',
      'reminders.enabledToast': '提醒已启用',
      'reminders.disabledToast': '提醒已停用',
      'reminders.toggleFailed': '更新提醒失败',
      'reminders.formNewTitle': '新建提醒',
      'reminders.formEditTitle': '编辑提醒',
      'reminders.formSubNew': '设定时间后，手机会在到点时提醒你。',
      'reminders.formSubEdit': '修改提醒的时间、内容或重复方式。',
      /* ---------- 管家心路 ---------- */
      'journal.sub': '{entries} 条记录 · {days} 天',
      'journal.loading': '正在载入心路…',
      'journal.emptyTitle': '暂无记录',
      'journal.emptyDesc': '暂无记录（自主大脑或任务完成时会自动记录）。',
      'journal.unsupported': '当前 Hub 暂不支持管家心路，请更新后端后再试。',
      'journal.loadFailed': '心路载入失败',
      'journal.retry': '重试',
      'journal.generateToday': '生成今日总结',
      'journal.generating': '生成中…',
      'journal.regenerate': '重新生成',
      'journal.generate': '生成总结',
      'journal.noSummary': '尚未总结',
      'journal.summaryTitle': '每日总结',
      'journal.summaryDone': '每日总结已生成',
      'journal.summaryFailed': '总结生成失败：{message}',
      'journal.settingsSaved': '心路设置已保存',
      'journal.invalidTime': '总结时间格式应为 HH:MM',
      'journal.save': '保存',
      'journal.saving': '保存中…',
      'journal.autoRecord': '自动记录',
      'journal.summaryTime': '总结时间',
      'journal.settingsHint': '开启后自动记录思考与任务结果，并在每天设定的时间生成每日总结。',
      'journal.filterAll': '全部',
      'journal.filterThought': '思考',
      'journal.filterWork': '工作',
      'journal.filterMilestone': '里程碑',
      'journal.filterDaily': '每日总结',
      'journal.kindThought': '思考',
      'journal.kindWork': '工作',
      'journal.kindMilestone': '里程碑',
      'journal.kindDaily': '每日总结',
      'journal.dayCount': '{n} 条',
      'journal.statsThought': '思考 {n}',
      'journal.statsWork': '工作 {n}',
      'journal.statsMilestone': '里程碑 {n}',
      'journal.statsTotal': '共 {n} 条',
      'journal.statsCompleted': '完成任务 {n}',
      'journal.statsFailed': '失败任务 {n}',
      'journal.generatedAt': '生成于 {time}',
      'journal.model': '模型 {model}',
      'journal.refTask': '任务 {id}',
      'journal.refGoal': '目标 {id}',
      'journal.refDecision': '决策 {id}',
      'journal.today': '今天',
      /* ---------- 头脑风暴 ---------- */
      'brainstorm.title': '头脑风暴',
      'brainstorm.subtitle': '直接和大脑聊思路、拆目标、做取舍',
      'brainstorm.tab': '对话',
      'brainstorm.sessions': '会话',
      'brainstorm.new': '新建',
      'brainstorm.delete': '删除会话',
      'brainstorm.deleteConfirm': '删除这个会话？删除后无法恢复。',
      'brainstorm.deleted': '会话已删除',
      'brainstorm.deleteFailed': '删除会话失败',
      'brainstorm.newFailed': '新建会话失败',
      'brainstorm.noSessions': '还没有会话，直接输入问题即可开始。',
      'brainstorm.sessionTitleFallback': '新对话',
      'brainstorm.messagesCount': '{n} 条消息',
      'brainstorm.emptyTitle': '和大脑聊聊',
      'brainstorm.emptyDesc': '把正在纠结的方向、想拆解的目标或取舍丢给大脑；有用的回复可以一键转成任务。',
      'brainstorm.suggest1': '把「求职」目标拆成本周 3 个行动',
      'brainstorm.suggest2': '评估自由职业先做哪个方向',
      'brainstorm.suggest3': '指出当前计划里最可能失败的一步',
      'brainstorm.placeholder': '输入你的想法，Enter 发送，Shift+Enter 换行',
      'brainstorm.hint': 'Enter 发送 · Shift+Enter 换行',
      'brainstorm.send': '发送',
      'brainstorm.sending': '发送中…',
      'brainstorm.thinking': '大脑思考中…',
      'brainstorm.brain': '大脑',
      'brainstorm.copy': '复制',
      'brainstorm.copied': '回复已复制',
      'brainstorm.toTask': '转成任务',
      'brainstorm.toTaskCreated': '已把这条回复转成任务',
      'brainstorm.toTaskFailed': '转任务失败：{message}',
      'brainstorm.linkGoal': '关联目标',
      'brainstorm.selectGoal': '选择要关联的目标',
      'brainstorm.selectGoalHint': '转成任务的同时关联到某个长期目标（可选）。',
      'brainstorm.noGoal': '不关联目标',
      'brainstorm.noGoalHint': '只创建任务',
      'brainstorm.loading': '正在载入对话…',
      'brainstorm.loadFailed': '对话载入失败',
      'brainstorm.unsupported': '当前 Hub 暂不支持头脑风暴，请更新后端后再试。',
      'brainstorm.retry': '重试',
      'brainstorm.refresh': '刷新',
      'brainstorm.sendFailed': '发送失败',
      'brainstorm.model': '模型 {model}',
      'brainstorm.assistantError': '大脑回复失败：{message}',
      /* ---------- 自主大脑：六步思考 / 需要主人 / 自适应节律 ---------- */
      'brain.stepGoals': '目标',
      'brain.stepProgress': '进度',
      'brain.stepBetterWay': '更好的工作方式',
      'brain.stepImprovement': '需要改进',
      'brain.stepMyMove': '我来推进',
      'brain.stepOwnerAsk': '需要主人',
      'brain.assessmentTitle': '六步思考',
      'brain.assessmentEmpty': '还没有六步思考记录，点「立即思考」后生成。',
      'brain.ownerAskLabel': '需要主人',
      'brain.ownerAskTitle': '需要主人参与',
      'brain.ownerAskGoal': '关联目标 {id}',
      'brain.ownerAskAck': '知道了',
      'brain.ownerAskCleared': '已确认，提醒已清除',
      'brain.ownerAskFailed': '确认失败，请稍后重试',
      'brain.rhythm': '节律 {base} → 实际 {effective} · 空闲 {idle} 轮 · 跳过 {skipped} 轮 · 下次 {next}',
      'brain.rhythmTitle': '自适应节律',
      'brain.rhythmHint': '自适应节律在没活干时按 2 倍退避（封顶 30 分钟），有活或执行动作后回到基准间隔。',
      'brain.adaptiveLabel': '启用自适应节律',
      'brain.adaptiveHint': '关闭后始终按基准间隔思考。',
      'brain.adaptiveOn': '自适应',
      'brain.adaptiveOff': '固定间隔',
      'brain.baseInterval': '基准间隔',
      'brain.effectiveInterval': '实际间隔',
      'brain.idleStreak': '空闲 {n} 轮',
      'brain.skippedCycles': '跳过 {n} 轮',
      'brain.decisionAssessment': '六步',
      'brain.waiting': '等待安排',
      'brain.paused': '已暂停',
      /* ---------- 心智 ---------- */
      'mind.title': '心智',
      'mind.subtitle': '编辑大脑的灵魂与工作流程。',
      'mind.intro': '这段灵魂与工作流程会在大脑每一轮思考时随现场快照一起交给 Agnes 模型。',
      'mind.soulTitle': '灵魂 Soul',
      'mind.skillTitle': '工作流程 Skill',
      'mind.soulDesc': '大脑是谁：价值观、气质、语气、取舍原则，以及面对不确定、风险与失败时的态度。',
      'mind.skillDesc': '大脑怎么做事：从观察、判断主要矛盾、评估方案，到小步执行、复盘与请求主人决策的步骤化流程。',
      'mind.charCount': '{n} / {max}',
      'mind.badgeDefault': '使用默认内容',
      'mind.badgeCustom': '已自定义',
      'mind.reset': '恢复默认',
      'mind.resetAll': '全部恢复默认',
      'mind.resetAllConfirm': '灵魂与工作流程都会恢复为默认内容，当前自定义内容将丢失。',
      'mind.save': '保存心智',
      'mind.saving': '保存中…',
      'mind.dirty': '有未保存的修改',
      'mind.serverUpdated': '服务端内容已更新，继续保存会覆盖服务端内容。',
      'mind.previewTitle': '本次思考将使用的提示段（前 600 字）',
      'mind.previewEmpty': '（尚未载入心智内容）',
      'mind.loading': '正在载入心智…',
      'mind.loadFailed': '心智载入失败',
      'mind.unsupported': '当前 Hub 暂不支持心智设置，请更新后端后再试。',
      'mind.saved': '心智已更新',
      'mind.resetDone': '已恢复默认内容',
      'mind.emptySoul': '灵魂不能为空',
      'mind.emptySkill': '工作流程不能为空',
      'mind.tooLong': '{field} 超出上限（最多 {max} 字）',
      'mind.saveFailed': '保存失败：{message}',
      'mind.resetFailed': '恢复默认失败：{message}',
      'mind.updatedAt': '上次更新 {time}',
      'mind.neverUpdated': '尚未保存',
      'mind.leaveTitle': '未保存的修改',
      'mind.leaveMessage': '心智页有未保存的修改，离开将丢失这些修改。',
      'mind.leaveOk': '离开',
      'mind.leaveStay': '留在此页',
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
      'reminders.title': 'Reminders',
      'reminders.new': 'New reminder',
      'reminders.loading': 'Loading reminders…',
      'reminders.sub': '{active} enabled · {total} total',
      'reminders.subEmpty': 'No reminders yet',
      'reminders.loadFailed': 'Failed to load reminders',
      'reminders.retry': 'Retry',
      'reminders.unsupported': 'Reminders are not enabled on this Hub. Update the backend and try again.',
      'reminders.emptyTitle': 'No reminders yet',
      'reminders.emptyDesc': 'Create a reminder and your phone will notify you at the scheduled time.',
      'reminders.untitled': 'Untitled reminder',
      'reminders.statusDisabled': 'Disabled',
      'reminders.statusOverdue': 'Overdue',
      'reminders.statusFired': 'Notified',
      'reminders.repeatNone': 'No repeat',
      'reminders.repeatDaily': 'Daily',
      'reminders.repeatWeekly': 'Weekly',
      'reminders.cardAria': 'Edit reminder: {title}',
      'reminders.editAria': 'Edit “{title}”',
      'reminders.toggleAria': 'Enable or disable “{title}”',
      'reminders.deleteAria': 'Delete “{title}”',
      'reminders.edit': 'Edit',
      'reminders.enable': 'Enable',
      'reminders.disable': 'Disable',
      'reminders.delete': 'Delete',
      'reminders.lastFiredLabel': 'Last notified',
      'reminders.hintBrowser': 'Notifications do not fire in the browser: reminders are delivered by the phone APK (system alarms) only.',
      'reminders.hintApk': 'Reminders are delivered by native notifications in the phone APK; keep the APK running in the background.',
      'reminders.hintPermission': 'Notification permission is off, so reminders will not fire. Allow notifications for BattleStar in system settings.',
      'reminders.hintSyncFailed': 'Failed to sync to the phone APK: {message}',
      'reminders.notFound': 'Reminder not found or already deleted',
      'reminders.fieldTitle': 'Title',
      'reminders.fieldTitleHint': 'Required, up to 80 characters.',
      'reminders.fieldTitlePlaceholder': 'e.g. Call mom',
      'reminders.fieldTitleRequired': 'Reminder title cannot be empty',
      'reminders.fieldTitleTooLong': 'Title cannot exceed 80 characters',
      'reminders.fieldNote': 'Note',
      'reminders.fieldNotePlaceholder': 'Optional details (up to 500 characters)',
      'reminders.fieldNoteTooLong': 'Note cannot exceed 500 characters',
      'reminders.fieldDue': 'Date & time',
      'reminders.fieldDueHint': 'Local time zone.',
      'reminders.fieldDueRequired': 'Please choose a time',
      'reminders.fieldRepeat': 'Repeat',
      'reminders.fieldNotifyStyle': 'Notification style',
      'reminders.notifyGentle': 'Gentle notification',
      'reminders.notifyAlarm': 'Alarm',
      'reminders.notifyStyleHint': 'APK only: alarms ring loudly and vibrate; gentle is a normal notification.',
      'reminders.badgeGentle': 'Gentle',
      'reminders.badgeAlarm': 'Alarm',
      'reminders.fieldEnabled': 'Enabled',
      'reminders.fieldEnabledHint': 'When disabled, no notification will fire',
      'reminders.formHint': 'Saved reminders are synced to the phone APK; notifications do not fire in the browser.',
      'reminders.save': 'Save',
      'reminders.create': 'Create',
      'reminders.saved': 'Reminder saved',
      'reminders.created': 'Reminder created',
      'reminders.saveFailed': 'Failed to save reminder',
      'reminders.deleteTitle': 'Delete reminder',
      'reminders.deleteMessage': 'This cannot be undone; the synced phone notification will also be removed.',
      'reminders.deleteOk': 'Delete',
      'reminders.deleted': 'Reminder deleted',
      'reminders.deleteFailed': 'Failed to delete reminder',
      'reminders.enabledToast': 'Reminder enabled',
      'reminders.disabledToast': 'Reminder disabled',
      'reminders.toggleFailed': 'Failed to update reminder',
      'reminders.formNewTitle': 'New reminder',
      'reminders.formEditTitle': 'Edit reminder',
      'reminders.formSubNew': 'Once scheduled, your phone will remind you at the chosen time.',
      'reminders.formSubEdit': 'Change the time, content or repeat mode of this reminder.',
      /* ---------- Journal ---------- */
      'journal.sub': '{entries} entries · {days} days',
      'journal.loading': 'Loading journal…',
      'journal.emptyTitle': 'No entries yet',
      'journal.emptyDesc': 'No entries yet. Thoughts and task results are recorded automatically.',
      'journal.unsupported': 'This Hub does not support the journal yet; update the backend and try again.',
      'journal.loadFailed': 'Failed to load the journal',
      'journal.retry': 'Retry',
      'journal.generateToday': 'Summarize today',
      'journal.generating': 'Generating…',
      'journal.regenerate': 'Regenerate',
      'journal.generate': 'Generate summary',
      'journal.noSummary': 'Not summarized yet',
      'journal.summaryTitle': 'Daily summary',
      'journal.summaryDone': 'Daily summary generated',
      'journal.summaryFailed': 'Failed to generate summary: {message}',
      'journal.settingsSaved': 'Journal settings saved',
      'journal.invalidTime': 'Summary time must be HH:MM',
      'journal.save': 'Save',
      'journal.saving': 'Saving…',
      'journal.autoRecord': 'Auto-record',
      'journal.summaryTime': 'Summary time',
      'journal.settingsHint': 'When enabled, thoughts and task results are recorded and a daily summary is generated at the configured time.',
      'journal.filterAll': 'All',
      'journal.filterThought': 'Thoughts',
      'journal.filterWork': 'Work',
      'journal.filterMilestone': 'Milestones',
      'journal.filterDaily': 'Daily summaries',
      'journal.kindThought': 'Thought',
      'journal.kindWork': 'Work',
      'journal.kindMilestone': 'Milestone',
      'journal.kindDaily': 'Daily summary',
      'journal.dayCount': '{n} entries',
      'journal.statsThought': 'Thoughts {n}',
      'journal.statsWork': 'Work {n}',
      'journal.statsMilestone': 'Milestones {n}',
      'journal.statsTotal': 'Total {n}',
      'journal.statsCompleted': 'Tasks done {n}',
      'journal.statsFailed': 'Failed tasks {n}',
      'journal.generatedAt': 'Generated at {time}',
      'journal.model': 'Model {model}',
      'journal.refTask': 'Task {id}',
      'journal.refGoal': 'Goal {id}',
      'journal.refDecision': 'Decision {id}',
      'journal.today': 'Today',
      /* ---------- Brainstorm ---------- */
      'brainstorm.title': 'Brainstorm',
      'brainstorm.subtitle': 'Talk through ideas, break down goals and make trade-offs',
      'brainstorm.tab': 'Chat',
      'brainstorm.sessions': 'Sessions',
      'brainstorm.new': 'New',
      'brainstorm.delete': 'Delete session',
      'brainstorm.deleteConfirm': 'Delete this session? This cannot be undone.',
      'brainstorm.deleted': 'Session deleted',
      'brainstorm.deleteFailed': 'Failed to delete the session',
      'brainstorm.newFailed': 'Failed to create a session',
      'brainstorm.noSessions': 'No sessions yet — just type a question to start.',
      'brainstorm.sessionTitleFallback': 'New chat',
      'brainstorm.messagesCount': '{n} message(s)',
      'brainstorm.emptyTitle': 'Talk to the brain',
      'brainstorm.emptyDesc': 'Throw in a direction you are unsure about, a goal to break down or a trade-off to weigh; any useful reply can become a task in one click.',
      'brainstorm.suggest1': 'Break the "job hunt" goal into 3 actions for this week',
      'brainstorm.suggest2': 'Evaluate which freelance direction to start with',
      'brainstorm.suggest3': 'Point out the most likely failure in the current plan',
      'brainstorm.placeholder': 'Type your thoughts. Enter to send, Shift+Enter for a new line.',
      'brainstorm.hint': 'Enter to send · Shift+Enter for a new line',
      'brainstorm.send': 'Send',
      'brainstorm.sending': 'Sending…',
      'brainstorm.thinking': 'The brain is thinking…',
      'brainstorm.brain': 'Brain',
      'brainstorm.copy': 'Copy',
      'brainstorm.copied': 'Reply copied',
      'brainstorm.toTask': 'Turn into task',
      'brainstorm.toTaskCreated': 'Turned that reply into a task',
      'brainstorm.toTaskFailed': 'Failed to create the task: {message}',
      'brainstorm.linkGoal': 'Link goal',
      'brainstorm.selectGoal': 'Choose a goal to link',
      'brainstorm.selectGoalHint': 'Optionally link the new task to a long-term goal.',
      'brainstorm.noGoal': 'No goal',
      'brainstorm.noGoalHint': 'Create the task only',
      'brainstorm.loading': 'Loading the chat…',
      'brainstorm.loadFailed': 'Failed to load the chat',
      'brainstorm.unsupported': 'This Hub does not support brainstorm yet. Update the backend and retry.',
      'brainstorm.retry': 'Retry',
      'brainstorm.refresh': 'Refresh',
      'brainstorm.sendFailed': 'Failed to send',
      'brainstorm.model': 'Model {model}',
      'brainstorm.assistantError': 'The brain failed to reply: {message}',
      /* ---------- Brain: six-step thinking / owner ask / adaptive rhythm ---------- */
      'brain.stepGoals': 'Goals',
      'brain.stepProgress': 'Progress',
      'brain.stepBetterWay': 'Better way',
      'brain.stepImprovement': 'Improvement',
      'brain.stepMyMove': 'My move',
      'brain.stepOwnerAsk': 'Owner ask',
      'brain.assessmentTitle': 'Six-step thinking',
      'brain.assessmentEmpty': 'No six-step thinking yet. Press "Think now" to generate one.',
      'brain.ownerAskLabel': 'Needs owner',
      'brain.ownerAskTitle': 'Owner involvement needed',
      'brain.ownerAskGoal': 'Goal {id}',
      'brain.ownerAskAck': 'Got it',
      'brain.ownerAskCleared': 'Acknowledged, reminder cleared',
      'brain.ownerAskFailed': 'Failed to acknowledge, please retry',
      'brain.rhythm': 'Rhythm {base} → actual {effective} · idle {idle} cycle(s) · skipped {skipped} · next {next}',
      'brain.rhythmTitle': 'Adaptive rhythm',
      'brain.rhythmHint': 'Adaptive rhythm backs off 2× while idle (capped at 30 min) and returns to the base interval once there is work or an action ran.',
      'brain.adaptiveLabel': 'Enable adaptive rhythm',
      'brain.adaptiveHint': 'When off, always use the base interval.',
      'brain.adaptiveOn': 'Adaptive',
      'brain.adaptiveOff': 'Fixed interval',
      'brain.baseInterval': 'Base interval',
      'brain.effectiveInterval': 'Actual interval',
      'brain.idleStreak': 'Idle {n} cycle(s)',
      'brain.skippedCycles': 'Skipped {n}',
      'brain.decisionAssessment': 'Six steps',
      'brain.waiting': 'Waiting',
      'brain.paused': 'Paused',
      /* ---------- Mind ---------- */
      'mind.title': 'Mind',
      'mind.subtitle': 'Edit the soul and workflow of the brain.',
      'mind.intro': 'This soul and workflow are handed to the Agnes model with the live snapshot on every autonomous think.',
      'mind.soulTitle': 'Soul',
      'mind.skillTitle': 'Workflow (Skill)',
      'mind.soulDesc': 'Who the brain is: values, temperament, tone, trade-off principles, and attitude toward uncertainty, risk and failure.',
      'mind.skillDesc': 'How the brain works: observe, find the main contradiction, evaluate options, act in small steps, review, and ask the owner when needed.',
      'mind.charCount': '{n} / {max}',
      'mind.badgeDefault': 'Using defaults',
      'mind.badgeCustom': 'Customized',
      'mind.reset': 'Restore default',
      'mind.resetAll': 'Restore all defaults',
      'mind.resetAllConfirm': 'Soul and workflow will both be restored to defaults. Current custom content will be lost.',
      'mind.save': 'Save mind',
      'mind.saving': 'Saving…',
      'mind.dirty': 'Unsaved changes',
      'mind.serverUpdated': 'Server content was updated; saving will overwrite it.',
      'mind.previewTitle': 'Prompt excerpt for the next think (first 600 chars)',
      'mind.previewEmpty': '(Mind content not loaded yet)',
      'mind.loading': 'Loading mind…',
      'mind.loadFailed': 'Failed to load mind',
      'mind.unsupported': 'This Hub does not support mind settings yet. Please update the backend.',
      'mind.saved': 'Mind updated',
      'mind.resetDone': 'Restored default content',
      'mind.emptySoul': 'Soul cannot be empty',
      'mind.emptySkill': 'Workflow cannot be empty',
      'mind.tooLong': '{field} exceeds the limit (max {max} characters)',
      'mind.saveFailed': 'Save failed: {message}',
      'mind.resetFailed': 'Restore failed: {message}',
      'mind.updatedAt': 'Updated {time}',
      'mind.neverUpdated': 'Not saved yet',
      'mind.leaveTitle': 'Unsaved changes',
      'mind.leaveMessage': 'The mind page has unsaved changes. Leaving will lose them.',
      'mind.leaveOk': 'Leave',
      'mind.leaveStay': 'Stay',
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
      '已进入继续任务模式，请在下方输入下一步指令': 'Continue-task mode: type the next instruction below',
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
      '项目（可选）': 'Project (optional)',
      '项目名或绝对路径，决定 Hermes 会话归属': 'Project name or absolute path — decides Hermes session ownership',
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
      '原文': 'Raw',
      '渲染': 'Rendered',
      '事件时间线': 'Event timeline',
      '收起事件': 'Collapse events',
      '展开输出': 'Expand output',
      '收起输出': 'Collapse output',
      '展开指令': 'Expand instruction',
      '收起指令': 'Collapse instruction',
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
      '设备昵称': 'Device nickname',
      '设备昵称最多 40 个字符': 'Device nickname can be at most 40 characters',
      '昵称没有变化': 'Nickname unchanged',
      '昵称已是空': 'Nickname is already empty',
      '设备昵称已保存': 'Device nickname saved',
      '设备昵称已清除': 'Device nickname cleared',
      '昵称保存失败': 'Failed to save nickname',
      '保存昵称': 'Save nickname',
      '清除昵称': 'Clear nickname',
      '机器名': 'Machine name',
      '只保存在本机 Hub，用来标注用途': 'Stored on this Hub only, for labeling its purpose',
      '例如：书房工作站（写代码）': 'e.g. Study workstation (coding)',
      '当前 Hub 还没加载昵称功能，重启后即可保存': 'This Hub build cannot store nicknames yet. Restart it to enable the feature',
      '重启 Hub': 'Restart Hub',
      '重启 Hub 以启用设备昵称': 'Restart Hub to enable device nicknames',
      '昵称功能需要 Hub 重启后才会生效；重启期间运行中的任务会自动重新排队。确定现在重启？':
        'Device nicknames need a Hub restart to take effect. Running tasks are re-queued during the restart. Restart now?',
      'Hub 正在重启，约 15 秒后自动重连…': 'Hub is restarting; reconnecting in about 15 seconds…',
      '昵称未保存：Hub 需要重启后才能保存昵称': 'Nickname not saved: restart the Hub to enable nicknames',
      '昵称没有保存成功，请重启 Hub 后重试': 'Nickname was not saved. Restart the Hub and try again',
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
      '子任务': 'Subtasks',
      '卡点': 'Blocked',
      '等待前置步骤': 'Waiting for previous step',
      '并行执行': 'Parallel',
      '按顺序执行': 'Sequential',
      '并行 + 顺序依赖': 'Parallel + sequential',
      '任务线程': 'Task thread',
      '查看子任务': 'View subtasks',
      '查看失败任务': 'View failed tasks',
      '重试失败子任务': 'Retry failed subtasks',
      '重试失败，请稍后再试': 'Retry failed, please try again later',
      '没有可重试的失败子任务': 'No failed subtasks to retry',
      '正在重试失败子任务…': 'Retrying failed subtasks…',
      '从此步继续': 'Continue from here',
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
      /* ---------- 提醒 ---------- */
      '提醒': 'Reminders',
      '新建提醒': 'New reminder',
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
      '目标已暂停（到点自动恢复）': 'Goal paused (auto-resume)',
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
      /* ---------- 暂停止 / 跳过下一次 ---------- */
      '暂停止': 'Pause temporarily',
      '暂停止目标': 'Pause goal temporarily',
      '暂停止方式': 'Pause method',
      '修改暂停设置': 'Edit pause settings',
      '保存暂停设置': 'Save pause settings',
      '确认暂停': 'Pause',
      '跳过这次': 'Skip this time',
      '跳过下一次（保持进行中）': 'Skip next check (stay active)',
      '暂停 1 天（自动恢复）': 'Pause for 1 day (auto-resume)',
      '暂停到指定时间（自动恢复）': 'Pause until a time (auto-resume)',
      '一直暂停（手动恢复）': 'Pause indefinitely (manual resume)',
      '暂停结束时间': 'Pause end time',
      '自动恢复时间': 'Auto-resume at',
      '已暂停 · 等你手动恢复': 'Paused · resume manually',
      '到点后自动恢复，并按计划重新排下一次跟进':
        'Auto-resume at that time and reschedule the next check.',
      '暂停期间不会自动创建跟进任务；「立即跟进」仍可手动执行。':
        'No automatic follow-ups while paused; “Check now” still works manually.',
      '「暂停止」只影响自动跟进，不会删除目标。':
        '“Pause temporarily” only affects automatic checks; the goal is not deleted.',
      '已跳过下一次自动跟进': 'Skipped the next automatic check',
      '只有进行中的目标可以跳过下一次': 'Only active goals can skip the next check.',
      '跳过失败': 'Failed to skip the next check.',
      '请选择暂停结束时间': 'Choose a pause end time.',
      '暂停结束时间必须晚于当前时间': 'The pause end time must be in the future.',
      /* ---------- 指导指令 / 恢复自动跟进 ---------- */
      '恢复自动跟进': 'Resume automatic checks',
      '目标已恢复自动跟进': 'Automatic checks resumed',
      '指导指令': 'Guidance',
      '添加指令': 'Add instruction',
      '添加中…': 'Adding…',
      '请先输入指导指令': 'Enter an instruction first.',
      '指导指令不能为空': 'The instruction cannot be empty.',
      '指导指令最多 2000 字': 'The instruction can be at most 2000 characters.',
      '指导指令已添加，将在下次自动跟进时生效':
        'Instruction added. It will apply to the next automatic check.',
      '添加指导指令失败': 'Failed to add the instruction.',
      '还没有指导指令。写下新的方向后，会加入之后的自动跟进。':
        'No instructions yet. Add a direction and it will be included in later automatic checks.',
      '例如：优先处理 A 项目；输出时多给具体行动；暂缓 B 项目。':
        'e.g. Prioritize project A; give concrete next actions; hold project B.',
      '指导指令会附加到之后的每一次自动跟进。':
        'Instructions are included in every later automatic check.',
      /* ---------- 管家心路 ---------- */
      '管家心路': 'Journal',
      '思考、动作与每日实质推进': 'Thoughts, actions and daily progress',
      '生成今日总结': 'Summarize today',
      '心路': 'Journal',
      /* ---------- 头脑风暴 ---------- */
      '头脑风暴': 'Brainstorm',
      '直接和大脑聊思路、拆目标、做取舍': 'Talk through ideas, break down goals and make trade-offs',
      '对话': 'Chat',
      '会话': 'Sessions',
      '新建': 'New',
      'Enter 发送 · Shift+Enter 换行': 'Enter to send · Shift+Enter for a new line',
      '输入你的想法，Enter 发送，Shift+Enter 换行': 'Type your thoughts. Enter to send, Shift+Enter for a new line.',
      /* ---------- 自主大脑 ---------- */
      '需要主人': 'Needs owner',
      '知道了': 'Got it',
      /* ---------- 心智 ---------- */
      '心智': 'Mind',
      '灵魂与工作流程会随现场快照一起交给大脑。': 'Soul and workflow are handed to the brain with the live snapshot.',
      '这段灵魂与工作流程会在大脑每一轮思考时随现场快照一起交给 Agnes 模型。':
        'This soul and workflow are handed to the Agnes model with the live snapshot on every autonomous think.',
      '灵魂 Soul': 'Soul',
      '工作流程 Skill': 'Workflow (Skill)',
      '大脑是谁：价值观、气质、语气、取舍原则，以及面对不确定、风险与失败时的态度。':
        'Who the brain is: values, temperament, tone, trade-off principles, and attitude toward uncertainty, risk and failure.',
      '大脑怎么做事：从观察、判断主要矛盾、评估方案，到小步执行、复盘与请求主人决策的步骤化流程。':
        'How the brain works: observe, find the main contradiction, evaluate options, act in small steps, review, and ask the owner when needed.',
      '使用默认内容': 'Using defaults',
      '已自定义': 'Customized',
      '恢复默认': 'Restore default',
      '保存心智': 'Save mind',
      '全部恢复默认': 'Restore all defaults',
      '有未保存的修改': 'Unsaved changes',
      '本次思考将使用的提示段（前 600 字）': 'Prompt excerpt for the next think (first 600 chars)',
      '尚未保存': 'Not saved yet',
      '编辑大脑的灵魂与工作流程。': 'Edit the soul and workflow of the brain.',
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
    [/^已暂停至 (\d+) 月 (\d+) 日 (\d{2}:\d{2}) · 到点自动恢复$/, 'Paused until $3 $2/$1 · auto-resume'],
    [/^已暂停至 (.+) · 到点自动恢复$/, 'Paused until $1 · auto-resume'],
    [/^(\d+) 天 (\d+) 小时$/, '$1d $2h'],
    [/^(\d+) 月 (\d+) 日$/, '$2/$1'],
    [/^(\d+) 月 (\d+) 日 (\d{2}:\d{2})$/, '$2/$1 $3'],
    [/^(\d+) 个任务$/, '$1 task(s)'],
    [/^项目 (.+)$/, 'Project $1'],
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
    [/^子任务 (\d+)\/(\d+)$/, 'Subtasks $1/$2'],
    [/^(\d+) 失败$/, '$1 failed'],
    [/^(\d+) 个失败任务可重试或继续$/, '$1 failed task(s) can be retried or continued'],
    [/^已重新排队 (\d+) 个失败子任务$/, 'Requeued $1 failed subtask(s)'],
    [/^(\d+) 个后续步骤$/, '$1 follow-up step(s)'],
    [/^第 (\d+) 步$/, 'Step $1'],
    [/^依赖第 (.+) 步$/, 'depends on step(s) $1'],
    [/^等待前置子任务：(.+)$/, 'Waiting for previous step: $1'],
    [/^卡点：(.+)$/, 'Blocker: $1'],
    [/^(\d+)\/(\d+) 完成 · (\d+) 失败$/, '$1/$2 done · $3 failed'],
    [/^(\d+)\/(\d+) 完成$/, '$1/$2 done'],
    [/^心跳 刚刚$/, 'Heartbeat just now'],
    [/^心跳 (\d+) 秒前$/, 'Heartbeat $1s ago'],
    [/^心跳 (\d+) 分钟前$/, 'Heartbeat $1m ago'],
    [/^心跳 (\d+) 小时前$/, 'Heartbeat $1h ago'],
    [/^心跳 (\d+) 天前$/, 'Heartbeat $1d ago'],
    [/^心跳 (.+)$/, 'Heartbeat $1'],
    [/^机器名：(.+)$/, 'Machine name: $1'],
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
