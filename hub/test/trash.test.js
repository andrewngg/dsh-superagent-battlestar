'use strict';

/**
 * 任务回收站（Task Trash）测试。
 * 契约：docs/TASK-TRASH-DESIGN.md（§5 用例清单）。
 *
 * 覆盖：非终态拒绝回收、终态回收后列表/统计/快照行为、恢复、线程与计划子任务联动、
 * 彻底删除（目标引用 + 执行记录文件 + task.deleted 广播）、HTTP 路由/鉴权、
 * 归档互斥、持久化重启。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const {
  startTestHub,
  startHubAt,
  makeTempDir,
  request,
  adminHeaders,
  makeManifest,
  registerDevice,
  createTask,
  ackTask,
  resultTask,
  waitFor,
} = require('./_helpers.js');
const { createHub } = require('../lib/hub.js');

function nowIso() {
  return new Date().toISOString();
}

/** 直接把任务置为终态：回收站逻辑只依赖 status / finishedAt，无需真的执行任务。 */
function markTerminal(hub, taskId, status, error = null) {
  const task = hub._requireTask(taskId);
  task.status = status;
  task.finishedAt = nowIso();
  task.updatedAt = task.finishedAt;
  task.error = error;
  return task;
}

function findTask(list, id) {
  return list.find((task) => task.id === id) || null;
}

test('trashTask：非终态任务不可回收（400「只能回收已结束的任务」）', async (t) => {
  const env = await startTestHub(t);

  const queued = await createTask(env, { instruction: '排队中的任务' });
  assert.equal(queued.status, 'queued');
  assert.throws(
    () => env.hub.trashTask(env.hub._requireTask(queued.id)),
    (err) => err.status === 400 && /只能回收已结束的任务/.test(err.message),
  );

  const device = await registerDevice(env, makeManifest({ name: '回收设备', limits: { maxConcurrentTasks: 2 } }));
  const running = await createTask(env, { instruction: '执行中的任务' });
  await waitFor(() => env.hub.getTask(running.id).status === 'assigned', { label: '任务派发' });
  await ackTask(env, device, running.id);
  assert.equal(env.hub.getTask(running.id).status, 'running');
  assert.throws(
    () => env.hub.trashTask(env.hub._requireTask(running.id)),
    /只能回收已结束的任务/,
  );
});

test('trashTask：失败任务回收后从列表/统计隐藏，快照仍包含并写入事件', async (t) => {
  const env = await startTestHub(t);
  const device = await registerDevice(env, makeManifest({ name: '执行设备' }));

  const task = await createTask(env, { instruction: '会失败的任务' });
  await ackTask(env, device, task.id);
  await resultTask(env, device, task.id, { ok: false, error: '执行失败' });
  await waitFor(() => env.hub.getTask(task.id).status === 'failed', { label: '任务失败' });
  assert.equal(env.hub.stats().tasksFailed, 1);

  env.hub.trashTask(env.hub._requireTask(task.id));
  const raw = env.hub.getTask(task.id);
  assert.ok(raw.trashedAt, 'trashedAt 应为 ISO 字符串');
  assert.equal(Number.isNaN(Date.parse(raw.trashedAt)), false);

  const json = env.hub.taskToJson(raw);
  assert.equal(json.trashed, true);
  assert.equal(json.trashedAt, raw.trashedAt);

  assert.equal(findTask(env.hub.listTasks({ limit: 500 }), task.id), null, '默认列表不含回收站任务');
  assert.ok(
    findTask(env.hub.listTasks({ includeTrashed: true, limit: 500 }), task.id),
    'includeTrashed 列表应包含回收站任务',
  );

  assert.equal(env.hub.stats().tasksFailed, 0, '统计应排除回收站任务');
  assert.ok(findTask(env.hub.snapshot(200).tasks, task.id), '快照应包含回收站任务');
  assert.ok(
    raw.events.some((event) => event.type === 'trashed' && event.message === '任务移入回收站'),
    '任务事件应记录「任务移入回收站」',
  );
  assert.ok(
    env.hub.events.some(
      (event) => event.type === 'task.updated' && event.data && event.data.task && event.data.task.id === task.id,
    ),
    '应广播 task.updated',
  );

  // 重复回收幂等：不改变 trashedAt。
  const firstAt = raw.trashedAt;
  env.hub.trashTask(raw);
  assert.equal(env.hub.getTask(task.id).trashedAt, firstAt);
});

