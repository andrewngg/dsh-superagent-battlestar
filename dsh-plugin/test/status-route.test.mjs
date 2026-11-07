import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

const ROUTE = '/super-butler'

function makeRequest({ method = 'GET', url = '/', body, remoteAddress = '127.0.0.1' }) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.socket = { remoteAddress }
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
    req.emit('end')
  })
  return req
}

function makeResponse() {
  const res = {
    statusCode: 0,
    headers: {},
    text: '',
    writeHead(status, headers) {
      res.statusCode = status
      res.headers = headers || {}
      return res
    },
    end(text = '') {
      res.text += String(text)
      return res
    },
  }
  return res
}

async function setup(t) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'battlestar-plugin-test-'))
  t.after(() => fsp.rm(dataDir, { recursive: true, force: true }))
  await fsp.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ adminToken: 'test-admin-token' }), 'utf8')
  const routes = []
  const ctx = {
    get() {
      return undefined
    },
    effect(fn) {
      // autoStart:false 时生命周期 effect 只会读取设置，不会启动 Hub。
      fn()
      return fn
    },
    webServer: {
      register(options) {
        routes.push(options)
      },
    },
  }
  apply(ctx, { projectRoot: process.cwd(), hubPort: 7317, autoStart: false, dataDir })
  const route = routes.find((item) => item.path === ROUTE)
  assert.ok(route, 'host plugin must register the /super-butler prefix route')
  return { dataDir, handler: route.handler }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function stubHubFetch(initialTask, options = {}) {
  const calls = []
  const originalFetch = globalThis.fetch
  const state = {
    task: initialTask,
    cancelStatus: 200,
    retryStatus: 200,
    externalStatus: 200,
    ...options,
  }
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url))
    const pathname = parsed.pathname
    const method = String(init.method || 'GET').toUpperCase()
    const body = init.body
    calls.push({ pathname, method, headers: init.headers || {}, body })

    if (pathname === '/api/health') return jsonResponse({ ok: true, name: 'BattleStar', version: 'test' })

    if (method === 'GET' && /^\/api\/tasks\/[^/]+$/.test(pathname)) {
      if (!state.task) return jsonResponse({ error: { code: 'not_found', message: '任务不存在' } }, 404)
      return jsonResponse({ task: state.task })
    }
    if (pathname.endsWith('/cancel')) {
      if (state.cancelStatus >= 400) {
        return jsonResponse({ error: { code: 'conflict', message: '任务状态不可取消' } }, state.cancelStatus)
      }
      if (state.task) state.task = { ...state.task, status: 'cancelled' }
      return jsonResponse({ task: state.task })
    }
    if (pathname.endsWith('/retry')) {
      if (state.retryStatus >= 400) {
        return jsonResponse({ error: { code: 'conflict', message: '任务状态不可重试' } }, state.retryStatus)
      }
      if (state.task) state.task = { ...state.task, status: 'queued' }
      return jsonResponse({ task: state.task })
    }
    if (pathname.endsWith('/external-result')) {
      if (state.externalStatus >= 400) {
        return jsonResponse({ error: { code: 'conflict', message: '拒绝外部结果' } }, state.externalStatus)
      }
      const payload = JSON.parse(String(body || '{}'))
      if (state.task) {
        state.task = { ...state.task, status: payload.status, output: { text: payload.text }, error: payload.error || null }
      }
      return jsonResponse({ task: state.task })
    }
    return jsonResponse({ ok: true })
  }
  return {
    state,
    calls,
    restore() {
      globalThis.fetch = originalFetch
    },
    taskCalls() {
      return calls.filter((call) => call.pathname.startsWith('/api/tasks/'))
    },
    callsTo(suffix) {
      return calls.filter((call) => call.pathname.endsWith(suffix))
    },
  }
}

async function callRoute(handler, { method, pathname, body }) {
  const req = makeRequest({ method, url: `${ROUTE}${pathname}`, body })
  const res = makeResponse()
  await handler(req, res)
  return res
}

function activeTask(overrides = {}) {
  return {
    id: 'task_abc123',
    instruction: '运行测试',
    status: 'running',
    isPlan: false,
    output: { text: 'real output' },
    error: null,
    childTaskIds: [],
    ...overrides,
  }
}

test('active task: mark completed cancels the device first, then forces the terminal status', async (t) => {
  const { handler } = await setup(t)
  const hub = stubHubFetch(activeTask())
  t.after(() => hub.restore())

  const res = await callRoute(handler, {
    method: 'POST',
    pathname: '/api/tasks/task_abc123/status',
    body: { status: 'completed', note: 'manual done' },
  })

  assert.equal(res.statusCode, 200)
  const paths = hub.taskCalls().map((call) => `${call.method} ${call.pathname}`)
  assert.deepEqual(paths, [
    'GET /api/tasks/task_abc123',
    'POST /api/tasks/task_abc123/cancel',
    'POST /api/tasks/task_abc123/external-result',
  ])
  const external = hub.callsTo('/external-result').at(-1)
  assert.deepEqual(JSON.parse(external.body), { text: 'manual done', status: 'completed' })
  assert.equal(external.headers['X-Butler-Token'], 'test-admin-token')
})

test('active task: mark failed without a note keeps the previous output text', async (t) => {
  const { handler } = await setup(t)
  const hub = stubHubFetch(activeTask({ status: 'waiting' }))
  t.after(() => hub.restore())

  const res = await callRoute(handler, {
    method: 'POST',
    pathname: '/api/tasks/task_abc123/status',
    body: { status: 'failed' },
  })

  assert.equal(res.statusCode, 200)
  assert.equal(hub.callsTo('/cancel').length, 1)
  const external = hub.callsTo('/external-result').at(-1)
  assert.deepEqual(JSON.parse(external.body), {
    text: 'real output',
    status: 'failed',
    error: '管理员手动标记失败',
  })
})

