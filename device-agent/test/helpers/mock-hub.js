'use strict';

/**
 * 进程内 Mock Hub：只实现 docs/PROTOCOL.md 的设备侧协议子集，
 * 用于 device-agent 的注册/心跳/领命令/ack/progress/result 全链路测试。
 *
 * 不依赖 hub/** 的任何实现，仅使用 node:http。
 */

const http = require('node:http');
const { URL } = require('node:url');

function nowIso() {
  return new Date().toISOString();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  if (res.writableEnded) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function errorBody(code, message, status) {
  return { status, body: { error: { code, message } } };
}

class MockHub {
  constructor(options = {}) {
    this.joinCode = options.joinCode || 'test-join';
    this.adminToken = options.adminToken || 'test-admin';
    this.heartbeatIntervalMs = options.heartbeatIntervalMs || 150;

    this.devices = new Map(); // id -> { id, token, manifest, name, online, status, load }
    this.queues = new Map(); // id -> Command[]
    this.waiters = new Map(); // id -> [{ res, timer }]
    this.nextHeartbeatCommands = []; // 下一次任意设备心跳时下发的命令
    this.records = {
      registers: [],
      manifests: [],
      heartbeats: [],
      acks: [],
      progresses: [],
      results: [],
      unregisters: [],
    };
    this.seq = 0;
    this.server = http.createServer((req, res) => {
      this._handle(req, res).catch((err) => {
        try {
          send(res, 500, { error: { code: 'internal', message: String((err && err.message) || err) } });
        } catch {
          /* ignore */
        }
      });
    });
  }

  get url() {
    return `http://127.0.0.1:${this.port}`;
  }

  async listen() {
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = this.server.address().port;
    return this.url;
  }

  async close() {
    for (const list of this.waiters.values()) {
      for (const waiter of list) {
        clearTimeout(waiter.timer);
        try {
          send(waiter.res, 200, { commands: [] });
        } catch {
          /* ignore */
        }
      }
    }
    this.waiters.clear();
    await new Promise((resolve) => this.server.close(resolve));
  }

  // ---- 测试辅助 ----

  /** 向指定设备投递命令；若有挂起的长轮询立即下发。 */
  pushCommand(deviceId, command) {
    const waiters = this.waiters.get(deviceId);
    if (waiters && waiters.length > 0) {
      const waiter = waiters.shift();
      clearTimeout(waiter.timer);
      send(waiter.res, 200, { commands: [command] });
      return;
    }
    if (!this.queues.has(deviceId)) this.queues.set(deviceId, []);
    this.queues.get(deviceId).push(command);
  }

  /** 下一次任意设备心跳时下发该命令（用于测试心跳回包领命令）。 */
  commandForNextHeartbeat(command) {
    this.nextHeartbeatCommands.push(command);
  }

  takeCommands(deviceId) {
    const commands = [];
    if (this.nextHeartbeatCommands.length > 0) commands.push(...this.nextHeartbeatCommands.splice(0));
    const queued = this.queues.get(deviceId) || [];
    if (queued.length > 0) commands.push(...queued.splice(0));
    return commands;
  }

  deviceList() {
    return [...this.devices.values()];
  }

  findResult(taskId) {
    return this.records.results.find((record) => record.taskId === taskId) || null;
  }

  async waitFor(predicate, options = {}) {
    const timeoutMs = options.timeoutMs || 5000;
    const intervalMs = options.intervalMs || 10;
    const label = options.label || '条件';
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`等待超时（${timeoutMs}ms）：${label}`);
  }

  // ---- HTTP 路由 ----

  async _handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    const method = req.method || 'GET';

    if (method === 'GET' && parts[0] === 'api' && parts[1] === 'health') {
      send(res, 200, {
        ok: true,
        name: 'mock-hub',
        version: '0.0.0-test',
        protocol: 1,
        uptimeSec: 1,
        hubTime: nowIso(),
      });
      return;
    }

    if (method === 'POST' && parts[0] === 'api' && parts[1] === 'devices' && parts[2] === 'register') {
      await this._register(req, res);
      return;
    }

    if (parts[0] === 'api' && parts[1] === 'devices' && parts[2]) {
      const deviceId = decodeURIComponent(parts[2]);
      const device = this.devices.get(deviceId);
      if (!device) {
        send(res, 404, errorBody('not_found', '设备不存在', 404).body);
        return;
      }
      if (!this._checkDeviceToken(req, device)) {
        send(res, 401, errorBody('unauthorized', '设备令牌无效', 401).body);
        return;
      }

      if (method === 'POST' && parts[3] === 'manifest') {
        const body = await readBody(req);
        device.manifest = body;
        if (typeof body.name === 'string') device.name = body.name;
        this.records.manifests.push({ deviceId, body, headers: req.headers });
        send(res, 200, { ok: true, device });
        return;
      }
      if (method === 'POST' && parts[3] === 'heartbeat') {
        const body = await readBody(req);
        device.load = body.load || device.load;
        device.status = body.status || device.status;
        this.records.heartbeats.push({ deviceId, body });
        const commands = this.takeCommands(deviceId);
        send(res, 200, {
          ok: true,
          hubTime: nowIso(),
          heartbeatIntervalMs: this.heartbeatIntervalMs,
          ttlSec: 30,
          commands,
        });
        return;
      }
      if (method === 'GET' && parts[3] === 'commands') {
        await this._commands(deviceId, url, res);
        return;
      }
      if (method === 'POST' && parts[3] === 'tasks' && parts[4] && parts[5]) {
        const taskId = decodeURIComponent(parts[4]);
        const action = parts[5];
        const body = await readBody(req);
        if (action === 'ack') {
          this.records.acks.push({ deviceId, taskId, body });
          send(res, 200, { ok: true, task: { id: taskId, status: 'running', assignedDeviceId: deviceId } });
          return;
        }
        if (action === 'progress') {
          this.records.progresses.push({ deviceId, taskId, body });
          send(res, 200, { ok: true });
          return;
        }
        if (action === 'result') {
          this.records.results.push({ deviceId, taskId, body, at: nowIso() });
          send(res, 200, { ok: true, task: { id: taskId, status: body.ok ? 'completed' : 'failed' } });
          return;
        }
      }
      if (method === 'POST' && parts[3] === 'unregister') {
        this.devices.delete(deviceId);
        this.records.unregisters.push({ deviceId });
        send(res, 200, { ok: true });
        return;
      }
    }

    send(res, 404, errorBody('not_found', `未知路由：${method} ${url.pathname}`, 404).body);
  }

  _checkDeviceToken(req, device) {
    return req.headers['x-butler-device-token'] === device.token;
  }

  async _register(req, res) {
    const body = await readBody(req);
    if (typeof body.name !== 'string' || !body.name) {
      send(res, 400, errorBody('bad_request', 'name 必填', 400).body);
      return;
    }
    const providedToken = req.headers['x-butler-device-token'];
    const providedId = req.headers['x-butler-device-id'] || body.deviceId;
    if (providedId && providedToken) {
      const device = this.devices.get(providedId);
      if (!device || device.token !== providedToken) {
        send(res, 401, errorBody('unauthorized', '设备令牌无效', 401).body);
        return;
      }
      device.manifest = body;
      device.name = body.name;
      this.records.manifests.push({ deviceId: providedId, body, headers: req.headers });
      send(res, 200, {
        deviceId: providedId,
        deviceToken: providedToken,
        heartbeatIntervalMs: this.heartbeatIntervalMs,
        ttlSec: 30,
        hubTime: nowIso(),
      });
      return;
    }

    const joinCode = req.headers['x-butler-join-code'];
    if (!joinCode || joinCode !== this.joinCode) {
      send(res, 401, errorBody('unauthorized', '加入码无效', 401).body);
      return;
    }
    this.seq += 1;
    const id = `dev_test${String(this.seq).padStart(2, '0')}`;
    const token = `tok_test${String(this.seq).padStart(2, '0')}`;
    const device = {
      id,
      token,
      manifest: body,
      name: body.name,
      online: true,
      status: 'idle',
      load: body.limits && body.limits.maxConcurrentTasks ? { running: 0, max: body.limits.maxConcurrentTasks } : { running: 0, max: 1 },
    };
    this.devices.set(id, device);
    this.records.registers.push({ deviceId: id, manifest: body, headers: req.headers });
    send(res, 200, {
      deviceId: id,
      deviceToken: token,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      ttlSec: 30,
      hubTime: nowIso(),
    });
  }

  async _commands(deviceId, url, res) {
    const waitMs = Math.max(0, Math.min(5000, Number(url.searchParams.get('waitMs')) || 0));
    const queued = this.takeCommands(deviceId);
    if (queued.length > 0) {
      send(res, 200, { commands: queued });
      return;
    }
    if (waitMs <= 0) {
      send(res, 200, { commands: [] });
      return;
    }
    const waiter = { res, timer: null };
    waiter.timer = setTimeout(() => {
      const list = this.waiters.get(deviceId) || [];
      const index = list.indexOf(waiter);
      if (index >= 0) list.splice(index, 1);
      send(res, 200, { commands: [] });
    }, waitMs);
    if (!this.waiters.has(deviceId)) this.waiters.set(deviceId, []);
    this.waiters.get(deviceId).push(waiter);
  }
}

module.exports = { MockHub };
