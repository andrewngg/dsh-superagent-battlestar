#!/usr/bin/env node
'use strict';

/**
 * Test double for the Mika CLI. Implements just enough of:
 *   task run --goal-file <file> --json
 *   task wait <id> --timeout <s> --json
 *   task status <id> --json
 *   task cancel <id> --json
 *
 * Env:
 *   MOCK_MIKA_COUNTER  file used to count waits
 *   MOCK_MIKA_MODE     ok | question | fail
 */

const fs = require('node:fs');

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const taskIndex = args.indexOf('task');
const action = taskIndex >= 0 ? args[taskIndex + 1] : '';
const taskId = valueOf('--request-id') || 'mk_task_1';
const mode = process.env.MOCK_MIKA_MODE || 'ok';
const counterFile = process.env.MOCK_MIKA_COUNTER || '';

function emit(payload, code = 0) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(code);
}

if (action === 'run') {
  emit({ task_id: taskId, status: 'running', progress: [{ message: '已打开应用' }] });
} else if (action === 'wait' || action === 'status') {
  if (mode === 'question') {
    emit({ task_id: taskId, status: 'waiting_for_answer', question: '要发送给谁？', options: ['张三', '李四'] });
  }
  if (mode === 'fail') {
    emit({ task_id: taskId, status: 'failed', answer: '无法打开目标应用' }, 1);
  }
  let waits = 0;
  try {
    waits = Number(fs.readFileSync(counterFile, 'utf8')) || 0;
  } catch {
    waits = 0;
  }
  waits += 1;
  if (counterFile) fs.writeFileSync(counterFile, String(waits));
  if (waits >= 2) {
    emit({ task_id: taskId, status: 'done', answer: '已在手机上发送消息给张三', verified: true });
  }
  emit({ task_id: taskId, status: 'running', progress: [{ message: '正在打开微信' }] });
} else if (action === 'cancel') {
  emit({ task_id: taskId, accepted: true });
} else {
  emit({ error: { code: 'arguments', message: `mock-mika: unsupported action ${action}` } }, 2);
}
