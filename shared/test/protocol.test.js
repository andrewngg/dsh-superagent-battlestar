'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PROTOCOL_VERSION,
  TASK_STATUS,
  LIMITS,
  randomId,
  normalizeManifest,
  normalizeRequirements,
  normalizeTaskRequest,
  matchRequirements,
  scoreDevice,
} = require('../protocol.js');

test('协议版本与状态常量稳定', () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.deepEqual(Object.values(TASK_STATUS).sort(), [
    'assigned',
    'cancelled',
    'completed',
    'failed',
    'queued',
    'running',
    'timeout',
    'waiting',
  ]);
  assert.equal(LIMITS.HEARTBEAT_TTL_MS, 30000);
});

test('randomId 生成带前缀且基本唯一', () => {
  const ids = new Set();
  for (let i = 0; i < 1000; i += 1) {
    const id = randomId('dev');
    assert.match(id, /^dev_[a-z0-9]{8,}$/);
    ids.add(id);
  }
  assert.ok(ids.size > 990, `IDs should be mostly unique, got ${ids.size}`);
});

test('normalizeManifest 补默认值并去重', () => {
  const { manifest, errors, warnings } = normalizeManifest({
    name: '  书房工作站  ',
    platform: 'windows',
    kind: 'dsh',
    models: [
      { id: 'deepseek-chat', provider: 'deepseek', strengths: ['code'] },
      { id: 'deepseek-chat', provider: 'dup' },
      { id: '' },
    ],
    profiles: [{ id: 'desktop', plugins: ['p1', 'p1'] }],
    skills: [{ id: 'office-docx', name: 'Word' }],
    tags: ['书房', '书房', ''],
    limits: { maxConcurrentTasks: 99 },
  });

  assert.deepEqual(errors, []);
  assert.equal(manifest.name, '书房工作站');
  assert.equal(manifest.models.length, 1);
  assert.equal(manifest.models[0].available, true);
  assert.deepEqual(manifest.profiles[0].plugins, ['p1']);
  assert.deepEqual(manifest.tags, ['书房']);
  assert.equal(manifest.limits.maxConcurrentTasks, LIMITS.MAX_CONCURRENT_TASKS);
  assert.deepEqual(manifest.resources, {});
  assert.equal(warnings.length >= 0, true);
});

test('normalizeManifest 拒绝空 name 并兜底未知枚举', () => {
  const { manifest, errors } = normalizeManifest({ name: '', platform: 'beos', kind: 'skynet' });
  assert.ok(errors.length >= 1);
  assert.equal(manifest.platform, 'other');
  assert.equal(manifest.kind, 'custom');
});

test('matchRequirements：model/skills/profile/gateway/tags 全覆盖', () => {
  const caps = {
    models: [
      { id: 'deepseek-chat', available: true },
      { id: 'deepseek-reasoner', available: false },
    ],
    profiles: [{ id: 'desktop' }],
    gateways: [{ id: 'openai-gateway' }],
    skills: [{ id: 'office-docx' }, { id: 'office-xlsx' }],
    tags: ['书房'],
  };

  const ok = matchRequirements(caps, {
    model: 'deepseek-chat',
    skills: ['office-docx'],
    profile: 'desktop',
    gateway: 'openai-gateway',
    tags: ['书房'],
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.missing, []);
  assert.equal(ok.matched.length, 5);

  const unavailable = matchRequirements(caps, { model: 'deepseek-reasoner' });
  assert.equal(unavailable.ok, false);
  assert.deepEqual(unavailable.missing, ['model:deepseek-reasoner']);

  const missing = matchRequirements(caps, { skills: ['office-pptx'], profile: 'web' });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing.sort(), ['profile:web', 'skill:office-pptx']);
});

test('scoreDevice：负载低者优先、显式设备与能力标签加分', () => {
  const now = new Date().toISOString();
  const caps = {
    models: [{ id: 'deepseek-chat', available: true, strengths: ['code'] }],
    skills: [{ id: 'office-docx' }],
  };

  const idle = { id: 'dev_a', capabilities: caps, load: { running: 0, max: 2 }, lastSeenAt: now };
  const busy = { id: 'dev_b', capabilities: caps, load: { running: 2, max: 2 }, lastSeenAt: now };

  const idleScore = scoreDevice(idle, {});
  const busyScore = scoreDevice(busy, {});
  assert.ok(idleScore.score > busyScore.score);

  const explicit = scoreDevice(idle, { deviceId: 'dev_a' });
  assert.ok(explicit.score >= idleScore.score + 15);

  const hinted = scoreDevice(idle, { model: 'deepseek-chat', hint: ['code'] });
  assert.ok(hinted.score >= idleScore.score + 5);

  const ineligible = scoreDevice(busy, { skills: ['office-xlsx'] });
  assert.equal(ineligible.score, -1);
});

test('normalizeTaskRequest：校验与范围收敛', () => {
  const bad = normalizeTaskRequest({ instruction: '   ' });
  assert.equal(bad.ok, false);

  const good = normalizeTaskRequest({
    instruction: '整理家庭开支',
    requirements: { skills: ['office-docx', 'office-docx'], priority: 100 },
    priority: 99,
    timeoutSec: 5,
    maxAttempts: 9,
  });
  assert.equal(good.ok, true);
  assert.equal(good.value.priority, 9);
  assert.equal(good.value.timeoutSec, LIMITS.MIN_TASK_TIMEOUT_SEC);
  assert.equal(good.value.maxAttempts, LIMITS.MAX_TASK_ATTEMPTS);
  assert.deepEqual(good.value.requirements.skills, ['office-docx']);
});

test('normalizeRequirements 空对象安全', () => {
  const req = normalizeRequirements(null);
  assert.equal(req.model, null);
  assert.deepEqual(req.skills, []);
  assert.deepEqual(req.tags, []);
  assert.equal(req.deviceId, null);
});
