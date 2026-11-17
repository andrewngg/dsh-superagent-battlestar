'use strict';

/**
 * 自适应思考节律 + 六步思考协议（docs/GOAL-BRAIN-DESIGN.md §8）测试。
 *
 * 纯函数部分覆盖 brain.js 的新导出；集成部分用 createHub 临时 dataDir +
 * 注入 brainThink，验证 Hub 的跳过/退避/节律重置/ownerAsk/持久化/心路行为。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  BRAIN_ASSESSMENT_KEYS,
  DEFAULT_BRAIN,
  MAX_IDLE_SEC,
  MAX_ASSESSMENT_LENGTH,
  MAX_OWNER_ASK_LENGTH,
  normalizeBrainPatch,
  normalizeAssessment,
  normalizeOwnerAsk,
  restoreBrain,
  computeNextThinkAt,
  effectiveIntervalSec,
  brainToJson,
  buildBrainPrompt,
  parseBrainReply,
} = require('../lib/brain.js');
const { createHub } = require('../lib/hub.js');
const { startTestHub, request, adminHeaders } = require('./_helpers.js');

const ASSESSMENT = {
  goals: '求职目标仍是主线',
  progress: '投递计划 2/5',
  betterWay: '先重试卡住的步骤再继续',
  improvement: '失败步骤重试不够及时',
  myMove: '重试第 3 步投递',
  ownerAsk: '',
};

function stepReply({ assessment, summary, actions, ownerAsk } = {}) {
  const merged = { ...ASSESSMENT };
  for (const key of BRAIN_ASSESSMENT_KEYS) {
    if (assessment && assessment[key] !== undefined) merged[key] = assessment[key];
  }
  if (ownerAsk !== undefined) merged.ownerAsk = ownerAsk;
  return JSON.stringify({
    assessment: merged,
    summary: summary === undefined ? '先重试卡住的投递步骤' : summary,
    actions: actions || [],
  });
}

function makeThinker(text, captured = []) {
  return async (prompt) => {
    captured.push(prompt);
    return typeof text === 'function' ? text(prompt) : text;
  };
}

async function newHub(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-brain-adaptive-'));
  const hub = await createHub({
    dataDir,
    silent: true,
    persistDebounceMs: 5,
    nightlyReview: false,
    brainTickMs: 3600000,
    goalTickMs: 3600000,
    ...overrides,
  });
  t.after(async () => {
    try {
      await hub.close();
    } catch {
      /* 已关闭 */
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return hub;
}

function isoNowOffsetMs(ms) {
  return new Date(Date.now() + ms).toISOString();
}

// ------------------------------------------------------------------ 纯函数

test('normalizeAssessment：六项逐字段截断，全空返回 null，忽略额外字段', () => {
  assert.equal(normalizeAssessment(null), null);
  assert.equal(normalizeAssessment('text'), null);
  assert.equal(normalizeAssessment({ goals: '   ' }), null);
  assert.equal(normalizeAssessment({ goals: 42 }), null);

  const assessment = normalizeAssessment({
    goals: '  求职目标  ',
    progress: '投递 2/5',
    betterWay: '',
    extra: '忽略我',
  });
  assert.deepEqual(assessment, {
    goals: '求职目标',
    progress: '投递 2/5',
    betterWay: '',
    improvement: '',
    myMove: '',
    ownerAsk: '',
  });

  const long = normalizeAssessment({ goals: 'x'.repeat(MAX_ASSESSMENT_LENGTH + 50) });
  assert.equal(long.goals.length, MAX_ASSESSMENT_LENGTH);
});

