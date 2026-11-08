import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
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

async function setup(t, options = {}) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'battlestar-plugin-test-'))
  t.after(() => fsp.rm(dataDir, { recursive: true, force: true }))
  await fsp.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ adminToken: 'test-admin-token' }), 'utf8')
  const routes = []
  const { credentials, webOrigin, ...overrides } = options
  const ctx = {
    get(name) {
      // 只有测试显式提供时才模拟 Harness credentials 服务；默认模拟「服务不可用」。
      return name === 'credentials' ? credentials : undefined
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
      ...(webOrigin ? { getOrigin: () => webOrigin } : {}),
    },
  }
  apply(ctx, { projectRoot: process.cwd(), hubPort: 7317, autoStart: false, dataDir, ...overrides })
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

async function callRoute(handler, { method, pathname, body, remoteAddress = '127.0.0.1' }) {
  const req = makeRequest({ method, url: `${ROUTE}${pathname}`, body, remoteAddress })
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

test('GET /api/dsh/open redirects the browser to the hub console with the admin token', async (t) => {
  const { handler } = await setup(t)
  const res = await callRoute(handler, { method: 'GET', pathname: '/api/dsh/open' })
  assert.equal(res.statusCode, 302)
  assert.equal(res.headers.Location, 'http://127.0.0.1:7317/?token=test-admin-token')
  assert.equal(res.headers['Cache-Control'], 'no-store')
})

test('GET /api/dsh/open refuses non-loopback callers', async (t) => {
  const { handler } = await setup(t)
  const res = await callRoute(handler, { method: 'GET', pathname: '/api/dsh/open', remoteAddress: '192.168.1.20' })
  assert.equal(res.statusCode, 403)
  assert.equal(JSON.parse(res.text).error.code, 'forbidden')
  assert.equal(res.headers.Location, undefined)
})

// 测试进程同样运行在受限沙箱里：git 的输出用临时文件收集（与插件 Host 的实现一致）。
function runGitInTest(cwd, args) {
  const logFile = path.join(os.tmpdir(), `battlestar-git-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.log`)
  return new Promise((resolve, reject) => {
    let settled = false
    const fd = fs.openSync(logFile, 'w')
    const finish = (code, error) => {
      if (settled) return
      settled = true
      try { fs.closeSync(fd) } catch { /* ignore */ }
      let output = ''
      try { output = fs.readFileSync(logFile, 'utf8').trim() } catch { /* ignore */ }
      try { fs.unlinkSync(logFile) } catch { /* ignore */ }
      if (error) reject(error)
      else resolve({ code, output })
    }
    const child = spawn('git', args, { cwd, stdio: ['ignore', fd, fd], windowsHide: true })
    child.on('error', (err) => finish(null, err))
    child.on('close', (code) => finish(code))
  })
}

test('POST /api/dsh/git-push refuses non-loopback callers', async (t) => {
  const { handler } = await setup(t)
  const res = await callRoute(handler, {
    method: 'POST', pathname: '/api/dsh/git-push', body: {}, remoteAddress: '192.168.1.20',
  })
  assert.equal(res.statusCode, 403)
  assert.equal(JSON.parse(res.text).error.code, 'forbidden')
})

test('POST /api/dsh/git-push reports a missing git repository instead of failing', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'battlestar-norepo-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const { handler } = await setup(t, { projectRoot: root })
  const res = await callRoute(handler, { method: 'POST', pathname: '/api/dsh/git-push', body: {} })
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.text)
  assert.equal(payload.ok, false)
  assert.equal(payload.code, 'no_repo')
  assert.match(payload.message, /没有找到 git 仓库/)
})

test('POST /api/dsh/git-push explains a repository without remotes', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'battlestar-noremote-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const repo = path.join(root, 'repo')
  await fsp.mkdir(repo)
  const git = async (args) => {
    const res = await runGitInTest(repo, args)
    assert.equal(res.code, 0, `git ${args.join(' ')} 失败：${res.output}`)
    return res
  }
  await git(['init', '-b', 'main'])
  await git(['config', 'user.email', 'dev@battlestar.local'])
  await git(['config', 'user.name', 'BattleStar Test'])
  await fsp.writeFile(path.join(repo, 'note.txt'), 'hello\n', 'utf8')
  await git(['add', '-A'])
  await git(['commit', '-m', 'init'])

  const { handler } = await setup(t, { projectRoot: repo })
  const res = await callRoute(handler, { method: 'POST', pathname: '/api/dsh/git-push', body: {} })
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.text)
  assert.equal(payload.ok, false)
  assert.equal(payload.code, 'no_remote')
  assert.match(payload.message, /没有配置远端/)
})

