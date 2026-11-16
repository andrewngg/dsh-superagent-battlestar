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
  getTask,
  snapshot,
  waitFor,
  readStateFile,
} = require('./_helpers.js');

// ---------------------------------------------------------------- 工具函数

function thinkReply(summary, actions) {
  return JSON.stringify({ summary, actions: actions || [] });
}

async function createGoal(env, body) {
  const res = await request(env.base, 'POST', '/api/goals', {
    headers: adminHeaders(env),
    body,
  });
  assert.equal(res.status, 200, res.text);
  return res.json.goal;
}

/** 注册一台设备并制造一个失败任务（attempts=1，默认 maxAttempts=2，仍可重试）。 */
async function createFailedTask(env, device, instruction) {
  const created = await createTask(env, { instruction: instruction || '会失败的任务' });
  await ackTask(env, device, created.id);
  await resultTask(env, device, created.id, { ok: false, error: '设备执行失败' });
  await waitFor(() => env.hub.getTask(created.id).status === 'failed', { label: '任务进入 failed' });
  return env.hub.getTask(created.id);
}

// ---------------------------------------------------------------- auto 模式

test('自主大脑 auto 模式：retry_task 重试失败任务并写入决策记录', async (t) => {
  const prompts = [];
  let targetTaskId = null;
  const env = await startTestHub(t, {
    brainThink: async (prompt) => {
      prompts.push(prompt);
      return thinkReply('失败任务还有重试次数，先重试', [
        { action: 'retry_task', taskId: targetTaskId, reason: '还有一次执行机会', confidence: 0.9 },
      ]);
    },
  });

  const device = await registerDevice(env, makeManifest({ name: '大脑重试设备' }));
  const failed = await createFailedTask(env, device, '重试我');
  targetTaskId = failed.id;
  assert.equal(failed.status, 'failed');

  const decision = await env.hub.requestBrainThink({ trigger: 'manual' });
  assert.equal(decision.trigger, 'manual');
  assert.equal(decision.mode, 'auto');
  assert.equal(decision.error, null);
  assert.equal(decision.summary, '失败任务还有重试次数，先重试');
  assert.equal(decision.actions.length, 1);
  assert.equal(decision.actions[0].action, 'retry_task');
  assert.equal(decision.actions[0].taskId, failed.id);
  assert.equal(decision.actions[0].executed, true);
  assert.equal(decision.actions[0].skippedReason, null);

  // 模型真的被调用，并且提示词里带上了任务与目标信息。
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].system, /BattleStar（对战星）的自主管家大脑/);
  assert.match(prompts[0].user, new RegExp(failed.id));

  // 任务被重新排回调度（attempts 在派发时 +1），不再是 failed。
  const retried = env.hub.getTask(failed.id);
  assert.notEqual(retried.status, 'failed');
  assert.ok(['queued', 'assigned', 'running'].includes(retried.status), `unexpected status: ${retried.status}`);

  // 决策落库 & 对外 JSON
  const brain = env.hub.getBrain();
  assert.equal(brain.lastSummary, '失败任务还有重试次数，先重试');
  assert.equal(brain.lastError, null);
  assert.equal(typeof brain.lastThinkAt, 'string');
  assert.equal(brain.decisions.length, 1);
  assert.equal(brain.decisions[0].id, decision.id);
  assert.equal(brain.decisions[0].actions[0].executed, true);

  const history = env.hub.listBrainDecisions(10);
  assert.equal(history.length, 1);
  assert.equal(history[0].id, decision.id);

  // 决策也进入事件流（控制台可观察）。
  const snap = await snapshot(env);
  assert.equal(snap.brain.lastSummary, '失败任务还有重试次数，先重试');
  assert.equal(snap.brain.decisions.length, 1);
});

