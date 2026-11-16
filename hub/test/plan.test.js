'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { startTestHub, startHubAt, makeTempDir, request, makeManifest, registerDevice, adminHeaders } = require('./_helpers.js');

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
  // 单并发设备上两个子任务会串行排队，给 2 个槽位让它们同时派发，专注验证父任务编排。
  const device = await registerDevice(
    env,
    makeManifest({ skills: [{ id: 'office-docx', name: 'Word' }], limits: { maxConcurrentTasks: 2 } }),
  );
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
  // 规划器给 120s，兜底后不应低于 300s（否则网页检索类子任务必然超时）
  assert.ok(children.every((child) => child.timeoutSec >= 300), '规划子任务超时应兜底到 300s');

  for (const child of children) {
    env.hub.handleAck(env.hub.devices.get(device.deviceId), child.id);
    env.hub.handleResult(env.hub.devices.get(device.deviceId), child.id, { ok: true, output: { text: 'done' } });
  }
  const finishedParent = env.hub.getTask(parent.id);
  assert.equal(finishedParent.status, 'completed');
  assert.match(finishedParent.output.text, /2 个子任务/);
});

test('规划子任务超时兜底：新建与手动重试都不低于 300s', async (t) => {
  const env = await startTestHub(t, {
    planner: async () => ({
      title: '超时兜底',
      subtasks: [
        { instruction: '网页检索子任务', timeoutSec: 60 },
        { instruction: '生成报告子任务', timeoutSec: 90 },
      ],
    }),
  });
  const device = await registerDevice(env, makeManifest({ skills: [{ id: 'office-docx' }] }));
  const deviceObj = env.hub.devices.get(device.deviceId);
  const parent = await env.hub.createPlanTask({
    instruction: '长任务',
    requirements: { skills: ['office-docx'] },
    timeoutSec: 1800,
    split: true,
  });
  const first = env.hub.getTask(parent.childTaskIds[0]);
  assert.equal(first.timeoutSec, 300, '新建的规划子任务超时应兜底到 300s');

  env.hub.handleAck(deviceObj, first.id);
  env.hub.handleResult(deviceObj, first.id, { ok: false, error: '模拟失败' });
  assert.equal(env.hub.getTask(first.id).status, 'failed');

  // 模拟旧数据/手工改回过短超时，重试时应再次兜底
  env.hub.getTask(first.id).timeoutSec = 60;
  const retried = env.hub.retryTask(env.hub.getTask(first.id));
  assert.equal(retried.timeoutSec, 300, '重试规划子任务时应兜底到 300s');
});

test('旧数据恢复：规划子任务超时低于 300s 时自动兜底', async (t) => {
  const dataDir = await makeTempDir('butler-plan-migrate-');
  t.after(() => fsp.rm(dataDir, { recursive: true, force: true }));

  const first = await startHubAt(dataDir, {
    planner: async () => ({
      title: '旧数据',
      subtasks: [
        { instruction: '子任务一', timeoutSec: 60 },
        { instruction: '子任务二', timeoutSec: 90 },
      ],
    }),
  });
  await registerDevice(first, makeManifest({ skills: [{ id: 'office-docx' }] }));
  const parent = await first.hub.createPlanTask({
    instruction: '父任务',
    requirements: { skills: ['office-docx'] },
    timeoutSec: 1800,
    split: true,
  });
  await first.hub.close();

  // 模拟历史数据：把子任务超时改回旧值
  const stateFile = path.join(dataDir, 'state.json');
  const state = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
  for (const task of state.tasks) {
    if (task.parentTaskId) task.timeoutSec = 60;
  }
  await fsp.writeFile(stateFile, JSON.stringify(state));

  const second = await startHubAt(dataDir);
  try {
    const child = second.hub.getTask(parent.childTaskIds[0]);
    assert.equal(child.timeoutSec, 300, '旧数据恢复后应自动兜底到 300s');
  } finally {
    await second.hub.close();
  }
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

test('外部最终结果可追加到 Mika 任务', async (t) => {
  const env = await startTestHub(t);
  const task = await env.hub.createTask({ instruction: '外部任务', requirements: {}, timeoutSec: 60 });
  env.hub._finishTask(task, 'failed', { error: '旧连接失败', eventMessage: '旧失败' });
  const res = await request(env.base, 'POST', `/api/tasks/${task.id}/external-result`, {
    headers: adminHeaders(env),
    body: { text: '手机端最终答案', data: { mikaTaskId: 'mika-1' } },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.task.status, 'completed');
  assert.equal(res.json.task.output.text, '手机端最终答案');
  assert.equal(env.hub.getTask(task.id).error, null);
});

test('父任务失败后子任务全部成功会重新判定为 completed 并清除 error', async (t) => {
  const env = await startTestHub(t, {
    planner: async () => ({
      title: '重算测试',
      subtasks: [{ instruction: '子任务一', timeoutSec: 60 }, { instruction: '子任务二', timeoutSec: 60 }],
    }),
  });
  const device = await registerDevice(env, makeManifest({ skills: [{ id: 'office-docx' }] }));
  const deviceObj = env.hub.devices.get(device.deviceId);
  const parent = await env.hub.createPlanTask({
    instruction: '父任务',
    requirements: { skills: ['office-docx'] },
    timeoutSec: 120,
    split: true,
  });
  env.hub._finishTask(parent, 'failed', { error: 'hub restarted', eventMessage: 'stale' });
  const children = parent.childTaskIds.map((id) => env.hub.getTask(id));
  for (const child of children) {
    env.hub.handleAck(deviceObj, child.id);
    env.hub.handleResult(deviceObj, child.id, { ok: true, output: { text: 'ok' } });
  }
  const updated = env.hub.getTask(parent.id);
  assert.equal(updated.status, 'completed');
  assert.equal(updated.error, null);
  assert.equal(updated.progress.percent, 100);
});
