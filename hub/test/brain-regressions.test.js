'use strict';

// 回归测试：对应 verifier 报告、由 Lead 修复的三个产品缺陷。
//   1. brainToJson(decisions <= 0) 因 slice(-0) 返回全部决策。
//   2. BRAIN_TIMEOUT_MS 来自环境变量（字符串）时被 clampInt 丢弃。
//   3. 计划父任务正常完成时 _reconcileParent 未回写长期目标。

const test = require('node:test');
const assert = require('node:assert/strict');

const { brainToJson, brainModelConfig, DEFAULT_BRAIN } = require('../lib/brain.js');
const {
  startTestHub,
  request,
  adminHeaders,
  makeManifest,
  registerDevice,
  ackTask,
  resultTask,
  waitFor,
} = require('./_helpers.js');

function createGoal(env, body) {
  return request(env.base, 'POST', '/api/goals', { headers: adminHeaders(env), body }).then((res) => {
    assert.equal(res.status, 200, res.text);
    return res.json.goal;
  });
}

async function createPlan(env, body) {
  const res = await request(env.base, 'POST', '/api/tasks', {
    headers: adminHeaders(env),
    body: { split: true, ...body },
  });
  assert.equal(res.status, 200, res.text);
  return res.json.task;
}

function planPlanner() {
  return async () => ({
    title: '两步计划',
    subtasks: [{ instruction: '第一步：收集资料' }, { instruction: '第二步：整理汇总' }],
  });
}

async function completeChild(env, device, childId) {
  await waitFor(() => env.hub.getTask(childId).status === 'assigned', { label: '子任务已派发' });
  await ackTask(env, device, childId);
  await resultTask(env, device, childId, { ok: true, output: { text: '子任务完成' } });
  await waitFor(() => env.hub.getTask(childId).status === 'completed', { label: '子任务完成' });
}

// ---------------------------------------------------------------- 缺陷 1

test('brainToJson：decisions<=0 返回空列表，不再受 slice(-0) 影响', () => {
  const brain = {
    ...DEFAULT_BRAIN,
    decisions: [{ id: 'brain_a' }, { id: 'brain_b' }, { id: 'brain_c' }],
  };

  assert.deepEqual(brainToJson(brain, { decisions: 0 }).decisions, []);
  assert.deepEqual(brainToJson(brain, { decisions: -3 }).decisions, []);
  assert.deepEqual(
    brainToJson(brain, { decisions: 2 }).decisions.map((item) => item.id),
    ['brain_b', 'brain_c'],
  );
});

// ---------------------------------------------------------------- 缺陷 2

test('brainModelConfig：字符串形式的 BRAIN_TIMEOUT_MS 会被采纳并按边界裁剪', () => {
  const previous = process.env.BRAIN_TIMEOUT_MS;
  try {
    delete process.env.BRAIN_TIMEOUT_MS;
    assert.equal(brainModelConfig({}).timeoutMs, 60000);

    process.env.BRAIN_TIMEOUT_MS = '90000';
    assert.equal(brainModelConfig({}).timeoutMs, 90000);

    process.env.BRAIN_TIMEOUT_MS = ' 123456 ';
    assert.equal(brainModelConfig({}).timeoutMs, 123456);

    process.env.BRAIN_TIMEOUT_MS = '1';
    assert.equal(brainModelConfig({}).timeoutMs, 5000);

    process.env.BRAIN_TIMEOUT_MS = '999999999';
    assert.equal(brainModelConfig({}).timeoutMs, 300000);

    process.env.BRAIN_TIMEOUT_MS = '';
    assert.equal(brainModelConfig({}).timeoutMs, 60000);

    process.env.BRAIN_TIMEOUT_MS = 'not-a-number';
    assert.equal(brainModelConfig({}).timeoutMs, 60000);
  } finally {
    if (previous === undefined) delete process.env.BRAIN_TIMEOUT_MS;
    else process.env.BRAIN_TIMEOUT_MS = previous;
  }
});

// ---------------------------------------------------------------- 缺陷 3

test('计划父任务正常完成：_reconcileParent 回写目标检查历史并清除 runningTaskId', async (t) => {
  const env = await startTestHub(t, { planner: planPlanner() });
  const goal = await createGoal(env, { title: '计划回写目标' });
  const device = await registerDevice(env, makeManifest({ name: '计划设备' }));
  const plan = await createPlan(env, { instruction: '整理一份资料', goalId: goal.id });

  assert.equal(plan.isPlan, true);
  assert.equal(plan.childTaskIds.length, 2);
  assert.equal(env.hub.getGoal(goal.id).runningTaskId, plan.id);

  for (const childId of plan.childTaskIds.slice()) {
    await completeChild(env, device, childId);
  }
  await waitFor(() => env.hub.getTask(plan.id).status === 'completed', { label: '父任务完成' });

  const saved = env.hub.getGoal(goal.id);
  assert.equal(saved.checks.length, 1, '计划完成应写入一条检查历史');
  assert.equal(saved.checks[0].taskId, plan.id);
  assert.equal(saved.checks[0].status, 'completed');
  assert.match(saved.checks[0].summary, /子任务已结束/);
  assert.equal(saved.lastSummary, saved.checks[0].summary);
  assert.equal(saved.lastCheckStatus, 'completed');
  assert.equal(saved.runningTaskId, null, '完成后不应残留 runningTaskId');
});