test('自主大脑 auto 模式：link_task 把已有任务关联到目标', async (t) => {
  const env = await startTestHub(t, {
    brainThink: async () => thinkReply('把投递任务关联到求职目标', [
      { action: 'link_task', goalId: goalId, taskId: taskId, reason: '任务属于该目标', confidence: 0.85 },
    ]),
  });
  const goal = await createGoal(env, { title: '求职目标', description: '找到广州的 AI 工作' });
  const device = await registerDevice(env, makeManifest({ name: '关联设备' }));
  const task = await createTask(env, { instruction: '投递三家公司' });
  await ackTask(env, device, task.id); // 任务执行中，goal.runningTaskId 才会生效
  const goalId = goal.id;
  const taskId = task.id;

  const decision = await env.hub.requestBrainThink();
  assert.equal(decision.actions[0].action, 'link_task');
  assert.equal(decision.actions[0].executed, true);

  const linked = env.hub.getTask(task.id);
  assert.equal(linked.goalId, goal.id);
  assert.equal(env.hub.getGoal(goal.id).runningTaskId, task.id);

  const detail = await request(env.base, 'GET', `/api/goals/${goal.id}`, { headers: adminHeaders(env) });
  assert.equal(detail.status, 200, detail.text);
  assert.equal(detail.json.tasks.length, 1);
  assert.equal(detail.json.tasks[0].id, task.id);
  assert.equal(detail.json.tasks[0].goalId, goal.id);
  assert.equal(detail.json.linkedStats.total, 1);
  assert.equal(detail.json.linkedStats.running, 1);
});

test('自主大脑 auto 模式：低置信度动作只记录不执行', async (t) => {
  const env = await startTestHub(t, {
    brainThink: async () => thinkReply('不确定是否重试', [
      { action: 'retry_task', taskId: targetId, reason: '可能有用', confidence: 0.2 },
    ]),
  });
  const device = await registerDevice(env, makeManifest({ name: '低置信设备' }));
  const failed = await createFailedTask(env, device);
  const targetId = failed.id;

  const decision = await env.hub.requestBrainThink();
  assert.equal(decision.actions[0].executed, false);
  assert.equal(decision.actions[0].skippedReason, 'low-confidence');
  assert.equal(env.hub.getTask(failed.id).status, 'failed');
  // 决策仍然记录 lastSummary。
  assert.equal(env.hub.getBrain().lastSummary, '不确定是否重试');
});

test('自主大脑：mode=suggest 只记录建议，不产生任何变更', async (t) => {
  const env = await startTestHub(t, {
    brainThink: async () => thinkReply('建议重试失败任务', [
      { action: 'retry_task', taskId: targetId, reason: '还有次数', confidence: 0.95 },
    ]),
  });
  const device = await registerDevice(env, makeManifest({ name: '建议模式设备' }));
  const failed = await createFailedTask(env, device);
  const targetId = failed.id;

  await env.hub.updateBrain({ mode: 'suggest' });
  const decision = await env.hub.requestBrainThink({ trigger: 'manual' });
  assert.equal(decision.mode, 'suggest');
  assert.equal(decision.actions.length, 1);
  assert.equal(decision.actions[0].executed, false);
  assert.equal(decision.actions[0].skippedReason, '建议模式（未执行）');
  // 任务没有被重试
  assert.equal(env.hub.getTask(failed.id).status, 'failed');
  assert.equal(env.hub.getTask(failed.id).attempts, 1);
  assert.equal(env.hub.getBrain().decisions.length, 1);
});

test('自主大脑：每轮动作数受 maxActions 限制', async (t) => {
  const env = await startTestHub(t, {
    brainThink: async () =>
      thinkReply('两个任务都重试', [
        { action: 'retry_task', taskId: firstId, reason: 'a', confidence: 0.9 },
        { action: 'retry_task', taskId: secondId, reason: 'b', confidence: 0.9 },
      ]),
  });
  const device = await registerDevice(env, makeManifest({ name: '限额设备' }));
  const first = await createFailedTask(env, device, '任务甲');
  const second = await createFailedTask(env, device, '任务乙');
  const firstId = first.id;
  const secondId = second.id;

  await env.hub.updateBrain({ maxActions: 1 });
  const decision = await env.hub.requestBrainThink();
  assert.equal(decision.actions.length, 2);
  assert.equal(decision.actions[0].executed, true);
  assert.equal(decision.actions[1].executed, false);
  assert.equal(decision.actions[1].skippedReason, '超过本轮动作上限');
  assert.notEqual(env.hub.getTask(first.id).status, 'failed');
  assert.equal(env.hub.getTask(second.id).status, 'failed');
});

// ---------------------------------------------------------------- 失败路径

