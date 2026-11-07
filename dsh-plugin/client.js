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
    const API = '/super-butler/api'

    const zh = {
      panel: 'BattleStar', title: 'BattleStar', subtitle: '多设备 AI 管家 · 控制台与密钥',
      edit: '编辑', rename: '重命名', saveName: '保存', cancelEdit: '取消',
      hubNickname: '母机昵称', connection: '连接', outbound: '主动连接', endpoint: '端点',
      deviceRenamed: '设备名称已更新', hubNicknameSaved: '母机昵称已更新', nameRequired: '名称不能为空',
      removeDevice: '移除', removeDeviceConfirm: '确定从 Hub 移除此设备吗？在线设备下次心跳可能重新注册。', deviceRemoved: '设备已移除',
      disableDevice: '禁用', enableDevice: '启用', disabled: '已禁用', deviceDisabled: '设备已禁用，不再接收任务', deviceEnabled: '设备已启用',
      console: '控制台', settings: '设置', refresh: '刷新', start: '启动 Hub', stop: '停止 Hub',
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
      followUp: '继续', followUpPrompt: '输入下一步或修正要求（会带上一步上下文）：', followUpCreated: '已创建下一步任务', thread: '任务线程',
      answer: '回答 Mika', answerPrompt: 'Mika 需要你的回答：', answerSent: '回答已发送，Mika 继续执行', waitingAnswer: '等待回答',
      hubSettings: 'Hub 设置', projectRoot: '项目目录', hubPort: 'Hub 端口', autoStart: 'DSH 启动时自动启动 Hub',
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
      emptySecrets: '尚未配置任何私人密钥',
      taskId: '任务 ID', copyId: '复制 ID', copiedId: '任务 ID 已复制', copyInstruction: '复制指令',
      copiedInstruction: '指令已复制', copyFailed: '复制失败，请手动选择文本',
      detail: '详情', showDetail: '展开任务详情', hideDetail: '收起任务详情', taskInfo: '任务信息',
      statusLabel: '状态', deviceLabel: '执行设备', priorityLabel: '优先级', timeoutLabel: '超时',
      attemptsLabel: '尝试次数', createdLabel: '创建时间', startedLabel: '开始时间',
      finishedLabel: '结束时间', threadStepLabel: '线程步骤', routeReason: '路由结果', noRoute: '暂无路由信息',
      manualStatus: '手动改状态', markCompleted: '标记完成', markFailed: '标记失败', requeue: '重新排队',
      statusNotePlaceholder: '备注（可选），会写入任务事件',
      applyStatus: '应用', statusUpdated: '任务状态已更新',
      statusChangeHint: '手动改状态会直接结束任务，设备之后上报的结果会被忽略。',
      statusRouteNeedsRestart: 'Host 插件已更新，请重启 DSH 后再使用手动改状态',
      followUpHint: '继续会创建一个新任务，并自动带上当前任务的结果作为上下文。',
      activeFollowUpHint: '任务还在进行中，结束后才能继续；也可以先取消任务再继续。',
      cancelTaskTitle: '取消任务', dialogOk: '确定', dialogCancel: '取消', close: '关闭',
    }
    const en = {
      panel: 'BattleStar', title: 'BattleStar', subtitle: 'Multi-device AI butler · console and keys',
      edit: 'Edit', rename: 'Rename', saveName: 'Save', cancelEdit: 'Cancel',
      hubNickname: 'Hub nickname', connection: 'Connection', outbound: 'outbound', endpoint: 'endpoint',
      deviceRenamed: 'Device renamed', hubNicknameSaved: 'Hub nickname saved', nameRequired: 'Name is required',
      removeDevice: 'Remove', removeDeviceConfirm: 'Remove this device from the hub? An online device may re-register on its next heartbeat.', deviceRemoved: 'Device removed',
      disableDevice: 'Disable', enableDevice: 'Enable', disabled: 'Disabled', deviceDisabled: 'Device disabled; it will no longer receive tasks', deviceEnabled: 'Device enabled',
      console: 'Console', settings: 'Settings', refresh: 'Refresh', start: 'Start hub', stop: 'Stop hub',
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
      followUp: 'Continue', followUpPrompt: 'Enter the next step or correction (previous context will be included):', followUpCreated: 'Follow-up task created', thread: 'Task thread',
      answer: 'Answer Mika', answerPrompt: 'Mika needs your answer:', answerSent: 'Answer sent; Mika continues', waitingAnswer: 'Waiting for answer',
      hubSettings: 'Hub settings', projectRoot: 'Project root', hubPort: 'Hub port', autoStart: 'Start hub with DSH',
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
      emptySecrets: 'No private keys configured yet',
      taskId: 'Task ID', copyId: 'Copy ID', copiedId: 'Task ID copied', copyInstruction: 'Copy instruction',
      copiedInstruction: 'Instruction copied', copyFailed: 'Copy failed; select the text manually',
      detail: 'Details', showDetail: 'Show task details', hideDetail: 'Hide task details', taskInfo: 'Task info',
      statusLabel: 'Status', deviceLabel: 'Device', priorityLabel: 'Priority', timeoutLabel: 'Timeout',
      attemptsLabel: 'Attempts', createdLabel: 'Created', startedLabel: 'Started',
      finishedLabel: 'Finished', threadStepLabel: 'Thread step', routeReason: 'Route', noRoute: 'No route info',
      manualStatus: 'Change status manually', markCompleted: 'Mark completed', markFailed: 'Mark failed', requeue: 'Re-queue',
      statusNotePlaceholder: 'Optional note, stored in the task events',
      applyStatus: 'Apply', statusUpdated: 'Task status updated',
      statusChangeHint: 'Changing status ends the task immediately; later device reports are ignored.',
      statusRouteNeedsRestart: 'Host plugin updated; restart DSH to use manual status changes',
      followUpHint: 'Continue creates a new task with the current result as context.',
      activeFollowUpHint: 'The task is still active; it can continue after it ends. You can cancel it first.',
      cancelTaskTitle: 'Cancel task', dialogOk: 'OK', dialogCancel: 'Cancel', close: 'Close',
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

    // 与 Hub 的任务状态机保持一致：进行中 / 可重试（终态里允许重新排队的部分）。
    const ACTIVE_TASK_STATUS = ['queued', 'assigned', 'running', 'waiting']
    const RETRYABLE_TASK_STATUS = ['failed', 'timeout', 'cancelled']
    const isActiveTask = (status) => ACTIVE_TASK_STATUS.includes(status)
    const isRetryableTask = (status) => RETRYABLE_TASK_STATUS.includes(status)

    const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 11 }
    const miniBtn = (danger, disabled) => ({
      ...btn(false, disabled), padding: '2px 8px', fontSize: 11, color: danger ? COLORS.err : COLORS.text,
    })

    function fmtDateTime(iso) {
      if (!iso) return '-'
      try {
        const date = new Date(iso)
        return Number.isFinite(date.getTime()) ? date.toLocaleString() : '-'
      } catch {
        return '-'
      }
    }

    // Electron 里 window.prompt 不可用，统一用面板内弹窗代替浏览器 prompt。
    async function copyToClipboard(text) {
      const value = String(text == null ? '' : text)
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(value)
        return
      }
      const area = document.createElement('textarea')
      area.value = value
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand && document.execCommand('copy')
      document.body.removeChild(area)
      if (!ok) throw new Error('copy failed')
    }

    // Host 插件里还没有 /status 路由时（未重启 Harness）给出明确提示，而不是原始 404。
    function isMissingRouteError(err) {
      const message = err && err.message ? String(err.message) : ''
      return /未知路由|not_found|HTTP 404|接口不存在|404/.test(message)
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

    function DeviceCard({ device, t, hubOrigin, onRename, onRemove, onToggle }) {
      const caps = device.capabilities || {}
      const models = (caps.models || []).slice(0, 4)
      const skills = (caps.skills || []).slice(0, 6)
      const [editing, setEditing] = useState(false)
      const [name, setName] = useState(device.name || '')
      useEffect(() => { setName(device.name || '') }, [device.name])
      const saveName = async () => {
        const next = String(name || '').trim()
        if (!next) return
        await onRename(device.id, next)
        setEditing(false)
      }
      const connection = device.endpoint
        ? `${t('endpoint')}: ${device.endpoint}`
        : `${t('outbound')} → ${hubOrigin || '-'}`
      return h('div', { style: { ...card, minWidth: 240, flex: '1 1 300px' } },
        h('div', { style: { ...row, justifyContent: 'space-between' } },
          h('div', { style: { ...row, flex: 1, minWidth: 0 } },
            h('span', {
              style: { width: 9, height: 9, borderRadius: 999, background: device.online ? COLORS.ok : COLORS.idle, display: 'inline-block', flex: 'none' },
            }),
            editing
              ? h('input', {
                  value: name, autoFocus: true,
                  onChange: (e) => setName(e.target.value),
                  onKeyDown: (e) => { if (e.key === 'Enter') void saveName(); if (e.key === 'Escape') setEditing(false) },
                  style: { ...inputStyle, padding: '4px 8px', fontSize: 13 },
                })
              : h('strong', { style: { fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, device.name),
          ),
          h('div', { style: { ...row, gap: 6 } },
            editing
              ? h('button', { style: { ...btn(true), padding: '3px 8px', fontSize: 12 }, onClick: () => void saveName() }, t('saveName'))
              : h('button', { style: { ...btn(false), padding: '3px 8px', fontSize: 12 }, onClick: () => setEditing(true) }, t('edit')),
            editing
              ? h('button', { style: { ...btn(false), padding: '3px 8px', fontSize: 12 }, onClick: () => setEditing(false) }, t('cancelEdit'))
              : device.disabled
                ? h(Badge, { tone: 'idle' }, t('disabled'))
                : h(Badge, { tone: device.online ? 'ok' : 'idle' }, device.online ? t('online') : t('offline')),
            h('button', {
              style: { ...btn(false), padding: '3px 8px', fontSize: 12 },
              onClick: () => onToggle(device),
            }, device.disabled ? t('enableDevice') : t('disableDevice')),
            h('button', {
              style: { ...btn(false), padding: '3px 8px', fontSize: 12, color: COLORS.err },
              onClick: () => onRemove(device),
            }, t('removeDevice')),
          ),
        ),
        h('div', { style: { ...muted, marginTop: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, connection),
        h('div', { style: { ...muted, marginTop: 4 } },
          `${device.platform || '-'} · ${device.kind || '-'} · ${device.status || '-'} · ${t('load')} ${device.load && device.load.running != null ? `${device.load.running}/${device.load.max}` : '-'}`,
        ),
        h('div', { style: { ...muted, marginTop: 2 } }, `${t('lastSeen')} ${timeAgo(device.lastSeenAt, t)}`),
        h('div', { style: { ...wrap, marginTop: 10 } },
          ...models.map((m) => h('span', { key: `m-${m.id}`, style: chip() }, m.id)),
          caps.models && caps.models.length > models.length ? h('span', { style: chip() }, `+${caps.models.length - models.length}`) : null,
        ),
        h('div', { style: { ...wrap, marginTop: 6 } },
          ...skills.map((s) => h('span', { key: `s-${s.id}`, style: chip() }, s.id)),
          caps.skills && caps.skills.length > skills.length ? h('span', { style: chip() }, `+${caps.skills.length - skills.length}`) : null,
        ),
      )
    }

    function TaskDetail({ task, t, busy, onAction, onCopy }) {
      const active = isActiveTask(task.status)
      const retryable = isRetryableTask(task.status)
      const rows = [
        [t('statusLabel'), task.status],
        [t('deviceLabel'), task.assignedDeviceName || '-'],
        [t('priorityLabel'), task.priority == null ? '-' : String(task.priority)],
        [t('timeoutLabel'), task.timeoutSec == null ? '-' : `${task.timeoutSec}s`],
        [t('attemptsLabel'), `${task.attempts == null ? 0 : task.attempts}/${task.maxAttempts == null ? 1 : task.maxAttempts}`],
        [t('createdLabel'), fmtDateTime(task.createdAt)],
        [t('startedLabel'), fmtDateTime(task.startedAt)],
        [t('finishedLabel'), fmtDateTime(task.finishedAt)],
        [t('threadStepLabel'), String(task.threadStep || 1)],
      ]
      const events = (task.events || []).slice(-12)
      const routeReason = task.route && task.route.reason ? String(task.route.reason) : ''
      return h('div', {
        style: {
          marginTop: 10, padding: 10, borderRadius: 8, background: COLORS.layer2,
          border: `1px solid ${COLORS.border}`, display: 'flex', flexDirection: 'column', gap: 10,
        },
      },
        h('div', { style: { ...row, gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { ...muted, fontSize: 12 } }, `${t('taskId')}:`),
          h('code', { style: { ...mono, userSelect: 'all', wordBreak: 'break-all' } }, task.id),
          h('button', { style: miniBtn(), onClick: () => onCopy(task.id, t('copiedId')) }, t('copyId')),
          h('button', { style: miniBtn(), onClick: () => onCopy(task.instruction || '', t('copiedInstruction')) }, t('copyInstruction')),
        ),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 } },
          ...rows.map(([label, value]) => h('div', { key: label, style: { minWidth: 0 } },
            h('div', { style: { ...muted, fontSize: 11 } }, label),
            h('div', { style: { fontSize: 12, marginTop: 2, wordBreak: 'break-word' } }, value),
          )),
        ),
        h('div', { style: { ...muted, fontSize: 12, lineHeight: 1.5 } }, `${t('routeReason')}: ${routeReason || t('noRoute')}`),
        h('div', { style: { borderTop: `1px solid ${COLORS.border}`, paddingTop: 8 } },
          h('div', { style: { ...row, gap: 8, flexWrap: 'wrap', marginBottom: 6 } },
            h('span', { style: { fontSize: 12, fontWeight: 600 } }, t('manualStatus')),
            task.status !== 'completed'
              ? h('button', { style: miniBtn(false, busy), disabled: busy, onClick: () => onAction(task, 'mark-completed') }, t('markCompleted'))
              : null,
            task.status !== 'failed'
              ? h('button', { style: miniBtn(false, busy), disabled: busy, onClick: () => onAction(task, 'mark-failed') }, t('markFailed'))
              : null,
            retryable
              ? h('button', { style: miniBtn(false, busy), disabled: busy, onClick: () => onAction(task, 'retry') }, t('requeue'))
              : null,
            active
              ? h('button', { style: miniBtn(true, busy), disabled: busy, onClick: () => onAction(task, 'cancel') }, t('cancel'))
              : null,
          ),
          h('div', { style: { ...muted, fontSize: 11, lineHeight: 1.5 } }, t('statusChangeHint')),
        ),
        events.length
          ? h('div', { style: { borderTop: `1px solid ${COLORS.border}`, paddingTop: 8 } },
              h('div', { style: { ...muted, fontSize: 12, fontWeight: 600, marginBottom: 4 } }, `${t('events')} (${events.length})`),
              ...events.map((event, index) => h('div', {
                key: `${event.at || ''}-${index}`,
                style: { display: 'flex', gap: 8, padding: '3px 0', fontSize: 12, alignItems: 'baseline' },
              },
                h('span', { style: { ...muted, fontSize: 11, flex: 'none', minWidth: 116 } }, fmtDateTime(event.at)),
                h('span', { style: { flex: 'none', color: COLORS.sub, fontSize: 11 } }, String(event.type || '')),
                h('span', { style: { flex: 1, minWidth: 0, wordBreak: 'break-word', lineHeight: 1.5 } }, String(event.message || '')),
              )),
            )
          : null,
      )
    }

    function TaskRow({ task, t, tasks, expanded, busy, onAction, onToggle, onCopy }) {
      const data = task.output && task.output.data ? task.output.data : null
      const active = isActiveTask(task.status)
      const retryable = isRetryableTask(task.status)
      const childTasks = (task.childTaskIds || [])
        .map((id) => (tasks || []).find((item) => item.id === id))
        .filter(Boolean)
      const finishedChildren = childTasks.filter((child) => ['completed', 'failed', 'timeout', 'cancelled'].includes(child.status))
      const threadTasks = (tasks || [])
        .filter((item) => item.replyToTaskId && item.id !== task.id && (item.threadId || item.id) === (task.threadId || task.id))
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      return h('div', { style: { ...card, padding: 12, opacity: task.archived ? 0.65 : 1 } },
        h('div', { style: { ...row, justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 } },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', {
              role: 'button',
              tabIndex: 0,
              'aria-expanded': expanded ? 'true' : 'false',
              title: expanded ? t('hideDetail') : t('showDetail'),
              onClick: onToggle,
              onKeyDown: (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onToggle()
                }
              },
              style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, cursor: 'pointer', outline: 'none' },
            },
              h(Badge, { tone: statusTone(task.status) }, task.status === 'waiting' ? t('waitingAnswer') : task.status),
              task.archived ? h(Badge, { tone: 'idle' }, t('archived')) : null,
              h('strong', { style: { fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, task.instruction),
              h('span', { style: { ...muted, flex: 'none' } }, expanded ? '▾' : '▸'),
            ),
            h('div', { style: { ...muted, marginTop: 4, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
              h('code', { style: { ...mono, userSelect: 'all' } }, task.id),
              h('button', { style: miniBtn(), onClick: () => onCopy(task.id, t('copiedId')) }, t('copy')),
              h('span', null, `${task.assignedDeviceName || '-'} · ${fmtDateTime(task.createdAt)}${data && data.backend ? ` · ${data.backend}` : ''}${task.isPlan ? ` · ${t('plan')}` : ''}`),
            ),
          ),
          h('div', { style: { ...row, gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end', flex: 'none' } },
            h('button', { style: { ...btn(false, busy), padding: '3px 8px', fontSize: 12 }, disabled: busy, onClick: () => onAction(task, 'follow-up') }, t('followUp')),
            task.status === 'waiting'
              ? h('button', { style: { ...btn(true, busy), padding: '3px 8px', fontSize: 12 }, disabled: busy, onClick: () => onAction(task, 'answer') }, t('answer'))
              : null,
            active
              ? h('button', { style: { ...btn(false, busy), padding: '3px 8px', fontSize: 12 }, disabled: busy, onClick: () => onAction(task, 'cancel') }, t('cancel'))
              : null,
            retryable
              ? h('button', { style: { ...btn(false, busy), padding: '3px 8px', fontSize: 12 }, disabled: busy, onClick: () => onAction(task, 'retry') }, t('retry'))
              : null,
            h('button', {
              style: { ...btn(false, busy), padding: '3px 8px', fontSize: 12 },
              disabled: busy,
              onClick: () => onAction(task, task.archived ? 'unarchive' : 'archive'),
            }, task.archived ? t('unarchive') : t('archive')),
            h('button', {
              style: { ...btn(false, busy), padding: '3px 8px', fontSize: 12, color: COLORS.err },
              disabled: busy,
              onClick: () => onAction(task, 'delete'),
            }, t('delete')),
            h('button', { style: { ...btn(false, busy), padding: '3px 8px', fontSize: 12 }, disabled: busy, onClick: onToggle }, expanded ? t('hideDetail') : t('detail')),
          ),
        ),
        expanded ? h(TaskDetail, { task, t, busy, onAction, onCopy }) : null,
        childTasks.length
          ? h('div', { style: { marginTop: 8, padding: 8, borderRadius: 8, background: COLORS.layer2, border: `1px solid ${COLORS.border}` } },
              h('div', { style: { ...muted, marginBottom: 5 } }, `${t('subtasks')} ${finishedChildren.length}/${childTasks.length}`),
              ...childTasks.map((child) => h('div', {
                key: child.id,
                style: { ...row, gap: 8, padding: '5px 0', borderTop: `1px solid ${COLORS.border}` },
              },
                h(Badge, { tone: statusTone(child.status) }, child.status),
                h('span', { style: { fontSize: 12, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, child.instruction),
                h('span', { style: { ...muted, fontSize: 11 } }, child.assignedDeviceName || ''),
              )),
            )
          : null,
        threadTasks.length
          ? h('div', { style: { marginTop: 8, padding: 8, borderRadius: 8, background: 'rgba(124,140,255,0.06)', border: '1px dashed rgba(148,163,255,0.25)' } },
              h('div', { style: { ...muted, marginBottom: 5 } }, `${t('thread')} · ${threadTasks.length + 1} 步`),
              ...threadTasks.map((child) => h('div', {
                key: child.id,
                style: { ...row, gap: 8, padding: '5px 0', borderTop: `1px solid ${COLORS.border}` },
              },
                h(Badge, { tone: statusTone(child.status) }, child.status),
                h('span', { style: { fontSize: 12, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, child.instruction),
                h('span', { style: { ...muted, fontSize: 11 } }, child.assignedDeviceName || ''),
              )),
            )
          : null,
        task.output && task.output.text
          ? h('div', {
              style: {
                marginTop: 8, padding: 10, borderRadius: 8, background: COLORS.layer2,
                border: `1px solid ${COLORS.border}`, whiteSpace: 'pre-wrap', fontSize: 12,
                maxHeight: 180, overflow: 'auto', lineHeight: 1.5,
              },
            }, task.output.text)
          : null,
        task.status === 'waiting' && task.progress && task.progress.question
          ? h('div', {
              style: {
                marginTop: 8, padding: 9, borderRadius: 8, background: 'rgba(255,191,90,0.08)',
                border: '1px solid rgba(255,191,90,0.28)', color: '#ffe2ad', whiteSpace: 'pre-wrap',
                fontSize: 12, lineHeight: 1.5,
              },
            }, `${t('answerPrompt')}\n${task.progress.question}`)
          : null,
        task.error ? h('div', { style: { ...muted, color: COLORS.err, marginTop: 6 } }, `${t('error')}: ${task.error}`) : null,
      )
    }

    function ConsoleTab({ status, snapshot, t, onRefresh, onHub, onTaskAction, onSend, onRenameDevice, onRemoveDevice, onToggleDevice, onToggleTask, onCopyText, expandedTasks, hubOrigin, busy, message }) {
      const devices = (snapshot && snapshot.devices) || []
      const allTasks = (snapshot && snapshot.tasks) || []
      const tasks = allTasks.filter((task) => !task.parentTaskId && !task.replyToTaskId)
      const stats = (snapshot && snapshot.stats) || {}
      const [instruction, setInstruction] = useState('')
      const [profile, setProfile] = useState('')
      const [model, setModel] = useState('')
      const [skills, setSkills] = useState('')
      const [deviceId, setDeviceId] = useState('')
      const profiles = useMemo(() => {
        const set = new Set(['hermes', 'opencode', 'cli-shell'])
        for (const d of devices) for (const p of (d.capabilities && d.capabilities.profiles) || []) set.add(p.id)
        return Array.from(set)
      }, [devices])
      const models = useMemo(() => {
        const set = new Set()
        for (const d of devices) for (const m of (d.capabilities && d.capabilities.models) || []) if (m.available !== false) set.add(m.id)
        return Array.from(set)
      }, [devices])
      const submit = async () => {
        if (!instruction.trim()) return
        const requirements = {}
        if (profile) requirements.profile = profile
        if (model) requirements.model = model
        if (deviceId) requirements.deviceId = deviceId
        const skillList = skills.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean)
        if (skillList.length) requirements.skills = skillList
        await onSend({ instruction: instruction.trim(), requirements, priority: 5, timeoutSec: 600 })
        setInstruction('')
      }
      const hub = status && status.hub ? status.hub : {}
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
        h('div', { style: { ...card, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 } },
          h('div', { style: { ...row } },
            h(Badge, { tone: hub.running ? 'ok' : 'err' }, hub.running ? t('running') : t('stopped')),
            h('span', { style: muted }, `${hub.origin || ''}${hub.owned ? ` · ${t('owned')}` : hub.running ? ` · ${t('external')}` : ''}`),
            hub.joinCode ? h('span', { style: { ...muted, marginLeft: 8 } }, `${t('joinCode')}: ${hub.joinCode}`) : null,
          ),
          h('div', { style: { ...row, gap: 8 } },
            h('button', { style: btn(false, busy), onClick: onRefresh }, t('refresh')),
            hub.running
              ? h('button', { style: btn(false, busy || !hub.owned), onClick: () => onHub('stop'), disabled: busy || !hub.owned }, t('stop'))
              : h('button', { style: btn(true, busy), onClick: () => onHub('start'), disabled: busy }, t('start')),
          ),
        ),
        message ? h('div', { style: { ...muted, color: COLORS.sub } }, message) : null,
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
            ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 12 } }, ...devices.map((d) => h(DeviceCard, { key: d.id, device: d, t, hubOrigin, onRename: onRenameDevice, onRemove: onRemoveDevice, onToggle: onToggleDevice })))
            : h('div', { style: { ...card, ...muted } }, t('noDevices')),
        ),
        h('section', { style: card },
          h('h3', { style: { fontSize: 14, margin: '0 0 10px' } }, t('command')),
          h('textarea', {
            value: instruction, onChange: (e) => setInstruction(e.target.value), rows: 3,
            placeholder: t('instructionPlaceholder'),
            style: { ...inputStyle, resize: 'vertical', minHeight: 70 },
          }),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginTop: 10 } },
            h(Field, { label: t('profile') }, h('select', { value: profile, onChange: (e) => setProfile(e.target.value), style: inputStyle },
              h('option', { value: '' }, t('profileAuto')),
              ...profiles.map((p) => h('option', { key: p, value: p }, p)),
            )),
            h(Field, { label: t('model') }, h('select', { value: model, onChange: (e) => setModel(e.target.value), style: inputStyle },
              h('option', { value: '' }, '-'),
              ...models.map((m) => h('option', { key: m, value: m }, m)),
            )),
            h(Field, { label: t('device') }, h('select', { value: deviceId, onChange: (e) => setDeviceId(e.target.value), style: inputStyle },
              h('option', { value: '' }, t('profileAuto')),
              ...devices.filter((d) => d.online).map((d) => h('option', { key: d.id, value: d.id }, d.name)),
            )),
            h(Field, { label: t('skills') }, h('input', { value: skills, onChange: (e) => setSkills(e.target.value), style: inputStyle, placeholder: 'office-docx, cli-exec' })),
          ),
          h('div', { style: { ...row, justifyContent: 'flex-end', marginTop: 6 } },
            h('button', { style: btn(true, busy || !instruction.trim()), disabled: busy || !instruction.trim(), onClick: submit }, busy ? t('sending') : t('send')),
          ),
        ),
        h('section', null,
          h('h3', { style: { fontSize: 14, margin: '0 0 10px' } }, `${t('tasks')} (${tasks.length})`),
          tasks.length
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, ...tasks.map((task) => h(TaskRow, {
                key: task.id,
                task,
                t,
                tasks: allTasks,
                expanded: Boolean(expandedTasks && expandedTasks[task.id]),
                busy,
                onAction: onTaskAction,
                onToggle: () => onToggleTask(task.id),
                onCopy: onCopyText,
              })))
            : h('div', { style: { ...card, ...muted } }, t('noTasks')),
        ),
      )
    }

    function Stat({ label, value, tone }) {
      return h('div', { style: { ...card, padding: 14 } },
        h('div', { style: { ...muted, fontSize: 12 } }, label),
        h('div', { style: { fontSize: 24, fontWeight: 650, marginTop: 4, color: tone === 'err' ? COLORS.err : COLORS.text } }, String(value)),
      )
    }

    function SettingsTab({ settings, secrets, status, t, onSave, busy, message }) {
      const s = settings || {}
      const hub = status && status.hub ? status.hub : {}
      const [form, setForm] = useState({
        projectRoot: s.projectRoot || '', hubPort: s.hubPort || 7317, autoStart: s.autoStart !== false,
        githubUser: s.githubUser || '', defaultModel: s.defaultModel || 'deepseek-chat',
        hubNickname: s.hubNickname || '',
      })
      const [keys, setKeys] = useState({ githubToken: '', deepseekApiKey: '', agnesApiKey: '', doubaoApiKey: '', opencodeApiKey: '' })
      const [tests, setTests] = useState({})
      const [localMsg, setLocalMsg] = useState('')
      useEffect(() => {
        setForm({
          projectRoot: s.projectRoot || '', hubPort: s.hubPort || 7317, autoStart: s.autoStart !== false,
          githubUser: s.githubUser || '', defaultModel: s.defaultModel || 'deepseek-chat',
          hubNickname: s.hubNickname || '',
        })
      }, [s.projectRoot, s.hubPort, s.autoStart, s.githubUser, s.defaultModel, s.hubNickname])
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
      const secretMap = Object.fromEntries((secrets || []).map((x) => [x.key, x]))
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
        h('section', { style: card },
          h('h3', { style: { fontSize: 14, margin: '0 0 12px' } }, t('hubSettings')),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 } },
            h(Field, { label: t('projectRoot') }, h('input', { value: form.projectRoot, onChange: (e) => set('projectRoot', e.target.value), style: inputStyle })),
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
          ...keyFields.map(([key, labelKey]) => {
            const info = secretMap[key] || {}
            const tested = tests[key]
            return h('div', { key, style: { marginBottom: 12 } },
              h('div', { style: { ...row, justifyContent: 'space-between', marginBottom: 4 } },
                h('span', { style: { fontSize: 13, fontWeight: 500 } }, t(labelKey)),
                h('span', { style: { ...row, gap: 6 } },
                  h(Badge, { tone: info.configured ? 'ok' : 'idle' }, info.configured ? t('configured') : t('notConfigured')),
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
        h('div', { style: { ...row, justifyContent: 'flex-end' } },
          h('button', { style: btn(true, busy), disabled: busy, onClick: save }, busy ? t('saving') : t('save')),
        ),
        (message || localMsg) ? h('div', { style: { ...muted, textAlign: 'right' } }, message || localMsg) : null,
        h('div', { style: { ...muted } }, t('adminTokenHidden')),
      )
    }

    // 面板内弹窗：Electron 不支持 window.prompt，继续/回答/手动改状态都走这里。
    function Dialog({ modal, busy, t, onChange, onCancel, onConfirm }) {
      if (!modal) return null
      const dangerStyle = modal.danger
        ? { borderColor: COLORS.err, background: COLORS.err, color: '#ffffff' }
        : {}
      return h('div', {
        style: {
          position: 'fixed', inset: 0, zIndex: 1000, padding: 20,
          background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        },
        onMouseDown: (event) => { if (event.target === event.currentTarget) onCancel() },
      },
        h('div', {
          role: 'dialog', 'aria-modal': 'true', 'aria-label': modal.title,
          style: {
            width: '100%', maxWidth: 480, background: COLORS.layer, color: COLORS.text,
            border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 18,
            boxShadow: '0 18px 48px rgba(0,0,0,0.35)', boxSizing: 'border-box',
          },
        },
          h('div', { style: { ...row, justifyContent: 'space-between', gap: 10 } },
            h('h3', { style: { margin: 0, fontSize: 15 } }, modal.title),
            h('button', { style: { ...btn(false), padding: '2px 8px', fontSize: 12 }, onClick: onCancel }, '×'),
          ),
          modal.message ? h('div', { style: { ...muted, marginTop: 8, lineHeight: 1.6, whiteSpace: 'pre-wrap' } }, modal.message) : null,
          modal.input
            ? (modal.input.multiline
                ? h('textarea', {
                    autoFocus: true, rows: modal.input.rows || 3, value: modal.value || '',
                    placeholder: modal.input.placeholder || '', onChange: (event) => onChange(event.target.value),
                    style: { ...inputStyle, marginTop: 10, resize: 'vertical', minHeight: 72 },
                  })
                : h('input', {
                    autoFocus: true, value: modal.value || '', placeholder: modal.input.placeholder || '',
                    onChange: (event) => onChange(event.target.value),
                    style: { ...inputStyle, marginTop: 10 },
                  }))
            : null,
          h('div', { style: { ...row, justifyContent: 'flex-end', gap: 8, marginTop: 14 } },
            h('button', { style: btn(false, busy), disabled: busy, onClick: onCancel }, t('dialogCancel')),
            h('button', {
              style: { ...btn(true, busy), ...dangerStyle },
              disabled: busy,
              onClick: () => void onConfirm(),
            }, busy ? t('saving') : (modal.confirmLabel || t('dialogOk'))),
          ),
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
      const [error, setError] = useState('')
      const [editingHub, setEditingHub] = useState(false)
      const [hubName, setHubName] = useState('')
      const [expandedTasks, setExpandedTasks] = useState({})
      const [modal, setModal] = useState(null)
      const hubDisplayName = (settingsData && settingsData.settings && settingsData.settings.hubNickname) || t('title')

      useEffect(() => { setHubName(hubDisplayName) }, [hubDisplayName])

      useEffect(() => {
        if (!modal) return undefined
        const onKeyDown = (event) => { if (event.key === 'Escape') setModal(null) }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [modal])

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

      const withBusy = async (fn) => {
        setBusy(true)
        setMessage('')
        try {
          await fn()
        } catch (err) {
          setMessage(err.message || t('taskFailed'))
        } finally {
          setBusy(false)
        }
      }

      const onHub = (action) => withBusy(async () => {
        await call(`/hub/${action}`, { method: 'POST', body: '{}' })
        await load()
        setMessage(action === 'start' ? t('running') : t('stopped'))
      })
      const onSend = (task) => withBusy(async () => {
        const res = await call('/tasks', { method: 'POST', body: JSON.stringify(task) })
        await load()
        const info = res && res.task && res.task.route ? res.task.route.reason : ''
        setMessage(`${t('sent')}${info ? ` · ${info}` : ''}`)
      })
      const taskApi = (id, suffix) => `/tasks/${encodeURIComponent(id)}${suffix || ''}`
      const postTaskAction = (id, suffix, body) => call(taskApi(id, suffix), {
        method: 'POST',
        body: JSON.stringify(body || {}),
      })
      const toggleTask = (id) => setExpandedTasks((prev) => ({ ...prev, [id]: !prev[id] }))
      const onCopyText = async (text, okMessage) => {
        try {
          await copyToClipboard(text)
          setMessage(okMessage || t('copied'))
        } catch {
          setMessage(t('copyFailed'))
        }
      }
      const openDialog = (options) => setModal({ value: '', ...options })
      const confirmModal = async () => {
        const current = modal
        if (!current) return
        const value = String(current.value || '').trim()
        if (current.input && current.input.required && !value) return
        setModal(null)
        if (typeof current.onConfirm === 'function') await current.onConfirm(value)
      }
      const runTaskAction = (fn) => withBusy(fn)
      const onTaskAction = (task, action) => {
        if (!task) return
        const id = task.id
        const active = isActiveTask(task.status)
        if (action === 'cancel') {
          openDialog({
            title: t('cancelTaskTitle'), message: t('cancelConfirm'), confirmLabel: t('cancel'), danger: true,
            onConfirm: () => runTaskAction(async () => { await postTaskAction(id, '/cancel'); await load() }),
          })
          return
        }
        if (action === 'delete') {
          openDialog({
            title: t('delete'), message: t('deleteConfirm'), confirmLabel: t('delete'), danger: true,
            onConfirm: () => runTaskAction(async () => { await call(taskApi(id), { method: 'DELETE' }); await load() }),
          })
          return
        }
        if (action === 'archive' || action === 'unarchive') {
          openDialog({
            title: action === 'archive' ? t('archive') : t('unarchive'),
            message: `${t('taskId')}: ${task.id}`,
            confirmLabel: action === 'archive' ? t('archive') : t('unarchive'),
            onConfirm: () => runTaskAction(async () => { await postTaskAction(id, `/${action}`); await load() }),
          })
          return
        }
        if (action === 'retry') {
          runTaskAction(async () => { await postTaskAction(id, '/retry'); await load() })
          return
        }
        if (action === 'follow-up') {
          if (active) {
            openDialog({
              title: t('followUp'), message: t('activeFollowUpHint'), confirmLabel: t('cancelTaskTitle'), danger: true,
              onConfirm: () => runTaskAction(async () => { await postTaskAction(id, '/cancel'); await load() }),
            })
            return
          }
          openDialog({
            title: t('followUp'), message: t('followUpHint'),
            input: { multiline: true, rows: 4, placeholder: t('followUpPrompt'), required: true },
            confirmLabel: t('followUp'),
            onConfirm: (value) => runTaskAction(async () => {
              await postTaskAction(id, '/follow-up', { instruction: value })
              await load()
              setMessage(t('followUpCreated'))
            }),
          })
          return
        }
        if (action === 'answer') {
          openDialog({
            title: t('answer'), message: t('answerPrompt'),
            input: { multiline: true, rows: 3, placeholder: t('answerPrompt'), required: true },
            confirmLabel: t('answer'),
            onConfirm: (value) => runTaskAction(async () => {
              await postTaskAction(id, '/answer', { text: value })
              await load()
              setMessage(t('answerSent'))
            }),
          })
          return
        }
        if (action === 'mark-completed' || action === 'mark-failed') {
          const targetStatus = action === 'mark-completed' ? 'completed' : 'failed'
          openDialog({
            title: action === 'mark-completed' ? t('markCompleted') : t('markFailed'),
            message: t('statusChangeHint'),
            input: { multiline: true, rows: 3, placeholder: t('statusNotePlaceholder') },
            confirmLabel: t('applyStatus'),
            onConfirm: (value) => runTaskAction(async () => {
              try {
                await postTaskAction(id, '/status', { status: targetStatus, note: value })
              } catch (err) {
                if (isMissingRouteError(err)) throw new Error(t('statusRouteNeedsRestart'))
                throw err
              }
              await load()
              setMessage(t('statusUpdated'))
            }),
          })
        }
      }
      const onRenameDevice = (id, name) => withBusy(async () => {
        const next = String(name || '').trim()
        if (!next) throw new Error(t('nameRequired'))
        await call(`/devices/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name: next }) })
        await load()
        setMessage(t('deviceRenamed'))
      })
      const onRemoveDevice = (device) => withBusy(async () => {
        if (!window.confirm(t('removeDeviceConfirm'))) return
        await call(`/devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' })
        await load()
        setMessage(t('deviceRemoved'))
      })
      const onToggleDevice = (device) => withBusy(async () => {
        const res = await call(`/devices/${encodeURIComponent(device.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ disabled: !device.disabled }),
        })
        await load()
        setMessage(res && res.device && res.device.disabled ? t('deviceDisabled') : t('deviceEnabled'))
      })
      const onSave = async (payload) => {
        setBusy(true)
        try {
          const res = await call('/settings', { method: 'POST', body: JSON.stringify(payload) })
          await load()
          setMessage(t('saved'))
          return res
        } catch (err) {
          setMessage(err.message || t('settingsFailed'))
          return null
        } finally {
          setBusy(false)
        }
      }
      const saveHubName = async () => {
        const next = String(hubName || '').trim()
        if (!next) return
        const res = await onSave({ settings: { hubNickname: next } })
        if (res) { setEditingHub(false); setMessage(t('hubNicknameSaved')) }
      }

      const header = h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' } },
        h('div', { style: { ...row, gap: 12 } },
          h('div', { style: { width: 42, height: 42, borderRadius: 12, background: COLORS.layer2, border: `1px solid ${COLORS.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center' } },
            h(ButlerIcon, { size: 24 }),
          ),
          h('div', null,
            h('div', { style: { ...row, gap: 8 } },
              editingHub
                ? h('input', {
                    value: hubName, autoFocus: true,
                    onChange: (e) => setHubName(e.target.value),
                    onKeyDown: (e) => { if (e.key === 'Enter') void saveHubName(); if (e.key === 'Escape') setEditingHub(false) },
                    style: { ...inputStyle, width: 220, padding: '4px 8px', fontSize: 18 },
                  })
                : h('h1', { style: { fontSize: 20, margin: 0 } }, hubDisplayName),
              editingHub
                ? h('button', { style: { ...btn(true), padding: '3px 8px', fontSize: 12 }, onClick: () => void saveHubName() }, t('saveName'))
                : h('button', { style: { ...btn(false), padding: '3px 8px', fontSize: 12 }, onClick: () => setEditingHub(true) }, t('edit')),
              editingHub ? h('button', { style: { ...btn(false), padding: '3px 8px', fontSize: 12 }, onClick: () => setEditingHub(false) }, t('cancelEdit')) : null,
            ),
            h('div', { style: { ...muted } }, t('subtitle')),
          ),
        ),
        h('div', { style: { ...row, gap: 8 } },
          h('button', { style: btn(false), onClick: () => void load() }, t('refresh')),
          h(Badge, { tone: status && status.hub && status.hub.running ? 'ok' : 'err' },
            status && status.hub && status.hub.running ? t('running') : t('stopped')),
        ),
      )

      const tabs = h('div', { style: { display: 'flex', gap: 6, marginTop: 16, borderBottom: `1px solid ${COLORS.border}`, paddingBottom: 8 } },
        ['console', 'settings'].map((key) => h('button', {
          key, onClick: () => setTab(key), style: {
            ...btn(tab === key), fontWeight: 600,
          },
        }, t(key))),
      )

      return h('div', { style: { height: '100%', overflow: 'auto', boxSizing: 'border-box', padding: '22px 26px', background: COLORS.bg, color: COLORS.text, font: 'inherit' } },
        h('div', { style: { maxWidth: 1080, margin: '0 auto' } },
          header,
          tabs,
          error ? h('div', { style: { ...card, marginTop: 16, borderColor: COLORS.err, color: COLORS.err } }, `${t('loadFailed')}: ${error}`) : null,
          h('div', { style: { marginTop: 16 } },
            tab === 'console'
              ? h(ConsoleTab, {
                  status, snapshot, t, busy, message,
                  onRefresh: () => void load(), onHub, onTaskAction, onSend,
                  onRenameDevice, onRemoveDevice, onToggleDevice,
                  onToggleTask: toggleTask, onCopyText, expandedTasks,
                  hubOrigin: status && status.hub ? status.hub.origin : '',
                })
              : h(SettingsTab, {
                  settings: settingsData && settingsData.settings, secrets: settingsData && settingsData.secrets, status, t, busy, message, onSave,
                }),
          ),
        ),
        h(Dialog, {
          modal,
          busy,
          t,
          onChange: (value) => setModal((prev) => (prev ? { ...prev, value } : prev)),
          onCancel: () => setModal(null),
          onConfirm: () => void confirmModal(),
        }),
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
