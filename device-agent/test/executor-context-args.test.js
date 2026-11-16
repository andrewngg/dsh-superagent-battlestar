'use strict';

/**
 * cli 执行器：把任务 id / 主任务 id 透传给 worker，
 * 让 worker 能为每个计划子任务使用独立 Hermes 会话并把主任务背景写进 prompt。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createCliExecutor } = require('../lib/executors');

test('cli 执行器：透传 --task-id 与 --parent-task-id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-cli-taskid-'));
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
  const executor = createCliExecutor({
    executorCfg: { worker: workerFile, mode: 'auto', workdir: dir, timeoutMs: 8000 },
    cwd: dir,
    stateDir: dir,
  });
  try {
    await executor.run({
      task: {
        id: 'task_c1',
        parentTaskId: 'task_p',
        threadId: 'thread_x',
        instruction: '分析代码',
      },
    });
    let args = readArgs();
    assert.equal(args[args.indexOf('--task-id') + 1], 'task_c1');
    assert.equal(args[args.indexOf('--parent-task-id') + 1], 'task_p');
    assert.equal(args[args.indexOf('--thread-id') + 1], 'thread_x');

    await executor.run({ task: { id: 'task_plain', instruction: '普通任务' } });
    args = readArgs();
    assert.equal(args[args.indexOf('--task-id') + 1], 'task_plain');
    assert.ok(!args.includes('--parent-task-id'), '普通任务不应带 --parent-task-id');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
