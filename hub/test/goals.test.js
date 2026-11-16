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
  createTask,
  ackTask,
  resultTask,
  adminHeaders,
  waitFor,
} = require('./_helpers.js');
const {
  normalizeSchedule,
  computeNextCheckAt,
  computeSkipNextCheckAt,
  normalizePausedUntil,
  normalizeGuidanceEntry,
  normalizeGoalRequest,
  restoreGoal,
  goalToJson,
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

test('目标调度器：到点只创建待确认提案，批准后才创建跟进任务', async (t) => {
  const env = await startTestHub(t);
  const device = await registerDevice(env, makeManifest({ name: '调度设备' }));
  const goal = await createGoal(env, {
    title: '每天复盘学习进度',
    description: '检查今天的学习任务是否完成',
    schedule: { type: 'interval', minutes: 60 },
  });
  const stored = env.hub.goals.get(goal.id);
  stored.nextCheckAt = new Date(Date.now() - 1000).toISOString();

  const triggered = env.hub.runDueGoalChecks();
  assert.deepEqual(triggered, [goal.id]);
  let latest = await getGoal(env, goal.id);
  assert.equal(latest.runningTaskId, null, '未批准前不应创建跟进任务');
  assert.ok(latest.pendingApproval, '到点后应生成待确认提案');
  assert.equal(latest.pendingApproval.source, 'schedule');
  assert.match(latest.pendingApproval.instruction, /每天复盘学习进度/);

  // 已有待确认提案：再次扫描不重复生成
  stored.nextCheckAt = new Date(Date.now() - 1000).toISOString();
  assert.deepEqual(env.hub.runDueGoalChecks(), []);

  // 批准：创建跟进任务并清空提案
  const approve = await request(env.base, 'POST', `/api/goals/${goal.id}/approve`, {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(approve.status, 200, approve.text);
  assert.equal(approve.json.goal.pendingApproval, null);
  assert.equal(approve.json.task.goalId, goal.id);
  assert.equal(approve.json.task.context.goalCheck, true);
  latest = await getGoal(env, goal.id);
  assert.ok(latest.runningTaskId, '批准后应创建跟进任务');
  assert.equal(latest.runningTaskId, approve.json.task.id);

  // 跟进任务执行中：再次扫描不重复创建
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

test('目标跟进待确认：列表、否决后暂停、重复批准报冲突', async (t) => {
  const env = await startTestHub(t);
  await registerDevice(env, makeManifest({ name: '否决设备' }));
  const goal = await createGoal(env, {
    title: '每天复盘写作进度',
    description: '检查今天写了多少字',
    schedule: { type: 'interval', minutes: 60 },
  });
  const stored = env.hub.goals.get(goal.id);
  stored.nextCheckAt = new Date(Date.now() - 1000).toISOString();
  env.hub.runDueGoalChecks();

  const pending = await request(env.base, 'GET', '/api/approvals', {
    headers: adminHeaders(env),
  });
  assert.equal(pending.status, 200);
  assert.equal(pending.json.approvals.length, 1);
  assert.equal(pending.json.approvals[0].goalId, goal.id);
  assert.match(pending.json.approvals[0].approval.instruction, /每天复盘写作进度/);

  const rejected = await request(env.base, 'POST', `/api/goals/${goal.id}/reject`, {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(rejected.status, 200, rejected.text);
  assert.equal(rejected.json.goal.status, 'paused');
  assert.equal(rejected.json.goal.pendingApproval, null);
  assert.equal(rejected.json.goal.nextCheckAt, null);
  assert.equal(env.hub.tasks.size, 0, '否决后不应创建任务');

  // 暂停后调度器不再触发
  assert.deepEqual(env.hub.runDueGoalChecks(), []);

  // 没有待确认提案时批准/否决都返回 409
  const approveAgain = await request(env.base, 'POST', `/api/goals/${goal.id}/approve`, {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(approveAgain.status, 409);
  const rejectAgain = await request(env.base, 'POST', `/api/goals/${goal.id}/reject`, {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(rejectAgain.status, 409);
});

test('每晚总结：手动任务完成后保存 Markdown 总结，手动运行条目可强制触发', async (t) => {
  const env = await startTestHub(t, { nightlyReview: true, nightlyReviewTime: '00:00' });
  const device = await registerDevice(env, makeManifest({ name: '总结设备' }));
  const goal = await createGoal(env, {
    title: '整理求职作品集',
    description: '把项目案例整理成作品集',
    schedule: { type: 'daily', time: '23:59' },
  });

  const task = env.hub.runNightlyReview();
  assert.ok(task, '到点应创建每日总结任务');
  assert.equal(task.context.nightlyReview, true);
  assert.match(task.instruction, /每日总结/);
  assert.match(task.instruction, /整理求职作品集/);
  const status = await request(env.base, 'GET', '/api/nightly-review', {
    headers: adminHeaders(env),
  });
  assert.equal(status.status, 200);
  assert.equal(status.json.review.taskId, task.id);
  assert.equal(status.json.review.date, new Date().toLocaleDateString('sv-SE'));
  const snap = await request(env.base, 'GET', '/api/snapshot', { headers: adminHeaders(env) });
  assert.equal(snap.json.nightlyReview.taskId, task.id);
  assert.equal(snap.json.nightlyReview.time, '00:00');

  // 同一天再次到点扫描不重复创建
  assert.equal(env.hub.runNightlyReview(), null);

  assert.equal((await ackTask(env, device, task.id)).status, 200);
  const result = await resultTask(env, device, task.id, {
    ok: true,
    output: { text: '# 每日总结\n\n## 1. 目标进度\n作品集已整理 60%。' },
  });
  assert.equal(result.status, 200, result.text);
  const finished = await waitFor(async () => {
    const res = await request(env.base, 'GET', '/api/nightly-review', {
      headers: adminHeaders(env),
    });
    return res.json.review.status === 'completed' ? res.json.review : null;
  }, { label: '每日总结完成', timeout: 5000 });
  assert.match(finished.summary, /作品集已整理 60%/);
  assert.ok(finished.finishedAt);
  void goal;
});


test('长期目标持久化：重启后恢复标题/计划/状态', async (t) => {
  const dataDir = await makeTempDir('butler-goals-');
  const first = await startHubAt(dataDir);
  try {
    const goal = await createGoal(first, {
      title: '长期健康计划',
      nickname: '健康',
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
    assert.equal(goal.nickname, '健康');
    assert.equal(goal.description, '每周三次运动');
    assert.deepEqual(goal.schedule, { type: 'daily', time: '07:30' });
    assert.equal(goal.status, 'paused');
    assert.equal(goal.nextCheckAt, null);
  } finally {
    await second.hub.close();
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  }
});

test('目标昵称：创建/编辑/清除，跟进指令与每日总结优先用昵称称呼', async (t) => {
  const env = await startTestHub(t);

  const goal = await createGoal(env, {
    title: '以自由职业（freelance）接案获得收入',
    nickname: '自由职业',
    schedule: { type: 'daily', time: '13:00' },
  });
  assert.equal(goal.nickname, '自由职业');

  // 昵称参与跟进指令，并保留正式标题作为补充。
  const instruction = buildGoalCheckInstruction(goal);
  assert.match(instruction, /目标：自由职业/);
  assert.match(instruction, /正式标题：以自由职业/);

  // 每日总结指令同样使用昵称。
  const nightly = env.hub._buildNightlyReviewInstruction('2026-11-08');
  assert.match(nightly, /自由职业（标题：以自由职业/);

  const renamed = await request(env.base, 'PATCH', `/api/goals/${goal.id}`, {
    headers: adminHeaders(env),
    body: { nickname: 'Fiverr 接单' },
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.goal.nickname, 'Fiverr 接单');
  assert.equal(renamed.json.goal.title, '以自由职业（freelance）接案获得收入');

  // 超长昵称截断到 40 字。
  const tooLong = await request(env.base, 'PATCH', `/api/goals/${goal.id}`, {
    headers: adminHeaders(env),
    body: { nickname: '目'.repeat(60) },
  });
  assert.equal(tooLong.json.goal.nickname.length, 40);

  // 传空字符串清除昵称，列表回退为标题。
  const cleared = await request(env.base, 'PATCH', `/api/goals/${goal.id}`, {
    headers: adminHeaders(env),
    body: { nickname: '' },
  });
  assert.equal(cleared.json.goal.nickname, '');
  const listed = await request(env.base, 'GET', '/api/goals', { headers: adminHeaders(env) });
  assert.equal(listed.json.goals[0].nickname, '');

  // 纯函数：没有昵称时目标称呼回退为标题。
  const normalized = normalizeGoalRequest({ title: '没有昵称的目标' });
  assert.equal(normalized.ok, true);
  assert.equal(normalized.value.nickname, '');
  assert.match(buildGoalCheckInstruction({ title: '没有昵称的目标', schedule: { type: 'daily', time: '09:00' }, checks: [] }), /目标：没有昵称的目标/);
});

test('目标关联已有任务：写入任务与检查历史，下一次跟进引用该结论', async (t) => {
  const env = await startTestHub(t);
  const device = await registerDevice(env, makeManifest({ name: '关联设备' }));
  const goal = await createGoal(env, {
    title: '按行动方案推进自由职业',
    description: '按已有任务产出的方案执行',
    schedule: { type: 'daily', time: '13:00' },
  });

  const task = await createTask(env, { instruction: '产出行动方案', timeoutSec: 120 });
  assert.equal(task.goalId, null);
  assert.equal((await ackTask(env, device, task.id)).status, 200);
  const result = await resultTask(env, device, task.id, {
    ok: true,
    output: { text: '行动方案：先做自动化外包，主攻 Upwork，其次 Fiverr。' },
  });
  assert.equal(result.status, 200, result.text);
  await waitFor(() => (env.hub.getTask(task.id).status === 'completed' ? true : null), {
    label: '任务完成',
    timeout: 5000,
  });

  const linked = await request(env.base, 'POST', `/api/goals/${goal.id}/link`, {
    headers: adminHeaders(env),
    body: { taskId: task.id },
  });
  assert.equal(linked.status, 200, linked.text);
  assert.equal(linked.json.task.goalId, goal.id);
  assert.equal(linked.json.goal.lastTaskId, task.id);
  assert.match(linked.json.goal.lastSummary, /Upwork/);
  assert.deepEqual(linked.json.goal.taskIds, [task.id]);
  assert.equal(linked.json.goal.lastCheckStatus, 'completed');
  assert.equal(linked.json.goal.checks.length, 1);
  assert.equal(linked.json.goal.checks[0].taskId, task.id);
  assert.ok(Date.parse(linked.json.goal.nextCheckAt) > Date.now());

  // 重复关联：不重复追加检查历史
  const again = await request(env.base, 'POST', `/api/goals/${goal.id}/link`, {
    headers: adminHeaders(env),
    body: { taskId: task.id },
  });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.goal.checks.length, 1);
  assert.deepEqual(again.json.goal.taskIds, [task.id]);

  // taskId 缺失或任务不存在
  const invalid = await request(env.base, 'POST', `/api/goals/${goal.id}/link`, {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(invalid.status, 400);
  const missing = await request(env.base, 'POST', `/api/goals/${goal.id}/link`, {
    headers: adminHeaders(env),
    body: { taskId: 'task_missing' },
  });
  assert.equal(missing.status, 404);

  // 下一次跟进任务带着关联任务的结论
  const check = await request(env.base, 'POST', `/api/goals/${goal.id}/check`, {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(check.status, 200, check.text);
  assert.match(check.json.task.instruction, /Upwork/);
});

test('每晚总结：关闭开关不自动触发，手动运行接口可强制创建', async (t) => {
  const env = await startTestHub(t);
  assert.equal(env.hub.runNightlyReview(), null);

  const run = await request(env.base, 'POST', '/api/nightly-review/run', {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(run.status, 200, run.text);
  assert.ok(run.json.task, '手动运行应创建每日总结任务');
  assert.equal(run.json.review.taskId, run.json.task.id);
  assert.equal(run.json.review.enabled, false);

  // 手动运行创建的任务执行中：再次触发不重复创建
  assert.equal(env.hub.runNightlyReview(), null);
});

test('目标暂停止纯函数：跳过下一次与暂停结束时间校验', () => {
  const noon = new Date(2026, 0, 5, 12, 0, 0, 0);
  const tomorrowNine = computeNextCheckAt({ type: 'daily', time: '09:00' }, noon.getTime());
  assert.equal(new Date(tomorrowNine).getDate(), 6);
  const skipped = computeSkipNextCheckAt({ type: 'daily', time: '09:00' }, tomorrowNine, noon.getTime());
  assert.equal(new Date(skipped).getDate(), 7);
  assert.equal(new Date(skipped).getHours(), 9);
  assert.ok(Date.parse(skipped) > Date.parse(tomorrowNine));

  // interval：在 nextCheckAt 基础上再推一个周期
  const intervalBase = new Date(noon.getTime() + 3600 * 1000).toISOString();
  assert.equal(
    computeSkipNextCheckAt({ type: 'interval', minutes: 60 }, intervalBase, noon.getTime()),
    new Date(noon.getTime() + 2 * 3600 * 1000).toISOString(),
  );

  // nextCheckAt 缺失或过期：从 now 开始重排，再推进一个周期
  const stale = new Date(noon.getTime() - 86400 * 1000).toISOString();
  const fromNow = computeSkipNextCheckAt({ type: 'daily', time: '09:00' }, stale, noon.getTime());
  assert.ok(Date.parse(fromNow) > noon.getTime());
  assert.equal(new Date(fromNow).getHours(), 9);

  // 暂停结束时间：null/空 表示手动恢复；非法/过期/超过 366 天报错
  assert.deepEqual(normalizePausedUntil(undefined, noon.getTime()), { ok: true, value: undefined });
  assert.deepEqual(normalizePausedUntil(null, noon.getTime()), { ok: true, value: null });
  assert.deepEqual(normalizePausedUntil('', noon.getTime()), { ok: true, value: null });
  const invalid = normalizePausedUntil('not-a-date', noon.getTime());
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /格式/);
  assert.equal(normalizePausedUntil(new Date(noon.getTime() - 1000).toISOString(), noon.getTime()).ok, false);
  assert.match(normalizePausedUntil(new Date(noon.getTime() + 400 * 86400 * 1000).toISOString(), noon.getTime()).error, /366/);
  const okUntil = new Date(noon.getTime() + 3600 * 1000).toISOString();
  assert.deepEqual(normalizePausedUntil(okUntil, noon.getTime()), { ok: true, value: okUntil });

  // PATCH 语义：暂停中的目标可以单独更新 pausedUntil
  const partial = normalizeGoalRequest({ pausedUntil: okUntil }, { partial: true, base: { status: 'paused' }, nowMs: noon.getTime() });
  assert.equal(partial.ok, true);
  assert.equal(partial.value.pausedUntil, okUntil);
  const activeUntil = normalizeGoalRequest({ pausedUntil: okUntil }, { partial: true, base: { status: 'active' }, nowMs: noon.getTime() });
  assert.equal(activeUntil.ok, false);
  assert.match(activeUntil.errors.join('；'), /只有已暂停/);

  // 持久化：restoreGoal / goalToJson 保留 pausedUntil，非 paused 状态清除
  const restored = restoreGoal({
    id: 'goal_restore',
    title: '恢复测试',
    status: 'paused',
    pausedUntil: okUntil,
    schedule: { type: 'daily', time: '09:00' },
  });
  assert.equal(restored.pausedUntil, okUntil);
  assert.equal(restored.nextCheckAt, null);
  assert.equal(goalToJson(restored).pausedUntil, okUntil);
  const restoredActive = restoreGoal({
    id: 'goal_restore_active',
    title: '恢复测试 2',
    status: 'active',
    pausedUntil: okUntil,
    schedule: { type: 'daily', time: '09:00' },
  });
  assert.equal(restoredActive.pausedUntil, null);
});

test('目标暂停止 API：暂停到指定时间自动恢复、跳过下一次自动跟进', async (t) => {
  const env = await startTestHub(t);
  const goal = await createGoal(env, {
    title: '临时暂停演练',
    schedule: { type: 'daily', time: '09:00' },
  });

  // 非法 pausedUntil / 未暂停时设置 pausedUntil
  const bad = await request(env.base, 'PATCH', `/api/goals/${goal.id}`, {
    headers: adminHeaders(env),
    body: { status: 'paused', pausedUntil: 'not-a-date' },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error.message, /暂停结束时间/);

  const invalidActive = await request(env.base, 'PATCH', `/api/goals/${goal.id}`, {
    headers: adminHeaders(env),
    body: { pausedUntil: new Date(Date.now() + 3600 * 1000).toISOString() },
  });
  assert.equal(invalidActive.status, 400);
  assert.match(invalidActive.json.error.message, /只有已暂停/);

  // 暂停到指定时间：清空 nextCheckAt，保留 pausedUntil
  const until = new Date(Date.now() + 86400 * 1000).toISOString();
  const paused = await request(env.base, 'PATCH', `/api/goals/${goal.id}`, {
    headers: adminHeaders(env),
    body: { status: 'paused', pausedUntil: until },
  });
  assert.equal(paused.status, 200, paused.text);
  assert.equal(paused.json.goal.status, 'paused');
  assert.equal(paused.json.goal.pausedUntil, until);
  assert.equal(paused.json.goal.nextCheckAt, null);

  // 未到期不恢复
  env.hub.runDueGoalChecks();
  assert.equal((await getGoal(env, goal.id)).status, 'paused');

  // 到期后调度器自动恢复，重新排下一次跟进
  env.hub.goals.get(goal.id).pausedUntil = new Date(Date.now() - 1000).toISOString();
  env.hub.runDueGoalChecks();
  const resumed = await getGoal(env, goal.id);
  assert.equal(resumed.status, 'active');
  assert.equal(resumed.pausedUntil, null);
  assert.ok(Date.parse(resumed.nextCheckAt) > Date.now());

  // 跳过下一次自动跟进：nextCheckAt 前进一个周期
  const before = Date.parse(resumed.nextCheckAt);
  const skip = await request(env.base, 'POST', `/api/goals/${goal.id}/skip`, {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(skip.status, 200, skip.text);
  assert.equal(skip.json.goal.status, 'active');
  assert.ok(Date.parse(skip.json.goal.nextCheckAt) > before);

  // 到点生成待确认提案后，跳过会同时取消提案
  const pendingGoal = await createGoal(env, {
    title: '待确认跳过',
    schedule: { type: 'interval', minutes: 60 },
  });
  env.hub.goals.get(pendingGoal.id).nextCheckAt = new Date(Date.now() - 1000).toISOString();
  assert.deepEqual(env.hub.runDueGoalChecks(), [pendingGoal.id]);
  assert.ok((await getGoal(env, pendingGoal.id)).pendingApproval);
  const skippedPending = await request(env.base, 'POST', `/api/goals/${pendingGoal.id}/skip`, {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(skippedPending.status, 200, skippedPending.text);
  assert.equal(skippedPending.json.goal.pendingApproval, null);
  assert.ok(Date.parse(skippedPending.json.goal.nextCheckAt) > Date.now());

  // 暂停中的目标不能跳过
  await request(env.base, 'PATCH', `/api/goals/${goal.id}`, {
    headers: adminHeaders(env),
    body: { status: 'paused' },
  });
  const conflict = await request(env.base, 'POST', `/api/goals/${goal.id}/skip`, {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(conflict.status, 409);
  assert.match(conflict.json.error.message, /跳过/);

  // 暂停到指定时间 → 一直暂停：显式传 null 清除自动恢复时间
  const repause = await request(env.base, 'PATCH', `/api/goals/${goal.id}`, {
    headers: adminHeaders(env),
    body: { status: 'paused', pausedUntil: new Date(Date.now() + 86400 * 1000).toISOString() },
  });
  assert.equal(repause.status, 200, repause.text);
  assert.ok(repause.json.goal.pausedUntil);
  const manual = await request(env.base, 'PATCH', `/api/goals/${goal.id}`, {
    headers: adminHeaders(env),
    body: { status: 'paused', pausedUntil: null },
  });
  assert.equal(manual.status, 200, manual.text);
  assert.equal(manual.json.goal.pausedUntil, null);
  assert.equal(manual.json.goal.status, 'paused');
});

test('目标指导指令纯函数：校验、恢复、指令注入', () => {
  assert.deepEqual(normalizeGuidanceEntry({ text: '  优先处理 A 项目  ' }), { ok: true, value: { text: '优先处理 A 项目' } });
  assert.equal(normalizeGuidanceEntry({ text: '   ' }).ok, false);
  assert.match(normalizeGuidanceEntry({ text: '   ' }).error, /不能为空/);
  assert.equal(normalizeGuidanceEntry({ text: 'x'.repeat(2001) }).ok, false);
  assert.match(normalizeGuidanceEntry({ text: 'x'.repeat(2001) }).error, /2000/);

  // 恢复与序列化：补 id/时间、过滤空文本、条数上限
  const restored = restoreGoal({
    id: 'goal_guidance',
    title: '指导指令测试',
    status: 'active',
    schedule: { type: 'daily', time: '09:00' },
    guidance: [
      { text: '第一条' },
      { text: '   ' },
      { text: '第二条', createdAt: '2026-11-02T01:02:03.000Z' },
    ],
  });
  assert.equal(restored.guidance.length, 2);
  assert.ok(restored.guidance[0].id.startsWith('gd_'));
  assert.equal(restored.guidance[1].createdAt, '2026-11-02T01:02:03.000Z');
  const json = goalToJson(restored);
  assert.equal(json.guidance.length, 2);
  assert.equal(json.guidance[1].text, '第二条');

  // 指令注入：出现在跟进任务指令里，且按时间顺序
  const instruction = buildGoalCheckInstruction(restored);
  assert.match(instruction, /用户指导/);
  assert.ok(instruction.includes('第一条'));
  assert.ok(instruction.indexOf('第一条') < instruction.indexOf('第二条'));

  // 超过上限时只保留最近 N 条
  const many = restoreGoal({
    id: 'goal_many',
    title: '很多指导',
    status: 'active',
    guidance: Array.from({ length: 30 }, (_, i) => ({ text: `指令 ${i + 1}` })),
  });
  assert.equal(many.guidance.length, 20);
  assert.equal(many.guidance[19].text, '指令 30');
});

test('目标指导指令 API：追加即生效、空文本报错、恢复自动跟进（stopped/paused）', async (t) => {
  const env = await startTestHub(t);
  const goal = await createGoal(env, {
    title: '指导指令演练',
    schedule: { type: 'daily', time: '09:00' },
  });

  // 追加指导指令
  const added = await request(env.base, 'POST', `/api/goals/${goal.id}/guidance`, {
    headers: adminHeaders(env),
    body: { text: '从明天起优先推进 A 项目，B 项目暂缓' },
  });
  assert.equal(added.status, 200, added.text);
  assert.equal(added.json.goal.guidance.length, 1);
  assert.match(added.json.goal.guidance[0].id, /^gd_/);
  assert.ok(added.json.goal.guidance[0].createdAt);
  assert.equal(added.json.goal.guidance[0].text, '从明天起优先推进 A 项目，B 项目暂缓');

  // 列表与详情都带指导指令
  const list = await request(env.base, 'GET', '/api/goals', { headers: adminHeaders(env) });
  assert.equal(list.status, 200, list.text);
  assert.equal(list.json.goals.find((item) => item.id === goal.id).guidance.length, 1);

  // 空文本 / 超长文本报 400
  const empty = await request(env.base, 'POST', `/api/goals/${goal.id}/guidance`, {
    headers: adminHeaders(env),
    body: { text: '   ' },
  });
  assert.equal(empty.status, 400);
  assert.match(empty.json.error.message, /不能为空/);
  const tooLong = await request(env.base, 'POST', `/api/goals/${goal.id}/guidance`, {
    headers: adminHeaders(env),
    body: { text: 'x'.repeat(2001) },
  });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.json.error.message, /2000/);
  assert.equal((await getGoal(env, goal.id)).guidance.length, 1);

  // 立即跟进的任务指令已包含新指导
  const check = await request(env.base, 'POST', `/api/goals/${goal.id}/check`, {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(check.status, 200, check.text);
  assert.match(check.json.task.instruction, /优先推进 A 项目/);
  assert.match(check.json.task.instruction, /用户指导/);

  // 待确认提案：追加指导后会刷新提案指令
  const pendingGoal = await createGoal(env, {
    title: '提案刷新指导',
    schedule: { type: 'interval', minutes: 60 },
  });
  env.hub.goals.get(pendingGoal.id).nextCheckAt = new Date(Date.now() - 1000).toISOString();
  env.hub.runDueGoalChecks();
  const pendingBefore = await getGoal(env, pendingGoal.id);
  assert.ok(pendingBefore.pendingApproval);
  const addedPending = await request(env.base, 'POST', `/api/goals/${pendingGoal.id}/guidance`, {
    headers: adminHeaders(env),
    body: { text: '批准时优先做 X' },
  });
  assert.equal(addedPending.status, 200, addedPending.text);
  assert.match(addedPending.json.goal.pendingApproval.instruction, /批准时优先做 X/);

  // stopped → active：恢复自动跟进
  const stopped = await request(env.base, 'PATCH', `/api/goals/${goal.id}`, {
    headers: adminHeaders(env),
    body: { status: 'stopped' },
  });
  assert.equal(stopped.status, 200, stopped.text);
  assert.equal(stopped.json.goal.status, 'stopped');
  assert.equal(stopped.json.goal.nextCheckAt, null);
  const resumed = await request(env.base, 'PATCH', `/api/goals/${goal.id}`, {
    headers: adminHeaders(env),
    body: { status: 'active' },
  });
  assert.equal(resumed.status, 200, resumed.text);
  assert.equal(resumed.json.goal.status, 'active');
  assert.equal(resumed.json.goal.stoppedAt, null);
  assert.ok(Date.parse(resumed.json.goal.nextCheckAt) > Date.now());
  assert.equal(resumed.json.goal.guidance.length, 1);

  // paused → active 也恢复自动跟进
  await request(env.base, 'PATCH', `/api/goals/${goal.id}`, {
    headers: adminHeaders(env),
    body: { status: 'paused', pausedUntil: new Date(Date.now() + 3600 * 1000).toISOString() },
  });
  const resumedPaused = await request(env.base, 'PATCH', `/api/goals/${goal.id}`, {
    headers: adminHeaders(env),
    body: { status: 'active' },
  });
  assert.equal(resumedPaused.status, 200, resumedPaused.text);
  assert.equal(resumedPaused.json.goal.status, 'active');
  assert.equal(resumedPaused.json.goal.pausedUntil, null);
});
