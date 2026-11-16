'use strict';

/**
 * Agnes 拆分计划的执行判断：并行/串行依赖、卡点暂停与恢复、单并发设备排队、取消级联。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');

const { startTestHub, startHubAt, makeTempDir, makeManifest, registerDevice, waitFor } = require('./_helpers.js');

/** 模拟设备完成一个已分配任务：ack → result(ok)。 */
function complete(env, deviceObj, taskId) {
  env.hub.handleAck(deviceObj, taskId);
  env.hub.handleResult(deviceObj, taskId, { ok: true, output: { text: `完成 ${taskId}` } });
}

const OFFICE_SKILLS = [{ id: 'office-docx', name: 'Word 文档' }];

test('计划执行：并行组同时派发，依赖子任务等前序完成后才派发', async (t) => {
  const env = await startTestHub(t, {
    planner: async () => ({
      title: '并行计划',
      execution: {
        strategy: 'mixed',
        blockerPolicy: 'stop-and-ask',
        groups: [
          { name: '准备', mode: 'parallel', subtaskIndexes: [0, 1] },
          { name: '汇总', mode: 'sequential', subtaskIndexes: [2] },
        ],
      },
      subtasks: [
        { instruction: '准备资料', timeoutSec: 300 },
        { instruction: '准备素材', timeoutSec: 300 },
        { instruction: '汇总输出', timeoutSec: 300, dependsOn: [0, 1], parallelGroup: '汇总' },
      ],
    }),
  });
  const device = await registerDevice(env, makeManifest({ limits: { maxConcurrentTasks: 2 }, skills: OFFICE_SKILLS }));
  const deviceObj = env.hub.devices.get(device.deviceId);
  const parent = await env.hub.createPlanTask({
    instruction: '并行长任务',
    requirements: { skills: ['office-docx'] },
    timeoutSec: 1800,
    split: true,
  });

  assert.equal(parent.plan.strategy, 'mixed');
  assert.deepEqual(parent.plan.groups.map((group) => group.name), ['准备', '汇总']);
  assert.match(parent.progress.message, /并行 \+ 顺序依赖/);

  const [first, second, third] = parent.childTaskIds.map((id) => env.hub.getTask(id));
  assert.equal(first.planStep, 1);
  assert.equal(second.planStep, 2);
  assert.equal(third.planStep, 3);
  assert.deepEqual(third.planDependsOn, [0, 1]);
  assert.equal(third.planDependsOnTaskIds.length, 2);
  assert.equal(third.planGroup, '汇总');

  // 并行组的两步同时派发；依赖它们的第三步继续排队。
  assert.equal(first.status, 'assigned');
  assert.equal(second.status, 'assigned');
  assert.equal(third.status, 'queued');
  assert.match(third.route.reason, /等待前置子任务/);

  complete(env, deviceObj, first.id);
  assert.equal(env.hub.getTask(third.id).status, 'queued', '只完成一个前置时仍应排队');
  assert.match(env.hub.getTask(third.id).route.reason, /等待前置子任务/);

  complete(env, deviceObj, second.id);
  await waitFor(() => env.hub.getTask(third.id).status === 'assigned', { label: '第三步派发' });
  complete(env, deviceObj, third.id);

  const finished = env.hub.getTask(parent.id);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.progress.percent, 100);
});

test('计划执行：前序失败后暂停并标记卡点，重试失败子任务后自动继续', async (t) => {
  const env = await startTestHub(t, {
    planner: async () => ({
      title: '串行计划',
      execution: { strategy: 'sequential', blockerPolicy: 'stop-and-ask', groups: [] },
      subtasks: [
        { instruction: '第一步', timeoutSec: 300 },
        { instruction: '第二步', timeoutSec: 300, dependsOn: [0] },
        { instruction: '第三步', timeoutSec: 300, dependsOn: [1] },
      ],
    }),
  });
  const device = await registerDevice(env, makeManifest({ limits: { maxConcurrentTasks: 1 }, skills: OFFICE_SKILLS }));
  const deviceObj = env.hub.devices.get(device.deviceId);
  const parent = await env.hub.createPlanTask({
    instruction: '串行长任务',
    requirements: { skills: ['office-docx'] },
    timeoutSec: 1800,
    split: true,
  });
  assert.equal(parent.plan.strategy, 'sequential');
  assert.match(parent.progress.message, /按顺序执行/);

  const [first, second, third] = parent.childTaskIds.map((id) => env.hub.getTask(id));
  assert.equal(first.status, 'assigned');
  assert.equal(second.status, 'queued');
  assert.equal(third.status, 'queued');

  env.hub.handleAck(deviceObj, first.id);
  env.hub.handleResult(deviceObj, first.id, { ok: false, error: '模拟失败' });

  const blocked = env.hub.getTask(parent.id);
  assert.equal(blocked.progress.blocked, true, '父任务进度应标记卡点');
  assert.match(blocked.progress.message, /卡点/);
  assert.ok(blocked.events.some((event) => event.type === 'blocked'), '应记录 blocked 事件');
  assert.match(env.hub.getTask(second.id).route.reason, /卡点/);

  // 重试失败子任务后，计划自动继续，不再需要人工点“继续任务”。
  env.hub.retryTask(env.hub.getTask(first.id));
  assert.equal(env.hub.getTask(first.id).status, 'assigned');
  complete(env, deviceObj, first.id);
  await waitFor(() => env.hub.getTask(second.id).status === 'assigned', { label: '第二步恢复派发' });
  complete(env, deviceObj, second.id);
  await waitFor(() => env.hub.getTask(third.id).status === 'assigned', { label: '第三步派发' });
  complete(env, deviceObj, third.id);

  assert.equal(env.hub.getTask(parent.id).status, 'completed');
});

