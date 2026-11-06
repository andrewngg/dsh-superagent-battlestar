'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestHub, request, makeManifest, registerDevice, adminHeaders } = require('./_helpers.js');

test('长任务拆分：父任务包含子任务，子任务全部完成后父任务完成', async (t) => {
  const env = await startTestHub(t, {
    planner: async () => ({
      title: '测试拆分',
      subtasks: [
        { instruction: '子任务一', timeoutSec: 120 },
        { instruction: '子任务二', timeoutSec: 120 },
      ],
    }),
  });
  const device = await registerDevice(env, makeManifest({ skills: [{ id: 'office-docx', name: 'Word' }] }));
  const res = await request(env.base, 'POST', '/api/tasks', {
    headers: adminHeaders(env),
    body: {
      instruction: '这是一个需要拆分的长任务',
      requirements: { skills: ['office-docx'] },
      timeoutSec: 600,
      split: true,
    },
  });
  assert.equal(res.status, 200);
  const parent = res.json.task;
  assert.equal(parent.isPlan, true);
  assert.equal(parent.childTaskIds.length, 2);
  assert.equal(parent.status, 'running');

  const children = parent.childTaskIds.map((id) => env.hub.getTask(id));
  assert.ok(children.every((child) => child && child.parentTaskId === parent.id));
  assert.ok(children.every((child) => child.assignedDeviceId === device.deviceId));

  for (const child of children) {
    env.hub.handleAck(env.hub.devices.get(device.deviceId), child.id);
    env.hub.handleResult(env.hub.devices.get(device.deviceId), child.id, { ok: true, output: { text: 'done' } });
  }
  const finishedParent = env.hub.getTask(parent.id);
  assert.equal(finishedParent.status, 'completed');
  assert.match(finishedParent.output.text, /2 个子任务/);
});

test('任务归档与删除 API', async (t) => {
  const env = await startTestHub(t);
  const task = await env.hub.createTask({ instruction: '普通任务', requirements: { skills: [] }, timeoutSec: 60 });  const archived = await request(env.base, 'POST', `/api/tasks/${task.id}/archive`, {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(archived.status, 200);
  assert.equal(archived.json.task.archived, true);
  const list = await request(env.base, 'GET', '/api/tasks', { headers: adminHeaders(env) });
  assert.ok(!list.json.tasks.some((item) => item.id === task.id));
  const all = await request(env.base, 'GET', '/api/tasks?includeArchived=1', { headers: adminHeaders(env) });
  assert.ok(all.json.tasks.some((item) => item.id === task.id));

  const deleted = await request(env.base, 'DELETE', `/api/tasks/${task.id}`, { headers: adminHeaders(env) });
  assert.equal(deleted.status, 200);
  assert.equal(env.hub.getTask(task.id), null);
});

test('任务线程：follow-up 继承上下文并可级联归档/删除', async (t) => {
  const env = await startTestHub(t);
  const device = await registerDevice(env, makeManifest({ skills: [{ id: 'office-docx', name: 'Word' }] }));
  const deviceObj = env.hub.devices.get(device.deviceId);
  const source = env.hub.createTask({ instruction: '第一步', requirements: { skills: ['office-docx'] }, timeoutSec: 60 });
  env.hub.handleAck(deviceObj, source.id);
  env.hub.handleResult(deviceObj, source.id, { ok: true, output: { text: '第一步输出' } });
  assert.equal(source.status, 'completed');

  const res = await request(env.base, 'POST', `/api/tasks/${source.id}/follow-up`, {
    headers: adminHeaders(env),
    body: { instruction: '基于上一步继续' },
  });
  assert.equal(res.status, 200);
  const follow = res.json.task;
  assert.equal(follow.threadId, source.id);
  assert.equal(follow.replyToTaskId, source.id);
  assert.equal(follow.threadStep, 2);
  assert.equal(follow.context.previousInstruction, '第一步');
  assert.equal(follow.context.previousOutput, '第一步输出');

  env.hub.archiveTask(source, true);
  assert.equal(env.hub.getTask(source.id).archived, true);
  assert.equal(env.hub.getTask(follow.id).archived, true);
  env.hub.deleteTask(source);
  assert.equal(env.hub.getTask(source.id), null);
  assert.equal(env.hub.getTask(follow.id), null);
});

test('任务附件：元数据与设备命令回传', async (t) => {
  const env = await startTestHub(t);
  const device = await registerDevice(env, makeManifest({ skills: [{ id: 'office-docx', name: 'Word' }] }));
  const data = Buffer.from('hello attachment').toString('base64');
  const res = await request(env.base, 'POST', '/api/tasks', {
    headers: adminHeaders(env),
    body: {
      instruction: '读取附件',
      requirements: { deviceId: device.deviceId },
      timeoutSec: 60,
      attachments: [{ name: 'a.txt', type: 'text/plain', data }],
    },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.task.attachments.map((file) => file.name), ['a.txt']);
  assert.equal(res.json.task.attachments[0].data, undefined);
  const command = env.hub.devices.get(device.deviceId).commands.find((item) => item.taskId === res.json.task.id);
  assert.equal(command.payload.attachments[0].name, 'a.txt');
  assert.equal(command.payload.attachments[0].data, data);
  await request(env.base, 'DELETE', `/api/tasks/${res.json.task.id}`, { headers: adminHeaders(env) });
});

test('Mika 等待回答：waiting 状态与 answer 命令', async (t) => {
  const env = await startTestHub(t);
  const device = await registerDevice(env, makeManifest({ skills: [{ id: 'phone-control', name: '手机操控' }] }));
  const deviceObj = env.hub.devices.get(device.deviceId);
  const task = env.hub.createTask({ instruction: '手机上执行任务', requirements: { skills: ['phone-control'] }, timeoutSec: 60 });
  env.hub.handleAck(deviceObj, task.id);
  env.hub.handleProgress(deviceObj, task.id, {
    message: '等待回答',
    waiting: true,
    question: '请回答问题',
    mikaTaskId: 'mika-task-1',
  });
  assert.equal(env.hub.getTask(task.id).status, 'waiting');
  assert.equal(env.hub.getTask(task.id).progress.question, '请回答问题');
  const answer = await request(env.base, 'POST', `/api/tasks/${task.id}/answer`, {
    headers: adminHeaders(env),
    body: { text: '我的回答' },
  });
  assert.equal(answer.status, 200);
  const command = env.hub.devices.get(device.deviceId).commands.find((item) => item.type === 'answer_task');
  assert.equal(command.payload.text, '我的回答');
  env.hub.handleProgress(deviceObj, task.id, { message: '回答已收到', waiting: false });
  assert.equal(env.hub.getTask(task.id).status, 'running');
  env.hub.handleResult(deviceObj, task.id, { ok: true, output: { text: '完成' } });
  assert.equal(env.hub.getTask(task.id).status, 'completed');
});
