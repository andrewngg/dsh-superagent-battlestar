'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startTestHub,
  makeManifest,
  registerDevice,
  heartbeat,
  ackTask,
  resultTask,
  createTask,
  request,
  adminHeaders,
} = require('./_helpers.js');

async function setupEnv(t) {
  const env = await startTestHub(t);
  const main = await registerDevice(
    env,
    makeManifest({
      name: '主工作机 · DESKTOP-T1',
      platform: 'windows',
      tags: ['本机', '母机'],
    }),
  );
  const mika = await registerDevice(
    env,
    makeManifest({
      name: 'Mika工作机',
      platform: 'android',
      kind: 'mika',
      tags: ['手机', 'Mika'],
      limits: { maxConcurrentTasks: 1 },
    }),
  );
  await heartbeat(env, main, {});
  await heartbeat(env, mika, {});
  return { env, main, mika };
}

test('建任务：指令点名 Mika 时覆盖选择器的母机 deviceId', async (t) => {
  const { env, main, mika } = await setupEnv(t);
  const task = await createTask(env, {
    instruction: '把 tracking 层的都处理掉。用mika工作机',
    requirements: { deviceId: main.deviceId },
  });
  assert.equal(task.assignedDeviceId, mika.deviceId);
  assert.equal(task.requirements.deviceId, mika.deviceId);
  assert.ok(
    task.events.some((event) => event.type === 'routing'),
    `事件里应记录指令点名：${JSON.stringify(task.events)}`,
  );
});

test('跟进任务：指令点名 Mika 时不继承源任务的母机 deviceId', async (t) => {
  const { env, main, mika } = await setupEnv(t);
  const source = await createTask(env, {
    instruction: '总结求职投递情况',
    requirements: { deviceId: main.deviceId },
  });
  assert.equal(source.assignedDeviceId, main.deviceId);
  await ackTask(env, main, source.id);
  const done = await resultTask(env, main, source.id, { ok: true, output: { text: '已总结' } });
  assert.equal(done.status, 200);

  const res = await request(env.base, 'POST', `/api/tasks/${source.id}/follow-up`, {
    headers: adminHeaders(env),
    body: {
      instruction: '继续，用mika工作机处理 tracking 层',
      requirements: { deviceId: main.deviceId },
    },
  });
  assert.equal(res.status, 200);
  const followUp = res.json.task;
  assert.equal(followUp.assignedDeviceId, mika.deviceId);
  assert.equal(followUp.requirements.deviceId, mika.deviceId);
  assert.equal(followUp.replyToTaskId, source.id);
});

test('建任务：点名设备离线时排队并说明在等哪台设备', async (t) => {
  const env = await startTestHub(t);
  const main = await registerDevice(
    env,
    makeManifest({ name: '主工作机 · DESKTOP-T2', platform: 'windows', tags: ['本机', '母机'] }),
  );
  const mika = await registerDevice(
    env,
    makeManifest({
      name: 'Mika工作机',
      platform: 'android',
      kind: 'mika',
      tags: ['手机', 'Mika'],
    }),
  );
  await heartbeat(env, main, {});
  // 直接标记离线，避免测试等心跳超时（注册时设备默认在线）。
  env.hub.markDeviceOffline(env.hub.devices.get(mika.deviceId), '测试离线');

  const task = await createTask(env, {
    instruction: '用mika工作机处理 tracking 层',
    requirements: { deviceId: main.deviceId },
  });
  assert.equal(task.status, 'queued');
  assert.equal(task.assignedDeviceId, null);
  assert.match(task.route.reason, /Mika/);
  assert.match(task.route.reason, /离线/);
  assert.ok(
    task.events.some((event) => event.type === 'queued' && /等待指定设备/.test(event.message)),
    `事件应说明在等指定设备：${JSON.stringify(task.events)}`,
  );
  // 引用一下 mika，确认测试里确实注册了这台离线设备。
  assert.ok(mika.deviceId);
});
