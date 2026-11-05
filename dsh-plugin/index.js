/**
 * BattleStar · DSH Host 插件
 *
 * 职责：
 *  1. 在 DSH 内管理本机管家 Hub（检测已有 Hub / 自动启动 / 停止），并代理其 API；
 *  2. 提供 /super-butler/api/* 路由给 Client 面板（状态、设备/任务快照、建任务、取消/重试、设置）；
 *  3. 通过 Harness credentials 服务统一保存私人密钥（GitHub、DeepSeek、Agnes、豆包、OpenCode），
 *     启动 Hub 时解析为环境变量，供管家与各设备使用。
 *
 * 配置（cordis.patch.yml 的 config）：
 *   projectRoot  管家项目根目录
 *   hubPort      Hub 端口（默认 7317）
 *   hubHost      绑定地址（默认 127.0.0.1）
 *   autoStart    插件加载时自动启动 Hub（默认 true）
 *   dataDir      Hub 数据目录（默认 <projectRoot>/hub/data）
 *   adminToken / joinCode  可选，覆盖自动生成（通常留空，从 state.json 读取）
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const ROUTE_PREFIX = '/super-butler'
const MAX_BODY_BYTES = 1024 * 1024

const SECRET_FIELDS = [
  { key: 'githubToken', ref: 'SUPER_BUTLER_GITHUB_TOKEN', label: 'GitHub Token', env: 'GITHUB_TOKEN' },
  { key: 'deepseekApiKey', ref: 'SUPER_BUTLER_DEEPSEEK_API_KEY', label: 'DeepSeek API Key', env: 'DEEPSEEK_API_KEY' },
  { key: 'agnesApiKey', ref: 'SUPER_BUTLER_AGNES_API_KEY', label: 'Agnes AI API Key', env: 'AGNES_API_KEY' },
  { key: 'doubaoApiKey', ref: 'SUPER_BUTLER_DOUBAO_API_KEY', label: '豆包 / 火山方舟 API Key', env: 'ARK_API_KEY' },
  { key: 'opencodeApiKey', ref: 'SUPER_BUTLER_OPENCODE_API_KEY', label: 'OpenCode API Key', env: 'OPENCODE_API_KEY' },
]

/**
 * 每个密钥的测试端点（只发只读请求，不产生模型费用）。
 * 若服务不支持 /models，会返回 unverified 而不是误报 token 无效。
 */
const CREDENTIAL_TESTS = {
  githubToken: {
    url: 'https://api.github.com/user',
    headers: (token) => ({
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'super-butler-token-test',
    }),
    describe: (data) => (data && data.login ? `GitHub 用户：${data.login}` : 'GitHub Token 有效'),
  },
  deepseekApiKey: {
    url: 'https://api.deepseek.com/models',
    headers: (token) => ({ Authorization: `Bearer ${token}` }),
    describe: (data) => {
      const count = data && Array.isArray(data.data) ? data.data.length : 0
      return count ? `DeepSeek Token 有效（可用模型 ${count} 个）` : 'DeepSeek Token 有效'
    },
  },
  agnesApiKey: {
    url: 'https://apihub.agnes-ai.com/v1/models',
    headers: (token) => ({ Authorization: `Bearer ${token}` }),
    describe: () => 'Agnes AI Token 有效',
  },
  doubaoApiKey: {
    url: 'https://ark.cn-beijing.volces.com/api/v3/models',
    headers: (token) => ({ Authorization: `Bearer ${token}` }),
    describe: () => '豆包 / 火山方舟 Token 有效',
  },
  opencodeApiKey: {
    url: 'https://opencode.ai/zen/v1/models',
    headers: (token) => ({ Authorization: `Bearer ${token}` }),
    describe: () => 'OpenCode Token 有效',
  },
}

const SETTING_KEYS = ['projectRoot', 'hubPort', 'hubHost', 'autoStart', 'dataDir', 'githubUser', 'adminToken', 'joinCode', 'defaultModel', 'hubNickname']

