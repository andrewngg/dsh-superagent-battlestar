/**
 * BattleStar · DSH Host 插件
 *
 * 职责：
 *  1. 在 DSH 内管理本机管家 Hub（检测已有 Hub / 自动启动 / 停止），并代理其 API；
 *  2. 提供 /super-butler/api/* 路由给 Client 面板（状态、设备/任务快照、建任务、取消/重试、
 *     手动改状态、继续/回答、设置）；
 *  3. 通过 Harness credentials 服务统一保存私人密钥（GitHub、DeepSeek、Agnes、豆包、OpenCode），
 *     启动 Hub 时解析为环境变量，供管家与各设备使用。若该服务在插件运行时不可用（例如 Harness
 *     升级后 provider 尚未激活），密钥会退回保存到本机 <dataDir>/plugin-secrets.json（0600），
 *     并在设置页明确标注存储位置，保证「保存密钥」始终可用。
 *
 * 配置（cordis.patch.yml 的 config）：
 *   projectRoot  管家项目根目录
 *   hubPort      Hub 端口（默认 7317）
 *   hubHost      绑定地址（默认 127.0.0.1）
 *   autoStart    插件加载时自动启动 Hub（默认 true）
 *   dataDir      Hub 数据目录（默认 <projectRoot>/hub/data）
 *   devWorkspacePath  Developer Mode 会话归属的 DSH 工作区目录（默认自动选包含 projectRoot 的工作区，
 *                     例如 projectRoot 在 super ai 项目内时，开发指令会话会挂到「super ai」工作区）
 *   adminToken / joinCode  可选，覆盖自动生成（通常留空，从 state.json 读取）
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const ROUTE_PREFIX = '/super-butler'
const MAX_BODY_BYTES = 1024 * 1024
// 面板“手动改状态”允许的目标状态：完成/失败走 external-result，取消/重新排队走 cancel/retry。
const MANUAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled', 'queued'])
const MANUAL_FINISH_STATUSES = new Set(['completed', 'failed'])
// 与 Hub 一致：这些状态下任务仍占用设备，改终态前必须先 cancel，避免设备继续执行。
const ACTIVE_TASK_STATUSES = new Set(['queued', 'assigned', 'running', 'waiting'])

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

const SETTING_KEYS = ['projectRoot', 'hubPort', 'hubHost', 'autoStart', 'dataDir', 'devWorkspacePath', 'githubUser', 'adminToken', 'joinCode', 'defaultModel', 'hubNickname']

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
    devWorkspacePath: '',
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
  const secretsFile = path.join(path.dirname(settingsFile), 'plugin-secrets.json')
  const state = {
    settings: { ...base },
    child: null,
    owned: false,
    lastError: null,
    startedAt: null,
    logFile: '',
    // credentials 服务不可用时的本机兜底密钥；只落盘到 <dataDir>/plugin-secrets.json（0600）。
    localSecrets: {},
  }
  /**
   * Harness 的 credentials 服务由凭据 provider 插件注册，可能晚于本插件挂载（升级后尤其如此）。
   * 这里每次用到时再取一次：ctx.get 是 peek，不受 inject 限制，取不到就返回 undefined 交给调用方
   * 走本机兜底文件；这样不会把挂载瞬间的一次性 undefined 永久缓存下来。
   */
  function resolveCredentials() {
    try {
      const service = ctx.get('credentials')
      if (service && typeof service.set === 'function') return service
    } catch {
      /* 服务尚未注册或 provider 未激活 */
    }
    return undefined
  }
  /**
   * DSH 的 Host 服务同样只在用到时解析：Harness 重启/升级后，服务可能比插件挂载晚激活，
   * 一次性捕获会把挂载瞬间的 undefined 永久缓存下来（credentials 就踩过这个坑）。
   */
  function resolveSessionController() {
    try {
      const service = ctx.get('sessionController')
      if (service && typeof service.create === 'function') return service
    } catch {
      /* 服务尚未注册或尚未激活 */
    }
    return undefined
  }

  function resolveApproval() {
    try {
      const service = ctx.get('approval')
      if (service && typeof service.setPolicy === 'function') return service
    } catch {
      /* approval 是可选服务 */
    }
    return undefined
  }

  function resolveWorkspaceRegistry() {
    try {
      const registry = ctx.get('workspaceRegistry')
      if (registry) return registry
    } catch {
      /* 回退到上下文属性 */
    }
    try {
      return ctx.workspaceRegistry
    } catch {
      return undefined
    }
  }
  const devState = { sessionId: '', sessionWorkspaceId: '', sessionWorkspacePath: '', jobSeq: 0, jobs: new Map() }

  const DEV_SCOPES = {
    global: {
      label: '全局 · 整套系统',
      paths: '整个 super-butler 仓库',
      rule: '可以修改仓库内任何组件；改动前先判断影响范围。',
    },
    plugin: {
      label: 'DSH 插件',
      paths: 'dsh-plugin/**',
      rule: '只允许修改 dsh-plugin/**。如果需求必须改 Hub、APK 或网页，先停下来告诉用户切换到「全局」。',
    },
    apk: {
      label: 'APK',
      paths: 'android/** 以及 dist/** 中的构建产物',
      rule: '只允许修改 android/** 和 dist/**。不要自动安装 APK；构建后告诉用户自己安装。',
    },
    localhost: {
      label: 'Localhost 界面',
      paths: 'hub/web/**',
      rule: '只允许修改 hub/web/**（Hub 本地网页/手机 WebView 界面）。不要修改 Hub 后端、插件或 APK。',
    },
  }

  function normalizeDevScope(value) {
    return Object.prototype.hasOwnProperty.call(DEV_SCOPES, value) ? value : 'global'
  }

  function devPrefix(scope) {
    const target = DEV_SCOPES[scope] || DEV_SCOPES.global
    return [
      '你是 BattleStar Developer Mode，运行在 DeepSeek Harness 里。',
      `只能修改这个仓库：${state.settings.projectRoot}`,
      `本次改动对象：${target.label}`,
      `本次允许修改的文件范围：${target.paths}`,
      target.rule,
      '不要读取、输出或提交私人 token、密钥、密码、个人隐私数据；不要把这些信息写进公开仓库。',
      '用户允许你直接修改代码，不需要逐文件确认；修改后请运行相关测试，并简要汇报改了哪些文件、测试结果。',
      '不要执行 git push，除非用户在消息里明确要求。',
    ].join('\n')
  }

  function dshAvailable() {
    const service = resolveSessionController()
    return Boolean(service && typeof service.create === 'function')
  }

  /** 路径比较用：Windows 不区分大小写，去掉尾部分隔符。 */
  function comparablePath(value) {
    const resolved = path.resolve(String(value || '')).replace(/[\\/]+$/, '')
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }

  /**
   * Developer Mode 会话要挂到哪个 DSH 工作区。
   * 优先用 devWorkspacePath 显式配置；否则选包含 projectRoot 的最近工作区
   * （例如 projectRoot = <...>/super ai/super-butler 时命中「super ai」工作区）。
   * 找不到返回 null，退回旧的 cwd 创建方式（会话会显示在「未分组」）。
   */
  function resolveDevWorkspace() {
    const registry = resolveWorkspaceRegistry()
    if (!registry || typeof registry.list !== 'function') return null
    let workspaces
    try {
      workspaces = registry.list()
    } catch {
      return null
    }
    const usable = (Array.isArray(workspaces) ? workspaces : []).filter(
      (workspace) => workspace && typeof workspace.path === 'string' && workspace.path,
    )
    if (usable.length === 0) return null
    const explicit = String(state.settings.devWorkspacePath || '').trim()
    if (explicit) {
      const wanted = comparablePath(explicit)
      return usable.find((workspace) => comparablePath(workspace.path) === wanted) || null
    }
    const root = comparablePath(state.settings.projectRoot)
    let best = null
    let bestLength = -1
    for (const workspace of usable) {
      const dir = comparablePath(workspace.path)
      if (dir === root) return workspace
      const prefix = `${dir}${path.sep}`
      if (root.startsWith(prefix) && dir.length > bestLength) {
        best = workspace
        bestLength = dir.length
      }
    }
    return best
  }

  function extractAssistantText(frame) {
    if (!frame || typeof frame !== 'object') return ''
    const event = frame.type === 'event' ? frame.event : null
    if (!event || event.type !== 'assistant/message') return ''
    const content = event.data && event.data.message && event.data.message.content
    if (!Array.isArray(content)) return ''
    return content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
  }

  function summarizeFrame(job, frame) {
    if (!frame || typeof frame !== 'object') return
    const event = frame.type === 'event' ? frame.event : null
    if (!event) return
    if (event.type === 'tool/call') {
      const name = event.data && event.data.name ? String(event.data.name) : 'tool'
      job.logs.push(`调用工具：${name}`)
      if (job.logs.length > 40) job.logs.splice(0, job.logs.length - 40)
    }
    if (event.type === 'tool/result') {
      const message = event.data && event.data.message
      const text = message && Array.isArray(message.content)
        ? message.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('').slice(0, 240)
        : ''
      if (text) job.logs.push(`工具结果：${text.replace(/\s+/g, ' ').trim()}`)
    }
  }

  async function ensureDevSession() {
    if (devState.sessionId) return devState.sessionId
    const session = resolveSessionController()
    if (!session) throw new Error('DSH sessionController 不可用：宿主插件还没拿到该服务，请完全重启 DeepSeek Harness 后重试')
    const workspace = resolveDevWorkspace()
    let created
    let attached = workspace
    if (workspace) {
      try {
        created = await session.create({ workspaceId: workspace.id })
      } catch (err) {
        // 工作区挂载失败时不能让开发指令直接失败，退回旧的 cwd 创建（会话会显示在「未分组」）。
        log(`Developer Mode 会话挂载工作区失败：${err && err.message ? err.message : err}；改为 cwd 创建`)
        attached = null
        created = await session.create({ cwd: state.settings.projectRoot })
      }
    } else {
      created = await session.create({ cwd: state.settings.projectRoot })
    }
    if (!created || !created.sessionId) throw new Error('DSH 未返回 sessionId')
    devState.sessionId = String(created.sessionId)
    devState.sessionWorkspaceId = attached ? String(attached.id) : ''
    devState.sessionWorkspacePath = attached ? String(attached.path) : ''
    log(
      `Developer Mode 会话 ${devState.sessionId} 归属：${
        attached ? `${attached.title}（${attached.path}）` : '未分组（没有匹配的工作区）'
      }`,
    )
    return devState.sessionId
  }

  async function runDevJob(job, message, scope = 'global') {
    let abort
    try {
      const session = resolveSessionController()
      if (!session) throw new Error('DSH sessionController 不可用：宿主插件还没拿到该服务，请完全重启 DeepSeek Harness 后重试')
      const sessionId = await ensureDevSession()
      job.sessionId = sessionId
      job.scope = normalizeDevScope(scope)
      const approval = resolveApproval()
      if (approval) {
        try {
          const resolved = await session.resolveAgent(sessionId)
          if (resolved && resolved.agent) approval.setPolicy(resolved.agent, 'never')
        } catch {
          /* approval 可选 */
        }
      }
      job.status = 'running'
      job.startedAt = new Date().toISOString()
      const controller = new AbortController()
      abort = controller
      job.abort = controller
      const content = [{ type: 'text', text: `${devPrefix(job.scope)}\n\n用户请求：\n${message}` }]
      await session.prompt({
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content,
      }, controller.signal)
      let finalText = ''
      let ended = false
      const deadline = Date.now() + 30 * 60 * 1000
      const timer = setTimeout(() => controller.abort(), Math.max(1000, deadline - Date.now()))
      try {
        for await (const frame of session.follow({
          address: { kind: 'session', sessionId },
          assistantStream: true,
        }, controller.signal)) {
          summarizeFrame(job, frame)
          const text = extractAssistantText(frame)
          if (text.trim()) finalText = text.trim()
          if (frame && frame.type === 'event' && frame.event && frame.event.type === 'turn/end') {
            ended = true
            break
          }
        }
      } finally {
        clearTimeout(timer)
      }
      job.text = finalText || (ended ? 'DSH 已完成修改（未返回文本）' : 'DSH 未返回最终文本')
      job.status = 'done'
      job.finishedAt = new Date().toISOString()
    } catch (err) {
      job.status = 'failed'
      job.error = err && err.message ? err.message : String(err)
      job.finishedAt = new Date().toISOString()
    } finally {
      if (abort) {
        try {
          abort.abort()
        } catch {
          /* ignore */
        }
      }
    }
  }

  function publicJob(job) {
    return {
      id: job.id,
      status: job.status,
      sessionId: job.sessionId || '',
      scope: job.scope || 'global',
      text: job.text || '',
      error: job.error || '',
      logs: job.logs.slice(-20),
      createdAt: job.createdAt,
      finishedAt: job.finishedAt || '',
    }
  }

  function isLoopback(req) {
    const raw = String((req.socket && req.socket.remoteAddress) || '')
    return raw === '127.0.0.1' || raw === '::1' || raw.endsWith('127.0.0.1')
  }

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
    const devWorkspacePath = String(state.settings.devWorkspacePath || '').trim()
    state.settings.devWorkspacePath = devWorkspacePath ? path.resolve(devWorkspacePath) : ''
  }

  async function loadSettings() {
    applyConfig(config)
    const stored = await readJsonFile(settingsFile, {})
    if (stored && typeof stored === 'object') applyConfig(stored)
    const storedSecrets = await readJsonFile(secretsFile, {})
    if (storedSecrets && typeof storedSecrets === 'object') {
      const next = {}
      for (const field of SECRET_FIELDS) {
        const value = storedSecrets[field.key]
        if (typeof value === 'string' && value.trim()) next[field.key] = value.trim()
      }
      state.localSecrets = next
    }
  }

  function publicSettings() {
    const s = state.settings
    return {
      projectRoot: s.projectRoot,
      hubPort: s.hubPort,
      hubHost: s.hubHost,
      autoStart: s.autoStart,
      dataDir: s.dataDir,
      devWorkspacePath: s.devWorkspacePath,
      githubUser: s.githubUser,
      defaultModel: s.defaultModel,
      hubNickname: s.hubNickname,
      adminTokenMasked: mask(s.adminToken),
      joinCodeMasked: mask(s.joinCode),
    }
  }

  async function saveSettings(next) {
    const previousProjectRoot = state.settings.projectRoot
    const previousDevWorkspacePath = state.settings.devWorkspacePath
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
    // 归属目标变化后，旧的 Developer Mode 会话可能仍落在「未分组」，下次开发指令重新建会话。
    if (
      state.settings.projectRoot !== previousProjectRoot ||
      state.settings.devWorkspacePath !== previousDevWorkspacePath
    ) {
      devState.sessionId = ''
      devState.sessionWorkspaceId = ''
      devState.sessionWorkspacePath = ''
    }
    const stored = {
      projectRoot: state.settings.projectRoot,
      hubPort: state.settings.hubPort,
      hubHost: state.settings.hubHost,
      autoStart: state.settings.autoStart,
      dataDir: state.settings.dataDir,
      devWorkspacePath: state.settings.devWorkspacePath,
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

  // 浏览器控制台地址：带上管理令牌，Web 控制台启动时会读取 URL 里的 token 并立即从地址栏抹掉。
  async function consoleRedirectUrl() {
    const origin = hubOrigin()
    const token = await hubAdminToken()
    return token ? `${origin}/?token=${encodeURIComponent(token)}` : `${origin}/`
  }

  // DSH 的 Web 端口每次启动都可能变化，插件要把当前 bridge 地址同步给 Hub：
  // 1) 写入 <dataDir>/dsh-bridge.json —— Hub 启动时直接读取，即使此刻 Hub 没在运行；
  // 2) Hub 正在运行时再 POST /api/dsh/bridge，让运行中的进程立刻换用新地址。
  function dshBridgeBaseUrl() {
    try {
      const server = ctx.webServer
      if (!server || typeof server.getOrigin !== 'function') return ''
      const origin = String(server.getOrigin() || '').replace(/\/+$/, '')
      if (!/^https?:\/\//.test(origin)) return ''
      return `${origin}${ROUTE_PREFIX}/api/dsh`
    } catch {
      // listen 之前的 getOrigin 会抛错，此时无法得出地址
      return ''
    }
  }

  async function syncDshBridge() {
    const url = dshBridgeBaseUrl()
    if (!url) return { ok: false, reason: 'web server 未就绪' }
    try {
      await writeJsonFile(path.join(state.settings.dataDir, 'dsh-bridge.json'), {
        url,
        updatedAt: new Date().toISOString(),
        source: 'dsh-plugin',
      })
    } catch {
      // 写盘失败也继续尝试通知运行中的 Hub
    }
    try {
      const token = await hubAdminToken()
      const res = await fetch(`${hubOrigin()}/api/dsh/bridge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Butler-Token': token } : {}) },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(2000),
      })
      return { ok: res.ok, url }
    } catch (err) {
      return { ok: false, url, reason: err && err.message ? err.message : String(err) }
    }
  }

  // 插件 apply 时 DSH 的 Web 服务可能还没 listen（getOrigin 会抛错），Hub 也可能还没起来。
  // 所以同步失败时按退避重试若干次，成功后停止；计时器 unref，不会拖住进程退出。
  const BRIDGE_SYNC_BACKOFF = [0, 800, 2500, 6000, 12000, 20000]
  const bridgeRetryTimers = new Set()
  let bridgeSyncDisposed = false
  let bridgeSyncAttempt = 0

  function scheduleBridgeSync() {
    if (bridgeSyncDisposed) return
    const delay = BRIDGE_SYNC_BACKOFF[Math.min(bridgeSyncAttempt, BRIDGE_SYNC_BACKOFF.length - 1)]
    const timer = setTimeout(() => {
      bridgeRetryTimers.delete(timer)
      if (bridgeSyncDisposed) return
      void syncDshBridge().then((result) => {
        if (bridgeSyncDisposed) return
        if (result.ok) {
          bridgeSyncAttempt = 0
          return
        }
        bridgeSyncAttempt += 1
        if (bridgeSyncAttempt < BRIDGE_SYNC_BACKOFF.length) scheduleBridgeSync()
      })
    }, delay)
    if (typeof timer.unref === 'function') timer.unref()
    bridgeRetryTimers.add(timer)
  }

  function stopBridgeSync() {
    bridgeSyncDisposed = true
    for (const timer of bridgeRetryTimers) clearTimeout(timer)
    bridgeRetryTimers.clear()
  }

  async function persistLocalSecrets() {
    await writeJsonFile(secretsFile, state.localSecrets)
  }

  async function readSecretValue(field, service) {
    if (service && typeof service.resolve === 'function') {
      try {
        const resolved = await service.resolve(field.ref)
        if (resolved && resolved.value) return resolved.value
      } catch {
        /* 未配置或服务暂时不可用，继续尝试本机兜底 */
      }
    }
    return state.localSecrets[field.key] || ''
  }

  async function resolveSecrets() {
    const out = {}
    const service = resolveCredentials()
    for (const field of SECRET_FIELDS) {
      const value = await readSecretValue(field, service)
      if (value) out[field.env] = value
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
      '--ttl-ms', '60000',
    ]
    if (state.settings.adminToken) args.push('--admin-token', String(state.settings.adminToken))
    if (state.settings.joinCode) args.push('--join-code', String(state.settings.joinCode))
    const secrets = await resolveSecrets()
    const env = { ...process.env, ...secrets, NO_COLOR: '1' }
    const bridgeUrl = dshBridgeBaseUrl()
    if (bridgeUrl) env.DSH_BRIDGE_URL = bridgeUrl
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
    if (health) {
      void syncDshBridge()
      return health
    }
    if (state.settings.autoStart === false && !state.child) {
      throw new Error('Hub 未运行（autoStart 已关闭）')
    }
    await spawnHub()
    const ready = await waitHubReady()
    void syncDshBridge()
    return ready
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

  // 重启 Hub：不要求由插件托管。优先调用 Hub 的自重启接口（进程 re-exec，等于加载新代码）；
  // Hub 没在运行时直接拉起；旧 Hub 不支持自重启时，只有插件托管的进程能停掉再启动。
  async function restartHub() {
    const health = await hubHealth()
    if (!health) {
      const ready = await ensureHub()
      return { ok: true, started: true, hub: ready }
    }
    const out = await hubRequest('/api/system/restart', {
      method: 'POST',
      body: { reason: 'dsh-plugin:restart-hub' },
      timeoutMs: 10000,
    })
    if (out.status < 400) {
      return { ok: true, restarting: true, alreadyRequested: Boolean(out.data && out.data.alreadyRequested) }
    }
    if (!state.child) {
      const detail = (out.data && out.data.error && out.data.error.message) || `HTTP ${out.status}`
      return {
        ok: false,
        reason: `这个 Hub 是外部进程，并且自重启不可用（${detail}）；请在启动它的终端重启一次`,
      }
    }
    await stopHub()
    const ready = await ensureHub()
    return { ok: true, restarted: true, hub: ready }
  }

  async function hubRequest(pathname, options = {}) {    await ensureHub()
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

  function credentialsAvailable() {
    return Boolean(resolveCredentials())
  }

  function secretStorageMode() {
    return credentialsAvailable() ? 'harness' : 'plugin-local'
  }

  async function secretStatus() {
    const service = resolveCredentials()
    const list = []
    for (const field of SECRET_FIELDS) {
      let configured = false
      let source = ''
      let writable = false
      if (service && typeof service.describe === 'function') {
        try {
          const info = await service.describe(field.ref)
          configured = Boolean(info && info.configured)
          source = (info && info.source) || ''
          writable = Boolean(info && info.writable)
        } catch {
          /* ignore */
        }
      }
      if (!configured && state.localSecrets[field.key]) {
        configured = true
        source = 'plugin-local'
        writable = true
      }
      list.push({ key: field.key, ref: field.ref, label: field.label, configured, source, writable })
    }
    return list
  }

  async function setSecret(key, value) {
    const field = SECRET_FIELDS.find((item) => item.key === key)
    if (!field) throw new Error(`未知密钥：${key}`)
    const text = typeof value === 'string' ? value.trim() : ''
    if (!text) return { key, cleared: false }
    const service = resolveCredentials()
    if (service) {
      try {
        await service.set(field.ref, text)
        if (state.localSecrets[field.key]) {
          delete state.localSecrets[field.key]
          await persistLocalSecrets()
        }
        return { key, saved: true, storage: 'harness' }
      } catch {
        /* credentials provider 写入失败时退回本机文件，避免用户保存不了密钥 */
      }
    }
    state.localSecrets[field.key] = text
    await persistLocalSecrets()
    return { key, saved: true, storage: 'plugin-local' }
  }

  async function clearSecret(key) {
    const field = SECRET_FIELDS.find((item) => item.key === key)
    if (!field) throw new Error(`未知密钥：${key}`)
    let cleared = false
    const service = resolveCredentials()
    if (service && typeof service.unset === 'function') {
      try {
        await service.unset(field.ref)
        cleared = true
      } catch {
        /* ignore */
      }
    }
    if (state.localSecrets[field.key]) {
      delete state.localSecrets[field.key]
      await persistLocalSecrets()
      cleared = true
    }
    return { key, cleared }
  }

  async function testCredential(key) {
    const field = SECRET_FIELDS.find((item) => item.key === key)
    if (!field) return { ok: false, status: 'unknown', message: `未知密钥：${key}` }
    const spec = CREDENTIAL_TESTS[key]
    if (!spec) return { ok: false, status: 'unsupported', message: '该密钥没有测试端点' }
    const service = resolveCredentials()
    let token = ''
    try {
      token = await readSecretValue(field, service)
    } catch (err) {
      return { ok: false, status: 'error', message: `读取密钥失败：${err.message}` }
    }
    if (!token) {
      return { ok: false, status: 'missing', message: '未配置 Token', configured: false }
    }
    const startedAt = Date.now()
    try {
      const res = await fetch(spec.url, {
        method: 'GET',
        headers: spec.headers(token),
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
      credentials: { available: credentialsAvailable(), storage: secretStorageMode() },
      serverTime: new Date().toISOString(),
    }
  }

  // 从 projectRoot 往上找最近的 git 仓库；找不到返回空串。
  function findGitRepo(startDir) {
    let dir = path.resolve(String(startDir || '.'))
    for (let depth = 0; depth < 8; depth += 1) {
      try {
        if (fs.existsSync(path.join(dir, '.git'))) return dir
      } catch {
        // 权限或路径异常时继续往上找
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return ''
  }

  // 在受限沙箱里直接 pipe stdio 会被拒绝，这里把子进程输出重定向到临时文件再读回。
  function runGit(cwd, args, timeoutMs = 120000) {
    const logFile = path.join(os.tmpdir(), `battlestar-git-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.log`)
    return new Promise((resolve) => {
      let fd = null
      let settled = false
      let child = null
      let timer = null
      const finish = (result) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (fd !== null) {
          try { fs.closeSync(fd) } catch { /* ignore */ }
          fd = null
        }
        let output = ''
        try { output = fs.readFileSync(logFile, 'utf8').trim() } catch { /* ignore */ }
        try { fs.unlinkSync(logFile) } catch { /* ignore */ }
        resolve({ ...result, output })
      }
      timer = setTimeout(() => {
        try { if (child) child.kill() } catch { /* ignore */ }
        finish({ code: null, timedOut: true })
      }, timeoutMs)
      try {
        fd = fs.openSync(logFile, 'w')
        child = spawn('git', args, { cwd, stdio: ['ignore', fd, fd], windowsHide: true })
      } catch (err) {
        finish({ code: null, timedOut: false, spawnError: err && err.message ? err.message : String(err) })
        return
      }
      child.on('error', (err) => finish({ code: null, timedOut: false, spawnError: err && err.message ? err.message : String(err) }))
      child.on('close', (code) => finish({ code, timedOut: false }))
    })
  }

  async function gitRepoInfo() {
    const repo = findGitRepo(state.settings.projectRoot)
    if (!repo) return { repo: '', branch: '', remote: '' }
    const branchRes = await runGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD'], 15000)
    const branch = branchRes.code === 0 ? branchRes.output : ''
    const remoteRes = await runGit(repo, ['remote'], 15000)
    const remote = remoteRes.code === 0 ? (remoteRes.output.split(/\r?\n/).filter(Boolean)[0] || '') : ''
    // 分支的跟踪上游；没有设置时（例如刚 git init 的 master）返回空串。
    const upstreamRes = await runGit(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], 15000)
    const upstream = upstreamRes.code === 0 ? upstreamRes.output.trim() : ''
    return { repo, branch, remote, upstream }
  }

  async function gitPushNow() {
    const info = await gitRepoInfo()
    if (!info.repo) {
      return {
        ok: false,
        code: 'no_repo',
        repo: '',
        branch: '',
        remote: '',
        upstream: '',
        message: `没有找到 git 仓库：${state.settings.projectRoot} 及其上级目录都没有 .git`,
        output: '',
      }
    }
    if (!info.remote) {
      return { ...info, ok: false, code: 'no_remote', message: '仓库没有配置远端，请先执行 git remote add origin <url>', output: '' }
    }
    if (!info.branch || info.branch === 'HEAD') {
      return { ...info, ok: false, code: 'detached_head', message: '当前处于 detached HEAD，请先切换到一个分支再推送', output: '' }
    }
    // 新仓库的 master/main 常常没有 upstream，直接 `git push` 会以 128 退出并提示 fatal:
    // The current branch has no upstream branch。首次推送时自动带上 --set-upstream。
    const setUpstream = !info.upstream
    const args = setUpstream ? ['push', '--set-upstream', info.remote, info.branch] : ['push']
    const res = await runGit(info.repo, args, 120000)
    if (res.timedOut) {
      return { ...info, setUpstream, ok: false, code: 'timeout', message: 'git push 超时（2 分钟），请检查网络或凭据', output: res.output }
    }
    if (res.spawnError) {
      return { ...info, setUpstream, ok: false, code: 'spawn_failed', message: `无法启动 git：${res.spawnError}`, output: res.output }
    }
    return {
      ...info,
      setUpstream,
      ok: res.code === 0,
      code: res.code === 0 ? 'pushed' : `exit_${res.code}`,
      message: res.code === 0
        ? (setUpstream ? `已推送并设置上游分支 ${info.remote}/${info.branch}` : '已推送到远端')
        : `git push 失败（退出码 ${res.code}）`,
      output: res.output,
    }
  }

  const routeHandler = async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const pathname = url.pathname || ''
    let sub = pathname.slice(ROUTE_PREFIX.length) || '/'
    if (!sub.startsWith('/')) sub = `/${sub}`
    const method = (req.method || 'GET').toUpperCase()
    try {
      if (sub === '/api/dsh/status' || sub === '/api/dsh/chat' || sub.startsWith('/api/dsh/job') || sub === '/api/dsh/reset') {
        if (!isLoopback(req)) return json(res, 403, { error: { code: 'forbidden', message: 'Developer Mode 只允许本机访问' } })
      }
      if (method === 'GET' && (sub === '/api/dsh/open' || sub === '/api/dsh/open/')) {
        if (!isLoopback(req)) return json(res, 403, { error: { code: 'forbidden', message: 'Developer Mode 只允许本机访问' } })
        const location = await consoleRedirectUrl()
        res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' })
        res.end()
        return
      }
      if (sub === '/api/dsh/git-push' || sub === '/api/dsh/git-push/') {
        if (!isLoopback(req)) return json(res, 403, { error: { code: 'forbidden', message: 'Developer Mode 只允许本机访问' } })
        if (method === 'GET') return json(res, 200, await gitRepoInfo())
        if (method === 'POST') return json(res, 200, await gitPushNow())
        return json(res, 405, { error: { code: 'method_not_allowed', message: '只支持 GET / POST' } })
      }
      if (sub === '/api/hub/restart' || sub === '/api/hub/start' || sub === '/api/hub/stop') {
        if (!isLoopback(req)) return json(res, 403, { error: { code: 'forbidden', message: 'Hub 控制只允许本机访问' } })
      }
      if (method === 'GET' && (sub === '/api/status' || sub === '/api/status/')) {
        return json(res, 200, await statusPayload())
      }
      if (method === 'GET' && sub === '/api/dsh/status') {
        const workspace = resolveDevWorkspace()
        return json(res, 200, {
          available: dshAvailable(),
          sessionId: devState.sessionId,
          sessionWorkspaceId: devState.sessionWorkspaceId,
          sessionWorkspacePath: devState.sessionWorkspacePath,
          workspaceId: workspace ? String(workspace.id) : '',
          workspacePath: workspace ? String(workspace.path) : '',
          workspaceTitle: workspace ? String(workspace.title) : '',
          projectRoot: state.settings.projectRoot,
          runningJobs: Array.from(devState.jobs.values()).filter((job) => job.status === 'running').length,
        })
      }
      if (method === 'POST' && sub === '/api/dsh/chat') {
        if (!dshAvailable()) {
          return json(res, 503, { error: { code: 'dsh_unavailable', message: 'DSH sessionController 不可用：宿主插件还没拿到该服务，请完全重启 DeepSeek Harness 后重试' } })
        }
        const body = await readBody(req)
        const message = typeof body.message === 'string' ? body.message.trim() : ''
        const scope = normalizeDevScope(typeof body.scope === 'string' ? body.scope : 'global')
        if (!message) {
          return json(res, 400, { error: { code: 'bad_request', message: 'message 不能为空' } })
        }
        if (message.length > 20000) {
          return json(res, 400, { error: { code: 'bad_request', message: 'message 过长' } })
        }
        const job = {
          id: `dev_${++devState.jobSeq}_${Date.now()}`,
          status: 'queued',
          sessionId: devState.sessionId,
          scope,
          text: '',
          error: '',
          logs: [],
          createdAt: new Date().toISOString(),
          finishedAt: '',
        }
        devState.jobs.set(job.id, job)
        void runDevJob(job, message, scope)
        return json(res, 202, { job: publicJob(job) })
      }
      const devJobMatch = /^\/api\/dsh\/job\/([^/]+)$/.exec(sub)
      if (method === 'GET' && devJobMatch) {
        const job = devState.jobs.get(decodeURIComponent(devJobMatch[1]))
        if (!job) return json(res, 404, { error: { code: 'not_found', message: 'Developer Mode 任务不存在' } })
        return json(res, 200, { job: publicJob(job) })
      }
      if (method === 'GET' && sub === '/api/dsh/jobs') {
        const jobs = Array.from(devState.jobs.values())
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
          .slice(0, 20)
          .map(publicJob)
        return json(res, 200, { jobs })
      }
      if (method === 'POST' && sub === '/api/dsh/reset') {
        devState.sessionId = ''
        devState.sessionWorkspaceId = ''
        devState.sessionWorkspacePath = ''
        return json(res, 200, { ok: true })
      }
      if (method === 'GET' && sub === '/api/settings') {
        return json(res, 200, {
          settings: publicSettings(),
          secrets: await secretStatus(),
          credentials: { available: credentialsAvailable(), storage: secretStorageMode() },
        })
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
        return json(res, 200, {
          settings: updated,
          secrets: await secretStatus(),
          credentials: { available: credentialsAvailable(), storage: secretStorageMode() },
          results,
        })
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
      const taskAction = /^\/api\/tasks\/([^/]+)\/(cancel|retry|archive|unarchive)$/.exec(sub)
      if (method === 'POST' && taskAction) {
        const out = await hubRequest(`/api/tasks/${encodeURIComponent(taskAction[1])}/${taskAction[2]}`, {
          method: 'POST',
          body: {},
        })
        return json(res, out.status, out.data)
      }
      const taskFollow = /^\/api\/tasks\/([^/]+)\/follow-up$/.exec(sub)
      if (method === 'POST' && taskFollow) {
        const body = await readBody(req)
        const out = await hubRequest(`/api/tasks/${encodeURIComponent(taskFollow[1])}/follow-up`, {
          method: 'POST',
          body,
        })
        return json(res, out.status, out.data)
      }
      const taskAnswer = /^\/api\/tasks\/([^/]+)\/answer$/.exec(sub)
      if (method === 'POST' && taskAnswer) {
        const body = await readBody(req)
        const out = await hubRequest(`/api/tasks/${encodeURIComponent(taskAnswer[1])}/answer`, {
          method: 'POST',
          body,
        })
        return json(res, out.status, out.data)
      }
      // 手动改状态：把面板里的“完成/失败/取消/重新排队”映射到 Hub 现有的管理接口。
      //  - 先读取任务：进行中的任务先取消（移除设备待执行指令并下发 cancel_task），避免 Hub 与设备状态分叉；
      //  - Agnes 拆分任务（isPlan）的状态由子任务汇总，只允许取消；
      //  - 完成/失败复用 Hub 的 external-result；备注为空时沿用原有输出，避免覆盖结果。
      const taskStatus = /^\/api\/tasks\/([^/]+)\/status$/.exec(sub)
      if (method === 'POST' && taskStatus) {
        const body = await readBody(req)
        const target = typeof body.status === 'string' ? body.status : ''
        const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : ''
        if (!MANUAL_TASK_STATUSES.has(target)) {
          return json(res, 400, {
            error: { code: 'bad_request', message: `不支持的状态：${target || '(空)'}` },
          })
        }
        let taskId
        try {
          taskId = decodeURIComponent(taskStatus[1])
        } catch {
          return json(res, 400, { error: { code: 'bad_request', message: '任务 ID 非法' } })
        }
        const id = encodeURIComponent(taskId)
        const fetched = await hubRequest(`/api/tasks/${id}`)
        if (fetched.status !== 200 || !fetched.data || !fetched.data.task) {
          return json(res, fetched.status, fetched.data)
        }
        const current = fetched.data.task
        if (current.isPlan && target !== 'cancelled') {
          return json(res, 409, {
            error: { code: 'conflict', message: '长任务拆分的状态由子任务汇总，只能取消' },
          })
        }
        if (MANUAL_FINISH_STATUSES.has(target) && ACTIVE_TASK_STATUSES.has(String(current.status || ''))) {
          const cancelled = await hubRequest(`/api/tasks/${id}/cancel`, { method: 'POST', body: {} })
          if (cancelled.status >= 400) {
            // 状态可能刚好变化（例如设备刚上报结果）：重新读取，只有仍是进行中才返回原错误。
            const again = await hubRequest(`/api/tasks/${id}`)
            const latest = again.status === 200 && again.data && again.data.task ? again.data.task : null
            if (!latest || ACTIVE_TASK_STATUSES.has(String(latest.status || ''))) {
              return json(res, cancelled.status, cancelled.data)
            }
          }
        }
        let out
        if (target === 'cancelled') {
          out = await hubRequest(`/api/tasks/${id}/cancel`, { method: 'POST', body: {} })
        } else if (target === 'queued') {
          out = await hubRequest(`/api/tasks/${id}/retry`, { method: 'POST', body: {} })
        } else {
          const previousOutput = current.output
          const previousText = previousOutput && typeof previousOutput.text === 'string' ? previousOutput.text : ''
          const previousError = typeof current.error === 'string' ? current.error : ''
          const payload = target === 'completed'
            ? { text: note || previousText || '管理员在 DSH 面板手动标记完成', status: 'completed' }
            : {
                text: note || previousText || '管理员在 DSH 面板手动标记失败',
                status: 'failed',
                error: note || previousError || '管理员手动标记失败',
              }
          out = await hubRequest(`/api/tasks/${id}/external-result`, { method: 'POST', body: payload })
        }
        return json(res, out.status, out.data)
      }
      const taskPath = /^\/api\/tasks\/([^/]+)$/.exec(sub)
      if (method === 'DELETE' && taskPath) {
        const out = await hubRequest(`/api/tasks/${encodeURIComponent(taskPath[1])}`, { method: 'DELETE' })
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
      if (devicePath && method === 'DELETE') {
        const out = await hubRequest(`/api/devices/${encodeURIComponent(devicePath[1])}`, { method: 'DELETE' })
        return json(res, out.status, out.data)
      }
      if (method === 'POST' && sub === '/api/hub/restart') {
        const result = await restartHub()
        return json(res, result.ok ? 200 : 409, { ...result, hub: (await statusPayload()).hub })
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
          routes: ['/api/status', '/api/settings', '/api/snapshot', '/api/tasks', '/api/tasks/:id/status', '/api/tasks/:id/follow-up', '/api/tasks/:id/answer', '/api/tasks/:id/archive', '/api/tasks/:id', '/api/devices/:id', '/api/test-credential', '/api/hub/start', '/api/hub/stop', '/api/hub/restart'],
          // 用于确认 Host 侧插件是否已加载最新实现（DSH 桌面端会热加载插件文件）。
          features: ['task-status-manual', 'task-status-cancel-first', 'hub-restart'],
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
        // 先把当前 DSH 端口写给 Hub（含即将由本插件启动的 Hub），再确保 Hub 在跑。
        scheduleBridgeSync()
        if (state.settings.autoStart) return ensureHub()
        return null
      })
      .catch((err) => {
        state.lastError = err && err.message ? err.message : String(err)
        log('启动失败：', state.lastError)
      })
    return () => {
      stopBridgeSync()
      try {
        if (state.child) state.child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
    }
  }, 'super-butler: hub lifecycle')

  log('已加载', { projectRoot: state.settings.projectRoot, port: state.settings.hubPort })
}
