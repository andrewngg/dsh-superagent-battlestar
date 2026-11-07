import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientFile = path.join(here, '..', 'client.js')
const source = fs.readFileSync(clientFile, 'utf8')

// 测试内把内部组件暴露出来，做一次无 DOM 的渲染冒烟测试。
const annotated = source.replace(
  '    return {\n      inject:',
  '    globalThis.__dshClientInternals = { TaskRow, TaskDetail, Dialog, ConsoleTab, Panel }\n    return {\n      inject:',
)

function flatten(children, out = []) {
  for (const child of children) {
    if (Array.isArray(child)) flatten(child, out)
    else if (child === null || child === undefined || child === true || child === false) continue
    else out.push(child)
  }
  return out
}

function createMiniReact() {
  const effects = []
  const React = {
    createElement(type, props, ...children) {
      const next = { ...(props || {}) }
      const list = flatten(children)
      if (list.length === 1) next.children = list[0]
      else if (list.length > 1) next.children = list
      return { type, props: next }
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect(fn) {
      effects.push(fn)
    },
    useCallback(fn) {
      return fn
    },
    useMemo(fn) {
      return fn()
    },
  }

  function renderNode(node) {
    if (node === null || node === undefined || node === true || node === false) return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(renderNode).join('')
    if (typeof node.type === 'function') return renderNode(node.type({ ...node.props }))
    const children = node.props.children
    return Array.isArray(children) ? children.map(renderNode).join('') : renderNode(children)
  }

  return { React, effects, render: renderNode }
}

function loadInternals() {
  const { React, render } = createMiniReact()
  let manifest = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (value) => { manifest = value } } },
    console,
  }
  vm.runInNewContext(annotated, sandbox, { filename: clientFile })
  assert.ok(manifest, 'client.js must call window.__ModuleLoader__.load')
  const plugin = manifest.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })
  const internals = sandbox.__dshClientInternals
  assert.ok(internals, 'test annotation must expose the client components')
  return { React, render, plugin, internals }
}

const t = (key) => String(key)
const noop = () => {}
const now = new Date().toISOString()

function makeTask(overrides = {}) {
  return {
    id: 'task_abc123',
    instruction: '运行测试并只回答结果',
    requirements: { skills: ['cli-exec'], tags: [] },
    priority: 5,
    status: 'running',
    assignedDeviceId: 'dev_1',
    assignedDeviceName: 'Mac mini',
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: null,
    attempts: 1,
    maxAttempts: 2,
    timeoutSec: 600,
    output: { text: 'partial output', data: { backend: 'hermes' } },
    error: null,
    progress: { question: '需要我继续吗？', percent: 42 },
    parentTaskId: null,
    childTaskIds: ['task_child1'],
    threadId: 'task_abc123',
    replyToTaskId: null,
    threadStep: 1,
    context: null,
    attachments: [],
    isPlan: false,
    archived: false,
    archivedAt: null,
    route: { reason: '最佳匹配', candidates: [], excluded: [] },
    events: [
      { at: now, type: 'created', message: '任务已创建' },
      { at: now, type: 'progress', message: '进度 42%' },
    ],
    ...overrides,
  }
}

const task = makeTask()
const childTask = makeTask({ id: 'task_child1', status: 'completed', instruction: '子任务' })
const threadTask = makeTask({ id: 'task_thread1', replyToTaskId: 'task_abc123', threadStep: 2 })

test('TaskRow renders the task id in both collapsed and expanded states', () => {
  const { React, render, internals } = loadInternals()
  const props = {
    t,
    tasks: [task, childTask, threadTask],
    busy: false,
    onAction: noop,
    onToggle: noop,
    onCopy: noop,
  }

  const collapsed = render(React.createElement(internals.TaskRow, { ...props, task, expanded: false }))
  assert.match(collapsed, /task_abc123/, 'collapsed task row must show the task id')
  assert.match(collapsed, /copy/, 'collapsed task row must offer a copy action')
  assert.doesNotMatch(collapsed, /manualStatus/, 'detail actions stay hidden while collapsed')

  const expanded = render(React.createElement(internals.TaskRow, { ...props, task, expanded: true }))
  assert.match(expanded, /manualStatus/)
  assert.match(expanded, /markCompleted/)
  assert.match(expanded, /markFailed/)
  assert.match(expanded, /events/)
})

