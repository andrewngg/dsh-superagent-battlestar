'use strict';

/**
 * 队列治理（P0）：
 * 1. queued 超时失效，避免历史任务永久堆积；
 * 2. 设备上线/重启时不把历史排队任务一次性全部补派（redispatchBudget）；
 * 3. 自主大脑同一目标下不重复建任务；
 * 4. 去重升级：标点/空白不同的重复指令也能识别。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startTestHub,
  request,
  adminHeaders,
  makeManifest,
  registerDevice,
  createTask,
  getTask,
  waitFor,
  sleep,
} = require('./_helpers.js');

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

/** 造一条排队任务：要求一个没有设备声明过的技能。 */
function queueTask(env, instruction) {
  return createTask(env, { instruction, requirements: { skills: ['office-pdf'] } });
}

test('队列寿命：queued 超过 queuedTtlMs 仍无设备可派时自动失败并写明原因', async (t) => {
  const env = await startTestHub(t, { queuedTtlMs: 150, sweepIntervalMs: 20 });
  const task = await queueTask(env, '需要一台不存在的设备来跑的分析任务');
  assert.equal(task.status, 'queued');

  const expired = await waitFor(
    async () => {
      const current = await getTask(env, task.id);
      return current.status === 'failed' ? current : null;
    },
    { label: '排队超时 → failed', timeout: 5000 },
  );
  assert.match(expired.error, /排队超时/);
  assert.ok(
    expired.events.some((event) => /排队超时/.test(event.message)),
    '事件里要能看到排队超时的终止原因',
  );
});

test('队列寿命：queuedTtlMs=0 时关闭失效，任务继续排队', async (t) => {
  const env = await startTestHub(t, { queuedTtlMs: 0, sweepIntervalMs: 20 });
  const task = await queueTask(env, '关闭 TTL 时不应被清理的排队任务');
  await sleep(300);
  assert.equal((await getTask(env, task.id)).status, 'queued');
});

test('重派节流：设备注册时一次最多补派 redispatchBudget 条历史排队任务', async (t) => {
  const env = await startTestHub(t, { redispatchBudget: 1 });
  const tasks = [];
  for (let i = 0; i < 3; i += 1) tasks.push(await queueTask(env, `历史排队任务 ${i + 1}：需要 PDF 能力`));
  assert.deepEqual(
    tasks.map((task) => task.status),
    ['queued', 'queued', 'queued'],
  );

  // 注册一台具备该能力的设备：只补派 1 条，不能一次把 3 条全部灌出去。
  await registerDevice(
    env,
    makeManifest({ name: 'PDF 设备', skills: [{ id: 'office-pdf' }], limits: { maxConcurrentTasks: 3 } }),
  );
  const afterRegister = [];
  for (const task of tasks) afterRegister.push((await getTask(env, task.id)).status);
  assert.equal(
    afterRegister.filter((status) => status === 'assigned').length,
    1,
    '设备注册时只补派 1 条（redispatchBudget=1）',
  );

  // 显式预算 0 不派发；显式更大预算可以把剩余排队任务补完。
  assert.equal(env.hub.retryQueuedTasks('manual', 0), 0);
  assert.ok(env.hub.retryQueuedTasks('manual', 5) >= 1);
  const afterManual = [];
  for (const task of tasks) afterManual.push((await getTask(env, task.id)).status);
  assert.equal(afterManual.filter((status) => status === 'assigned').length, 3);
});

test('同目标并发闸：目标下已有在途任务时，大脑 create_task 被拒并提示 retry/resume', async (t) => {
  let goalId = null;
  let calls = 0;
  const env = await startTestHub(t, {
    brainThink: async () => {
      calls += 1;
      const instruction = calls === 1 ? '整理求职投递清单并生成第一版' : '继续推进求职投递进度';
      return thinkReply('推进求职目标', [
        { action: 'create_task', instruction, goalId, reason: '推进目标', confidence: 0.9 },
      ]);
    },
  });
  const goal = await createGoal(env, { title: '求职目标' });
  goalId = goal.id;

  const first = await env.hub.requestBrainThink({ trigger: 'manual' });
  assert.equal(first.actions[0].executed, true);

  const second = await env.hub.requestBrainThink({ trigger: 'manual' });
  assert.equal(second.actions[0].executed, false);
  assert.match(second.actions[0].skippedReason, /同目标已有在途任务/);
});

test('去重升级：仅标点/空白不同的重复指令被识别为 duplicate', async (t) => {
  let calls = 0;
  const env = await startTestHub(t, {
    brainThink: async () => {
      calls += 1;
      const instruction =
        calls === 1 ? '整理求职投递清单，并生成第一版草稿' : '整理求职投递清单并生成第一版草稿';
      return thinkReply('推进', [{ action: 'create_task', instruction, confidence: 0.9 }]);
    },
  });
  const first = await env.hub.requestBrainThink({ trigger: 'manual' });
  assert.equal(first.actions[0].executed, true);

  const second = await env.hub.requestBrainThink({ trigger: 'manual' });
  assert.equal(second.actions[0].executed, false);
  assert.equal(second.actions[0].skippedReason, 'duplicate');
});

test('去重辅助：bigram 相似度能识别改写过的同一件事，又不误伤不同任务', async (t) => {
  const env = await startTestHub(t);
  assert.ok(
    env.hub._instructionSimilarity('在母机上启动反腐AI系统并做最小验证', '在母机上启动反腐 AI 系统，做一次最小验证') >= 0.6,
  );
  assert.ok(env.hub._instructionSimilarity('整理简历', '给 applier.py 加自动投递参数') < 0.6);
});