function defaultProjectRoot() {
  return process.env.SUPER_BUTLER_PROJECT_ROOT
    || path.join(os.homedir(), 'super-butler')
}

function defaults() {
  const projectRoot = defaultProjectRoot()
  return {
    projectRoot,
    hubPort: 7317,
    hubHost: '0.0.0.0',
    autoStart: true,
    dataDir: path.join(projectRoot, 'hub', 'data'),
    githubUser: '',
    adminToken: '',
    joinCode: '',
    defaultModel: 'deepseek-chat',
    hubNickname: 'BattleStar母机',
  }
}

function clampInt(value, fallback, min, max) {
  const n = Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(max, Math.max(min, n))
}

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大（上限 1 MiB）'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

async function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJsonFile(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await fsp.rename(tmp, file)
}

function mask(secret) {
  if (!secret) return ''
  const s = String(secret)
  if (s.length <= 10) return `${s.slice(0, 2)}***${s.slice(-2)}`
  return `${s.slice(0, 4)}…${s.slice(-4)}`
}

export const inject = ['webServer']

export function apply(ctx, rawConfig = {}) {
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
  const base = defaults()
  const settingsFile = path.join(
    path.resolve(String(config.dataDir || base.dataDir)),
    'plugin-settings.json',
  )
  const state = {
    settings: { ...base },
    child: null,
    owned: false,
    lastError: null,
    startedAt: null,
    logFile: '',
  }
  const credentials = (() => {
    try {
      return ctx.get('credentials')
    } catch {
      return undefined
    }
  })()

  const log = (...args) => {
    try {
      console.log('[super-butler]', ...args)
    } catch {
      /* ignore */
    }
  }

  function applyConfig(next) {
    for (const key of SETTING_KEYS) {
      if (next[key] !== undefined && next[key] !== null) state.settings[key] = next[key]
    }
    state.settings.hubPort = clampInt(Number(state.settings.hubPort), 7317, 1, 65535)
    state.settings.projectRoot = path.resolve(String(state.settings.projectRoot))
    state.settings.dataDir = path.resolve(String(state.settings.dataDir || path.join(state.settings.projectRoot, 'hub', 'data')))
  }

  async function loadSettings() {
    applyConfig(config)
    const stored = await readJsonFile(settingsFile, {})
    if (stored && typeof stored === 'object') applyConfig(stored)
  }

  function publicSettings() {
    const s = state.settings
    return {
      projectRoot: s.projectRoot,
      hubPort: s.hubPort,
      hubHost: s.hubHost,
      autoStart: s.autoStart,
      dataDir: s.dataDir,
      githubUser: s.githubUser,
      defaultModel: s.defaultModel,
      hubNickname: s.hubNickname,
      adminTokenMasked: mask(s.adminToken),
      joinCodeMasked: mask(s.joinCode),
    }
  }

  async function saveSettings(next) {
    if (next && typeof next === 'object') {
      const patch = {}
      for (const key of SETTING_KEYS) {
        if (next[key] !== undefined) patch[key] = next[key]
      }
      if (typeof patch.hubPort !== 'undefined') patch.hubPort = clampInt(Number(patch.hubPort), state.settings.hubPort, 1, 65535)
      if (typeof patch.projectRoot === 'string') patch.projectRoot = path.resolve(patch.projectRoot)
      if (typeof patch.autoStart !== 'undefined') patch.autoStart = Boolean(patch.autoStart)
      applyConfig(patch)
    }
    const stored = {
      projectRoot: state.settings.projectRoot,
      hubPort: state.settings.hubPort,
      hubHost: state.settings.hubHost,
      autoStart: state.settings.autoStart,
      dataDir: state.settings.dataDir,
      githubUser: state.settings.githubUser,
      defaultModel: state.settings.defaultModel,
      hubNickname: state.settings.hubNickname,
      adminToken: state.settings.adminToken,
      joinCode: state.settings.joinCode,
    }
    await writeJsonFile(settingsFile, stored)
    return publicSettings()
  }

  function hubScript() {
    return path.join(state.settings.projectRoot, 'hub', 'server.js')
  }

  function hubOrigin() {
    return `http://127.0.0.1:${state.settings.hubPort}`
  }

  async function hubHealth(timeoutMs = 1500) {
    try {
      const res = await fetch(`${hubOrigin()}/api/health`, {
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) return null
      return await res.json()
    } catch {
      return null
    }
  }

  async function hubState() {
    return readJsonFile(path.join(state.settings.dataDir, 'state.json'), null)
  }

  async function hubAdminToken() {
    const s = await hubState()
    return state.settings.adminToken || (s && s.adminToken) || ''
  }

  async function hubJoinCode() {
    const s = await hubState()
    return state.settings.joinCode || (s && s.joinCode) || ''
  }

  async function resolveSecrets() {
    const out = {}
    if (!credentials) return out
    for (const field of SECRET_FIELDS) {
      try {
        const resolved = await credentials.resolve(field.ref)
        if (resolved && resolved.value) out[field.env] = resolved.value
      } catch {
        /* 未配置或服务不可用 */
      }
    }
    return out
  }

  async function spawnHub() {
    if (state.child) return
    const script = hubScript()
    if (!fs.existsSync(script)) throw new Error(`找不到 Hub 脚本：${script}`)
    await fsp.mkdir(state.settings.dataDir, { recursive: true })
    state.logFile = path.join(state.settings.dataDir, 'plugin-hub.log')
    const fd = fs.openSync(state.logFile, 'a')
    const args = [
      script,
      '--port', String(state.settings.hubPort),
      '--host', String(state.settings.hubHost || '0.0.0.0'),
      '--data-dir', state.settings.dataDir,
    ]
    if (state.settings.adminToken) args.push('--admin-token', String(state.settings.adminToken))
    if (state.settings.joinCode) args.push('--join-code', String(state.settings.joinCode))
    const secrets = await resolveSecrets()
    const env = { ...process.env, ...secrets, NO_COLOR: '1' }
    const child = spawn(process.execPath, args, {
      cwd: state.settings.projectRoot,
      env,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    })
    state.child = child
    state.owned = true
    state.startedAt = new Date().toISOString()
    log('Hub 启动中', { pid: child.pid, port: state.settings.hubPort })
    child.once('exit', (code, signal) => {
      log('Hub 进程退出', { code, signal })
      state.child = null
      state.owned = false
      if (code !== 0 && code !== null) state.lastError = `Hub 进程退出（code=${code}）`
    })
  }

  async function waitHubReady(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const health = await hubHealth(800)
      if (health) return health
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    throw new Error(`Hub 在 ${Math.round(timeoutMs / 1000)}s 内未就绪，请查看 ${state.logFile || 'Hub 日志'}`)
  }

  async function ensureHub() {
    const health = await hubHealth()
    if (health) return health
    if (state.settings.autoStart === false && !state.child) {
      throw new Error('Hub 未运行（autoStart 已关闭）')
    }
    await spawnHub()
    return waitHubReady()
  }

  async function stopHub() {
    if (!state.child) {
      return { stopped: false, reason: 'Hub 不是由插件启动的（可能由终端手动运行），请到对应终端停止' }
    }
    const child = state.child
    try {
      child.kill('SIGTERM')
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    state.child = null
    state.owned = false
    return { stopped: true }
  }

  async function hubRequest(pathname, options = {}) {
    await ensureHub()
    const token = await hubAdminToken()
    const headers = {}
    if (token) headers['X-Butler-Token'] = token
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetch(`${hubOrigin()}${pathname}`, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs || 20000),
    })
    const text = await res.text()
    let data
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = { raw: text }
    }
    return { status: res.status, data }
  }

  async function secretStatus() {
    const list = []
    for (const field of SECRET_FIELDS) {
      let configured = false
      let source = ''
      let writable = false
      if (credentials && typeof credentials.describe === 'function') {
        try {
          const info = await credentials.describe(field.ref)
          configured = Boolean(info && info.configured)
          source = (info && info.source) || ''
          writable = Boolean(info && info.writable)
        } catch {
          /* ignore */
        }
      }
      list.push({ key: field.key, ref: field.ref, label: field.label, configured, source, writable })
    }
    return list
  }

  async function setSecret(key, value) {
    const field = SECRET_FIELDS.find((item) => item.key === key)
    if (!field) throw new Error(`未知密钥：${key}`)
    if (!credentials) throw new Error('credentials 服务不可用，无法保存密钥')
    const text = typeof value === 'string' ? value.trim() : ''
    if (!text) return { key, cleared: false }
    await credentials.set(field.ref, text)
    return { key, saved: true }
  }

  async function clearSecret(key) {
    const field = SECRET_FIELDS.find((item) => item.key === key)
    if (!field) throw new Error(`未知密钥：${key}`)
    if (!credentials) throw new Error('credentials 服务不可用，无法清除密钥')
    await credentials.unset(field.ref)
    return { key, cleared: true }
  }

  async function testCredential(key) {
    const field = SECRET_FIELDS.find((item) => item.key === key)
    if (!field) return { ok: false, status: 'unknown', message: `未知密钥：${key}` }
    const spec = CREDENTIAL_TESTS[key]
    if (!spec) return { ok: false, status: 'unsupported', message: '该密钥没有测试端点' }
    if (!credentials) return { ok: false, status: 'error', message: 'credentials 服务不可用' }
    let resolved
    try {
      resolved = await credentials.resolve(field.ref)
    } catch (err) {
      return { ok: false, status: 'error', message: `读取密钥失败：${err.message}` }
    }
    if (!resolved || !resolved.value) {
      return { ok: false, status: 'missing', message: '未配置 Token', configured: false }
    }
    const startedAt = Date.now()
    try {
      const res = await fetch(spec.url, {
        method: 'GET',
        headers: spec.headers(resolved.value),
        signal: AbortSignal.timeout(15000),
      })
      const latencyMs = Date.now() - startedAt
      const text = await res.text()
      let data = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        data = null
      }
      if (res.ok) {
        return {
          ok: true,
          status: 'ok',
          httpStatus: res.status,
          latencyMs,
          message: spec.describe(data),
        }
      }
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          status: 'invalid',
          httpStatus: res.status,
          latencyMs,
          message: `Token 无效或权限不足（HTTP ${res.status}）`,
        }
      }
      return {
        ok: false,
        status: 'unverified',
        httpStatus: res.status,
        latencyMs,
        message: `端点返回 HTTP ${res.status}，无法仅凭此判定 Token（服务可能不支持该只读接口）`,
      }
    } catch (err) {
      return {
        ok: false,
        status: 'error',
        latencyMs: Date.now() - startedAt,
        message: `测试请求失败：${err && err.message ? err.message : String(err)}`,
      }
    }
  }

  async function statusPayload() {
    const health = await hubHealth()
    const joinCode = health ? await hubJoinCode() : ''
    return {
      hub: {
        running: Boolean(health),
        owned: Boolean(state.child),
        port: state.settings.hubPort,
        origin: hubOrigin(),
        health,
        joinCode,
        joinCodeMasked: mask(joinCode),
        logFile: state.logFile,
        lastError: state.lastError,
        startedAt: state.startedAt,
      },
      settings: publicSettings(),
      secrets: await secretStatus(),
      serverTime: new Date().toISOString(),
    }
  }

  const routeHandler = async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const pathname = url.pathname || ''
    let sub = pathname.slice(ROUTE_PREFIX.length) || '/'
    if (!sub.startsWith('/')) sub = `/${sub}`
    const method = (req.method || 'GET').toUpperCase()
    try {
      if (method === 'GET' && (sub === '/api/status' || sub === '/api/status/')) {
        return json(res, 200, await statusPayload())
      }
      if (method === 'GET' && sub === '/api/settings') {
        return json(res, 200, { settings: publicSettings(), secrets: await secretStatus() })
      }
      if (method === 'POST' && sub === '/api/settings') {
        const body = await readBody(req)
        const updated = await saveSettings(body.settings || {})
        const results = []
        const secrets = body.secrets && typeof body.secrets === 'object' ? body.secrets : {}
        for (const field of SECRET_FIELDS) {
          if (typeof secrets[field.key] === 'string' && secrets[field.key].trim()) {
            results.push(await setSecret(field.key, secrets[field.key]))
          }
        }
        for (const key of Array.isArray(body.clearSecrets) ? body.clearSecrets : []) {
          results.push(await clearSecret(key))
        }
        return json(res, 200, { settings: updated, secrets: await secretStatus(), results })
      }
      if (method === 'POST' && sub === '/api/test-credential') {
        const body = await readBody(req)
        const key = typeof body.key === 'string' ? body.key : ''
        return json(res, 200, await testCredential(key))
      }
      if (method === 'GET' && sub === '/api/snapshot') {
        const limit = clampInt(Number(url.searchParams.get('limit')), 50, 1, 200)
        const out = await hubRequest(`/api/snapshot?limit=${limit}`)
        return json(res, out.status, out.data)
      }
      if (method === 'POST' && sub === '/api/tasks') {
        const body = await readBody(req)
        const out = await hubRequest('/api/tasks', { method: 'POST', body })
        return json(res, out.status, out.data)
      }
      const taskAction = /^\/api\/tasks\/([^/]+)\/(cancel|retry)$/.exec(sub)
      if (method === 'POST' && taskAction) {
        const out = await hubRequest(`/api/tasks/${encodeURIComponent(taskAction[1])}/${taskAction[2]}`, {
          method: 'POST',
          body: {},
        })
        return json(res, out.status, out.data)
      }
      const devicePath = /^\/api\/devices\/([^/]+)$/.exec(sub)
      if (devicePath && method === 'PATCH') {
        const body = await readBody(req)
        const out = await hubRequest(`/api/devices/${encodeURIComponent(devicePath[1])}`, {
          method: 'PATCH',
          body,
        })
        return json(res, out.status, out.data)
      }
      if (method === 'POST' && sub === '/api/hub/start') {
        await ensureHub()
        return json(res, 200, { ok: true, hub: (await statusPayload()).hub })
      }
      if (method === 'POST' && sub === '/api/hub/stop') {
        const result = await stopHub()
        return json(res, 200, { ok: result.stopped, result, hub: (await statusPayload()).hub })
      }
      if (method === 'GET' && (sub === '/' || sub === '')) {
        return json(res, 200, {
          name: 'BattleStar',
          routes: ['/api/status', '/api/settings', '/api/snapshot', '/api/tasks', '/api/devices/:id', '/api/test-credential', '/api/hub/start', '/api/hub/stop'],
        })
      }
      return json(res, 404, { error: { code: 'not_found', message: `未知路由：${method} ${sub}` } })
    } catch (err) {
      return json(res, 500, { error: { code: 'battlestar_error', message: err && err.message ? err.message : String(err) } })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: routeHandler }), 'super-butler: http routes')

  ctx.effect(() => {
    void loadSettings()
      .then(() => {
        if (state.settings.autoStart) return ensureHub()
        return null
      })
      .catch((err) => {
        state.lastError = err && err.message ? err.message : String(err)
        log('启动失败：', state.lastError)
      })
    return () => {
      try {
        if (state.child) state.child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
    }
  }, 'super-butler: hub lifecycle')

  log('已加载', { projectRoot: state.settings.projectRoot, port: state.settings.hubPort })
}
