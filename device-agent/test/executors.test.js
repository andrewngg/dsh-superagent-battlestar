'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  createExecutor,
  createCliExecutor,
  createProgressFileTailer,
  makeProgressThrottle,
  parseWorkerProgressLine,
  assertEndpointAllowed,
  ExecutorTimeoutError,
} = require('../lib/executors');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEST_DEVICE = {
  id: 'dev_test01',
  name: '测试设备',
  platform: 'windows',
  capabilities: {
    models: [{ id: 'qwen2.5', provider: 'ollama', available: true, strengths: ['chat'] }],
    skills: [{ id: 'office-docx' }],
    profiles: [],
    gateways: [],
    resources: {},
    limits: { maxConcurrentTasks: 2 },
  },
};

function makeTask(overrides = {}) {
  return {
    id: 'task_test01',
    instruction: '把本周家庭开销整理成 Word 报告',
    requirements: {},
    priority: 5,
    timeoutSec: 30,
    context: {},
    ...overrides,
  };
}

function createProgressCollector() {
  const events = [];
  return {
    events,
    progress: async (message, percent) => {
      events.push({ message, percent, at: Date.now() });
    },
  };
}

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        let body = null;
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch {
          body = null;
        }
        const result = handler({ method: req.method, url: req.url || '/', headers: req.headers, body });
        res.writeHead(result.status || 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result.body === undefined ? {} : result.body));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// simulate
// ---------------------------------------------------------------------------

