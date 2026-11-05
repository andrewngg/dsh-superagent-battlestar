'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startTestHub,
  request,
  makeManifest,
  registerDevice,
  heartbeat,
  ackTask,
  progressTask,
  resultTask,
  createTask,
  getTask,
  snapshot,
  waitFor,
  adminHeaders,
  deviceHeaders,
} = require('./_helpers.js');

test('任务全流程：创建 → assigned → 命令 → ack → running → progress → result → completed', async (t) => {
  const env = await startTestHub(t);
  const device = await registerDevice(env, makeManifest({ name: '执行设备' }));

  const task = await createTask(env, {
    instruction: '把本周开销整理成 Word 报告',
    requirements: { skills: ['office-docx'] },
    priority: 7,
    timeoutSec: 120,
  });
  assert.equal(task.status, 'assigned');
  assert.equal(task.attempts, 1);
  assert.equal(task.priority, 7);
  assert.equal(task.timeoutSec, 120);
  assert.equal(task.maxAttempts, 2);
  assert.equal(task.assignedDeviceId, device.deviceId);
  assert.equal(task.assignedDeviceName, '执行设备');
  assert.equal(task.startedAt, null);
  assert.match(task.route.reason, /matched 1 candidate; picked dev_/);
  assert.ok(task.route.candidates[0].matched.includes('skill:office-docx'));
  assert.deepEqual(
    task.events.map((event) => event.type),
    ['created', 'assigned'],
  );

  // 设备从心跳回包取命令
  const beat = await heartbeat(env, device, { status: 'idle' });
  assert.equal(beat.json.commands.length, 1);
  const command = beat.json.commands[0];
  assert.equal(command.type, 'run_task');
  assert.equal(command.taskId, task.id);
  assert.equal(command.payload.instruction, '把本周开销整理成 Word 报告');
  assert.equal(command.payload.priority, 7);

  // ack：assigned → running，幂等
  const ack = await ackTask(env, device, task.id);
  assert.equal(ack.status, 200);
  assert.equal(ack.json.task.status, 'running');
  assert.ok(Date.parse(ack.json.task.startedAt) > 0);
  const ackAgain = await ackTask(env, device, task.id);
  assert.equal(ackAgain.status, 200);
  assert.equal(ackAgain.json.task.status, 'running');
  assert.equal(ackAgain.json.task.attempts, 1);

  let snap = await snapshot(env);
  assert.equal(snap.devices[0].load.running, 1);
  assert.equal(snap.stats.tasksRunning, 1);
  assert.equal(snap.stats.tasksAssigned, 0);

  // progress
  const progress = await progressTask(env, device, task.id, {
    message: '正在解析表格…',
    percent: 40,
    logs: ['读取 expenses.xlsx', '生成大纲'],
  });
  assert.equal(progress.status, 200);
  assert.equal(progress.json.ok, true);
  let current = await getTask(env, task.id);
  assert.equal(current.status, 'running');
  assert.equal(current.progress.percent, 40);
  assert.equal(current.progress.message, '正在解析表格…');
  assert.deepEqual(current.progress.logs, ['读取 expenses.xlsx', '生成大纲']);

  // result → completed
  const result = await resultTask(env, device, task.id, {
    ok: true,
    output: {
      text: '报告已生成',
      markdown: '# 报告',
      artifacts: [{ name: 'report.docx', url: 'http://192.168.1.20/report.docx' }],
    },
    durationMs: 1200,
  });
  assert.equal(result.status, 200);
  const completed = result.json.task;
  assert.equal(completed.status, 'completed');
  assert.ok(Date.parse(completed.finishedAt) > 0);
  assert.equal(completed.output.text, '报告已生成');
  assert.equal(completed.output.artifacts[0].name, 'report.docx');
  assert.equal(completed.progress.percent, 100);

  snap = await snapshot(env);
  assert.equal(snap.devices[0].load.running, 0);
  assert.equal(snap.stats.tasksCompleted, 1);
  assert.equal(snap.stats.tasksRunning, 0);

  const types = completed.events.map((event) => event.type);
  for (const expected of ['created', 'assigned', 'ack', 'progress', 'completed']) {
    assert.ok(types.includes(expected), `任务事件时间线缺少 ${expected}：${types.join(',')}`);
  }
});

