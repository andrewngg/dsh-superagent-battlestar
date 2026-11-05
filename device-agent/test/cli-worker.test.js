'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const worker = require('../cli-worker.js');

test('chooseBackend：默认 hermes，代码任务走 opencode，shell 需显式允许', () => {
  assert.equal(worker.chooseBackend({ instruction: '帮我整理一下下周计划' }), 'hermes');
  assert.equal(worker.chooseBackend({ instruction: '写一个 hello.js 脚本' }), 'opencode');
  assert.equal(worker.chooseBackend({ instruction: '修复这个 bug' }), 'opencode');
  assert.equal(worker.chooseBackend({ instruction: '只输出 pong' }), 'hermes');
  assert.equal(worker.chooseBackend({ mode: 'hermes', instruction: '写代码' }), 'hermes');
  assert.equal(worker.chooseBackend({ mode: 'opencode' }), 'opencode');
});

test('chooseBackend：profile 可强制指定后端', () => {
  assert.equal(worker.chooseBackend({ profile: 'opencode', instruction: '随便聊聊' }), 'opencode');
  assert.equal(worker.chooseBackend({ profile: 'hermes-lovbot', instruction: '写代码' }), 'hermes');
  assert.equal(worker.chooseBackend({ profile: 'cli-shell', instruction: '列目录', allowShell: true }), 'shell');
  assert.throws(() => worker.chooseBackend({ profile: 'cli-shell', instruction: '列目录' }), /shell 模式未启用/);
});

test('chooseBackend：shell 前缀与 allowShell 保护', () => {
  assert.throws(() => worker.chooseBackend({ instruction: '!node -v' }), /shell 模式未启用/);
  assert.equal(worker.chooseBackend({ instruction: '!node -v', allowShell: true }), 'shell');
  assert.equal(worker.chooseBackend({ instruction: '/run node -v', allowShell: true }), 'shell');
});

test('buildHermesArgs：包含一次性提示、模型、工作目录与自动批准', () => {
  const args = worker.buildHermesArgs({
    instruction: '运行 node -v',
    model: 'deepseek-chat',
    provider: 'deepseek',
    workdir: 'C:\\work',
  });
  assert.deepEqual(args, [
    '--cli',
    '--yolo',
    '-m', 'deepseek-chat',
    '--provider', 'deepseek',
    '--in', 'C:\\work',
    '-z', '运行 node -v',
  ]);
  const noYolo = worker.buildHermesArgs({ instruction: 'hi', yolo: false });
  assert.ok(!noYolo.includes('--yolo'));
  assert.equal(noYolo[noYolo.length - 1], 'hi');
});

test('buildOpencodeArgs：非交互 JSON 输出与模型参数', () => {
  const args = worker.buildOpencodeArgs({
    instruction: '写一个 hello.js',
    model: 'opencode/deepseek-v4-flash-free',
    workdir: 'C:\\work',
  });
  assert.deepEqual(args, [
    'run', '写一个 hello.js',
    '-m', 'opencode/deepseek-v4-flash-free',
    '--format', 'json',
    '--dir', 'C:\\work',
    '--auto',
  ]);
});

test('extractOpencodeText：从 JSONL 提取正文与错误', () => {
  const stdout = [
    JSON.stringify({ type: 'step_start' }),
    JSON.stringify({ type: 'text', text: '第一段' }),
    JSON.stringify({ type: 'message.part.updated', properties: { part: { type: 'text', text: '第二段' } } }),
    'not a json line',
  ].join('\n');
  const parsed = worker.extractOpencodeText(stdout);
  assert.equal(parsed.text, '第一段第二段');
  assert.equal(parsed.error, '');

  const failed = worker.extractOpencodeText(
    JSON.stringify({ type: 'error', error: { name: 'APIError', data: { message: 'Model is unavailable' } } }),
  );
  assert.equal(failed.error, 'Model is unavailable');
});

test('parseCliArgs：解析设备代理传入的参数', () => {
  const args = worker.parseCliArgs([
    '--instruction', '你好',
    '--mode', 'auto',
    '--profile', 'hermes',
    '--model', 'deepseek-chat',
    '--workdir', 'C:\\work',
    '--allow-shell',
    '--fallback-hermes',
    '--timeout-ms', '120000',
  ]);
  assert.equal(args.instruction, '你好');
  assert.equal(args.mode, 'auto');
  assert.equal(args.profile, 'hermes');
  assert.equal(args.model, 'deepseek-chat');
  assert.equal(args.workdir, 'C:\\work');
  assert.equal(args.allowShell, true);
  assert.equal(args.fallbackHermes, true);
  assert.equal(args.timeoutMs, 120000);
});

test('hermesProfileHome：hermes-<profile> 映射到 profiles 目录', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-hermes-home-'));
  fs.mkdirSync(path.join(home, 'profiles', 'lovbot'), { recursive: true });
  try {
    assert.equal(worker.hermesProfileHome(home, ''), home);
    assert.equal(worker.hermesProfileHome(home, 'hermes'), home);
    assert.equal(worker.hermesProfileHome(home, 'lovbot'), home);
    assert.equal(worker.hermesProfileHome(home, 'hermes-lovbot'), path.join(home, 'profiles', 'lovbot'));
    assert.equal(worker.hermesProfileHome(home, 'hermes-not-exist'), home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('stripAnsi：去掉终端颜色码', () => {
  assert.equal(worker.stripAnsi('\u001b[32mok\u001b[0m'), 'ok');
});
