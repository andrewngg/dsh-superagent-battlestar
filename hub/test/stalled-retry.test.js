'use strict';

/**
 * A+B 卡死治理：设备上报 stalled / 无进度 / 本机 CLI 硬上限失败时，
 * Hub 在 attempts 预算内自动重排一次，而不是直接 failed 让人等满 15 分钟。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  makeManifest,
  startTestHub,
  registerDevice,
  createTask,
  getTask,
  ackTask,
  progressTask,
  resultTask,
} = require('./_helpers');

test('卡死自动重试：stalled 失败在预算内重新排队并保留原主机亲和', async (t) => {
  const env = await startTestHub(t, { autoRetryOnTimeout: true });
  const device = await registerDevice(env, makeManifest({ limits: { maxConcurrentTasks: 2 } }));

  const task = await createTask(env, {
    instruction: '跑一个会卡住的 CLI 任务',
    timeoutSec: 600,
    requirements: { deviceId: device.id },
  });
  assert.equal(task.status, 'assigned');

  await ackTask(env, device, task.id);
  const before = await getTask(env, task.id);
  assert.equal(before.status, 'running');

  const result = await resultTask(env, device, task.id, {
    ok: false,
    error: '本机 CLI 无进度已 300s（stalled），已终止',
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.ignored, false);

  const after = await getTask(env, task.id);
  assert.ok(['assigned', 'running'].includes(after.status), `应自动重排，实际 ${after.status}`);
  assert.equal(after.assignedDeviceId, device.id, '应保留原主机亲和');
  assert.equal(after.attempts, 2, '自动重试应消耗一次尝试');
  assert.equal(after.error, null);
  assert.ok(
    (after.events || []).some((event) => event.type === 'retry' && /执行卡死/.test(event.message || '')),
    '应记录 retry 事件',
  );
});

test('卡死自动重试：预算用尽后仍标记 failed', async (t) => {
  const env = await startTestHub(t, { autoRetryOnTimeout: true });
  const device = await registerDevice(env, makeManifest({ limits: { maxConcurrentTasks: 2 } }));

  const task = await createTask(env, {
    instruction: '只允许一次尝试的 CLI 任务',
    timeoutSec: 600,
    maxAttempts: 1,
    requirements: { deviceId: device.id },
  });
  await ackTask(env, device, task.id);

  await resultTask(env, device, task.id, {
    ok: false,
    error: '本机 CLI 无进度已 300s（stalled），已终止',
  });

  const after = await getTask(env, task.id);
  assert.equal(after.status, 'failed');
  assert.match(after.error, /stalled|无进度/);
});

test('普通内容错误不触发卡死自动重试', async (t) => {
  const env = await startTestHub(t, { autoRetryOnTimeout: true });
  const device = await registerDevice(env, makeManifest({ limits: { maxConcurrentTasks: 2 } }));

  const task = await createTask(env, {
    instruction: '脚本报错',
    timeoutSec: 600,
    requirements: { deviceId: device.id },
  });
  await ackTask(env, device, task.id);

  await resultTask(env, device, task.id, { ok: false, error: '脚本报错：TypeError: x is undefined' });

  const after = await getTask(env, task.id);
  assert.equal(after.status, 'failed');
  assert.equal(after.attempts, 1);
});

test('keepalive 不能把运行时长无限续期：超过总运行上限后按超时重排', async (t) => {
  const env = await startTestHub(t, { autoRetryOnTimeout: true });
  const device = await registerDevice(env, makeManifest({ limits: { maxConcurrentTasks: 2 } }));

  const task = await createTask(env, {
    instruction: '长时间 keepalive 的任务',
    timeoutSec: 600,
    requirements: { deviceId: device.id },
  });
  await ackTask(env, device, task.id);

  // 模拟任务已经连续跑了 2 小时（超过 timeoutSec*6 的封顶 1 小时）。
  const live = env.hub.tasks.get(task.id);
  live.startedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  await progressTask(env, device, task.id, { keepalive: true });

  const after = await getTask(env, task.id);
  assert.equal(after.attempts, 2, '超上限应触发超时自动重排');
  assert.ok(
    (after.events || []).some((event) => /运行超时/.test(event.message || '')),
    '应记录运行超时重试事件',
  );
});