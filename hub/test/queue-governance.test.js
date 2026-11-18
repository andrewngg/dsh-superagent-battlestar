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

test('改需求：PATCH /api/tasks/:id 补 requirements 后排队任务立即派发', async (t) => {
  const env = await startTestHub(t);
  const worker = await registerDevice(env, makeManifest({ name: '工作机' }));
  const task = await queueTask(env, '需要 PDF 能力的历史排队任务');
  assert.equal(task.status, 'queued');

  const res = await request(env.base, 'PATCH', `/api/tasks/${task.id}`, {
    headers: adminHeaders(env),
    body: { requirements: { deviceId: worker.id, skills: [] } },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.task.status, 'assigned');
  assert.equal(res.json.task.assignedDeviceId, worker.id);
  const stored = await getTask(env, task.id);
  assert.equal(stored.requirements.deviceId, worker.id);
  assert.ok(
    stored.events.some((event) => /需求已修改/.test(event.message)),
    '事件里要记录需求已修改',
  );

  // 已结束任务不允许再改需求。
  const cancelled = await request(env.base, 'POST', `/api/tasks/${task.id}/cancel`, {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(cancelled.status, 200, cancelled.text);
  const rejected = await request(env.base, 'PATCH', `/api/tasks/${task.id}`, {
    headers: adminHeaders(env),
    body: { requirements: { deviceId: worker.id } },
  });
  assert.equal(rejected.status, 400, rejected.text);
});

test('队列健康：有任务排队超过 queueStuckMs 时，大脑不再 create_task', async (t) => {
  const env = await startTestHub(t, {
    queueStuckMs: 50,
    brainThink: async () =>
      thinkReply('先处理积压', [
        { action: 'create_task', instruction: '新建一条与积压无关的分析任务', confidence: 0.9 },
      ]),
  });
  await queueTask(env, '缺少设备能力的积压任务');
  await sleep(120);

  const res = await env.hub.requestBrainThink({ trigger: 'manual' });
  assert.equal(res.actions[0].executed, false);
  assert.match(res.actions[0].skippedReason, /队列积压/);
});

test('大脑 update_task：给排队任务补设备需求后立即派发', async (t) => {
  let queuedTaskId = null;
  let workerId = null;
  const env = await startTestHub(t, {
    brainThink: async () =>
      thinkReply('补齐排队任务需求', [
        {
          action: 'update_task',
          taskId: queuedTaskId,
          requirements: { deviceId: workerId, skills: [] },
          confidence: 0.9,
        },
      ]),
  });
  const worker = await registerDevice(env, makeManifest({ name: '工作机' }));
  workerId = worker.id;
  const queued = await queueTask(env, '缺少能力的排队任务');
  queuedTaskId = queued.id;
  assert.equal(queued.status, 'queued');

  const res = await env.hub.requestBrainThink({ trigger: 'manual' });
  assert.equal(res.actions[0].executed, true, JSON.stringify(res.actions[0]));
  const stored = await getTask(env, queued.id);
  assert.equal(stored.status, 'assigned');
  assert.equal(stored.assignedDeviceId, worker.id);
});

test('优先级老化：排队越久有效优先级越高，最多 +3', async (t) => {
  const env = await startTestHub(t);
  const now = Date.now();
  const base = { priority: 1 };
  assert.equal(env.hub._effectivePriority({ ...base, createdAt: new Date(now).toISOString() }, now), 1);
  assert.equal(
    env.hub._effectivePriority({ ...base, createdAt: new Date(now - 3 * 3600 * 1000).toISOString() }, now),
    4,
  );
  assert.equal(
    env.hub._effectivePriority({ ...base, createdAt: new Date(now - 20 * 3600 * 1000).toISOString() }, now),
    4,
  );
});

test('优先级老化：补派时优先补派排队更久的低优先级任务', async (t) => {
  const env = await startTestHub(t, { redispatchBudget: 2 });
  const fresh = await createTask(env, {
    instruction: '新提交的高优先级任务：需要 PDF 能力',
    priority: 5,
    requirements: { skills: ['office-pdf'] },
  });
  const stale = await createTask(env, {
    instruction: '排队很久的低优先级任务：也需要 PDF 能力',
    priority: 4,
    requirements: { skills: ['office-pdf'] },
  });
  const hub = env.hub;
  hub.tasks.get(stale.id).createdAt = new Date(Date.now() - 3 * 3600 * 1000).toISOString();

  // 只有 1 个空闲槽位：应补派有效优先级更高（4+3）的那条老任务。
  await registerDevice(
    env,
    makeManifest({ name: 'PDF 设备', skills: [{ id: 'office-pdf' }], limits: { maxConcurrentTasks: 1 } }),
  );
  assert.equal((await getTask(env, stale.id)).status, 'assigned');
  assert.equal((await getTask(env, fresh.id)).status, 'queued');
});

test('同目标串行：同目标下自主大脑的顶层任务一次只跑一个', async (t) => {
  const env = await startTestHub(t);
  await registerDevice(env, makeManifest({ name: '工作机', limits: { maxConcurrentTasks: 1 } }));
  const goal = await createGoal(env, { title: '求职目标' });

  const first = await createTask(env, {
    instruction: '第一件求职工作：整理投递清单',
    goalId: goal.id,
    context: { brain: true },
  });
  assert.equal(first.status, 'assigned');

  const second = await createTask(env, {
    instruction: '第二件求职工作：更新简历版本',
    goalId: goal.id,
    context: { brain: true },
  });
  assert.equal(second.status, 'queued');
  assert.match(second.route.reason, /同目标串行/);
});

test('动作命中率：大脑提示词带上最近决策的执行率与主要跳过原因', async (t) => {
  await startTestHub(t);
  const { buildBrainPrompt } = require('../lib/brain.js');
  const prompt = buildBrainPrompt({
    now: new Date().toISOString(),
    decisions: [
      {
        at: new Date().toISOString(),
        summary: '测试决策',
        actions: [
          { action: 'create_task', executed: false, skippedReason: 'duplicate' },
          { action: 'create_task', executed: false, skippedReason: 'duplicate' },
          { action: 'retry_task', taskId: 'task_x', executed: true },
        ],
      },
    ],
  });
  assert.match(prompt.user, /动作命中率/);
  assert.match(prompt.user, /执行率 33%/);
  assert.match(prompt.user, /duplicate×2/);
});

test('去重辅助：bigram 相似度能识别改写过的同一件事，又不误伤不同任务', async (t) => {
  const env = await startTestHub(t);
  assert.ok(
    env.hub._instructionSimilarity('在母机上启动反腐AI系统并做最小验证', '在母机上启动反腐 AI 系统，做一次最小验证') >= 0.6,
  );
  assert.ok(env.hub._instructionSimilarity('整理简历', '给 applier.py 加自动投递参数') < 0.6);
});
