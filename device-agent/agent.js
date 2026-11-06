#!/usr/bin/env node
'use strict';

/**
 * BattleStar 设备代理。
 *
 * 流程（docs/PROTOCOL.md §8）：
 *   探测能力 → 注册（首次用加入码；之后用本地 deviceId+deviceToken 更新 manifest）
 *   → 心跳循环（默认 10s，携带 status/load/metrics，顺带领取命令）
 *   → 空闲时 GET /commands?waitMs=25000 长轮询
 *   → 收到 run_task 先 ack，再按 limits.maxConcurrentTasks 并发执行
 *   → 周期 progress（>=800ms 节流）→ result
 *   断线指数退避（1s→30s）；SIGINT 优雅注销退出。
 *
 * CLI：
 *   node device-agent/agent.js --hub http://127.0.0.1:7317 --join-code ABCD \
 *     --name 书房工作站 --config device-agent/config.example.json --state-dir ~/.super-butler --once
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { discover, loadConfig, AGENT_VERSION } = require('./lib/discovery');
const { createExecutor, makeProgressThrottle } = require('./lib/executors');
const { createLogger } = require('./lib/logger');
const { HubClient, ApiError } = require('./lib/hub-client');
const { normalizeBaseUrl } = require('./lib/http');
const { discoverHub, hubPortFromUrl } = require('./lib/hub-discovery');
const { resolveStateDir, resolveStateFile, loadState, saveState } = require('./lib/state');
const { createMetricsSampler } = require('./lib/metrics');
const { normalizeManifest } = require('../shared/protocol.js');

const DEFAULTS = Object.freeze({
  hub: 'http://127.0.0.1:7317',
  intervalMs: 10000,
  pollWaitMs: 25000,
  minHeartbeatMs: 1000,
  maxHeartbeatMs: 60000,
  stopTimeoutMs: 6000,
  idleBackoffMs: 200,
  maxSeenCommandIds: 500,
  backoffBaseMs: 1000,
  backoffMaxMs: 30000,
});

function isNetworkError(err) {
  if (!err) return false;
  if (err.isNetworkError) return true;
  if (err.name === 'AbortError') return false;
  return /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network|socket hang up/i.test(
    `${err.code || ''} ${err.message || ''}`,
  );
}

/** 配置/参数错误：不可重试，CLI 以退出码 2 结束。 */
class FatalSetupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FatalSetupError';
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function clampInt(value, min, max, fallback) {
  const n = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : fallback;
  return Math.min(max, Math.max(min, n));
}

