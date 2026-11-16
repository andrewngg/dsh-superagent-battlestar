'use strict';

/**
 * 计划子任务上下文贯通：
 * 子任务必须携带主任务 id / 主任务目标 / 计划步骤，避免子任务里的“这里/该项目”失去参照。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestHub, makeManifest, registerDevice } = require('./_helpers.js');

const OFFICE_SKILLS = [{ id: 'office-docx', name: 'Word 文档' }];

test('计划子任务：createTask 带主任务背景，run_task payload 携带 parentTaskId 与计划信息', async (t) => {
  const env = await startTestHub(t, {
    planner: async () => ({
      title: '打包计划',
      execution: { strategy: 'sequential', blockerPolicy: 'stop-and-ask', groups: [] },
      subtasks: [
        { instruction: '检查日志', timeoutSec: 300 },
        { instruction: '分析代码', timeoutSec: 300, dependsOn: [0] },
      ],
    }),
  });
  const device = await registerDevice(env, makeManifest({ limits: { maxConcurrentTasks: 1 }, skills: OFFICE_SKILLS }));
  const deviceObj = env.hub.devices.get(device.deviceId);
  const parent = await env.hub.createPlanTask({
    instruction: '把 C:\\work\\gui 项目做成任意目录可运行的 exe，并检查 run 日志',
    requirements: { skills: ['office-docx'] },
    timeoutSec: 1800,
    split: true,
  });

  const [first, second] = parent.childTaskIds.map((id) => env.hub.getTask(id));
  assert.equal(first.context.parentTaskId, parent.id);
  assert.match(first.context.parentInstruction, /任意目录可运行的 exe/);
  assert.equal(first.context.planStep, 1);
  assert.equal(first.context.planTotal, 2);
  assert.equal(first.context.planTitle, '打包计划');
  assert.equal(second.context.planStep, 2);

  const command = env.hub._buildRunCommand(first, deviceObj);
  assert.equal(command.payload.parentTaskId, parent.id, 'payload 必须带主任务 id');
  assert.equal(command.payload.context.taskId, first.id, '设备端需要知道当前任务 id');
  assert.equal(command.payload.context.parentTaskId, parent.id);
  assert.equal(command.payload.context.parentInstruction, first.context.parentInstruction);
  assert.equal(command.payload.context.planStep, 1);
  assert.equal(command.payload.context.planTotal, 2);
  assert.equal(command.payload.context.planTitle, '打包计划');
  assert.ok(Array.isArray(command.payload.context.planSiblings));
  assert.equal(command.payload.context.planSiblings.length, 2);
  assert.deepEqual(
    command.payload.context.planSiblings.map((item) => item.step),
    [1, 2],
  );
  assert.match(command.payload.context.planSiblings[0].instruction, /检查日志/);
});

test('普通任务：run_task payload 仍带 taskId，但不带主任务字段', async (t) => {
  const env = await startTestHub(t);
  const device = await registerDevice(env, makeManifest({ limits: { maxConcurrentTasks: 1 } }));
  const deviceObj = env.hub.devices.get(device.deviceId);
  const task = await env.hub.createTask({ instruction: '普通任务' });

  const command = env.hub._buildRunCommand(task, deviceObj);
  assert.equal(command.payload.parentTaskId, null);
  assert.equal(command.payload.context.taskId, task.id);
  assert.equal(command.payload.context.parentTaskId, undefined);
  assert.equal(command.payload.context.parentInstruction, undefined);
  assert.equal(command.payload.context.planSiblings, undefined);
});
