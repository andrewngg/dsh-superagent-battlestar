'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildBrainPrompt } = require('../lib/brain.js');

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

test('自主大脑 create_task：默认 600 秒，可显式超时与设备要求', async (t) => {
  const env = await startTestHub(t, {
    brainThink: async () => thinkReply('自由职业目标需要先落一个文件', [
      {
        action: 'create_task',
        instruction: '整理自由职业工作区并写出第一份介绍草稿',
        reason: '自由职业目标有方案但零交付',
        confidence: 0.9,
      },
      {
        action: 'create_task',
        instruction: '把 GUI 打包成一个不依赖固定目录的 exe',
        reason: '交付可执行文件',
        timeoutSec: 900,
        requirements: { deviceId: 'dev_pzh31fkv', project: 'freelance' },
        confidence: 0.9,
      },
    ]),
  });

  const decision = await env.hub.requestBrainThink({ trigger: 'manual' });
  assert.equal(decision.actions.length, 2);
  assert.equal(decision.actions[0].executed, true);
  assert.equal(decision.actions[1].executed, true);

  const first = env.hub.getTask(decision.actions[0].taskId);
  const second = env.hub.getTask(decision.actions[1].taskId);
  // 300 秒是 task_yfllwarp 失败的诱因之一：大脑新建任务改为默认 600 秒。
  assert.equal(first.timeoutSec, 600);
  assert.equal(second.timeoutSec, 900);
  assert.equal(second.requirements.deviceId, 'dev_pzh31fkv');
  assert.equal(second.requirements.project, 'freelance');

  // 决策记录同样保留超时/要求，方便复盘“为什么派到了某台设备”。
  const recorded = env.hub.getBrain().decisions[0].actions;
  assert.equal(recorded[1].timeoutSec, 900);
  assert.equal(recorded[1].requirements.deviceId, 'dev_pzh31fkv');
});


