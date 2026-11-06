'use strict';

/**
 * Hub 核心：设备注册表、在线检测、任务编排、事件流、持久化恢复。
 * 仅依赖 Node 内置模块与 shared/protocol.js（协议唯一实现）。
 */

const path = require('node:path');

const protocol = require('../../shared/protocol.js');
const { createHttpServer } = require('./http');
const { StateStore } = require('./store');
const { badRequest, notFound, conflict } = require('./errors');
const { createPlan } = require('./planner');
const util = require('./util');

const { LIMITS, TASK_STATUS } = protocol;
const ACTIVE_TASK_STATUSES = new Set([TASK_STATUS.ASSIGNED, TASK_STATUS.RUNNING]);
const TERMINAL_TASK_STATUSES = new Set([
  TASK_STATUS.COMPLETED,
  TASK_STATUS.FAILED,
  TASK_STATUS.CANCELLED,
  TASK_STATUS.TIMEOUT,
]);
const DEVICE_STATUSES = new Set(['idle', 'busy', 'degraded', 'offline']);
const TASK_MESSAGES = {
  completed: '任务完成',
  failed: '任务失败',
  timeout: '任务超时',
  cancelled: '任务已取消',
};

function normalizeOutput(input) {
  if (!util.isPlainObject(input)) return null;
  const out = {};
  if (typeof input.text === 'string') out.text = input.text.slice(0, 20000);
  if (typeof input.markdown === 'string') out.markdown = input.markdown.slice(0, 50000);
  if (Array.isArray(input.artifacts)) {
    out.artifacts = input.artifacts
      .filter(util.isPlainObject)
      .slice(0, 20)
      .map((a) => ({
        name: util.str(a.name, 200),
        url: util.str(a.url, 500),
        path: util.str(a.path, 500),
      }));
  }
  if (input.data !== undefined) out.data = input.data;
  return Object.keys(out).length ? out : null;
}

class Hub {
  constructor(options = {}) {
    this.version = typeof options.version === 'string' ? options.version : '0.1.0';
    this.host = typeof options.host === 'string' ? options.host : '0.0.0.0';
    this.requestedPort = Number.isFinite(options.port) ? options.port : 7317;
    this.dataDir = path.resolve(
      typeof options.dataDir === 'string' ? options.dataDir : path.join(__dirname, '..', 'data'),
    );
    this.webDir = path.resolve(
      typeof options.webDir === 'string' ? options.webDir : path.join(__dirname, '..', 'web'),
    );

    this.ttlMs = util.clampInt(options.ttlMs, LIMITS.HEARTBEAT_TTL_MS, 50, 24 * 3600 * 1000);
    this.heartbeatIntervalMs = util.clampInt(
      options.heartbeatIntervalMs,
      LIMITS.HEARTBEAT_INTERVAL_MS,
      100,
      3600 * 1000,
    );
    this.ackTimeoutMs = util.clampInt(options.ackTimeoutMs, LIMITS.ASSIGN_ACK_TIMEOUT_MS, 20, 3600 * 1000);
    // 仅测试使用：把所有任务的实际执行超时固定为该毫秒数（协议允许的 timeoutSec 最小 30s）
    this.timeoutOverrideMs =
      Number.isFinite(options.timeoutOverrideMs) && options.timeoutOverrideMs > 0
        ? options.timeoutOverrideMs
        : null;
    this.sweepIntervalMs = util.clampInt(
      options.sweepIntervalMs,
      Math.max(50, Math.min(1000, Math.floor(this.ttlMs / 3))),
      20,
      60000,
    );
    this.planner = typeof options.planner === 'function' ? options.planner : createPlan;
    this.splitThresholdChars = util.clampInt(options.splitThresholdChars, 800, 100, 100000);
    this.splitTimeoutSec = util.clampInt(options.splitTimeoutSec, 900, 30, 86400);
    this.pingIntervalMs = util.clampInt(options.pingIntervalMs, 15000, 20, 3600 * 1000);
    this.persistDebounceMs = util.clampInt(options.persistDebounceMs, 150, 0, 60000);
    this.eventLimit = util.clampInt(options.eventLimit, 200, 20, 2000);
    this.taskEventLimit = util.clampInt(options.taskEventLimit, 100, 10, 500);
    this.silent = options.silent === true;
    this.maxCommandsPerDevice = 200;

    this.adminToken =
      util.str(options.adminToken, 300) || util.str(process.env.BUTLER_ADMIN_TOKEN, 300) || null;
    this.joinCode = util.str(options.joinCode, 100) || util.str(process.env.BUTLER_JOIN_CODE, 100) || null;

    this.devices = new Map();
    this.tasks = new Map();
    this.events = [];
    this.sseClients = new Set();
    this._timers = new Map(); // taskId -> { ack?: Timeout, timeout?: Timeout }
    this._sockets = new Set();
    this._initialized = false;
    this._closed = false;
    this.bootedAt = Date.now();
    this.server = null;
    this.port = null;
    this.url = null;

    this.store = new StateStore(path.join(this.dataDir, 'state.json'), () => this.serializeState(), {
      debounceMs: this.persistDebounceMs,
      onError: (err) => this.log('warn', `状态持久化失败：${err && err.message ? err.message : err}`),
    });

    this._sweepTimer = null;
    this._pingTimer = null;
  }

  // ---------------------------------------------------------------- 生命周期

  async init() {
    if (this._initialized) return this;
    this._initialized = true;

    const saved = await this.store.load();
    const savedObj = saved || {};

    if (!this.adminToken) {
      this.adminToken =
        typeof savedObj.adminToken === 'string' && savedObj.adminToken
          ? savedObj.adminToken
          : util.generateToken('adm');
    }
    if (!this.joinCode) {
      this.joinCode =
        typeof savedObj.joinCode === 'string' && savedObj.joinCode
          ? savedObj.joinCode
          : util.generateToken('join');
    }

    for (const raw of util.arr(savedObj.devices)) {
      const device = this._restoreDevice(raw);
      if (device) this.devices.set(device.id, device);
    }
    for (const raw of util.arr(savedObj.tasks)) {
      const task = this._restoreTask(raw);
      if (task) this.tasks.set(task.id, task);
    }
    this.events = util.arr(savedObj.events).slice(-this.eventLimit);

    // 重启语义：设备一律离线；assigned 重排（attempts 未超限），running 记 failed
    for (const task of [...this.tasks.values()]) {
      if (task.status === TASK_STATUS.ASSIGNED) {
        if (task.attempts < task.maxAttempts) {
          task.status = TASK_STATUS.QUEUED;
          task.assignedDeviceId = null;
          task.assignedDeviceName = null;
          task.updatedAt = protocol.nowIso();
          task.route = { reason: 'hub restarted; waiting for redispatch', candidates: [], excluded: [] };
          this._pushTaskEvent(task, 'requeued', 'Hub 重启，任务重新排队');
          this.broadcast('task.updated', { task: this.taskToJson(task) });
        } else {
          this._finishTask(task, TASK_STATUS.FAILED, {
            error: 'hub restarted',
            eventMessage: 'Hub 重启，任务失败',
          });
        }
      } else if (task.status === TASK_STATUS.RUNNING) {
        this._finishTask(task, TASK_STATUS.FAILED, {
          error: 'hub restarted',
          eventMessage: 'Hub 重启，运行中的任务失败',
        });
      }
    }

    this._sweepTimer = setInterval(() => this.sweepOffline(), this.sweepIntervalMs);
    if (this._sweepTimer.unref) this._sweepTimer.unref();
    this._pingTimer = setInterval(() => this._pingClients(), this.pingIntervalMs);
    if (this._pingTimer.unref) this._pingTimer.unref();

    this.schedulePersist();
    this.retryQueuedTasks('startup');
    return this;
  }