test('restoreTask：从回收站恢复并写「任务已恢复」事件', async (t) => {
  const env = await startTestHub(t);
  const task = env.hub.createTask({ instruction: '需要恢复的任务' });
  markTerminal(env.hub, task.id, 'completed');

  env.hub.trashTask(env.hub._requireTask(task.id));
  assert.equal(findTask(env.hub.listTasks({ limit: 500 }), task.id), null);

  env.hub.restoreTask(env.hub._requireTask(task.id));
  const raw = env.hub.getTask(task.id);
  assert.equal(raw.trashedAt, null);
  assert.equal(env.hub.taskToJson(raw).trashed, false);
  assert.ok(findTask(env.hub.listTasks({ limit: 500 }), task.id), '恢复后应回到常规列表');
  assert.ok(
    raw.events.some((event) => event.type === 'restored' && event.message === '任务已恢复'),
    '任务事件应记录「任务已恢复」',
  );

  assert.throws(() => env.hub.restoreTask(raw), /任务不在回收站中/);
});

test('trashTask：同线程任务（继续此任务）一起进回收站', async (t) => {
  const env = await startTestHub(t);
  const first = env.hub.createTask({ instruction: '线程第一步' });
  markTerminal(env.hub, first.id, 'completed');

  const follow = env.hub.createFollowUp(env.hub._requireTask(first.id), { instruction: '线程继续' });
  markTerminal(env.hub, follow.id, 'failed', '继续失败');
  assert.equal(follow.threadId, first.threadId || first.id);

  env.hub.trashTask(env.hub._requireTask(first.id));
  assert.ok(env.hub.getTask(first.id).trashedAt);
  assert.ok(env.hub.getTask(follow.id).trashedAt, '同线程任务应一起回收');
  assert.equal(findTask(env.hub.listTasks({ limit: 500 }), follow.id), null);
  assert.ok(findTask(env.hub.listTasks({ includeTrashed: true, limit: 500 }), follow.id));

  env.hub.restoreTask(env.hub._requireTask(first.id));
  assert.equal(env.hub.getTask(follow.id).trashedAt, null, '恢复时同线程任务一起恢复');
});

test('trashTask：计划父任务回收时子任务一起回收，列表只保留父任务视图', async (t) => {
  const planner = async () => ({
    title: '回收站计划',
    subtasks: [{ instruction: '第一步：收集数据' }, { instruction: '第二步：汇总成文' }],
  });
  const env = await startTestHub(t, { planner });

  const plan = await createTask(env, { instruction: '写一份季度报告', split: true });
  await waitFor(() => env.hub.getTask(plan.id).childTaskIds.length === 2, { label: '计划子任务创建' });
  const raw = env.hub.getTask(plan.id);
  assert.equal(raw.isPlan, true);

  for (const childId of raw.childTaskIds) markTerminal(env.hub, childId, 'completed');
  markTerminal(env.hub, plan.id, 'completed');

  env.hub.trashTask(env.hub._requireTask(plan.id));
  assert.ok(env.hub.getTask(plan.id).trashedAt);
  for (const childId of raw.childTaskIds) {
    assert.ok(env.hub.getTask(childId).trashedAt, `子任务 ${childId} 应一起回收`);
  }
  assert.equal(findTask(env.hub.listTasks({ limit: 500 }), plan.id), null, '回收站计划不出现在常规列表');

  env.hub.restoreTask(env.hub._requireTask(plan.id));
  for (const childId of raw.childTaskIds) {
    assert.equal(env.hub.getTask(childId).trashedAt, null, '恢复时子任务一起恢复');
  }
});