test('result(ok:false) → failed，设备负载回落', async (t) => {
  const env = await startTestHub(t);
  const device = await registerDevice(env, makeManifest());

  const task = await createTask(env, {
    instruction: '会失败的任务',
    requirements: { deviceId: device.deviceId },
  });
  await ackTask(env, device, task.id);
  const result = await resultTask(env, device, task.id, { ok: false, error: '文件损坏' });
  assert.equal(result.status, 200);
  assert.equal(result.json.task.status, 'failed');
  assert.equal(result.json.task.error, '文件损坏');
  assert.ok(result.json.task.finishedAt);

  const snap = await snapshot(env);
  assert.equal(snap.devices[0].load.running, 0);
  assert.equal(snap.stats.tasksFailed, 1);
  assert.ok(snap.tasks[0].events.some((event) => event.type === 'failed'));
});

test('ack 超时 → 30s 内重派（测试用短超时），超过 maxAttempts 后 failed', async (t) => {
  const env = await startTestHub(t, { ackTimeoutMs: 120 });
  const deviceA = await registerDevice(env, makeManifest({ name: '设备 A' }));
  const deviceB = await registerDevice(env, makeManifest({ name: '设备 B' }));

  const task = await createTask(env, {
    instruction: '设备不确认',
    requirements: { model: 'deepseek-chat' },
  });
  assert.equal(task.status, 'assigned');
  const firstDeviceId = task.assignedDeviceId;
  assert.ok([deviceA.deviceId, deviceB.deviceId].includes(firstDeviceId));

  const redispatched = await waitFor(
    async () => {
      const current = await getTask(env, task.id);
      return current.attempts === 2 && current.status === 'assigned' && current.assignedDeviceId !== firstDeviceId
        ? current
        : null;
    },
    { label: 'ack 超时后重派到另一台设备', timeout: 5000 },
  );
  assert.notEqual(redispatched.assignedDeviceId, firstDeviceId);
  assert.ok(redispatched.events.some((event) => event.type === 'retry'));

  const failed = await waitFor(
    async () => {
      const current = await getTask(env, task.id);
      return current.status === 'failed' ? current : null;
    },
    { label: '第二次 ack 超时后失败', timeout: 5000 },
  );
  assert.equal(failed.attempts, 2);
  assert.match(failed.error, /ack timeout/);
  const snap = await snapshot(env);
  assert.equal(snap.stats.tasksFailed, 1);
});

test('maxAttempts=1 时 ack 超时直接失败', async (t) => {
  const env = await startTestHub(t, { ackTimeoutMs: 100 });
  const device = await registerDevice(env, makeManifest());

  const task = await createTask(env, {
    instruction: '只允许一次尝试',
    maxAttempts: 1,
    requirements: { deviceId: device.deviceId },
  });
  const failed = await waitFor(
    async () => {
      const current = await getTask(env, task.id);
      return current.status === 'failed' ? current : null;
    },
    { label: '单次尝试失败', timeout: 5000 },
  );
  assert.equal(failed.attempts, 1);
  assert.equal(failed.assignedDeviceId, device.deviceId);
  assert.match(failed.error, /ack timeout/);
});

