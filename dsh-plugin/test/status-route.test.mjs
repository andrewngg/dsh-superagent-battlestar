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

async function setup() {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'battlestar-plugin-test-'))
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

function stubHubFetch() {
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url))
    calls.push({
      path: parsed.pathname + parsed.search,
      method: String(options.method || 'GET').toUpperCase(),
      headers: options.headers || {},
      body: options.body,
    })
    const payload = parsed.pathname === '/api/health'
      ? { ok: true, name: 'BattleStar', version: 'test' }
      : { task: { id: 'task_abc123', status: 'completed' } }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch
    },
    taskCalls() {
      return calls.filter((call) => call.path.startsWith('/api/tasks/'))
    },
  }
}

async function callRoute(handler, { method, pathname, body }) {
  const req = makeRequest({ method, url: `${ROUTE}${pathname}`, body })
  const res = makeResponse()
  await handler(req, res)
  return res
}

test('manual status route maps completed/failed to external-result and cancel/retry to hub actions', async (t) => {
  const { handler } = await setup()
  const hub = stubHubFetch()
  t.after(() => hub.restore())

  const completed = await callRoute(handler, {
    method: 'POST',
    pathname: '/api/tasks/task_abc123/status',
    body: { status: 'completed', note: 'manual done' },
  })
  assert.equal(completed.statusCode, 200)
  let action = hub.taskCalls().at(-1)
  assert.equal(action.method, 'POST')
  assert.equal(action.path, '/api/tasks/task_abc123/external-result')
  assert.deepEqual(JSON.parse(action.body), { text: 'manual done', status: 'completed' })
  assert.equal(action.headers['X-Butler-Token'], 'test-admin-token')

  const failed = await callRoute(handler, {
    method: 'POST',
    pathname: '/api/tasks/task_abc123/status',
    body: { status: 'failed', note: 'device stuck' },
  })
  assert.equal(failed.statusCode, 200)
  action = hub.taskCalls().at(-1)
  assert.equal(action.path, '/api/tasks/task_abc123/external-result')
  assert.deepEqual(JSON.parse(action.body), {
    text: 'device stuck',
    status: 'failed',
    error: 'device stuck',
  })

  const cancelled = await callRoute(handler, {
    method: 'POST',
    pathname: '/api/tasks/task_abc123/status',
    body: { status: 'cancelled' },
  })
  assert.equal(cancelled.statusCode, 200)
  action = hub.taskCalls().at(-1)
  assert.equal(action.path, '/api/tasks/task_abc123/cancel')

  const queued = await callRoute(handler, {
    method: 'POST',
    pathname: '/api/tasks/task_abc123/status',
    body: { status: 'queued' },
  })
  assert.equal(queued.statusCode, 200)
  action = hub.taskCalls().at(-1)
  assert.equal(action.path, '/api/tasks/task_abc123/retry')
})

test('manual status route rejects unsupported target statuses without touching the hub', async (t) => {
  const { handler } = await setup()
  const hub = stubHubFetch()
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

test('unknown task sub-routes still return 404', async (t) => {
  const { handler } = await setup()
  const hub = stubHubFetch()
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

test('root route advertises the manual status endpoint', async () => {
  const { handler } = await setup()
  const res = await callRoute(handler, { method: 'GET', pathname: '/' })
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.text)
  assert.ok(payload.routes.includes('/api/tasks/:id/status'))
})
