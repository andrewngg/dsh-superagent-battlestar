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
  for (const key of ['taskId', 'manualStatus', 'markCompleted', 'markFailed', 'statusUpdated', 'followUpHint', 'statusRouteNeedsRestart']) {
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

test('task UI uses in-panel dialogs instead of window.prompt (Electron has no prompt)', () => {
  assert.equal(source.includes('window.prompt('), false, 'window.prompt is unavailable in the DSH desktop shell')
  assert.ok(source.includes('function Dialog('), 'client must render an in-panel dialog')
  assert.ok(source.includes('function TaskDetail('), 'client must render a task detail section')
  assert.ok(source.includes('/status'), 'client must call the manual status endpoint')
})
