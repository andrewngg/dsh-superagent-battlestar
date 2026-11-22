'use strict';

/**
 * Hub HTTP 层：路由、鉴权、JSON 请求体、SSE、静态文件回退。
 * 所有错误统一为 { error: { code, message } }（见 docs/PROTOCOL.md §2）。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const protocol = require('../../shared/protocol.js');
const errors = require('./errors');
const util = require('./util');
const { listRecords, readRecord } = require('./records');
const { serveStatic } = require('./static');

const { toHttpError, unauthorized, forbidden, notFound, badRequest } = errors;
const { LIMITS } = protocol;

const TASK_ACTION_RE = /^tasks\/([^/]+)\/(ack|progress|result)$/;
const TASK_ADMIN_RE = /^\/api\/tasks\/([^/]+)(?:\/(cancel|retry|archive|unarchive|trash|restore|purge))?$/;
const TASK_FOLLOW_RE = /^\/api\/tasks\/([^/]+)\/follow-up$/;
const TASK_ANSWER_RE = /^\/api\/tasks\/([^/]+)\/answer$/;
const TASK_EXTERNAL_RE = /^\/api\/tasks\/([^/]+)\/external-result$/;
const GOAL_ADMIN_RE = /^\/api\/goals\/([^/]+)(?:\/(check|link|unlink|approve|reject|skip|guidance))?$/;
const REMINDER_ADMIN_RE = /^\/api\/reminders\/([^/]+)(?:\/(fire))?$/;
const RECORD_RE = /^\/api\/records\/([^/]+)$/;
const DSH_JOB_RE = /^\/api\/dsh\/job\/([^/]+)$/;
// DSH 的 Web 端口每次启动都可能变化（桌面版默认随机端口），因此 bridge 地址是可运行时
// 更新的：优先用插件通过 POST /api/dsh/bridge 同步进来的值（同时落盘 <dataDir>/dsh-bridge.json），
// 其次环境变量 DSH_BRIDGE_URL，最后才是历史默认端口。
const DEFAULT_DSH_BRIDGE_URL = 'http://127.0.0.1:50646/super-butler/api/dsh';
const DSH_BRIDGE_FILE = 'dsh-bridge.json';

function normalizeBridgeUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  let parsed = null;
  try {
    parsed = new URL(raw);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  return raw;
}

function dshBridgeFile(hub) {
  return path.join(hub.dataDir, DSH_BRIDGE_FILE);
}

function readStoredBridgeUrl(hub) {
  try {
    const raw = JSON.parse(fs.readFileSync(dshBridgeFile(hub), 'utf8'));
    return normalizeBridgeUrl(raw && raw.url);
  } catch {
    return '';
  }
}

function dshBridgeUrl(hub) {
  if (!hub.dshBridgeUrl) {
    hub.dshBridgeUrl =
      readStoredBridgeUrl(hub) ||
      normalizeBridgeUrl(process.env.DSH_BRIDGE_URL) ||
      DEFAULT_DSH_BRIDGE_URL;
  }
  return hub.dshBridgeUrl;
}

/** 更新 bridge 地址并落盘；返回规范化后的地址（非法地址抛 400）。 */
function setDshBridgeUrl(hub, value) {
  const next = normalizeBridgeUrl(value);
  if (!next) throw badRequest('DSH bridge 地址必须是 http(s) URL');
  hub.dshBridgeUrl = next;
  try {
    fs.mkdirSync(hub.dataDir, { recursive: true });
    const file = dshBridgeFile(hub);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ url: next, updatedAt: protocol.nowIso() }, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.renameSync(tmp, file);
  } catch {
    // 落盘失败不影响当前进程继续使用新地址
  }
  return next;
}