test('GET /api/dsh/git-push reports the repository, branch and remote', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'battlestar-gitinfo-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const repo = path.join(root, 'repo')
  await fsp.mkdir(repo)
  const git = async (args, cwd = repo) => {
    const res = await runGitInTest(cwd, args)
    assert.equal(res.code, 0, `git ${args.join(' ')} 失败：${res.output}`)
    return res
  }
  await git(['init', '-b', 'main'])
  await git(['config', 'user.email', 'dev@battlestar.local'])
  await git(['config', 'user.name', 'BattleStar Test'])
  await fsp.writeFile(path.join(repo, 'note.txt'), 'hello\n', 'utf8')
  await git(['add', '-A'])
  await git(['commit', '-m', 'init'])
  await git(['remote', 'add', 'origin', path.join(root, 'remote.git')])

  const { handler } = await setup(t, { projectRoot: repo })
  const res = await callRoute(handler, { method: 'GET', pathname: '/api/dsh/git-push' })
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.text)
  assert.ok(payload.repo.endsWith('repo'), `unexpected repo: ${payload.repo}`)
  assert.equal(payload.branch, 'main')
  assert.equal(payload.remote, 'origin')
  assert.equal(payload.upstream, '', 'a freshly created repo has no upstream yet')
})

test('POST /api/dsh/git-push pushes the current branch to the configured remote', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'battlestar-gitpush-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const repo = path.join(root, 'repo')
  const remote = path.join(root, 'remote.git')
  await fsp.mkdir(repo)
  const git = async (args, cwd = repo) => {
    const res = await runGitInTest(cwd, args)
    assert.equal(res.code, 0, `git ${args.join(' ')} 失败：${res.output}`)
    return res
  }
  await git(['init', '--bare', remote], root)
  await git(['init', '-b', 'main'])
  await git(['config', 'user.email', 'dev@battlestar.local'])
  await git(['config', 'user.name', 'BattleStar Test'])
  await git(['config', 'push.default', 'current'])
  await fsp.writeFile(path.join(repo, 'note.txt'), 'hello\n', 'utf8')
  await git(['add', '-A'])
  await git(['commit', '-m', 'init'])
  await git(['remote', 'add', 'origin', remote])

  const { handler } = await setup(t, { projectRoot: repo })
  const res = await callRoute(handler, { method: 'POST', pathname: '/api/dsh/git-push', body: {} })
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.text)
  // DSH 的文件沙箱禁止 MSYS 的 sh 创建命名对象，本地 file 传输会因此失败；
  // 这是测试环境限制而不是功能缺陷（插件 Host 进程不在该沙箱内）。
  if (!payload.ok && /NtCreateDirectoryObject|Could not read from remote repository/.test(String(payload.output || ''))) {
    t.skip('当前沙箱禁止 MSYS sh 创建命名对象，真实 git push 只能在沙箱外验证')
    return
  }
  assert.equal(payload.ok, true, payload.output)
  assert.equal(payload.branch, 'main')
  assert.equal(payload.remote, 'origin')
  assert.equal(payload.setUpstream, true, 'the first push sets the upstream branch automatically')
  assert.match(payload.message, /设置上游分支/)
  assert.match(payload.output, /main/i, 'git push output is returned to the panel')

  const upstreamRef = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  assert.equal(upstreamRef.output, 'origin/main', 'the branch now tracks origin/main')

  const remoteHead = await runGitInTest(remote, ['rev-parse', 'refs/heads/main'])
  assert.equal(remoteHead.code, 0, remoteHead.output)
  const localHead = await git(['rev-parse', 'HEAD'])
  assert.equal(remoteHead.output, localHead.output, 'the remote received the local commit')

  // 第二次推送已有上游，应走普通 `git push`（不再带 --set-upstream）。
  const second = await callRoute(handler, { method: 'POST', pathname: '/api/dsh/git-push', body: {} })
  assert.equal(second.statusCode, 200)
  const secondPayload = JSON.parse(second.text)
  assert.equal(secondPayload.ok, true, secondPayload.output)
  assert.equal(secondPayload.setUpstream, false)
  assert.equal(secondPayload.upstream, 'origin/main')
  assert.match(secondPayload.message, /已推送到远端/)
})

test('settings fall back to a local secrets file when the credentials service is unavailable', async (t) => {
  const { dataDir, handler } = await setup(t)
  const saved = await callRoute(handler, {
    method: 'POST',
    pathname: '/api/settings',
    body: { secrets: { githubToken: 'ghp_test_placeholder' } },
  })
  assert.equal(saved.statusCode, 200)
  const savedPayload = JSON.parse(saved.text)
  assert.equal(savedPayload.credentials.available, false)
  assert.equal(savedPayload.credentials.storage, 'plugin-local')
  const github = savedPayload.secrets.find((item) => item.key === 'githubToken')
  assert.equal(github.configured, true)
  assert.equal(github.source, 'plugin-local')
  assert.equal(github.writable, true)

  const secretFile = path.join(dataDir, 'plugin-secrets.json')
  const stored = JSON.parse(await fsp.readFile(secretFile, 'utf8'))
  assert.equal(stored.githubToken, 'ghp_test_placeholder')

  // 再次读取设置时仍能看到本机文件里的密钥。
  const listed = await callRoute(handler, { method: 'GET', pathname: '/api/settings' })
  const listedPayload = JSON.parse(listed.text)
  assert.equal(listedPayload.credentials.available, false)
  assert.equal(listedPayload.secrets.find((item) => item.key === 'githubToken').configured, true)

  // 清除后本机文件里的条目也应消失。
  const cleared = await callRoute(handler, {
    method: 'POST',
    pathname: '/api/settings',
    body: { clearSecrets: ['githubToken'] },
  })
  const clearedPayload = JSON.parse(cleared.text)
  assert.equal(clearedPayload.secrets.find((item) => item.key === 'githubToken').configured, false)
  const afterClear = JSON.parse(await fsp.readFile(secretFile, 'utf8'))
  assert.equal(afterClear.githubToken, undefined)
})

