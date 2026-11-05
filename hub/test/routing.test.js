'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startTestHub,
  makeManifest,
  registerDevice,
  heartbeat,
  ackTask,
  createTask,
  getTask,
  snapshot,
  request,
  adminHeaders,
  deviceHeaders,
} = require('./_helpers.js');

test('路由匹配：skills / model / tags / deviceId', async (t) => {
  const env = await startTestHub(t);
  const office = await registerDevice(
    env,
    makeManifest({
      name: 'Office 工作站',
      tags: ['书房'],
      models: [{ id: 'deepseek-chat', strengths: ['code'] }],
      skills: [{ id: 'office-docx' }],
    }),
  );
  const media = await registerDevice(
    env,
    makeManifest({
      name: '客厅媒体中心',
      tags: ['客厅'],
      models: [{ id: 'gpt-4o' }],
      skills: [{ id: 'office-xlsx' }],
    }),
  );

  const bySkill = await createTask(env, {
    instruction: '整理 Word 报告',
    requirements: { skills: ['office-docx'] },
  });
  assert.equal(bySkill.status, 'assigned');
  assert.equal(bySkill.assignedDeviceId, office.deviceId);
  assert.equal(bySkill.assignedDeviceName, 'Office 工作站');
  assert.match(bySkill.route.reason, /matched 1 candidate/);
  assert.deepEqual(bySkill.route.candidates[0].matched, ['skill:office-docx']);
  assert.ok(bySkill.route.candidates[0].score > 0);

  const byModel = await createTask(env, {
    instruction: '用 gpt-4o 写文案',
    requirements: { model: 'gpt-4o' },
  });
  assert.equal(byModel.assignedDeviceId, media.deviceId);

  const byTags = await createTask(env, {
    instruction: '客厅任务',
    requirements: { tags: ['客厅'] },
  });
  assert.equal(byTags.assignedDeviceId, media.deviceId);

  const byDeviceId = await createTask(env, {
    instruction: '指定设备任务',
    requirements: { deviceId: office.deviceId, model: 'deepseek-chat' },
  });
  assert.equal(byDeviceId.assignedDeviceId, office.deviceId);
  const mismatch = byDeviceId.route.excluded.find((item) => item.deviceId === media.deviceId);
  assert.ok(mismatch, '指定 deviceId 时其他设备应进入 excluded');
  assert.equal(mismatch.reason, 'deviceId mismatch');
});

test('无匹配设备 → queued（含 excluded 原因）；设备上线/新注册后自动路由', async (t) => {
  const env = await startTestHub(t);
  const onlyXlsx = await registerDevice(env, makeManifest({ skills: [{ id: 'office-xlsx' }] }));

  const task = await createTask(env, {
    instruction: '生成 PDF',
    requirements: { skills: ['office-pdf'], model: 'deepseek-chat' },
  });
  assert.equal(task.status, 'queued');
  assert.equal(task.assignedDeviceId, null);
  assert.deepEqual(task.route.candidates, []);
  assert.match(task.route.reason, /no matching device/);
  const excluded = task.route.excluded.find((item) => item.deviceId === onlyXlsx.deviceId);
  assert.ok(excluded);
  assert.match(excluded.reason, /missing skill:office-pdf/);

  // 设备离线 → 只有 offline 原因
  env.hub.markDeviceOffline(env.hub.getDevice(onlyXlsx.deviceId), 'test offline');
  const offlineTask = await createTask(env, {
    instruction: '离线设备任务',
    requirements: { model: 'deepseek-chat' },
  });
  assert.equal(offlineTask.status, 'queued');
  assert.match(
    offlineTask.route.excluded.find((item) => item.deviceId === onlyXlsx.deviceId).reason,
    /^offline$/,
  );

  // 心跳让设备重新上线 → 自动重路由已排队任务，命令随心跳下发
  const beat = await heartbeat(env, onlyXlsx, { status: 'idle' });
  assert.equal(beat.status, 200);
  const onlineTask = await getTask(env, offlineTask.id);
  assert.equal(onlineTask.status, 'assigned');
  assert.equal(onlineTask.assignedDeviceId, onlyXlsx.deviceId);
  assert.equal(onlineTask.attempts, 1);
  assert.equal(beat.json.commands.length, 1);
  assert.equal(beat.json.commands[0].taskId, offlineTask.id);

  // 新注册设备补齐能力 → 之前因缺技能排队的任务自动路由
  const capable = await registerDevice(env, makeManifest({ name: '能干活的设备', skills: [{ id: 'office-pdf' }] }));
  const queuedTask = await getTask(env, task.id);
  assert.equal(queuedTask.status, 'assigned');
  assert.equal(queuedTask.assignedDeviceId, capable.deviceId);
});