test('simulate：3-6 条中文进度 + 结构化结果 + 默认 2-6s 可配置缩短', async () => {
  const executor = createExecutor({
    config: {
      executor: {
        type: 'simulate',
        simulate: { minDurationMs: 120, maxDurationMs: 240, minSteps: 3, maxSteps: 4 },
      },
    },
  });
  assert.equal(executor.type, 'simulate');

  const collector = createProgressCollector();
  const startedAt = Date.now();
  const outcome = await executor.run({
    task: makeTask(),
    device: TEST_DEVICE,
    progress: collector.progress,
  });
  const elapsed = Date.now() - startedAt;

  assert.ok(outcome.output);
  assert.match(outcome.output.text, /任务已完成/);
  assert.match(outcome.output.text, /模拟执行/);
  assert.match(outcome.output.markdown, /### 执行步骤/);
  assert.ok(outcome.output.markdown.includes('office') || outcome.output.markdown.includes('办公'));
  assert.ok(outcome.output.data.simulated);
  assert.equal(outcome.output.data.flavor, 'office');
  assert.ok(Array.isArray(outcome.output.data.steps));
  assert.ok(outcome.output.data.steps.length >= 3 && outcome.output.data.steps.length <= 4);
  assert.ok(outcome.output.artifacts.length >= 1);
  assert.match(outcome.output.artifacts[0].name, /\.(docx|xlsx|pptx|md|json)$/);
  assert.ok(elapsed >= 120);

  // 默认 800ms 节流下，120-240ms 内最多上报 1 条进度（不刷屏），且至少 1 条
  assert.ok(collector.events.length >= 1);
  assert.ok(collector.events.length <= 4);
  for (const event of collector.events) {
    assert.equal(typeof event.message, 'string');
    assert.ok(event.message.length > 0);
    if (event.percent !== undefined) assert.ok(event.percent >= 0 && event.percent <= 100);
  }
});

test('simulate：不同指令生成不同类别结果（家居/调研）', async () => {
  const executor = createExecutor({
    config: { executor: { simulate: { minDurationMs: 60, maxDurationMs: 90, minSteps: 3, maxSteps: 3 } } },
  });

  const home = await executor.run({
    task: makeTask({ instruction: '把客厅空调调到 24 度，并关闭窗帘' }),
    device: TEST_DEVICE,
  });
  assert.equal(home.output.data.flavor, 'home');
  assert.match(home.output.artifacts[0].name, /家居|json/);

  const research = await executor.run({
    task: makeTask({ instruction: '调研一下最近的家庭机器人都有什么新品' }),
    device: TEST_DEVICE,
  });
  assert.equal(research.output.data.flavor, 'research');
});

test('simulate：AbortSignal 可中止执行', async () => {
  const executor = createExecutor({
    config: { executor: { simulate: { minDurationMs: 2000, maxDurationMs: 2400 } } },
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('cancelled'), 40);
  try {
    await assert.rejects(
      () =>
        executor.run({
          task: makeTask(),
          device: TEST_DEVICE,
          signal: controller.signal,
        }),
      (err) => {
        assert.equal(err.name, 'AbortError');
        return true;
      },
    );
  } finally {
    clearTimeout(timer);
  }
});

test('makeProgressThrottle：800ms 内只放行一次', async () => {
  const sent = [];
  const report = makeProgressThrottle(async (message, percent) => {
    sent.push(`${message}:${percent}`);
  });
  await report('第一步', 10);
  await report('第二步', 20);
  await report('第三步', 30);
  assert.deepEqual(sent, ['第一步:10']);
});

test('makeProgressThrottle：force 上报不被节流窗口吞掉', async () => {
  const sent = [];
  const report = makeProgressThrottle(async (message, percent) => {
    sent.push(`${message}:${percent}`);
  });
  await report('已接收任务', 2);
  await report('正在执行本机 CLI（auto）…', 10, { force: true });
  assert.deepEqual(sent, ['已接收任务:2', '正在执行本机 CLI（auto）…:10']);
});

// ---------------------------------------------------------------------------
// dsh-cli / shell（命令模板 + 文件重定向 + 超时 + 截断）
// ---------------------------------------------------------------------------

test('shell 执行器：模板替换 + 文件重定向捕获输出', async () => {
  const executor = createExecutor({
    type: 'shell',
    config: {
      executor: {
        shell: { command: 'node -e "process.stdout.write(process.argv[1])" {instruction}' },
      },
    },
  });
  const outcome = await executor.run({
    task: makeTask({ instruction: 'hello-butler' }),
    device: TEST_DEVICE,
  });
  assert.equal(outcome.error, undefined);
  assert.match(outcome.output.text, /hello-butler/);
  assert.equal(outcome.output.data.exitCode, 0);
});

test('dsh-cli 执行器：命令模板可配置（这里用 node 模拟 dsh）', async () => {
  const executor = createExecutor({
    type: 'dsh-cli',
    config: {
      executor: {
        'dsh-cli': { command: 'node -e "console.log(\'dsh-cli-ok\')"' },
      },
    },
  });
  const outcome = await executor.run({ task: makeTask(), device: TEST_DEVICE });
  assert.match(outcome.output.text, /dsh-cli-ok/);
});

test('命令执行器：输出超长时截断', async () => {
  const executor = createExecutor({
    type: 'shell',
    config: {
      executor: {
        shell: {
          command: 'node -e "process.stdout.write(\'A\'.repeat(5000))"',
          maxOutputChars: 100,
        },
      },
    },
  });
  const outcome = await executor.run({ task: makeTask(), device: TEST_DEVICE });
  assert.ok(outcome.output.text.length < 400);
  assert.match(outcome.output.text, /输出已截断/);
});

test('命令执行器：超时 kill 子进程并抛 ExecutorTimeoutError', async () => {
  const executor = createExecutor({
    type: 'shell',
    config: {
      executor: {
        shell: { command: 'node -e "setTimeout(()=>{}, 5000)"', timeoutMs: 400 },
      },
    },
  });
  const startedAt = Date.now();
  await assert.rejects(
    () => executor.run({ task: makeTask(), device: TEST_DEVICE }),
    (err) => {
      assert.equal(err.name, 'ExecutorTimeoutError');
      assert.equal(err.code, 'timeout');
      return true;
    },
  );
  assert.ok(Date.now() - startedAt < 8000, '超时应在数秒内生效');
});

test('命令执行器：非零退出码返回 error 而非抛出', async () => {
  const executor = createExecutor({
    type: 'shell',
    config: { executor: { shell: { command: 'node -e "process.exit(3)"' } } },
  });
  const outcome = await executor.run({ task: makeTask(), device: TEST_DEVICE });
  assert.ok(outcome.error);
  assert.match(outcome.error, /退出码 3/);
});

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------

test('http 执行器：POST 到本地 endpoint 并解析结构化输出', async () => {
  const server = await startMockServer(({ url, body }) => {
    if (url === '/execute') {
      return { status: 200, body: { ok: true, output: { text: `远端执行完成：${body.instruction}` } } };
    }
    return { status: 404, body: { error: { code: 'not_found', message: 'mock 未实现' } } };
  });
  try {
    const executor = createExecutor({
      type: 'http',
      hubUrl: 'http://127.0.0.1:7317',
      config: { executor: { http: { url: `${server.url}/execute`, timeoutMs: 3000 } } },
    });
    const outcome = await executor.run({ task: makeTask(), device: TEST_DEVICE });
    assert.match(outcome.output.text, /远端执行完成/);
    assert.match(outcome.output.text, /把本周家庭开销/);
  } finally {
    await server.close();
  }
});

test('http 执行器：拒绝指向 Hub 自身', async () => {
  const server = await startMockServer(() => ({ status: 200, body: {} }));
  try {
    const executor = createExecutor({
      type: 'http',
      hubUrl: server.url,
      config: { executor: { http: { url: `${server.url}/execute` } } },
    });
    await assert.rejects(() => executor.run({ task: makeTask(), device: TEST_DEVICE }), /Hub 自身/);
    assert.throws(() => assertEndpointAllowed('http://example.com/execute', []), /本机或内网/);
    assert.doesNotThrow(() => assertEndpointAllowed('http://192.168.1.20:7788/execute', []));
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// ollama
// ---------------------------------------------------------------------------

test('ollama 执行器：调用 /api/generate 并返回模型输出', async () => {
  const requests = [];
  const server = await startMockServer(({ url, body }) => {
    requests.push({ url, body });
    if (url === '/api/generate') {
      return { status: 200, body: { response: '你好，本周开销已整理完成。', eval_count: 42, total_duration: 1200000000 } };
    }
    return { status: 404, body: {} };
  });
  try {
    const executor = createExecutor({
      type: 'ollama',
      config: { executor: { ollama: { baseUrl: server.url, timeoutMs: 3000 } } },
    });
    const outcome = await executor.run({ task: makeTask(), device: TEST_DEVICE });
    assert.match(outcome.output.text, /你好/);
    assert.equal(outcome.output.data.model, 'qwen2.5');
    assert.equal(outcome.output.data.evalCount, 42);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/api/generate');
    assert.equal(requests[0].body.model, 'qwen2.5');
    assert.match(requests[0].body.prompt, /把本周家庭开销/);
  } finally {
    await server.close();
  }
});

test('未知执行器类型给出明确错误', () => {
  assert.throws(() => createExecutor({ type: 'no-such-executor', config: {} }), /未知执行器类型/);
});

// ---------------------------------------------------------------------------
// cli 执行器：实时执行步骤（进度文件轮询）
// ---------------------------------------------------------------------------

test('parseWorkerProgressLine：只认魔法前缀，钳制百分比', () => {
  assert.deepEqual(
    parseWorkerProgressLine('@@BUTLER_PROGRESS@@ {"message":"子任务：调研竞品","percent":20}'),
    { message: '子任务：调研竞品', percent: 20 },
  );
  assert.equal(
    parseWorkerProgressLine('@@BUTLER_PROGRESS@@ {"message":"执行步骤","percent":120}').percent,
    100,
  );
  assert.equal(parseWorkerProgressLine('@@BUTLER_PROGRESS@@ {"message":""}'), null);
  assert.equal(parseWorkerProgressLine('@@BUTLER_PROGRESS@@ not-json'), null);
  assert.equal(parseWorkerProgressLine('普通日志'), null);
});

test('createProgressFileTailer：追加行实时回调，stop 时补最后一行', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-progress-'));
  const file = path.join(dir, 'progress.log');
  const seen = [];
  const tailer = createProgressFileTailer(file, (message, percent) => seen.push([message, percent]), 20);
  try {
    fs.appendFileSync(file, '@@BUTLER_PROGRESS@@ {"message":"开始","percent":10}\n@@BUTLER_PROGRESS@@ {"message":"进行中","percent":30}\n');
    tailer.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    // 最后一行没有换行：stop 时也要处理
    fs.appendFileSync(file, '@@BUTLER_PROGRESS@@ {"message":"收尾","percent":50}');
    await tailer.stop();
    assert.deepEqual(seen, [['开始', 10], ['进行中', 30], ['收尾', 50]]);
  } finally {
    await tailer.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cli 执行器：worker 的实时步骤转成 Hub 进度', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-cli-stream-'));
  const workerFile = path.join(dir, 'fake-worker.js');
  fs.writeFileSync(
    workerFile,
    [
      "'use strict';",
      "const fs = require('node:fs');",
      "const prefix = '@@BUTLER_PROGRESS@@ ';",
      "const file = process.argv[process.argv.indexOf('--progress-file') + 1];",
      "fs.appendFileSync(file, `${prefix}${JSON.stringify({ message: '子任务：调研竞品', percent: 20 })}\\n`);",
      "fs.appendFileSync(file, `${prefix}${JSON.stringify({ message: '执行步骤：整理报告', percent: 45 })}\\n`);",
      "setTimeout(() => {",
      "  process.stdout.write(`${JSON.stringify({ ok: true, backend: 'hermes', model: 'fake', profile: '', text: '已完成', exitCode: 0, durationMs: 10, commandPreview: 'fake', fallbackFrom: null, fallbackReason: null, at: new Date().toISOString() })}\\n`);",
      "}, 50);",
    ].join('\n'),
  );
  const calls = [];
  const executor = createCliExecutor({
    executorCfg: { worker: workerFile, mode: 'auto', workdir: dir, timeoutMs: 8000 },
    cwd: dir,
    stateDir: dir,
  });
  try {
    const outcome = await executor.run({
      task: { id: 'task_x', instruction: '整理本周开销' },
      progress: async (message, percent) => calls.push([message, percent]),
    });
    assert.equal(outcome.output.text, '已完成');
    assert.ok(calls.some(([message]) => message.includes('子任务：调研竞品')));
    assert.ok(calls.some(([message]) => message.includes('执行步骤：整理报告')));
    assert.ok(calls.some(([message, percent]) => message.includes('执行完成') && percent === 92));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cli 执行器：任务级项目传给 worker，设备默认项目使用工作目录', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-cli-project-'));
  const workerFile = path.join(dir, 'fake-worker.js');
  fs.writeFileSync(
    workerFile,
    [
      "'use strict';",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "fs.writeFileSync(path.join(__dirname, 'args.json'), JSON.stringify(process.argv.slice(2)));",
      "process.stdout.write(`${JSON.stringify({ ok: true, backend: 'hermes', model: 'fake', profile: '', text: 'done', exitCode: 0, durationMs: 1, commandPreview: 'fake', fallbackFrom: null, fallbackReason: null, at: new Date().toISOString() })}\\n`);",
    ].join('\n'),
  );
  const readArgs = () => JSON.parse(fs.readFileSync(path.join(dir, 'args.json'), 'utf8'));
  const cfg = { worker: workerFile, mode: 'auto', workdir: dir, timeoutMs: 8000 };
  try {
    const taskLevel = createCliExecutor({ executorCfg: cfg, cwd: dir, stateDir: dir, deviceName: '主工作机' });
    await taskLevel.run({ task: { id: 't1', instruction: 'x', requirements: { project: 'ComfyUI 工作机' } } });
    let args = readArgs();
    assert.equal(args[args.indexOf('--project') + 1], 'ComfyUI 工作机');
    assert.ok(!args.includes('--project-folder'), '任务级项目不应覆盖项目文件夹');

    const deviceLevel = createCliExecutor({ executorCfg: cfg, cwd: dir, stateDir: dir, deviceName: '主工作机' });
    await deviceLevel.run({ task: { id: 't2', instruction: 'y' } });
    args = readArgs();
    assert.equal(args[args.indexOf('--project') + 1], '主工作机');
    assert.equal(args[args.indexOf('--project-folder') + 1], dir);

    const configured = createCliExecutor({
      executorCfg: { ...cfg, project: '图像处理主机' },
      cwd: dir,
      stateDir: dir,
      deviceName: '主工作机',
    });
    await configured.run({ task: { id: 't3', instruction: 'z' } });
    args = readArgs();
    assert.equal(args[args.indexOf('--project') + 1], '图像处理主机', '设备配置项目优先于设备名');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// A+B 卡死治理：无进度 watchdog 与任务预算
// ---------------------------------------------------------------------------

test('cli 执行器：无进度 watchdog 会终止卡住的 worker 并返回 stalled', { timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-cli-stall-'));
  const workerFile = path.join(dir, 'hang-worker.js');
  fs.writeFileSync(workerFile, ["'use strict';", 'setTimeout(() => {}, 60000);'].join('\n'));
  const calls = [];
  const executor = createCliExecutor({
    executorCfg: {
      worker: workerFile,
      mode: 'auto',
      workdir: dir,
      timeoutMs: 8000,
      stallTimeoutMs: 1200,
      heartbeatMs: 5000,
    },
    cwd: dir,
    stateDir: dir,
  });
  try {
    const outcome = await executor.run({
      task: { id: 'task_stall', instruction: '跑一个会卡住的命令', timeoutSec: 600 },
      progress: async (message, percent) => calls.push([message, percent]),
    });
    assert.ok(outcome.error, '卡死应返回错误');
    assert.match(outcome.error, /stalled|无进度/);
    assert.equal(outcome.output.data.stalled, true);
    assert.ok(calls.some(([message]) => message.includes('正在执行本机 CLI')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cli 执行器：worker 超时预算取 max(cli.timeoutMs, task.timeoutSec)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-cli-budget-'));
  const workerFile = path.join(dir, 'budget-worker.js');
  fs.writeFileSync(
    workerFile,
    [
      "'use strict';",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "fs.writeFileSync(path.join(__dirname, 'budget.json'), JSON.stringify({ args: process.argv.slice(2), env: process.env.BUTLER_CLI_TIMEOUT_MS || '' }));",
      "process.stdout.write(`${JSON.stringify({ ok: true, backend: 'hermes', model: 'fake', profile: '', text: 'done', exitCode: 0, durationMs: 1, commandPreview: 'fake', fallbackFrom: null, fallbackReason: null, at: new Date().toISOString() })}\\n`);",
    ].join('\n'),
  );
  const executor = createCliExecutor({
    executorCfg: { worker: workerFile, mode: 'auto', workdir: dir, timeoutMs: 8000 },
    cwd: dir,
    stateDir: dir,
  });
  try {
    await executor.run({ task: { id: 'task_budget', instruction: '长任务', timeoutSec: 1800 } });
    const recorded = JSON.parse(fs.readFileSync(path.join(dir, 'budget.json'), 'utf8'));
    assert.equal(recorded.args[recorded.args.indexOf('--timeout-ms') + 1], '1800000');
    assert.equal(recorded.env, '1800000');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
