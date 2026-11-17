'use strict';

/**
 * 管家心路（journal）与 Hub 的集成测试：思考/工作/里程碑/目标检查条目、
 * 每日总结生成与降级、设置更新与调度周期、持久化、SSE 事件、HTTP 接口、历史回填。
 * 契约见 docs/GOAL-BRAIN-DESIGN.md §6。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createHub } = require('../lib/hub.js');
const { DEFAULT_SUMMARY_TIME, journalModelConfig, localDateKey } = require('../lib/journal.js');
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
  readStateFile,
} = require('./_helpers.js');

const MODEL_ENV_KEYS = [
  'BRAIN_API_KEY',
  'AGNES_API_KEY',
  'BUTLER_AGNES_API_KEY',
  'BRAIN_BASE_URL',
  'AGNES_BASE_URL',
  'BRAIN_MODEL',
  'AGNES_MODEL',
  'BRAIN_TIMEOUT_MS',
  'DEEPSEEK_API_KEY',
  'BRAINSTORM_API_KEY',
  'BRAINSTORM_BASE_URL',
  'BRAINSTORM_MODEL',
];

/** 临时清空/设置模型相关环境变量，结束后恢复（宿主机可能配置了真实密钥）。 */
async function withModelEnv(values, fn) {
  const saved = new Map();
  for (const key of MODEL_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const key of MODEL_ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** 用临时目录创建一个不监听端口的 Hub（定时器拉到 1 小时，避免测试期间自动触发）。 */
async function newHub(t, overrides = {}) {
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'butler-journal-hub-'));
  const hub = await createHub({
    dataDir,
    silent: true,
    persistDebounceMs: 5,
    nightlyReview: false,
    goalTickMs: 3600000,
    brainTickMs: 3600000,
    ...overrides,
  });
  t.after(async () => {
    await hub.close();
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  });
  return hub;
}

function thinkReply(summary, extra = {}) {
  return JSON.stringify({ summary, ...extra });
}

function findEntry(hub, predicate) {
  return hub.journal.entries.find(predicate) || null;
}

// ---------------------------------------------------------------- 思考条目

test('自主大脑思考写入心路思考条目，低信息量「无需动作」不记录', async (t) => {
  let mode = 'ok';
  let calls = 0;
  const hub = await newHub(t, {
    brainThink: async () => {
      calls += 1;
      if (mode === 'fail') throw new Error('模型超时');
      if (mode === 'quiet') return thinkReply('无需动作', { actions: [] });
      return thinkReply('准备继续推进求职目标', {
        actions: [{ action: 'none', reason: '保持观察', confidence: 0.9 }],
      });
    },
  });

  const decision = await hub.requestBrainThink({ trigger: 'manual' });
  assert.equal(decision.error, null);
  const entry = findEntry(hub, (item) => item.refs.decisionId === decision.id);
  assert.ok(entry, '应写入思考条目');
  assert.equal(entry.kind, 'thought');
  assert.match(entry.title, /^思考：准备继续推进求职目标/);
  assert.equal(entry.meta.trigger, 'manual');
  assert.equal(entry.meta.mode, 'auto');
  assert.match(entry.text, /none/);
  assert.match(entry.text, /跳过：无需动作/);

  mode = 'fail';
  const failed = await hub.requestBrainThink({ trigger: 'manual' });
  assert.match(failed.error, /模型超时/);
  const failEntry = findEntry(hub, (item) => item.refs.decisionId === failed.id);
  assert.ok(failEntry, '思考失败也应记录');
  assert.match(failEntry.title, /^思考失败：模型超时/);
  assert.equal(failEntry.meta.error, '模型超时');

  mode = 'quiet';
  const before = hub.journal.entries.length;
  const quiet = await hub.requestBrainThink({ trigger: 'manual' });
  assert.equal(quiet.error, null);
  assert.equal(hub.journal.entries.length, before, '无动作且无需关注时不应写日志');
  assert.equal(calls, 3);
});

