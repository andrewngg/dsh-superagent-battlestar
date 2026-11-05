'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { MockHub } = require('./helpers/mock-hub');
const { Agent, FatalSetupError } = require('../agent');
const { createSilentLogger } = require('../lib/logger');
const { resolveStateFile } = require('../lib/state');

const TEST_MANIFEST = {
  name: '测试设备',
  platform: 'windows',
  kind: 'dsh',
  agentVersion: '0.1.0',
  tags: ['测试'],
  models: [{ id: 'deepseek-chat', provider: 'deepseek', strengths: ['code'] }],
  profiles: [],
  gateways: [],
  skills: [{ id: 'office-docx', name: 'Word 文档' }],
  resources: { cpuCores: 8, memoryGB: 16, os: 'Windows 11' },
  limits: { maxConcurrentTasks: 2 },
};

function makeRunCommand(taskId, overrides = {}) {
  return {
    id: `cmd_${taskId}`,
    type: 'run_task',
    taskId,
    createdAt: new Date().toISOString(),
    payload: {
      instruction: '把本周家庭开销整理成 Word 报告',
      requirements: { skills: ['office-docx'] },
      priority: 5,
      timeoutSec: 30,
      context: { deviceName: '测试设备' },
      ...overrides,
    },
  };
}

function createAgent(hub, stateDir, options = {}) {
  const simulate = options.simulate || { minDurationMs: 80, maxDurationMs: 140, minSteps: 3, maxSteps: 4 };
  return new Agent({
    hub: hub.url,
    joinCode: options.joinCode === undefined ? 'test-join' : options.joinCode,
    name: '测试设备',
    manifest: options.manifest || TEST_MANIFEST,
    stateDir,
    intervalMs: 100,
    pollWaitMs: 120,
    logger: createSilentLogger(),
    env: {},
    config: {
      executor: { type: 'simulate', simulate },
      ...(options.config || {}),
    },
  });
}

async function makeTempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'butler-agent-'));
}

// ---------------------------------------------------------------------------

test('全链路：注册 → 心跳 → 领命令 → ack → progress → result', async () => {
  const hub = new MockHub();
  await hub.listen();
  const stateDir = await makeTempDir();
  const agent = createAgent(hub, stateDir);
  try {
    const device = await agent.start();
    assert.ok(device.id.startsWith('dev_'));
    assert.equal(hub.devices.size, 1);
    assert.equal(hub.records.registers.length, 1);
    assert.equal(hub.records.registers[0].headers['x-butler-join-code'], 'test-join');

    // 心跳内容符合 §5.3
    await hub.waitFor(() => hub.records.heartbeats.length >= 1, { timeoutMs: 4000, label: '首心跳' });
    const heartbeat = hub.records.heartbeats[0].body;
    assert.ok(['idle', 'busy'].includes(heartbeat.status));
    assert.deepEqual(heartbeat.load, { running: 0, max: 2 });
    assert.ok(heartbeat.metrics);
    assert.equal(typeof heartbeat.metrics.uptimeSec, 'number');

    // 状态文件已保存 deviceId/deviceToken
    const state = JSON.parse(await fsp.readFile(agent.stateFile, 'utf8'));
    assert.equal(state.deviceId, device.id);
    assert.ok(state.deviceToken);
    assert.equal(state.hub, hub.url);

    // 下发命令 → ack → progress → result
    hub.pushCommand(device.id, makeRunCommand('task_flow01'));
    const result = await hub.waitFor(() => hub.findResult('task_flow01'), { timeoutMs: 10000, label: '任务结果' });
    assert.equal(result.body.ok, true);
    assert.ok(result.body.durationMs > 0);
    assert.match(result.body.output.text, /任务已完成/);
    assert.ok(result.body.output.markdown);
    assert.equal(result.body.output.data.simulated, true);
    assert.ok(hub.records.acks.some((ack) => ack.taskId === 'task_flow01'));
    assert.ok(hub.records.progresses.length >= 1);
    assert.equal(hub.records.progresses[0].body.message.length > 0, true);

    // 任务结束后心跳负载回落
    await hub.waitFor(
      () => {
        const last = hub.records.heartbeats[hub.records.heartbeats.length - 1];
        return last && last.body.load.running === 0;
      },
      { timeoutMs: 4000, label: '心跳负载回落' },
    );
  } finally {
    await agent.stop({ unregister: true });
    await hub.close();
    await fsp.rm(stateDir, { recursive: true, force: true });
  }
});

