'use strict';

/**
 * Hub 测试公共工具：随机端口 + 临时数据目录 + 简易 HTTP/SSE 客户端。
 * 注意：本文件放在 hub/test 下（node --test 目录模式会把 test/ 下所有 .js 视为测试文件），
 * 因此顶层不产生任何副作用；它本身不含测试。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { startHub } = require('../lib/hub');

const DEFAULT_MANIFEST = Object.freeze({
  name: '测试设备',
  platform: 'windows',
  kind: 'dsh',
  agentVersion: '0.1.0',
  tags: [],
  models: [{ id: 'deepseek-chat', provider: 'deepseek', strengths: ['code'] }],
  skills: [{ id: 'office-docx', name: 'Word 文档' }],
  limits: { maxConcurrentTasks: 1 },
});

function makeManifest(overrides = {}) {
  return { ...DEFAULT_MANIFEST, ...overrides };
}

async function makeTempDir(prefix = 'butler-hub-test-') {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 轮询直到 fn 返回真值（测试里用来等异步状态，避免硬编码 sleep）。 */
async function waitFor(fn, { timeout = 5000, interval = 20, label = '条件' } = {}) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(interval);
  }
  throw new Error(
    `等待超时（${timeout}ms）：${label}${lastError ? `；最后错误：${lastError.message}` : ''}`,
  );
}

/**
 * 用临时数据目录启动一个 Hub（随机端口）。
 * @returns {{ hub: object, base: string, dataDir: string, webDir: string, close: Function }}
 */
async function startHubAt(dataDir, overrides = {}) {
  const webDir = overrides.webDir || path.join(dataDir, 'web');
  const hub = await startHub({
    dataDir,
    webDir,
    port: 0,
    host: '127.0.0.1',
    silent: true,
    persistDebounceMs: 5,
    ...overrides,
  });
  return {
    hub,
    base: `http://127.0.0.1:${hub.port}`,
    dataDir,
    webDir,
    adminToken: hub.adminToken,
    joinCode: hub.joinCode,
    close: () => hub.close(),
  };
}

/** 启动一个带自动清理的 Hub（t.after 里关闭并删除临时目录）。 */
async function startTestHub(t, overrides = {}) {
  const dataDir = overrides.dataDir || (await makeTempDir());
  const env = await startHubAt(dataDir, overrides);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await env.hub.close();
    } finally {
      await fs.promises.rm(dataDir, { recursive: true, force: true });
    }
  };
  env.close = close;
  if (t && typeof t.after === 'function') t.after(close);
  return env;
}