// ---------------------------------------------------------------- 任务工作条目

test('任务结束写入工作条目（包含输出与设备信息）', async (t) => {
  const env = await startTestHub(t);
  const device = await registerDevice(env, makeManifest({ name: '报表设备' }));
  const task = await createTask(env, { instruction: '整理本周报表' });
  await waitFor(() => env.hub.getTask(task.id).status === 'assigned', { label: '任务分配' });
  await ackTask(env, device, task.id);
  await resultTask(env, device, task.id, { ok: true, output: { text: '报表已生成' } });
  await waitFor(() => env.hub.getTask(task.id).status === 'completed', { label: '任务完成' });

  const entry = findEntry(env.hub, (item) => item.refs.taskId === task.id);
  assert.ok(entry, '应写入任务工作条目');
  assert.equal(entry.kind, 'work');
  assert.equal(entry.title, '任务完成：整理本周报表');
  assert.match(entry.text, /报表已生成/);
  assert.match(entry.text, /设备：报表设备/);
  assert.equal(entry.meta.taskStatus, 'completed');
  assert.equal(entry.meta.isPlan, false);
  assert.equal(entry.meta.device, '报表设备');
});

test('计划出现卡点时写入里程碑条目', async (t) => {
  const env = await startTestHub(t, {
    planner: async () => ({
      title: '季度报告',
      subtasks: [
        { instruction: '第一步：收集数据' },
        { instruction: '第二步：汇总成文', dependsOn: [0] },
      ],
    }),
  });
  const device = await registerDevice(env, makeManifest());
  const plan = await createTask(env, { instruction: '写一份季度报告', split: true });
  assert.equal(plan.isPlan, true);
  await waitFor(() => env.hub.getTask(plan.id).childTaskIds.length === 2, { label: '子任务创建' });
  const firstChildId = env.hub.getTask(plan.id).childTaskIds[0];
  await waitFor(() => env.hub.getTask(firstChildId).status === 'assigned', {
    label: '第一个子任务分配',
  });
  await ackTask(env, device, firstChildId);
  await resultTask(env, device, firstChildId, { ok: false, error: '数据源不可用' });
  await waitFor(() => Boolean(env.hub.getTask(plan.id).progress?.blocked), { label: '计划卡点' });

  const entry = findEntry(env.hub, (item) => item.kind === 'milestone');
  assert.ok(entry, '应写入里程碑条目');
  assert.match(entry.title, /^计划卡点：写一份季度报告/);
  assert.match(entry.text, /^卡点：第 1 步/);
  assert.equal(entry.refs.taskId, plan.id);
  assert.equal(typeof entry.meta.percent, 'number');
});

test('目标关联与跟进回写目标视角的工作条目', async (t) => {
  const env = await startTestHub(t);
  const device = await registerDevice(env, makeManifest());
  const goalRes = await request(env.base, 'POST', '/api/goals', {
    headers: adminHeaders(env),
    body: { title: '求职目标', schedule: { type: 'interval', minutes: 60 } },
  });
  assert.equal(goalRes.status, 200, goalRes.text);
  const goal = goalRes.json.goal;
  const task = await createTask(env, { instruction: '投递简历' });
  const linkRes = await request(env.base, 'POST', `/api/goals/${goal.id}/link`, {
    headers: adminHeaders(env),
    body: { taskId: task.id },
  });
  assert.equal(linkRes.status, 200, linkRes.text);

  await waitFor(() => env.hub.getTask(task.id).status === 'assigned', { label: '任务分配' });
  await ackTask(env, device, task.id);
  await resultTask(env, device, task.id, { ok: true, output: { text: '已投递 3 家公司' } });
  await waitFor(() => env.hub.getGoal(goal.id).checks.length === 1, { label: '目标检查回写' });

  const linkEntry = findEntry(env.hub, (item) => item.meta && item.meta.action === 'link');
  assert.ok(linkEntry, '关联动作应写日志');
  assert.match(linkEntry.title, /^关联任务到目标「求职目标」/);
  assert.equal(linkEntry.refs.goalId, goal.id);
  assert.equal(linkEntry.refs.taskId, task.id);
  assert.match(linkEntry.text, /投递简历/);

  const checkEntry = findEntry(
    env.hub,
    (item) => item.refs.goalId === goal.id && item.refs.taskId === task.id && /跟进/.test(item.title),
  );
  assert.ok(checkEntry, '目标跟进应写日志');
  assert.equal(checkEntry.kind, 'work');
  assert.equal(checkEntry.title, '目标「求职目标」跟进：任务完成');
  assert.equal(checkEntry.meta.goalStatus, 'active');
  assert.equal(checkEntry.meta.taskStatus, 'completed');
  assert.match(checkEntry.text, /已投递 3 家公司/);
});

