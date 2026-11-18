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

test('providerForModel：按模型/显式映射选择 provider', () => {
  assert.equal(worker.providerForModel('deepseek-chat'), 'deepseek');
  assert.equal(worker.providerForModel('agnes-2.5-flash'), 'custom');
  assert.equal(worker.providerForModel('custom-model'), '');
  assert.equal(worker.providerForModel('agnes-2.5-flash', { 'agnes-2.5-flash': 'agnes' }), 'agnes');
  assert.equal(worker.providerForModel('unknown', { unknown: 'my-provider' }), 'my-provider');
});

test('Hermes 技能：--skills 透传，promptPrefix 只包在用户任务前', () => {
  const args = worker.buildHermesArgs({
    instruction: '生成一段视频',
    skills: 'comfyui-workflow',
  });
  assert.deepEqual(args.slice(-4), ['--skills', 'comfyui-workflow', '-z', '生成一段视频']);
  assert.equal(worker.composePrompt('必须使用 comfyui-workflow', '生成一张图'), '必须使用 comfyui-workflow\n\n用户任务：\n生成一张图');
});

test('buildOpencodeArgs：非交互 JSON 输出与模型参数', () => {
  const args = worker.buildOpencodeArgs({
    instruction: '写一个 hello.js',
    model: 'deepseek/deepseek-flash',
    workdir: 'C:\\work',
  });
  assert.deepEqual(args, [
    'run', '写一个 hello.js',
    '-m', 'deepseek/deepseek-flash',
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

test('parseCliArgs 与 sessionKeyFor：计划子任务用 taskId 隔离会话', () => {
  const args = worker.parseCliArgs([
    '--instruction', 'x',
    '--thread-id', 'thread_1',
    '--task-id', 'task_c1',
    '--parent-task-id', 'task_p',
  ]);
  assert.equal(args.threadId, 'thread_1');
  assert.equal(args.taskId, 'task_c1');
  assert.equal(args.parentTaskId, 'task_p');
  assert.equal(worker.sessionKeyFor(args), 'task:task_c1');

  assert.equal(worker.sessionKeyFor({ threadId: 'thread_1' }), 'thread_1');
  assert.equal(worker.sessionKeyFor({ threadId: 'thread_1', taskId: 'task_c1' }), 'thread_1');
  assert.equal(worker.sessionKeyFor({}), '');
  // 同一主任务的不同子任务必须使用不同会话，避免上一子任务的对话污染下一子任务。
  assert.notEqual(
    worker.sessionKeyFor({ threadId: 't', taskId: 'c1', parentTaskId: 'p' }),
    worker.sessionKeyFor({ threadId: 't', taskId: 'c2', parentTaskId: 'p' }),
  );
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

test('describeHermesExit：无输出时给出 HERMES_HOME / 沙箱提示', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-hermes-exit-'));
  try {
    assert.equal(worker.hermesHomeProblem(home), '');
    assert.match(worker.describeHermesExit(1, 'boom', home), /boom/);
    const silent = worker.describeHermesExit(1, '', home);
    assert.match(silent, /退出码 1/);
    assert.match(silent, /无输出/);
    assert.match(silent, /HERMES_HOME/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('buildHermesArgs：会话续聊参数', () => {
  const args = worker.buildHermesArgs({ instruction: '继续', sessionId: 'local-abc123' });
  assert.ok(args.includes('--resume'));
  assert.equal(args[args.indexOf('--resume') + 1], 'local-abc123');
});

test('parseCliArgs：解析任务线程 ID', () => {
  const args = worker.parseCliArgs(['--instruction', '继续', '--thread-id', 'thread_abc']);
  assert.equal(args.threadId, 'thread_abc');
});

test('buildHermesStreamArgs：用 chat 子命令 + stream-json 实时事件流', () => {
  const args = worker.buildHermesStreamArgs({
    instruction: '调研竞品',
    model: 'deepseek-chat',
    provider: 'deepseek',
    skills: 'autonomous-agents',
    sessionId: 'local-abc123',
    workdir: 'C:\\work',
  });
  assert.deepEqual(args, [
    'chat', '-q', '调研竞品',
    '--format', 'stream-json',
    '--source', 'cli',
    '--yolo',
    '-m', 'deepseek-chat',
    '--provider', 'deepseek',
    '--skills', 'autonomous-agents',
    '--resume', 'local-abc123',
    '--in', 'C:\\work',
  ]);
  const minimal = worker.buildHermesStreamArgs({ instruction: 'hi' });
  assert.deepEqual(minimal, ['chat', '-q', 'hi', '--format', 'stream-json', '--source', 'cli', '--yolo']);
  const custom = worker.buildHermesStreamArgs({ instruction: 'hi', source: 'tool' });
  assert.equal(custom[custom.indexOf('--source') + 1], 'tool');
});

test('parseCliArgs：解析项目归属参数', () => {
  const args = worker.parseCliArgs([
    '--instruction', '跑一下', '--project', 'ComfyUI 工作机', '--project-folder', 'C:\\work',
  ]);
  assert.equal(args.project, 'ComfyUI 工作机');
  assert.equal(args.projectFolder, 'C:\\work');
  const none = worker.parseCliArgs(['--instruction', 'hi']);
  assert.equal(none.project, '');
  assert.equal(none.projectFolder, '');
});

test('parseCliArgs：stream-progress 默认开启，可用 --no-stream-progress 关闭', () => {
  const defaults = worker.parseCliArgs(['--instruction', 'hi']);
  assert.equal(defaults.streamProgress, true);
  const off = worker.parseCliArgs(['--instruction', 'hi', '--no-stream-progress']);
  assert.equal(off.streamProgress, false);
  const on = worker.parseCliArgs(['--instruction', 'hi', '--stream-progress']);
  assert.equal(on.streamProgress, true);
});

test('createJsonlSplitter：分片、CRLF 与空行容错', () => {
  const lines = [];
  const splitter = worker.createJsonlSplitter((line) => lines.push(line));
  splitter.push('{"type":"sys');
  splitter.push('tem"}\n{"type":"text",');
  splitter.push('"text":"hi"}\r\n\n');
  splitter.push('{"type":"result"}');
  splitter.end();
  assert.deepEqual(lines, ['{"type":"system"}', '{"type":"text","text":"hi"}', '{"type":"result"}']);
});

test('describeHermesTool：识别子任务、执行计划与普通工具', () => {
  assert.equal(
    worker.describeHermesTool('delegate_task', { tasks: [{ goal: '调研竞品' }, { goal: '整理报告' }] }),
    '子任务：调研竞品（共 2 个）',
  );
  assert.equal(
    worker.describeHermesTool('todo_list', { todos: [{ content: '收集资料', status: 'in_progress' }] }),
    '执行步骤：收集资料',
  );
  assert.equal(
    worker.describeHermesTool('todo_list', { todos: [{ status: 'completed' }, { status: 'completed' }, { status: 'pending' }] }),
    '更新执行计划：2/3 步完成',
  );
  assert.equal(
    worker.describeHermesTool('terminal', { command: 'npm test -- --watch=false' }),
    '正在执行：terminal · npm test -- --watch=false',
  );
  assert.equal(worker.describeHermesTool('read_file', {}), '正在执行：read_file');
});

test('planPercentForTodos：按完成比例推进且不超过工具上限', () => {
  const half = worker.planPercentForTodos([{ status: 'completed' }, { status: 'pending' }]);
  assert.ok(half > 8 && worker.planPercentForTodos([{ status: 'completed' }]) >= half);
  assert.equal(
    worker.planPercentForTodos(Array.from({ length: 100 }, () => ({ status: 'completed' }))),
    82,
  );
  assert.equal(worker.planPercentForTodos([]), null);
});

test('createHermesStreamParser：事件流转成单调进度并保留最终结果', () => {
  const sessionId = `local-${'a'.repeat(32)}`;
  const events = [
    { type: 'system', subtype: 'init', model: 'deepseek-chat', session_id: sessionId },
    { type: 'text', text: '我先看看' },
    { type: 'tool_use', name: 'terminal', input: { command: 'ls' } },
    { type: 'tool_result', name: 'terminal', output: 'ok', is_error: false },
    { type: 'tool_use', name: 'delegate_task', input: { tasks: [{ goal: '调研竞品' }] } },
    { type: 'tool_result', name: 'delegate_task', output: 'timeout', is_error: true },
    { type: 'text', text: '完成' },
    { type: 'result', session_id: sessionId, exit_code: 0, text: '最终答案', tokens: { total: 42 } },
  ];
  const payloads = [];
  const parser = worker.createHermesStreamParser({ onProgress: (payload) => payloads.push(payload) });
  events.forEach((event) => parser.push(`${JSON.stringify(event)}\n`));
  parser.end();
  const result = parser.result();
  assert.equal(result.text, '最终答案');
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.sawResult, true);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.result.tokens, { total: 42 });
  assert.deepEqual(
    payloads.map((payload) => payload.message),
    ['正在执行：terminal · ls', '子任务：调研竞品', '工具失败：delegate_task：timeout'],
  );
  const percents = payloads.map((payload) => payload.percent);
  assert.deepEqual(percents, [...percents].sort((a, b) => a - b));
  assert.ok(percents.every((percent) => percent >= 8 && percent <= 85));
});

test('createHermesStreamParser：分片输入与损坏行不影响解析', () => {
  const sessionId = `local-${'b'.repeat(32)}`;
  const raw = [
    'not json',
    JSON.stringify({ type: 'system', session_id: sessionId }),
    JSON.stringify({ type: 'tool_use', name: 'todo_list', input: { todos: [{ content: '写代码', status: 'in_progress' }] } }),
    JSON.stringify({ type: 'result', session_id: sessionId, exit_code: 0, text: 'done' }),
    '',
  ].join('\n');
  const payloads = [];
  const parser = worker.createHermesStreamParser({ onProgress: (payload) => payloads.push(payload) });
  for (let i = 0; i < raw.length; i += 7) parser.push(raw.slice(i, i + 7));
  parser.end();
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].message, '执行步骤：写代码');
  assert.equal(parser.result().text, 'done');
  assert.equal(parser.result().sessionId, sessionId);
});

test('normalizeProgressPayload：消息截断、百分比钳制且不回退', () => {
  const state = { lastPercent: 8 };
  assert.deepEqual(
    worker.normalizeProgressPayload({ message: 'x'.repeat(300), percent: 40 }, state),
    { message: `${'x'.repeat(199)}…`, percent: 40 },
  );
  assert.equal(worker.normalizeProgressPayload({ message: 'retry', percent: 12 }, state).percent, 40);
  assert.equal(worker.normalizeProgressPayload({ message: 'high', percent: 500 }, state).percent, 99);
  assert.equal(worker.normalizeProgressPayload({ message: '' }, state), null);
});

test('createProgressEmitter：silent 心跳标记写入进度行，供 executors 区分真实进度', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-emitter-'));
  const file = path.join(dir, 'progress.log');
  try {
    const emit = worker.createProgressEmitter(file);
    emit({ message: 'OpenCode 执行中（已 15s）…', percent: 20, silent: true });
    emit({ message: 'OpenCode：工具 bash（completed）', percent: 30 });
    emit({ message: '' });
    const lines = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line.slice(worker.PROGRESS_PREFIX.length)));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].silent, true);
    assert.equal(lines[0].message, 'OpenCode 执行中（已 15s）…');
    assert.equal(lines[1].silent, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('withRuntimeGuard：追加「不要起常驻服务」约束，且不重复追加', () => {
  const guarded = worker.withRuntimeGuard('## 任务：做个原型页面');
  assert.match(guarded, /^## 任务：做个原型页面/);
  assert.match(guarded, /【运行约束】/);
  assert.match(guarded, /常驻服务/);
  assert.equal(worker.withRuntimeGuard(guarded), guarded, '已有约束时不重复追加');
  assert.equal(worker.withRuntimeGuard(''), '');
});
