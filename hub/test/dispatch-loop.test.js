'use strict';

/**
 * P0 回归：Hub 重复派发导致 worker 空转死循环。
 *
 * 复现链路：设备忙碌（maxConcurrentTasks=1）时排队中的任务不会立刻 ack，
 * 旧逻辑把 assigned 状态下的 ack 超时当成派发失败并重派（每次新 command id），
 * 设备按 command.id 去重失效 → 重复执行 → 旧 attempt 结果被 409 丢弃 → Hub 继续重派。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  makeManifest,
  startTestHub,
  registerDevice,
  heartbeat,
  createTask,
  getTask,
  ackTask,
  resultTask,
  waitFor,
} = require('./_helpers');

function commandList(res) {
  return (res && res.json && res.json.commands) || [];
}

test('ack 超时：设备忙碌时不重派，重投同一个 command id', async (t) => {
  const env = await startTestHub(t, { ackTimeoutMs: 80, autoRetryOnTimeout: false });
  const device = await registerDevice(env, makeManifest({ limits: { maxConcurrentTasks: 1 } }));

  // 设备正在跑别的任务：心跳显示 busy，并上报已持有的 taskId。
  const busyBody = { status: 'busy', load: { running: 1, max: 1 }, taskIds: ['task_other'] };
  await heartbeat(env, device, busyBody);

  const task = await createTask(env, {
    instruction: '排队中的任务',
    requirements: { model: 'deepseek-chat' },
  });
  const firstBeat = await heartbeat(env, device, busyBody);
  const firstCommands = commandList(firstBeat);
  assert.equal(firstCommands.length, 1, '首轮心跳应拿到派发命令');
  assert.equal(firstCommands[0].taskId, task.id);
  const firstCommandId = firstCommands[0].id;

  // ack 超时后：设备仍忙 → 不重派，只推“设备忙碌”事件。
  await waitFor(
    async () => {
      const current = await getTask(env, task.id);
      return (current.events || []).some((event) => /设备忙碌/.test(String(event.message || '')));
    },
    { label: '设备忙碌等待事件' },
  );

  const afterWait = await getTask(env, task.id);
  assert.equal(afterWait.status, 'assigned');
  assert.equal(afterWait.attempts, 1, '忙碌设备不应消耗 attempt 预算');
  assert.ok(
    !(afterWait.events || []).some((event) => event.type === 'retry'),
    '忙碌设备不应触发 retry 事件',
  );

  const secondBeat = await heartbeat(env, device, busyBody);
  const reCommands = commandList(secondBeat);
  assert.equal(reCommands.length, 1, '超时后应重新投递命令');
  assert.equal(reCommands[0].id, firstCommandId, '同一 attempt 重投必须复用同一个 command id');

  // 设备忙完后正常 ack + 上报结果，任务应只执行一次。
  await ackTask(env, device, task.id);
  const result = await resultTask(env, device, task.id, { ok: true, output: { text: 'ok' } });
  assert.equal(result.status, 200);
  assert.equal(result.json.ignored, false);

  const finished = await getTask(env, task.id);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.attempts, 1);
});

test('结果收敛：重复结果与旧 attempt 结果均返回 200 ignored，且不改变任务', async (t) => {
  const env = await startTestHub(t, { ackTimeoutMs: 5000, autoRetryOnTimeout: false });
  const deviceA = await registerDevice(
    env,
    makeManifest({ name: '设备 A', limits: { maxConcurrentTasks: 1 } }),
  );

  const task = await createTask(env, {
    instruction: '结果收敛',
    requirements: { model: 'deepseek-chat' },
  });
  const beatA = await heartbeat(env, deviceA, { status: 'idle', load: { running: 0, max: 1 } });
  const commandsA = commandList(beatA);
  assert.equal(commandsA.length, 1);
  await ackTask(env, deviceA, task.id);

  // A 掉线后任务重派给新注册的 B（attempt 2）。
  const deviceB = await registerDevice(
    env,
    makeManifest({ name: '设备 B', limits: { maxConcurrentTasks: 1 } }),
  );
  env.hub.markDeviceOffline(env.hub.getDevice(deviceA.deviceId), 'test offline');
  const reassigned = await waitFor(
    async () => {
      const current = await getTask(env, task.id);
      return current.assignedDeviceId === deviceB.deviceId ? current : null;
    },
    { label: '任务重派给设备 B' },
  );
  assert.equal(reassigned.attempts, 2);

  // 旧 attempt（设备 A）迟到的结果：200 + ignored，任务仍归 B。
  const stale = await resultTask(env, deviceA, task.id, { ok: true, output: { text: 'stale' } });
  assert.equal(stale.status, 200);
  assert.equal(stale.json.ignored, true);
  assert.match(String(stale.json.reason || ''), /旧尝试|重新派发/);

  const stillB = await getTask(env, task.id);
  assert.equal(stillB.status, 'assigned');
  assert.equal(stillB.assignedDeviceId, deviceB.deviceId);
  assert.equal(stillB.output, null, '旧结果不应写入输出');

  // B 正常完成。
  const beatB = await heartbeat(env, deviceB, { status: 'idle', load: { running: 0, max: 1 } });
  assert.equal(commandList(beatB).length, 1);
  await ackTask(env, deviceB, task.id);
  const done = await resultTask(env, deviceB, task.id, { ok: true, output: { text: 'done' } });
  assert.equal(done.status, 200);
  assert.equal(done.json.ignored, false);

  // 重复结果：200 + ignored，终态不变。
  const duplicate = await resultTask(env, deviceB, task.id, { ok: false, error: 'late failure' });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.json.ignored, true);
  const completed = await getTask(env, task.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.error, null);
});

test('attempt 归因：自动重试后，旧 attempt 的超时结果返回 200 ignored，不终结新 attempt', async (t) => {
  const env = await startTestHub(t, { timeoutOverrideMs: 120 });
  const device = await registerDevice(env, makeManifest());

  const task = await createTask(env, {
    instruction: '自动重试与旧结果竞态',
    requirements: { deviceId: device.deviceId },
  });
  await ackTask(env, device, task.id);

  const retried = await waitFor(
    async () => {
      const current = await getTask(env, task.id);
      return current.status === 'assigned' && current.attempts === 2 ? current : null;
    },
    { label: '超时后自动重试', timeout: 5000 },
  );
  assert.equal(retried.assignedDeviceId, device.deviceId, '本例重派给同一台设备');

  // 旧 attempt 的「执行超时」迟到：必须被忽略，任务仍由 attempt 2 持有。
  const stale = await resultTask(env, device, task.id, {
    ok: false,
    error: '执行超时',
    attempt: retried.attempts - 1,
  });
  assert.equal(stale.status, 200);
  assert.equal(stale.json.ignored, true);
  assert.match(String(stale.json.reason || ''), /旧尝试|attempt/);

  const stillAssigned = await getTask(env, task.id);
  assert.equal(stillAssigned.status, 'assigned');
  assert.equal(stillAssigned.attempts, 2);
  assert.equal(stillAssigned.error, null);

  // 本次 attempt 的结果正常收下。
  await ackTask(env, device, task.id);
  const done = await resultTask(env, device, task.id, {
    ok: true,
    output: { text: 'ok' },
    attempt: 2,
  });
  assert.equal(done.status, 200);
  assert.equal(done.json.ignored, false);

  const finished = await getTask(env, task.id);
  assert.equal(finished.status, 'completed');
});

test('派发预算：attempts 达到上限时不再派发', async (t) => {
  const env = await startTestHub(t);
  const task = await createTask(env, {
    instruction: '预算耗尽',
    requirements: { model: 'deepseek-chat' },
  });
  const queued = await getTask(env, task.id);
  assert.equal(queued.status, 'queued');

  const internal = env.hub.getTask(task.id);
  internal.attempts = internal.maxAttempts;
  env.hub.routeTask(internal);

  const failed = await getTask(env, task.id);
  assert.equal(failed.status, 'failed');
  assert.match(String(failed.error || ''), /dispatch budget exhausted/);
});
