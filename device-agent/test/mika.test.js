'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createExecutor,
  findInstructionFileRefs,
  rewriteInstructionForPhone,
} = require('../lib/executors.js');

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
      async wake() {
        calls.push('wake');
        return { steps: [{ name: 'wake', ok: true, detail: '屏幕已唤醒' }], awake: true };
      },
      async launchApp() {
        calls.push('launchApp');
        return { steps: [{ name: 'launch', ok: true, detail: '已拉起 Mika' }], ok: true };
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

test('mika 执行器：连接错误（CLI 连不上手机）→ 自愈 + 刷新连接后重试成功', async () => {
  const tmp = tempDir();
  const stub = stubRecovery({ healthy: true });
  try {
    const counter = path.join(tmp, 'counter.txt');
    const failOnce = path.join(tmp, 'connection-fail-once');
    fs.writeFileSync(failOnce, '1');
    const messages = [];
    const executor = buildRecoveryExecutor(tmp, {
      MOCK_MIKA_COUNTER: counter,
      MOCK_MIKA_MODE: 'ok',
      MOCK_MIKA_CONNECTION_FAIL_ONCE: failOnce,
    });
    const result = await executor.run({
      task: { id: 'task_connection', instruction: '看一下手机时间' },
      progress: async (message) => { messages.push(String(message)); },
    });
    assert.equal(fs.existsSync(failOnce), false, '第一次 task run 应消费掉连接失败标记');
    assert.equal(result.error, undefined, `连接错误应自愈后重试成功，实际：${result.error}`);
    assert.equal(result.output.data.status, 'done');
    assert.equal(stub.calls.filter((item) => item === 'ensure').length, 1);
    assert.ok(messages.some((message) => message.includes('正在通过 USB ADB 自愈')), `进度里应有自愈提示：${messages.join(' | ')}`);
    assert.ok(messages.some((message) => message.includes('正在刷新 Mika 连接信息')), `自愈后应刷新连接信息：${messages.join(' | ')}`);
    assert.ok(messages.some((message) => message.includes('正在重试 Mika 任务')), `进度里应有重试提示：${messages.join(' | ')}`);
  } finally {
    stub.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mika 执行器：关闭 adb 自愈时，连接错误仍先 mika connect 刷新后重试', async () => {
  const tmp = tempDir();
  const stub = stubRecovery({ healthy: true });
  try {
    const counter = path.join(tmp, 'counter.txt');
    const failOnce = path.join(tmp, 'connection-fail-once');
    fs.writeFileSync(failOnce, '1');
    const messages = [];
    const executor = buildRecoveryExecutor(
      tmp,
      { MOCK_MIKA_COUNTER: counter, MOCK_MIKA_MODE: 'ok', MOCK_MIKA_CONNECTION_FAIL_ONCE: failOnce },
      { enabled: false },
    );
    const result = await executor.run({
      task: { id: 'task_connection_connect_only', instruction: '看一下手机时间' },
      progress: async (message) => { messages.push(String(message)); },
    });
    assert.equal(fs.existsSync(failOnce), false, '第一次 task run 应消费掉连接失败标记');
    assert.equal(result.error, undefined, `应刷新连接后重试成功，实际：${result.error}`);
    assert.equal(result.output.data.status, 'done');
    assert.equal(stub.calls.filter((item) => item.kind === 'create').length, 0, '关闭自愈时不应创建 adb 自愈器');
    assert.ok(messages.some((message) => message.includes('正在刷新 Mika 连接信息')), `应有刷新连接提示：${messages.join(' | ')}`);
    assert.ok(messages.some((message) => message.includes('正在重试 Mika 任务')), `进度里应有重试提示：${messages.join(' | ')}`);
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

test('mika 执行器：connect 被锁屏挡住时先唤醒手机并重试连接', async () => {
  const tmp = tempDir();
  const stub = stubRecovery({ healthy: true });
  try {
    const counter = path.join(tmp, 'counter.txt');
    const connectionFailOnce = path.join(tmp, 'connection-fail-once');
    const connectFailOnce = path.join(tmp, 'connect-fail-once');
    fs.writeFileSync(connectionFailOnce, '1');
    fs.writeFileSync(connectFailOnce, '1');
    const messages = [];
    const executor = buildRecoveryExecutor(tmp, {
      MOCK_MIKA_COUNTER: counter,
      MOCK_MIKA_MODE: 'ok',
      MOCK_MIKA_CONNECTION_FAIL_ONCE: connectionFailOnce,
      MOCK_MIKA_CONNECT_FAIL_ONCE: connectFailOnce,
    });
    const result = await executor.run({
      task: { id: 'task_locked', instruction: '看一下手机时间' },
      progress: async (message) => { messages.push(String(message)); },
    });
    assert.equal(fs.existsSync(connectFailOnce), false, '第一次 connect 应消费掉锁屏标记');
    assert.equal(result.error, undefined, `唤醒后应重试成功，实际：${result.error}`);
    assert.equal(result.output.data.status, 'done');
    assert.ok(stub.calls.includes('wake'), `应调用唤醒：${stub.calls.join(',')}`);
    assert.ok(stub.calls.includes('launchApp'), `应拉起 Mika：${stub.calls.join(',')}`);
    assert.ok(
      messages.some((message) => message.includes('正在唤醒手机并打开 Mika')),
      `进度里应有唤醒提示：${messages.join(' | ')}`,
    );
    assert.ok(
      messages.some((message) => message.includes('手机已唤醒，重新刷新 Mika 连接信息')),
      `进度里应有重试刷新提示：${messages.join(' | ')}`,
    );
  } finally {
    stub.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mika 执行器：派发前先在母机侧检查并修复 Mika 连接', async () => {
  const tmp = tempDir();
  const stub = stubRecovery({ healthy: true });
  try {
    const counter = path.join(tmp, 'counter.txt');
    const messages = [];
    const executor = buildRecoveryExecutor(tmp, { MOCK_MIKA_COUNTER: counter, MOCK_MIKA_MODE: 'ok' });
    const result = await executor.run({
      task: { id: 'task_preflight', instruction: '看一下手机时间' },
      progress: async (message) => { messages.push(String(message)); },
    });
    assert.equal(result.error, undefined, `期望任务成功，实际：${result.error}`);
    assert.ok(
      messages.some((message) => message.includes('正在通过母机 ADB 检查并修复 Mika 连接')),
      `派发前应有母机侧连接预检：${messages.join(' | ')}`,
    );
    assert.ok(messages.some((message) => message.includes('Mika 连接已就绪，开始派发手机任务')));
  } finally {
    stub.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mika 执行器：连接修复失败时不把指令发到手机', async () => {
  const tmp = tempDir();
  const stub = stubRecovery({ healthy: true });
  try {
    const counter = path.join(tmp, 'counter.txt');
    const capture = path.join(tmp, 'goal-captured.txt');
    const messages = [];
    const executor = buildRecoveryExecutor(tmp, {
      MOCK_MIKA_COUNTER: counter,
      MOCK_MIKA_MODE: 'ok',
      MOCK_MIKA_GOAL_CAPTURE: capture,
      MOCK_MIKA_CONNECT_FAIL_ALWAYS: '1',
    });
    const result = await executor.run({
      task: { id: 'task_unready', instruction: '打开求职 App 投递简历' },
      progress: async (message) => { messages.push(String(message)); },
    });
    assert.ok(result.error, '连接没修好时应该失败');
    assert.match(result.error, /本次指令没有发送到手机/);
    assert.equal(fs.existsSync(capture), false, '连接未就绪时不应把指令派发到手机');
    assert.ok(!messages.some((message) => message.includes('正在通过 Mika 派发手机任务')));
  } finally {
    stub.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mika 执行器：指令里的电脑文件路径改写为手机 Download 说法', async () => {
  const tmp = tempDir();
  const stub = stubRecovery({ healthy: true });
  try {
    const counter = path.join(tmp, 'counter.txt');
    const capture = path.join(tmp, 'goal-captured.txt');
    const pdf = path.join(tmp, 'resume.pdf');
    fs.writeFileSync(pdf, 'test pdf');
    const instruction = `把简历投出去；resume.pdf 位于 ${pdf}`;
    const executor = buildRecoveryExecutor(tmp, {
      MOCK_MIKA_COUNTER: counter,
      MOCK_MIKA_MODE: 'ok',
      MOCK_MIKA_GOAL_CAPTURE: capture,
    });
    const result = await executor.run({ task: { id: 'task_pdf', instruction } });
    assert.equal(result.error, undefined, `任务应成功，实际：${result.error}`);
    const sent = fs.readFileSync(capture, 'utf8');
    assert.ok(!sent.includes(tmp), '不应把电脑路径直接发给手机');
    assert.match(sent, /手机「下载\/Download」文件夹里的 resume\.pdf/);
    assert.match(sent, /Android 手机上执行，无法访问电脑路径/);
  } finally {
    stub.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mika 指令文件引用：识别 Windows 路径并改写为手机 Download', () => {
  const instruction = '执行 python applier.py；resume.pdf 位于 C:\\Users\\someone\\Downloads\\resume.pdf';
  const refs = findInstructionFileRefs(instruction);
  assert.equal(refs.length, 1);
  assert.equal(path.basename(refs[0].path), 'resume.pdf');
  const placed = rewriteInstructionForPhone(instruction, { placedFiles: ['resume.pdf'] });
  assert.doesNotMatch(placed, /C:\\Users/);
  assert.match(placed, /手机「下载\/Download」文件夹里的 resume\.pdf/);
  assert.match(placed, /已经放到手机的「下载\/Download」文件夹/);
  assert.equal(findInstructionFileRefs('没有文件的普通任务').length, 0);
});
