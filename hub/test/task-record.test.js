'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  startTestHub,
  registerDevice,
  makeManifest,
  createTask,
  ackTask,
  progressTask,
  resultTask,
  waitFor,
} = require('./_helpers.js');
const { buildTaskRecordMarkdown, buildIndexMarkdown } = require('../lib/task-record.js');
const { exportRecords } = require('../../scripts/export-task-records.js');

function makeTask(overrides = {}) {
  return {
    id: 'task_demo1',
    instruction: '演示任务：抓取网页并生成报告',
    requirements: { model: 'deepseek-chat', skills: [], tags: [], deviceId: 'dev_a' },
    priority: 5,
    status: 'running',
    assignedDeviceId: 'dev_a',
    assignedDeviceName: '测试设备',
    createdAt: '2026-11-08T01:00:00.000Z',
    updatedAt: '2026-11-08T01:02:00.000Z',
    startedAt: '2026-11-08T01:00:02.000Z',
    finishedAt: null,
    attempts: 1,
    maxAttempts: 2,
    timeoutSec: 300,
    autoRetry: true,
    output: null,
    error: null,
    progress: { message: '正在抓取…', percent: 40, waiting: false, at: '2026-11-08T01:01:00.000Z' },
    parentTaskId: null,
    childTaskIds: ['task_child1'],
    threadId: 'thread_x',
    threadStep: 1,
    context: null,
    attachments: [],
    isPlan: false,
    archived: false,
    route: {
      reason: 'matched 1 candidate; picked dev_a (score 100)',
      candidates: [{ deviceId: 'dev_a', score: 100, matched: ['model:deepseek-chat'] }],
      excluded: [],
    },
    events: [
      { at: '2026-11-08T01:00:00.000Z', type: 'created', message: '任务已创建' },
      { at: '2026-11-08T01:00:02.000Z', type: 'ack', message: '设备已确认任务' },
      { at: '2026-11-08T01:01:00.000Z', type: 'progress', message: '正在抓取…' },
      { at: '2026-11-08T01:02:00.000Z', type: 'completed', message: '任务完成' },
    ],
    ...overrides,
  };
}

test('buildTaskRecordMarkdown：包含指令、事件时间线、耗时、路由与相关日志', () => {
  const task = makeTask({ output: { text: '报告已生成', data: { backend: 'hermes', exitCode: 0 } } });
  const md = buildTaskRecordMarkdown(task, {
    allTasks: [task],
    hubEvents: [{ at: '2026-11-08T01:00:00.000Z', type: 'log', message: '任务创建：task_demo1' }],
  });
  assert.match(md, /任务执行记录 · task_demo1/);
  assert.match(md, /演示任务：抓取网页并生成报告/);
  assert.match(md, /事件时间线（共 4 条）/);
  assert.match(md, /任务完成/);
  assert.match(md, /报告已生成/);
  assert.match(md, /backend/);
  assert.match(md, /路由决策/);
  assert.match(md, /任务创建：task_demo1/);
  assert.match(md, /关键耗时/);
});

test('buildTaskRecordMarkdown：计划父任务列出子任务并带记录链接', () => {
  const parent = makeTask({
    id: 'task_parent',
    isPlan: true,
    childTaskIds: ['task_c1', 'task_c2'],
    output: null,
    progress: { message: '子任务 1/2 已完成', percent: 50, at: '2026-11-08T01:02:00.000Z' },
  });
  const child1 = makeTask({ id: 'task_c1', parentTaskId: 'task_parent', status: 'completed', output: { text: 'ok' } });
  const child2 = makeTask({ id: 'task_c2', parentTaskId: 'task_parent', status: 'failed', error: 'Hermes CLI 退出码 1' });
  const md = buildTaskRecordMarkdown(parent, { allTasks: [parent, child1, child2] });
  assert.match(md, /子任务（2）/);
  assert.match(md, /\[task_c1\]\(task_c1\.md\)/);
  assert.match(md, /Hermes CLI 退出码 1/);

  const index = buildIndexMarkdown([parent, child2, child1]);
  assert.match(index, /任务执行记录索引/);
  assert.match(index, /task_parent/);
  assert.match(index, /失败（失败）|failed（失败）/);
});