test('运行时超时 → timeout；设备收到 cancel_task；可 retry 后完成', async (t) => {
  const env = await startTestHub(t, { timeoutOverrideMs: 150 });
  const device = await registerDevice(env, makeManifest());

  const task = await createTask(env, { instruction: '执行很慢', requirements: { deviceId: device.deviceId } });
  await ackTask(env, device, task.id);

  const timedOut = await waitFor(
    async () => {
      const current = await getTask(env, task.id);
      return current.status === 'timeout' ? current : null;
    },
    { label: '任务运行超时', timeout: 5000 },
  );
  assert.match(timedOut.error, /超时/);
  assert.ok(timedOut.finishedAt);

  const snap = await snapshot(env);
  assert.equal(snap.devices[0].load.running, 0);
  assert.equal(snap.stats.tasksFailed, 1);

  // 超时后 Hub 会向设备下发 cancel_task
  const commands = await request(
    env.base,
    'GET',
    `/api/devices/${device.deviceId}/commands?waitMs=100&limit=5`,
    { headers: deviceHeaders(device) },
  );
  assert.ok(
    commands.json.commands.some((cmd) => cmd.type === 'cancel_task' && cmd.taskId === task.id),
    '超时任务应下发 cancel_task 命令',
  );

  // retry：timeout 可重试，重新路由并完成
  const retried = await request(env.base, 'POST', `/api/tasks/${task.id}/retry`, {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(retried.status, 200);
  assert.equal(retried.json.task.status, 'assigned');
  assert.equal(retried.json.task.attempts, 1);
  assert.equal(retried.json.task.error, null);
  assert.equal(retried.json.task.finishedAt, null);

  await ackTask(env, device, task.id);
  await resultTask(env, device, task.id, { ok: true, output: { text: '补跑成功' } });
  const completed = await getTask(env, task.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.output.text, '补跑成功');
});

test('assigned 阶段也会按时超时（未 ack → timeout）', async (t) => {
  const env = await startTestHub(t, { timeoutOverrideMs: 120 });
  const device = await registerDevice(env, makeManifest());
  const task = await createTask(env, {
    instruction: '没人确认的任务',
    requirements: { deviceId: device.deviceId },
  });
  assert.equal(task.status, 'assigned');

  const timedOut = await waitFor(
    async () => {
      const current = await getTask(env, task.id);
      return current.status === 'timeout' ? current : null;
    },
    { label: 'assigned 阶段超时', timeout: 5000 },
  );
  assert.match(timedOut.error, /超时/);
});

test('取消：queued / running 均可取消，running 取消会下发 cancel_task；终态不可取消', async (t) => {
  const env = await startTestHub(t);
  const device = await registerDevice(env, makeManifest());

  // queued 任务取消
  const queued = await createTask(env, {
    instruction: '无匹配任务',
    requirements: { skills: ['office-pdf'] },
  });
  assert.equal(queued.status, 'queued');
  const cancelledQueued = await request(env.base, 'POST', `/api/tasks/${queued.id}/cancel`, {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(cancelledQueued.status, 200);
  assert.equal(cancelledQueued.json.task.status, 'cancelled');
  assert.ok(cancelledQueued.json.task.finishedAt);

  // running 任务取消
  const running = await createTask(env, {
    instruction: '运行中的任务',
    requirements: { deviceId: device.deviceId },
  });
  await ackTask(env, device, running.id);
  const cancelledRunning = await request(env.base, 'POST', `/api/tasks/${running.id}/cancel`, {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(cancelledRunning.status, 200);
  assert.equal(cancelledRunning.json.task.status, 'cancelled');
  const snap = await snapshot(env);
  assert.equal(snap.devices[0].load.running, 0);

  const commands = await request(
    env.base,
    'GET',
    `/api/devices/${device.deviceId}/commands?waitMs=100&limit=5`,
    { headers: deviceHeaders(device) },
  );
  assert.ok(
    commands.json.commands.some((cmd) => cmd.type === 'cancel_task' && cmd.taskId === running.id),
    '取消 running 任务应下发 cancel_task',
  );

  // 已完成任务不可取消
  const done = await createTask(env, {
    instruction: '已完成任务',
    requirements: { deviceId: device.deviceId },
  });
  await ackTask(env, device, done.id);
  await resultTask(env, device, done.id, { ok: true, output: { text: '完成' } });
  const cancelDone = await request(env.base, 'POST', `/api/tasks/${done.id}/cancel`, {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(cancelDone.status, 409);
  assert.equal(cancelDone.json.error.code, 'conflict');
});

test('failed 任务可 retry，retry 后 attempts 重置并重新派发', async (t) => {
  const env = await startTestHub(t);
  const device = await registerDevice(env, makeManifest());

  const task = await createTask(env, {
    instruction: '先失败再重试',
    requirements: { deviceId: device.deviceId },
  });
  await ackTask(env, device, task.id);
  await resultTask(env, device, task.id, { ok: false, error: '第一次失败' });
  const failed = await getTask(env, task.id);
  assert.equal(failed.status, 'failed');

  const retried = await request(env.base, 'POST', `/api/tasks/${task.id}/retry`, {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(retried.status, 200);
  assert.equal(retried.json.task.status, 'assigned');
  assert.equal(retried.json.task.attempts, 1);
  assert.equal(retried.json.task.error, null);
  assert.ok(retried.json.task.events.some((event) => event.type === 'retried'));

  await ackTask(env, device, task.id);
  const result = await resultTask(env, device, task.id, { ok: true, output: { text: '重试成功' } });
  assert.equal(result.json.task.status, 'completed');

  // 已完成任务不可重试
  const retryDone = await request(env.base, 'POST', `/api/tasks/${task.id}/retry`, {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(retryDone.status, 409);
});

test('设备离线：assigned/running 任务在 maxAttempts 内重派其他设备，否则 failed', async (t) => {
  const env = await startTestHub(t);
  const deviceA = await registerDevice(env, makeManifest({ name: 'A 设备' }));
  const deviceB = await registerDevice(env, makeManifest({ name: 'B 设备' }));

  // 先让 B 离线，确保任务落到 A
  env.hub.markDeviceOffline(env.hub.getDevice(deviceB.deviceId), 'test offline');
  const task = await createTask(env, {
    instruction: '设备会掉线',
    requirements: { model: 'deepseek-chat' },
  });
  assert.equal(task.status, 'assigned');
  assert.equal(task.assignedDeviceId, deviceA.deviceId);
  await ackTask(env, deviceA, task.id);

  // B 重新上线后让 A 掉线 → running 任务重派到 B
  await heartbeat(env, deviceB, { status: 'idle' });
  env.hub.markDeviceOffline(env.hub.getDevice(deviceA.deviceId), 'test heartbeat timeout');
  const redispatched = await waitFor(
    async () => {
      const current = await getTask(env, task.id);
      return current.attempts === 2 && current.status === 'assigned' ? current : null;
    },
    { label: '设备离线后 running 任务重派', timeout: 3000 },
  );
  assert.equal(redispatched.assignedDeviceId, deviceB.deviceId);
  assert.equal(redispatched.attempts, 2);
  assert.ok(redispatched.events.some((event) => event.type === 'retry'));

  const beat = await heartbeat(env, deviceB, { status: 'idle' });
  assert.equal(beat.json.commands.length, 1);
  assert.equal(beat.json.commands[0].taskId, task.id);

  // maxAttempts=1 时设备离线直接 failed
  const single = await createTask(env, {
    instruction: '只允许一次尝试',
    maxAttempts: 1,
    requirements: { model: 'deepseek-chat' },
  });
  assert.equal(single.status, 'assigned');
  assert.equal(single.assignedDeviceId, deviceB.deviceId);
  await ackTask(env, deviceB, single.id);
  env.hub.markDeviceOffline(env.hub.getDevice(deviceB.deviceId), 'test heartbeat timeout');
  const failed = await waitFor(
    async () => {
      const current = await getTask(env, single.id);
      return current.status === 'failed' ? current : null;
    },
    { label: '设备离线且无重试次数 → failed', timeout: 3000 },
  );
  assert.match(failed.error, /heartbeat timeout/);
  assert.equal(failed.attempts, 1);
});

test('任务参数校验、列表过滤与 404', async (t) => {
  const env = await startTestHub(t);
  const device = await registerDevice(env, makeManifest());

  const missingInstruction = await request(env.base, 'POST', '/api/tasks', {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(missingInstruction.status, 400);
  assert.match(missingInstruction.json.error.message, /instruction/);

  const task = await createTask(env, {
    instruction: '参数归一化',
    priority: 99,
    timeoutSec: 5,
    maxAttempts: 9,
    requirements: { deviceId: device.deviceId },
  });
  assert.equal(task.priority, 9);
  assert.equal(task.timeoutSec, 30);
  assert.equal(task.maxAttempts, 3);

  await createTask(env, {
    instruction: '第二个任务',
    requirements: { deviceId: device.deviceId },
  });

  const assignedList = await request(env.base, 'GET', '/api/tasks?status=assigned', {
    headers: adminHeaders(env),
  });
  assert.equal(assignedList.status, 200);
  assert.equal(assignedList.json.tasks.length, 2);

  const byDevice = await request(
    env.base,
    'GET',
    `/api/tasks?deviceId=${encodeURIComponent(device.deviceId)}`,
    { headers: adminHeaders(env) },
  );
  assert.equal(byDevice.json.tasks.length, 2);

  const limited = await request(env.base, 'GET', '/api/tasks?limit=1', {
    headers: adminHeaders(env),
  });
  assert.equal(limited.json.tasks.length, 1);

  const single = await request(env.base, 'GET', `/api/tasks/${task.id}`, {
    headers: adminHeaders(env),
  });
  assert.equal(single.status, 200);
  assert.equal(single.json.task.id, task.id);
  assert.ok(single.json.task.route);
  assert.ok(Array.isArray(single.json.task.events));

  const notFoundTask = await request(env.base, 'GET', '/api/tasks/task_missing', {
    headers: adminHeaders(env),
  });
  assert.equal(notFoundTask.status, 404);
  assert.equal(notFoundTask.json.error.code, 'not_found');
});
