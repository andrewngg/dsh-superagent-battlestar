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
  '    globalThis.__dshClientInternals = { DeviceCard, ConsoleTab, GuideTab, MindTab, Panel, SettingsTab }\n    return {\n      inject:',
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

  // 按类型收集元素树里的节点，用来断言 props（无 DOM 渲染时 props 不会出现在文本里）。
  function collect(node, predicate, out = []) {
    if (node === null || node === undefined || typeof node !== 'object') return out
    if (Array.isArray(node)) {
      for (const child of node) collect(child, predicate, out)
      return out
    }
    if (typeof node.type === 'function') return collect(node.type({ ...node.props }), predicate, out)
    if (predicate(node)) out.push(node)
    const children = node.props && node.props.children
    if (Array.isArray(children)) collect(children, predicate, out)
    else collect(children, predicate, out)
    return out
  }

  return { React, effects, render: renderNode, collect }
}

function loadInternals() {
  const { React, render, collect } = createMiniReact()
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
  return { React, render, collect, plugin, internals }
}

const t = (key) => String(key)
const noop = () => {}
const now = new Date().toISOString()

function makeTask(overrides = {}) {
  return {
    id: 'task_abc123',
    instruction: '运行测试并只回答结果',
    status: 'running',
    assignedDeviceId: 'dev_1',
    assignedDeviceName: 'Mac mini',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

const device = {
  id: 'dev_1',
  name: 'Mac mini',
  nickname: '书房主力机',
  online: true,
  disabled: false,
  platform: 'darwin',
  kind: 'desktop',
  status: 'busy',
  load: { running: 1, max: 2 },
  lastSeenAt: now,
  capabilities: { models: [{ id: 'deepseek-chat' }], skills: [{ id: 'cli-exec' }] },
}

function renderConsole(internals, overrides = {}) {
  const { React, render, collect } = overrides.helpers
  return {
    html: render(React.createElement(internals.ConsoleTab, {
      status: { hub: { running: true, origin: 'http://127.0.0.1:7317', owned: true, joinCode: 'join_x' } },
      snapshot: {
        stats: { devicesOnline: 1, devicesTotal: 1, tasksRunning: 1, tasksQueued: 2, tasksCompleted: 3, tasksFailed: 0 },
        devices: [device],
        tasks: [makeTask(), makeTask({ id: 'task_done', status: 'completed', instruction: '整理下载目录' })],
      },
      t,
      busy: false,
      message: '',
      messageTone: '',
      hubOrigin: 'http://127.0.0.1:7317',
      onRefresh: noop,
      onHub: noop,
    })),
    collect,
  }
}

test('ConsoleTab renders a read-only dashboard with devices, stats and recent tasks', () => {
  const internals = loadInternals().internals
  const helpers = createMiniReact()
  const { html } = renderConsole(internals, { helpers })
  assert.match(html, /http:\/\/127\.0\.0\.1:7317/, 'dashboard shows the hub origin')
  assert.match(html, /书房主力机/, 'dashboard shows the device nickname')
  assert.match(html, /1\/1/, 'dashboard shows the online device count')
  assert.match(html, /运行测试并只回答结果/, 'recent task list shows the instruction')
  assert.match(html, /整理下载目录/, 'recent task list shows completed work')
  // 面板已经简化：不再直接下发任务、也不再提供任务操作。
  assert.doesNotMatch(html, /instructionPlaceholder/, 'no task composer on the dashboard')
  assert.doesNotMatch(html, /manualStatus/, 'no manual status actions on the dashboard')
  assert.doesNotMatch(html, /removeDevice|disableDevice/, 'no device management actions on the dashboard')
})

test('ConsoleTab links to the browser console through the plugin redirect route', () => {
  const internals = loadInternals().internals
  const helpers = createMiniReact()
  const { html } = renderConsole(internals, { helpers })
  assert.match(html, /openConsole/, 'the browser console entry is labelled')
  const { React, collect } = helpers
  const tree = React.createElement(internals.ConsoleTab, {
    status: { hub: { running: true, origin: 'http://127.0.0.1:7317', owned: true } },
    snapshot: { stats: {}, devices: [], tasks: [] },
    t, busy: false, message: '', messageTone: '', hubOrigin: 'http://127.0.0.1:7317',
    onRefresh: noop, onHub: noop,
  })
  const anchors = collect(tree, (node) => node.type === 'a')
  assert.equal(anchors.length, 1, 'dashboard must render exactly one browser console link')
  assert.equal(anchors[0].props.href, '/super-butler/api/dsh/open')
  assert.equal(anchors[0].props.target, '_blank')
  assert.equal(anchors[0].props.rel, 'noopener noreferrer')
})

test('the restart hub action works even when the Hub is an external process', () => {
  const { React, collect, render, internals } = loadInternals()
  const t = (key) => String(key)
  const tree = React.createElement(internals.ConsoleTab, {
    status: { hub: { running: true, origin: 'http://127.0.0.1:7317', owned: false } },
    snapshot: { stats: {}, devices: [], tasks: [] },
    t, busy: false, message: '', messageTone: '', hubOrigin: 'http://127.0.0.1:7317',
    onRefresh: noop, onHub: noop,
  })
  const buttons = collect(tree, (node) => node.type === 'button')
  const restart = buttons.find((node) => render(node.props.children) === 'restartHub')
  assert.ok(restart, 'the dashboard exposes a restart action')
  assert.equal(restart.props.disabled, false, 'restart stays clickable for an external Hub')
  const stop = buttons.find((node) => render(node.props.children) === 'stop')
  assert.ok(stop, 'stop is still shown')
  assert.equal(stop.props.disabled, true, 'the plugin cannot stop an external Hub process')
  assert.match(String(stop.props.title), /stopExternalHint/, 'the disabled stop button explains why')
})

test('DeviceCard is a read-only summary that shows the nickname and keeps the machine name', () => {
  const { React, render, internals } = loadInternals()
  const html = render(React.createElement(internals.DeviceCard, { device, t }))
  assert.match(html, /书房主力机/)
  assert.match(html, /machineName: Mac mini/)
  assert.match(html, /deepseek-chat/)
  assert.doesNotMatch(html, /saveName|disableDevice|removeDevice/, 'read-only card offers no editing actions')

  const fallback = render(React.createElement(internals.DeviceCard, { device: { ...device, nickname: '' }, t }))
  assert.match(fallback, /Mac mini/)
  assert.doesNotMatch(fallback, /machineName/)
})

test('DeviceCard marks offline devices and hides capabilities when the device is bare', () => {
  const { React, render, internals } = loadInternals()
  const offline = render(React.createElement(internals.DeviceCard, {
    device: { ...device, online: false, nickname: '', capabilities: {} }, t,
  }))
  assert.match(offline, /offline/)
  assert.doesNotMatch(offline, /deepseek-chat/)
})

test('GuideTab teaches PC and phone worker setup with the live hub address and join code', () => {
  const { React, render, collect, internals } = loadInternals()
  const tree = React.createElement(internals.GuideTab, {
    t, hubOrigin: 'http://127.0.0.1:7317', joinCode: 'join_demo',
  })
  const html = render(tree)
  for (const key of ['guide', 'addPc', 'pcStep1', 'pcStep4', 'addPhoneWorker', 'phoneStep1', 'phoneStep5', 'phoneControl', 'ctrlStep1', 'guideTrouble', 'troubleOffline', 'guideDocs']) {
    assert.match(html, new RegExp(key), `guide renders ${key}`)
  }
  assert.match(html, /http:\/\/127\.0\.0\.1:7317/, 'commands use the live hub address')
  assert.match(html, /join_demo/, 'commands use the live join code')
  assert.match(html, /\/m\?token=/, 'control client instructions point at the mobile console')
  const pre = collect(tree, (node) => node.type === 'pre')
  assert.ok(pre.length >= 4, 'commands are rendered as copyable code blocks')
  assert.ok(pre.some((node) => /agent\.js --hub/.test(render(node.props.children))), 'agent start command is shown')
})

test('SettingsTab exposes the developer git push action', () => {
  const { React, render, collect, internals } = loadInternals()
  const tree = React.createElement(internals.SettingsTab, {
    settings: {}, secrets: [], status: { hub: { running: true, joinCode: 'join_x' } },
    t, onSave: async () => null, busy: false, message: '',
  })
  const html = render(tree)
  assert.match(html, /devTools/, 'settings tab has a dev tools section')
  assert.match(html, /gitPushHint/, 'the push button explains what it does')
  const buttons = collect(tree, (node) => node.type === 'button')
  const push = buttons.find((node) => node.props.children === 'gitPush')
  assert.ok(push, 'settings tab renders the Git Push button')
  assert.equal(push.props.disabled, false, 'the button is enabled when idle')
})

test('SettingsTab warns that keys fall back to the local file when credentials are unavailable', () => {
  const { React, render, internals } = loadInternals()
  const props = {
    settings: {}, secrets: [], status: { hub: { running: true, joinCode: 'join_x' } },
    t, onSave: async () => null, busy: false, message: '',
  }
  const fallback = render(React.createElement(internals.SettingsTab, {
    ...props, credentials: { available: false, storage: 'plugin-local' },
  }))
  assert.match(fallback, /credentialsFallback/, 'local fallback is called out in the key section')
  const harness = render(React.createElement(internals.SettingsTab, {
    ...props, credentials: { available: true, storage: 'harness' },
  }))
  assert.doesNotMatch(harness, /credentialsFallback/, 'no warning while the credentials service is available')
})

test('ConsoleTab reports the stopped hub and still exposes the browser console link', () => {
  const internals = loadInternals().internals
  const { React, render } = createMiniReact()
  const html = render(React.createElement(internals.ConsoleTab, {
    status: { hub: { running: false, origin: 'http://127.0.0.1:7317', owned: false } },
    snapshot: null,
    t, busy: false, message: 'stopped', messageTone: '', hubOrigin: 'http://127.0.0.1:7317',
    onRefresh: noop, onHub: noop,
  }))
  assert.match(html, /stopped/)
  assert.match(html, /noDevices/)
  assert.match(html, /openConsole/)
})

test('MindTab edits the soul and workflow that moved out of the web console', () => {
  const { React, render, collect, internals } = loadInternals()
  const tree = React.createElement(internals.MindTab, { t })
  const html = render(tree)
  for (const key of ['mindTitle', 'mindHint', 'soulField', 'skillField', 'mindSave', 'mindResetAll', 'mindDefaultBadge']) {
    assert.match(html, new RegExp(key), `mind tab renders ${key}`)
  }
  const textareas = collect(tree, (node) => node.type === 'textarea')
  assert.equal(textareas.length, 2, 'soul and workflow each get a textarea')
  const buttons = collect(tree, (node) => node.type === 'button')
  const labels = buttons.map((node) => render(node.props.children))
  assert.ok(labels.includes('mindSave'), 'save action exists')
  assert.ok(labels.includes('mindResetAll'), 'reset-all action exists')
  assert.equal(labels.filter((label) => label === 'mindReset').length, 2, 'each field can be reset')
})