test('状态文件恢复：重启后用 deviceId+deviceToken 更新 manifest，不重复占号', async () => {
  const hub = new MockHub();
  await hub.listen();
  const stateDir = await makeTempDir();
  const agentA = createAgent(hub, stateDir);
  let agentB = null;
  try {
    await agentA.start();
    const deviceId = agentA.device.id;
    await agentA.stop({ unregister: false });
    assert.equal(hub.devices.size, 1);
    assert.equal(hub.records.registers.length, 1);

    agentB = createAgent(hub, stateDir);
    const device = await agentB.start();
    assert.equal(device.id, deviceId);
    assert.equal(hub.records.registers.length, 1, '恢复时不应重新注册');
    assert.ok(hub.records.manifests.length >= 1, '恢复时应调用 POST /:id/manifest');
    assert.equal(hub.devices.size, 1);

    hub.pushCommand(deviceId, makeRunCommand('task_restore'));
    const result = await hub.waitFor(() => hub.findResult('task_restore'), { timeoutMs: 10000, label: '恢复后任务结果' });
    assert.equal(result.body.ok, true);
  } finally {
    if (agentB) await agentB.stop({ unregister: true });
    await agentA.stop({ unregister: false });
    await hub.close();
    await fsp.rm(stateDir, { recursive: true, force: true });
  }
});

test('状态文件损坏：记录告警并用加入码重新注册', async () => {
  const hub = new MockHub();
  await hub.listen();
  const stateDir = await makeTempDir();
  const stateFile = resolveStateFile({ stateDir, name: '测试设备', hubUrl: hub.url });
  try {
    await fsp.mkdir(path.dirname(stateFile), { recursive: true });
    await fsp.writeFile(stateFile, '{ 损坏的 JSON', 'utf8');

    const agent = createAgent(hub, stateDir);
    try {
      await agent.start();
      assert.equal(hub.records.registers.length, 1);
      assert.equal(hub.devices.size, 1);
      const state = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
      assert.ok(state.deviceId);
      assert.ok(state.deviceToken);
    } finally {
      await agent.stop({ unregister: true });
    }
  } finally {
    await hub.close();
    await fsp.rm(stateDir, { recursive: true, force: true });
  }
});

test('cancel 命令可中止执行中的任务并回报 cancelled', async () => {
  const hub = new MockHub();
  await hub.listen();
  const stateDir = await makeTempDir();
  const agent = createAgent(hub, stateDir, {
    simulate: { minDurationMs: 3000, maxDurationMs: 3500, minSteps: 4, maxSteps: 4 },
  });
  try {
    const device = await agent.start();
    hub.pushCommand(device.id, makeRunCommand('task_cancel01'));
    await hub.waitFor(() => hub.records.acks.some((ack) => ack.taskId === 'task_cancel01'), {
      timeoutMs: 5000,
      label: '任务 ack',
    });
    hub.pushCommand(device.id, {
      id: 'cmd_cancel01',
      type: 'cancel_task',
      taskId: 'task_cancel01',
      createdAt: new Date().toISOString(),
      payload: { taskId: 'task_cancel01' },
    });
    const result = await hub.waitFor(() => hub.findResult('task_cancel01'), { timeoutMs: 8000, label: '取消结果' });
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error, 'cancelled');
  } finally {
    await agent.stop({ unregister: true });
    await hub.close();
    await fsp.rm(stateDir, { recursive: true, force: true });
  }
});

test('任务超时：设备主动中止并 result(ok:false, error:"timeout")', async () => {
  const hub = new MockHub();
  await hub.listen();
  const stateDir = await makeTempDir();
  const agent = createAgent(hub, stateDir, {
    simulate: { minDurationMs: 2500, maxDurationMs: 2800, minSteps: 4, maxSteps: 4 },
  });
  try {
    const device = await agent.start();
    hub.pushCommand(device.id, makeRunCommand('task_timeout01', { timeoutSec: 1 }));
    const result = await hub.waitFor(() => hub.findResult('task_timeout01'), { timeoutMs: 10000, label: '超时结果' });
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error, 'timeout');
    assert.ok(result.body.durationMs >= 1000);
  } finally {
    await agent.stop({ unregister: true });
    await hub.close();
    await fsp.rm(stateDir, { recursive: true, force: true });
  }
});

test('并发上限：limits.maxConcurrentTasks=1 时排队串行执行', async () => {
  const hub = new MockHub();
  await hub.listen();
  const stateDir = await makeTempDir();
  const manifest = { ...TEST_MANIFEST, limits: { maxConcurrentTasks: 1 } };
  const agent = createAgent(hub, stateDir, { manifest });
  try {
    const device = await agent.start();
    hub.pushCommand(device.id, makeRunCommand('task_seq_a'));
    hub.pushCommand(device.id, makeRunCommand('task_seq_b'));
    await hub.waitFor(() => hub.findResult('task_seq_a') && hub.findResult('task_seq_b'), {
      timeoutMs: 15000,
      label: '两个任务结果',
    });
    assert.equal(hub.findResult('task_seq_a').body.ok, true);
    assert.equal(hub.findResult('task_seq_b').body.ok, true);
    // 两条命令都 ack 过
    assert.ok(hub.records.acks.some((ack) => ack.taskId === 'task_seq_a'));
    assert.ok(hub.records.acks.some((ack) => ack.taskId === 'task_seq_b'));
  } finally {
    await agent.stop({ unregister: true });
    await hub.close();
    await fsp.rm(stateDir, { recursive: true, force: true });
  }
});