async function dshFetchOnce(hub, pathname, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 30000);
  try {
    const res = await fetch(`${dshBridgeUrl(hub)}${pathname}`, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-json */
    }
    return { status: res.status, data: json, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 请求 DSH bridge。DSH 换端口后插件会把新地址写进 <dataDir>/dsh-bridge.json；
 * 所以 fetch 失败时重读一次该文件，地址确实变了就立刻用新地址重试一次，
 * 这样即使 Hub 是在插件写入文件之前手工启动的，也会自愈而不必重启。
 */
async function dshRequest(hub, pathname, options = {}) {
  try {
    return await dshFetchOnce(hub, pathname, options);
  } catch (err) {
    const stored = readStoredBridgeUrl(hub);
    if (!stored || stored === dshBridgeUrl(hub)) throw err;
    hub.dshBridgeUrl = stored;
    return dshFetchOnce(hub, pathname, options);
  }
}
function dshUnavailableMessage(hub, err) {
  const reason = err && err.message ? err.message : String(err);
  return `DSH bridge 不可用（${dshBridgeUrl(hub)}）：${reason}；如果刚重启过 DSH，请稍等插件同步地址，或在 DSH 插件面板点一次「重启 Hub」`;
}

const TASK_BODY_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENT_COUNT = 3;
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const MAX_ATTACHMENTS_TOTAL = 4 * 1024 * 1024;

function normalizeAttachments(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw badRequest('attachments 必须是数组');
  if (raw.length > MAX_ATTACHMENT_COUNT) throw badRequest(`最多附加 ${MAX_ATTACHMENT_COUNT} 个文件`);
  let total = 0;
  return raw.map((item) => {
    if (!item || typeof item !== 'object') throw badRequest('附件格式不正确');
    const name = String(item.name || 'file')
      .replace(/[\\/:*?"<>|]/g, '_')
      .slice(0, 120) || 'file';
    const mime = String(item.type || item.mime || 'application/octet-stream').slice(0, 120);
    const source = String(item.data || '').replace(/^data:[^;]+;base64,/i, '').replace(/\s+/g, '');
    if (!source || !/^[A-Za-z0-9+/]+={0,2}$/.test(source)) throw badRequest(`附件 ${name} 不是合法 base64`);
    const size = Buffer.byteLength(source, 'base64');
    if (!size) throw badRequest(`附件 ${name} 是空文件`);
    if (size > MAX_ATTACHMENT_BYTES) throw badRequest(`附件 ${name} 超过 2 MiB`);
    total += size;
    if (total > MAX_ATTACHMENTS_TOTAL) throw badRequest('附件总大小超过 4 MiB');
    return { id: protocol.randomId('att'), name, mime, size, data: source };
  });
}

function headerValue(req, name) {
  const value = req.headers[name];
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0].trim();
  return '';
}

function sendJson(res, status, payload) {
  if (res.writableEnded || res.destroyed) return;
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, err) {
  const httpErr = toHttpError(err);
  sendJson(res, httpErr.status, { error: { code: httpErr.code, message: httpErr.message } });
}

/** 读取数字型 query 参数；缺失/非法返回 undefined（交给 clampInt 的默认值）。 */
function queryNumber(url, name) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function queryString(url, name) {
  const raw = url.searchParams.get(name);
  return raw === null ? '' : raw;
}

/** 读取 JSON 请求体；空体视为 {}；非对象 → 400。 */
function readJsonBody(req, maxBytes = LIMITS.MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        fail(badRequest(`请求体过大（上限 ${Math.round(maxBytes / 1024 / 1024)} MiB）`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (!chunks.length) return resolve({});
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        return reject(badRequest('请求体不是合法 JSON'));
      }
      if (!util.isPlainObject(value)) return reject(badRequest('请求体必须是 JSON 对象'));
      return resolve(value);
    });
    req.on('error', (err) => fail(err));
  });
}

// ---------------------------------------------------------------- 鉴权

function adminTokenOf(hub, req, url, allowQuery = false) {
  const fromHeader = headerValue(req, 'x-butler-token');
  if (fromHeader) return fromHeader;
  if (allowQuery) {
    const fromQuery = url.searchParams.get('token');
    if (typeof fromQuery === 'string' && fromQuery.trim()) return fromQuery.trim();
  }
  return '';
}

function requireAdmin(hub, req, url, allowQuery = false) {
  const token = adminTokenOf(hub, req, url, allowQuery);
  if (!token) {
    if (headerValue(req, 'x-butler-device-token')) throw forbidden('设备令牌无权访问管理接口');
    throw unauthorized('缺少管理员令牌');
  }
  if (!hub.isAdminToken(token)) {
    if (headerValue(req, 'x-butler-device-token')) throw forbidden('设备令牌无权访问管理接口');
    throw unauthorized('管理员令牌无效');
  }
}

/**
 * 设备域接口鉴权：管理员令牌或该设备自己的设备令牌。
 * 设备令牌只能访问自己的 /api/devices/:id/* 路径。
 */
function requireDeviceAccess(hub, req, device) {
  const adminHeader = headerValue(req, 'x-butler-token');
  if (adminHeader && hub.isAdminToken(adminHeader)) return 'admin';
  const deviceToken = headerValue(req, 'x-butler-device-token');
  if (deviceToken && hub.verifyDeviceToken(device, deviceToken)) return 'device';
  if (!adminHeader && !deviceToken) throw unauthorized('缺少设备令牌');
  if (deviceToken) throw forbidden('设备令牌无效');
  throw unauthorized('管理员令牌无效');
}

// ---------------------------------------------------------------- 路由

function createHttpServer(hub) {
  const server = http.createServer((req, res) => {
    handleRequest(hub, req, res).catch((err) => {
      if (res.headersSent) {
        try {
          res.destroy();
        } catch {
          /* 忽略 */
        }
        return;
      }
      const httpErr = toHttpError(err);
      if (httpErr.code === 'internal') {
        const detail = err && err.stack ? err.stack : String(err);
        if (!hub.silent) console.error('[hub] 请求处理异常：', detail);
      }
      sendError(res, httpErr);
    });
  });
  server.on('clientError', (err, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    } catch {
      /* 忽略 */
    }
  });
  return server;
}

