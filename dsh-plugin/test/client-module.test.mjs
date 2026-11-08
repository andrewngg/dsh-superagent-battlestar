import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientFile = path.join(here, '..', 'client.js')
const source = fs.readFileSync(clientFile, 'utf8')

function loadManifest() {
  let manifest = null
  const windowStub = { __ModuleLoader__: { load: (value) => { manifest = value } } }
  vm.runInNewContext(source, { window: windowStub, console }, { filename: clientFile })
  return manifest
}

function createReactStub() {
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children }
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() {},
    useCallback(fn) {
      return fn
    },
    useMemo(fn) {
      return fn()
    },
  }
  return React
}

function createContext() {
  const localeRegistrations = []
  const slotRegistrations = []
  const ctx = {
    effect(fn) {
      fn()
      return fn
    },
    locale: {
      register(namespace, dictionaries) {
        localeRegistrations.push({ namespace, dictionaries })
      },
      bind(namespace) {
        return (key) => `${namespace}.${key}`
      },
    },
    slots: {
      inject(_slot, fn) {
        fn()
      },
      register(options, component) {
        slotRegistrations.push({ options, component })
        return options
      },
    },
  }
  return { ctx, localeRegistrations, slotRegistrations }
}

test('client.js registers the super-butler module', () => {
  const manifest = loadManifest()
  assert.ok(manifest, 'client.js must call window.__ModuleLoader__.load')
  assert.equal(manifest.id, '@local/dsh-super-butler')
  assert.equal(typeof manifest.factory, 'function')
})

test('module factory and apply register dictionaries, main panel and sidebar entry', () => {
  const manifest = loadManifest()
  const requireStub = (name) => {
    if (name === 'react') return createReactStub()
    throw new Error(`unexpected require: ${name}`)
  }
  const plugin = manifest.factory(requireStub)
  assert.deepEqual([...plugin.inject], ['slots', 'locale'])
  assert.equal(typeof plugin.apply, 'function')

  const { ctx, localeRegistrations, slotRegistrations } = createContext()
  plugin.apply(ctx)

  assert.equal(localeRegistrations.length, 1)
  assert.equal(localeRegistrations[0].namespace, 'superButler')
  const { zh, en } = localeRegistrations[0].dictionaries
  for (const key of ['taskId', 'manualStatus', 'markCompleted', 'markFailed', 'statusUpdated', 'followUpHint', 'statusRouteNeedsRestart', 'overwriteHint', 'planStatusHint', 'inputRequired', 'dashboard', 'openConsole', 'openConsoleHint', 'recentTasks', 'guide', 'addPc', 'addPhoneWorker', 'phoneControl', 'guideTrouble', 'devTools', 'gitPush', 'gitPushing', 'gitPushOk', 'gitPushFailed', 'gitPushNeedsRestart', 'restartNeedsRestart', 'gitRepo', 'gitUpstream', 'gitNoUpstream', 'credentialsFallback', 'credentialsLocalBadge']) {
    assert.ok(zh[key], `zh dictionary is missing ${key}`)
    assert.ok(en[key], `en dictionary is missing ${key}`)
  }

  const main = slotRegistrations.find((item) => item.options.name === 'main')
  assert.ok(main, 'main slot must be registered')
  assert.equal(main.options.key, 'super-butler')
  const sidebar = slotRegistrations.find((item) => item.options.name === 'sidebar.panellist')
  assert.ok(sidebar, 'sidebar.panellist slot must be registered')
  assert.equal(sidebar.options.order, 5)
})

test('client.js stays a read-only dashboard that opens the browser console', () => {
  assert.equal(source.includes('window.prompt('), false, 'window.prompt is unavailable in the DSH desktop shell')
  assert.ok(source.includes('function ConsoleTab('), 'client must render the dashboard tab')
  assert.ok(source.includes('function DeviceCard('), 'client must render the device summary card')
  assert.ok(source.includes('/api/dsh/open'), 'client must link to the browser console redirect route')
  assert.equal(source.includes('function TaskRow('), false, 'task actions live in the browser console only')
  assert.equal(source.includes('function TaskDetail('), false, 'task details live in the browser console only')
  assert.equal(source.includes('function Dialog('), false, 'the dashboard needs no in-panel dialogs')
  assert.equal(source.includes("call('/tasks'"), false, 'the dashboard no longer dispatches tasks')
  assert.ok(source.includes('function GuideTab('), 'client must render the worker setup guide tab')
  assert.ok(source.includes('--join-code'), 'the guide shows the worker start command')
  assert.ok(source.includes("call('/dsh/git-push'"), 'the settings tab triggers git push through the host route')
  assert.ok(source.includes("credentials.available === false"), 'settings must warn when keys fall back to the local file')
})