function shorten(text, maxLength) {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function pickCapabilities(manifest) {
  return {
    tags: asArray(manifest && manifest.tags),
    models: asArray(manifest && manifest.models),
    profiles: asArray(manifest && manifest.profiles),
    gateways: asArray(manifest && manifest.gateways),
    skills: asArray(manifest && manifest.skills),
    resources: (manifest && manifest.resources) || {},
    limits: (manifest && manifest.limits) || { maxConcurrentTasks: 1 },
  };
}

class Agent {
  /**
   * @param {object} [options]
   * @param {string} [options.hub] Hub 地址
   * @param {string} [options.joinCode] 首次注册加入码
   * @param {string} [options.name] 设备名
   * @param {object} [options.config] 配置文件内容（能力/执行器/发现开关）
   * @param {string} [options.stateDir] 状态目录
   * @param {string} [options.stateFile] 状态文件（优先于 stateDir）
   * @param {number} [options.intervalMs] 心跳间隔
   * @param {number} [options.pollWaitMs] 空闲长轮询等待
   * @param {string} [options.executorType] 强制执行器类型
   * @param {object} [options.manifest] 跳过能力探测，直接使用给定 manifest（测试用）
   * @param {object} [options.logger] 自定义 logger
   * @param {object} [options.env] 环境变量
   */
  constructor(options = {}) {
    this.options = options;
    this.env = options.env || process.env;
    this.config = isPlainObject(options.config) ? { ...options.config } : {};
    this.log = options.logger || createLogger({ level: 'info', prefix: options.name || 'agent' });

    this.hubUrl = normalizeBaseUrl(options.hub || this.config.hub || DEFAULTS.hub);
    this.joinCode = options.joinCode || this.config.joinCode || this.env.BUTLER_JOIN_CODE || null;
    this.autoDiscover = options.discoverHub !== undefined
      ? options.discoverHub !== false
      : this.config.discoverHub !== false;
    if (this.env.BUTLER_DISCOVER_HUB === '0') this.autoDiscover = false;
    this.needsDiscovery = false;
    this.lastDiscoveryAt = 0;
    this.intervalMs = clampInt(
      options.intervalMs !== undefined ? options.intervalMs : this.config.intervalMs,
      DEFAULTS.minHeartbeatMs,
      DEFAULTS.maxHeartbeatMs,
      DEFAULTS.intervalMs,
    );
    this.pollWaitMs = clampInt(
      options.pollWaitMs !== undefined ? options.pollWaitMs : this.config.pollWaitMs,
      0,
      30000,
      DEFAULTS.pollWaitMs,
    );
    this.stopTimeoutMs = clampInt(options.stopTimeoutMs, 0, 60000, DEFAULTS.stopTimeoutMs);

    const explicitName = options.name || this.config.name;
    this.stateName = explicitName || os.hostname();
    this.stateDir = resolveStateDir({ stateDir: options.stateDir || this.config.stateDir, env: this.env });
    this.stateFile = resolveStateFile({
      stateFile: options.stateFile,
      stateDir: this.stateDir,
      name: this.stateName,
      hubUrl: this.hubUrl,
    });

    this.state = null;
    this.manifest = null;
    this.device = null;
    this.client = null;
    this.executor = null;
    this.maxConcurrent = 1;
    this.deviceCapabilities = null;

    this.queue = [];
    this.running = new Map();
    this.executions = new Set();
    this.seenCommandIds = new Set();
    this.seenCommandOrder = [];

    this.stopped = false;
    this.connecting = null;
    this.failures = 0;
    this.heartbeatLoopPromise = null;
    this.pollLoopPromise = null;
    this.sleepers = new Set();
    this.pollAbort = new AbortController();

    this.metrics = createMetricsSampler();
    this.startedAt = Date.now();
    this.stats = {
      registeredAt: null,
      heartbeats: 0,
      polls: 0,
      commands: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      tasksCancelled: 0,
    };

    this._stopPromise = new Promise((resolve) => {
      this._resolveStop = resolve;
    });
  }

  // -------------------------------------------------------------------------
  // 初始化
  // -------------------------------------------------------------------------

  async init() {
    // 1. 本地状态
    const loaded = await loadState(this.stateFile);
    if (loaded.error) this.log.warn(loaded.error);
    this.state = loaded.state;
    if (this.state && this.state.hub && !this.options.hub && !this.config.hub) {
      if (normalizeBaseUrl(this.state.hub) !== this.hubUrl) {
        this.log.warn(
          `状态文件所属 Hub（${this.state.hub}）与当前 Hub（${this.hubUrl}）不一致，将按当前 Hub 重新注册`,
        );
        this.state = null;
      }
    }

    // 2. 能力探测 + config 合并
    const effectiveConfig = { ...this.config };
    if (this.options.name) effectiveConfig.name = this.options.name;
    if (this.options.kind) effectiveConfig.kind = this.options.kind;
    if (this.options.platform) effectiveConfig.platform = this.options.platform;
    if (this.options.endpoint) effectiveConfig.endpoint = this.options.endpoint;
    if (asArray(this.options.tags).length) {
      effectiveConfig.tags = [...asArray(this.options.tags), ...asArray(effectiveConfig.tags)];
    }
    effectiveConfig.discovery = {
      ...(isPlainObject(this.config.discovery) ? this.config.discovery : {}),
      ...(this.options.noDsh ? { dsh: false } : {}),
      ...(this.options.noOllama ? { ollama: false } : {}),
    };
    this.config = effectiveConfig;

    let manifest;
    if (this.options.manifest) {
      const normalized = normalizeManifest(this.options.manifest);
      if (normalized.errors.length) throw new FatalSetupError(`manifest 校验失败：${normalized.errors.join('；')}`);
      manifest = normalized.manifest;
    } else {
      const discovered = await discover({
        config: effectiveConfig,
        env: this.env,
        homeDir: this.options.homeDir,
        dshHome: this.options.dshHome,
        ollamaHost: this.options.ollamaHost,
      });
      manifest = discovered.manifest;
      for (const warning of discovered.warnings) this.log.warn(`能力探测：${warning}`);
      this.log.debug(`探测结果：${JSON.stringify(discovered.probing)}`);
    }

    // 第一次运行用主机名占位时，沿用状态文件里保存的设备名，避免设备“换名”
    if (!this.options.name && !this.config.name && this.state && nonEmptyString(this.state.name)) {
      manifest.name = this.state.name.slice(0, 64);
    }
    this.manifest = manifest;
    this.maxConcurrent = clampInt(manifest.limits && manifest.limits.maxConcurrentTasks, 1, 8, 1);
    this.deviceCapabilities = pickCapabilities(manifest);
    this.executor = createExecutor({
      config: effectiveConfig,
      type: this.options.executorType,
      hubUrl: this.hubUrl,
      env: this.env,
      cwd: this.options.cwd,
      stateDir: this.stateDir,
      log: this.log,
    });

    this.log.info(
      `能力清单：${manifest.name}（${manifest.kind}/${manifest.platform}）｜` +
        `模型 ${manifest.models.length}｜技能 ${manifest.skills.length}｜` +
        `profile ${manifest.profiles.length}｜gateway ${manifest.gateways.length}｜` +
        `并发 ${this.maxConcurrent}｜执行器 ${this.executor.type}`,
    );
    return this.manifest;
  }

  // -------------------------------------------------------------------------
  // 注册 / 重连
  // -------------------------------------------------------------------------

  async connect() {
    if (this.stopped) throw new FatalSetupError('设备代理已停止');
    if (this.device && this.client) return this.device;
    if (this.connecting) return this.connecting;
    this.connecting = this._establish()
      .catch((err) => {
        this.connecting = null;
        throw err;
      })
      .then((device) => {
        this.connecting = null;
        return device;
      });
    return this.connecting;
  }

  async _discoverHub() {
    if (!this.autoDiscover) return false;
    const now = Date.now();
    if (now - this.lastDiscoveryAt < 15000) return false;
    this.lastDiscoveryAt = now;
    const port = hubPortFromUrl(this.hubUrl, 7317);
    this.log.info(`Hub 不可达，正在局域网自动发现 :${port} …`);
    try {
      const found = await discoverHub({ port, timeoutMs: 700, concurrency: 48 });
      if (!found) {
        this.log.warn(`局域网未发现 Hub（端口 ${port}），继续使用 ${this.hubUrl}`);
        return false;
      }
      if (found.baseUrl !== this.hubUrl) {
        this.log.info(`自动发现 Hub：${found.baseUrl}（${found.name}）`);
        this.hubUrl = found.baseUrl;
      }
      this.needsDiscovery = false;
      return true;
    } catch (err) {
      this.log.warn(`局域网发现 Hub 失败：${err && err.message ? err.message : err}`);
      return false;
    }
  }

  async _establish() {
    if (this.needsDiscovery) {
      await this._discoverHub();
      this.needsDiscovery = false;
    }
    // 2.1 有本地令牌：先用 POST /:id/manifest 更新并恢复
    if (this.state && this.state.deviceId && this.state.deviceToken) {
      const resumeClient = new HubClient({
        baseUrl: this.hubUrl,
        deviceId: this.state.deviceId,
        deviceToken: this.state.deviceToken,
        joinCode: this.joinCode,
      });
      try {
        const res = await resumeClient.updateManifest(this.manifest);
        this.client = resumeClient;
        this.device = this._deviceFromManifest(res.json && res.json.device);
        this.stats.registeredAt = this.stats.registeredAt || this.state.registeredAt || new Date().toISOString();
        if (this.state.hub !== this.hubUrl) {
          this.state.hub = this.hubUrl;
          try {
            await saveState(this.stateFile, this.state);
          } catch (err) {
            this.log.warn(`保存自动发现的新 Hub 地址失败：${err.message}`);
          }
        }
        this.log.info(`已用本地令牌恢复设备 ${this.state.deviceId}，manifest 已更新`);
        this._onConnected();
        return this.device;
      } catch (err) {
        if (err instanceof ApiError && err.isAuthError) {
          this.log.warn(`本地设备令牌已失效（HTTP ${err.status} ${err.code}），改用加入码重新注册`);
          this.state = { ...this.state, deviceId: null, deviceToken: null };
        } else if (err instanceof ApiError && !err.isNetworkError) {
          throw new FatalSetupError(`更新设备 manifest 失败：${err.message}`);
        } else {
          throw err; // 网络问题：交给外层退避重试
        }
      }
    }

    // 2.2 首次注册（需要加入码）
    if (!this.joinCode) {
      throw new FatalSetupError(
        '设备尚未注册，且未提供加入码：请用 --join-code <code> 或设置环境变量 BUTLER_JOIN_CODE',
      );
    }
    const regClient = new HubClient({ baseUrl: this.hubUrl, joinCode: this.joinCode });
    let res;
    try {
      res = await regClient.register(this.manifest, {
        joinCode: this.joinCode,
        deviceId: this.state && this.state.deviceId,
        deviceToken: this.state && this.state.deviceToken,
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        throw new FatalSetupError(`注册被拒绝（${err.code}）：加入码无效或已过期，请检查 --join-code`);
      }
      if (err instanceof ApiError && err.status === 403) {
        throw new FatalSetupError(`注册被拒绝（${err.code}）：Hub 不允许该设备注册`);
      }
      if (err instanceof ApiError && err.status === 409) {
        throw new FatalSetupError(`注册冲突（${err.code}）：${err.message}`);
      }
      throw err;
    }

    const body = (res.json && typeof res.json === 'object' && res.json) || {};
    if (!nonEmptyString(body.deviceId) || !nonEmptyString(body.deviceToken)) {
      throw new FatalSetupError('注册响应缺少 deviceId/deviceToken，请确认 Hub 实现符合协议 §5.2');
    }
    regClient.setDevice(body.deviceId, body.deviceToken);
    this.client = regClient;
    this.device = this._deviceFromManifest(null, body.deviceId);
    if (Number.isFinite(body.heartbeatIntervalMs)) {
      this.intervalMs = clampInt(body.heartbeatIntervalMs, DEFAULTS.minHeartbeatMs, DEFAULTS.maxHeartbeatMs, this.intervalMs);
    }
    this.state = {
      version: 1,
      hub: this.hubUrl,
      deviceId: body.deviceId,
      deviceToken: body.deviceToken,
      name: this.manifest.name,
      platform: this.manifest.platform,
      kind: this.manifest.kind,
      agentVersion: AGENT_VERSION,
      registeredAt: new Date().toISOString(),
    };
    this.stats.registeredAt = this.state.registeredAt;
    try {
      await saveState(this.stateFile, this.state);
      this.log.info(`设备已注册：${this.manifest.name}（deviceId=${body.deviceId}，令牌保存至 ${this.stateFile}）`);
    } catch (err) {
      this.log.warn(`注册成功但保存状态文件失败（重启后需加入码）：${err.message}`);
    }
    this._onConnected();
    return this.device;
  }

  _deviceFromManifest(device, fallbackId) {
    return {
      id: (device && device.id) || fallbackId || (this.state && this.state.deviceId) || null,
      name: (device && device.name) || this.manifest.name,
      platform: (device && device.platform) || this.manifest.platform,
      kind: (device && device.kind) || this.manifest.kind,
      capabilities: pickCapabilities(this.manifest),
      limits: this.manifest.limits,
    };
  }

  _onConnected() {
    if (this.failures > 0) this.log.info('与 Hub 的连接已恢复');
    this.failures = 0;
  }

  _onLoopSuccess() {
    if (this.failures > 0) this.log.info('与 Hub 的连接已恢复');
    this.failures = 0;
  }

  _backoffDelay() {
    const exponent = Math.max(0, this.failures - 1);
    return Math.min(DEFAULTS.backoffMaxMs, DEFAULTS.backoffBaseMs * 2 ** exponent);
  }

  _handleLoopError(label, err) {
    if (this.stopped) return;
    if (err && err.name === 'AbortError') return;

    if (err instanceof ApiError && err.isAuthError) {
      this.log.warn(`${label}鉴权失败（HTTP ${err.status} ${err.code}），清除本地令牌并尝试重新注册`);
      this.device = null;
      if (this.state) this.state = { ...this.state, deviceId: null, deviceToken: null };
    } else {
      if (isNetworkError(err)) {
        this.device = null;
        this.client = null;
        this.needsDiscovery = true;
      }
      this.log.warn(`${label}失败：${err && err.message ? err.message : err}`);
    }
    this.failures += 1;
    if (this.failures === 1 || this.failures % 5 === 0) {
      this.log.warn(`连接异常：指数退避重连（第 ${this.failures} 次，下次等待 ${this._backoffDelay()}ms，上限 ${DEFAULTS.backoffMaxMs}ms）`);
    }
  }

  async _ensureConnected() {
    if (this.device && this.client) return this.device;
    return this.connect();
  }

  // -------------------------------------------------------------------------
  // 心跳 / 长轮询
  // -------------------------------------------------------------------------

  _sampleMetrics() {
    try {
      return this.metrics();
    } catch {
      return { cpuPct: null, memPct: null, uptimeSec: Math.round((Date.now() - this.startedAt) / 1000) };
    }
  }

  async _heartbeatOnce() {
    const payload = {
      status: this.running.size > 0 ? 'busy' : 'idle',
      load: { running: this.running.size, max: this.maxConcurrent },
      metrics: this._sampleMetrics(),
      taskIds: [...this.running.keys()],
    };
    const res = await this.client.heartbeat(payload);
    const body = (res.json && typeof res.json === 'object' && res.json) || {};
    this.stats.heartbeats += 1;
    if (Number.isFinite(body.heartbeatIntervalMs)) {
      this.intervalMs = clampInt(body.heartbeatIntervalMs, DEFAULTS.minHeartbeatMs, DEFAULTS.maxHeartbeatMs, this.intervalMs);
    }
    return body;
  }

  _startHeartbeatLoop() {
    this.heartbeatLoopPromise = (async () => {
      while (!this.stopped) {
        const tickStart = Date.now();
        let failed = false;
        try {
          await this._ensureConnected();
          const body = await this._heartbeatOnce();
          this._onLoopSuccess();
          this.enqueueCommands(body.commands);
        } catch (err) {
          failed = true;
          this._handleLoopError('心跳', err);
        }
        const wait = failed ? this._backoffDelay() : Math.max(200, this.intervalMs - (Date.now() - tickStart));
        await this._sleep(wait);
      }
    })().catch((err) => {
      if (!this.stopped) this.log.error(`心跳循环异常退出：${err && err.message}`);
    });
  }

  _startPollLoop() {
    this.pollLoopPromise = (async () => {
      while (!this.stopped) {
        if (!this.device || !this.client || this.queue.length > 0 || this.running.size >= this.maxConcurrent) {
          await this._sleep(DEFAULTS.idleBackoffMs);
          continue;
        }
        try {
          const limit = Math.max(1, this.maxConcurrent - this.running.size);
          const res = await this.client.pollCommands({
            waitMs: this.pollWaitMs,
            limit,
            signal: this.pollAbort.signal,
          });
          this.stats.polls += 1;
          this._onLoopSuccess();
          const commands = (res.json && res.json.commands) || [];
          if (commands.length) this.enqueueCommands(commands);
          await this._sleep(commands.length ? 50 : DEFAULTS.idleBackoffMs);
        } catch (err) {
          if (this.stopped || (err && err.name === 'AbortError')) break;
          this._handleLoopError('长轮询', err);
          await this._sleep(this._backoffDelay());
        }
      }
    })().catch((err) => {
      if (!this.stopped) this.log.error(`长轮询循环异常退出：${err && err.message}`);
    });
  }

  // -------------------------------------------------------------------------
  // 命令队列与执行
  // -------------------------------------------------------------------------

  enqueueCommands(commands) {
    for (const command of asArray(commands)) {
      if (!command || !nonEmptyString(command.id)) continue;
      if (this.seenCommandIds.has(command.id)) continue;
      this.seenCommandIds.add(command.id);
      this.seenCommandOrder.push(command.id);
      while (this.seenCommandOrder.length > DEFAULTS.maxSeenCommandIds) {
        this.seenCommandIds.delete(this.seenCommandOrder.shift());
      }
      this.queue.push(command);
      const payload = isPlainObject(command.payload) ? command.payload : {};
      const taskId = command.taskId || payload.taskId || '';
      this.log.info(`收到命令 ${command.id}（${command.type}${taskId ? `，任务 ${taskId}` : ''}）`);
    }
    this._pump();
  }

  _pump() {
    if (this.stopped) return;
    while (this.queue.length > 0 && this.running.size < this.maxConcurrent) {
      const command = this.queue.shift();
      const promise = this._runCommand(command)
        .catch((err) => {
          this.log.error(`命令处理异常：${err && err.message ? err.message : err}`);
        })
        .finally(() => {
          this.executions.delete(promise);
        });
      this.executions.add(promise);
    }
  }

  _materializeAttachments(task) {
    if (!Array.isArray(task.attachments) || !task.attachments.length) return;
    const dir = path.join(this.stateDir, 'attachments', task.id);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const paths = [];
      task.attachments.forEach((file, index) => {
        if (!file || !file.data) return;
        const safe = String(file.name || `file-${index + 1}`).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
        const target = path.join(dir, `${index + 1}-${safe}`);
        fs.writeFileSync(target, Buffer.from(String(file.data), 'base64'));
        paths.push(target);
      });
      if (paths.length) {
        task.attachmentPaths = paths;
        task.instruction = `【任务附件】\n以下是用户随任务上传的文件，请直接读取：\n${paths.map((p) => `- ${p}`).join('\n')}\n\n${task.instruction}`;
      }
    } catch (err) {
      this.log.warn(`附件写入失败：${err && err.message ? err.message : err}`);
    }
  }

  _taskFromCommand(command) {
    const payload = isPlainObject(command.payload) ? command.payload : {};
    return {
      id: command.taskId || payload.taskId || command.id,
      commandId: command.id,
      instruction: typeof payload.instruction === 'string' ? payload.instruction : '',
      requirements: isPlainObject(payload.requirements) ? payload.requirements : {},
      priority: Number.isFinite(payload.priority) ? payload.priority : 5,
      timeoutSec: Number.isFinite(payload.timeoutSec) ? payload.timeoutSec : 300,
      context: isPlainObject(payload.context) ? payload.context : {},
      attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
      threadId: typeof payload.threadId === 'string' ? payload.threadId : '',
      replyToTaskId: typeof payload.replyToTaskId === 'string' ? payload.replyToTaskId : null,
      threadStep: Number.isFinite(payload.threadStep) ? payload.threadStep : 1,
      createdAt: command.createdAt || null,
    };
  }

  _taskTimeoutMs(task) {
    const timeoutSec = clampInt(task && task.timeoutSec, 1, 3600, 300);
    return timeoutSec * 1000 + 500;
  }

  _currentDeviceId() {
    return (this.device && this.device.id) || (this.client && this.client.deviceId) || null;
  }

  _answerTask(taskId, text) {
    if (!taskId) return;
    const record = this.running.get(taskId);
    if (!record) {
      this.log.warn(`回答命令：任务 ${taskId} 当前未在执行`);
      return;
    }
    if (record.answerResolve) record.answerResolve(text);
    else record.pendingAnswer = String(text || '');
  }

  _cancelTask(taskId, reason = 'cancelled') {
    if (!taskId) return;
    const record = this.running.get(taskId);
    if (!record) {
      this.log.warn(`取消命令：任务 ${taskId} 当前未在执行`);
      return;
    }
    this.log.info(`收到取消指令，正在中止任务 ${taskId}`);
    record.cancelled = true;
    if (record.answerReject) record.answerReject(new Error('任务已取消'));
    record.controller.abort(reason);
  }

  async _runCommand(command) {
    const type = command.type;
    const payload = isPlainObject(command.payload) ? command.payload : {};
    const taskId = command.taskId || payload.taskId || null;

    if (type === 'cancel_task' || type === 'cancel') {
      this._cancelTask(taskId, 'cancelled');
      return;
    }
    if (type === 'answer_task') {
      this._answerTask(taskId, payload.text);
      return;
    }
    if (type !== 'run_task') {
      this.log.warn(`忽略未知命令类型：${type}`);
      return;
    }
    if (!taskId) {
      this.log.warn('run_task 命令缺少 taskId，已忽略');
      return;
    }
    if (this.running.has(taskId)) {
      // Hub 重派/重复下发时，任务其实还在本机执行：重新 ack 并报一次进度，
      // 避免 Hub 等 30s 后把“仍在跑”的任务判成 ack timeout。
      this._ackTask(taskId)
        .then(() => this.client.progress(taskId, { message: '任务仍在执行，重复派发已确认', percent: undefined }))
        .catch((err) => this.log.warn(`重复任务 ${taskId} 重新确认失败：${err && err.message ? err.message : err}`));
      return;
    }

    const task = this._taskFromCommand(command);
    this._materializeAttachments(task);
    const context = isPlainObject(task.context) ? task.context : {};
    if (context.previousInstruction || context.previousOutput || context.previousError) {
      const parts = ['【BattleStar 任务线程上下文】'];
      if (Number.isFinite(context.step)) parts.push(`当前是第 ${context.step} 步。`);
      if (context.previousInstruction) parts.push(`上一步任务：\n${String(context.previousInstruction).slice(0, 6000)}`);
      if (context.previousOutput) parts.push(`上一步输出：\n${String(context.previousOutput).slice(0, 8000)}`);
      if (context.previousError) parts.push(`上一步错误：\n${String(context.previousError).slice(0, 2000)}`);
      if (context.historySummary) parts.push(`更早的步骤：\n${String(context.historySummary).slice(0, 4000)}`);
      parts.push('【当前任务】');
      task.instruction = `${parts.join('\n\n')}\n\n${task.instruction}`;
    }
    const controller = new AbortController();
    const record = {
      taskId,
      commandId: command.id,
      task,
      controller,
      startedAt: Date.now(),
      timeoutTimer: null,
      timedOut: false,
      cancelled: false,
      finished: false,
      waiting: false,
      pendingAnswer: null,
      answerResolve: null,
      answerReject: null,
    };
    const requestAnswer = (question, mikaTaskId) => new Promise((resolve, reject) => {
      const deliver = (text) => {
        record.waiting = false;
        record.answerResolve = null;
        record.answerReject = null;
        record.pendingAnswer = null;
        if (record.timeoutTimer) record.timeoutTimer.refresh();
        this.client.progress(taskId, { message: '收到回答，继续执行…', waiting: false }).catch(() => {});
        resolve(String(text || ''));
      };
      if (record.pendingAnswer !== null && record.pendingAnswer !== undefined) {
        deliver(record.pendingAnswer);
        return;
      }
      record.waiting = true;
      record.answerResolve = deliver;
      record.answerReject = (err) => {
        record.answerResolve = null;
        record.answerReject = null;
        record.waiting = false;
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const onAbort = () => {
        if (record.answerReject) record.answerReject(new Error('任务已中止'));
      };
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener('abort', onAbort, { once: true });
      this.client.progress(taskId, {
        message: '等待回答',
        waiting: true,
        question: String(question || ''),
        mikaTaskId: String(mikaTaskId || ''),
        percent: undefined,
      }).catch(() => {});
    });
    this.running.set(taskId, record);
    this.stats.commands += 1;
    this.log.info(`开始执行任务 ${taskId}：${shorten(task.instruction, 40)}`);

    const progress = makeProgressThrottle(async (message, percent) => {
      if (record.finished) return;
      const body = { message: String(message).slice(0, 200) };
      if (Number.isFinite(percent)) body.percent = Math.max(0, Math.min(100, Math.round(percent)));
      await this.client.progress(taskId, body);
    });

    record.timeoutTimer = setTimeout(() => {
      record.timedOut = true;
      controller.abort('timeout');
    }, this._taskTimeoutMs(task));
    if (record.timeoutTimer.unref) record.timeoutTimer.unref();

    try {
      const acked = await this._ackTask(taskId);
      if (!acked) return;
      await progress('已接收任务，开始执行…', 2);
      const outcome = await this.executor.run({
        task,
        command,
        device: {
          id: this._currentDeviceId(),
          name: this.manifest && this.manifest.name,
          platform: this.manifest && this.manifest.platform,
          capabilities: this.deviceCapabilities,
        },
        signal: controller.signal,
        progress,
        requestAnswer,
        log: this.log,
      });
      if (record.finished) return;
      const ok = !(outcome && outcome.error);
      await this._reportResult(record, {
        ok,
        output: outcome && outcome.output,
        error: outcome && outcome.error,
        durationMs: Date.now() - record.startedAt,
      });
      if (ok) this.stats.tasksCompleted += 1;
      else this.stats.tasksFailed += 1;
      this.log.info(`任务 ${taskId} ${ok ? '完成' : `失败（${outcome.error}）`}，用时 ${Date.now() - record.startedAt}ms`);
    } catch (err) {
      if (record.finished) return;
      const durationMs = Date.now() - record.startedAt;
      if (err && err.name === 'AbortError') {
        if (record.timedOut) {
          this.stats.tasksFailed += 1;
          this.log.warn(`任务 ${taskId} 执行超时（${Math.round(durationMs / 1000)}s），已中止`);
          await this._reportResult(record, { ok: false, error: 'timeout', durationMs });
        } else {
          this.stats.tasksCancelled += 1;
          this.log.warn(`任务 ${taskId} 已取消，用时 ${durationMs}ms`);
          await this._reportResult(record, { ok: false, error: 'cancelled', durationMs });
        }
      } else {
        this.stats.tasksFailed += 1;
        const message = String(err && err.message ? err.message : err).slice(0, 500);
        this.log.error(`任务 ${taskId} 执行失败：${message}`);
        await this._reportResult(record, { ok: false, error: message, durationMs });
      }
    } finally {
      if (record.timeoutTimer) clearTimeout(record.timeoutTimer);
      this.running.delete(taskId);
      this._pump();
    }
  }

  async _ackTask(taskId) {
    try {
      await this.client.ack(taskId);
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.isAuthError) {
        this._handleLoopError('ack', err);
        return false;
      }
      if (err instanceof ApiError && !err.isNetworkError) {
        this.log.warn(`任务 ${taskId} ack 被拒绝（HTTP ${err.status} ${err.code}），跳过执行`);
        return false;
      }
      this.log.warn(`任务 ${taskId} ack 网络失败（${err.message}），本次不执行，等待 Hub 重派`);
      return false;
    }
  }

  async _reportResult(record, payload) {
    record.finished = true;
    if (!this.client || !this._currentDeviceId()) {
      this.log.warn(`任务 ${record.taskId} 结果未上报：设备尚未注册`);
      return;
    }
    const body = {
      ok: Boolean(payload.ok),
      durationMs: Number.isFinite(payload.durationMs) ? payload.durationMs : Date.now() - record.startedAt,
    };
    if (payload.output !== undefined) body.output = payload.output;
    if (!payload.ok) body.error = String(payload.error || 'unknown').slice(0, 500);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.client.result(record.taskId, body);
        return;
      } catch (err) {
        if (err instanceof ApiError && (err.status === 404 || err.status === 409 || err.status === 400)) {
          this.log.warn(`结果上报被 Hub 忽略（HTTP ${err.status} ${err.code}），任务可能已被取消/重派`);
          return;
        }
        if (attempt === 3) {
          this.log.error(`任务 ${record.taskId} 结果上报失败（已重试 3 次）：${err.message}`);
          return;
        }
        this.log.warn(`结果上报失败，${300 * attempt}ms 后重试：${err.message}`);
        await this._wait(300 * attempt);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 启动 / 停止
  // -------------------------------------------------------------------------

  async start() {
    await this.init();
    try {
      await this.connect();
    } catch (err) {
      if (isNetworkError(err) && this.autoDiscover && (await this._discoverHub())) {
        await this.connect();
      } else {
        throw err;
      }
    }
    this._startHeartbeatLoop();
    this._startPollLoop();
    this.log.info(
      `已连接 Hub ${this.hubUrl}｜心跳 ${this.intervalMs}ms｜长轮询 ${this.pollWaitMs}ms｜并发上限 ${this.maxConcurrent}`,
    );
    return this.device;
  }

  /** 单次运行：注册→一次心跳→领一次命令→执行→退出（调试/CI 用）。 */
  async runOnce(options = {}) {
    await this.init();
    await this.connect();
    const heartbeat = await this._heartbeatOnce();
    this.enqueueCommands(heartbeat.commands);
    const waitMs = clampInt(options.waitMs, 0, 30000, 1000);
    if ((!heartbeat.commands || heartbeat.commands.length === 0) && waitMs > 0) {
      try {
        const res = await this.client.pollCommands({ waitMs, limit: this.maxConcurrent });
        this.enqueueCommands((res.json && res.json.commands) || []);
      } catch (err) {
        this.log.warn(`一次性模式长轮询失败：${err.message}`);
      }
    }
    const deadline = Date.now() + clampInt(options.maxWaitMs, 1000, 300000, 60000);
    while ((this.queue.length > 0 || this.running.size > 0) && Date.now() < deadline) {
      await this._wait(100);
    }
    await this._heartbeatOnce().catch(() => {});
    await this.stop({ unregister: false });
    return this.stats;
  }

  /**
   * 优雅停止：唤醒睡眠、中止长轮询、取消执行中任务、注销设备。
   * @param {{unregister?:boolean, reason?:string}} [options]
   */
  async stop(options = {}) {
    if (this.stopped) return this._stopPromise;
    this.stopped = true;
    const unregister = options.unregister !== false;
    this.log.info(`正在停止设备代理${options.reason ? `（${options.reason}）` : ''}…`);

    // 唤醒所有 sleep
    for (const entry of this.sleepers) {
      clearTimeout(entry.timer);
      entry.resolve();
    }
    this.sleepers.clear();
    try {
      this.pollAbort.abort('stop');
    } catch {
      /* ignore */
    }
    // 取消执行中的任务（让执行器尽快退出并上报 cancelled）
    for (const record of [...this.running.values()]) {
      record.cancelled = true;
      record.controller.abort('cancelled');
    }

    const waiters = [this.heartbeatLoopPromise, this.pollLoopPromise, ...[...this.executions]].filter(Boolean);
    await Promise.race([Promise.allSettled(waiters), this._wait(Math.max(50, this.stopTimeoutMs))]);

    if (unregister && this.client && this._currentDeviceId()) {
      try {
        await this.client.unregister();
        this.log.info('已向 Hub 注销设备');
      } catch (err) {
        this.log.warn(`注销失败（忽略）：${err.message}`);
      }
    }
    this.log.info(
      `设备代理已退出｜心跳 ${this.stats.heartbeats}｜命令 ${this.stats.commands}｜` +
        `完成 ${this.stats.tasksCompleted}｜失败 ${this.stats.tasksFailed}｜取消 ${this.stats.tasksCancelled}`,
    );
    this._resolveStop(this.stats);
    return this._stopPromise;
  }

  waitUntilStopped() {
    return this._stopPromise;
  }

  // -------------------------------------------------------------------------
  // 内部 sleep（记录在册，stop 时统一唤醒）
  // -------------------------------------------------------------------------

  _sleep(ms) {
    if (this.stopped || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const entry = { timer: null, resolve };
      entry.timer = setTimeout(() => {
        this.sleepers.delete(entry);
        resolve();
      }, Math.max(0, ms));
      // 注意：这里不能 unref，否则设备空闲时进程可能因没有活跃句柄而提前退出
      this.sleepers.add(entry);
    });
  }

  _wait(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, Math.max(0, ms));
    });
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const VALUE_FLAGS = {
  '--hub': 'hub',
  '--join-code': 'joinCode',
  '--name': 'name',
  '--config': 'config',
  '--state-dir': 'stateDir',
  '--state-file': 'stateFile',
  '--interval': 'intervalMs',
  '--poll-wait': 'pollWaitMs',
  '--executor': 'executorType',
  '--once-wait': 'onceWaitMs',
  '--log-level': 'logLevel',
  '--kind': 'kind',
  '--platform': 'platform',
  '--endpoint': 'endpoint',
  '--dsh-home': 'dshHome',
  '--ollama-host': 'ollamaHost',
  '--tag': 'tags',
  '--stop-timeout': 'stopTimeoutMs',
};