test('评分：负载越低得分越高，同能力时优先空闲设备；route.candidates 最多 5 个', async (t) => {
  const env = await startTestHub(t);
  const busy = await registerDevice(
    env,
    makeManifest({ name: '忙碌设备', limits: { maxConcurrentTasks: 2 } }),
  );
  const idle = await registerDevice(
    env,
    makeManifest({ name: '空闲设备', limits: { maxConcurrentTasks: 2 } }),
  );

  const runningTask = await createTask(env, {
    instruction: '占用一个并发',
    requirements: { deviceId: busy.deviceId },
  });
  const ack = await ackTask(env, busy, runningTask.id);
  assert.equal(ack.status, 200);
  assert.equal(ack.json.task.status, 'running');

  const busySnapshot = await request(env.base, 'GET', `/api/devices/${busy.deviceId}`, {
    headers: adminHeaders(env),
  });
  assert.equal(busySnapshot.json.device.load.running, 1);

  await heartbeat(env, busy, { status: 'busy' });
  await heartbeat(env, idle, { status: 'idle' });

  const task = await createTask(env, {
    instruction: '挑一台设备',
    requirements: { model: 'deepseek-chat' },
  });
  assert.equal(task.status, 'assigned');
  assert.equal(task.assignedDeviceId, idle.deviceId);
  assert.equal(task.route.candidates.length, 2);
  assert.equal(task.route.candidates[0].deviceId, idle.deviceId);
  assert.ok(
    task.route.candidates[0].score > task.route.candidates[1].score,
    '空闲设备得分应高于忙碌设备',
  );

  // 再注册 4 台同能力设备，共 6 台 → candidates 只保留前 5
  for (let i = 0; i < 4; i += 1) {
    await registerDevice(env, makeManifest({ name: `扩展设备 ${i}` }));
  }
  const multi = await createTask(env, {
    instruction: '候选上限',
    requirements: { model: 'deepseek-chat' },
  });
  assert.equal(multi.status, 'assigned');
  assert.equal(multi.route.candidates.length, 5);
});

test('容量与禁用设备被排除；excluded 最多记录 10 条', async (t) => {
  const env = await startTestHub(t);
  const single = await registerDevice(env, makeManifest({ name: '单并发设备', limits: { maxConcurrentTasks: 1 } }));

  const first = await createTask(env, {
    instruction: '占满并发',
    requirements: { deviceId: single.deviceId },
  });
  assert.equal(first.status, 'assigned');
  await ackTask(env, single, first.id);

  const second = await createTask(env, {
    instruction: '容量已满',
    requirements: { deviceId: single.deviceId },
  });
  assert.equal(second.status, 'queued');
  const capacityReason = second.route.excluded.find((item) => item.deviceId === single.deviceId);
  assert.ok(capacityReason);
  assert.match(capacityReason.reason, /capacity/);

  // 释放容量后仍未被禁用；PATCH disabled 后应被排除
  await request(env.base, 'POST', `/api/tasks/${first.id}/cancel`, {
    headers: adminHeaders(env),
    body: {},
  });
  const patched = await request(env.base, 'PATCH', `/api/devices/${single.deviceId}`, {
    headers: adminHeaders(env),
    body: { disabled: true },
  });
  assert.equal(patched.status, 200);

  const disabledTask = await createTask(env, {
    instruction: '设备被禁用',
    requirements: { model: 'deepseek-chat' },
  });
  assert.equal(disabledTask.status, 'queued');
  const disabledReason = disabledTask.route.excluded.find((item) => item.deviceId === single.deviceId);
  assert.ok(disabledReason);
  assert.equal(disabledReason.reason, 'disabled');
  assert.equal(disabledTask.route.excluded.length, 1);
});

test('excluded 最多 10 条；补齐能力后排队任务自动路由', async (t) => {
  const env = await startTestHub(t);
  const devices = [];
  for (let i = 0; i < 12; i += 1) {
    devices.push(
      await registerDevice(
        env,
        makeManifest({ name: `设备 ${i}`, skills: [{ id: 'office-xlsx' }] }),
      ),
    );
  }
  const task = await createTask(env, {
    instruction: '需要 PDF 技能',
    requirements: { skills: ['office-pdf'] },
  });
  assert.equal(task.status, 'queued');
  assert.equal(task.route.excluded.length, 10);

  const capable = await registerDevice(env, makeManifest({ name: 'PDF 设备', skills: [{ id: 'office-pdf' }] }));
  const routed = await getTask(env, task.id);
  assert.equal(routed.status, 'assigned');
  assert.equal(routed.assignedDeviceId, capable.deviceId);
  assert.equal(routed.route.candidates.length, 1);

  // 全部设备仍在线
  const snap = await snapshot(env);
  assert.equal(snap.stats.devicesOnline, 13);
});