test('自主大脑 create_task：项目标签学成项目别名，钉住的设备不被无人声明标签卡住', async (t) => {
  let device = null;
  const env = await startTestHub(t, {
    brainThink: async () =>
      thinkReply('反腐AI 验证任务不应自造设备标签', [
        {
          action: 'create_task',
          instruction: '启动反腐AI服务并做最小验证',
          reason: '验证系统可用',
          timeoutSec: 600,
          requirements: {
            deviceId: device.deviceId,
            project: 'ai-corruption',
            // 模型常见的错误：把项目名/任务名当成设备能力标签。
            tags: ['反腐AI', '验证'],
          },
          confidence: 0.9,
        },
      ]),
  });
  device = await registerDevice(env, makeManifest({ name: '母机', tags: ['本机'] }));

  const decision = await env.hub.requestBrainThink({ trigger: 'manual' });
  assert.equal(decision.actions[0].executed, true);

  const task = env.hub.getTask(decision.actions[0].taskId);
  // 有项目时标签不再直接丢弃：登记成项目别名，设备做过该项目后自动匹配。
  assert.deepEqual(task.requirements.tags, ['反腐AI', '验证']);
  assert.deepEqual(env.hub.projectTags.get('ai-corruption'), ['反腐AI', '验证']);
  assert.equal(task.requirements.deviceId, device.deviceId);
  assert.equal(task.requirements.project, 'ai-corruption');
  // 显式钉住设备且只缺描述性标签时，应正常派发；而不是一直排队。
  assert.ok(['assigned', 'running'].includes(task.status), `unexpected status: ${task.status}`);
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

test('自主大脑：非法 JSON 回复记录 error 且不抛错（含一次修复重试）', async (t) => {
  let calls = 0;
  const env = await startTestHub(t, {
    brainThink: async () => {
      calls += 1;
      return '抱歉，我现在无法输出 JSON';
    },
  });

  const decision = await env.hub.requestBrainThink();
  assert.equal(calls, 2); // 首次解析失败后带修复提示重试一次
  assert.match(decision.error, /^大脑返回不是合法 JSON/);
  assert.match(decision.error, /开头：/); // 错误里带模型输出开头，便于定位
  assert.match(env.hub.getBrain().lastError, /大脑返回不是合法 JSON/);
  assert.equal(env.hub.getBrain().decisions.length, 1);
});

test('自主大脑：首次输出非法 JSON 时带修复提示重试，第二次成功则整轮正常', async (t) => {
  let calls = 0;
  const prompts = [];
  const env = await startTestHub(t, {
    brainThink: async (prompt) => {
      calls += 1;
      prompts.push(prompt);
      if (calls === 1) return '先说一句话然后 {不是 JSON';
      return thinkReply('重试后恢复', []);
    },
  });

  const decision = await env.hub.requestBrainThink();
  assert.equal(decision.error, null);
  assert.equal(decision.summary, '重试后恢复');
  assert.equal(calls, 2);
  assert.match(prompts[1].user, /【重要】你上一次的输出无法解析为 JSON/);
  assert.equal(env.hub.getBrain().lastError, null);
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

test('主人选择：选项写入 ownerReply、ownerAsk 清空，下一轮提示词包含选择', async (t) => {
  const prompts = [];
  let round = 0;
  const env = await startTestHub(t, {
    brainThink: async (prompt) => {
      prompts.push(prompt);
      round += 1;
      if (round === 1) {
        return JSON.stringify({
          summary: '需要主人拍板方向',
          actions: [],
          assessment: {
            goals: '自由职业目标',
            progress: '已有方案',
            betterWay: '',
            improvement: '',
            myMove: '',
            ownerAsk: { text: '先做哪一个交付？', options: ['写介绍草稿', '先补测试'] },
          },
        });
      }
      return thinkReply('按主人的选择继续推进', []);
    },
  });

  const decision = await env.hub.requestBrainThink({ trigger: 'manual' });
  assert.equal(decision.error, null);
  const brain = env.hub.getBrain();
  assert.equal(brain.ownerAsk.text, '先做哪一个交付？');
  assert.deepEqual(brain.ownerAsk.options.map((option) => option.label), ['写介绍草稿', '先补测试']);
  assert.equal(brain.ownerAsk.options[0].id, 'o1');

  // 通知/控制台点击选项 → 写入 ownerReply 并清空 ownerAsk。
  const choose = await request(env.base, 'POST', '/api/brain/owner-ask/choose', {
    headers: adminHeaders(env),
    body: { optionId: 'o2' },
  });
  assert.equal(choose.status, 200, choose.text);
  assert.equal(choose.json.brain.ownerAsk, null);
  assert.equal(choose.json.brain.ownerReply.optionId, 'o2');
  assert.equal(choose.json.brain.ownerReply.label, '先补测试');
  assert.equal(choose.json.brain.ownerReply.question, '先做哪一个交付？');
  assert.equal(typeof choose.json.hubTime, 'string');

  // 下一轮思考的提示词里带上「主人对上次提问的选择」。
  await env.hub.requestBrainThink({ trigger: 'manual' });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1].user, /## 主人对上次提问的选择/);
  assert.match(prompts[1].user, /先补测试/);
  assert.match(prompts[1].user, /不要再次询问同一个问题/);
  // 选择被消费后清空，避免反复注入。
  assert.equal(env.hub.getBrain().ownerReply, null);

  // 非法选项 / 没有待决定问题 / 缺少鉴权。
  const bad = await request(env.base, 'POST', '/api/brain/owner-ask/choose', {
    headers: adminHeaders(env),
    body: { optionId: 'o9' },
  });
  assert.equal(bad.status, 400, bad.text);
  assert.match(bad.json.error.message, /无效的选项|没有等待主人决定/);

  const none = await request(env.base, 'POST', '/api/brain/owner-ask/choose', {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(none.status, 400, none.text);

  const unauth = await request(env.base, 'POST', '/api/brain/owner-ask/choose', {
    body: { optionId: 'o1' },
  });
  assert.equal(unauth.status, 401, unauth.text);
});

test('主人自由回复：文字写入 ownerReply、ownerAsk 清空，下一轮提示词包含回复', async (t) => {
  const prompts = [];
  let round = 0;
  const env = await startTestHub(t, {
    brainThink: async (prompt) => {
      prompts.push(prompt);
      round += 1;
      if (round === 1) {
        return JSON.stringify({
          summary: '求职自动化失败，需要主人选方向',
          actions: [],
          assessment: {
            goals: '求职目标',
            progress: '两个自动化任务失败',
            betterWay: '',
            improvement: '',
            myMove: '',
            ownerAsk: {
              text: '接下来怎么推进？',
              options: ['A 重新设计自动化', 'B 手动补投递'],
            },
          },
        });
      }
      return thinkReply('按主人的回复继续推进', []);
    },
  });

  const decision = await env.hub.requestBrainThink({ trigger: 'manual' });
  assert.equal(decision.error, null);
  assert.equal(env.hub.getBrain().ownerAsk.text, '接下来怎么推进？');
  assert.equal(env.hub.getBrain().ownerAsk.options.length, 2);

  // 空文本被拒绝，提示缺内容。
  const empty = await request(env.base, 'POST', '/api/brain/owner-ask/reply', {
    headers: adminHeaders(env),
    body: { text: '   ' },
  });
  assert.equal(empty.status, 400, empty.text);
  assert.match(empty.json.error.message, /缺少回复内容/);

  // 自由文本回复（不点选项，直接写 C/自定义方向）→ 写入 ownerReply 并清空 ownerAsk。
  const reply = await request(env.base, 'POST', '/api/brain/owner-ask/reply', {
    headers: adminHeaders(env),
    body: { text: 'B 先放弃自动化，手动补投递' },
  });
  assert.equal(reply.status, 200, reply.text);
  assert.equal(reply.json.brain.ownerAsk, null);
  assert.equal(reply.json.brain.ownerReply.optionId, null);
  assert.equal(reply.json.brain.ownerReply.text, 'B 先放弃自动化，手动补投递');
  assert.equal(reply.json.brain.ownerReply.label, 'B 先放弃自动化，手动补投递');
  assert.equal(reply.json.brain.ownerReply.question, '接下来怎么推进？');
  assert.equal(typeof reply.json.hubTime, 'string');

  // 下一轮提示词里带上「主人对上次提问的回复」，之后清空。
  await env.hub.requestBrainThink({ trigger: 'manual' });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1].user, /## 主人对上次提问的回复/);
  assert.match(prompts[1].user, /我的回答：B 先放弃自动化，手动补投递/);
  assert.match(prompts[1].user, /不要再次询问同一个问题/);
  assert.equal(env.hub.getBrain().ownerReply, null);

  // 没有待决定问题时，主人也可以主动补一句方向，直接写入 ownerReply。
  const proactive = await request(env.base, 'POST', '/api/brain/owner-ask/reply', {
    headers: adminHeaders(env),
    body: { text: '另外：以后每天晚上汇报投递数量' },
  });
  assert.equal(proactive.status, 200, proactive.text);
  assert.equal(proactive.json.brain.ownerReply.text, '另外：以后每天晚上汇报投递数量');
  assert.equal(proactive.json.brain.ownerReply.question, '');

  const unauth = await request(env.base, 'POST', '/api/brain/owner-ask/reply', {
    body: { text: 'hi' },
  });
  assert.equal(unauth.status, 401, unauth.text);
});

test('大脑路径核查：在 Hub 主机探测任务文件引用，并带上项目/设备与历史提问', async (t) => {
  const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-path-audit-'));
  fs.writeFileSync(path.join(scanDir, 'applier.py'), 'print("ok")\n');
  t.after(() => fs.rmSync(scanDir, { recursive: true, force: true }));

  const env = await startTestHub(t, {
    brainThink: async () => thinkReply('观察中', []),
  });
  const device = await registerDevice(env, makeManifest({ name: '求职工作机' }));
  const created = await createTask(env, {
    instruction:
      '给 applier.py 加 --auto-submit；找不到 C:\\Users\\__nouser__\\Desktop\\jobstreet_candidates.json 就改用 resume.pdf',
    requirements: { project: 'job_search' },
  });
  await ackTask(env, device, created.id);
  await resultTask(env, device, created.id, { ok: false, error: 'resume.pdf 路径不对' });
  await waitFor(() => env.hub.getTask(created.id).status === 'failed', { label: '任务进入 failed' });

  // 历史决策里记录「当轮提问」，提示词据此提醒不要重复问。
  env.hub.brain.decisions.push({
    id: 'brain_test_ownerask',
    at: '2026-11-17T03:36:00.000Z',
    summary: '路径缺失，需要主人处理',
    ownerAsk: { text: 'applier.py 的具体路径在哪里？' },
    actions: [],
  });

  const prevRoots = process.env.BRAIN_PATH_ROOTS;
  process.env.BRAIN_PATH_ROOTS = scanDir;
  let snap;
  try {
    snap = env.hub._brainSnapshot();
  } finally {
    if (prevRoots === undefined) delete process.env.BRAIN_PATH_ROOTS;
    else process.env.BRAIN_PATH_ROOTS = prevRoots;
  }

  const taskRow = snap.tasks.find((task) => task.id === created.id);
  assert.ok(taskRow, '快照应包含失败任务');
  assert.equal(taskRow.project, 'job_search');
  assert.equal(taskRow.assignedDeviceId, device.deviceId);
  assert.equal(snap.decisions[0].ownerAsk, 'applier.py 的具体路径在哪里？');

  const byRef = new Map(snap.pathAudit.map((entry) => [entry.ref, entry]));
  const applier = snap.pathAudit.find((entry) => entry.ref.toLowerCase() === 'applier.py');
  assert.ok(applier, `路径核查应包含 applier.py：${JSON.stringify(snap.pathAudit)}`);
  assert.equal(applier.status, 'candidates');
  assert.ok(applier.paths.some((filePath) => filePath.endsWith('applier.py')));
  const missing = byRef.get('C:\\Users\\__nouser__\\Desktop\\jobstreet_candidates.json');
  assert.ok(missing, `路径核查应包含绝对路径任务文件：${JSON.stringify(snap.pathAudit)}`);
  assert.equal(missing.status, 'missing');

  // 提示词：路径核查实测结果 + 历史提问提醒（不再把事实问题升级成 ownerAsk）。
  const prompt = buildBrainPrompt(snap);
  assert.match(prompt.user, /## 路径核查（在 .+ 上实测；其它设备上的路径可能不同）/);
  assert.match(prompt.user, /applier\.py → Hub 主机上该路径不存在，但找到同名文件：/);
  assert.match(prompt.user, /当轮提问：applier\.py 的具体路径在哪里？（已问过，除非有全新信息不要重复问）/);
});

test('自主大脑 consult_worker：向指定设备提只读问题，回答写入咨询记录并回喂下一轮', async (t) => {
  const prompts = [];
  let round = 0;
  let targetDeviceId = null;
  const env = await startTestHub(t, {
    brainThink: async (prompt) => {
      prompts.push(prompt);
      round += 1;
      if (round === 1) {
        return thinkReply('项目目录只有工作机清楚，直接问它', [
          {
            action: 'consult_worker',
            question: '列出 job_search 项目的绝对目录和 applier.py 路径',
            requirements: { deviceId: targetDeviceId, project: 'job_search' },
            reason: '缺设备侧路径',
            confidence: 0.9,
          },
        ]);
      }
      return thinkReply('已拿到路径，继续推进', []);
    },
  });

  const device = await registerDevice(env, makeManifest({ name: '求职工作机' }));
  targetDeviceId = device.deviceId;

  const decision = await env.hub.requestBrainThink({ trigger: 'manual' });
  assert.equal(decision.error, null);
  assert.equal(decision.actions.length, 1);
  const record = decision.actions[0];
  assert.equal(record.action, 'consult_worker');
  assert.equal(record.executed, true);
  assert.equal(record.question, '列出 job_search 项目的绝对目录和 applier.py 路径');

  // 咨询任务：只读前缀、硬锁到指定设备、带项目归属。
  const consultTask = env.hub.getTask(record.taskId);
  assert.ok(consultTask, '应创建咨询任务');
  assert.match(consultTask.instruction, /^【只读咨询】列出 job_search 项目的绝对目录和 applier\.py 路径/);
  assert.match(consultTask.instruction, /不要修改任何文件或执行有副作用的操作/);
  assert.equal(consultTask.requirements.deviceId, device.deviceId);
  assert.equal(consultTask.requirements.project, 'job_search');
  assert.equal(consultTask.consult.deviceId, device.deviceId);
  assert.equal(consultTask.consult.question, '列出 job_search 项目的绝对目录和 applier.py 路径');
  assert.ok(['assigned', 'running'].includes(consultTask.status), `unexpected status: ${consultTask.status}`);

  await ackTask(env, device, consultTask.id);
  await resultTask(env, device, consultTask.id, {
    ok: true,
    output: { text: '项目目录 C:\\work\\job_search，applier.py 在 scripts/applier.py' },
  });
  await waitFor(() => env.hub.getTask(consultTask.id).status === 'completed', { label: '咨询任务完成' });
  await waitFor(() => env.hub.getBrain().consultations.length === 1, { label: '咨询记录写入' });

  const consultation = env.hub.getBrain().consultations[0];
  assert.equal(consultation.ok, true);
  assert.equal(consultation.deviceId, device.deviceId);
  assert.equal(consultation.project, 'job_search');
  assert.match(consultation.answer, /scripts\/applier\.py/);

  // 快照：项目↔主机映射 + 咨询记录，下一轮提示词可见且不会重复问同一件事。
  const snap = env.hub._brainSnapshot();
  const hostRow = snap.projectHosts.find((entry) => entry.project === 'job_search');
  assert.ok(hostRow, `快照应带项目↔主机：${JSON.stringify(snap.projectHosts)}`);
  assert.equal(hostRow.deviceId, device.deviceId);
  assert.equal(snap.consultations.length, 1);
  assert.equal(snap.consultations[0].deviceName, '求职工作机');

  const second = await env.hub.requestBrainThink({ trigger: 'manual' });
  assert.equal(second.error, null);
  const lastPrompt = prompts[prompts.length - 1];
  assert.match(lastPrompt.user, /## 项目 ↔ 主机（1 个/);
  assert.match(lastPrompt.user, /job_search → 求职工作机/);
  assert.match(lastPrompt.user, /## 咨询记录（worker 已回答；同一问题不要重复咨询）/);
  assert.match(lastPrompt.user, /问 求职工作机：列出 job_search 项目的绝对目录和 applier\.py 路径/);
  assert.match(lastPrompt.user, /scripts\/applier\.py/);
  assert.deepEqual(second.actions, []);
});

test('自主大脑 remember：长期记忆写入 brain.notes、去重，并持久化/注入下一轮', async (t) => {
  const prompts = [];
  let round = 0;
  const env = await startTestHub(t, {
    brainThink: async (prompt) => {
      prompts.push(prompt);
      round += 1;
      if (round === 1) {
        return thinkReply('记下项目约定', [
          {
            action: 'remember',
            note: 'job_search 项目的 applier.py 固定在 scripts/applier.py',
            reason: '以后不必再问',
            confidence: 0.9,
          },
        ]);
      }
      if (round === 2) {
        return thinkReply('再记一次同样的内容', [
          { action: 'remember', note: 'job_search 项目的 applier.py 固定在 scripts/applier.py', confidence: 0.9 },
        ]);
      }
      return thinkReply('没有新动作', []);
    },
  });

  const first = await env.hub.requestBrainThink({ trigger: 'manual' });
  assert.equal(first.error, null);
  assert.equal(first.actions[0].executed, true);
  assert.match(first.actions[0].note, /applier\.py/);
  assert.equal(env.hub.getBrain().notes.length, 1);
  assert.equal(env.hub.getBrain().notes[0].text, 'job_search 项目的 applier.py 固定在 scripts/applier.py');

  // 完全相同的内容不重复写。
  const second = await env.hub.requestBrainThink({ trigger: 'manual' });
  assert.equal(second.error, null);
  assert.equal(second.actions[0].executed, false);
  assert.equal(second.actions[0].skippedReason, '这条记忆已存在');
  assert.equal(env.hub.getBrain().notes.length, 1);

  // 记忆注入下一轮提示词。
  const lastPrompt = prompts[prompts.length - 1];
  assert.match(lastPrompt.user, /## 管家记忆（长期上下文，按需使用，不要重复记录）/);
  assert.match(lastPrompt.user, /job_search 项目的 applier\.py 固定在 scripts\/applier\.py/);

  // 持久化到 state.json。
  await env.hub.flushState();
  const saved = await readStateFile(env.dataDir);
  assert.equal(saved.brain.notes.length, 1);
  assert.equal(saved.brain.notes[0].text, 'job_search 项目的 applier.py 固定在 scripts/applier.py');
});

test('自主大脑：进行中的咨询不会被重复创建，缺少设备/问题会被跳过', async (t) => {
  const env = await startTestHub(t, {
    brainThink: async () => thinkReply('没有动作', []),
  });
  const device = await registerDevice(env, makeManifest({ name: '工作机' }));

  assert.equal(env.hub._applyBrainAction({ action: 'consult_worker', question: '很短', requirements: { deviceId: device.deviceId } }).skippedReason, '缺少可回答的咨询问题');
  assert.match(
    env.hub._applyBrainAction({ action: 'consult_worker', question: '列出项目绝对目录' }).skippedReason,
    /需要 requirements\.deviceId/,
  );
  assert.equal(
    env.hub._applyBrainAction({ action: 'consult_worker', question: '列出项目绝对目录', requirements: { deviceId: 'dev_missing' } }).skippedReason,
    'device-not-found',
  );

  const created = env.hub._applyBrainAction({
    action: 'consult_worker',
    question: '列出项目绝对目录',
    requirements: { deviceId: device.deviceId },
  });
  assert.ok(created.taskId);
  const duplicate = env.hub._applyBrainAction({
    action: 'consult_worker',
    question: '这个项目的运行环境版本是多少',
    requirements: { deviceId: device.deviceId },
  });
  assert.equal(duplicate.skippedReason, '同一设备已有进行中的咨询');
  assert.equal(duplicate.taskId, created.taskId);
});