const BOOLEAN_FLAGS = {
  '--once': 'once',
  '--no-dsh': 'noDsh',
  '--no-ollama': 'noOllama',
  '--help': 'help',
  '-h': 'help',
  '--version': 'version',
  '-v': 'version',
};

const NUMERIC_KEYS = new Set(['intervalMs', 'pollWaitMs', 'onceWaitMs', 'stopTimeoutMs']);

function parseArgs(argv = []) {
  const result = { tags: [] };
  for (let i = 0; i < argv.length; i += 1) {
    let arg = argv[i];
    let inlineValue = null;
    if (typeof arg !== 'string') continue;
    if (arg.startsWith('--') && arg.includes('=')) {
      const index = arg.indexOf('=');
      inlineValue = arg.slice(index + 1);
      arg = arg.slice(0, index);
    }
    if (Object.prototype.hasOwnProperty.call(BOOLEAN_FLAGS, arg)) {
      if (inlineValue !== null) throw new Error(`${arg} 不接受取值`);
      result[BOOLEAN_FLAGS[arg]] = true;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(VALUE_FLAGS, arg)) {
      const key = VALUE_FLAGS[arg];
      let value = inlineValue;
      if (value === null) {
        i += 1;
        value = argv[i];
      }
      if (value === undefined || value === '') throw new Error(`${arg} 缺少取值`);
      if (key === 'tags') result.tags.push(value);
      else if (NUMERIC_KEYS.has(key)) {
        const num = Number(value);
        if (!Number.isFinite(num)) throw new Error(`${arg} 需要数字，收到：${value}`);
        result[key] = Math.trunc(num);
      } else result[key] = value;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`未知参数：${arg}`);
    throw new Error(`多余的参数：${arg}（本 CLI 不接受位置参数）`);
  }
  return result;
}

