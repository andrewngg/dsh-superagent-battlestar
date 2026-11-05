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