test('terminal task: status flip does not cancel again and preserves output when the note is empty', async (t) => {
  const { handler } = await setup(t)
  const hub = stubHubFetch(activeTask({ status: 'completed', error: 'old error' }))
  t.after(() => hub.restore())

  const res = await callRoute(handler, {
    method: 'POST',
    pathname: '/api/tasks/task_abc123/status',
    body: { status: 'failed' },
  })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(hub.taskCalls().map((call) => call.pathname), [
    '/api/tasks/task_abc123',
    '/api/tasks/task_abc123/external-result',
  ])
  assert.deepEqual(JSON.parse(hub.callsTo('/external-result').at(-1).body), {
    text: 'real output',
    status: 'failed',
    error: 'old error',
  })
})

test('cancelled target only calls cancel', async (t) => {
  const { handler } = await setup(t)
  const hub = stubHubFetch(activeTask({ status: 'assigned' }))
  t.after(() => hub.restore())

  const res = await callRoute(handler, {
    method: 'POST',
    pathname: '/api/tasks/task_abc123/status',
    body: { status: 'cancelled' },
  })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(hub.taskCalls().map((call) => call.pathname), [
    '/api/tasks/task_abc123',
    '/api/tasks/task_abc123/cancel',
  ])
})

test('queued target maps to retry without an extra cancel', async (t) => {
  const { handler } = await setup(t)
  const hub = stubHubFetch(activeTask({ status: 'failed' }))
  t.after(() => hub.restore())

  const res = await callRoute(handler, {
    method: 'POST',
    pathname: '/api/tasks/task_abc123/status',
    body: { status: 'queued' },
  })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(hub.taskCalls().map((call) => call.pathname), [
    '/api/tasks/task_abc123',
    '/api/tasks/task_abc123/retry',
  ])
})

test('plan parents reject manual terminal statuses because children own the status', async (t) => {
  const { handler } = await setup(t)
  const hub = stubHubFetch(activeTask({ isPlan: true, status: 'completed' }))
  t.after(() => hub.restore())

  const res = await callRoute(handler, {
    method: 'POST',
    pathname: '/api/tasks/task_abc123/status',
    body: { status: 'failed' },
  })

  assert.equal(res.statusCode, 409)
  assert.match(JSON.parse(res.text).error.message, /长任务拆分/)
  assert.deepEqual(hub.taskCalls().map((call) => call.pathname), ['/api/tasks/task_abc123'])
})

test('plan parents can still be cancelled', async (t) => {
  const { handler } = await setup(t)
  const hub = stubHubFetch(activeTask({ isPlan: true, status: 'running' }))
  t.after(() => hub.restore())

  const res = await callRoute(handler, {
    method: 'POST',
    pathname: '/api/tasks/task_abc123/status',
    body: { status: 'cancelled' },
  })

  assert.equal(res.statusCode, 200)
  assert.equal(hub.callsTo('/cancel').length, 1)
})

test('a cancel failure on an active task propagates and skips external-result', async (t) => {
  const { handler } = await setup(t)
  const hub = stubHubFetch(activeTask(), { cancelStatus: 409 })
  t.after(() => hub.restore())

  const res = await callRoute(handler, {
    method: 'POST',
    pathname: '/api/tasks/task_abc123/status',
    body: { status: 'completed' },
  })

  assert.equal(res.statusCode, 409)
  assert.equal(hub.callsTo('/cancel').length, 1)
  assert.equal(hub.callsTo('/external-result').length, 0)
})

test('manual status route rejects unsupported target statuses without touching the hub', async (t) => {
  const { handler } = await setup(t)
  const hub = stubHubFetch(activeTask())
  t.after(() => hub.restore())

  const res = await callRoute(handler, {
    method: 'POST',
    pathname: '/api/tasks/task_abc123/status',
    body: { status: 'running' },
  })
  assert.equal(res.statusCode, 400)
  const payload = JSON.parse(res.text)
  assert.equal(payload.error.code, 'bad_request')
  assert.match(payload.error.message, /不支持的状态/)
  assert.equal(hub.taskCalls().length, 0)
})

test('unknown task ids propagate the hub 404 without further actions', async (t) => {
  const { handler } = await setup(t)
  const hub = stubHubFetch(null)
  t.after(() => hub.restore())

  const res = await callRoute(handler, {
    method: 'POST',
    pathname: '/api/tasks/task_missing/status',
    body: { status: 'completed' },
  })
  assert.equal(res.statusCode, 404)
  assert.equal(JSON.parse(res.text).error.message, '任务不存在')
  assert.deepEqual(hub.taskCalls().map((call) => call.pathname), ['/api/tasks/task_missing'])
})

test('unknown task sub-routes still return 404', async (t) => {
  const { handler } = await setup(t)
  const hub = stubHubFetch(activeTask())
  t.after(() => hub.restore())

  const res = await callRoute(handler, {
    method: 'POST',
    pathname: '/api/tasks/task_abc123/not-a-real-action',
    body: {},
  })
  assert.equal(res.statusCode, 404)
  assert.equal(JSON.parse(res.text).error.code, 'not_found')
  assert.equal(hub.taskCalls().length, 0)
})

test('root route advertises the manual status endpoint', async (t) => {
  const { handler } = await setup(t)
  const res = await callRoute(handler, { method: 'GET', pathname: '/' })
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.text)
  assert.ok(payload.routes.includes('/api/tasks/:id/status'))
  assert.ok(payload.features.includes('task-status-cancel-first'), 'client uses this feature flag to gate forced status changes')
})
