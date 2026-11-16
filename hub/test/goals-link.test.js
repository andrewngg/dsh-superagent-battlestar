'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startTestHub,
  request,
  adminHeaders,
  makeManifest,
  registerDevice,
  ackTask,
  resultTask,
  createTask,
  waitFor,
} = require('./_helpers.js');

// ---------------------------------------------------------------- 工具函数

async function createGoal(env, body) {
  const res = await request(env.base, 'POST', '/api/goals', {
    headers: adminHeaders(env),
    body,
  });
  assert.equal(res.status, 200, res.text);
  return res.json.goal;
}

/** 通过 HTTP 关联任务到目标。 */
async function linkGoalTask(env, goalId, taskId) {
  return request(env.base, 'POST', `/api/goals/${goalId}/link`, {
    headers: adminHeaders(env),
    body: { taskId },
  });
}

async function getGoalDetail(env, goalId) {
  return request(env.base, 'GET', `/api/goals/${goalId}`, { headers: adminHeaders(env) });
}

/** 创建执行中（running）的任务：设备注册 -> 建任务 -> ack。 */
async function createRunningTask(env, device, instruction) {
  const task = await createTask(env, { instruction: instruction || '执行中的任务' });
  await ackTask(env, device, task.id);
  await waitFor(() => env.hub.getTask(task.id).status === 'running', { label: '任务进入 running' });
  return env.hub.getTask(task.id);
}

/** 完成一个任务：必要时 ack，然后返回成功结果。 */
async function completeTask(env, device, task) {
  let current = env.hub.getTask(task.id);
  if (current.status === 'queued') {
    await waitFor(() => env.hub.getTask(task.id).status === 'assigned', { label: '任务重新派发' });
    current = env.hub.getTask(task.id);
  }
  if (current.status === 'assigned') {
    await ackTask(env, device, task.id);
  }
  await resultTask(env, device, task.id, { ok: true, output: { text: '任务完成结果' } });
  await waitFor(() => env.hub.getTask(task.id).status === 'completed', { label: '任务完成' });
  return env.hub.getTask(task.id);
}

/** 使用注入的 planner 创建一个两步计划任务（父任务 RUNNING）。 */
async function createPlanTask(env, body) {
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

// ---------------------------------------------------------------- 关联 / 取消关联

test('关联执行中任务：写入 goal.runningTaskId 与 task.goalId，并出现在列表与统计中', async (t) => {
  const env = await startTestHub(t);
  const goal = await createGoal(env, { title: '求职目标' });
  const device = await registerDevice(env, makeManifest({ name: '关联设备' }));
  const task = await createRunningTask(env, device, '投递简历');

  const res = await linkGoalTask(env, goal.id, task.id);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.task.goalId, goal.id);
  assert.equal(res.json.goal.runningTaskId, task.id);
  assert.ok(res.json.goal.taskIds.includes(task.id));

  const detail = await getGoalDetail(env, goal.id);
  assert.equal(detail.status, 200, detail.text);
  assert.deepEqual(Object.keys(detail.json).sort(), ['goal', 'hubTime', 'linkedStats', 'tasks']);
  assert.equal(typeof detail.json.hubTime, 'string');
  assert.equal(detail.json.tasks.length, 1);
  assert.equal(detail.json.tasks[0].id, task.id);
  assert.equal(detail.json.tasks[0].goalId, goal.id);
  assert.equal(detail.json.tasks[0].instruction, '投递简历');
  assert.equal(detail.json.linkedStats.total, 1);
  assert.equal(detail.json.linkedStats.running, 1);
  assert.equal(detail.json.linkedStats.completed, 0);

  // 直接方法也可读
  assert.equal(env.hub.listGoalTasks(goal.id).length, 1);
  assert.equal(env.hub.goalLinkedStats(goal.id).running, 1);
});

