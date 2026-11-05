'use strict';

/**
 * Super Butler 协议 v1 共享实现（零依赖，CommonJS）。
 * Hub 与 Device Agent 都可以 require 本模块，保证能力匹配规则一致。
 * 契约见 docs/PROTOCOL.md。
 */

const PROTOCOL_VERSION = 1;

const TASK_STATUS = Object.freeze({
  QUEUED: 'queued',
  ASSIGNED: 'assigned',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TIMEOUT: 'timeout',
});

const DEVICE_STATUS = Object.freeze({
  IDLE: 'idle',
  BUSY: 'busy',
  DEGRADED: 'degraded',
  OFFLINE: 'offline',
});

const STATUS = Object.freeze({
  OK: 'ok',
  ERROR: 'error',
});

const LIMITS = Object.freeze({
  MAX_BODY_BYTES: 1024 * 1024,
  MAX_CONCURRENT_TASKS: 8,
  DEFAULT_CONCURRENT_TASKS: 1,
  HEARTBEAT_INTERVAL_MS: 10000,
  HEARTBEAT_TTL_MS: 30000,
  LONG_POLL_MAX_MS: 30000,
  DEFAULT_TASK_TIMEOUT_SEC: 300,
  MIN_TASK_TIMEOUT_SEC: 30,
  MAX_TASK_TIMEOUT_SEC: 3600,
  MAX_TASK_ATTEMPTS: 3,
  DEFAULT_TASK_ATTEMPTS: 2,
  ASSIGN_ACK_TIMEOUT_MS: 30000,
  MAX_NAME_LENGTH: 64,
  MAX_INSTRUCTION_LENGTH: 8000,
});

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomId(prefix) {
  let s = '';
  const bytes = require('node:crypto').randomBytes(8);
  for (let i = 0; i < bytes.length; i += 1) s += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return `${prefix}_${s}`;
}

function nowIso() {
  return new Date().toISOString();
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v, max = 200) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function bool(v, dflt) {
  return typeof v === 'boolean' ? v : dflt;
}