async function handleRequest(hub, req, res) {
  const url = new URL(req.url || '/', `http://${headerValue(req, 'host') || 'localhost'}`);
  const pathname = url.pathname;
  const method = (req.method || 'GET').toUpperCase();

  if (pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      name: 'BattleStar',
      version: hub.version,
      protocol: protocol.PROTOCOL_VERSION,
      uptimeSec: hub.uptimeSec,
      hubTime: protocol.nowIso(),
      features: {
        progressKeepalive: true,
        autoRetryOnTimeout: hub.autoRetryOnTimeout !== false,
        selfRestart: typeof hub.restartHandler === 'function',
        restartedFromSelf: hub.gracefulRestart === true,
      },
    });
  }

  if (pathname === '/api/system/restart') {
    requireAdmin(hub, req, url);
    if (method !== 'POST') throw notFound('接口不存在');
    const body = await readJsonBody(req);
    const reason = util.str(body && body.reason, 120) || 'console';
    const result = hub.requestRestart(reason);
    return sendJson(res, 202, { ok: true, ...result, hubTime: protocol.nowIso() });
  }

  if (pathname === '/api/events') {
    requireAdmin(hub, req, url, true);
    if (method !== 'GET') throw notFound('接口不存在');
    return hub.attachSse(req, res);
  }

  if (pathname === '/api/devices/register' && method === 'POST') {
    return handleRegister(hub, req, res);
  }

  const deviceMatch = /^\/api\/devices\/([^/]+)(?:\/(.+))?$/.exec(pathname);
  if (deviceMatch) {
    let deviceId;
    try {
      deviceId = decodeURIComponent(deviceMatch[1]);
    } catch {
      throw badRequest('设备 ID 非法');
    }
    const rest = deviceMatch[2] || '';
    return handleDeviceScoped(hub, req, res, url, method, deviceId, rest);
  }

  if (pathname === '/api/snapshot') {
    requireAdmin(hub, req, url);
    if (method !== 'GET') throw notFound('接口不存在');
    const limit = util.clampInt(queryNumber(url, 'limit'), 50, 1, 200);
    return sendJson(res, 200, {
      ...hub.snapshot(limit),
      joinCode: hub.joinCode,
      dshBridge: { url: dshBridgeUrl(hub) },
    });
  }

  // 加入码管理：GET 供控制台显示；POST 轮换（母机改一次，在线设备下一次心跳自动同步）。
  if (pathname === '/api/admin/join-code') {
    requireAdmin(hub, req, url);
    if (method === 'GET') {
      return sendJson(res, 200, { joinCode: hub.joinCode, hubTime: protocol.nowIso() });
    }
    if (method !== 'POST') throw notFound('接口不存在');
    await readJsonBody(req);
    const joinCode = hub.rotateJoinCode();
    return sendJson(res, 200, { joinCode, hubTime: protocol.nowIso() });
  }

  if (pathname === '/api/settings') {
    requireAdmin(hub, req, url);
    if (method === 'GET') {
      return sendJson(res, 200, {
        settings: hub.getSettings(),
        supportedLanguages: hub.getSupportedLanguages(),
        joinCode: hub.joinCode,
        hubTime: protocol.nowIso(),
      });
    }
    if (method === 'PATCH' || method === 'PUT') {
      const body = await readJsonBody(req);
      const settings = hub.updateSettings(body);
      return sendJson(res, 200, { settings, hubTime: protocol.nowIso() });
    }
    throw notFound('接口不存在');
  }

  // ---------------------------------------------------------------- 自主大脑
  if (pathname === '/api/brain') {
    requireAdmin(hub, req, url);
    if (method === 'GET') {
      return sendJson(res, 200, {
        brain: hub.getBrain(),
        decisions: hub.listBrainDecisions(util.clampInt(queryNumber(url, 'decisions'), 20, 1, 30)),
        hubTime: protocol.nowIso(),
      });
    }
    if (method === 'PATCH' || method === 'PUT') {
      const body = await readJsonBody(req);
      const brain = hub.updateBrain(body);
      return sendJson(res, 200, { brain, hubTime: protocol.nowIso() });
    }
    throw notFound('接口不存在');
  }

  if (pathname === '/api/brain/owner-ask/choose') {
    requireAdmin(hub, req, url);
    if (method !== 'POST') throw notFound('接口不存在');
    const body = await readJsonBody(req);
    const brain = hub.chooseBrainOwnerAsk(body && body.optionId);
    return sendJson(res, 200, { brain, hubTime: protocol.nowIso() });
  }

  if (pathname === '/api/brain/owner-ask/reply') {
    requireAdmin(hub, req, url);
    if (method !== 'POST') throw notFound('接口不存在');
    const body = await readJsonBody(req);
    const brain = hub.replyBrainOwnerAsk(body && body.text);
    return sendJson(res, 200, { brain, hubTime: protocol.nowIso() });
  }

  if (pathname === '/api/brain/think') {
    requireAdmin(hub, req, url);
    if (method !== 'POST') throw notFound('接口不存在');
    await readJsonBody(req);
    const decision = await hub.requestBrainThink({ trigger: 'manual' });
    if (!decision) throw badRequest('自主大脑正在思考，请稍后重试');
    const brain = hub.getBrain();
    // 未配置模型时是配置问题（400），其余思考失败按 502 返回但同样带上决策记录。
    if (decision.error && /BRAIN_API_KEY|AGNES_API_KEY/.test(decision.error)) {
      throw badRequest(decision.error);
    }
    if (decision.error) {
      return sendJson(res, 502, {
        error: { code: 'brain_failed', message: decision.error },
        decision,
        brain,
        hubTime: protocol.nowIso(),
      });
    }
    return sendJson(res, 200, { decision, brain, hubTime: protocol.nowIso() });
  }

  // ---------------------------------------------------------------- 心智（Soul / Skill）

  if (pathname === '/api/mind') {
    requireAdmin(hub, req, url);
    if (method === 'GET') {
      return sendJson(res, 200, { mind: hub.getMind(), hubTime: protocol.nowIso() });
    }
    if (method === 'PATCH' || method === 'PUT') {
      const body = await readJsonBody(req);
      const mind = hub.updateMind(body);
      return sendJson(res, 200, { mind, hubTime: protocol.nowIso() });
    }
    throw notFound('接口不存在');
  }

  // ---------------------------------------------------------------- 管家心路
  if (pathname === '/api/journal') {
    requireAdmin(hub, req, url);
    if (method === 'GET') {
      const journal = hub.getJournal({
        entries: util.clampInt(queryNumber(url, 'entries'), 300, 1, 800),
        days: util.clampInt(queryNumber(url, 'days'), 60, 1, 180),
        date: queryString(url, 'date') || null,
      });
      return sendJson(res, 200, { journal, entries: journal.entries, hubTime: protocol.nowIso() });
    }
    if (method === 'PATCH' || method === 'PUT') {
      const body = await readJsonBody(req);
      const journal = hub.updateJournal(body);
      return sendJson(res, 200, { journal, hubTime: protocol.nowIso() });
    }
    throw notFound('接口不存在');
  }

  if (pathname === '/api/journal/summary') {
    requireAdmin(hub, req, url);
    if (method !== 'POST') throw notFound('接口不存在');
    const body = await readJsonBody(req);
    const date = body && typeof body.date === 'string' ? body.date.trim() : '';
    const force = !(body && body.force === false);
    const result = await hub.generateJournalSummary({ date: date || undefined, force });
    if (!result) throw badRequest('管家心路正在生成总结，请稍后重试');
    return sendJson(res, 200, {
      day: result.day || null,
      error: result.error || null,
      hubTime: protocol.nowIso(),
    });
  }

  // ---------------------------------------------------------------- 头脑风暴
  if (pathname === '/api/brainstorm') {
    requireAdmin(hub, req, url);
    if (method !== 'GET') throw notFound('接口不存在');
    const view = hub.getBrainstorm({
      messages: util.clampInt(queryNumber(url, 'messages'), 100, 1, 200),
      sessionId: queryString(url, 'session') || null,
    });
    return sendJson(res, 200, {
      brainstorm: { activeId: view.activeId, sessions: view.sessions },
      session: view.session,
      hubTime: protocol.nowIso(),
    });
  }

  if (pathname === '/api/brainstorm/chat') {
    requireAdmin(hub, req, url);
    if (method !== 'POST') throw notFound('接口不存在');
    const body = await readJsonBody(req);
    const result = await hub.chatBrainstorm({
      sessionId: body && body.sessionId,
      message: body && body.message,
      attachments: body && body.attachments,
    });
    return sendJson(res, 200, {
      session: result.session,
      reply: result.reply || null,
      error: result.error || null,
      attachments: result.attachments || [],
      attachmentErrors: result.attachmentErrors || [],
      hubTime: protocol.nowIso(),
    });
  }

  if (pathname === '/api/brainstorm/sessions') {
    requireAdmin(hub, req, url);
    if (method !== 'POST') throw notFound('接口不存在');
    await readJsonBody(req);
    const session = hub.createBrainstormSession();
    const view = hub.getBrainstorm({ sessionId: session.id });
    return sendJson(res, 200, {
      session: view.session,
      brainstorm: { activeId: view.activeId, sessions: view.sessions },
      hubTime: protocol.nowIso(),
    });
  }

  const brainstormSessionMatch = /^\/api\/brainstorm\/sessions\/([^/]+)$/.exec(pathname);
  if (brainstormSessionMatch) {
    requireAdmin(hub, req, url);
    if (method !== 'DELETE') throw notFound('接口不存在');
    let deletedId;
    try {
      deletedId = decodeURIComponent(brainstormSessionMatch[1]);
    } catch {
      throw badRequest('会话 ID 非法');
    }
    hub.deleteBrainstormSession(deletedId);
    const view = hub.getBrainstorm({ messages: 1 });
    return sendJson(res, 200, {
      ok: true,
      brainstorm: { activeId: view.activeId, sessions: view.sessions },
      hubTime: protocol.nowIso(),
    });
  }

  if (pathname === '/api/brainstorm/to-task') {
    requireAdmin(hub, req, url);
    if (method !== 'POST') throw notFound('接口不存在');
    const body = await readJsonBody(req);
    const result = hub.brainstormMessageToTask({
      sessionId: body && body.sessionId,
      messageId: body && body.messageId,
      goalId: body && body.goalId,
    });
    return sendJson(res, 200, {
      task: hub.taskToJson(result.task),
      session: result.session,
      hubTime: protocol.nowIso(),
    });
  }

  if (pathname === '/api/goals') {
    requireAdmin(hub, req, url);
    if (method === 'GET') {
      const goals = hub.listGoals({ status: queryString(url, 'status') });
      return sendJson(res, 200, { goals, hubTime: protocol.nowIso() });
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      const goal = hub.createGoal(body);
      return sendJson(res, 200, { goal: hub.getGoal(goal.id), hubTime: protocol.nowIso() });
    }
    throw notFound('接口不存在');
  }

  const goalMatch = GOAL_ADMIN_RE.exec(pathname);
  if (goalMatch) {
    requireAdmin(hub, req, url);
    let goalId;
    try {
      goalId = decodeURIComponent(goalMatch[1]);
    } catch {
      throw badRequest('目标 ID 非法');
    }
    const action = goalMatch[2] || null;
    if (!action && method === 'GET') {
      const goal = hub.getGoal(goalId);
      return sendJson(res, 200, {
        goal,
        tasks: hub.listGoalTasks(goalId),
        linkedStats: hub.goalLinkedStats(goalId),
        hubTime: protocol.nowIso(),
      });
    }
    if (!action && (method === 'PATCH' || method === 'PUT')) {
      const body = await readJsonBody(req);
      const goal = hub.updateGoal(goalId, body);
      return sendJson(res, 200, { goal: hub.getGoal(goal.id), hubTime: protocol.nowIso() });
    }
    if (!action && method === 'DELETE') {
      hub.deleteGoal(goalId);
      return sendJson(res, 200, { ok: true, hubTime: protocol.nowIso() });
    }
    if (action === 'check' && method === 'POST') {
      await readJsonBody(req);
      const { goal, task } = hub.requestGoalCheck(goalId, { manual: true });
      return sendJson(res, 200, {
        goal: hub.getGoal(goal.id),
        task: hub.taskToJson(task),
        hubTime: protocol.nowIso(),
      });
    }
    if (action === 'link' && method === 'POST') {
      const body = await readJsonBody(req);
      const taskId = body && typeof body.taskId === 'string' ? body.taskId.trim() : '';
      if (!taskId) throw badRequest('taskId 必填');
      const { goal, task } = hub.linkGoalTask(goalId, taskId);
      return sendJson(res, 200, {
        goal: hub.getGoal(goal.id),
        task: hub.taskToJson(task),
        hubTime: protocol.nowIso(),
      });
    }
    if (action === 'unlink' && method === 'POST') {
      const body = await readJsonBody(req);
      const taskId = body && typeof body.taskId === 'string' ? body.taskId.trim() : '';
      if (!taskId) throw badRequest('taskId 必填');
      const { goal } = hub.unlinkGoalTask(goalId, taskId);
      return sendJson(res, 200, {
        goal: hub.getGoal(goal.id),
        tasks: hub.listGoalTasks(goalId),
        linkedStats: hub.goalLinkedStats(goalId),
        hubTime: protocol.nowIso(),
      });
    }
    if (action === 'skip' && method === 'POST') {
      await readJsonBody(req);
      const goal = hub.skipNextGoalCheck(goalId);
      return sendJson(res, 200, { goal: hub.getGoal(goal.id), hubTime: protocol.nowIso() });
    }
    if (action === 'guidance' && method === 'POST') {
      const body = await readJsonBody(req);
      const goal = hub.addGoalGuidance(goalId, body);
      return sendJson(res, 200, { goal: hub.getGoal(goal.id), hubTime: protocol.nowIso() });
    }
    if (action === 'approve' && method === 'POST') {
      await readJsonBody(req);
      const { goal, task } = hub.approveGoalCheck(goalId);
      return sendJson(res, 200, {
        goal: hub.getGoal(goal.id),
        task: hub.taskToJson(task),
        hubTime: protocol.nowIso(),
      });
    }
    if (action === 'reject' && method === 'POST') {
      await readJsonBody(req);
      const goal = hub.rejectGoalCheck(goalId);
      return sendJson(res, 200, { goal, hubTime: protocol.nowIso() });
    }
    throw notFound('接口不存在');
  }

  if (pathname === '/api/reminders') {
    requireAdmin(hub, req, url);
    if (method === 'GET') {
      return sendJson(res, 200, { reminders: hub.listReminders(), hubTime: protocol.nowIso() });
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      const reminder = hub.createReminder(body);
      return sendJson(res, 200, { reminder: hub.getReminder(reminder.id), hubTime: protocol.nowIso() });
    }
    throw notFound('接口不存在');
  }

  const reminderMatch = REMINDER_ADMIN_RE.exec(pathname);
  if (reminderMatch) {
    requireAdmin(hub, req, url);
    let reminderId;
    try {
      reminderId = decodeURIComponent(reminderMatch[1]);
    } catch {
      throw notFound('提醒不存在');
    }
    const action = reminderMatch[2] || null;
    if (!action && method === 'GET') {
      return sendJson(res, 200, { reminder: hub.getReminder(reminderId), hubTime: protocol.nowIso() });
    }
    if (!action && (method === 'PATCH' || method === 'PUT')) {
      const body = await readJsonBody(req);
      const reminder = hub.updateReminder(reminderId, body);
      return sendJson(res, 200, { reminder: hub.getReminder(reminder.id), hubTime: protocol.nowIso() });
    }
    if (!action && method === 'DELETE') {
      const reminder = hub.deleteReminder(reminderId);
      return sendJson(res, 200, {
        deleted: true,
        reminderId: reminder.id,
        hubTime: protocol.nowIso(),
      });
    }
    if (action === 'fire' && method === 'POST') {
      const body = await readJsonBody(req);
      const reminder = hub.fireReminder(reminderId, {
        firedAt: body && typeof body.firedAt === 'string' ? body.firedAt : undefined,
      });
      return sendJson(res, 200, { reminder: hub.getReminder(reminder.id), hubTime: protocol.nowIso() });
    }
    throw notFound('接口不存在');
  }

  if (pathname === '/api/approvals') {
    requireAdmin(hub, req, url);
    if (method !== 'GET') throw notFound('接口不存在');
    return sendJson(res, 200, { approvals: hub.listApprovals(), hubTime: protocol.nowIso() });
  }

  if (pathname === '/api/nightly-review') {
    requireAdmin(hub, req, url);
    if (method !== 'GET') throw notFound('接口不存在');
    return sendJson(res, 200, { review: hub.getNightlyReview(), hubTime: protocol.nowIso() });
  }

  if (pathname === '/api/nightly-review/run') {
    requireAdmin(hub, req, url);
    if (method !== 'POST') throw notFound('接口不存在');
    await readJsonBody(req);
    const task = hub.runNightlyReview(Date.now(), { force: true });
    return sendJson(res, 200, {
      task: task ? hub.taskToJson(task) : null,
      review: hub.getNightlyReview(),
      hubTime: protocol.nowIso(),
    });
  }

  if (pathname === '/api/records') {
    requireAdmin(hub, req, url);
    if (method !== 'GET') throw notFound('接口不存在');
    const result = listRecords(hub, {
      q: queryString(url, 'q'),
      status: queryString(url, 'status'),
      limit: queryNumber(url, 'limit'),
      offset: queryNumber(url, 'offset'),
    });
    return sendJson(res, 200, { ...result, hubTime: protocol.nowIso() });
  }

  const recordMatch = RECORD_RE.exec(pathname);
  if (recordMatch) {
    requireAdmin(hub, req, url);
    if (method !== 'GET') throw notFound('接口不存在');
    let taskId;
    try {
      taskId = decodeURIComponent(recordMatch[1]);
    } catch {
      throw badRequest('任务 ID 非法');
    }
    const record = readRecord(hub, taskId);
    if (!record) throw notFound('执行记录不存在');
    if (queryString(url, 'format') === 'md') {
      const body = Buffer.from(record.markdown, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Length': body.length,
        'Content-Disposition': `attachment; filename="${record.taskId}.md"`,
        'Cache-Control': 'no-store',
      });
      return res.end(body);
    }
    return sendJson(res, 200, { record, hubTime: protocol.nowIso() });
  }

  if (pathname === '/api/devices') {
    requireAdmin(hub, req, url);
    if (method !== 'GET') throw notFound('接口不存在');
    const devices = [...hub.devices.values()].map((device) => hub.deviceToJson(device));
    return sendJson(res, 200, { devices, hubTime: protocol.nowIso() });
  }

  if (pathname === '/api/dsh/bridge') {
    requireAdmin(hub, req, url);
    if (method === 'GET') return sendJson(res, 200, { url: dshBridgeUrl(hub) });
    if (method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, { url: setDshBridgeUrl(hub, body.url) });
    }
    throw notFound('接口不存在');
  }

  if (pathname === '/api/dsh/status') {
    requireAdmin(hub, req, url);
    try {
      const out = await dshRequest(hub, '/status');
      return sendJson(res, out.status, out.data || {});
    } catch (err) {
      return sendJson(res, 502, { error: { code: 'dsh_unavailable', message: dshUnavailableMessage(hub, err) } });
    }
  }

  if (pathname === '/api/dsh/chat') {
    requireAdmin(hub, req, url);
    if (method !== 'POST') throw notFound('接口不存在');
    const body = await readJsonBody(req);
    try {
      const out = await dshRequest(hub, '/chat', { method: 'POST', body });
      return sendJson(res, out.status, out.data || {});
    } catch (err) {
      return sendJson(res, 502, { error: { code: 'dsh_unavailable', message: dshUnavailableMessage(hub, err) } });
    }
  }

  if (pathname === '/api/dsh/reset') {
    requireAdmin(hub, req, url);
    if (method !== 'POST') throw notFound('接口不存在');
    try {
      const out = await dshRequest(hub, '/reset', { method: 'POST', body: {} });
      return sendJson(res, out.status, out.data || {});
    } catch (err) {
      return sendJson(res, 502, { error: { code: 'dsh_unavailable', message: dshUnavailableMessage(hub, err) } });
    }
  }

  if (pathname === '/api/dsh/jobs') {
    requireAdmin(hub, req, url);
    try {
      const out = await dshRequest(hub, '/jobs');
      return sendJson(res, out.status, out.data || {});
    } catch (err) {
      return sendJson(res, 502, { error: { code: 'dsh_unavailable', message: dshUnavailableMessage(hub, err) } });
    }
  }

  const dshJobMatch = DSH_JOB_RE.exec(pathname);
  if (dshJobMatch) {
    requireAdmin(hub, req, url);
    try {
      const out = await dshRequest(hub, `/job/${encodeURIComponent(decodeURIComponent(dshJobMatch[1]))}`);
      return sendJson(res, out.status, out.data || {});
    } catch (err) {
      return sendJson(res, 502, { error: { code: 'dsh_unavailable', message: dshUnavailableMessage(hub, err) } });
    }
  }

  if (pathname === '/api/tasks') {
    requireAdmin(hub, req, url);
    if (method === 'POST') {
      const body = await readJsonBody(req, TASK_BODY_BYTES);
      const input = { ...body, attachments: normalizeAttachments(body.attachments) };
      const task = hub.shouldAutoSplit(input) ? await hub.createPlanTask(input) : hub.createTask(input);
      return sendJson(res, 200, { task: hub.taskToJson(task) });
    }
    if (method === 'GET') {
      const tasks = hub.listTasks({
        status: queryString(url, 'status'),
        deviceId: queryString(url, 'deviceId'),
        includeArchived: queryString(url, 'includeArchived') === '1',
        includeTrashed: queryString(url, 'includeTrashed') === '1',
        limit: queryNumber(url, 'limit'),
      });
      return sendJson(res, 200, { tasks });
    }
    throw notFound('接口不存在');
  }

  const answerMatch = TASK_ANSWER_RE.exec(pathname);
  if (answerMatch) {
    requireAdmin(hub, req, url);
    if (method !== 'POST') throw notFound('接口不存在');
    let taskId;
    try {
      taskId = decodeURIComponent(answerMatch[1]);
    } catch {
      throw badRequest('任务 ID 非法');
    }
    const body = await readJsonBody(req);
    const task = hub._requireTask(taskId);
    const answered = hub.answerTask(task, body.text);
    return sendJson(res, 200, { task: hub.taskToJson(answered) });
  }

  const externalMatch = TASK_EXTERNAL_RE.exec(pathname);
  if (externalMatch) {
    requireAdmin(hub, req, url);
    if (method !== 'POST') throw notFound('接口不存在');
    let taskId;
    try {
      taskId = decodeURIComponent(externalMatch[1]);
    } catch {
      throw badRequest('任务 ID 非法');
    }
    const body = await readJsonBody(req, TASK_BODY_BYTES);
    const task = hub._requireTask(taskId);
    const updated = hub.attachExternalResult(task, body);
    return sendJson(res, 200, { task: hub.taskToJson(updated) });
  }

  const followMatch = TASK_FOLLOW_RE.exec(pathname);
  if (followMatch) {
    requireAdmin(hub, req, url);
    if (method !== 'POST') throw notFound('接口不存在');
    let sourceId;
    try {
      sourceId = decodeURIComponent(followMatch[1]);
    } catch {
      throw badRequest('任务 ID 非法');
    }
    const body = await readJsonBody(req, TASK_BODY_BYTES);
    const source = hub._requireTask(sourceId);
    const task = hub.createFollowUp(source, { ...body, attachments: normalizeAttachments(body.attachments) });
    return sendJson(res, 200, { task: hub.taskToJson(task) });
  }

  const taskMatch = TASK_ADMIN_RE.exec(pathname);
  if (taskMatch) {
    requireAdmin(hub, req, url);
    let taskId;
    try {
      taskId = decodeURIComponent(taskMatch[1]);
    } catch {
      throw badRequest('任务 ID 非法');
    }
    const action = taskMatch[2] || null;
    if (!action && method === 'GET') {
      return sendJson(res, 200, { task: hub.taskToJson(hub._requireTask(taskId)) });
    }
    if (!action && (method === 'PATCH' || method === 'PUT')) {
      const body = await readJsonBody(req, TASK_BODY_BYTES);
      const task = hub.updateTask(hub._requireTask(taskId), body);
      return sendJson(res, 200, { task: hub.taskToJson(task) });
    }
    if (!action && method === 'DELETE') {
      const task = hub.deleteTask(hub._requireTask(taskId));
      return sendJson(res, 200, { ok: true, task: hub.taskToJson(task) });
    }
    if (action === 'cancel' && method === 'POST') {
      await readJsonBody(req);
      const task = hub.cancelTask(hub._requireTask(taskId));
      return sendJson(res, 200, { task: hub.taskToJson(task) });
    }
    if (action === 'retry' && method === 'POST') {
      await readJsonBody(req);
      const task = hub.retryTask(hub._requireTask(taskId));
      return sendJson(res, 200, { task: hub.taskToJson(task) });
    }
    if (action === 'archive' && method === 'POST') {
      await readJsonBody(req);
      const task = hub.archiveTask(hub._requireTask(taskId), true);
      return sendJson(res, 200, { task: hub.taskToJson(task) });
    }
    if (action === 'unarchive' && method === 'POST') {
      await readJsonBody(req);
      const task = hub.archiveTask(hub._requireTask(taskId), false);
      return sendJson(res, 200, { task: hub.taskToJson(task) });
    }
    if (action === 'trash' && method === 'POST') {
      await readJsonBody(req);
      const task = hub.trashTask(hub._requireTask(taskId));
      return sendJson(res, 200, { ok: true, task: hub.taskToJson(task) });
    }
    if (action === 'restore' && method === 'POST') {
      await readJsonBody(req);
      const task = hub.restoreTask(hub._requireTask(taskId));
      return sendJson(res, 200, { ok: true, task: hub.taskToJson(task) });
    }
    if (action === 'purge' && method === 'POST') {
      await readJsonBody(req);
      const result = hub.purgeTask(hub._requireTask(taskId));
      return sendJson(res, 200, { ok: true, deleted: result.deleted });
    }
    throw notFound('接口不存在');
  }

  if (pathname.startsWith('/api/')) throw notFound('接口不存在');

  const served = await serveStatic(hub, req, res, pathname);
  if (!served) throw notFound('页面不存在');
}