test('取消关联：清除 task.goalId、goal.taskIds 与 runningTaskId', async (t) => {
  const env = await startTestHub(t);
  const goal = await createGoal(env, { title: '求职目标' });
  const device = await registerDevice(env, makeManifest({ name: '取消关联设备' }));
  const task = await createRunningTask(env, device, '投递简历');
  await linkGoalTask(env, goal.id, task.id);

  const res = await request(env.base, 'POST', `/api/goals/${goal.id}/unlink`, {
    headers: adminHeaders(env),
    body: { taskId: task.id },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.goal.runningTaskId, null);
  assert.deepEqual(res.json.goal.taskIds, []);
  assert.deepEqual(res.json.tasks, []);
  assert.equal(res.json.linkedStats.total, 0);
  assert.equal(env.hub.getTask(task.id).goalId, null);

  const detail = await getGoalDetail(env, goal.id);
  assert.equal(detail.json.tasks.length, 0);
});

test('关联计划父任务：子任务 context.goalId 同步写入（不写 child.goalId）', async (t) => {
  const env = await startTestHub(t, { planner: planPlanner() });
  const goal = await createGoal(env, { title: '整理资料目标' });
  const plan = await createPlanTask(env, { instruction: '整理一份资料' });
  assert.equal(plan.isPlan, true);
  assert.equal(plan.childTaskIds.length, 2);
  const childIds = plan.childTaskIds.slice();

  const res = await linkGoalTask(env, goal.id, plan.id);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.goal.runningTaskId, plan.id);

  for (const childId of childIds) {
    const child = env.hub.getTask(childId);
    assert.equal(child.context.goalId, goal.id);
    assert.equal(child.goalId, null);
  }

  // 列表里只有父任务，并带 childProgress（无设备时子任务处于排队）。
  const tasks = env.hub.listGoalTasks(goal.id);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, plan.id);
  assert.equal(tasks[0].isPlan, true);
  assert.deepEqual(tasks[0].childProgress, {
    total: 2,
    completed: 0,
    failed: 0,
    running: 0,
    waiting: 0,
  });

  // 取消关联后子任务 context.goalId 清空。
  await request(env.base, 'POST', `/api/goals/${goal.id}/unlink`, {
    headers: adminHeaders(env),
    body: { taskId: plan.id },
  });
  for (const childId of childIds) {
    const child = env.hub.getTask(childId);
    assert.equal(child.context && child.context.goalId, undefined);
    assert.equal(child.goalId, null);
  }
});

test('计划任务带 goalId 创建时，父任务与子任务自动继承目标', async (t) => {
  const env = await startTestHub(t, { planner: planPlanner() });
  const goal = await createGoal(env, { title: '写周报目标' });
  const plan = await createPlanTask(env, { instruction: '写一份周报', goalId: goal.id });
  assert.equal(plan.goalId, goal.id);
  assert.equal(env.hub.getGoal(goal.id).runningTaskId, plan.id);
  for (const childId of plan.childTaskIds) {
    assert.equal(env.hub.getTask(childId).context.goalId, goal.id);
  }

  // 普通任务带 goalId 创建时也会自动登记到目标。
  const plain = await createTask(env, { instruction: '普通任务', goalId: goal.id });
  assert.equal(plain.goalId, goal.id);
  assert.ok(env.hub.getGoal(goal.id).taskIds.includes(plain.id));
});

test('createFollowUp 继承源任务 goalId 并登记到目标', async (t) => {
  const env = await startTestHub(t);
  const goal = await createGoal(env, { title: '跟进目标' });
  const device = await registerDevice(env, makeManifest({ name: '跟进设备' }));
  const task = await createRunningTask(env, device, '第一版方案');
  await linkGoalTask(env, goal.id, task.id);
  const completed = await completeTask(env, device, task);

  const res = await request(env.base, 'POST', `/api/tasks/${completed.id}/follow-up`, {
    headers: adminHeaders(env),
    body: { instruction: '基于结果继续优化' },
  });
  assert.equal(res.status, 200, res.text);
  const followUp = res.json.task;
  assert.notEqual(followUp.id, completed.id);
  assert.equal(followUp.goalId, goal.id);
  assert.equal(followUp.context.sourceTaskId, completed.id);
  assert.ok(env.hub.getGoal(goal.id).taskIds.includes(followUp.id));

  // 通过 HTTP 读取任务，确认 goalId 一致。
  const got = await request(env.base, 'GET', `/api/tasks/${followUp.id}`, { headers: adminHeaders(env) });
  assert.equal(got.status, 200);
  assert.equal(got.json.task.goalId, goal.id);
});

// ---------------------------------------------------------------- 目标回写