// ---------------------------------------------------------------- 每日总结

test('每日总结：模型生成、复用与强制重生成', async (t) => {
  let calls = 0;
  const hub = await newHub(t, {
    journalThink: async () => {
      calls += 1;
      return thinkReply('## 今日推进\n完成报表。', {
        highlights: [{ text: '完成报表', category: '推进' }],
        verdict: '稳步推进',
      });
    },
  });
  hub.appendJournalEntry({ kind: 'work', title: '完成周报', text: '报表已生成' });

  const first = await hub.generateJournalSummary({ force: true });
  assert.equal(first.error, null);
  assert.ok(first.day, '应生成当日总结');
  assert.match(first.day.summary, /今日推进/);
  assert.equal(first.day.highlights[0].text, '完成报表');
  assert.equal(first.day.verdict, '稳步推进');
  assert.ok(first.day.stats.total >= 1);
  assert.match(first.day.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(first.day.date, hub.getJournal().today);
  assert.equal(hub.journal.lastSummaryDate, first.day.date);
  assert.equal(hub.journal.days[first.day.date].summary, first.day.summary);
  assert.equal(first.day.model, journalModelConfig().model);
  const daily = hub.journal.entries.filter((item) => item.kind === 'daily');
  assert.equal(daily.length, 1);
  assert.equal(daily[0].text, first.day.summary);
  assert.deepEqual(daily[0].refs, {});
  assert.equal(daily[0].title, `每日总结：${first.day.date}`);

  const callsAfterFirst = calls;
  const second = await hub.generateJournalSummary();
  assert.equal(second.error, null);
  assert.equal(second.day.generatedAt, first.day.generatedAt, '未强制时应复用当天总结');
  assert.equal(calls, callsAfterFirst);

  const third = await hub.generateJournalSummary({ force: true });
  assert.equal(calls, callsAfterFirst + 1);
  assert.ok(third.day.generatedAt >= first.day.generatedAt);
  assert.equal(hub.journal.entries.filter((item) => item.kind === 'daily').length, 2);
});

test('每日总结：模型失败时降级为本地汇总且不抛错', async (t) => {
  const hub = await newHub(t, {
    journalThink: async () => {
      throw new Error('模型超时');
    },
  });
  hub.appendJournalEntry({ kind: 'work', title: '完成周报' });

  const result = await hub.generateJournalSummary({ force: true });
  assert.ok(result.day);
  assert.equal(result.error, '模型超时');
  assert.equal(result.day.error, '模型超时');
  assert.match(result.day.summary, /管家总结/);
  assert.equal(result.day.model, journalModelConfig().model);
});

test('每日总结：未配置模型时降级为本地汇总且不抛错', async (t) => {
  await withModelEnv({}, async () => {
    const hub = await newHub(t);
    hub.appendJournalEntry({ kind: 'work', title: '离线推进' });
    const result = await hub.generateJournalSummary({ force: true });
    assert.match(result.error || '', /未配置自主大脑模型/);
    assert.match(result.day.summary, /管家总结/);
  });
});

// ---------------------------------------------------------------- 设置 / 周期

test('设置更新与每日总结周期：PATCH 校验、禁用不生成、开启后手动周期生成', async (t) => {
  const env = await startTestHub(t, {
    journalThink: async () => thinkReply('周期总结内容'),
  });
  const bad = await request(env.base, 'PATCH', '/api/journal', {
    headers: adminHeaders(env),
    body: { summaryTime: '25:00' },
  });
  assert.equal(bad.status, 400, bad.text);
  assert.match(bad.text, /summaryTime/);

  const disabled = await request(env.base, 'PATCH', '/api/journal', {
    headers: adminHeaders(env),
    body: { enabled: false, summaryTime: '00:00' },
  });
  assert.equal(disabled.status, 200, disabled.text);
  assert.equal(disabled.json.journal.enabled, false);
  assert.equal(await env.hub.runJournalCycle(), null);

  const enabled = await request(env.base, 'PATCH', '/api/journal', {
    headers: adminHeaders(env),
    body: { enabled: true, summaryTime: '00:00' },
  });
  assert.equal(enabled.status, 200, enabled.text);
  assert.equal(enabled.json.journal.enabled, true);

  const generated = await env.hub.runJournalCycle();
  assert.ok(generated && generated.day, '开启后应生成本地总结');
  assert.match(generated.day.summary, /周期总结内容/);

  await waitFor(
    async () => {
      const state = await readStateFile(env.dataDir);
      return state.journal && state.journal.summaryTime === '00:00';
    },
    { label: 'state.json 保存管家心路设置' },
  );
});

// ---------------------------------------------------------------- 持久化 / 事件

test('管家心路持久化：serializeState 包含 journal，重启后恢复', async (t) => {
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'butler-journal-persist-'));
  t.after(async () => {
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  });
  const hub = await createHub({
    dataDir,
    silent: true,
    persistDebounceMs: 5,
    nightlyReview: false,
    goalTickMs: 3600000,
    brainTickMs: 3600000,
  });
  const entry = hub.appendJournalEntry({ kind: 'thought', title: '恢复测试思考', text: '细节' });
  hub.updateJournal({ summaryTime: '22:15' });

  const state = hub.serializeState();
  assert.equal(state.journal.summaryTime, '22:15');
  assert.ok(state.journal.entries.some((item) => item.id === entry.id));
  await hub.flushState();
  await hub.close();

  const reopened = await createHub({
    dataDir,
    silent: true,
    persistDebounceMs: 5,
    nightlyReview: false,
    goalTickMs: 3600000,
    brainTickMs: 3600000,
  });
  t.after(async () => {
    await reopened.close();
  });
  assert.equal(reopened.getJournal().summaryTime, '22:15');
  const restored = reopened.journal.entries.find((item) => item.id === entry.id);
  assert.ok(restored, '重启后应恢复日志条目');
  assert.equal(restored.title, '恢复测试思考');
});

