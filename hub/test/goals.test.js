'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  startTestHub,
  startHubAt,
  makeTempDir,
  request,
  makeManifest,
  registerDevice,
  ackTask,
  resultTask,
  adminHeaders,
  waitFor,
} = require('./_helpers.js');
const {
  normalizeSchedule,
  computeNextCheckAt,
  normalizeGoalRequest,
  buildGoalCheckInstruction,
} = require('../lib/goals.js');

async function createGoal(env, body) {
  const res = await request(env.base, 'POST', '/api/goals', { headers: adminHeaders(env), body });
  assert.equal(res.status, 200, res.text);
  return res.json.goal;
}

async function getGoal(env, goalId) {
  const res = await request(env.base, 'GET', `/api/goals/${goalId}`, { headers: adminHeaders(env) });
  assert.equal(res.status, 200, res.text);
  return res.json.goal;
}

test('目标计划纯函数：daily/interval 归一化与下一次时间计算', () => {
  assert.deepEqual(normalizeSchedule(undefined), { type: 'daily', time: '09:00' });
  assert.deepEqual(normalizeSchedule({ type: 'daily', time: '7:05' }), { type: 'daily', time: '07:05' });
  assert.deepEqual(normalizeSchedule({ type: 'interval', minutes: 1 }), { type: 'interval', minutes: 5 });
  assert.deepEqual(normalizeSchedule({ type: 'interval', minutes: 999999 }), {
    type: 'interval',
    minutes: 10080,
  });
  // 编辑时未给的字段回退到旧计划
  assert.deepEqual(normalizeSchedule({ time: '22:15' }, { type: 'daily', time: '08:00' }), {
    type: 'daily',
    time: '22:15',
  });
  assert.deepEqual(normalizeSchedule({ type: 'interval', minutes: 120 }, { type: 'daily', time: '08:00' }), {
    type: 'interval',
    minutes: 120,
  });

  const noon = new Date(2026, 0, 5, 12, 0, 0, 0);
  const nextMorning = new Date(computeNextCheckAt({ type: 'daily', time: '09:00' }, noon.getTime()));
  assert.equal(nextMorning.getDate(), 6);
  assert.equal(nextMorning.getHours(), 9);
  const laterToday = new Date(computeNextCheckAt({ type: 'daily', time: '18:30' }, noon.getTime()));
  assert.equal(laterToday.getDate(), 5);
  assert.equal(laterToday.getHours(), 18);
  assert.equal(laterToday.getMinutes(), 30);

  const intervalNext = computeNextCheckAt({ type: 'interval', minutes: 90 }, noon.getTime());
  assert.equal(Date.parse(intervalNext) - noon.getTime(), 90 * 60 * 1000);

  const invalid = normalizeGoalRequest({ title: '   ' });
  assert.equal(invalid.ok, false);
  const valid = normalizeGoalRequest({
    title: '找一份远程工作',
    description: '每周复盘投递进展',
    schedule: { type: 'daily', time: '21:00' },
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.value.title, '找一份远程工作');

  const instruction = buildGoalCheckInstruction({
    title: '找一份远程工作',
    description: '每周复盘投递进展',
    schedule: { type: 'daily', time: '21:00' },
    checks: [],
  });
  assert.match(instruction, /长期目标跟进/);
  assert.match(instruction, /找一份远程工作/);
  assert.match(instruction, /下一步建议/);
});

test('长期目标 API：创建/列表/暂停恢复/编辑/删除/鉴权', async (t) => {
  const env = await startTestHub(t);

  const empty = await request(env.base, 'GET', '/api/goals', { headers: adminHeaders(env) });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json.goals, []);

  const unauthorized = await request(env.base, 'GET', '/api/goals', {});
  assert.equal(unauthorized.status, 401);

  const goal = await createGoal(env, {
    title: '持续跟进求职进展',
    description: '每周整理投递与面试结果，给出下一步建议',
    schedule: { type: 'daily', time: '09:30' },
  });
  assert.match(goal.id, /^goal_/);
  assert.equal(goal.status, 'active');
  assert.equal(goal.schedule.time, '09:30');
  assert.ok(Date.parse(goal.nextCheckAt) > Date.now());
  assert.deepEqual(goal.checks, []);

  const listed = await request(env.base, 'GET', '/api/goals', { headers: adminHeaders(env) });
  assert.equal(listed.json.goals.length, 1);
  assert.equal(listed.json.goals[0].id, goal.id);

  const snap = await request(env.base, 'GET', '/api/snapshot', { headers: adminHeaders(env) });
  assert.equal(snap.json.goals.length, 1);
  assert.equal(snap.json.goals[0].title, '持续跟进求职进展');

  // 暂停：清空下一次跟进；恢复：重新排期
  const paused = await request(env.base, 'PATCH', `/api/goals/${goal.id}`, {
    headers: adminHeaders(env),
    body: { status: 'paused' },
  });
  assert.equal(paused.status, 200);
  assert.equal(paused.json.goal.status, 'paused');
  assert.equal(paused.json.goal.nextCheckAt, null);

  const resumed = await request(env.base, 'PATCH', `/api/goals/${goal.id}`, {
    headers: adminHeaders(env),
    body: { status: 'active' },
  });
  assert.equal(resumed.json.goal.status, 'active');
  assert.ok(Date.parse(resumed.json.goal.nextCheckAt) > Date.now());

  const edited = await request(env.base, 'PATCH', `/api/goals/${goal.id}`, {
    headers: adminHeaders(env),
    body: {
      title: '求职进展（每日）',
      schedule: { type: 'interval', minutes: 120 },
    },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.goal.title, '求职进展（每日）');
  assert.deepEqual(edited.json.goal.schedule, { type: 'interval', minutes: 120 });

  const invalidStatus = await request(env.base, 'PATCH', `/api/goals/${goal.id}`, {
    headers: adminHeaders(env),
    body: { status: 'unknown' },
  });
  assert.equal(invalidStatus.status, 400);
  assert.match(invalidStatus.json.error.message, /目标状态/);

  const invalidTitle = await request(env.base, 'POST', '/api/goals', {
    headers: adminHeaders(env),
    body: { title: '  ' },
  });
  assert.equal(invalidTitle.status, 400);

  const missing = await request(env.base, 'GET', '/api/goals/goal_missing', {
    headers: adminHeaders(env),
  });
  assert.equal(missing.status, 404);

  const removed = await request(env.base, 'DELETE', `/api/goals/${goal.id}`, {
    headers: adminHeaders(env),
  });
  assert.equal(removed.status, 200);
  assert.equal(removed.json.ok, true);
  const afterDelete = await request(env.base, 'GET', '/api/goals', { headers: adminHeaders(env) });
  assert.deepEqual(afterDelete.json.goals, []);
});

test('目标立即跟进：创建关联任务，完成结果回写建议与检查历史', async (t) => {
  const env = await startTestHub(t);
  const device = await registerDevice(env, makeManifest({ name: '目标检查设备' }));
  const goal = await createGoal(env, {
    title: '整理作品集',
    description: '把项目案例整理成可展示的作品集',
    schedule: { type: 'daily', time: '09:00' },
  });

  const check = await request(env.base, 'POST', `/api/goals/${goal.id}/check`, {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(check.status, 200, check.text);
  assert.equal(check.json.task.goalId, goal.id);
  assert.equal(check.json.task.status, 'assigned');
  assert.equal(check.json.task.assignedDeviceId, device.deviceId);
  assert.match(check.json.task.instruction, /整理作品集/);
  assert.equal(check.json.task.timeoutSec, 600);
  assert.equal(check.json.goal.runningTaskId, check.json.task.id);

  // 已有跟进任务执行中：不能重复创建
  const conflict = await request(env.base, 'POST', `/api/goals/${goal.id}/check`, {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(conflict.status, 409);
  assert.match(conflict.json.error.message, /跟进任务/);

  const taskId = check.json.task.id;
  assert.equal((await ackTask(env, device, taskId)).status, 200);
  const result = await resultTask(env, device, taskId, {
    ok: true,
    output: { text: '当前进度 60%：案例已整理 3 个，还差 2 个；建议本周补齐并发布。' },
  });
  assert.equal(result.status, 200, result.text);

  const updated = await waitFor(async () => {
    const latest = await getGoal(env, goal.id);
    return latest.lastCheckStatus === 'completed' ? latest : null;
  }, { label: '目标检查回写', timeout: 5000 });

  assert.equal(updated.runningTaskId, null);
  assert.match(updated.lastSummary, /当前进度 60%/);
  assert.equal(updated.checks.length, 1);
  assert.equal(updated.checks[0].taskId, taskId);
  assert.equal(updated.checks[0].status, 'completed');
  assert.match(updated.checks[0].summary, /建议本周补齐/);
  assert.ok(Date.parse(updated.nextCheckAt) > Date.now(), '完成后应重新排下一次跟进');

  // 失败结果也写入检查历史
  const second = await request(env.base, 'POST', `/api/goals/${goal.id}/check`, {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(second.status, 200, second.text);
  await ackTask(env, device, second.json.task.id);
  await resultTask(env, device, second.json.task.id, { ok: false, error: '设备执行失败' });
  const afterFailure = await waitFor(async () => {
    const latest = await getGoal(env, goal.id);
    return latest.lastCheckStatus === 'failed' ? latest : null;
  }, { label: '失败检查回写', timeout: 5000 });
  assert.equal(afterFailure.checks.length, 2);
  assert.equal(afterFailure.checks[1].status, 'failed');
  assert.match(afterFailure.lastSummary, /设备执行失败/);
});

test('目标调度器：到点自动创建跟进任务，执行中不重复触发', async (t) => {
  const env = await startTestHub(t);
  const goal = await createGoal(env, {
    title: '每天复盘学习进度',
    description: '检查今天的学习任务是否完成',
    schedule: { type: 'interval', minutes: 60 },
  });
  const stored = env.hub.goals.get(goal.id);
  stored.nextCheckAt = new Date(Date.now() - 1000).toISOString();

  const triggered = env.hub.runDueGoalChecks();
  assert.deepEqual(triggered, [goal.id]);
  const latest = await getGoal(env, goal.id);
  assert.ok(latest.runningTaskId, '到点后应创建跟进任务');
  const task = env.hub.tasks.get(latest.runningTaskId);
  assert.equal(task.goalId, goal.id);
  assert.equal(task.context.goalCheck, true);
  assert.equal(task.context.trigger, 'schedule');

  // 已有跟进任务执行中：再次扫描不重复创建
  stored.nextCheckAt = new Date(Date.now() - 1000).toISOString();
  assert.deepEqual(env.hub.runDueGoalChecks(), []);

  // 未到点的目标不会被触发
  const future = await createGoal(env, {
    title: '下个月再跟进',
    schedule: { type: 'daily', time: '23:59' },
  });
  assert.deepEqual(env.hub.runDueGoalChecks(), []);
  assert.equal((await getGoal(env, future.id)).runningTaskId, null);
});

test('长期目标持久化：重启后恢复标题/计划/状态', async (t) => {
  const dataDir = await makeTempDir('butler-goals-');
  const first = await startHubAt(dataDir);
  try {
    const goal = await createGoal(first, {
      title: '长期健康计划',
      description: '每周三次运动',
      schedule: { type: 'daily', time: '07:30' },
    });
    await request(first.base, 'PATCH', `/api/goals/${goal.id}`, {
      headers: adminHeaders(first),
      body: { status: 'paused' },
    });
    await first.hub.flushState();
    assert.ok(fs.existsSync(path.join(dataDir, 'state.json')));
  } finally {
    await first.hub.close();
  }

  const second = await startHubAt(dataDir);
  try {
    const res = await request(second.base, 'GET', '/api/goals', { headers: adminHeaders(second) });
    assert.equal(res.status, 200);
    assert.equal(res.json.goals.length, 1);
    const [goal] = res.json.goals;
    assert.equal(goal.title, '长期健康计划');
    assert.equal(goal.description, '每周三次运动');
    assert.deepEqual(goal.schedule, { type: 'daily', time: '07:30' });
    assert.equal(goal.status, 'paused');
    assert.equal(goal.nextCheckAt, null);
  } finally {
    await second.hub.close();
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  }
});