test('令牌失效：心跳 401 后自动用加入码重新注册并继续执行', async () => {
  const hub = new MockHub();
  await hub.listen();
  const stateDir = await makeTempDir();
  const agent = createAgent(hub, stateDir);
  try {
    await agent.start();
    const firstId = agent.device.id;
    // 模拟 Hub 侧令牌轮换/状态丢失
    hub.devices.get(firstId).token = 'rotated-token';

    await hub.waitFor(() => hub.records.registers.length >= 2, { timeoutMs: 10000, label: '重新注册' });
    const secondDevice = hub.deviceList().find((d) => d.id !== firstId);
    assert.ok(secondDevice, '应注册出新的设备');
    await hub.waitFor(() => agent.device && agent.device.id === secondDevice.id, {
      timeoutMs: 5000,
      label: 'Agent 切换到新设备',
    });
    hub.pushCommand(secondDevice.id, makeRunCommand('task_reauth'));
    const result = await hub.waitFor(() => hub.findResult('task_reauth'), { timeoutMs: 10000, label: '重注册后任务' });
    assert.equal(result.body.ok, true);
  } finally {
    await agent.stop({ unregister: true });
    await hub.close();
    await fsp.rm(stateDir, { recursive: true, force: true });
  }
});

test('--once 单次运行：注册 → 心跳领命令 → 执行 → 退出（不注销）', async () => {
  const hub = new MockHub();
  await hub.listen();
  const stateDir = await makeTempDir();
  const agent = createAgent(hub, stateDir);
  try {
    hub.commandForNextHeartbeat(makeRunCommand('task_once01'));
    const stats = await agent.runOnce({ waitMs: 300 });
    assert.equal(stats.commands, 1);
    assert.equal(stats.tasksCompleted, 1);
    assert.ok(hub.findResult('task_once01'));
    assert.equal(hub.findResult('task_once01').body.ok, true);
    assert.equal(hub.records.registers.length, 1);
    assert.equal(hub.devices.size, 1, '--once 不应注销设备');
    assert.equal(agent.stopped, true);
  } finally {
    await agent.stop({ unregister: false });
    await hub.close();
    await fsp.rm(stateDir, { recursive: true, force: true });
  }
});

test('stop({unregister:true}) 会向 Hub 注销设备（SIGINT 优雅退出路径）', async () => {
  const hub = new MockHub();
  await hub.listen();
  const stateDir = await makeTempDir();
  const agent = createAgent(hub, stateDir);
  try {
    const device = await agent.start();
    await agent.stop({ unregister: true, reason: 'SIGINT' });
    assert.ok(hub.records.unregisters.some((record) => record.deviceId === device.id));
    assert.equal(hub.devices.size, 0);
  } finally {
    await agent.stop({ unregister: false });
    await hub.close();
    await fsp.rm(stateDir, { recursive: true, force: true });
  }
});

test('加入码错误：启动失败并给出可读错误（退出码 2 的路径）', async () => {
  const hub = new MockHub();
  await hub.listen();
  const stateDir = await makeTempDir();
  const agent = createAgent(hub, stateDir, { joinCode: 'wrong-code' });
  try {
    await assert.rejects(
      () => agent.start(),
      (err) => {
        assert.ok(err instanceof FatalSetupError);
        assert.match(err.message, /加入码/);
        return true;
      },
    );
    assert.equal(hub.devices.size, 0);
  } finally {
    await agent.stop({ unregister: false });
    await hub.close();
    await fsp.rm(stateDir, { recursive: true, force: true });
  }
});

test('无加入码且无本地状态：给出明确提示，不无限重试', async () => {
  const hub = new MockHub();
  await hub.listen();
  const stateDir = await makeTempDir();
  const agent = createAgent(hub, stateDir, { joinCode: '' });
  try {
    await assert.rejects(
      () => agent.start(),
      (err) => {
        assert.ok(err instanceof FatalSetupError);
        assert.match(err.message, /加入码/);
        return true;
      },
    );
  } finally {
    await agent.stop({ unregister: false });
    await hub.close();
    await fsp.rm(stateDir, { recursive: true, force: true });
  }
});