function printHelp(stream = process.stdout) {
  const lines = [
    'BattleStar 设备代理 v' + AGENT_VERSION,
    '',
    '用法：node device-agent/agent.js [选项]',
    '',
    '选项：',
    '  --hub <url>            Hub 地址，默认 http://127.0.0.1:7317',
    '  --join-code <code>     首次注册加入码（也可用环境变量 BUTLER_JOIN_CODE）',
    '  --name <name>          设备名，默认主机名；建议中文如“书房工作站”',
    '  --config <file>        JSON 配置文件（能力覆盖 / 执行器 / 发现开关）',
    '  --state-dir <dir>      状态目录，默认 ~/.super-butler',
    '  --state-file <file>    状态文件（优先于 --state-dir）',
    '  --interval <ms>        心跳间隔，默认 10000',
    '  --poll-wait <ms>       空闲长轮询等待，默认 25000（上限 30000）',
    '  --once                 单次运行：注册→心跳→领命令→执行→退出',
    '  --once-wait <ms>       单次模式长轮询等待，默认 1000',
    '  --executor <type>      simulate | dsh-cli | shell | http | ollama',
    '  --kind <kind>          dsh | ollama | openai-gateway | custom',
    '  --platform <name>      windows | macos | linux | android | other',
    '  --tag <tag>            追加标签，可重复',
    '  --no-dsh               跳过 DSH 目录探测',
    '  --no-ollama            跳过 Ollama 探测',
    '  --dsh-home <dir>       覆盖 DSH_HOME',
    '  --ollama-host <url>    覆盖 OLLAMA_HOST',
    '  --log-level <level>    debug | info | warn | error | silent',
    '  -h, --help             显示帮助',
    '  -v, --version          显示版本',
    '',
    '示例：',
    '  node device-agent/agent.js --hub http://127.0.0.1:7317 --join-code ABCD \\',
    '    --name 书房工作站 --config device-agent/config.example.json',
  ];
  stream.write(`${lines.join('\n')}\n`);
}