function int(v, dflt, min, max) {
  const n = Number.isFinite(v) ? Math.trunc(v) : dflt;
  return Math.min(max, Math.max(min, n));
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function uniqBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** 规范化设备上报的能力清单。返回 { manifest, errors, warnings }。 */
function normalizeManifest(input) {
  const errors = [];
  const warnings = [];
  const src = isPlainObject(input) ? input : {};
  if (!isPlainObject(input)) errors.push('manifest 必须是对象');

  const name = str(src.name, LIMITS.MAX_NAME_LENGTH);
  if (!name) errors.push('name 必填（1-64 字符）');

  const platform = ['windows', 'macos', 'linux', 'android', 'other'].includes(src.platform)
    ? src.platform
    : 'other';
  const kind = ['dsh', 'ollama', 'openai-gateway', 'multi', 'custom'].includes(src.kind)
    ? src.kind
    : 'custom';

  const models = uniqBy(
    arr(src.models)
      .filter(isPlainObject)
      .map((m) => ({
        id: str(m.id, 80),
        provider: str(m.provider, 80),
        contextWindow: Number.isFinite(m.contextWindow) ? Math.trunc(m.contextWindow) : null,
        strengths: uniqBy(arr(m.strengths).map((s) => str(s, 40)).filter(Boolean), (s) => s),
        available: bool(m.available, true),
      }))
      .filter((m) => m.id),
    (m) => m.id,
  );

  const profiles = uniqBy(
    arr(src.profiles)
      .filter(isPlainObject)
      .map((p) => ({
        id: str(p.id, 80),
        name: str(p.name, 120) || str(p.id, 80),
        plugins: uniqBy(arr(p.plugins).map((x) => str(x, 160)).filter(Boolean), (x) => x),
      }))
      .filter((p) => p.id),
    (p) => p.id,
  );

  const gateways = uniqBy(
    arr(src.gateways)
      .filter(isPlainObject)
      .map((g) => ({
        id: str(g.id, 80),
        kind: str(g.kind, 40) || 'openai-compatible',
        baseUrl: str(g.baseUrl, 300),
        models: uniqBy(arr(g.models).map((x) => str(x, 80)).filter(Boolean), (x) => x),
      }))
      .filter((g) => g.id),
    (g) => g.id,
  );

  const skills = uniqBy(
    arr(src.skills)
      .filter(isPlainObject)
      .map((s) => ({
        id: str(s.id, 80),
        name: str(s.name, 120) || str(s.id, 80),
        version: str(s.version, 40),
      }))
      .filter((s) => s.id),
    (s) => s.id,
  );

  const resources = isPlainObject(src.resources)
    ? {
        cpuCores: Number.isFinite(src.resources.cpuCores) ? Math.trunc(src.resources.cpuCores) : null,
        memoryGB: Number.isFinite(src.resources.memoryGB) ? src.resources.memoryGB : null,
        gpu: str(src.resources.gpu, 100),
        os: str(src.resources.os, 100),
      }
    : {};

  const limits = {
    maxConcurrentTasks: int(
      isPlainObject(src.limits) ? src.limits.maxConcurrentTasks : undefined,
      LIMITS.DEFAULT_CONCURRENT_TASKS,
      1,
      LIMITS.MAX_CONCURRENT_TASKS,
    ),
  };

  const tags = uniqBy(arr(src.tags).map((t) => str(t, 40)).filter(Boolean), (t) => t);

  if (models.length === 0) warnings.push('未申报 models：只能接收无 model 要求的任务');
  if (skills.length === 0) warnings.push('未申报 skills：只能接收无 skills 要求的任务');

  return {
    manifest: {
      name,
      platform,
      kind,
      agentVersion: str(src.agentVersion, 40),
      endpoint: str(src.endpoint, 300),
      tags,
      models,
      profiles,
      gateways,
      skills,
      resources,
      limits,
    },
    errors,
    warnings,
  };
}

function haveAll(have, want) {
  const set = new Set(arr(have));
  return arr(want).every((x) => set.has(x));
}

/**
 * 判断设备能力是否满足任务需求。
 * @returns {{ ok: boolean, matched: string[], missing: string[] }}
 */
function matchRequirements(capabilities, requirements) {
  const cap = isPlainObject(capabilities) ? capabilities : {};
  const req = isPlainObject(requirements) ? requirements : {};
  const matched = [];
  const missing = [];

  const modelIds = arr(cap.models)
    .filter((m) => m && m.available !== false)
    .map((m) => m.id);
  if (req.model) {
    if (modelIds.includes(req.model)) matched.push(`model:${req.model}`);
    else missing.push(`model:${req.model}`);
  }

  const skillIds = arr(cap.skills).map((s) => s && s.id).filter(Boolean);
  for (const skill of arr(req.skills)) {
    if (!skill) continue;
    if (skillIds.includes(skill)) matched.push(`skill:${skill}`);
    else missing.push(`skill:${skill}`);
  }

  if (req.profile) {
    const ids = arr(cap.profiles).map((p) => p && p.id).filter(Boolean);
    if (ids.includes(req.profile)) matched.push(`profile:${req.profile}`);
    else missing.push(`profile:${req.profile}`);
  }

  if (req.gateway) {
    const ids = arr(cap.gateways).map((g) => g && g.id).filter(Boolean);
    if (ids.includes(req.gateway)) matched.push(`gateway:${req.gateway}`);
    else missing.push(`gateway:${req.gateway}`);
  }

  const tags = arr(cap.tags || (cap.capabilities && cap.capabilities.tags));
  for (const tag of arr(req.tags)) {
    if (!tag) continue;
    if (tags.includes(tag)) matched.push(`tag:${tag}`);
    else missing.push(`tag:${tag}`);
  }

  return { ok: missing.length === 0, matched, missing };
}

/**
 * 计算单个设备的候选得分。
 * device 是 Hub 内部表示：包含 capabilities、load、lastSeenAt 等。
 * @returns {{ score: number, matched: string[], missing: string[] }}
 */
function scoreDevice(device, requirements) {
  const req = isPlainObject(requirements) ? requirements : {};
  const cap = isPlainObject(device.capabilities) ? device.capabilities : {};
  const m = matchRequirements(cap, req);
  if (!m.ok) return { score: -1, matched: m.matched, missing: m.missing };

  const max = Math.max(1, (device.load && device.load.max) || 1);
  const running = Math.max(0, (device.load && device.load.running) || 0);
  const loadRatio = Math.min(1, running / max);

  let score = 100;
  score -= 20 * loadRatio;
  if (req.deviceId && req.deviceId === device.id) score += 15;

  // 模型能力标签的加分：requirements.hint 形如 ["code"] 或 model 的 strengths 含关键词
  const hints = arr(req.hint).map((h) => String(h).toLowerCase());
  if (hints.length) {
    for (const model of arr(cap.models)) {
      if (req.model && model.id !== req.model) continue;
      const strengths = arr(model.strengths).map((s) => String(s).toLowerCase());
      if (hints.some((h) => strengths.includes(h))) {
        score += 5;
        break;
      }
    }
  }

  const ageMs = device.lastSeenAt ? Math.max(0, Date.now() - Date.parse(device.lastSeenAt)) : Infinity;
  if (Number.isFinite(ageMs)) score += Math.max(0, 3 - Math.floor(ageMs / 10000));

  return { score: Math.round(score), matched: m.matched, missing: [] };
}

/** 任务需求规范化。 */
function normalizeRequirements(input) {
  const src = isPlainObject(input) ? input : {};
  return {
    model: str(src.model, 80) || null,
    skills: uniqBy(arr(src.skills).map((s) => str(s, 80)).filter(Boolean), (s) => s),
    profile: str(src.profile, 80) || null,
    gateway: str(src.gateway, 80) || null,
    tags: uniqBy(arr(src.tags).map((t) => str(t, 40)).filter(Boolean), (t) => t),
    deviceId: str(src.deviceId, 80) || null,
    hint: uniqBy(arr(src.hint).map((h) => str(h, 40)).filter(Boolean), (h) => h),
  };
}

/** 任务创建请求校验。返回 { ok, errors, value }。 */
function normalizeTaskRequest(input) {
  const src = isPlainObject(input) ? input : {};
  const errors = [];
  const instruction = str(src.instruction, LIMITS.MAX_INSTRUCTION_LENGTH);
  if (!instruction) errors.push('instruction 必填');
  return {
    ok: errors.length === 0,
    errors,
    value: {
      instruction,
      requirements: normalizeRequirements(src.requirements),
      priority: int(src.priority, 5, 0, 9),
      timeoutSec: int(src.timeoutSec, LIMITS.DEFAULT_TASK_TIMEOUT_SEC, LIMITS.MIN_TASK_TIMEOUT_SEC, LIMITS.MAX_TASK_TIMEOUT_SEC),
      maxAttempts: int(src.maxAttempts, LIMITS.DEFAULT_TASK_ATTEMPTS, 1, LIMITS.MAX_TASK_ATTEMPTS),
    },
  };
}

module.exports = {
  PROTOCOL_VERSION,
  TASK_STATUS,
  DEVICE_STATUS,
  STATUS,
  LIMITS,
  randomId,
  nowIso,
  normalizeManifest,
  normalizeRequirements,
  normalizeTaskRequest,
  matchRequirements,
  scoreDevice,
  haveAll,
};
