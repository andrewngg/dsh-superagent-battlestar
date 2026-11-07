import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fsp from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

// 真实 Hub（隔离端口 + 临时数据目录）上的端到端校验：确认「先取消再结束」在真实
// Hub 状态机上有效，而不是只在 stub 里成立。
const require = createRequire(import.meta.url)
const { startHub } = require('../../hub/lib/hub.js')

const ROUTE = '/super-butler'

function makeRequest({ method = 'GET', url = '/', body }) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.socket = { remoteAddress: '127.0.0.1' }
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  return req
}

function makeResponse() {
  const res = {
    statusCode: 0,
    text: '',
    writeHead(status) {
      res.statusCode = status
      return res
    },
    end(text = '') {
      res.text += String(text)
      return res
    },
  }
  return res
}

async function callRoute(handler, { method, pathname, body }) {
  const req = makeRequest({ method, url: `${ROUTE}${pathname}`, body })
  const res = makeResponse()
  await handler(req, res)
  return res
}

async function setup(t) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'battlestar-plugin-e2e-'))
  const hub = await startHub({
    port: 0,
    host: '127.0.0.1',
    dataDir,
    webDir: path.join(process.cwd(), 'hub', 'web'),
    version: 'test',
    ttlMs: 60000,
    planner: async () => ({
      title: '集成测试拆分',
      subtasks: [
        { instruction: '子任务一', timeoutSec: 60 },
        { instruction: '子任务二', timeoutSec: 60 },
      ],
    }),
  })
  await hub.flushState()
  t.after(async () => {
    await hub.close()
    await fsp.rm(dataDir, { recursive: true, force: true })
  })

  const routes = []
  const ctx = {
    get() {
      return undefined
    },
    effect(fn) {
      fn()
      return fn
    },
    webServer: {
      register(options) {
        routes.push(options)
      },
    },
  }
  apply(ctx, {
    projectRoot: process.cwd(),
    hubPort: hub.port,
    hubHost: '127.0.0.1',
    autoStart: false,
    dataDir,
  })
  const route = routes.find((item) => item.path === ROUTE)
  assert.ok(route, 'host plugin must register the /super-butler prefix route')
  return { hub, handler: route.handler }
}

test('active queued task is really cancelled before being force-completed on a live hub', async (t) => {
  const { hub, handler } = await setup(t)
  const task = hub.createTask({ instruction: '集成测试：手动改状态', requirements: {}, timeoutSec: 60 })
  assert.equal(task.status, 'queued')

  const res = await callRoute(handler, {
    method: 'POST',
    pathname: `/api/tasks/${encodeURIComponent(task.id)}/status`,
    body: { status: 'completed', note: '手动完成（集成测试）' },
  })

  assert.equal(res.statusCode, 200)
  const stored = hub.getTask(task.id)
  assert.equal(stored.status, 'completed')
  assert.equal(stored.output.text, '手动完成（集成测试）')
  // 真实 Hub 会先记录取消事件，再记录 external-result 的完成事件。
  const messages = stored.events.map((event) => event.message)
  assert.ok(messages.includes('任务已取消'), `expected a cancel event, got ${JSON.stringify(messages)}`)
  assert.ok(messages.includes('已同步 Mika 最终结果'), `expected an external-result event, got ${JSON.stringify(messages)}`)
})

test('failed queued task can be force-failed on a live hub without a note losing output', async (t) => {
  const { hub, handler } = await setup(t)
  const task = hub.createTask({ instruction: '集成测试：手动失败', requirements: {}, timeoutSec: 60 })
  hub._finishTask(task, 'failed', { output: { text: '原有输出' }, error: '原有错误', eventMessage: '旧失败' })

  const res = await callRoute(handler, {
    method: 'POST',
    pathname: `/api/tasks/${encodeURIComponent(task.id)}/status`,
    body: { status: 'failed' },
  })

  assert.equal(res.statusCode, 200)
  const stored = hub.getTask(task.id)
  assert.equal(stored.status, 'failed')
  assert.equal(stored.output.text, '原有输出')
  assert.equal(stored.error, '原有错误')
})

test('live hub rejects manual status for Agnes plan parents but still allows cancel', async (t) => {
  const { hub, handler } = await setup(t)
  const plan = await hub.createPlanTask({
    instruction: '集成测试：长任务',
    requirements: {},
    timeoutSec: 120,
    split: true,
  })
  assert.equal(plan.isPlan, true)

  const rejected = await callRoute(handler, {
    method: 'POST',
    pathname: `/api/tasks/${encodeURIComponent(plan.id)}/status`,
    body: { status: 'completed' },
  })
  assert.equal(rejected.statusCode, 409)
  assert.match(JSON.parse(rejected.text).error.message, /长任务拆分/)
  assert.notEqual(hub.getTask(plan.id).status, 'completed')

  const cancelled = await callRoute(handler, {
    method: 'POST',
    pathname: `/api/tasks/${encodeURIComponent(plan.id)}/status`,
    body: { status: 'cancelled' },
  })
  assert.equal(cancelled.statusCode, 200)
  assert.equal(hub.getTask(plan.id).status, 'cancelled')
})