  async listen() {
    if (this.server) return this;
    this.server = createHttpServer(this);
    this.server.on('connection', (socket) => {
      this._sockets.add(socket);
      socket.on('close', () => this._sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        this.server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        this.server.removeListener('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.requestedPort, this.host);
    });
    const addr = this.server.address();
    this.port = addr && typeof addr === 'object' ? addr.port : this.requestedPort;
    const localHost = this.host === '0.0.0.0' || this.host === '::' || this.host === '' ? '127.0.0.1' : this.host;
    this.url = `http://${localHost}:${this.port}`;
    return this;
  }

  get lanUrl() {
    const ip = util.lanIPv4();
    return `http://${ip}:${this.port || this.requestedPort}`;
  }

  get uptimeSec() {
    return Math.max(0, Math.floor((Date.now() - this.bootedAt) / 1000));
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    if (this._sweepTimer) clearInterval(this._sweepTimer);
    if (this._pingTimer) clearInterval(this._pingTimer);
    this._sweepTimer = null;
    this._pingTimer = null;

    for (const timers of this._timers.values()) {
      if (timers.ack) clearTimeout(timers.ack);
      if (timers.timeout) clearTimeout(timers.timeout);
    }
    this._timers.clear();

    for (const client of this.sseClients) {
      try {
        if (!client.res.writableEnded) client.res.end();
      } catch {
        /* 忽略 */
      }
    }
    this.sseClients.clear();

    for (const device of this.devices.values()) {
      for (const waiter of device.waiters.splice(0)) {
        try {
          waiter.settle([]);
        } catch {
          /* 忽略 */
        }
      }
    }

    try {
      await this.store.close();
    } catch {
      /* 忽略持久化失败 */
    }

    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        server.close(done);
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        for (const socket of this._sockets) {
          try {
            socket.destroy();
          } catch {
            /* 忽略 */
          }
        }
        this._sockets.clear();
        const timer = setTimeout(done, 2000);
        if (timer.unref) timer.unref();
      });
    }
  }

  // ---------------------------------------------------------------- 序列化 / 恢复

  serializeState() {
    return {
      version: protocol.PROTOCOL_VERSION,
      hubVersion: this.version,
      savedAt: protocol.nowIso(),
      adminToken: this.adminToken,
      joinCode: this.joinCode,
      devices: [...this.devices.values()].map((device) => ({
        id: device.id,
        deviceToken: device.deviceToken,
        name: device.name,
        platform: device.platform,
        kind: device.kind,
        agentVersion: device.agentVersion,
        endpoint: device.endpoint,
        tags: [...device.tags],
        capabilities: device.capabilities,
        disabled: device.disabled,
        registeredAt: device.registeredAt,
        lastSeenAt: device.lastSeenAt,
      })),
      tasks: [...this.tasks.values()].map((task) => this.taskToJson(task)),
      events: this.events.slice(-this.eventLimit),
    };
  }

  _restoreDevice(raw) {
    if (!util.isPlainObject(raw)) return null;
    const id = util.str(raw.id, 80);
    if (!id) return null;
    const cap = util.isPlainObject(raw.capabilities) ? raw.capabilities : {};
    const limits = util.isPlainObject(cap.limits) ? cap.limits : {};
    const maxConcurrentTasks = util.clampInt(
      limits.maxConcurrentTasks,
      LIMITS.DEFAULT_CONCURRENT_TASKS,
      1,
      LIMITS.MAX_CONCURRENT_TASKS,
    );
    return {
      id,
      deviceToken: util.str(raw.deviceToken, 300),
      name: util.str(raw.name, LIMITS.MAX_NAME_LENGTH) || id,
      platform: util.str(raw.platform, 20) || 'other',
      kind: util.str(raw.kind, 30) || 'custom',
      agentVersion: util.str(raw.agentVersion, 40),
      endpoint: util.str(raw.endpoint, 300),
      tags: util.arr(raw.tags).map((t) => util.str(t, 40)).filter(Boolean),
      capabilities: {
        models: util.arr(cap.models),
        profiles: util.arr(cap.profiles),
        gateways: util.arr(cap.gateways),
        skills: util.arr(cap.skills),
        resources: util.isPlainObject(cap.resources) ? cap.resources : {},
        limits: { maxConcurrentTasks },
      },
      disabled: raw.disabled === true,
      online: false,
      status: 'offline',
      registeredAt: util.str(raw.registeredAt, 40) || protocol.nowIso(),
      lastSeenAt: util.str(raw.lastSeenAt, 40) || null,
      load: { running: 0, max: maxConcurrentTasks },
      reportedRunning: 0,
      metrics: {},
      commands: [],
      waiters: [],
    };
  }

  _restoreTask(raw) {
    if (!util.isPlainObject(raw)) return null;
    const id = util.str(raw.id, 80);
    if (!id) return null;
    const status = Object.values(TASK_STATUS).includes(raw.status) ? raw.status : TASK_STATUS.QUEUED;
    const createdAt = util.str(raw.createdAt, 40) || protocol.nowIso();
    const route = util.isPlainObject(raw.route)
      ? {
          reason: util.str(raw.route.reason, 500),
          candidates: util.arr(raw.route.candidates),
          excluded: util.arr(raw.route.excluded),
        }
      : { reason: '', candidates: [], excluded: [] };
    return {
      id,
      instruction: util.str(raw.instruction, LIMITS.MAX_INSTRUCTION_LENGTH),
      requirements: protocol.normalizeRequirements(raw.requirements),
      priority: util.clampInt(raw.priority, 5, 0, 9),
      status,
      assignedDeviceId: util.str(raw.assignedDeviceId, 80) || null,
      assignedDeviceName: util.str(raw.assignedDeviceName, LIMITS.MAX_NAME_LENGTH) || null,
      createdAt,
      updatedAt: util.str(raw.updatedAt, 40) || createdAt,
      startedAt: util.str(raw.startedAt, 40) || null,
      finishedAt: util.str(raw.finishedAt, 40) || null,
      attempts: util.clampInt(raw.attempts, 0, 0, 10),
      maxAttempts: util.clampInt(raw.maxAttempts, LIMITS.DEFAULT_TASK_ATTEMPTS, 1, LIMITS.MAX_TASK_ATTEMPTS),
      timeoutSec: util.clampInt(
        raw.timeoutSec,
        LIMITS.DEFAULT_TASK_TIMEOUT_SEC,
        LIMITS.MIN_TASK_TIMEOUT_SEC,
        LIMITS.MAX_TASK_TIMEOUT_SEC,
      ),
      output: raw.output === undefined ? null : raw.output,
      error: typeof raw.error === 'string' ? raw.error : null,
      progress: util.isPlainObject(raw.progress) ? raw.progress : null,
      route,
      events: util
        .arr(raw.events)
        .filter((e) => util.isPlainObject(e))
        .slice(-this.taskEventLimit),
      parentTaskId: util.str(raw.parentTaskId, 80) || null,
      childTaskIds: util.arr(raw.childTaskIds).map((id) => util.str(id, 80)).filter(Boolean),
      threadId: util.str(raw.threadId, 80) || id,
      replyToTaskId: util.str(raw.replyToTaskId, 80) || null,
      threadStep: util.clampInt(raw.threadStep, 1, 1, 10000),
      context: util.isPlainObject(raw.context) ? raw.context : null,
      isPlan: raw.isPlan === true,
      archived: raw.archived === true,
      archivedAt: util.str(raw.archivedAt, 40) || null,
      _avoidDeviceIds: [],
    };
  }

  // ---------------------------------------------------------------- 视图

  deviceToJson(device) {
    return {
      id: device.id,
      name: device.name,
      platform: device.platform,
      kind: device.kind,
      agentVersion: device.agentVersion,
      endpoint: device.endpoint,
      tags: [...device.tags],
      online: device.online,
      status: device.status,
      registeredAt: device.registeredAt,
      lastSeenAt: device.lastSeenAt,
      disabled: device.disabled,
      load: { running: device.load.running, max: device.load.max },
      metrics: { ...device.metrics },
      capabilities: device.capabilities,
    };
  }

  taskToJson(task) {
    return {
      id: task.id,
      instruction: task.instruction,
      requirements: { ...task.requirements, skills: [...task.requirements.skills], tags: [...task.requirements.tags] },
      priority: task.priority,
      status: task.status,
      assignedDeviceId: task.assignedDeviceId,
      assignedDeviceName: task.assignedDeviceName,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      attempts: task.attempts,
      maxAttempts: task.maxAttempts,
      timeoutSec: task.timeoutSec,
      output: task.output,
      error: task.error,
      progress: task.progress ? { ...task.progress } : null,
      parentTaskId: task.parentTaskId || null,
      childTaskIds: [...(task.childTaskIds || [])],
      threadId: task.threadId || task.id,
      replyToTaskId: task.replyToTaskId || null,
      threadStep: Number.isFinite(task.threadStep) ? task.threadStep : 1,
      context: task.context ? { ...task.context } : null,
      isPlan: Boolean(task.isPlan),
      archived: Boolean(task.archived),
      archivedAt: task.archivedAt || null,
      route: {
        reason: task.route.reason,
        candidates: task.route.candidates.map((c) => ({ ...c })),
        excluded: task.route.excluded.map((e) => ({ ...e })),
      },
      events: task.events.map((e) => ({ ...e })),
    };
  }

  stats() {
    let devicesOnline = 0;
    for (const device of this.devices.values()) if (device.online && !device.disabled) devicesOnline += 1;
    let tasksQueued = 0;
    let tasksAssigned = 0;
    let tasksRunning = 0;
    let tasksCompleted = 0;
    let tasksFailed = 0;
    for (const task of this.tasks.values()) {
      if (task.archived) continue;
      if (task.status === TASK_STATUS.QUEUED) tasksQueued += 1;
      else if (task.status === TASK_STATUS.ASSIGNED) tasksAssigned += 1;
      else if (task.status === TASK_STATUS.RUNNING) tasksRunning += 1;
      else if (task.status === TASK_STATUS.COMPLETED) tasksCompleted += 1;
      else if (task.status === TASK_STATUS.FAILED || task.status === TASK_STATUS.TIMEOUT) tasksFailed += 1;
    }
    return {
      devicesTotal: this.devices.size,
      devicesOnline,
      tasksQueued,
      tasksAssigned,
      tasksRunning,
      tasksCompleted,
      tasksFailed,
    };
  }

  snapshot(limit = 50) {
    const safeLimit = util.clampInt(limit, 50, 1, 200);
    const devices = [...this.devices.values()].map((device) => this.deviceToJson(device));
    const tasks = [...this.tasks.values()]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, safeLimit)
      .map((task) => this.taskToJson(task));
    return {
      server: { version: this.version, uptimeSec: this.uptimeSec, hubTime: protocol.nowIso() },
      stats: this.stats(),
      devices,
      tasks,
      events: this.events.slice(-safeLimit).map((event) => ({ ...event })),
    };
  }

  // ---------------------------------------------------------------- 事件 / 日志

  _recordEvent(type, data) {
    if (type === 'ping') return;
    const entry = { id: protocol.randomId('evt'), at: protocol.nowIso(), type, data };
    const task = data && data.task;
    const device = data && data.device;
    if (task && task.id) entry.taskId = task.id;
    if (device && device.id) entry.deviceId = device.id;
    if (data && data.deviceId && !entry.deviceId) entry.deviceId = data.deviceId;
    if (data && data.taskId && !entry.taskId) entry.taskId = data.taskId;
    if (data && typeof data.message === 'string' && data.message) entry.message = data.message;
    this.events.push(entry);
    if (this.events.length > this.eventLimit) this.events.splice(0, this.events.length - this.eventLimit);
  }

  broadcast(type, data, options = {}) {
    if (options.record !== false) this._recordEvent(type, data);
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of [...this.sseClients]) {
      try {
        if (client.res.writableEnded || client.res.destroyed) {
          this.sseClients.delete(client);
          continue;
        }
        client.res.write(frame);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  log(level, message) {
    const at = protocol.nowIso();
    if (!this.silent) {
      const line = `[hub] ${at} ${level.toUpperCase()} ${message}`;
      if (level === 'error') console.error(line);
      else console.log(line);
    }
    this.broadcast('log', { level, message, at });
  }

  _pushTaskEvent(task, type, message) {
    task.events.push({ at: protocol.nowIso(), type, message });
    if (task.events.length > this.taskEventLimit) {
      task.events.splice(0, task.events.length - this.taskEventLimit);
    }
  }

  attachSse(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    const client = { res };
    this.sseClients.add(client);
    this._writeSseFrame(client, 'snapshot', this.snapshot(50));
    const cleanup = () => {
      this.sseClients.delete(client);
      try {
        if (!res.writableEnded) res.end();
      } catch {
        /* 忽略 */
      }
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
    req.on('close', cleanup);
    return client;
  }

  _writeSseFrame(client, type, data) {
    try {
      if (client.res.writableEnded || client.res.destroyed) return false;
      client.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      return false;
    }
  }

  _pingClients() {
    const data = { hubTime: protocol.nowIso() };
    for (const client of [...this.sseClients]) {
      if (!this._writeSseFrame(client, 'ping', data)) this.sseClients.delete(client);
    }
  }

  // ---------------------------------------------------------------- 设备

  _requireDevice(id) {
    const device = this.devices.get(id);
    if (!device) throw notFound('设备不存在');
    return device;
  }

  getDevice(id) {
    return this.devices.get(id) || null;
  }

  isAdminToken(token) {
    return util.safeEqual(token, this.adminToken);
  }

  isValidJoinCode(code) {
    return util.safeEqual(code, this.joinCode);
  }

  verifyDeviceToken(device, token) {
    return !!device && util.safeEqual(token, device.deviceToken);
  }

  _applyManifest(device, manifest) {
    device.name = manifest.name;
    device.platform = manifest.platform;
    device.kind = manifest.kind;
    device.agentVersion = manifest.agentVersion;
    device.endpoint = manifest.endpoint;
    device.tags = [...manifest.tags];
    device.capabilities = {
      models: manifest.models,
      profiles: manifest.profiles,
      gateways: manifest.gateways,
      skills: manifest.skills,
      resources: manifest.resources,
      limits: manifest.limits,
    };
    device.load.max = manifest.limits.maxConcurrentTasks;
    if (device.load.running > device.load.max) device.load.running = device.load.max;
  }

  /** 新设备注册（需要加入码）。 */
  registerDevice(manifestInput) {
    const { manifest, errors } = protocol.normalizeManifest(manifestInput);
    if (errors.length) throw badRequest(errors.join('；'));

    const now = protocol.nowIso();
    const maxConcurrentTasks = manifest.limits.maxConcurrentTasks;
    const device = {
      id: protocol.randomId('dev'),
      deviceToken: util.generateToken('dtok'),
      name: manifest.name,
      platform: manifest.platform,
      kind: manifest.kind,
      agentVersion: manifest.agentVersion,
      endpoint: manifest.endpoint,
      tags: [...manifest.tags],
      capabilities: {
        models: manifest.models,
        profiles: manifest.profiles,
        gateways: manifest.gateways,
        skills: manifest.skills,
        resources: manifest.resources,
        limits: manifest.limits,
      },
      disabled: false,
      online: true,
      status: 'idle',
      registeredAt: now,
      lastSeenAt: now,
      load: { running: 0, max: maxConcurrentTasks },
      reportedRunning: 0,
      metrics: {},
      commands: [],
      waiters: [],
    };
    this.devices.set(device.id, device);
    this.broadcast('device.updated', { device: this.deviceToJson(device) });
    this.log('info', `设备注册：${device.name}（${device.id}，${device.platform}/${device.kind}）`);
    this.retryQueuedTasks('device registered');
    this.schedulePersist();
    return device;
  }

  /** 已注册设备通过 /manifest 或 register 更新能力。 */
  updateDeviceManifest(device, manifestInput) {
    const { manifest, errors } = protocol.normalizeManifest(manifestInput);
    if (errors.length) throw badRequest(errors.join('；'));
    this._applyManifest(device, manifest);
    const wasOffline = this.touch(device);
    // touch() 在离线→在线时已广播 device.updated，避免重复
    if (!wasOffline) this.broadcast('device.updated', { device: this.deviceToJson(device) });
    this.log('info', `设备能力更新：${device.name}（${device.id}）`);
    this.retryQueuedTasks('device manifest updated');
    this.schedulePersist();
    return device;
  }

  /** 心跳/命令轮询都会刷新存活时间；离线→在线时广播并重试排队任务。 */
  touch(device) {
    device.lastSeenAt = protocol.nowIso();
    const wasOffline = !device.online;
    device.online = true;
    if (device.status === 'offline') device.status = 'idle';
    if (wasOffline) {
      this.broadcast('device.online', {
        deviceId: device.id,
        name: device.name,
        at: device.lastSeenAt,
      });
      this.broadcast('device.updated', { device: this.deviceToJson(device) });
      this.log('info', `设备上线：${device.name}（${device.id}）`);
      this.retryQueuedTasks('device online');
    }
    return wasOffline;
  }

  handleHeartbeat(device, body) {
    const input = util.isPlainObject(body) ? body : {};
    this.touch(device);
    if (typeof input.status === 'string' && DEVICE_STATUSES.has(input.status) && input.status !== 'offline') {
      device.status = input.status;
    }
    if (util.isPlainObject(input.metrics)) {
      device.metrics = {
        cpuPct: Number.isFinite(input.metrics.cpuPct)
          ? util.clampNumber(input.metrics.cpuPct, 0, 0, 100)
          : device.metrics.cpuPct,
        memPct: Number.isFinite(input.metrics.memPct)
          ? util.clampNumber(input.metrics.memPct, 0, 0, 100)
          : device.metrics.memPct,
        uptimeSec: Number.isFinite(input.metrics.uptimeSec)
          ? Math.max(0, Math.trunc(input.metrics.uptimeSec))
          : device.metrics.uptimeSec,
      };
    }
    if (util.isPlainObject(input.load)) {
      // load.running 由任务生命周期维护；心跳上报只作为参考，且不得超过 limits
      device.reportedRunning = util.clampInt(
        input.load.running,
        device.reportedRunning || 0,
        0,
        this._maxConcurrent(device),
      );
    }
    this.broadcast('device.updated', { device: this.deviceToJson(device) }, { record: false });
    this.schedulePersist();
    const commands = this.takeCommands(device, 20);
    return { commands };
  }

  takeCommands(device, limit) {
    if (!device.commands.length) return [];
    return device.commands.splice(0, Math.max(1, limit));
  }

  enqueueCommand(device, command) {
    device.commands.push(command);
    if (device.commands.length > this.maxCommandsPerDevice) {
      device.commands.splice(0, device.commands.length - this.maxCommandsPerDevice);
    }
    this._notifyWaiters(device);
  }

  _notifyWaiters(device) {
    while (device.commands.length && device.waiters.length) {
      const waiter = device.waiters[0];
      const commands = this.takeCommands(device, waiter.limit || 5);
      waiter.settle(commands);
    }
  }

  /** 命令长轮询：无命令时挂起 waitMs（上限 30s）。 */
  addCommandWaiter(device, { waitMs = 25000, limit = 5, req = null } = {}) {
    const safeWait = util.clampInt(waitMs, 25000, 0, LIMITS.LONG_POLL_MAX_MS);
    const safeLimit = util.clampInt(limit, 5, 1, 50);
    const immediate = this.takeCommands(device, safeLimit);
    if (immediate.length) return Promise.resolve(immediate);
    if (safeWait <= 0) return Promise.resolve([]);
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const waiter = {
        limit: safeLimit,
        settle: (commands) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (req) req.removeListener('close', onClose);
          const idx = device.waiters.indexOf(waiter);
          if (idx >= 0) device.waiters.splice(idx, 1);
          resolve(commands);
        },
      };
      const onClose = () => waiter.settle([]);
      timer = setTimeout(() => waiter.settle([]), safeWait);
      if (timer.unref) timer.unref();
      if (req) req.once('close', onClose);
      device.waiters.push(waiter);
    });
  }

  markDeviceOffline(device, reason = 'device offline') {
    if (!device.online) return;
    device.online = false;
    device.status = 'offline';
    device.reportedRunning = 0;
    this.broadcast('device.offline', {
      deviceId: device.id,
      name: device.name,
      at: protocol.nowIso(),
    });
    this.broadcast('device.updated', { device: this.deviceToJson(device) });
    this.log('info', `设备离线：${device.name}（${device.id}，${reason}）`);
    this.handleDeviceLost(device, reason);
    this.schedulePersist();
  }

  sweepOffline() {
    const now = Date.now();
    for (const device of [...this.devices.values()]) {
      if (!device.online) continue;
      const lastSeen = device.lastSeenAt ? Date.parse(device.lastSeenAt) : 0;
      if (!Number.isFinite(lastSeen)) continue;
      if (now - lastSeen > this.ttlMs) this.markDeviceOffline(device, 'heartbeat timeout');
    }
  }

  removeDevice(device, reason = 'device removed') {
    for (const waiter of device.waiters.splice(0)) {
      try {
        waiter.settle([]);
      } catch {
        /* 忽略 */
      }
    }
    device.commands.length = 0;
    this.devices.delete(device.id);
    this.handleDeviceLost(device, reason);
    this.broadcast('device.offline', {
      deviceId: device.id,
      name: device.name,
      at: protocol.nowIso(),
    });
    this.log('info', `设备移除：${device.name}（${device.id}，${reason}）`);
    this.schedulePersist();
  }

  patchDevice(device, body) {
    const input = util.isPlainObject(body) ? body : {};
    let changed = false;
    if (typeof input.name === 'string') {
      const name = util.str(input.name, LIMITS.MAX_NAME_LENGTH);
      if (!name) throw badRequest('name 必须为 1-64 字符');
      device.name = name;
      changed = true;
    }
    if (Array.isArray(input.tags)) {
      device.tags = [...new Set(util.arr(input.tags).map((t) => util.str(t, 40)).filter(Boolean))];
      changed = true;
    }
    if (typeof input.disabled === 'boolean') {
      device.disabled = input.disabled;
      changed = true;
    }
    if (changed) {
      this.broadcast('device.updated', { device: this.deviceToJson(device) });
      if (device.disabled) this.handleDeviceLost(device, 'device disabled');
      this.retryQueuedTasks('device patched');
      this.schedulePersist();
    }
    return device;
  }

  // ---------------------------------------------------------------- 任务

  _requireTask(id) {
    const task = this.tasks.get(id);
    if (!task) throw notFound('任务不存在');
    return task;
  }

  getTask(id) {
    return this.tasks.get(id) || null;
  }

  listTasks({ status, deviceId, includeArchived = false, limit } = {}) {
    const safeLimit = util.clampInt(limit, 100, 1, 500);
    let tasks = [...this.tasks.values()];
    if (!includeArchived) tasks = tasks.filter((task) => !task.archived);
    if (typeof status === 'string' && status) tasks = tasks.filter((task) => task.status === status);
    if (typeof deviceId === 'string' && deviceId) {
      tasks = tasks.filter((task) => task.assignedDeviceId === deviceId);
    }
    tasks.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return tasks.slice(0, safeLimit).map((task) => this.taskToJson(task));
  }

  createTask(input) {
    const { ok, errors, value } = protocol.normalizeTaskRequest(input);
    if (!ok) throw badRequest(errors.join('；'));
    const now = protocol.nowIso();
    const taskId = protocol.randomId('task');
    const task = {
      id: taskId,
      instruction: value.instruction,
      requirements: value.requirements,
      priority: value.priority,
      status: TASK_STATUS.QUEUED,
      assignedDeviceId: null,
      assignedDeviceName: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      attempts: 0,
      maxAttempts: value.maxAttempts,
      timeoutSec: value.timeoutSec,
      output: null,
      error: null,
      progress: null,
      parentTaskId: input.parentTaskId ? String(input.parentTaskId) : null,
      childTaskIds: [],
      threadId: typeof input.threadId === 'string' && input.threadId ? input.threadId : taskId,
      replyToTaskId: typeof input.replyToTaskId === 'string' && input.replyToTaskId ? input.replyToTaskId : null,
      threadStep: Number.isFinite(Number(input.threadStep)) ? Math.max(1, Math.trunc(Number(input.threadStep))) : 1,
      context: util.isPlainObject(input.context) ? input.context : null,
      isPlan: false,
      archived: false,
      archivedAt: null,
      route: { reason: '等待路由', candidates: [], excluded: [] },
      events: [{ at: now, type: 'created', message: '任务已创建' }],
      _avoidDeviceIds: [],
    };
    this.tasks.set(task.id, task);
    this.broadcast('task.created', { task: this.taskToJson(task) });
    this.log('info', `任务创建：${task.id}「${util.truncate(task.instruction, 40)}」`);
    this.routeTask(task);
    this.schedulePersist();
    return task;
  }

  createFollowUp(source, input = {}) {
    if (!source) throw notFound('源任务不存在');
    if (!TERMINAL_TASK_STATUSES.has(source.status)) {
      throw conflict('只能对已完成/失败/超时/已取消的任务继续');
    }
    const normalized = protocol.normalizeTaskRequest(input);
    if (!normalized.ok) throw badRequest(normalized.errors.join('；'));
    const value = normalized.value;
    const threadTasks = [...this.tasks.values()]
      .filter((task) => (task.threadId || task.id) === (source.threadId || source.id))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const previousOutput = source.output
      ? (source.output.text || source.output.markdown || '')
      : '';
    const context = {
      sourceTaskId: source.id,
      threadId: source.threadId || source.id,
      step: threadTasks.length + 1,
      previousInstruction: source.instruction,
      previousOutput: String(previousOutput).slice(0, 8000),
      previousError: source.error || null,
      previousStatus: source.status,
      previousArtifacts: source.output && Array.isArray(source.output.artifacts)
        ? source.output.artifacts.slice(0, 10)
        : [],
      historySummary: threadTasks
        .slice(0, 10)
        .map((task) => `${task.threadStep || 1}. [${task.status}] ${util.truncate(task.instruction, 120)}`)
        .join('\n'),
    };
    const mergedRequirements = {
      ...source.requirements,
      skills: value.requirements.skills.length ? value.requirements.skills : source.requirements.skills,
      tags: value.requirements.tags.length ? value.requirements.tags : source.requirements.tags,
    };
    if (value.requirements.model) mergedRequirements.model = value.requirements.model;
    if (value.requirements.profile) mergedRequirements.profile = value.requirements.profile;
    if (value.requirements.gateway) mergedRequirements.gateway = value.requirements.gateway;
    if (value.requirements.deviceId) mergedRequirements.deviceId = value.requirements.deviceId;
    return this.createTask({
      instruction: value.instruction,
      requirements: mergedRequirements,
      priority: input.priority !== undefined ? value.priority : source.priority,
      timeoutSec: input.timeoutSec !== undefined ? value.timeoutSec : source.timeoutSec,
      maxAttempts: input.maxAttempts !== undefined ? value.maxAttempts : source.maxAttempts,
      threadId: source.threadId || source.id,
      replyToTaskId: source.id,
      threadStep: context.step,
      context,
    });
  }

  shouldAutoSplit(input) {
    if (!util.isPlainObject(input)) return false;
    if (input.split === false) return false;
    if (input.split === true) return true;
    const instruction = typeof input.instruction === 'string' ? input.instruction : '';
    const timeoutSec = Number(input.timeoutSec) || 0;
    return instruction.length >= this.splitThresholdChars || timeoutSec >= this.splitTimeoutSec;
  }

  /**
   * 长任务先用 Agnes AI 拆成子任务，再让每个子任务独立路由。
   * 规划失败时退化为普通任务，避免因为规划服务不可用而丢任务。
   */
  async createPlanTask(input) {
    let plan;
    try {
      plan = await this.planner({
        instruction: input.instruction,
        requirements: input.requirements || {},
        timeoutSec: input.timeoutSec,
      });
    } catch (err) {
      this.log('warn', `Agnes 长任务拆分失败，按普通任务执行：${err && err.message ? err.message : err}`);
      return this.createTask(input);
    }
    if (!plan || !Array.isArray(plan.subtasks) || plan.subtasks.length < 2) {
      this.log('warn', 'Agnes 没有返回有效子任务，按普通任务执行');
      return this.createTask(input);
    }
    const normalized = protocol.normalizeTaskRequest(input);
    if (!normalized.ok) throw badRequest(normalized.errors.join('；'));
    const value = normalized.value;
    const now = protocol.nowIso();
    const parentThreadId = protocol.randomId('thread');
    const parent = {
      id: protocol.randomId('task'),
      instruction: value.instruction,
      requirements: value.requirements,
      priority: value.priority,
      status: TASK_STATUS.RUNNING,
      assignedDeviceId: null,
      assignedDeviceName: 'Agnes 规划器',
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      finishedAt: null,
      attempts: 0,
      maxAttempts: value.maxAttempts,
      timeoutSec: value.timeoutSec,
      output: null,
      error: null,
      progress: { message: `Agnes 已拆分为 ${plan.subtasks.length} 个子任务`, percent: 0, logs: [], at: now },
      parentTaskId: null,
      childTaskIds: [],
      threadId: parentThreadId,
      replyToTaskId: null,
      threadStep: 1,
      context: null,
      isPlan: true,
      archived: false,
      archivedAt: null,
      route: {
        reason: `Agnes 长任务拆分：${plan.title || '长任务'}`,
        candidates: [],
        excluded: [],
      },
      events: [
        { at: now, type: 'created', message: '长任务已创建' },
        { at: now, type: 'plan', message: `Agnes 拆分为 ${plan.subtasks.length} 个子任务` },
      ],
      _avoidDeviceIds: [],
    };
    this.tasks.set(parent.id, parent);
    this.broadcast('task.created', { task: this.taskToJson(parent) });
    this.log('info', `Agnes 拆分任务：${parent.id} → ${plan.subtasks.length} 个子任务`);
    for (const subtask of plan.subtasks) {
      const child = this.createTask({
        instruction: subtask.instruction,
        requirements: value.requirements,
        priority: parent.priority,
        timeoutSec: subtask.timeoutSec,
        maxAttempts: parent.maxAttempts,
        parentTaskId: parent.id,
        threadId: parent.threadId,
        threadStep: 1,
      });
      parent.childTaskIds.push(child.id);
    }
    parent.updatedAt = protocol.nowIso();
    this.broadcast('task.updated', { task: this.taskToJson(parent) });
    this.schedulePersist();
    return parent;
  }

  _updateParentTask(child) {
    if (!child || !child.parentTaskId) return;
    const parent = this.tasks.get(child.parentTaskId);
    if (!parent || !parent.isPlan) return;
    const children = parent.childTaskIds.map((id) => this.tasks.get(id)).filter(Boolean);
    const finished = children.filter((task) => TERMINAL_TASK_STATUSES.has(task.status));
    const failed = finished.filter((task) => task.status !== TASK_STATUS.COMPLETED);
    parent.updatedAt = protocol.nowIso();
    if (finished.length < children.length) {
      parent.progress = {
        message: `子任务 ${finished.length}/${children.length} 已完成`,
        percent: children.length ? Math.round((finished.length / children.length) * 100) : 0,
        logs: [],
        at: parent.updatedAt,
      };
      this.broadcast('task.updated', { task: this.taskToJson(parent) });
      this.schedulePersist();
      return;
    }
    parent.status = failed.length ? TASK_STATUS.FAILED : TASK_STATUS.COMPLETED;
    parent.finishedAt = parent.updatedAt;
    parent.progress = { message: '全部子任务结束', percent: 100, logs: [], at: parent.updatedAt };
    parent.output = {
      text: `Agnes 拆分的 ${children.length} 个子任务已结束：完成 ${children.length - failed.length} 个，失败 ${failed.length} 个。`,
    };
    parent.error = failed.length ? `${failed.length} 个子任务失败` : null;
    parent.events.push({ at: parent.updatedAt, type: parent.status, message: parent.output.text });
    this.broadcast(parent.status === TASK_STATUS.COMPLETED ? 'task.completed' : 'task.failed', {
      task: this.taskToJson(parent),
    });
    this.schedulePersist();
  }

  archiveTask(task, archived = true) {
    const threadTasks = [...this.tasks.values()].filter(
      (item) => (item.threadId || item.id) === (task.threadId || task.id),
    );
    const targets = [...new Set([task, ...threadTasks, ...(task.childTaskIds || []).map((id) => this.tasks.get(id)).filter(Boolean)])];
    const at = protocol.nowIso();
    for (const item of targets) {
      item.archived = archived;
      item.archivedAt = archived ? at : null;
      item.updatedAt = at;
      this.broadcast('task.updated', { task: this.taskToJson(item) });
    }
    this.schedulePersist();
    return task;
  }

  deleteTask(task) {
    const threadTasks = [...this.tasks.values()].filter(
      (item) => (item.threadId || item.id) === (task.threadId || task.id),
    );
    const ids = [...new Set([
      task.id,
      ...threadTasks.map((item) => item.id),
      ...(task.childTaskIds || []),
    ])];
    for (const id of ids) {
      const item = this.tasks.get(id);
      if (!item) continue;
      this._clearTaskTimers(id);
      this.tasks.delete(id);
      this.broadcast('task.deleted', { taskId: id });
    }
    this.schedulePersist();
    return task;
  }

  _capabilitiesForMatch(device) {
    return { ...device.capabilities, tags: device.tags };
  }

  _maxConcurrent(device) {
    return Math.max(1, device.capabilities.limits.maxConcurrentTasks || 1);
  }

  /** 为 queued 任务计算候选并派发；无匹配保持 queued 并记录原因。 */
  routeTask(task) {
    if (task.status !== TASK_STATUS.QUEUED) return task;
    const requirements = task.requirements;
    const candidates = [];
    const excluded = [];

    for (const device of this.devices.values()) {
      let reason = null;
      if (device.disabled) {
        reason = 'disabled';
      } else if (!device.online) {
        reason = 'offline';
      } else if (device.load.running >= this._maxConcurrent(device)) {
        reason = `at capacity (${device.load.running}/${this._maxConcurrent(device)})`;
      } else if (requirements.deviceId && requirements.deviceId !== device.id) {
        reason = 'deviceId mismatch';
      } else {
        const matched = protocol.matchRequirements(this._capabilitiesForMatch(device), requirements);
        if (!matched.ok) reason = `missing ${matched.missing.join(', ')}`;
      }
      if (reason) {
        excluded.push({ deviceId: device.id, reason });
        continue;
      }
      const scored = protocol.scoreDevice(
        {
          id: device.id,
          capabilities: this._capabilitiesForMatch(device),
          load: device.load,
          lastSeenAt: device.lastSeenAt,
        },
        requirements,
      );
      if (scored.score < 0) {
        excluded.push({ deviceId: device.id, reason: `missing ${scored.missing.join(', ')}` });
        continue;
      }
      candidates.push({
        deviceId: device.id,
        score: scored.score,
        matched: scored.matched,
        lastSeenAt: device.lastSeenAt || '',
      });
    }

    candidates.sort(
      (a, b) =>
        b.score - a.score || String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)),
    );

    const avoid = new Set(task._avoidDeviceIds || []);
    const usable = avoid.size ? candidates.filter((c) => !avoid.has(c.deviceId)) : candidates;
    const pickedCandidate = usable[0] || candidates[0];

    if (!pickedCandidate) {
      task.status = TASK_STATUS.QUEUED;
      task.assignedDeviceId = null;
      task.assignedDeviceName = null;
      task.updatedAt = protocol.nowIso();
      const firstReason = excluded.length ? excluded[0].reason : 'no devices registered';
      task.route = {
        reason: `no matching device (${excluded.length} excluded): ${firstReason}`,
        candidates: [],
        excluded: excluded.slice(0, 10),
      };
      this._pushTaskEvent(task, 'queued', `暂无匹配设备：${firstReason}`);
      this.broadcast('task.updated', { task: this.taskToJson(task) });
      return task;
    }

    if (!avoid.has(pickedCandidate.deviceId)) task._avoidDeviceIds = [];

    const device = this.devices.get(pickedCandidate.deviceId);
    if (!device) return task;

    const now = protocol.nowIso();
    task.attempts += 1;
    task.status = TASK_STATUS.ASSIGNED;
    task.assignedDeviceId = device.id;
    task.assignedDeviceName = device.name;
    task.updatedAt = now;
    task.error = null;
    task.route = {
      reason: `matched ${candidates.length} candidate${candidates.length === 1 ? '' : 's'}; picked ${device.id} (score ${pickedCandidate.score})`,
      candidates: candidates.slice(0, 5).map((c) => ({
        deviceId: c.deviceId,
        score: c.score,
        matched: c.matched,
      })),
      excluded: excluded.slice(0, 10),
    };
    this._pushTaskEvent(
      task,
      'assigned',
      `派发到 ${device.name}（第 ${task.attempts}/${task.maxAttempts} 次尝试）`,
    );
    this.enqueueCommand(device, this._buildRunCommand(task, device));
    this._setTaskTimer(task.id, 'ack', () => {
      if (task.status !== TASK_STATUS.ASSIGNED || task.assignedDeviceId !== device.id) return;
      this._dispatchFailure(task, device, 'ack timeout');
    }, this.ackTimeoutMs);
    this._setTaskTimer(task.id, 'timeout', () => {
      if (task.status !== TASK_STATUS.ASSIGNED && task.status !== TASK_STATUS.RUNNING) return;
      this._timeoutTask(task);
    }, this._timeoutMsFor(task));
    this.broadcast('task.updated', { task: this.taskToJson(task) });
    this.log('info', `任务派发：${task.id} → ${device.name}（score ${pickedCandidate.score}）`);
    this.schedulePersist();
    return task;
  }

  /** 设备上线 / 能力变化 / 启动后重试所有排队任务（优先级高者先）。 */
  retryQueuedTasks(reason = '') {
    const queued = [...this.tasks.values()]
      .filter((task) => task.status === TASK_STATUS.QUEUED)
      .sort((a, b) => b.priority - a.priority || String(a.createdAt).localeCompare(String(b.createdAt)));
    for (const task of queued) this.routeTask(task);
    if (queued.length && reason) this.schedulePersist();
  }

  _buildRunCommand(task, device) {
    return {
      id: protocol.randomId('cmd'),
      type: 'run_task',
      taskId: task.id,
      createdAt: protocol.nowIso(),
      payload: {
        instruction: task.instruction,
        requirements: { ...task.requirements },
        priority: task.priority,
        timeoutSec: task.timeoutSec,
        threadId: task.threadId,
        replyToTaskId: task.replyToTaskId || null,
        threadStep: task.threadStep || 1,
        context: {
          deviceName: device.name,
          requestedAt: protocol.nowIso(),
          ...(task.context || {}),
        },
      },
    };
  }

  _buildCancelCommand(task, reason) {
    return {
      id: protocol.randomId('cmd'),
      type: 'cancel_task',
      taskId: task.id,
      createdAt: protocol.nowIso(),
      payload: { taskId: task.id, reason },
    };
  }

  _removeTaskCommand(device, taskId) {
    if (!device) return;
    device.commands = device.commands.filter((cmd) => !(cmd && cmd.taskId === taskId));
  }

  _timeoutMsFor(task) {
    return this.timeoutOverrideMs != null ? this.timeoutOverrideMs : Math.max(1000, task.timeoutSec * 1000);
  }

  _setTaskTimer(taskId, name, fn, ms) {
    let entry = this._timers.get(taskId);
    if (!entry) {
      entry = {};
      this._timers.set(taskId, entry);
    }
    if (entry[name]) clearTimeout(entry[name]);
    const timer = setTimeout(fn, Math.max(1, ms));
    if (timer.unref) timer.unref();
    entry[name] = timer;
  }

  _clearTaskTimers(taskId) {
    const entry = this._timers.get(taskId);
    if (!entry) return;
    if (entry.ack) clearTimeout(entry.ack);
    if (entry.timeout) clearTimeout(entry.timeout);
    this._timers.delete(taskId);
  }

  _adjustLoad(deviceId, delta) {
    const device = deviceId ? this.devices.get(deviceId) : null;
    if (!device) return;
    const max = this._maxConcurrent(device);
    device.load.running = util.clampInt(device.load.running + delta, 0, 0, max);
  }

  /** 派发失败（ack 超时/设备离线）：maxAttempts 内重排，否则 failed。 */
  _dispatchFailure(task, device, reason) {
    if (task.status !== TASK_STATUS.ASSIGNED && task.status !== TASK_STATUS.RUNNING) return;
    const wasRunning = task.status === TASK_STATUS.RUNNING;
    this._clearTaskTimers(task.id);
    this._removeTaskCommand(device, task.id);

    if (task.attempts < task.maxAttempts) {
      if (wasRunning) this._adjustLoad(device.id, -1);
      const avoid = new Set(task._avoidDeviceIds || []);
      avoid.add(device.id);
      task._avoidDeviceIds = [...avoid];
      task.status = TASK_STATUS.QUEUED;
      task.assignedDeviceId = null;
      task.assignedDeviceName = null;
      task.updatedAt = protocol.nowIso();
      this._pushTaskEvent(
        task,
        'retry',
        `${reason}，重新调度（${task.attempts}/${task.maxAttempts}）`,
      );
      this.broadcast('task.updated', { task: this.taskToJson(task) });
      this.log('warn', `任务重派：${task.id}（${reason}）`);
      this.routeTask(task);
      this.schedulePersist();
      return;
    }

    this._finishTask(task, TASK_STATUS.FAILED, {
      error: `dispatch failed: ${reason}`,
      eventMessage: `${reason}，已达最大尝试次数`,
    });
  }

  handleDeviceLost(device, reason) {
    const affected = [...this.tasks.values()].filter(
      (task) => task.assignedDeviceId === device.id && ACTIVE_TASK_STATUSES.has(task.status),
    );
    for (const task of affected) this._dispatchFailure(task, device, reason);
  }

  _timeoutTask(task) {
    const device = task.assignedDeviceId ? this.devices.get(task.assignedDeviceId) : null;
    if (device) this._removeTaskCommand(device, task.id);
    this._finishTask(task, TASK_STATUS.TIMEOUT, {
      output: null,
      error: `任务执行超时（${task.timeoutSec}s）`,
      eventMessage: `${task.timeoutSec}s 内未完成`,
    });
    if (device) this.enqueueCommand(device, this._buildCancelCommand(task, 'timeout'));
  }

  _finishTask(task, status, { output, error, eventMessage } = {}) {
    const wasRunning = task.status === TASK_STATUS.RUNNING;
    this._clearTaskTimers(task.id);
    task.status = status;
    task.finishedAt = protocol.nowIso();
    task.updatedAt = task.finishedAt;
    if (output !== undefined) task.output = output;
    if (error !== undefined) task.error = error;
    if (wasRunning) this._adjustLoad(task.assignedDeviceId, -1);
    if (status === TASK_STATUS.COMPLETED) {
      task.progress = { message: '任务完成', percent: 100, logs: [], at: task.finishedAt };
    }
    this._pushTaskEvent(task, status, eventMessage || TASK_MESSAGES[status] || status);
    const eventName =
      status === TASK_STATUS.COMPLETED
        ? 'task.completed'
        : status === TASK_STATUS.CANCELLED
          ? 'task.updated'
          : 'task.failed';
    this.broadcast(eventName, { task: this.taskToJson(task) });
    this.log(
      status === TASK_STATUS.COMPLETED ? 'info' : 'warn',
      `${TASK_MESSAGES[status] || `状态 ${status}`}：${task.id}`,
    );
    this._updateParentTask(task);
    this.schedulePersist();
    return task;
  }

  handleAck(device, taskId) {
    const task = this._requireTask(taskId);
    if (task.assignedDeviceId !== device.id) throw conflict('任务未分配给该设备');
    if (task.status === TASK_STATUS.ASSIGNED) {
      this._clearTaskTimers(task.id);
      task.status = TASK_STATUS.RUNNING;
      task.startedAt = task.startedAt || protocol.nowIso();
      task.updatedAt = protocol.nowIso();
      this._adjustLoad(device.id, 1);
      this._setTaskTimer(task.id, 'timeout', () => {
        if (task.status !== TASK_STATUS.RUNNING) return;
        this._timeoutTask(task);
      }, this._timeoutMsFor(task));
      this._pushTaskEvent(task, 'ack', '设备已确认任务');
      this.broadcast('task.updated', { task: this.taskToJson(task) });
      this.schedulePersist();
    } else if (task.status === TASK_STATUS.RUNNING) {
      // 幂等：重复 ack 直接返回
    } else if (TERMINAL_TASK_STATUSES.has(task.status)) {
      // 幂等：设备迟到的 ack 不改变终态
    } else {
      throw conflict(`任务状态 ${task.status} 不可确认`);
    }
    return task;
  }

  handleProgress(device, taskId, body) {
    const task = this._requireTask(taskId);
    if (task.assignedDeviceId !== device.id) throw conflict('任务未分配给该设备');
    if (!ACTIVE_TASK_STATUSES.has(task.status)) throw conflict(`任务状态 ${task.status} 不接受进度`);
    const input = util.isPlainObject(body) ? body : {};
    const message = util.str(input.message, 500);
    task.progress = {
      message,
      percent: Number.isFinite(input.percent) ? util.clampInt(input.percent, 0, 0, 100) : null,
      logs: util
        .arr(input.logs)
        .slice(-20)
        .map((line) => util.str(line, 300))
        .filter(Boolean),
      at: protocol.nowIso(),
    };
    task.updatedAt = task.progress.at;
    this._pushTaskEvent(task, 'progress', message || `进度 ${task.progress.percent == null ? '' : `${task.progress.percent}%`}`.trim());
    this.broadcast('task.updated', { task: this.taskToJson(task) });
    this.schedulePersist();
    return task;
  }

  handleResult(device, taskId, body) {
    const task = this._requireTask(taskId);
    if (task.assignedDeviceId !== device.id) throw conflict('任务未分配给该设备');
    if (!ACTIVE_TASK_STATUSES.has(task.status)) throw conflict(`任务状态 ${task.status} 不接受结果`);
    const input = util.isPlainObject(body) ? body : {};
    const ok = input.ok !== false;
    const output = normalizeOutput(input.output);
    if (ok) {
      this._finishTask(task, TASK_STATUS.COMPLETED, { output, error: null, eventMessage: '任务完成' });
    } else {
      const message = util.str(input.error, 1000) || '设备执行失败';
      this._finishTask(task, TASK_STATUS.FAILED, {
        output,
        error: message,
        eventMessage: message,
      });
    }
    return task;
  }

  cancelTask(task) {
    if (task.isPlan) {
      for (const childId of task.childTaskIds || []) {
        const child = this.tasks.get(childId);
        if (child && [TASK_STATUS.QUEUED, TASK_STATUS.ASSIGNED, TASK_STATUS.RUNNING].includes(child.status)) {
          try {
            this.cancelTask(child);
          } catch {
            /* 子任务可能已结束 */
          }
        }
      }
      this._finishTask(task, TASK_STATUS.CANCELLED, { error: null, eventMessage: '长任务已取消' });
      return task;
    }
    if (![TASK_STATUS.QUEUED, TASK_STATUS.ASSIGNED, TASK_STATUS.RUNNING].includes(task.status)) {
      throw conflict(`任务状态 ${task.status} 不可取消`);
    }
    const device = task.assignedDeviceId ? this.devices.get(task.assignedDeviceId) : null;
    if (device) {
      this._removeTaskCommand(device, task.id);
      if (ACTIVE_TASK_STATUSES.has(task.status)) {
        this.enqueueCommand(device, this._buildCancelCommand(task, 'cancelled'));
      }
    }
    this._finishTask(task, TASK_STATUS.CANCELLED, { error: null, eventMessage: '任务已取消' });
    return task;
  }

  retryTask(task) {
    if (![TASK_STATUS.FAILED, TASK_STATUS.TIMEOUT, TASK_STATUS.CANCELLED].includes(task.status)) {
      throw conflict(`任务状态 ${task.status} 不可重试`);
    }
    this._clearTaskTimers(task.id);
    task.status = TASK_STATUS.QUEUED;
    task.attempts = 0;
    task.assignedDeviceId = null;
    task.assignedDeviceName = null;
    task.startedAt = null;
    task.finishedAt = null;
    task.output = null;
    task.error = null;
    task.progress = null;
    task.route = { reason: '等待重新路由', candidates: [], excluded: [] };
    task._avoidDeviceIds = [];
    task.updatedAt = protocol.nowIso();
    this._pushTaskEvent(task, 'retried', '任务重新提交');
    this.broadcast('task.updated', { task: this.taskToJson(task) });
    this.log('info', `任务重试：${task.id}`);
    this.routeTask(task);
    this.schedulePersist();
    return task;
  }

  // ---------------------------------------------------------------- 持久化

  schedulePersist() {
    this.store.schedule();
  }

  async flushState() {
    await this.store.flush();
  }
}

async function createHub(options = {}) {
  const hub = new Hub(options);
  await hub.init();
  return hub;
}

async function startHub(options = {}) {
  const hub = await createHub(options);
  await hub.listen();
  return hub;
}

module.exports = {
  Hub,
  createHub,
  startHub,
  normalizeOutput,
  TERMINAL_TASK_STATUSES,
  ACTIVE_TASK_STATUSES,
};