test('appendJournalEntry 的 SSE 更新不写入常规事件记录', async (t) => {
  const hub = await newHub(t);
  const before = hub.events.length;
  hub.appendJournalEntry({ kind: 'thought', title: '测试思考' });
  assert.equal(hub.events.length, before);
  assert.equal(hub.events.some((event) => event.type === 'journal.updated'), false);
});

// ---------------------------------------------------------------- HTTP 接口

test('HTTP：GET /api/journal 支持限额与日期过滤，PATCH 更新设置', async (t) => {
  const env = await startTestHub(t);
  const res = await request(env.base, 'GET', '/api/journal?days=10&entries=3', {
    headers: adminHeaders(env),
  });
  assert.equal(res.status, 200, res.text);
  const { journal, entries, hubTime } = res.json;
  assert.equal(journal.enabled, true);
  assert.equal(journal.summaryTime, DEFAULT_SUMMARY_TIME);
  assert.match(journal.today, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(journal.timeZone, /./);
  assert.match(journal.nowTime, /^\d{2}:\d{2}$/);
  assert.ok(Array.isArray(journal.days));
  assert.deepEqual(entries, journal.entries);
  assert.equal(typeof hubTime, 'string');

  const old = env.hub.appendJournalEntry({
    at: '2025-12-31T04:00:00.000Z',
    kind: 'work',
    title: '旧条目',
  });
  const filtered = await request(env.base, 'GET', `/api/journal?date=${old.date}`, {
    headers: adminHeaders(env),
  });
  assert.equal(filtered.status, 200, filtered.text);
  assert.ok(filtered.json.entries.length >= 1);
  assert.ok(filtered.json.entries.every((item) => item.date === old.date));
  assert.ok(filtered.json.journal.days.every((day) => day.date === old.date));

  const patch = await request(env.base, 'PATCH', '/api/journal', {
    headers: adminHeaders(env),
    body: { summaryTime: '21:40' },
  });
  assert.equal(patch.status, 200, patch.text);
  assert.equal(patch.json.journal.summaryTime, '21:40');

  const one = await request(env.base, 'GET', '/api/journal?entries=1', {
    headers: adminHeaders(env),
  });
  assert.equal(one.status, 200, one.text);
  assert.equal(one.json.entries.length, 1);

  const unauthorized = await request(env.base, 'GET', '/api/journal');
  assert.equal(unauthorized.status, 401);
});

test('HTTP：POST /api/journal/summary 生成当日总结，GET 返回 404', async (t) => {
  const env = await startTestHub(t, {
    journalThink: async () => thinkReply('HTTP 总结内容'),
  });
  env.hub.appendJournalEntry({ kind: 'work', title: 'HTTP 前提条目' });
  const res = await request(env.base, 'POST', '/api/journal/summary', {
    headers: adminHeaders(env),
    body: { force: true },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.error, null);
  assert.match(res.json.day.summary, /HTTP 总结内容/);
  assert.equal(typeof res.json.hubTime, 'string');

  const wrongMethod = await request(env.base, 'GET', '/api/journal/summary', {
    headers: adminHeaders(env),
  });
  assert.equal(wrongMethod.status, 404);
  const unauthorized = await request(env.base, 'POST', '/api/journal/summary', {
    body: { force: true },
  });
  assert.equal(unauthorized.status, 401);
});

// ---------------------------------------------------------------- 历史回填

test('历史回填：从当天任务与大脑决策生成条目且不重复', async (t) => {
  const env = await startTestHub(t);
  const device = await registerDevice(env, makeManifest());
  const task = await createTask(env, { instruction: '完成一次资料整理' });
  await waitFor(() => env.hub.getTask(task.id).status === 'assigned', { label: '任务分配' });
  await ackTask(env, device, task.id);
  await resultTask(env, device, task.id, { ok: true, output: { text: '资料已整理' } });
  await waitFor(() => env.hub.getTask(task.id).status === 'completed', { label: '任务完成' });

  env.hub.journal.entries = [];
  env.hub.journal.days = {};
  env.hub._seedJournalFromHistory();

  const seeded = env.hub.journal.entries.filter((item) => item.meta && item.meta.seeded);
  assert.ok(seeded.length >= 1, '应回填历史条目');
  const workEntry = seeded.find((item) => item.refs.taskId === task.id && item.kind === 'work');
  assert.ok(workEntry, '应回填当天完成的任务');
  assert.equal(workEntry.title, '任务完成：完成一次资料整理');
  assert.match(workEntry.text, /资料已整理/);
  const today = localDateKey();
  assert.ok(env.hub.journal.days[today]);
  assert.equal(env.hub.journal.days[today].entryCount, env.hub.journal.entries.length);

  const count = env.hub.journal.entries.length;
  env.hub._seedJournalFromHistory();
  assert.equal(env.hub.journal.entries.length, count, '重复回填不应产生重复条目');
});