test('restoreTask / purgeTask：只对回收站中的任务生效', async (t) => {
  const env = await startTestHub(t);
  const task = env.hub.createTask({ instruction: '普通终态任务' });
  markTerminal(env.hub, task.id, 'timeout', '执行超时');

  assert.throws(() => env.hub.restoreTask(env.hub._requireTask(task.id)), /任务不在回收站中/);
  assert.throws(
    () => env.hub.purgeTask(env.hub._requireTask(task.id)),
    /只能彻底删除回收站中的任务/,
  );
});

test('purgeTask：清理目标引用、删除执行记录文件并广播 task.deleted', async (t) => {
  const env = await startTestHub(t);

  const goalRes = await request(env.base, 'POST', '/api/goals', {
    headers: adminHeaders(env),
    body: { title: '回收站目标' },
  });
  assert.equal(goalRes.status, 200, goalRes.text);
  const goalId = goalRes.json.goal.id;

  const task = env.hub.createTask({ instruction: '带执行记录的任务' });
  markTerminal(env.hub, task.id, 'failed', '失败原因');
  env.hub.linkGoalTask(goalId, task.id);

  const goal = env.hub.goals.get(goalId);
  assert.ok(goal.taskIds.includes(task.id));
  assert.equal(goal.lastTaskId, task.id);
  goal.runningTaskId = task.id; // 构造 runningTaskId 清理断言

  env.hub._writeTaskRecord(task.id);
  const recordFile = env.hub._taskRecordFile(env.hub._requireTask(task.id));
  assert.ok(recordFile, '应能解析执行记录文件路径');
  assert.ok(fs.existsSync(recordFile), '彻底删除前执行记录文件应存在');

  env.hub.trashTask(env.hub._requireTask(task.id));
  const result = env.hub.purgeTask(env.hub._requireTask(task.id));

  assert.equal(result.taskId, task.id);
  assert.ok(result.deleted.includes(task.id));
  assert.equal(env.hub.getTask(task.id), null, '任务应从 Hub 中移除');
  assert.equal(fs.existsSync(recordFile), false, '执行记录 markdown 应被删除');

  const after = env.hub.goals.get(goalId);
  assert.equal(after.taskIds.includes(task.id), false, 'goal.taskIds 应清理');
  assert.equal(after.runningTaskId, null, 'goal.runningTaskId 应清理');
  assert.equal(after.lastTaskId, null, 'goal.lastTaskId 应清理');

  assert.ok(
    env.hub.events.some(
      (event) => event.type === 'task.deleted' && event.data && event.data.taskId === task.id,
    ),
    '应广播 task.deleted',
  );
});