function printStats(stats) {
  const lines = [
    '—— 单次运行结束 ——',
    `心跳 ${stats.heartbeats} 次｜命令 ${stats.commands} 个｜完成 ${stats.tasksCompleted}｜失败 ${stats.tasksFailed}｜取消 ${stats.tasksCancelled}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`参数错误：${err.message}\n\n`);
    printHelp(process.stderr);
    return 2;
  }
  if (args.help) {
    printHelp(process.stdout);
    return 0;
  }
  if (args.version) {
    process.stdout.write(`super-butler-device-agent ${AGENT_VERSION}\n`);
    return 0;
  }

  const logger = createLogger({
    level: args.logLevel || process.env.BUTLER_LOG_LEVEL || 'info',
    prefix: args.name || 'agent',
  });

  let fileConfig = {};
  if (args.config) {
    try {
      fileConfig = await loadConfig(args.config);
    } catch (err) {
      logger.error(err.message);
      return 2;
    }
  }

  const agent = new Agent({
    hub: args.hub,
    joinCode: args.joinCode,
    name: args.name,
    config: fileConfig,
    stateDir: args.stateDir,
    stateFile: args.stateFile,
    intervalMs: args.intervalMs,
    pollWaitMs: args.pollWaitMs,
    executorType: args.executorType,
    tags: args.tags,
    kind: args.kind,
    platform: args.platform,
    endpoint: args.endpoint,
    dshHome: args.dshHome,
    ollamaHost: args.ollamaHost,
    stopTimeoutMs: args.stopTimeoutMs,
    noDsh: args.noDsh,
    noOllama: args.noOllama,
    logger,
    env: process.env,
    cwd: process.cwd(),
  });

  let shuttingDown = false;
  const handleSignal = (signal) => {
    if (shuttingDown) {
      logger.warn(`再次收到 ${signal}，强制退出`);
      process.exit(130);
    }
    shuttingDown = true;
    logger.info(`收到 ${signal}，正在优雅退出（再按一次可强制退出）…`);
    agent
      .stop({ unregister: true, reason: signal })
      .then(() => process.exit(0))
      .catch((err) => {
        logger.error(`退出时发生错误：${err.message}`);
        process.exit(1);
      });
  };
  const onSigint = () => handleSignal('SIGINT');
  const onSigterm = () => handleSignal('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  try {
    logger.info(`BattleStar 设备代理 v${AGENT_VERSION}｜Hub=${agent.hubUrl}`);
    if (args.once) {
      const stats = await agent.runOnce({ waitMs: args.onceWaitMs });
      printStats(stats);
      return 0;
    }
    await agent.start();
    await agent.waitUntilStopped();
    return 0;
  } catch (err) {
    if (err instanceof FatalSetupError) {
      logger.error(err.message);
      return 2;
    }
    logger.error(`启动失败：${err && err.message ? err.message : err}`);
    return 1;
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}

if (require.main === module) {
  main()
    .then((code) => {
      if (code) process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`未捕获错误：${err && err.stack ? err.stack : err}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  DEFAULTS,
  Agent,
  FatalSetupError,
  parseArgs,
  printHelp,
  main,
};