async function handleRegister(hub, req, res) {
  const body = await readJsonBody(req);
  const joinCode = headerValue(req, 'x-butler-join-code');
  const headerDeviceId = headerValue(req, 'x-butler-device-id');
  const deviceToken = headerValue(req, 'x-butler-device-token');
  const bodyDeviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
  const updateDeviceId = bodyDeviceId || headerDeviceId;

  const respond = (device) => {
    sendJson(res, 200, {
      deviceId: device.id,
      deviceToken: device.deviceToken,
      heartbeatIntervalMs: hub.heartbeatIntervalMs,
      ttlSec: Math.max(1, Math.round(hub.ttlMs / 1000)),
      // 当前加入码随注册响应下发，设备保存后令牌失效时可直接重注册（母机轮换后自动同步）。
      joinCode: hub.joinCode,
      hubTime: protocol.nowIso(),
    });
  };

  if (updateDeviceId) {
    const device = hub.getDevice(updateDeviceId);
    if (!device) throw notFound('设备不存在，请使用加入码重新注册');
    if (!deviceToken) throw unauthorized('缺少设备令牌');
    if (!hub.verifyDeviceToken(device, deviceToken)) throw forbidden('设备令牌无效');
    hub.updateDeviceManifest(device, body);
    return respond(device);
  }

  if (!joinCode) throw unauthorized('缺少加入码');
  if (!hub.isValidJoinCode(joinCode)) throw forbidden('加入码无效');
  const device = hub.registerDevice(body);
  return respond(device);
}

