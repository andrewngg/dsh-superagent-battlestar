import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

const ROUTE = '/super-butler'
// 测试从 dsh-plugin 目录运行：上一级是 super-butler（projectRoot），再上一级是工作区根（super ai）。
const SUPER_AI_ROOT = path.resolve(process.cwd(), '..', '..')

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

function workspace(id, dir, title = id) {
  return { id, path: dir, title, sessionIds: [] }
}

function makeSessionStub() {
  const createCalls = []
  const session = {
    createCalls,
    async create(arg) {
      createCalls.push(arg)
      return { sessionId: 'session-dev-1' }
    },
    async prompt() {},
    async resolveAgent() {
      return { agent: { id: 'agent-dev-1' } }
    },
    async *follow() {
      yield { type: 'event', event: { type: 'turn/end' } }
    },
  }
  return session
}

async function setup(t, { workspaces, session, lateSession } = {}) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'battlestar-dev-workspace-'))
  t.after(() => fsp.rm(dataDir, { recursive: true, force: true }))
  await fsp.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ adminToken: 'test-admin-token' }), 'utf8')
  const routes = []
  const registry = workspaces
    ? {
        list: () => workspaces,
        get: (id) => workspaces.find((item) => item.id === id),
      }
    : undefined
  const ctx = {
    get(name) {
      if (name === 'workspaceRegistry') return registry
      if (name === 'sessionController') return lateSession && !lateSession.enabled ? undefined : session
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
  const projectRoot = path.resolve(process.cwd(), '..')
  apply(ctx, { projectRoot, hubPort: 7317, autoStart: false, dataDir })
  const route = routes.find((item) => item.path === ROUTE)
  assert.ok(route, 'host plugin must register the /super-butler prefix route')
  return { dataDir, projectRoot, handler: route.handler }
}

async function callRoute(handler, { method = 'GET', pathname = '/', body }) {
  const req = makeRequest({ method, url: `${ROUTE}${pathname}`, body })
  const res = makeResponse()
  await handler(req, res)
  return res
}

async function waitForJob(handler, jobId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const res = await callRoute(handler, { pathname: `/api/dsh/job/${jobId}` })
    const payload = JSON.parse(res.text)
    if (payload.job && payload.job.status !== 'queued' && payload.job.status !== 'running') return payload.job
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('dev job did not finish in time')
}

test('status reports the ancestor workspace that contains the project root', async (t) => {
  const ancestor = workspace('ws-super-ai', SUPER_AI_ROOT, 'super ai')
  const { handler } = await setup(t, {
    workspaces: [workspace('ws-default', path.join(os.tmpdir(), 'dev-workspace-default'), 'default-workspace'), ancestor],
    session: makeSessionStub(),
  })

  const res = await callRoute(handler, { pathname: '/api/dsh/status' })
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.text)
  assert.equal(payload.workspaceId, 'ws-super-ai')
  assert.equal(payload.workspaceTitle, 'super ai')
  assert.equal(payload.sessionId, '')
})

test('developer chat creates the DSH session inside the matched workspace', async (t) => {
  const target = workspace('ws-super-ai', SUPER_AI_ROOT, 'super ai')
  const session = makeSessionStub()
  const { handler } = await setup(t, {
    workspaces: [workspace('ws-default', path.join(os.tmpdir(), 'dev-workspace-default'), 'default-workspace'), target],
    session,
  })

  const created = await callRoute(handler, {
    method: 'POST',
    pathname: '/api/dsh/chat',
    body: { message: '给任务路由加上设备亲和提示' },
  })
  assert.equal(created.statusCode, 202)
  const jobId = JSON.parse(created.text).job.id
  const job = await waitForJob(handler, jobId)

  assert.equal(session.createCalls.length, 1)
  assert.deepEqual(session.createCalls[0], { workspaceId: 'ws-super-ai' })
  assert.equal(job.status, 'done')
  assert.equal(job.sessionId, 'session-dev-1')

  const status = await callRoute(handler, { pathname: '/api/dsh/status' })
  const payload = JSON.parse(status.text)
  assert.equal(payload.sessionId, 'session-dev-1')
  assert.equal(payload.sessionWorkspaceId, 'ws-super-ai')
  assert.equal(payload.sessionWorkspacePath, target.path)
})

test('developer chat resolves sessionController lazily instead of caching the mount-time miss', async (t) => {
  const session = makeSessionStub()
  const lateSession = { enabled: false }
  const { handler } = await setup(t, { session, lateSession })

  const before = await callRoute(handler, { pathname: '/api/dsh/status' })
  assert.equal(JSON.parse(before.text).available, false, 'the service is not registered at mount time')

  lateSession.enabled = true

  const created = await callRoute(handler, {
    method: 'POST',
    pathname: '/api/dsh/chat',
    body: { message: '挂载之后才激活的服务也要能用' },
  })
  assert.equal(created.statusCode, 202, 'a late-activated sessionController must be picked up')
  const job = await waitForJob(handler, JSON.parse(created.text).job.id)
  assert.equal(job.status, 'done')
  assert.equal(session.createCalls.length, 1)
})

test('chat falls back to cwd creation when no workspace registry is available', async (t) => {
  const session = makeSessionStub()
  const { handler, projectRoot } = await setup(t, { session })

  const created = await callRoute(handler, {
    method: 'POST',
    pathname: '/api/dsh/chat',
    body: { message: '检查一下 hub 日志' },
  })
  const jobId = JSON.parse(created.text).job.id
  await waitForJob(handler, jobId)

  assert.equal(session.createCalls.length, 1)
  assert.deepEqual(session.createCalls[0], { cwd: projectRoot })

  const status = await callRoute(handler, { pathname: '/api/dsh/status' })
  const payload = JSON.parse(status.text)
  assert.equal(payload.workspaceId, '')
  assert.equal(payload.sessionWorkspaceId, '')
})

test('explicit devWorkspacePath setting overrides ancestor detection and resets the session', async (t) => {
  const explicit = workspace('ws-explicit', path.join(os.tmpdir(), 'dev-workspace-explicit'), 'explicit workspace')
  const session = makeSessionStub()
  const { handler } = await setup(t, {
    workspaces: [workspace('ws-super-ai', SUPER_AI_ROOT, 'super ai'), explicit],
    session,
  })

  const first = await callRoute(handler, {
    method: 'POST',
    pathname: '/api/dsh/chat',
    body: { message: '第一次开发指令' },
  })
  await waitForJob(handler, JSON.parse(first.text).job.id)
  assert.deepEqual(session.createCalls[0], { workspaceId: 'ws-super-ai' })

  const saved = await callRoute(handler, {
    method: 'POST',
    pathname: '/api/settings',
    body: { settings: { devWorkspacePath: explicit.path } },
  })
  assert.equal(saved.statusCode, 200)

  const status = await callRoute(handler, { pathname: '/api/dsh/status' })
  const payload = JSON.parse(status.text)
  assert.equal(payload.workspaceId, 'ws-explicit')
  assert.equal(payload.sessionId, '', 'changing the target workspace must reset the dev session')

  const second = await callRoute(handler, {
    method: 'POST',
    pathname: '/api/dsh/chat',
    body: { message: '第二次开发指令' },
  })
  await waitForJob(handler, JSON.parse(second.text).job.id)
  assert.deepEqual(session.createCalls[1], { workspaceId: 'ws-explicit' })
})
