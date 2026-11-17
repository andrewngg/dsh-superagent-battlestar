'use strict';

/**
 * 派发亲和（母机 / 项目 / 线程锁定）回归测试。
 *
 * 目标：任务优先留在项目所在的母机、上次成功执行该项目的设备、同一线程上次执行的主机，
 * 避免被派到没有项目上下文的主机导致失败；同时保证硬 deviceId、计划并行与失败重派不受影响。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  startTestHub,
  startHubAt,
  makeTempDir,
  request,
  makeManifest,
  registerDevice,
  heartbeat,
  ackTask,
  resultTask,
  createTask,
  getTask,
  snapshot,
  adminHeaders,
} = require('./_helpers.js');

async function completeTask(env, device, taskId) {
  const ack = await ackTask(env, device, taskId);
  assert.equal(ack.status, 200);
  const result = await resultTask(env, device, taskId, {
    ok: true,
    output: { text: '完成' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.task.status, 'completed');
  return result.json.task;
}

test('主设备（母机）：未指定项目时优先留在「本机」标签设备，即便另一台设备评分更高', async (t) => {
  const env = await startTestHub(t);
  const main = await registerDevice(env, makeManifest({ name: '母机工作机', tags: ['本机'] }));
  // 后注册的设备 lastSeenAt 更新，旧逻辑会在同分时选中它。
  const other = await registerDevice(env, makeManifest({ name: '备用主机' }));

  const task = await createTask(env, { instruction: '整理项目笔记', timeoutSec: 300 });
  assert.equal(task.status, 'assigned');
  assert.equal(task.assignedDeviceId, main.deviceId);
  assert.match(task.route.reason, /主设备（母机）优先/);
  assert.equal(task.affinity.deviceId, main.deviceId);
  assert.match(task.affinity.reason, /主设备（母机）优先/);
  assert.notEqual(task.assignedDeviceId, other.deviceId);
});

test('线程亲和：继续同一任务时，即使另一台设备更新也回到原主机', async (t) => {
  const env = await startTestHub(t);
  const first = await registerDevice(env, makeManifest({ name: '原主机' }));
  const task = await createTask(env, { instruction: '第一轮', timeoutSec: 300 });
  assert.equal(task.assignedDeviceId, first.deviceId);
  await completeTask(env, first, task.id);

  // 新设备 lastSeenAt 更新，正常评分会优先它；线程亲和应把跟进任务拉回原主机。
  const newer = await registerDevice(env, makeManifest({ name: '新主机' }));
  const follow = await request(env.base, 'POST', `/api/tasks/${task.id}/follow-up`, {
    headers: adminHeaders(env),
    body: { instruction: '继续第二轮', timeoutSec: 300 },
  });
  assert.equal(follow.status, 200);
  const next = follow.json.task;
  assert.equal(next.assignedDeviceId, first.deviceId);
  assert.match(next.route.reason, /线程亲和/);
  assert.notEqual(next.assignedDeviceId, newer.deviceId);
});

test('项目亲和：同项目新任务回到上次成功设备，并在重启后继续生效', async (t) => {
  const dataDir = await makeTempDir('butler-affinity-');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const env = await startHubAt(dataDir);
  t.after(() => env.close());
  const worker = await registerDevice(env, makeManifest({ name: '项目主机' }));

  const first = await createTask(env, {
    instruction: '项目 alpha：搭建目录',
    requirements: { project: 'alpha' },
    timeoutSec: 300,
  });
  assert.equal(first.assignedDeviceId, worker.deviceId);
  await completeTask(env, worker, first.id);

  // 项目亲和写入序列化状态。
  const statePath = path.join(dataDir, 'state.json');
  await env.hub.flushState();
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.routing.projectAffinity.alpha, worker.deviceId);
  assert.equal(state.routing.mainDeviceId, '');

  // 换一台评分更“新”的设备，项目亲和仍然优先。
  const newer = await registerDevice(env, makeManifest({ name: '新主机' }));
  const second = await createTask(env, {
    instruction: '项目 alpha：继续写接口',
    requirements: { project: 'alpha' },
    timeoutSec: 300,
  });
  assert.equal(second.assignedDeviceId, worker.deviceId);
  assert.match(second.route.reason, /项目亲和/);
  assert.notEqual(second.assignedDeviceId, newer.deviceId);

  // 重启后 projectAffinity 从 state.routing 恢复。
  await env.close();
  const restarted = await startHubAt(dataDir);
  t.after(() => restarted.close());
  assert.equal(restarted.hub.projectAffinity.get('alpha'), worker.deviceId);
});

test('母机并发满：任务排队等母机空槽，不偷跑到备用主机；母机空闲后自动接上', async (t) => {
  const env = await startTestHub(t);
  const main = await registerDevice(env, makeManifest({ name: '母机', tags: ['本机'], limits: { maxConcurrentTasks: 1 } }));
  const spare = await registerDevice(env, makeManifest({ name: '备用机', limits: { maxConcurrentTasks: 5 } }));

  const occupying = await createTask(env, { instruction: '占住母机', timeoutSec: 300 });
  assert.equal(occupying.assignedDeviceId, main.deviceId);
  await ackTask(env, main, occupying.id);

  const waiting = await createTask(env, { instruction: '等母机空槽', timeoutSec: 300 });
  assert.equal(waiting.status, 'queued');
  assert.equal(waiting.assignedDeviceId, null);
  assert.match(waiting.route.reason, /亲和等待/);
  assert.match(waiting.route.reason, /并发已满/);

  // 母机释放槽位后排队任务自动派回母机，而不是备用机。
  await completeTask(env, main, occupying.id);
  const resumed = await getTask(env, waiting.id);
  assert.equal(resumed.status, 'assigned');
  assert.equal(resumed.assignedDeviceId, main.deviceId);
  assert.notEqual(spare.deviceId, resumed.assignedDeviceId);
});

test('项目主机离线：任务排队等待上线，不派给没有项目上下文的设备；上线后自动接走', async (t) => {
  const env = await startTestHub(t);
  const projectHost = await registerDevice(env, makeManifest({ name: '项目主机' }));
  const first = await createTask(env, {
    instruction: '项目 beta：初始化',
    requirements: { project: 'beta' },
    timeoutSec: 300,
  });
  await completeTask(env, projectHost, first.id);

  const spare = await registerDevice(env, makeManifest({ name: '无关主机', limits: { maxConcurrentTasks: 5 } }));
  env.hub.markDeviceOffline(env.hub.getDevice(projectHost.deviceId), 'test offline');

  const waiting = await createTask(env, {
    instruction: '项目 beta：下一步',
    requirements: { project: 'beta' },
    timeoutSec: 300,
  });
  assert.equal(waiting.status, 'queued');
  assert.equal(waiting.assignedDeviceId, null);
  assert.match(waiting.route.reason, /亲和等待/);
  assert.match(waiting.route.reason, /离线/);

  await heartbeat(env, projectHost, { status: 'idle' });
  const resumed = await getTask(env, waiting.id);
  assert.equal(resumed.status, 'assigned');
  assert.equal(resumed.assignedDeviceId, projectHost.deviceId);
  assert.notEqual(resumed.assignedDeviceId, spare.deviceId);
});

test('显式 requirements.deviceId 仍是最高优先级，不被母机亲和覆盖', async (t) => {
  const env = await startTestHub(t);
  const main = await registerDevice(env, makeManifest({ name: '母机', tags: ['本机'] }));
  const pinned = await registerDevice(env, makeManifest({ name: '指定主机' }));

  const task = await createTask(env, {
    instruction: '必须去指定主机',
    requirements: { deviceId: pinned.deviceId },
    timeoutSec: 300,
  });
  assert.equal(task.status, 'assigned');
  assert.equal(task.assignedDeviceId, pinned.deviceId);
  assert.notEqual(task.assignedDeviceId, main.deviceId);
});

test('任务失败后手动重试：亲和继续原主机，保留项目上下文', async (t) => {
  const env = await startTestHub(t);
  const host = await registerDevice(env, makeManifest({ name: '原主机' }));
  const task = await createTask(env, { instruction: '可能失败的任务', timeoutSec: 300 });
  assert.equal(task.assignedDeviceId, host.deviceId);

  await ackTask(env, host, task.id);
  const failed = await resultTask(env, host, task.id, { ok: false, error: '脚本报错' });
  assert.equal(failed.json.task.status, 'failed');

  // 新设备评分更新，手动重试仍应回到原主机。
  await registerDevice(env, makeManifest({ name: '新主机' }));
  const retried = await request(env.base, 'POST', `/api/tasks/${task.id}/retry`, {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(retried.status, 200);
  assert.equal(retried.json.task.assignedDeviceId, host.deviceId);
  assert.match(retried.json.task.route.reason, /亲和锁定/);
});

test('系统设置 mainDeviceId：可指定母机、未知设备 400、快照与 state 同步', async (t) => {
  const env = await startTestHub(t);
  const main = await registerDevice(env, makeManifest({ name: '母机 A' }));
  await registerDevice(env, makeManifest({ name: '备用 B' }));

  const unknown = await request(env.base, 'PATCH', '/api/settings', {
    headers: adminHeaders(env),
    body: { mainDeviceId: 'dev_missing' },
  });
  assert.equal(unknown.status, 400);
  assert.match(unknown.json.error.message, /主设备不存在/);

  const patched = await request(env.base, 'PATCH', '/api/settings', {
    headers: adminHeaders(env),
    body: { mainDeviceId: main.deviceId },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.settings.mainDeviceId, main.deviceId);

  const snap = await snapshot(env);
  assert.equal(snap.settings.mainDeviceId, main.deviceId);

  await env.hub.flushState();
  const state = JSON.parse(fs.readFileSync(path.join(env.dataDir, 'state.json'), 'utf8'));
  assert.equal(state.routing.mainDeviceId, main.deviceId);

  // 显式设置后派发也确实走这台母机。
  const task = await createTask(env, { instruction: '派给指定母机', timeoutSec: 300 });
  assert.equal(task.assignedDeviceId, main.deviceId);
});
