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
 *   MOCK_MIKA_PHONE_FAIL_ONCE  file flag：存在时第一次 task run 返回 phone_unavailable 并删除该文件
 *   MOCK_MIKA_CONNECTION_FAIL_ONCE  file flag：存在时第一次 task run 返回 connection 错误并删除该文件
 *   MOCK_MIKA_CONNECT_FAIL_ONCE  file flag：存在时第一次 connect 返回 bootstrap 未完成错误并删除该文件
 *   MOCK_MIKA_CONNECT_FAIL_ALWAYS  file flag：存在时每次 connect 都返回 bootstrap 未完成错误（不删除）
 *   MOCK_MIKA_GOAL_CAPTURE  file：把 task run 收到的 --goal-file 内容复制到这里（供测试断言）
 */

const fs = require('node:fs');

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const taskIndex = args.indexOf('task');
const action = taskIndex >= 0 ? args[taskIndex + 1] : '';
const taskId = 'mk_task_1';
const mode = process.env.MOCK_MIKA_MODE || 'ok';
const counterFile = process.env.MOCK_MIKA_COUNTER || '';
const phoneFailFlag = process.env.MOCK_MIKA_PHONE_FAIL_ONCE || '';
const connectionFailFlag = process.env.MOCK_MIKA_CONNECTION_FAIL_ONCE || '';
const connectFailFlag = process.env.MOCK_MIKA_CONNECT_FAIL_ONCE || '';
const connectFailAlways = process.env.MOCK_MIKA_CONNECT_FAIL_ALWAYS || '';
const goalCapture = process.env.MOCK_MIKA_GOAL_CAPTURE || '';
const goalFile = valueOf('--goal-file') || '';

function emit(payload, code = 0) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(code);
}

if (action === '' && args.includes('connect')) {
  if (connectFailAlways || (connectFailFlag && fs.existsSync(connectFailFlag))) {
    if (connectFailFlag && !connectFailAlways) {
      try {
        fs.unlinkSync(connectFailFlag);
      } catch {
        /* ignore */
      }
    }
    emit(
      {
        error: {
          code: 'adb',
          message: "Mika's phone bootstrap did not complete. Unlock the phone, open Mika once, then retry connect.",
        },
      },
      1,
    );
  }
  emit({ connection: 'ok', transport: 'adb', device: 'mock-phone', api_version: 1 });
} else if (action === 'run') {
  if (goalCapture && goalFile) {
    try {
      fs.writeFileSync(goalCapture, fs.readFileSync(goalFile, 'utf8'));
    } catch {
      /* ignore */
    }
  }
  if (connectionFailFlag && fs.existsSync(connectionFailFlag)) {
    try {
      fs.unlinkSync(connectionFailFlag);
    } catch {
      /* ignore */
    }
    emit(
      {
        error: {
          code: 'connection',
          message: 'Could not read a valid response from Mika; check the connection and run mika connect.',
        },
      },
      1,
    );
  }
  if (phoneFailFlag && fs.existsSync(phoneFailFlag)) {
    try {
      fs.unlinkSync(phoneFailFlag);
    } catch {
      /* ignore */
    }
    emit({ error: { code: 'phone_unavailable', message: 'NO_PHONE_HELPER: 手机助手已停止' } }, 1);
  }
  emit({ task_id: taskId, status: 'running', progress: [{ message: '已打开应用' }] });
} else if (action === 'wait' || action === 'status') {
  // request_id 反查（task status <requestId>）不应该凭空造出一个任务：
  // 只有已知 task_id 才返回快照，其余按「查不到」处理，让执行器保留原始错误。
  const idArg = args[taskIndex + 2];
  if (action === 'status' && idArg && idArg !== taskId) {
    emit({ error: { code: 'not_found', message: `mock-mika: unknown task ${idArg}` } }, 1);
  }
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
