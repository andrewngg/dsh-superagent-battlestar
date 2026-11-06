'use strict';

/**
 * Hub HTTP 层：路由、鉴权、JSON 请求体、SSE、静态文件回退。
 * 所有错误统一为 { error: { code, message } }（见 docs/PROTOCOL.md §2）。
 */

const http = require('node:http');
const { URL } = require('node:url');

const protocol = require('../../shared/protocol.js');
const errors = require('./errors');
const util = require('./util');
const { serveStatic } = require('./static');

const { toHttpError, unauthorized, forbidden, notFound, badRequest } = errors;
const { LIMITS } = protocol;

const TASK_ACTION_RE = /^tasks\/([^/]+)\/(ack|progress|result)$/;
const TASK_ADMIN_RE = /^\/api\/tasks\/([^/]+)(?:\/(cancel|retry|archive|unarchive))?$/;
const TASK_FOLLOW_RE = /^\/api\/tasks\/([^/]+)\/follow-up$/;
const TASK_ANSWER_RE = /^\/api\/tasks\/([^/]+)\/answer$/;
const TASK_EXTERNAL_RE = /^\/api\/tasks\/([^/]+)\/external-result$/;
const DSH_JOB_RE = /^\/api\/dsh\/job\/([^/]+)$/;
const DSH_BRIDGE_URL = (process.env.DSH_BRIDGE_URL || 'http://127.0.0.1:50646/super-butler/api/dsh').replace(/\/+$/, '');

async function dshRequest(pathname, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 30000);
  try {
    const res = await fetch(`${DSH_BRIDGE_URL}${pathname}`, {
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
    });
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
    return sendJson(res, 200, hub.snapshot(limit));
  }

  if (pathname === '/api/devices') {
    requireAdmin(hub, req, url);
    if (method !== 'GET') throw notFound('接口不存在');
    const devices = [...hub.devices.values()].map((device) => hub.deviceToJson(device));
    return sendJson(res, 200, { devices, hubTime: protocol.nowIso() });
  }

  if (pathname === '/api/dsh/status') {
    requireAdmin(hub, req, url);
    try {
      const out = await dshRequest('/status');
      return sendJson(res, out.status, out.data || {});
    } catch (err) {
      return sendJson(res, 502, { error: { code: 'dsh_unavailable', message: `DSH bridge 不可用：${err.message}` } });
    }
  }

  if (pathname === '/api/dsh/chat') {
    requireAdmin(hub, req, url);
    if (method !== 'POST') throw notFound('接口不存在');
    const body = await readJsonBody(req);
    try {
      const out = await dshRequest('/chat', { method: 'POST', body });
      return sendJson(res, out.status, out.data || {});
    } catch (err) {
      return sendJson(res, 502, { error: { code: 'dsh_unavailable', message: `DSH bridge 不可用：${err.message}` } });
    }
  }

  if (pathname === '/api/dsh/reset') {
    requireAdmin(hub, req, url);
    if (method !== 'POST') throw notFound('接口不存在');
    try {
      const out = await dshRequest('/reset', { method: 'POST', body: {} });
      return sendJson(res, out.status, out.data || {});
    } catch (err) {
      return sendJson(res, 502, { error: { code: 'dsh_unavailable', message: `DSH bridge 不可用：${err.message}` } });
    }
  }

  const dshJobMatch = DSH_JOB_RE.exec(pathname);
  if (dshJobMatch) {
    requireAdmin(hub, req, url);
    try {
      const out = await dshRequest(`/job/${encodeURIComponent(decodeURIComponent(dshJobMatch[1]))}`);
      return sendJson(res, out.status, out.data || {});
    } catch (err) {
      return sendJson(res, 502, { error: { code: 'dsh_unavailable', message: `DSH bridge 不可用：${err.message}` } });
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
      commands: result.commands,
    });
  }

  if (rest === 'manifest') {
    if (method !== 'POST') throw notFound('接口不存在');
    const body = await readJsonBody(req);
    hub.updateDeviceManifest(device, body);
    return sendJson(res, 200, { ok: true, device: hub.deviceToJson(device) });
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
    const task = hub.handleResult(device, taskId, body);
    return sendJson(res, 200, { ok: true, task: hub.taskToJson(task) });
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