test('Hub 自动为任务写 Markdown 记录与索引', async (t) => {
  const env = await startTestHub(t);
  const device = await registerDevice(env, makeManifest());
  const task = await createTask(env, {
    instruction: '记录测试任务',
    requirements: { deviceId: device.deviceId },
  });
  await ackTask(env, device, task.id);
  await progressTask(env, device, task.id, { message: '执行中…', percent: 50 });
  await resultTask(env, device, task.id, { ok: true, output: { text: '记录测试完成' } });

  const day = String(task.createdAt).slice(0, 10);
  const file = path.join(env.hub.recordDir, day, `${task.id}.md`);
  await waitFor(() => fs.existsSync(file), { label: '任务记录 md 写入', timeout: 5000 });
  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /记录测试任务/);
  assert.match(content, /记录测试完成/);
  assert.match(content, /completed/);
  assert.match(content, /执行中…/);

  const indexFile = path.join(env.hub.recordDir, 'index.md');
  await waitFor(() => fs.existsSync(indexFile), { label: '任务记录索引写入', timeout: 5000 });
  const index = fs.readFileSync(indexFile, 'utf8');
  assert.match(index, new RegExp(task.id));
  assert.match(index, /completed/);
});

test('计划父任务完成后自动补齐父/子记录', async (t) => {
  const env = await startTestHub(t, {
    planner: async () => ({
      title: '记录测试拆分',
      subtasks: [
        { instruction: '子任务一', timeoutSec: 60 },
        { instruction: '子任务二', timeoutSec: 60 },
      ],
    }),
  });
  const device = await registerDevice(env, makeManifest());
  const deviceObj = env.hub.devices.get(device.deviceId);
  const parent = await env.hub.createPlanTask({
    instruction: '记录测试长任务',
    requirements: { deviceId: device.deviceId },
    timeoutSec: 600,
    split: true,
  });
  for (const childId of parent.childTaskIds) {
    env.hub.handleAck(deviceObj, childId);
    env.hub.handleResult(deviceObj, childId, { ok: true, output: { text: 'done' } });
  }
  const day = String(parent.createdAt).slice(0, 10);
  const parentFile = path.join(env.hub.recordDir, day, `${parent.id}.md`);
  await waitFor(() => fs.existsSync(parentFile), { label: '父任务记录写入', timeout: 5000 });
  const content = fs.readFileSync(parentFile, 'utf8');
  assert.match(content, /子任务（2）/);
  assert.match(content, /全部子任务结束/);
  for (const childId of parent.childTaskIds) {
    assert.ok(fs.existsSync(path.join(env.hub.recordDir, day, `${childId}.md`)));
  }
});

test('export-task-records.js：可从 state.json 离线导出所有任务', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-records-'));
  try {
    const dataDir = path.join(dir, 'data');
    const outDir = path.join(dir, 'out');
    fs.mkdirSync(dataDir, { recursive: true });
    const task = makeTask({
      status: 'completed',
      output: { text: 'done' },
      finishedAt: '2026-11-08T01:02:00.000Z',
    });
    fs.writeFileSync(
      path.join(dataDir, 'state.json'),
      JSON.stringify({ tasks: [task], events: [] }),
      'utf8',
    );
    const result = exportRecords({ dataDir, outDir });
    assert.equal(result.written, 1);
    assert.ok(fs.existsSync(path.join(outDir, '2026-11-08', 'task_demo1.md')));
    assert.ok(fs.existsSync(path.join(outDir, 'index.md')));

    const single = exportRecords({ dataDir, outDir, taskId: 'task_demo1' });
    assert.equal(single.written, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