/** 简单 JSON HTTP 客户端（默认不走 keep-alive，避免测试结束后残留连接）。 */
function request(base, method, pathName, { headers = {}, body, timeout = 20000 } = {}) {
  const url = new URL(pathName, base);
  return new Promise((resolve, reject) => {
    const requestHeaders = { ...headers };
    let payload;
    if (body !== undefined) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      requestHeaders['content-type'] = requestHeaders['content-type'] || 'application/json';
      requestHeaders['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: requestHeaders,
        agent: false,
        timeout,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`请求超时：${method} ${pathName}`)));
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function adminHeaders(env) {
  return { 'x-butler-token': env.adminToken };
}

function deviceHeaders(device) {
  return { 'x-butler-device-token': device.deviceToken };
}

async function registerDevice(env, manifest = {}, options = {}) {
  const res = await request(env.base, 'POST', '/api/devices/register', {
    headers: { 'x-butler-join-code': options.joinCode || env.joinCode, ...(options.headers || {}) },
    body: manifest,
  });
  if (res.status !== 200) throw new Error(`注册设备失败（${res.status}）：${res.text}`);
  const data = res.json;
  return { ...data, id: data.deviceId, token: data.deviceToken, response: res };
}

function heartbeat(env, device, body = {}) {
  return request(env.base, 'POST', `/api/devices/${device.deviceId}/heartbeat`, {
    headers: deviceHeaders(device),
    body,
  });
}

function ackTask(env, device, taskId) {
  return request(env.base, 'POST', `/api/devices/${device.deviceId}/tasks/${taskId}/ack`, {
    headers: deviceHeaders(device),
    body: { ok: true },
  });
}

function progressTask(env, device, taskId, body) {
  return request(env.base, 'POST', `/api/devices/${device.deviceId}/tasks/${taskId}/progress`, {
    headers: deviceHeaders(device),
    body,
  });
}

function resultTask(env, device, taskId, body) {
  return request(env.base, 'POST', `/api/devices/${device.deviceId}/tasks/${taskId}/result`, {
    headers: deviceHeaders(device),
    body,
  });
}

async function createTask(env, body) {
  const res = await request(env.base, 'POST', '/api/tasks', { headers: adminHeaders(env), body });
  if (res.status !== 200) throw new Error(`创建任务失败（${res.status}）：${res.text}`);
  return res.json.task;
}

async function getTask(env, taskId) {
  const res = await request(env.base, 'GET', `/api/tasks/${taskId}`, { headers: adminHeaders(env) });
  if (res.status !== 200) throw new Error(`读取任务失败（${res.status}）：${res.text}`);
  return res.json.task;
}

async function snapshot(env, limit = 50) {
  const res = await request(env.base, 'GET', `/api/snapshot?limit=${limit}`, {
    headers: adminHeaders(env),
  });
  if (res.status !== 200) throw new Error(`读取快照失败（${res.status}）：${res.text}`);
  return res.json;
}

async function readStateFile(dataDir) {
  const text = await fs.promises.readFile(path.join(dataDir, 'state.json'), 'utf8');
  return JSON.parse(text);
}

function parseSseFrame(raw) {
  const lines = raw.split(/\r?\n/);
  let event = 'message';
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  const text = dataLines.join('\n');
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { event, data, at: Date.now() };
}

/**
 * 打开一条 SSE 连接（管理员令牌走 ?token=）。
 * @returns {{ ready: Promise<object>, events: object[], waitForEvent: Function, close: Function, status: number, errorText: string }}
 */
function openSse(env, { token, query, headers = {} } = {}) {
  const url = new URL('/api/events', env.base);
  const search = new URLSearchParams(query || {});
  if (token !== null) search.set('token', token === undefined ? env.adminToken : token);
  url.search = search.toString();

  const state = {
    status: 0,
    errorText: '',
    events: [],
    closed: false,
    waiters: [],
  };
  let readyResolve;
  const ready = new Promise((resolve) => {
    readyResolve = resolve;
  });

  const settleWaiters = (event) => {
    for (const waiter of [...state.waiters]) {
      if (waiter.event !== event.event) continue;
      if (waiter.predicate && !waiter.predicate(event.data, event)) continue;
      state.waiters.splice(state.waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(event);
    }
  };

  const req = http.get(
    {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      agent: false,
      timeout: 0,
      headers: { accept: 'text/event-stream', ...headers },
    },
    (res) => {
      state.status = res.statusCode;
      if (res.statusCode !== 200) {
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          state.errorText += chunk;
        });
        res.on('end', () => readyResolve(state));
        res.on('error', () => readyResolve(state));
        return;
      }
      res.setEncoding('utf8');
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk;
        let idx = buffer.indexOf('\n\n');
        while (idx >= 0) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (raw.trim()) {
            const event = parseSseFrame(raw);
            state.events.push(event);
            settleWaiters(event);
          }
          idx = buffer.indexOf('\n\n');
        }
      });
      readyResolve(state);
    },
  );
  req.on('error', () => {
    readyResolve(state);
  });
  state.req = req;
  state.waitForEvent = (event, { timeout = 5000, predicate } = {}) =>
    new Promise((resolve, reject) => {
      const existing = state.events.find(
        (item) => item.event === event && (!predicate || predicate(item.data, item)),
      );
      if (existing) return resolve(existing);
      const waiter = { event, predicate, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const index = state.waiters.indexOf(waiter);
        if (index >= 0) state.waiters.splice(index, 1);
        reject(
          new Error(
            `等待 SSE 事件超时：${event}（已收到：${state.events.map((e) => e.event).join(',') || '无'}）`,
          ),
        );
      }, timeout);
      state.waiters.push(waiter);
    });
  state.close = () => {
    if (state.closed) return;
    state.closed = true;
    for (const waiter of state.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve({ event: '__closed__', data: null });
    }
    try {
      state.req.destroy();
    } catch {
      /* 忽略 */
    }
  };
  state.waitForEventReady = ready;
  return { ready, events: state.events, waitForEvent: state.waitForEvent, close: state.close, state };
}

module.exports = {
  DEFAULT_MANIFEST,
  makeManifest,
  makeTempDir,
  sleep,
  waitFor,
  startHubAt,
  startTestHub,
  request,
  adminHeaders,
  deviceHeaders,
  registerDevice,
  heartbeat,
  ackTask,
  progressTask,
  resultTask,
  createTask,
  getTask,
  snapshot,
  readStateFile,
  openSse,
};
