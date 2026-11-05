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
    }
    const en = {
      panel: 'BattleStar', title: 'BattleStar', subtitle: 'Multi-device AI butler · console and keys',
      edit: 'Edit', rename: 'Rename', saveName: 'Save', cancelEdit: 'Cancel',
      hubNickname: 'Hub nickname', connection: 'Connection', outbound: 'outbound', endpoint: 'endpoint',
      deviceRenamed: 'Device renamed', hubNicknameSaved: 'Hub nickname saved', nameRequired: 'Name is required',
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
      if (status === 'running' || status === 'assigned') return 'warn'
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

    function DeviceCard({ device, t, hubOrigin, onRename }) {
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
              : h(Badge, { tone: device.online ? 'ok' : 'idle' }, device.online ? t('online') : t('offline')),
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

    function TaskRow({ task, t, onAction }) {
      const data = task.output && task.output.data ? task.output.data : null
      return h('div', { style: { ...card, padding: 12 } },
        h('div', { style: { ...row, justifyContent: 'space-between', alignItems: 'flex-start' } },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { style: { ...row, gap: 8 } },
              h(Badge, { tone: statusTone(task.status) }, task.status),
              h('strong', { style: { fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, task.instruction),
            ),
            h('div', { style: { ...muted, marginTop: 4 } },
              `${task.assignedDeviceName || '-'} · ${new Date(task.createdAt).toLocaleString()}${data && data.backend ? ` · ${data.backend}` : ''}`,
            ),
          ),
          h('div', { style: { ...row, gap: 6 } },
            task.status === 'running' || task.status === 'assigned' || task.status === 'queued'
              ? h('button', { style: btn(false), onClick: () => onAction(task.id, 'cancel') }, t('cancel'))
              : null,
            task.status === 'failed' || task.status === 'timeout' || task.status === 'cancelled'
              ? h('button', { style: btn(false), onClick: () => onAction(task.id, 'retry') }, t('retry'))
              : null,
          ),
        ),
        task.output && task.output.text
          ? h('div', {
              style: {
                marginTop: 8, padding: 10, borderRadius: 8, background: COLORS.layer2,
                border: `1px solid ${COLORS.border}`, whiteSpace: 'pre-wrap', fontSize: 12,
                maxHeight: 180, overflow: 'auto', lineHeight: 1.5,
              },
            }, task.output.text)
          : null,
        task.error ? h('div', { style: { ...muted, color: COLORS.err, marginTop: 6 } }, `${t('error')}: ${task.error}`) : null,
      )
    }

    function ConsoleTab({ status, snapshot, t, onRefresh, onHub, onTaskAction, onSend, onRenameDevice, hubOrigin, busy, message }) {
      const devices = (snapshot && snapshot.devices) || []
      const tasks = (snapshot && snapshot.tasks) || []
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
          h(Stat, { label: t('runningTasks'), value: stats.tasksRunning ?? 0 }),
          h(Stat, { label: t('queued'), value: stats.tasksQueued ?? 0 }),
          h(Stat, { label: t('completed'), value: stats.tasksCompleted ?? 0 }),
          h(Stat, { label: t('failed'), value: stats.tasksFailed ?? 0, tone: 'err' }),
        ),
        h('section', null,
          h('h3', { style: { fontSize: 14, margin: '0 0 10px' } }, `${t('devices')} (${devices.length})`),
          devices.length
            ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 12 } }, ...devices.map((d) => h(DeviceCard, { key: d.id, device: d, t, hubOrigin, onRename: onRenameDevice })))
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
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, ...tasks.map((task) => h(TaskRow, { key: task.id, task, t, onAction: onTaskAction })))
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
      const hubDisplayName = (settingsData && settingsData.settings && settingsData.settings.hubNickname) || t('title')

      useEffect(() => { setHubName(hubDisplayName) }, [hubDisplayName])

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
      const onTaskAction = (id, action) => withBusy(async () => {
        if (action === 'cancel' && !window.confirm(t('cancelConfirm'))) return
        await call(`/tasks/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: '{}' })
        await load()
      })
      const onRenameDevice = (id, name) => withBusy(async () => {
        const next = String(name || '').trim()
        if (!next) throw new Error(t('nameRequired'))
        await call(`/devices/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name: next }) })
        await load()
        setMessage(t('deviceRenamed'))
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
                  onRenameDevice, hubOrigin: status && status.hub ? status.hub.origin : '',
                })
              : h(SettingsTab, {
                  settings: settingsData && settingsData.settings, secrets: settingsData && settingsData.secrets, status, t, busy, message, onSave,
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
