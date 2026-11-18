'use strict';

/**
 * 自动标签（按项目 / 任务学习）回归测试。
 *
 * 目标：设备成功执行过某个项目后，自动获得「项目名 + 项目别名标签」，
 * 大脑写的项目标签（如「反腐AI」）不再因为没有设备声明而让任务永久排队；
 * 显式 deviceId 钉住的设备只缺描述性标签时不阻塞派发，缺硬能力仍排除。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  startTestHub,
  startHubAt,
  makeTempDir,
  makeManifest,
  registerDevice,
  ackTask,
  resultTask,
  createTask,
} = require('./_helpers.js');

async function completeTask(env, device, taskId) {
  const ack = await ackTask(env, device, taskId);
  assert.equal(ack.status, 200);
  const result = await resultTask(env, device, taskId, { ok: true, output: { text: '完成' } });
  assert.equal(result.status, 200);
  assert.equal(result.json.task.status, 'completed');
  return result.json.task;
}

test('自动标签：设备做过项目后自动获得项目名与项目别名标签', async (t) => {
  const env = await startTestHub(t);
  const worker = await registerDevice(env, makeManifest({ name: '项目主机' }));

  const first = await createTask(env, {
    instruction: '项目 alpha 初始化',
    requirements: { project: 'alpha' },
    timeoutSec: 300,
  });
  assert.equal(first.assignedDeviceId, worker.deviceId);
  await completeTask(env, worker, first.id);

  // 任务里带的项目标签（大脑常见写法）登记为项目别名；钉住的设备只缺标签也能派发。
  const tagged = await createTask(env, {
    instruction: '项目 alpha 带标签',
    requirements: { project: 'alpha', tags: ['反腐AI', '验证'], deviceId: worker.deviceId },
    timeoutSec: 300,
  });
  assert.equal(tagged.assignedDeviceId, worker.deviceId);
  await completeTask(env, worker, tagged.id);

  const dev = env.hub.devices.get(worker.deviceId);
  assert.deepEqual(dev.tags, []);
  const autoTags = env.hub._autoTagsForDevice(worker.deviceId);
  assert.ok(autoTags.includes('alpha'), autoTags.join('、'));
  assert.ok(autoTags.includes('反腐AI'), autoTags.join('、'));
  assert.ok(autoTags.includes('验证'), autoTags.join('、'));

  // 新设备评分更“新”，但只有项目主机的自动标签能匹配「反腐AI」。
  const newer = await registerDevice(env, makeManifest({ name: '新主机' }));
  const other = await createTask(env, {
    instruction: '另一个项目使用同一标签',
    requirements: { project: 'beta', tags: ['反腐AI'] },
    timeoutSec: 300,
  });
  assert.equal(other.assignedDeviceId, worker.deviceId);
  assert.notEqual(other.assignedDeviceId, newer.deviceId);
});

test('自动标签：项目别名随 state.json 持久化，重启后仍自动匹配', async (t) => {
  const dataDir = await makeTempDir('butler-autotags-');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const env = await startHubAt(dataDir);
  t.after(() => env.close());

  const worker = await registerDevice(env, makeManifest({ name: '持久化主机' }));
  const first = await createTask(env, {
    instruction: '项目 alpha 初始化',
    requirements: { project: 'alpha' },
    timeoutSec: 300,
  });
  await completeTask(env, worker, first.id);
  const tagged = await createTask(env, {
    instruction: '项目 alpha 带标签',
    requirements: { project: 'alpha', tags: ['反腐AI'], deviceId: worker.deviceId },
    timeoutSec: 300,
  });
  await completeTask(env, worker, tagged.id);

  await env.hub.flushState();
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.deepEqual(state.routing.projectTags.alpha, ['反腐AI']);

  await env.close();
  const restarted = await startHubAt(dataDir);
  t.after(() => restarted.close());
  assert.deepEqual(restarted.hub.projectTags.get('alpha'), ['反腐AI']);
  assert.ok(restarted.hub._autoTagsForDevice(worker.deviceId).includes('反腐AI'));
});

test('显式钉住设备：只缺描述性标签不阻塞派发，缺硬能力仍排除', async (t) => {
  const env = await startTestHub(t);
  const pinned = await registerDevice(env, makeManifest({ name: '钉住主机' }));

  const task = await createTask(env, {
    instruction: '继续反腐AI验证',
    requirements: { deviceId: pinned.deviceId, tags: ['验证'] },
    timeoutSec: 300,
  });
  assert.equal(task.status, 'assigned');
  assert.equal(task.assignedDeviceId, pinned.deviceId);
  await completeTask(env, pinned, task.id);

  // 硬能力（模型）缺失时仍然不能派发，避免标签宽松策略掩盖真实能力缺口。
  const blocked = await createTask(env, {
    instruction: '需要指定模型',
    requirements: { deviceId: pinned.deviceId, model: 'gpt-5' },
    timeoutSec: 300,
  });
  assert.equal(blocked.status, 'queued');
  assert.match(blocked.route.reason, /missing model:gpt-5/);
});

test('路由软化：无人声明的自造标签降级为提示，不再把任务永久卡在排队', async (t) => {
  const env = await startTestHub(t);
  const worker = await registerDevice(env, makeManifest({ name: '普通主机', tags: ['本机'] }));

  // 模型常见的错误：把项目名/任务名写成设备标签；没有任何设备会声明它们。
  const task = await createTask(env, {
    instruction: '反腐AI 验证任务（自造标签）',
    requirements: { tags: ['反腐AI', '验证'] },
    timeoutSec: 300,
  });
  assert.equal(task.status, 'assigned');
  assert.equal(task.assignedDeviceId, worker.deviceId);

  const stored = env.hub.getTask(task.id);
  assert.deepEqual(stored.requirements.tags, []);
  assert.deepEqual(stored.requirements.hint, ['反腐AI', '验证']);
  assert.ok(
    stored.events.some((event) => /没有设备支持，已降级为提示/.test(event.message || '')),
    '应记录标签降级事件',
  );
});
