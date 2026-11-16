'use strict';

/**
 * P0 回归（设备侧）：收到 run_task 先 ack、按 taskId 去重、队列上限与排队 keepalive。
 * 这些行为用于打断“Hub 重派 → 设备重复执行 → 结果被拒 → Hub 再重派”的死循环。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Agent } = require('../agent');
const { createSilentLogger } = require('../lib/logger');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(fn, { timeout = 3000, interval = 10, label = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(interval);
  }
  throw new Error(`等待超时：${label}`);
}

function createHarness(t) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-agent-queue-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const agent = new Agent({
    hub: 'http://127.0.0.1:1',
    name: 'queue-test',
    stateDir,
    discoverHub: false,
    env: {},
    logger: createSilentLogger(),
  });
  const calls = { acks: [], progresses: [], results: [] };
  agent.client = {
    deviceId: 'dev_test01',
    ack: async (taskId) => {
      calls.acks.push(taskId);
      return { status: 200, json: { ok: true } };
    },
    progress: async (taskId, body) => {
      calls.progresses.push({ taskId, body });
      return { status: 200, json: { ok: true } };
    },
    result: async (taskId, body) => {
      calls.results.push({ taskId, body });
      return { status: 200, json: { ok: true, ignored: false } };
    },
  };
  // 单元测试只验证队列/ack 行为，不真正启动执行器。
  agent._pump = () => {};
  agent.device = { id: 'dev_test01' };
  return { agent, calls, stateDir };
}

function runCommand(id, taskId) {
  return {
    id,
    type: 'run_task',
    taskId,
    createdAt: new Date().toISOString(),
    payload: { instruction: `任务 ${taskId}` },
  };
}

test('收到即 ack：入队时立即 ack，同一个 taskId 的重复派发被丢弃', async (t) => {
  const { agent, calls } = createHarness(t);

  agent.enqueueCommands([runCommand('cmd_a1', 'task_a')]);
  await waitUntil(() => agent.ackedTasks.has('task_a'), { label: '入队 ack' });

  assert.deepEqual(calls.acks, ['task_a'], '收到 run_task 应立即 ack');
  assert.equal(agent.queue.length, 1);
  assert.equal(agent.taskIdIndex.has('task_a'), true);

  // Hub 换了一个 command id 重派同一个任务：按 taskId 去重，不重复入队、不重复 ack。
  agent.enqueueCommands([runCommand('cmd_a2', 'task_a')]);
  await waitUntil(() => agent.stats.duplicateCommands === 1, { label: '重复派发计数' });

  assert.equal(agent.queue.length, 1, '队列中同一个 taskId 只能有一份');
  assert.equal(agent.queue[0].id, 'cmd_a1');
  assert.deepEqual(calls.acks, ['task_a'], '已 ack 过的任务不再重复 ack');
});

test('ack 失败时丢弃排队命令，等待 Hub 重新派发', async (t) => {
  const { agent, calls } = createHarness(t);
  agent.client.ack = async (taskId) => {
    calls.acks.push(taskId);
    throw new Error('acl denied');
  };

  agent.enqueueCommands([runCommand('cmd_b1', 'task_b')]);
  await waitUntil(() => !agent.taskIdIndex.has('task_b'), { label: '丢弃 ack 失败的命令' });

  assert.equal(agent.queue.length, 0);
  assert.equal(agent.ackedTasks.has('task_b'), false);
  assert.deepEqual(calls.acks, ['task_b']);
});

test('队列上限：满时丢弃新命令且不记 seen，允许 Hub 稍后重投', async (t) => {
  const { agent, calls } = createHarness(t);
  agent.maxQueueSize = 2;

  agent.enqueueCommands([
    runCommand('cmd_c1', 'task_c1'),
    runCommand('cmd_c2', 'task_c2'),
    runCommand('cmd_c3', 'task_c3'),
  ]);
  await waitUntil(() => calls.acks.length >= 2, { label: '前两个任务 ack' });

  assert.equal(agent.queue.length, 2);
  assert.equal(agent.stats.queueDropped, 1);
  assert.equal(agent.seenCommandIds.has('cmd_c3'), false, '被丢弃的命令不能记为已处理');

  // 队列仍然满：再次投递仍被丢弃。
  agent.enqueueCommands([runCommand('cmd_c3', 'task_c3')]);
  await waitUntil(() => agent.stats.queueDropped === 2, { label: '队列满再次丢弃' });
  assert.equal(agent.queue.length, 2);

  // 腾出队列后，同一个命令可被正常接收。
  agent.queue.length = 0;
  agent.taskIdIndex.clear();
  agent.ackedTasks.clear();
  agent.enqueueCommands([runCommand('cmd_c3', 'task_c3')]);
  await waitUntil(() => agent.taskIdIndex.has('task_c3'), { label: '重新接收' });
  assert.equal(agent.queue.length, 1);
  assert.equal(agent.seenCommandIds.has('cmd_c3'), true);
});

test('排队 keepalive：只对已 ack 且未执行的任务发送', async (t) => {
  const { agent, calls } = createHarness(t);
  agent.taskKeepaliveMs = 20;
  agent.ackedTasks = new Set(['task_x', 'task_y']);
  agent.running.set('task_x', { taskId: 'task_x' });

  agent._startQueueKeepalive();
  await sleep(1300);
  clearInterval(agent.queueKeepaliveTimer);
  agent.queueKeepaliveTimer = null;

  const keepalives = calls.progresses.filter((item) => item.body && item.body.keepalive === true);
  assert.ok(keepalives.length >= 1, '排队任务应发送 keepalive');
  assert.ok(keepalives.every((item) => item.taskId === 'task_y'), '执行中的任务不应重复排队 keepalive');
});

test('结果被 Hub 收敛忽略时计入统计，不再重试', async (t) => {
  const { agent, calls } = createHarness(t);
  agent.client.result = async (taskId, body) => {
    calls.results.push({ taskId, body });
    return {
      status: 200,
      json: { ok: true, ignored: true, reason: '任务已 completed' },
    };
  };

  await agent._reportResult({ taskId: 'task_r', startedAt: Date.now() }, { ok: true });
  assert.equal(agent.stats.resultsIgnored, 1);
  assert.equal(calls.results.length, 1);
});