test('计划执行：Mika 单并发时并行子任务排队，前一个结束后自动接下一个', async (t) => {
  const env = await startTestHub(t, {
    planner: async () => ({
      title: '手机任务计划',
      execution: { strategy: 'parallel', blockerPolicy: 'stop-and-ask', groups: [{ name: '手机步骤', mode: 'parallel', subtaskIndexes: [0, 1, 2] }] },
      subtasks: [
        { instruction: '手机步骤一', timeoutSec: 600 },
        { instruction: '手机步骤二', timeoutSec: 600 },
        { instruction: '手机步骤三', timeoutSec: 600 },
      ],
    }),
  });
  const device = await registerDevice(
    env,
    makeManifest({
      name: '手机工作机 · OPPO',
      platform: 'android',
      tags: ['手机', 'Mika'],
      limits: { maxConcurrentTasks: 1 },
      skills: [{ id: 'phone-control', name: '手机操控' }],
    }),
  );
  const deviceObj = env.hub.devices.get(device.deviceId);
  const parent = await env.hub.createPlanTask({
    instruction: '手机上连续做三件事',
    requirements: { skills: ['phone-control'] },
    timeoutSec: 1800,
    split: true,
  });

  const children = parent.childTaskIds.map((id) => env.hub.getTask(id));
  assert.equal(children.filter((child) => child.status === 'assigned').length, 1, '单并发设备同时只接 1 个子任务');
  assert.equal(children.filter((child) => child.status === 'queued').length, 2);

  for (let index = 0; index < children.length; index += 1) {
    const assigned = env.hub
      .getTask(parent.id)
      .childTaskIds.map((id) => env.hub.getTask(id))
      .find((child) => child.status === 'assigned');
    assert.ok(assigned, `第 ${index + 1} 轮应有一个子任务在设备上执行`);
    complete(env, deviceObj, assigned.id);
    if (index < children.length - 1) {
      await waitFor(
        () =>
          env.hub
            .getTask(parent.id)
            .childTaskIds.map((id) => env.hub.getTask(id))
            .filter((child) => child.status === 'assigned').length === 1,
        { label: `第 ${index + 2} 个子任务接力` },
      );
    }
  }
  assert.equal(env.hub.getTask(parent.id).status, 'completed');
});

test('计划执行：取消排队子任务时级联取消依赖它的后续子任务', async (t) => {
  const env = await startTestHub(t, {
    planner: async () => ({
      title: '级联取消',
      execution: { strategy: 'sequential', blockerPolicy: 'stop-and-ask', groups: [] },
      subtasks: [
        { instruction: '第一步', timeoutSec: 300 },
        { instruction: '第二步', timeoutSec: 300, dependsOn: [0] },
        { instruction: '第三步', timeoutSec: 300, dependsOn: [1] },
      ],
    }),
  });
  const device = await registerDevice(env, makeManifest({ limits: { maxConcurrentTasks: 1 }, skills: OFFICE_SKILLS }));
  const deviceObj = env.hub.devices.get(device.deviceId);
  const parent = await env.hub.createPlanTask({
    instruction: '可取消的长任务',
    requirements: { skills: ['office-docx'] },
    timeoutSec: 1800,
    split: true,
  });
  const [first, second, third] = parent.childTaskIds.map((id) => env.hub.getTask(id));
  env.hub.handleAck(deviceObj, first.id);
  env.hub.handleResult(deviceObj, first.id, { ok: false, error: '模拟失败' });

  env.hub.cancelTask(env.hub.getTask(second.id));
  assert.equal(env.hub.getTask(second.id).status, 'cancelled');
  assert.equal(env.hub.getTask(third.id).status, 'cancelled', '依赖被取消的子任务应级联取消');
  assert.equal(env.hub.getTask(parent.id).status, 'failed');
});

test('计划元数据持久化：重启后保留执行方式、步骤与依赖', async (t) => {
  const dataDir = await makeTempDir('butler-plan-exec-restore-');
  t.after(() => fsp.rm(dataDir, { recursive: true, force: true }));

  const first = await startHubAt(dataDir, {
    planner: async () => ({
      title: '持久化计划',
      execution: { strategy: 'mixed', blockerPolicy: 'stop-and-ask', groups: [{ name: '准备', mode: 'parallel', subtaskIndexes: [0] }] },
      subtasks: [
        { instruction: '第一步', timeoutSec: 300 },
        { instruction: '第二步', timeoutSec: 300, dependsOn: [0] },
      ],
    }),
  });
  await registerDevice(first, makeManifest({ limits: { maxConcurrentTasks: 1 }, skills: OFFICE_SKILLS }));
  const parent = await first.hub.createPlanTask({
    instruction: '持久化长任务',
    requirements: { skills: ['office-docx'] },
    timeoutSec: 1800,
    split: true,
  });
  await first.hub.flushState();
  await first.hub.close();

  const second = await startHubAt(dataDir);
  try {
    const restoredParent = second.hub.getTask(parent.id);
    assert.equal(restoredParent.plan.strategy, 'mixed');
    assert.equal(restoredParent.plan.groups[0].name, '准备');
    const restoredChildren = restoredParent.childTaskIds.map((id) => second.hub.getTask(id));
    assert.equal(restoredChildren[0].planStep, 1);
    assert.equal(restoredChildren[1].planStep, 2);
    assert.deepEqual(restoredChildren[1].planDependsOn, [0]);
    assert.equal(restoredChildren[1].planDependsOnTaskIds.length, 1);
  } finally {
    await second.hub.close();
  }
});