async function handleDeviceScoped(hub, req, res, url, method, deviceId, rest) {
  const device = hub.getDevice(deviceId);
  if (!device) throw notFound('设备不存在');

  if (rest === '') {
    requireAdmin(hub, req, url);
    if (method === 'GET') return sendJson(res, 200, { device: hub.deviceToJson(device) });
    if (method === 'PATCH') {
      const body = await readJsonBody(req);
      hub.patchDevice(device, body);
      return sendJson(res, 200, { device: hub.deviceToJson(device) });
    }
    if (method === 'DELETE') {
      hub.removeDevice(device, 'device deleted by admin');
      return sendJson(res, 200, { ok: true });
    }
    throw notFound('接口不存在');
  }

  requireDeviceAccess(hub, req, device);

  if (rest === 'heartbeat') {
    if (method !== 'POST') throw notFound('接口不存在');
    const body = await readJsonBody(req);
    const result = hub.handleHeartbeat(device, body);
    return sendJson(res, 200, {
      ok: true,
      hubTime: protocol.nowIso(),
      heartbeatIntervalMs: hub.heartbeatIntervalMs,
      ttlSec: Math.max(1, Math.round(hub.ttlMs / 1000)),
      // 加入码下发通道：母机轮换后在线设备靠这条心跳值自动同步本地保存的加入码。
      joinCode: hub.joinCode,
      commands: result.commands,
    });
  }

  if (rest === 'manifest') {
    if (method !== 'POST') throw notFound('接口不存在');
    const body = await readJsonBody(req);
    hub.updateDeviceManifest(device, body);
    return sendJson(res, 200, { ok: true, device: hub.deviceToJson(device), joinCode: hub.joinCode });
  }

  if (rest === 'commands') {
    if (method !== 'GET') throw notFound('接口不存在');
    hub.touch(device);
    const waitMs = queryNumber(url, 'waitMs');
    const limit = queryNumber(url, 'limit');
    const commands = await hub.addCommandWaiter(device, {
      waitMs: waitMs === undefined ? 25000 : waitMs,
      limit: limit === undefined ? 5 : limit,
      req,
    });
    if (!res.writableEnded) sendJson(res, 200, { commands });
    return;
  }

  if (rest === 'unregister') {
    if (method !== 'POST') throw notFound('接口不存在');
    await readJsonBody(req);
    hub.removeDevice(device, 'device unregistered');
    return sendJson(res, 200, { ok: true });
  }

  const taskAction = TASK_ACTION_RE.exec(rest);
  if (taskAction) {
    if (method !== 'POST') throw notFound('接口不存在');
    let taskId;
    try {
      taskId = decodeURIComponent(taskAction[1]);
    } catch {
      throw badRequest('任务 ID 非法');
    }
    const action = taskAction[2];
    const body = await readJsonBody(req);
    if (action === 'ack') {
      const task = hub.handleAck(device, taskId);
      return sendJson(res, 200, { ok: true, task: hub.taskToJson(task) });
    }
    if (action === 'progress') {
      hub.handleProgress(device, taskId, body);
      return sendJson(res, 200, { ok: true });
    }
    const result = hub.handleResult(device, taskId, body);
    // 结果收敛：旧 attempt / 重复上报也回 200，用 ignored 标记，避免设备把 409 当成
    // “Hub 仍在处理”而继续等待/重试，也避免 Hub 因 409 继续重派。
    return sendJson(res, 200, {
      ok: true,
      ignored: Boolean(result && result.ignored),
      task: hub.taskToJson(result.task),
      ...(result && result.ignored && result.reason ? { reason: result.reason } : {}),
    });
  }

  throw notFound('接口不存在');
}

module.exports = {
  createHttpServer,
  sendJson,
  sendError,
  readJsonBody,
  headerValue,
  requireAdmin,
};