test('TaskDetail renders metadata, manual status buttons and the event timeline', () => {
  const { React, render, internals } = loadInternals()
  const html = render(React.createElement(internals.TaskDetail, { task, t, busy: false, onAction: noop, onCopy: noop }))
  for (const expected of ['task_abc123', 'statusLabel', 'deviceLabel', 'attemptsLabel', 'manualStatus', 'markCompleted', 'markFailed', 'cancel', 'routeReason', 'created']) {
    assert.match(html, new RegExp(expected))
  }
})

test('TaskDetail hides completed/failed buttons that would be no-ops', () => {
  const { React, render, internals } = loadInternals()
  const completedTask = makeTask({ status: 'completed', output: { text: 'done' } })
  const html = render(React.createElement(internals.TaskDetail, { task: completedTask, t, busy: false, onAction: noop, onCopy: noop }))
  assert.doesNotMatch(html, /markCompleted/)
  assert.match(html, /markFailed/)
})

test('Dialog renders message, input and confirm button', () => {
  const { React, render, internals } = loadInternals()
  const html = render(React.createElement(internals.Dialog, {
    modal: {
      title: '继续',
      message: '继续会创建一个新任务',
      input: { multiline: true, rows: 4, placeholder: '下一步', required: true },
      value: '再跑一次',
      confirmLabel: '继续',
    },
    busy: false,
    t,
    onChange: noop,
    onCancel: noop,
    onConfirm: noop,
  }))
  assert.match(html, /继续/)
  assert.match(html, /dialogCancel/)
  // textarea 的值是受控 prop，不会出现在无 DOM 渲染结果里，检查元素树本身。
  const textareas = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (node.props && node.props.value === '再跑一次') textareas.push(node)
    const children = node.props && node.props.children
    if (Array.isArray(children)) children.forEach(walk)
    else walk(children)
  }
  walk(internals.Dialog({
    modal: {
      title: '继续',
      message: '继续会创建一个新任务',
      input: { multiline: true, rows: 4, placeholder: '下一步', required: true },
      value: '再跑一次',
      confirmLabel: '继续',
    },
    busy: false,
    t,
    onChange: noop,
    onCancel: noop,
    onConfirm: noop,
  }))
  assert.equal(textareas.length, 1, 'dialog must render a controlled textarea with the typed value')
})

test('ConsoleTab renders devices and the task list without throwing', () => {
  const { React, render, internals } = loadInternals()
  const html = render(React.createElement(internals.ConsoleTab, {
    status: { hub: { running: true, origin: 'http://127.0.0.1:7317', owned: true, joinCode: 'join_x' } },
    snapshot: {
      stats: { devicesOnline: 1, devicesTotal: 1, tasksRunning: 1, tasksQueued: 0, tasksCompleted: 0, tasksFailed: 0 },
      devices: [{
        id: 'dev_1', name: 'Mac mini', online: true, disabled: false, platform: 'darwin', kind: 'desktop',
        status: 'busy', load: { running: 1, max: 2 }, lastSeenAt: now,
        capabilities: { models: [{ id: 'deepseek-chat' }], skills: [{ id: 'cli-exec' }], profiles: [{ id: 'hermes' }] },
      }],
      tasks: [task, childTask, threadTask],
    },
    t,
    onRefresh: noop,
    onHub: noop,
    onTaskAction: noop,
    onSend: async () => {},
    onRenameDevice: noop,
    onRemoveDevice: noop,
    onToggleDevice: noop,
    onToggleTask: noop,
    onCopyText: noop,
    expandedTasks: { task_abc123: true },
    hubOrigin: 'http://127.0.0.1:7317',
    busy: false,
    message: '已创建任务',
  }))
  assert.match(html, /Mac mini/)
  assert.match(html, /task_abc123/)
  assert.match(html, /manualStatus/)
})