test('自主大脑：模型调用抛错时只写 lastError，不向调用方抛错，下次成功会清空', async (t) => {
  let attempt = 0;
  const env = await startTestHub(t, {
    brainThink: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('模型服务不可用');
      return thinkReply('恢复正常', []);
    },
  });

  const first = await env.hub.requestBrainThink({ trigger: 'manual' });
  assert.equal(first.error, '模型服务不可用');
  assert.deepEqual(first.actions, []);
  assert.match(env.hub.getBrain().lastError, /模型服务不可用/);

  const history = env.hub.listBrainDecisions(10);
  assert.equal(history.length, 1);
  assert.match(history[0].error, /模型服务不可用/);

  const second = await env.hub.requestBrainThink({ trigger: 'manual' });
  assert.equal(second.error, null);
  assert.equal(second.summary, '恢复正常');
  assert.equal(env.hub.getBrain().lastError, null);
  assert.equal(env.hub.getBrain().decisions.length, 2);
  assert.equal(env.hub.listBrainDecisions(10)[0].id, second.id); // 最新在前
});

test('自主大脑：非法 JSON 回复记录 error 且不抛错', async (t) => {
  const env = await startTestHub(t, {
    brainThink: async () => '抱歉，我现在无法输出 JSON',
  });

  const decision = await env.hub.requestBrainThink();
  assert.equal(decision.error, '大脑返回不是合法 JSON');
  assert.match(env.hub.getBrain().lastError, /大脑返回不是合法 JSON/);
  assert.equal(env.hub.getBrain().decisions.length, 1);
});

// ---------------------------------------------------------------- 定时器/开关/持久化

test('自主大脑：enabled=false 时 runBrainCycle 不调用模型；未到点也不调用', async (t) => {
  let calls = 0;
  const env = await startTestHub(t, {
    brainThink: async () => {
      calls += 1;
      return thinkReply('观察中', []);
    },
  });

  // 未到下次思考时间：跳过。
  env.hub.brain.lastThinkAt = new Date().toISOString();
  env.hub.brain.intervalSec = 180;
  assert.equal(await env.hub.runBrainCycle(), null);
  assert.equal(calls, 0);

  // 禁用后即使到点也不思考。
  await env.hub.updateBrain({ enabled: false });
  env.hub.brain.lastThinkAt = new Date(Date.now() - 3600 * 1000).toISOString();
  assert.equal(await env.hub.runBrainCycle(), null);
  assert.equal(calls, 0);

  // 重新启用且到点：自动思考（trigger=schedule）。
  await env.hub.updateBrain({ enabled: true, intervalSec: 60 });
  env.hub.brain.lastThinkAt = new Date(Date.now() - 3600 * 1000).toISOString();
  const decision = await env.hub.runBrainCycle();
  assert.ok(decision);
  assert.equal(decision.trigger, 'schedule');
  assert.equal(calls, 1);

  // 思考完成后 nextThinkAt 在将来，再次轮询直接跳过。
  assert.equal(await env.hub.runBrainCycle(), null);
  assert.equal(calls, 1);
});

test('自主大脑：serializeState 与 state.json 持久化 brain 状态', async (t) => {
  const env = await startTestHub(t, {
    brainThink: async () => thinkReply('检查完成', []),
  });

  await env.hub.updateBrain({ mode: 'suggest', intervalSec: 90, maxActions: 3 });
  await env.hub.requestBrainThink({ trigger: 'manual' });

  const state = env.hub.serializeState();
  assert.ok(state.brain);
  assert.equal(state.brain.enabled, true);
  assert.equal(state.brain.mode, 'suggest');
  assert.equal(state.brain.intervalSec, 90);
  assert.equal(state.brain.maxActions, 3);
  assert.equal(typeof state.brain.lastThinkAt, 'string');
  assert.equal(state.brain.decisions.length, 1);
  assert.equal(state.brain.decisions[0].summary, '检查完成');

  await waitFor(
    async () => {
      try {
        const saved = await readStateFile(env.dataDir);
        return Boolean(saved && saved.brain && saved.brain.decisions && saved.brain.decisions.length === 1);
      } catch {
        return false;
      }
    },
    { label: 'brain 状态落盘' },
  );
  const saved = await readStateFile(env.dataDir);
  assert.equal(saved.brain.mode, 'suggest');
});

// ---------------------------------------------------------------- HTTP API