test('normalizeOwnerAsk：字符串/对象归一化，空值返回 null，超长截断', () => {
  assert.equal(normalizeOwnerAsk(null), null);
  assert.equal(normalizeOwnerAsk(undefined), null);
  assert.equal(normalizeOwnerAsk('   '), null);
  assert.equal(normalizeOwnerAsk({ text: '  ' }), null);
  assert.equal(normalizeOwnerAsk(42), null);

  const fromString = normalizeOwnerAsk('  请确认是否优先投广州岗位  ');
  assert.equal(fromString.text, '请确认是否优先投广州岗位');
  assert.match(fromString.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(fromString.goalId, null);

  const fromObject = normalizeOwnerAsk({
    text: '请确认方向',
    at: '2026-01-01T00:00:00.000Z',
    goalId: 'goal_1',
  });
  assert.deepEqual(fromObject, {
    text: '请确认方向',
    at: '2026-01-01T00:00:00.000Z',
    goalId: 'goal_1',
    options: null,
  });

  const long = normalizeOwnerAsk('y'.repeat(MAX_OWNER_ASK_LENGTH + 100));
  assert.equal(long.text.length, MAX_OWNER_ASK_LENGTH);
  // goalId 非字符串按 null 处理
  assert.equal(normalizeOwnerAsk({ text: 'x', goalId: 42 }).goalId, null);
});

test('normalizeBrainPatch：adaptive 与 ownerAskAck 的校验与合并', () => {
  assert.deepEqual(normalizeBrainPatch({ adaptive: false }).value, { adaptive: false });
  assert.deepEqual(normalizeBrainPatch({ ownerAskAck: true }).value, { ownerAskAck: true });
  // false 表示「不确认」，不产生字段
  assert.deepEqual(normalizeBrainPatch({ ownerAskAck: false }).value, {});
  assert.deepEqual(
    normalizeBrainPatch({ adaptive: true, ownerAskAck: true, intervalSec: 240 }).value,
    { intervalSec: 240, adaptive: true, ownerAskAck: true },
  );

  const badAdaptive = normalizeBrainPatch({ adaptive: 'yes' });
  assert.equal(badAdaptive.ok, false);
  assert.match(badAdaptive.errors[0], /adaptive 必须是布尔值/);

  const badAck = normalizeBrainPatch({ ownerAskAck: 'yes' });
  assert.equal(badAck.ok, false);
  assert.match(badAck.errors[0], /ownerAskAck 必须是布尔值/);

  const badBoth = normalizeBrainPatch({ adaptive: 1, ownerAskAck: 0 });
  assert.equal(badBoth.ok, false);
  assert.equal(badBoth.errors.length, 2);

  // ownerAskAck 不是持久化状态字段
  assert.equal('ownerAskAck' in DEFAULT_BRAIN, false);
});

test('restoreBrain：自适应新字段容错恢复（裁剪 + 归一化）', () => {
  const restored = restoreBrain({
    intervalSec: 300,
    adaptive: false,
    idleStreak: 99,
    effectiveIntervalSec: 3000,
    nextThinkAt: '2026-02-01T00:00:00.000Z',
    skippedCycles: 5000,
    lastAssessment: { goals: ' 求职目标 ', progress: '', betterWay: '', improvement: '', myMove: '', ownerAsk: '' },
    ownerAsk: ' 请确认是否投递 B 公司 ',
    decisions: [
      {
        id: 'brain_1',
        at: '2026-01-31T00:00:00.000Z',
        summary: '六步思考',
        assessment: { goals: 'g', progress: 'p', betterWay: '', improvement: '', myMove: '', ownerAsk: '' },
        ownerAsk: { text: '请授权', at: '2026-01-31T00:00:00.000Z', goalId: 'goal_1' },
        actions: [],
      },
    ],
  });
  assert.equal(restored.adaptive, false);
  assert.equal(restored.idleStreak, 20); // 上限 20
  assert.equal(restored.effectiveIntervalSec, MAX_IDLE_SEC); // 上限 1800
  assert.equal(restored.nextThinkAt, '2026-02-01T00:00:00.000Z');
  assert.equal(restored.skippedCycles, 1000); // 上限 1000
  assert.deepEqual(restored.lastAssessment, {
    goals: '求职目标',
    progress: '',
    betterWay: '',
    improvement: '',
    myMove: '',
    ownerAsk: '',
  });
  assert.equal(restored.ownerAsk.text, '请确认是否投递 B 公司');
  assert.equal(restored.ownerAsk.goalId, null);
  assert.equal(restored.decisions.length, 1);
  assert.equal(restored.decisions[0].assessment.goals, 'g');
  assert.deepEqual(restored.decisions[0].ownerAsk, {
    text: '请授权',
    at: '2026-01-31T00:00:00.000Z',
    goalId: 'goal_1',
    options: null,
  });

  // 非法值回退
  const fallback = restoreBrain({
    adaptive: 'yes',
    idleStreak: -5,
    effectiveIntervalSec: 'abc',
    nextThinkAt: 42,
    skippedCycles: -3,
    lastAssessment: { goals: '' },
    ownerAsk: { text: '  ' },
  });
  assert.equal(fallback.adaptive, true);
  assert.equal(fallback.idleStreak, 0);
  assert.equal(fallback.effectiveIntervalSec, fallback.intervalSec);
  assert.equal(fallback.nextThinkAt, null);
  assert.equal(fallback.skippedCycles, 0);
  assert.equal(fallback.lastAssessment, null);
  assert.equal(fallback.ownerAsk, null);

  // 小于基准间隔的持久化值在对外 JSON 中会被夹回基准间隔
  const low = restoreBrain({ intervalSec: 300, effectiveIntervalSec: 100 });
  assert.equal(brainToJson(low).effectiveIntervalSec, 300);
});

test('effectiveIntervalSec / computeNextThinkAt：自适应间隔与显式 nextThinkAt 优先', () => {
  const brain = restoreBrain({
    intervalSec: 300,
    effectiveIntervalSec: 600,
    adaptive: true,
    lastThinkAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(effectiveIntervalSec(brain), 600);
  assert.equal(computeNextThinkAt(brain), '2026-01-01T00:10:00.000Z');

  // 关闭自适应时一律用基准 intervalSec
  const fixed = { ...brain, adaptive: false };
  assert.equal(effectiveIntervalSec(fixed), 300);
  assert.equal(computeNextThinkAt(fixed), '2026-01-01T00:05:00.000Z');

  // 显式 nextThinkAt 优先于 lastThinkAt + 间隔
  const scheduled = { ...brain, nextThinkAt: '2026-01-01T00:20:00.000Z' };
  assert.equal(computeNextThinkAt(scheduled), '2026-01-01T00:20:00.000Z');
  assert.equal(computeNextThinkAt({ ...scheduled, nextThinkAt: 'bad-date' }), '2026-01-01T00:10:00.000Z');

  // 间隔下限为基准、上限为 MAX_IDLE_SEC
  assert.equal(effectiveIntervalSec({ ...brain, effectiveIntervalSec: 50 }), 300);
  assert.equal(effectiveIntervalSec({ ...brain, effectiveIntervalSec: 9000 }), MAX_IDLE_SEC);
});

test('brainToJson：输出自适应新字段与六步结论（深拷贝）', () => {
  const brain = restoreBrain({
    adaptive: false,
    intervalSec: 240,
    idleStreak: 3,
    skippedCycles: 7,
    lastThinkAt: '2026-01-01T00:00:00.000Z',
    lastAssessment: { goals: '主线目标' },
    ownerAsk: '请确认优先级',
  });
  const json = brainToJson(brain);
  assert.equal(json.adaptive, false);
  assert.equal(json.effectiveIntervalSec, 240);
  assert.equal(json.idleStreak, 3);
  assert.equal(json.skippedCycles, 7);
  assert.equal(json.lastAssessment.goals, '主线目标');
  assert.equal(json.ownerAsk.text, '请确认优先级');
  assert.equal(json.nextThinkAt, '2026-01-01T00:04:00.000Z');

  // 对外 JSON 是深拷贝，外部修改不会污染大脑状态
  json.lastAssessment.goals = 'hacked';
  json.ownerAsk.text = 'hacked';
  assert.equal(brain.lastAssessment.goals, '主线目标');
  assert.equal(brain.ownerAsk.text, '请确认优先级');
});

test('parseBrainReply：六步 assessment 与 ownerAsk 归一化', () => {
  const reply = JSON.stringify({
    assessment: { ...ASSESSMENT, ownerAsk: '请确认是否优先投广州岗位' },
    summary: '先重试卡住的投递步骤',
    actions: [],
  });
  const parsed = parseBrainReply(reply);
  assert.equal(parsed.summary, '先重试卡住的投递步骤');
  assert.deepEqual(parsed.actions, []);
  assert.deepEqual(parsed.assessment, { ...ASSESSMENT, ownerAsk: '请确认是否优先投广州岗位' });
  assert.equal(parsed.ownerAsk.text, '请确认是否优先投广州岗位');
  assert.equal(parsed.ownerAsk.goalId, null);
  assert.match(parsed.ownerAsk.at, /^\d{4}-\d{2}-\d{2}T/);

  // 兼容旧的顶层 ownerAsk 字符串
  const legacy = parseBrainReply(JSON.stringify({ summary: '关联任务', ownerAsk: '请授权我关联任务' }));
  assert.equal(legacy.assessment, null);
  assert.equal(legacy.ownerAsk.text, '请授权我关联任务');

  // assessment 内 ownerAsk 为空且无顶层 ownerAsk → null
  const noAsk = parseBrainReply(JSON.stringify({ assessment: { ...ASSESSMENT, ownerAsk: '' }, summary: '继续观察' }));
  assert.equal(noAsk.ownerAsk, null);
  assert.equal(noAsk.assessment.goals, ASSESSMENT.goals);

  // 只有 assessment（无 summary / actions）也合法
  const onlyAssessment = parseBrainReply(
    JSON.stringify({ assessment: { ...ASSESSMENT, goals: '只填目标' } }),
  );
  assert.equal(onlyAssessment.summary, '');
  assert.equal(onlyAssessment.assessment.goals, '只填目标');

  // 全空仍抛错
  assert.throws(() => parseBrainReply(JSON.stringify({ summary: '', actions: [], assessment: {} })), /大脑没有给出任何结论或动作/);
});

test('buildBrainPrompt：系统提示要求六步思考与 assessment 结构', () => {
  const prompt = buildBrainPrompt({});
  assert.match(prompt.system, /六步/);
  assert.match(prompt.system, /"assessment"/);
  for (const key of BRAIN_ASSESSMENT_KEYS) {
    assert.match(prompt.system, new RegExp(key));
  }
  assert.match(prompt.system, /ownerAsk/);
  assert.match(prompt.user, /assessment/);

  const withGoal = buildBrainPrompt({
    goals: [{ id: 'goal_1', title: '求职', status: 'active', schedule: { type: 'daily', time: '09:30' } }],
  });
  assert.match(withGoal.user, /求职（goal_1）/);
});

// ------------------------------------------------------------------ 集成

test('空闲时跳过模型调用并 2 倍退避，封顶 MAX_IDLE_SEC', async (t) => {
  const calls = [];
  const hub = await newHub(t, { brainThink: makeThinker(stepReply(), calls) });

  // 第一次真实思考（无任务/目标/审批/设备）：思考后为空闲节律
  const first = await hub.requestBrainThink({ trigger: 'schedule' });
  assert.equal(first.error, null);
  assert.equal(calls.length, 1);
  assert.equal(hub.brain.decisions.length, 1);
  assert.equal(hub.brain.idleStreak, 1);
  assert.equal(hub.brain.effectiveIntervalSec, 360); // 180 * 2^1
  assert.equal(hub.getBrain().skippedCycles, 0);
  assert.match(hub.getBrain().nextThinkAt, /^\d{4}-\d{2}-\d{2}T/);

  // 到期但无新信号 → 跳过模型调用，退避到 720s
  hub.brain.nextThinkAt = isoNowOffsetMs(-1000);
  const skipped = await hub.runBrainCycle();
  assert.equal(skipped, null);
  assert.equal(calls.length, 1);
  assert.equal(hub.brain.skippedCycles, 1);
  assert.equal(hub.brain.idleStreak, 2);
  assert.equal(hub.brain.effectiveIntervalSec, 720);
  assert.equal(hub.getBrain().effectiveIntervalSec, 720);
  assert.equal(hub.getBrain().nextThinkAt, hub.brain.nextThinkAt);
  assert.ok(
    hub.events.some((event) => event.type === 'brain.updated' && event.data && event.data.skipped === true),
    '跳过时应广播 brain.updated {skipped:true}',
  );

  // 空闲封顶：idleStreak 到 20、间隔 1800
  hub.brain.idleStreak = 25;
  hub.brain.nextThinkAt = isoNowOffsetMs(-1000);
  await hub.runBrainCycle();
  assert.equal(calls.length, 1);
  assert.equal(hub.brain.idleStreak, 20);
  assert.equal(hub.brain.effectiveIntervalSec, MAX_IDLE_SEC);
  assert.equal(hub.brain.skippedCycles, 2);
});

test('有活时不跳过思考，节律回到基准间隔', async (t) => {
  const calls = [];
  const hub = await newHub(t, { brainThink: makeThinker(stepReply(), calls) });

  // 一个可重试的失败任务 = 有活
  const task = hub.createTask({ instruction: '整理投递记录' });
  hub._finishTask(hub.getTask(task.id), 'failed', { error: '网络超时' });
  assert.equal(hub.getTask(task.id).attempts, 0);

  const first = await hub.requestBrainThink();
  assert.equal(first.error, null);
  assert.equal(calls.length, 1);
  assert.equal(hub.brain.idleStreak, 0);
  assert.equal(hub.brain.effectiveIntervalSec, hub.brain.intervalSec);

  hub.brain.nextThinkAt = isoNowOffsetMs(-1000);
  const decision = await hub.runBrainCycle();
  assert.ok(decision, '有活时 runBrainCycle 应真的调用模型');
  assert.equal(decision.trigger, 'schedule');
  assert.equal(calls.length, 2);
  assert.equal(hub.brain.idleStreak, 0);
  assert.equal(hub.brain.effectiveIntervalSec, hub.brain.intervalSec);
});

test('执行动作后按基准间隔排期（idleStreak 归零）', async (t) => {
  const calls = [];
  let failedTaskId = null;
  const hub = await newHub(t, {
    brainThink: makeThinker(
      () => stepReply({
        summary: '重试失败的投递任务',
        actions: [{ action: 'retry_task', taskId: failedTaskId, reason: '还有重试次数', confidence: 0.8 }],
      }),
      calls,
    ),
  });

  const task = hub.createTask({ instruction: '投递简历' });
  hub._finishTask(hub.getTask(task.id), 'failed', { error: '网络超时' });
  failedTaskId = task.id;

  const decision = await hub.requestBrainThink();
  assert.equal(decision.error, null);
  assert.equal(decision.actions.length, 1);
  assert.equal(decision.actions[0].executed, true);
  assert.equal(hub.getTask(task.id).status, 'queued');
  assert.equal(hub.brain.idleStreak, 0);
  assert.equal(hub.brain.effectiveIntervalSec, hub.brain.intervalSec);
  const nextThinkAt = Date.parse(hub.brain.nextThinkAt);
  assert.ok(Number.isFinite(nextThinkAt));
  const expected = Date.now() + hub.brain.intervalSec * 1000;
  assert.ok(Math.abs(nextThinkAt - expected) < 5000, 'nextThinkAt 应按基准间隔排期');
});

test('ownerAsk 写入大脑状态、决策历史与持久化，ownerAskAck 清除', async (t) => {
  const hub = await newHub(t, {
    brainThink: makeThinker(
      stepReply({ ownerAsk: '请确认是否投递 B 公司，授权备用账号' }),
    ),
  });

  const decision = await hub.requestBrainThink();
  assert.equal(decision.ownerAsk.text, '请确认是否投递 B 公司，授权备用账号');
  assert.equal(hub.brain.ownerAsk.text, '请确认是否投递 B 公司，授权备用账号');
  assert.equal(hub.getBrain().ownerAsk.text, '请确认是否投递 B 公司，授权备用账号');
  assert.equal(hub.getBrain().lastAssessment.goals, ASSESSMENT.goals);
  assert.equal(hub.listBrainDecisions(1)[0].ownerAsk.text, '请确认是否投递 B 公司，授权备用账号');
  assert.equal(hub.serializeState().brain.ownerAsk.text, '请确认是否投递 B 公司，授权备用账号');

  // 校验：类型错误拒绝；ownerAskAck:true 清除
  assert.throws(() => hub.updateBrain({ adaptive: 'yes' }), /adaptive 必须是布尔值/);
  assert.throws(() => hub.updateBrain({ ownerAskAck: 'yes' }), /ownerAskAck 必须是布尔值/);
  const updated = hub.updateBrain({ ownerAskAck: true });
  assert.equal(updated.ownerAsk, null);
  assert.equal(hub.brain.ownerAsk, null);
  assert.equal(hub.serializeState().brain.ownerAsk, null);
});

test('手动思考不受跳过规则影响，但同样更新节律', async (t) => {
  const calls = [];
  const hub = await newHub(t, { brainThink: makeThinker(stepReply(), calls) });

  await hub.requestBrainThink();
  assert.equal(calls.length, 1);

  // 排到很久以后：定时周期不思考
  hub.brain.nextThinkAt = isoNowOffsetMs(3600 * 1000);
  assert.equal(await hub.runBrainCycle(), null);
  assert.equal(calls.length, 1);

  const manual = await hub.requestBrainThink({ trigger: 'manual' });
  assert.equal(calls.length, 2);
  assert.equal(manual.trigger, 'manual');
  assert.equal(hub.brain.decisions.length, 2);
  // 手动思考后节律同样按空闲递增（无活、无动作）
  assert.equal(hub.brain.idleStreak, 2);
  assert.equal(hub.brain.skippedCycles, 0);
});

test('六步思考写入管家心路（含「需要主人」；低信息量思考不记录）', async (t) => {
  let reply = stepReply({ ownerAsk: '请确认投递口径' });
  const hub = await newHub(t, { brainThink: async () => reply });

  await hub.requestBrainThink();
  const thoughts = hub.journal.entries.filter((entry) => entry.kind === 'thought');
  assert.equal(thoughts.length, 1);
  const entry = thoughts[0];
  assert.match(entry.title, /^思考：/);
  assert.match(entry.text, /- 目标：求职目标仍是主线/);
  assert.match(entry.text, /- 进度：投递计划 2\/5/);
  assert.match(entry.text, /- 更好的方式：先重试卡住的步骤再继续/);
  assert.match(entry.text, /- 要改进：失败步骤重试不够及时/);
  assert.match(entry.text, /- 我来推进：重试第 3 步投递/);
  assert.match(entry.text, /- 需要主人：请确认投递口径/);
  assert.equal(entry.meta.ownerAsk, '请确认投递口径');
  assert.ok(entry.refs.decisionId);

  // 低信息量「无需动作」思考不写入心路
  const before = hub.journal.entries.length;
  reply = stepReply({ summary: '无需动作，保持观察', actions: [] });
  await hub.requestBrainThink();
  assert.equal(hub.journal.entries.length, before);
});

test('持久化：重启后恢复自适应节律、六步结论与 ownerAsk', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-brain-adaptive-persist-'));
  let hub1 = null;
  let hub2 = null;
  try {
    hub1 = await createHub({
      dataDir,
      silent: true,
      persistDebounceMs: 5,
      nightlyReview: false,
      brainTickMs: 3600000,
      goalTickMs: 3600000,
      brainThink: makeThinker(stepReply({ ownerAsk: '请确认目标优先级' })),
    });
    await hub1.requestBrainThink();
    hub1.brain.idleStreak = 6;
    hub1.brain.effectiveIntervalSec = 720;
    hub1.brain.skippedCycles = 4;
    hub1.brain.nextThinkAt = '2026-06-01T00:00:00.000Z';

    const persisted = hub1.serializeState().brain;
    assert.equal(persisted.adaptive, true);
    assert.equal(persisted.idleStreak, 6);
    assert.equal(persisted.effectiveIntervalSec, 720);
    assert.equal(persisted.skippedCycles, 4);
    assert.equal(persisted.lastAssessment.goals, ASSESSMENT.goals);
    assert.equal(persisted.ownerAsk.text, '请确认目标优先级');
    assert.equal(persisted.decisions.length, 1);
    assert.equal(persisted.decisions[0].assessment.goals, ASSESSMENT.goals);

    await hub1.flushState();
    await hub1.close();
    hub1 = null;

    hub2 = await createHub({ dataDir, silent: true, brainTickMs: 3600000, goalTickMs: 3600000 });
    const brain = hub2.getBrain();
    assert.equal(brain.adaptive, true);
    assert.equal(brain.idleStreak, 6);
    assert.equal(brain.effectiveIntervalSec, 720);
    assert.equal(brain.skippedCycles, 4);
    assert.equal(brain.nextThinkAt, '2026-06-01T00:00:00.000Z');
    assert.equal(brain.lastAssessment.goals, ASSESSMENT.goals);
    assert.equal(brain.ownerAsk.text, '请确认目标优先级');
    assert.equal(brain.decisions.length, 1);
    assert.equal(brain.decisions[0].assessment.goals, ASSESSMENT.goals);
    assert.equal(brain.decisions[0].ownerAsk.text, '请确认目标优先级');
  } finally {
    if (hub1) await hub1.close().catch(() => {});
    if (hub2) await hub2.close().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('HTTP PATCH /api/brain：adaptive 与 ownerAskAck', async (t) => {
  const env = await startTestHub(t, {
    brainThink: makeThinker(stepReply({ ownerAsk: '请确认方向' })),
  });
  const headers = adminHeaders(env);

  const off = await request(env.base, 'PATCH', '/api/brain', { headers, body: { adaptive: false } });
  assert.equal(off.status, 200, off.text);
  assert.equal(off.json.brain.adaptive, false);
  assert.equal(off.json.brain.effectiveIntervalSec, off.json.brain.intervalSec);

  const on = await request(env.base, 'PATCH', '/api/brain', { headers, body: { adaptive: true, intervalSec: 120 } });
  assert.equal(on.status, 200, on.text);
  assert.equal(on.json.brain.adaptive, true);
  assert.equal(on.json.brain.intervalSec, 120);
  assert.ok(on.json.brain.effectiveIntervalSec >= 120);
  assert.ok(on.json.brain.effectiveIntervalSec <= MAX_IDLE_SEC);

  const badAdaptive = await request(env.base, 'PATCH', '/api/brain', { headers, body: { adaptive: 'yes' } });
  assert.equal(badAdaptive.status, 400);
  assert.match(badAdaptive.text, /adaptive 必须是布尔值/);

  const badAck = await request(env.base, 'PATCH', '/api/brain', { headers, body: { ownerAskAck: 'yes' } });
  assert.equal(badAck.status, 400);
  assert.match(badAck.text, /ownerAskAck 必须是布尔值/);

  // 先思考产生 ownerAsk，再通过 HTTP ack 清除
  const think = await request(env.base, 'POST', '/api/brain/think', { headers, body: {} });
  assert.equal(think.status, 200, think.text);
  assert.equal(think.json.decision.ownerAsk.text, '请确认方向');
  assert.equal(think.json.brain.ownerAsk.text, '请确认方向');

  const ack = await request(env.base, 'PATCH', '/api/brain', { headers, body: { ownerAskAck: true } });
  assert.equal(ack.status, 200, ack.text);
  assert.equal(ack.json.brain.ownerAsk, null);

  const got = await request(env.base, 'GET', '/api/brain', { headers });
  assert.equal(got.status, 200);
  assert.equal(got.json.brain.ownerAsk, null);
  assert.equal(got.json.brain.adaptive, true);
});
