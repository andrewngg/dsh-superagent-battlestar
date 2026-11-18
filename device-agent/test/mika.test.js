'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createExecutor } = require('../lib/executors.js');

const MOCK = path.join(__dirname, 'helpers', 'mock-mika.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'butler-mika-test-'));
}

function buildExecutor(tmp, env) {
  return createExecutor({
    config: {
      executor: {
        type: 'mika',
        mika: {
          command: process.execPath,
          commandArgs: [MOCK],
          workdir: tmp,
          timeoutMs: 30000,
          waitSeconds: 3,
        },
      },
    },
    env: { ...process.env, ...env },
  });
}

test('mika 执行器：run → wait → done 返回手机结果', async () => {
  const tmp = tempDir();
  try {
    const counter = path.join(tmp, 'counter.txt');
    const executor = buildExecutor(tmp, { MOCK_MIKA_COUNTER: counter, MOCK_MIKA_MODE: 'ok' });
    assert.ok(executor.availableTypes.includes('mika'));
    const result = await executor.run({
      task: { id: 'task_1', instruction: '给张三发微信消息：晚上一起吃饭' },
      device: { name: '手机 · Mika' },
      progress: async () => {},
    });
    assert.equal(result.error, undefined);
    assert.match(result.output.text, /已在手机上发送消息给张三/);
    assert.equal(result.output.data.executor, 'mika');
    assert.equal(result.output.data.taskId, 'mk_task_1');
    assert.equal(result.output.data.status, 'done');
    assert.equal(result.output.data.verified, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mika 执行器：等待手机回答时返回明确错误', async () => {
  const tmp = tempDir();
  try {
    const counter = path.join(tmp, 'counter.txt');
    const executor = buildExecutor(tmp, { MOCK_MIKA_COUNTER: counter, MOCK_MIKA_MODE: 'question' });
    const result = await executor.run({
      task: { id: 'task_2', instruction: '给联系人发消息' },
      progress: async () => {},
    });
    assert.ok(result.error, 'expected an error when Mika waits for an answer');
    assert.match(result.error, /需要回答/);
    assert.match(result.error, /要发送给谁/);
    assert.equal(result.output.data.status, 'waiting_for_answer');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mika 执行器：failed 状态回报错误', async () => {
  const tmp = tempDir();
  try {
    const counter = path.join(tmp, 'counter.txt');
    const executor = buildExecutor(tmp, { MOCK_MIKA_COUNTER: counter, MOCK_MIKA_MODE: 'fail' });
    const result = await executor.run({
      task: { id: 'task_3', instruction: '打开一个不存在的应用' },
      progress: async () => {},
    });
    assert.ok(result.error);
    assert.match(result.error, /任务失败/);
    assert.match(result.output.text, /无法打开目标应用/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mika 执行器：缺少指令时直接拒绝', async () => {
  const tmp = tempDir();
  try {
    const executor = buildExecutor(tmp, {});
    const result = await executor.run({ task: { id: 'task_4', instruction: '  ' } });
    assert.equal(result.error, '任务指令为空');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 手机自愈接线：把 mika-recovery 换成替身，验证执行器在什么时机自愈/重试
// ---------------------------------------------------------------------------

const mikaRecoveryModule = require('../lib/mika-recovery.js');

/** 用替身替换 createMikaRecovery，返回 { calls, restore }。 */
function stubRecovery({ healthy = true, ensureOk = true, a11yOk = healthy ? true : false } = {}) {
  const calls = [];
  const original = mikaRecoveryModule.createMikaRecovery;
  mikaRecoveryModule.createMikaRecovery = (options) => {
    let ok = healthy;
    calls.push({ kind: 'create', options });
    return {
      adb: options.adb,
      async diagnose() {
        calls.push('diagnose');
        return {
          ok,
          problems: ok ? [] : ['helper-not-running'],
          checks: [],
          a11yOk,
          summary: ok ? '正常' : '手机控制异常',
        };
      },
      async ensure({ onStep } = {}) {
        calls.push('ensure');
        if (!ensureOk) {
          return { ok: false, repaired: false, steps: [], report: { ok: false, problems: ['helper-not-running'] } };
        }
        if (onStep) onStep({ name: 'helper-start-1', ok: true, detail: '已发出启动指令' });
        ok = true;
        return { ok: true, repaired: true, steps: [{ name: 'helper-start-1', ok: true }], report: { ok: true, problems: [] } };
      },
    };
  };
  return { calls, restore: () => { mikaRecoveryModule.createMikaRecovery = original; } };
}

function buildRecoveryExecutor(tmp, env, recoveryCfg = {}) {
  return createExecutor({
    config: {
      executor: {
        type: 'mika',
        mika: {
          command: process.execPath,
          commandArgs: [MOCK],
          workdir: tmp,
          timeoutMs: 30000,
          waitSeconds: 3,
          adb: 'adb.exe',
          recovery: { enabled: true, preflight: true, ...recoveryCfg },
        },
      },
    },
    env: { ...process.env, ...env },
  });
}

test('mika 执行器：派发前自检不过 → 先自愈再派发任务', async () => {
  const tmp = tempDir();
  const stub = stubRecovery({ healthy: false });
  try {
    const counter = path.join(tmp, 'counter.txt');
    const messages = [];
    const executor = buildRecoveryExecutor(tmp, { MOCK_MIKA_COUNTER: counter, MOCK_MIKA_MODE: 'ok' });
    const result = await executor.run({
      task: { id: 'task_heal', instruction: '看一下手机时间' },
      progress: async (message) => { messages.push(String(message)); },
    });
    assert.equal(stub.calls.filter((item) => item === 'ensure').length, 1);
    assert.equal(result.error, undefined, `期望任务成功，实际：${result.error}`);
    assert.match(result.output.text, /已在手机上发送消息给张三/);
    assert.ok(messages.some((message) => message.includes('先自愈再派发')), `进度里应有自检提示：${messages.join(' | ')}`);
    assert.ok(messages.some((message) => message.includes('手机自愈 helper-start-1')), `进度里应有自愈步骤：${messages.join(' | ')}`);
  } finally {
    stub.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mika 执行器：只有手机助手没跑（无障碍正常）→ 不提前修，任务照常派发', async () => {
  const tmp = tempDir();
  const stub = stubRecovery({ healthy: false, a11yOk: true });
  try {
    const counter = path.join(tmp, 'counter.txt');
    const messages = [];
    const executor = buildRecoveryExecutor(tmp, { MOCK_MIKA_COUNTER: counter, MOCK_MIKA_MODE: 'ok' });
    const result = await executor.run({
      task: { id: 'task_helper_only', instruction: '看一下手机时间' },
      progress: async (message) => { messages.push(String(message)); },
    });
    assert.equal(stub.calls.filter((item) => item === 'ensure').length, 0, '无障碍正常时不应提前自愈');
    assert.equal(result.error, undefined, `期望任务成功，实际：${result.error}`);
    assert.ok(!messages.some((message) => message.includes('先自愈再派发')), `不应出现预习自愈提示：${messages.join(' | ')}`);
  } finally {
    stub.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mika 执行器：任务报手机控制类错误 → 自愈后自动重试并成功', async () => {
  const tmp = tempDir();
  const stub = stubRecovery({ healthy: true });
  try {
    const counter = path.join(tmp, 'counter.txt');
    const failOnce = path.join(tmp, 'phone-fail-once');
    fs.writeFileSync(failOnce, '1');
    const messages = [];
    const executor = buildRecoveryExecutor(tmp, {
      MOCK_MIKA_COUNTER: counter,
      MOCK_MIKA_MODE: 'ok',
      MOCK_MIKA_PHONE_FAIL_ONCE: failOnce,
    });
    const result = await executor.run({
      task: { id: 'task_retry', instruction: '给张三发微信消息：晚上一起吃饭' },
      progress: async (message) => { messages.push(String(message)); },
    });
    assert.equal(fs.existsSync(failOnce), false, '第一次 task run 应该已经失败并消费掉标记');
    assert.equal(result.error, undefined, `期望重试后成功，实际：${result.error}`);
    assert.equal(result.output.data.status, 'done');
    assert.equal(stub.calls.filter((item) => item === 'ensure').length, 1);
    assert.ok(messages.some((message) => message.includes('正在重试 Mika 任务')), `进度里应有重试提示：${messages.join(' | ')}`);
    assert.ok(messages.some((message) => message.includes('正在刷新 Mika 连接信息')), `自愈后应刷新连接信息：${messages.join(' | ')}`);
  } finally {
    stub.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mika 执行器：自愈也修不好 → 原错误附上排查提示', async () => {
  const tmp = tempDir();
  const stub = stubRecovery({ healthy: true, ensureOk: false });
  try {
    const counter = path.join(tmp, 'counter.txt');
    const failOnce = path.join(tmp, 'phone-fail-once');
    fs.writeFileSync(failOnce, '1');
    const executor = buildRecoveryExecutor(tmp, {
      MOCK_MIKA_COUNTER: counter,
      MOCK_MIKA_MODE: 'ok',
      MOCK_MIKA_PHONE_FAIL_ONCE: failOnce,
    });
    const result = await executor.run({ task: { id: 'task_fail', instruction: '打开相册' } });
    assert.ok(result.error, 'expected an error');
    assert.match(result.error, /phone_unavailable/);
    assert.match(result.error, /已通过 USB ADB 自愈并重试 1 次仍失败/);
    assert.match(result.error, /mika-phone-recovery\.js --check/);
  } finally {
    stub.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mika 执行器：没配 adb 时不启用自愈（Wi-Fi 模式不受影响）', async () => {
  const tmp = tempDir();
  const stub = stubRecovery({ healthy: false });
  try {
    const counter = path.join(tmp, 'counter.txt');
    const failOnce = path.join(tmp, 'phone-fail-once');
    fs.writeFileSync(failOnce, '1');
    const executor = createExecutor({
      config: {
        executor: {
          type: 'mika',
          mika: { command: process.execPath, commandArgs: [MOCK], workdir: tmp, timeoutMs: 30000, waitSeconds: 3 },
        },
      },
      env: { ...process.env, MOCK_MIKA_COUNTER: counter, MOCK_MIKA_MODE: 'ok', MOCK_MIKA_PHONE_FAIL_ONCE: failOnce },
    });
    const result = await executor.run({ task: { id: 'task_no_adb', instruction: '打开相册' } });
    assert.equal(stub.calls.filter((item) => item.kind === 'create').length, 0, '没有 adb 就不该创建自愈器');
    assert.ok(result.error);
    assert.match(result.error, /phone_unavailable/);
    assert.doesNotMatch(result.error, /已通过 USB ADB 自愈/);
  } finally {
    stub.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
