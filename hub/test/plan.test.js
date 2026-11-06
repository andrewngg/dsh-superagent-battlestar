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
  const task = await env.hub.createTask({ instruction: '普通任务', requirements: { skills: [] }, timeoutSec: 60 });
  const archived = await request(env.base, 'POST', `/api/tasks/${task.id}/archive`, {
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