test('任务完成/失败回写目标：checks 按 taskId 去重，重试成功后更新为 completed', async (t) => {
  const env = await startTestHub(t);
  const goal = await createGoal(env, { title: '回写目标' });
  const device = await registerDevice(env, makeManifest({ name: '回写设备' }));
  const task = await createTask(env, { instruction: '会先失败再成功' });
  await linkGoalTask(env, goal.id, task.id);
  assert.equal(env.hub.getGoal(goal.id).runningTaskId, task.id);

  // 第一次执行失败 -> 写入 failed check。
  await ackTask(env, device, task.id);
  await resultTask(env, device, task.id, { ok: false, error: '第一次执行失败' });
  await waitFor(() => env.hub.getTask(task.id).status === 'failed', { label: '任务失败' });
  let saved = env.hub.getGoal(goal.id);
  assert.equal(saved.checks.length, 1);
  assert.equal(saved.checks[0].taskId, task.id);
  assert.equal(saved.checks[0].status, 'failed');
  assert.equal(saved.checks[0].error, '第一次执行失败');
  assert.equal(saved.lastCheckStatus, 'failed');
  assert.equal(saved.lastTaskId, task.id);

  // 重试并成功 -> 同一个 taskId 的 check 被更新而不是追加。
  env.hub.retryTask(env.hub.getTask(task.id));
  await waitFor(() => env.hub.getTask(task.id).status === 'assigned', { label: '重试后派发' });
  await ackTask(env, device, task.id);
  await resultTask(env, device, task.id, { ok: true, output: { text: '第二次执行成功' } });
  await waitFor(() => env.hub.getTask(task.id).status === 'completed', { label: '重试成功' });

  saved = env.hub.getGoal(goal.id);
  assert.equal(saved.checks.length, 1, '同一 taskId 不应重复写入 check');
  assert.equal(saved.checks[0].taskId, task.id);
  assert.equal(saved.checks[0].status, 'completed');
  assert.equal(saved.checks[0].summary, '第二次执行成功');
  assert.equal(saved.lastCheckStatus, 'completed');
  assert.equal(saved.runningTaskId, null);
});

test('计划父任务无输出结束：_goalTaskFinished 写入合成计划摘要', async (t) => {
  const env = await startTestHub(t, { planner: planPlanner() });
  const goal = await createGoal(env, { title: '计划摘要目标' });
  const plan = await createPlanTask(env, { instruction: '整理一份资料', goalId: goal.id });
  assert.equal(plan.isPlan, true);
  assert.equal(plan.childTaskIds.length, 2);

  // 模拟父任务在无输出情况下结束（正常 reconcile 会先写入 output.text，这里直接走 _finishTask）。
  env.hub._finishTask(env.hub.getTask(plan.id), 'failed', { output: null, error: null });

  const saved = env.hub.getGoal(goal.id);
  assert.equal(saved.checks.length, 1);
  assert.equal(saved.checks[0].taskId, plan.id);
  assert.match(saved.checks[0].summary, /计划「整理一份资料」共 2 步：完成 0，失败 0/);
  assert.equal(saved.lastSummary, saved.checks[0].summary);
  assert.equal(saved.runningTaskId, null);
});

// ---------------------------------------------------------------- HTTP 校验

test('目标关联 HTTP 校验：未知目标 404、缺少 taskId 400、未知任务 404', async (t) => {
  const env = await startTestHub(t);
  const goal = await createGoal(env, { title: '校验目标' });

  const missingGoal = await getGoalDetail(env, 'goal_does_not_exist');
  assert.equal(missingGoal.status, 404);

  const unlinkWithoutTask = await request(env.base, 'POST', `/api/goals/${goal.id}/unlink`, {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(unlinkWithoutTask.status, 400);
  assert.match(unlinkWithoutTask.json.error.message, /taskId/);

  const linkWithoutTask = await request(env.base, 'POST', `/api/goals/${goal.id}/link`, {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(linkWithoutTask.status, 400);
  assert.match(linkWithoutTask.json.error.message, /taskId/);

  const linkUnknownTask = await linkGoalTask(env, goal.id, 'task_does_not_exist');
  assert.equal(linkUnknownTask.status, 404);

  const unauthorized = await linkGoalTask(
    { base: env.base, adminToken: 'invalid-token' },
    goal.id,
    'task_x',
  );
  assert.equal(unauthorized.status, 401);
});