test('HTTP：trash / restore / purge 路由、includeTrashed 与鉴权', async (t) => {
  const env = await startTestHub(t);
  const task = env.hub.createTask({ instruction: 'HTTP 回收站任务' });
  markTerminal(env.hub, task.id, 'failed', '失败');

  // 鉴权：管理接口必须带 x-butler-token。
  const noTokenTrash = await request(env.base, 'POST', `/api/tasks/${task.id}/trash`);
  assert.equal(noTokenTrash.status, 401);
  const noTokenList = await request(env.base, 'GET', '/api/tasks?includeTrashed=1');
  assert.equal(noTokenList.status, 401);

  // 400：非终态任务不可回收。
  const queued = await createTask(env, { instruction: '排队任务' });
  const badTrash = await request(env.base, 'POST', `/api/tasks/${queued.id}/trash`, {
    headers: adminHeaders(env),
  });
  assert.equal(badTrash.status, 400);
  assert.match(badTrash.text, /只能回收已结束的任务/);

  // 404：任务不存在。
  const missing = await request(env.base, 'POST', '/api/tasks/task_not_exists/trash', {
    headers: adminHeaders(env),
  });
  assert.equal(missing.status, 404);
  assert.match(missing.text, /任务不存在/);

  // 回收 200。
  const trashed = await request(env.base, 'POST', `/api/tasks/${task.id}/trash`, {
    headers: adminHeaders(env),
  });
  assert.equal(trashed.status, 200, trashed.text);
  assert.equal(trashed.json.ok, true);
  assert.equal(trashed.json.task.trashed, true);
  assert.ok(trashed.json.task.trashedAt);

  // 列表：默认隐藏，includeTrashed=1 可见。
  const listDefault = await request(env.base, 'GET', '/api/tasks', { headers: adminHeaders(env) });
  assert.equal(listDefault.status, 200);
  assert.equal(findTask(listDefault.json.tasks, task.id), null);
  const listTrashed = await request(env.base, 'GET', '/api/tasks?includeTrashed=1', {
    headers: adminHeaders(env),
  });
  assert.equal(listTrashed.status, 200);
  assert.ok(findTask(listTrashed.json.tasks, task.id));

  // 恢复 200；未在回收站时彻底删除 → 400。
  const restored = await request(env.base, 'POST', `/api/tasks/${task.id}/restore`, {
    headers: adminHeaders(env),
  });
  assert.equal(restored.status, 200, restored.text);
  assert.equal(restored.json.task.trashed, false);
  const purgeNotTrashed = await request(env.base, 'POST', `/api/tasks/${task.id}/purge`, {
    headers: adminHeaders(env),
  });
  assert.equal(purgeNotTrashed.status, 400);
  assert.match(purgeNotTrashed.text, /只能彻底删除回收站中的任务/);

  // 再次回收后彻底删除 200，随后任务 404。
  const retrashed = await request(env.base, 'POST', `/api/tasks/${task.id}/trash`, {
    headers: adminHeaders(env),
  });
  assert.equal(retrashed.status, 200, retrashed.text);
  const purged = await request(env.base, 'POST', `/api/tasks/${task.id}/purge`, {
    headers: adminHeaders(env),
  });
  assert.equal(purged.status, 200, purged.text);
  assert.equal(purged.json.ok, true);
  assert.ok(purged.json.deleted.includes(task.id));
  const gone = await request(env.base, 'GET', `/api/tasks/${task.id}`, { headers: adminHeaders(env) });
  assert.equal(gone.status, 404);

  const noTokenPurge = await request(env.base, 'POST', '/api/tasks/task_x/purge');
  assert.equal(noTokenPurge.status, 401);
});

test('trashTask：回收时清除归档状态（归档与回收站互斥）', async (t) => {
  const env = await startTestHub(t);
  const task = env.hub.createTask({ instruction: '已归档任务' });
  markTerminal(env.hub, task.id, 'completed');

  env.hub.archiveTask(env.hub._requireTask(task.id), true);
  assert.equal(env.hub.getTask(task.id).archived, true);

  env.hub.trashTask(env.hub._requireTask(task.id));
  const raw = env.hub.getTask(task.id);
  assert.ok(raw.trashedAt);
  assert.equal(raw.archived, false, '回收时应清除归档标记');
  assert.equal(raw.archivedAt, null);

  env.hub.restoreTask(raw);
  assert.equal(env.hub.getTask(task.id).archived, false, '恢复后保持未归档');
  assert.equal(env.hub.getTask(task.id).trashedAt, null);
});

test('持久化：回收站状态在重启后保留', async (t) => {
  const dataDir = await makeTempDir('butler-trash-persist-');
  let first = null;
  let second = null;
  t.after(async () => {
    if (first) await first.close().catch(() => {});
    if (second) await second.close().catch(() => {});
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  });

  first = await startHubAt(dataDir);
  const task = first.hub.createTask({ instruction: '持久化回收任务' });
  markTerminal(first.hub, task.id, 'cancelled');
  first.hub.trashTask(first.hub._requireTask(task.id));
  const trashedAt = first.hub.getTask(task.id).trashedAt;
  assert.ok(trashedAt);
  await first.hub.flushState();
  await first.close();
  first = null;

  second = await createHub({
    dataDir,
    silent: true,
    persistDebounceMs: 5,
    nightlyReview: false,
  });

  const restored = second.tasks.get(task.id);
  assert.ok(restored, '重启后任务仍在');
  assert.equal(restored.trashedAt, trashedAt, 'trashedAt 应持久化');
  assert.equal(second.listTasks({ limit: 500 }).some((item) => item.id === task.id), false);
  assert.ok(second.listTasks({ includeTrashed: true, limit: 500 }).some((item) => item.id === task.id));
  assert.equal(second.taskToJson(restored).trashed, true);
});
