'use strict';

/**
 * 管家思考流程优化（m02419 审计的 P0 清单）回归测试：
 * 1) 任务快照只喂可行动任务 + 最近完成；cancelled 不再进入提示词，也不再算「有活」；
 * 2) 提示词带最近决策（避免重复无效动作）与任务相对时间；
 * 3) 自适应退避不再被 MAX_IDLE_SEC 卡死；
 * 4) 连续思考失败按指数退避，且心路只记第一次失败；
 * 5) 纯 none 动作的思考不再写心路。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildBrainPrompt,
  effectiveIntervalSec,
  formatAge,
  idleIntervalCapSec,
  MAX_IDLE_SEC,
} = require('../lib/brain.js');
const { startTestHub } = require('./_helpers.js');

// ---------------------------------------------------------------- 纯函数

test('idleIntervalCapSec：退避上限随基准间隔放大，但不超过 6 小时', () => {
  assert.equal(idleIntervalCapSec(60), MAX_IDLE_SEC); // 小基准仍至少 30 分钟
  assert.equal(idleIntervalCapSec(180), MAX_IDLE_SEC);
  assert.equal(idleIntervalCapSec(300), MAX_IDLE_SEC);
  assert.equal(idleIntervalCapSec(1800), 7200); // 4 倍基准
  assert.equal(idleIntervalCapSec(3600), 14400);
  assert.equal(idleIntervalCapSec('bad'), MAX_IDLE_SEC);

  const brain = { intervalSec: 1800, effectiveIntervalSec: 7200, adaptive: true };
  assert.equal(effectiveIntervalSec(brain), 7200);
  assert.equal(effectiveIntervalSec({ ...brain, effectiveIntervalSec: 99 }), 1800);
  assert.equal(effectiveIntervalSec({ ...brain, effectiveIntervalSec: 999999 }), 7200);
});

test('formatAge：秒/分钟/小时/天渲染，非法时间返回 null', () => {
  const now = Date.parse('2026-11-16T06:00:00.000Z');
  assert.equal(formatAge('2026-11-16T05:59:40.000Z', now), '刚刚');
  assert.equal(formatAge('2026-11-16T05:30:00.000Z', now), '30 分钟前');
  assert.equal(formatAge('2026-11-16T03:00:00.000Z', now), '3 小时前');
  assert.equal(formatAge('2026-11-14T06:00:00.000Z', now), '2 天前');
  assert.equal(formatAge('not-a-date', now), null);
  assert.equal(formatAge(null, now), null);
});

test('buildBrainPrompt：渲染最近决策、任务相对时间与可配置动作上限', () => {
  const prompt = buildBrainPrompt(
    {
      now: '2026-11-16T06:00:00.000Z',
      tasks: [
        {
          id: 'task_1',
          status: 'failed',
          instruction: '卡住的投递',
          updatedAt: '2026-11-16T05:30:00.000Z',
          attempts: 1,
          maxAttempts: 2,
        },
      ],
      decisions: [
        {
          at: '2026-11-16T05:50:00.000Z',
          summary: '先重试卡住步骤',
          actions: [
            {
              action: 'retry_task',
              taskId: 'task_1',
              executed: false,
              skippedReason: '任务不在可重试状态',
            },
          ],
        },
      ],
    },
    { maxActions: 3 },
  );
  assert.match(prompt.system, /同一轮最多 3 个动作/);
  assert.match(prompt.user, /## 最近决策/);
  assert.match(prompt.user, /retry_task task_1 → 跳过：任务不在可重试状态/);
  assert.match(prompt.user, /更新 30 分钟前/);
});

// ---------------------------------------------------------------- Hub 集成

function putTask(hub, id, status, extra = {}) {
  const now = Date.now();
  const iso = (deltaMs) => new Date(now - deltaMs).toISOString();
  hub.tasks.set(id, {
    id,
    status,
    instruction: `任务 ${id}`,
    archived: false,
    attempts: 1,
    maxAttempts: 2,
    createdAt: iso(3600000),
    updatedAt: iso(600000),
    threadId: id,
    events: [],
    childTaskIds: [],
    ...extra,
  });
}

test('_brainSnapshot：只喂可行动任务 + 最近完成，cancelled 不再喂给模型', async (t) => {
  const env = await startTestHub(t, {});
  const hub = env.hub;
  const now = Date.now();
  const iso = (deltaMs) => new Date(now - deltaMs).toISOString();
  putTask(hub, 'task_failed_1', 'failed');
  putTask(hub, 'task_queued_1', 'queued');
  putTask(hub, 'task_completed_1', 'completed', { finishedAt: iso(10 * 60000) });
  putTask(hub, 'task_completed_2', 'completed', { finishedAt: iso(20 * 60000) });
  putTask(hub, 'task_cancelled_1', 'cancelled', { finishedAt: iso(60000) });

  const snap = hub._brainSnapshot();
  const ids = snap.tasks.map((task) => task.id);
  assert.ok(!ids.includes('task_cancelled_1'), 'cancelled 不应出现在提示词里');
  assert.ok(ids.includes('task_failed_1'));
  assert.ok(ids.includes('task_queued_1'));
  assert.ok(ids.includes('task_completed_1'));
  // 失败/排队优先于已完成
  assert.ok(ids.indexOf('task_failed_1') < ids.indexOf('task_completed_1'));

  // cancelled 不进快照，也不算「有活」：否则一整天 busy=true 无法降频。
  hub.tasks.clear();
  putTask(hub, 'task_cancelled_only', 'cancelled', { finishedAt: iso(60000) });
  const workload = hub._brainWorkload();
  assert.equal(workload.counts.retryable, 0);
  assert.equal(workload.busy, false);
  assert.equal(hub._brainSnapshot().tasks.length, 0);
});

test('自适应节律：基准 1800s 时空闲退避可以超过 MAX_IDLE_SEC，封顶 7200s', async (t) => {
  let calls = 0;
  const env = await startTestHub(t, {
    brainThink: async () => {
      calls += 1;
      return JSON.stringify({ summary: '继续观察', actions: [] });
    },
  });
  const hub = env.hub;
  hub.updateBrain({ intervalSec: 1800, adaptive: true });

  await hub.requestBrainThink({ trigger: 'manual' });
  assert.equal(calls, 1);
  assert.equal(hub.brain.effectiveIntervalSec, 3600); // 空闲 ×2

  // 没有新信号 → 跳过模型调用并继续退避
  hub.brain.nextThinkAt = new Date(Date.now() - 1000).toISOString();
  await hub.runBrainCycle();
  assert.equal(calls, 1, '空闲轮不应调用模型');
  assert.equal(hub.brain.effectiveIntervalSec, 7200);

  hub.brain.nextThinkAt = new Date(Date.now() - 1000).toISOString();
  await hub.runBrainCycle();
  assert.equal(calls, 1);
  assert.equal(hub.brain.effectiveIntervalSec, 7200, '不应超过 idleIntervalCapSec(1800)');
  assert.equal(hub.getBrain().idleLimitSec, 7200);
  assert.ok(hub.getBrain().skippedCycles >= 2);
});

test('连续思考失败：指数退避，且心路只记录第一次失败', async (t) => {
  let calls = 0;
  const env = await startTestHub(t, {
    brainThink: async () => {
      calls += 1;
      throw new Error('模型超时');
    },
  });
  const hub = env.hub;
  hub.updateBrain({ intervalSec: 600 });

  const first = await hub.requestBrainThink({ trigger: 'manual' });
  assert.equal(first.error, '模型超时');
  assert.equal(hub.brain.consecutiveFailures, 1);
  assert.equal(hub.brain.effectiveIntervalSec, 1200);

  const second = await hub.requestBrainThink({ trigger: 'manual' });
  assert.equal(second.error, '模型超时');
  assert.equal(hub.brain.consecutiveFailures, 2);
  assert.equal(hub.brain.effectiveIntervalSec, 2400);
  assert.equal(calls, 2);

  const failureEntries = hub.journal.entries.filter(
    (entry) => entry.kind === 'thought' && /思考失败/.test(entry.title || ''),
  );
  assert.equal(failureEntries.length, 1, '连续失败不应刷屏心路');

  // 成功一次即清零失败计数；因本轮无活，空闲退避从基准 ×2 重新开始
  hub.brainThink = async () => JSON.stringify({ summary: '恢复', actions: [] });
  hub._brainThinker = hub.brainThink;
  await hub.requestBrainThink({ trigger: 'manual' });
  assert.equal(hub.brain.consecutiveFailures, 0);
  assert.equal(hub.brain.effectiveIntervalSec, 1200);
});

test('纯 none 动作的思考不写心路（低价值过滤生效）', async (t) => {
  const env = await startTestHub(t, {
    brainThink: async () =>
      JSON.stringify({
        summary: '保持观察，无需动作',
        assessment: { goals: '观察', progress: '无变化', betterWay: '', improvement: '', myMove: '', ownerAsk: '' },
        actions: [{ action: 'none', reason: '继续观察', confidence: 0.8 }],
      }),
  });
  const hub = env.hub;
  const before = hub.journal.entries.length;
  await hub.requestBrainThink({ trigger: 'manual' });
  assert.equal(hub.journal.entries.length, before, 'none 决策不应写入心路');
  assert.equal(hub.brain.decisions.length, 1);
});