test('settings prefer the Harness credentials service when it is available', async (t) => {
  const store = new Map()
  const credentials = {
    async describe(ref) {
      return { configured: store.has(ref), source: store.has(ref) ? 'file' : '', writable: true }
    },
    async resolve(ref) {
      return store.has(ref) ? { value: store.get(ref) } : null
    },
    async set(ref, value) {
      store.set(ref, value)
      return true
    },
    async unset(ref) {
      store.delete(ref)
    },
  }
  const { dataDir, handler } = await setup(t, { credentials })
  const saved = await callRoute(handler, {
    method: 'POST',
    pathname: '/api/settings',
    body: { secrets: { deepseekApiKey: 'sk-test-placeholder' } },
  })
  assert.equal(saved.statusCode, 200)
  const payload = JSON.parse(saved.text)
  assert.equal(payload.credentials.available, true)
  assert.equal(payload.credentials.storage, 'harness')
  assert.equal(store.get('SUPER_BUTLER_DEEPSEEK_API_KEY'), 'sk-test-placeholder')
  const listed = await callRoute(handler, { method: 'GET', pathname: '/api/settings' })
  const info = JSON.parse(listed.text).secrets.find((item) => item.key === 'deepseekApiKey')
  assert.equal(info.configured, true)
  assert.equal(info.source, 'file')
  // 走 Harness 凭据时不应再写本机兜底文件。
  await assert.rejects(fsp.stat(path.join(dataDir, 'plugin-secrets.json')))
})

test('POST /api/hub/restart asks a running Hub to self-restart in place', async (t) => {
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const pathname = new URL(String(url)).pathname
    const method = String(init.method || 'GET').toUpperCase()
    calls.push({ pathname, method })
    if (pathname === '/api/health') return jsonResponse({ ok: true, name: 'BattleStar', version: 'test' })
    if (pathname === '/api/system/restart') return jsonResponse({ ok: true, restarting: true }, 202)
    return jsonResponse({ error: { code: 'not_found', message: '未知路由' } }, 404)
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const { handler } = await setup(t)
  const lan = await callRoute(handler, { method: 'POST', pathname: '/api/hub/restart', remoteAddress: '192.168.1.20' })
  assert.equal(lan.statusCode, 403, 'hub control routes stay loopback-only')
  const res = await callRoute(handler, { method: 'POST', pathname: '/api/hub/restart' })
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.text)
  assert.equal(payload.ok, true)
  assert.equal(payload.restarting, true)
  assert.ok(
    calls.some((item) => item.pathname === '/api/system/restart' && item.method === 'POST'),
    'the plugin must call the Hub self-restart endpoint instead of killing an external process',
  )
})

test('POST /api/hub/restart explains an external Hub without self-restart', async (t) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const pathname = new URL(String(url)).pathname
    if (pathname === '/api/health') return jsonResponse({ ok: true, name: 'BattleStar', version: 'test' })
    return jsonResponse({ error: { code: 'conflict', message: '未启用自重启' } }, 403)
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const { handler } = await setup(t)
  const res = await callRoute(handler, { method: 'POST', pathname: '/api/hub/restart' })
  assert.equal(res.statusCode, 409)
  const payload = JSON.parse(res.text)
  assert.equal(payload.ok, false)
  assert.match(payload.reason, /外部进程/)
})

test('apply syncs the current DSH bridge URL to the Hub and the data dir', async (t) => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: String(init.method || 'GET').toUpperCase(), body: init.body })
    return jsonResponse({ url: 'http://127.0.0.1:60974/super-butler/api/dsh' })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const { dataDir } = await setup(t, { webOrigin: 'http://127.0.0.1:60974' })
  const bridgeFile = path.join(dataDir, 'dsh-bridge.json')
  const deadline = Date.now() + 3000
  let stored = null
  while (Date.now() < deadline) {
    try {
      stored = JSON.parse(await fsp.readFile(bridgeFile, 'utf8'))
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  assert.ok(stored, 'the plugin must write <dataDir>/dsh-bridge.json at startup')
  assert.equal(stored.url, 'http://127.0.0.1:60974/super-butler/api/dsh')
  assert.equal(stored.source, 'dsh-plugin')

  const deadlinePost = Date.now() + 3000
  let post = null
  while (Date.now() < deadlinePost) {
    post = calls.find((item) => item.url.endsWith('/api/dsh/bridge') && item.method === 'POST')
    if (post) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.ok(post, 'the running Hub should be told about the new bridge URL')
  assert.equal(JSON.parse(String(post.body)).url, 'http://127.0.0.1:60974/super-butler/api/dsh')
})