test('大脑 HTTP API：GET/PATCH /api/brain 与 POST /api/brain/think', async (t) => {
  const env = await startTestHub(t, {
    brainThink: async () => thinkReply('HTTP 决策', []),
  });

  const unauthorized = await request(env.base, 'GET', '/api/brain', {});
  assert.equal(unauthorized.status, 401);

  const initial = await request(env.base, 'GET', '/api/brain', { headers: adminHeaders(env) });
  assert.equal(initial.status, 200, initial.text);
  assert.equal(initial.json.brain.enabled, true);
  assert.equal(initial.json.brain.mode, 'auto');
  assert.equal(initial.json.brain.intervalSec, 180);
  assert.equal(initial.json.brain.maxActions, 2);
  assert.equal(typeof initial.json.brain.configured, 'boolean');
  assert.ok(Array.isArray(initial.json.decisions));
  assert.equal(initial.json.decisions.length, 0);
  assert.equal(typeof initial.json.hubTime, 'string');

  const patched = await request(env.base, 'PATCH', '/api/brain', {
    headers: adminHeaders(env),
    body: { mode: 'suggest', intervalSec: 120, maxActions: 3 },
  });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.json.brain.mode, 'suggest');
  assert.equal(patched.json.brain.intervalSec, 120);
  assert.equal(patched.json.brain.maxActions, 3);
  assert.equal(typeof patched.json.hubTime, 'string');

  const invalid = await request(env.base, 'PATCH', '/api/brain', {
    headers: adminHeaders(env),
    body: { mode: 'turbo' },
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.json.error.message, /mode 必须是 auto \/ suggest/);

  const think = await request(env.base, 'POST', '/api/brain/think', {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(think.status, 200, think.text);
  assert.equal(think.json.decision.summary, 'HTTP 决策');
  assert.equal(think.json.decision.trigger, 'manual');
  assert.equal(think.json.brain.lastSummary, 'HTTP 决策');
  assert.equal(think.json.decision.mode, 'suggest');
  assert.equal(typeof think.json.hubTime, 'string');

  // GET ?decisions= 控制历史条数（默认 20，上限 30）。
  const withHistory = await request(env.base, 'GET', '/api/brain?decisions=5', {
    headers: adminHeaders(env),
  });
  assert.equal(withHistory.status, 200);
  assert.equal(withHistory.json.decisions.length, 1);
  assert.equal(withHistory.json.decisions[0].id, think.json.decision.id);
});

test('大脑 HTTP API：未配置模型返回 400，模型失败返回 502', async (t) => {
  const noKey = await startTestHub(t, {
    brainThink: async () => {
      throw new Error('未配置自主大脑模型（BRAIN_API_KEY / AGNES_API_KEY）');
    },
  });
  const res400 = await request(noKey.base, 'POST', '/api/brain/think', {
    headers: adminHeaders(noKey),
    body: {},
  });
  assert.equal(res400.status, 400, res400.text);
  assert.match(res400.json.error.message, /BRAIN_API_KEY/);

  const failing = await startTestHub(t, {
    brainThink: async () => {
      throw new Error('上游模型超时');
    },
  });
  const res502 = await request(failing.base, 'POST', '/api/brain/think', {
    headers: adminHeaders(failing),
    body: {},
  });
  assert.equal(res502.status, 502, res502.text);
  assert.equal(res502.json.error.code, 'brain_failed');
  assert.match(res502.json.error.message, /上游模型超时/);
  assert.match(res502.json.decision.error, /上游模型超时/);
  assert.match(res502.json.brain.lastError, /上游模型超时/);
});

test('大脑 HTTP API：并发思考时复用同一个 Promise，不重复调用模型', async (t) => {
  let calls = 0;
  let release = null;
  const env = await startTestHub(t, {
    brainThink: async () => {
      calls += 1;
      await new Promise((resolve) => {
        release = resolve;
      });
      return thinkReply('并发决策', []);
    },
  });

  const first = env.hub.requestBrainThink({ trigger: 'manual' });
  const second = env.hub.requestBrainThink({ trigger: 'manual' });
  await waitFor(() => typeof release === 'function', { label: '模型开始调用' });
  release();
  const [decisionA, decisionB] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(decisionA.id, decisionB.id);
  assert.equal(env.hub.getBrain().decisions.length, 1);

  // 思考进行中时 runBrainCycle 直接返回同一个进行中的 Promise，不会另起一次。
  const pending = env.hub.requestBrainThink({ trigger: 'manual' });
  const cycle = env.hub.runBrainCycle();
  assert.equal(cycle, pending);
  await waitFor(() => typeof release === 'function', { label: '第二轮模型开始调用' });
  release();
  const third = await pending;
  assert.equal(calls, 2);
  assert.notEqual(third.id, decisionA.id);
  assert.equal(env.hub.getBrain().decisions.length, 2);
});
