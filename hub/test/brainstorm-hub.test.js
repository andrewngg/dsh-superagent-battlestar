'use strict';

/**
 * 头脑风暴（brainstorm）Hub 集成 + HTTP 测试：会话自动创建、多轮历史、
 * 模型失败降级、转任务（含目标关联）、删除、持久化、SSE 不写常规 events、
 * GET/POST/DELETE/to-task 接口与参数校验。契约见 docs/GOAL-BRAIN-DESIGN.md §7。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createHub } = require('../lib/hub.js');
const { restoreBrainstorm } = require('../lib/brainstorm.js');
const { startTestHub, request, adminHeaders, makeManifest } = require('./_helpers.js');

const MODEL_ENV_KEYS = [
  'BRAIN_API_KEY',
  'AGNES_API_KEY',
  'BUTLER_AGNES_API_KEY',
  'BRAIN_BASE_URL',
  'AGNES_BASE_URL',
  'BRAIN_MODEL',
  'AGNES_MODEL',
  'BRAIN_TIMEOUT_MS',
  'DEEPSEEK_API_KEY',
  'BRAINSTORM_API_KEY',
  'BRAINSTORM_BASE_URL',
  'BRAINSTORM_MODEL',
  'BRAINSTORM_FILE_API_KEY',
  'BRAINSTORM_FILE_BASE_URL',
  'BRAINSTORM_FILE_MODEL',
];

/** 临时清空模型相关环境变量，结束后恢复（宿主机可能配置了真实密钥）。 */
async function withModelEnv(values, fn) {
  const saved = new Map();
  for (const key of MODEL_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const key of MODEL_ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** 独立临时 dataDir 的 Hub（不走 HTTP），t.after 负责关闭与清理。 */
async function newHub(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-brainstorm-hub-'));
  const hub = await createHub({
    dataDir,
    silent: true,
    persistDebounceMs: 5,
    nightlyReview: false,
    brainTickMs: 3600000,
    goalTickMs: 3600000,
    ...overrides,
  });
  t.after(async () => {
    await hub.close().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { hub, dataDir };
}

/** 可切换行为的 brainstormThink 桩，记录提示词。 */
function makeThinker(reply = '## 结论\n先定方向，再拆行动。') {
  const captured = [];
  const state = { fail: false, reply, captured };
  state.think = async ({ system, user }) => {
    captured.push({ system, user });
    if (state.fail) throw new Error('模型超时');
    return typeof state.reply === 'function' ? state.reply() : state.reply;
  };
  return state;
}

test('首轮对话自动建会话并落盘 user + assistant 消息，提示词带管家上下文', async (t) => {
  const thinker = makeThinker();
  const { hub } = await newHub(t, { brainstormThink: thinker.think });
  const goal = hub.createGoal({ title: '求职', nickname: '求职' });
  hub.createTask({ instruction: '整理简历', goalId: goal.id });

  const first = await hub.chatBrainstorm({ message: '帮我把求职目标拆成本周行动' });
  assert.equal(first.error, null);
  assert.ok(first.reply.startsWith('## 结论'));
  const sessionId = first.session.id;
  assert.match(sessionId, /^bs_/);
  assert.equal(first.session.messages.length, 2);
  assert.equal(first.session.messages[0].role, 'user');
  assert.equal(first.session.messages[1].role, 'assistant');
  assert.ok(first.session.title.includes('求职'));

  const view = hub.getBrainstorm();
  assert.equal(view.sessions.length, 1);
  assert.equal(view.activeId, sessionId);
  assert.equal(view.session.id, sessionId);
  assert.equal(view.session.messages.length, 2);

  // 提示词：system 含头脑风暴原则，user 含管家上下文（目标/任务）与本轮消息。
  assert.equal(thinker.captured.length, 1);
  assert.ok(thinker.captured[0].system.includes('头脑风暴'));
  assert.ok(thinker.captured[0].system.includes('不要输出 JSON'));
  assert.ok(thinker.captured[0].user.includes('## 管家上下文'));
  assert.ok(thinker.captured[0].user.includes('求职'));
  assert.ok(thinker.captured[0].user.includes('整理简历'));
  assert.ok(thinker.captured[0].user.includes('## 本轮消息\n帮我把求职目标拆成本周行动'));
});

test('多轮对话：历史进入提示词，标题保持首条用户消息', async (t) => {
  const thinker = makeThinker();
  const { hub } = await newHub(t, { brainstormThink: thinker.think });
  const first = await hub.chatBrainstorm({ message: '帮我把求职目标拆成本周行动' });
  const second = await hub.chatBrainstorm({ sessionId: first.session.id, message: '那第一步具体怎么做？' });

  assert.equal(second.error, null);
  assert.equal(second.session.messages.length, 4);
  assert.deepEqual(
    second.session.messages.map((message) => message.role),
    ['user', 'assistant', 'user', 'assistant'],
  );
  assert.equal(second.session.title, first.session.title);

  // 第二轮 prompt 的历史包含第一轮的用户消息与大脑回复。
  assert.equal(thinker.captured.length, 2);
  assert.ok(thinker.captured[1].user.includes('帮我把求职目标拆成本周行动'));
  assert.ok(thinker.captured[1].user.includes('## 最近对话'));
  assert.ok(thinker.captured[1].user.includes('大脑：## 结论'));
  assert.ok(thinker.captured[1].user.includes('那第一步具体怎么做？'));
});

test('模型路由：普通对话用 Agnes，涉及文件时自动切 DeepSeek', async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ choices: [{ message: { content: '## 结论\n已读取文件内容。' } }] });
      },
    };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await withModelEnv(
    { AGNES_API_KEY: 'agnes-key', AGNES_BASE_URL: 'https://agnes.test/v1', DEEPSEEK_API_KEY: 'ds-key' },
    async () => {
      const { hub } = await newHub(t);

      const plain = await hub.chatBrainstorm({ message: '帮我把求职目标拆成本周行动' });
      assert.equal(plain.error, null);
      assert.equal(plain.fileMode, false);
      assert.equal(plain.model, 'agnes-2.5-flash');
      assert.equal(calls[0], 'https://agnes.test/v1/chat/completions');

      const filePath = path.join(os.tmpdir(), 'bs-brainstorm-file-mode.txt');
      fs.writeFileSync(filePath, '服务线 A：Python 自动化。');
      t.after(() => fs.rmSync(filePath, { force: true }));

      const withFile = await hub.chatBrainstorm({ message: `读取 ${filePath} 并总结` });
      assert.equal(withFile.fileMode, true);
      assert.equal(withFile.model, 'deepseek-chat');
      assert.equal(calls[1], 'https://api.deepseek.com/chat/completions');
      assert.equal(withFile.attachments.length, 1);

      const uploaded = await hub.chatBrainstorm({
        message: '再结合这份附件给建议',
        attachments: [{ name: 'notes.txt', text: '附件正文' }],
      });
      assert.equal(uploaded.fileMode, true);
      assert.equal(calls[2], 'https://api.deepseek.com/chat/completions');
    },
  );
});

test('模型失败：不抛错，assistant 消息带 error，之后可继续对话', async (t) => {
  const thinker = makeThinker();
  const { hub } = await newHub(t, { brainstormThink: thinker.think });
  const first = await hub.chatBrainstorm({ message: '先聊聊方向' });
  const sessionId = first.session.id;

  thinker.fail = true;
  const failed = await hub.chatBrainstorm({ sessionId, message: '再想想' });
  assert.ok(failed.error.includes('模型超时'));
  assert.equal(failed.reply, null);
  assert.equal(failed.session.messages.length, 4);
  const failureMessage = failed.session.messages[3];
  assert.equal(failureMessage.role, 'assistant');
  assert.equal(failureMessage.error, '模型超时');
  assert.ok(failureMessage.text.startsWith('（大脑暂时无法回答'));
  // 失败消息同样落盘。
  assert.equal(hub.getBrainstorm({ sessionId }).session.messages[3].error, '模型超时');

  thinker.fail = false;
  const recovered = await hub.chatBrainstorm({ sessionId, message: '继续' });
  assert.equal(recovered.error, null);
  assert.equal(recovered.session.messages.length, 6);
  assert.equal(recovered.session.messages[5].error, undefined);
  // 常规事件不记录 brainstorm.updated（只走 SSE）。
  assert.equal(hub.events.some((event) => event.type === 'brainstorm.updated'), false);
});

test('模型返回空回复：按失败处理并写入 error', async (t) => {
  const thinker = makeThinker('   ');
  const { hub } = await newHub(t, { brainstormThink: thinker.think });
  const result = await hub.chatBrainstorm({ message: '帮我想想' });
  assert.ok(result.error.includes('大脑返回了空回复'));
  assert.equal(result.reply, null);
  assert.equal(result.session.messages.length, 2);
  assert.ok(result.session.messages[1].text.startsWith('（大脑暂时无法回答'));
});

test('未配置模型：对话仍保存并返回错误，不抛给调用方', async (t) => {
  await withModelEnv({}, async () => {
    const { hub } = await newHub(t);
    const result = await hub.chatBrainstorm({ message: '帮我想想求职方向' });
    assert.ok(result.error.includes('未配置自主大脑模型'));
    assert.equal(result.reply, null);
    assert.equal(result.session.messages.length, 2);
    assert.equal(result.session.messages[0].role, 'user');
    assert.equal(result.session.messages[1].error, '未配置自主大脑模型（BRAIN_API_KEY / AGNES_API_KEY / DEEPSEEK_API_KEY）');
    // 会话仍被保存，可继续追问。
    const view = hub.getBrainstorm();
    assert.equal(view.sessions.length, 1);
  });
});

test('to-task：从大脑回复生成任务（priority 6、context.brainstorm、自动关联目标）', async (t) => {
  const thinker = makeThinker('## 结论\n先做 A，再做 B。\n\n### 下一步\n- 今天整理简历');
  const { hub } = await newHub(t, { brainstormThink: thinker.think });
  const goal = hub.createGoal({ title: '求职', nickname: '求职' });
  const first = await hub.chatBrainstorm({ message: '帮我把求职目标拆成本周行动' });
  const assistant = first.session.messages[1];

  const result = hub.brainstormMessageToTask({
    sessionId: first.session.id,
    messageId: assistant.id,
    goalId: goal.id,
  });
  const task = result.task;
  assert.equal(task.priority, 6);
  assert.equal(task.goalId, goal.id);
  assert.equal(task.instruction, assistant.text);
  assert.equal(task.context.brainstorm, true);
  assert.equal(task.context.sessionId, first.session.id);
  assert.equal(task.context.messageId, assistant.id);
  assert.equal(hub.getTask(task.id).id, task.id);

  const linked = hub.getGoal(goal.id);
  assert.ok(linked.taskIds.includes(task.id));
  assert.equal(linked.runningTaskId, task.id);

  // 不带 goalId 时不关联目标。
  const plain = hub.brainstormMessageToTask({ sessionId: first.session.id, messageId: assistant.id });
  assert.equal(plain.task.goalId, null);
  assert.equal(plain.task.priority, 6);
});

test('to-task：主设备兜底路由（避免转出来的任务永远排队）', async (t) => {
  const thinker = makeThinker('## 结论\n先做 A。');
  const { hub } = await newHub(t, { brainstormThink: thinker.think });
  const device = hub.registerDevice(makeManifest({ name: '母机' }));
  hub.updateSettings({ mainDeviceId: device.id });
  const first = await hub.chatBrainstorm({ message: '帮我想想' });
  const assistant = first.session.messages[1];

  const result = hub.brainstormMessageToTask({ sessionId: first.session.id, messageId: assistant.id });
  assert.equal(result.task.requirements.deviceId, device.id);
});

test('to-task：主设备为空时保持原样路由', async (t) => {
  const thinker = makeThinker('## 结论\n先做 A。');
  const { hub } = await newHub(t, { brainstormThink: thinker.think });
  const first = await hub.chatBrainstorm({ message: '帮我想想' });
  const assistant = first.session.messages[1];

  const result = hub.brainstormMessageToTask({ sessionId: first.session.id, messageId: assistant.id });
  assert.ok(!result.task.requirements || !result.task.requirements.deviceId);
});

test('to-task：会话/消息/角色校验', async (t) => {
  const thinker = makeThinker();
  const { hub } = await newHub(t, { brainstormThink: thinker.think });
  const first = await hub.chatBrainstorm({ message: '帮我想想' });
  const sessionId = first.session.id;

  assert.throws(() => hub.brainstormMessageToTask({ sessionId: 'bs_missing', messageId: 'x' }), /对话不存在/);
  assert.throws(() => hub.brainstormMessageToTask({ sessionId }), /消息不存在/);
  assert.throws(() => hub.brainstormMessageToTask({ sessionId, messageId: 'bm_missing' }), /消息不存在/);
  assert.throws(
    () => hub.brainstormMessageToTask({ sessionId, messageId: first.session.messages[0].id }),
    /只能把大脑的回复转成任务/,
  );
});

test('授权后：回复里的 actions 块真正建任务（主设备路由、剥离 JSON、消息记录 taskId）', async (t) => {
  const reply = [
    '## 结论',
    '先把反腐只读看板做出来。',
    '',
    '```actions',
    JSON.stringify([
      {
        action: 'create_task',
        instruction: '在反腐项目目录新增只读看板页面，跑通后截图验收',
        reason: '下一步',
      },
    ]),
    '```',
  ].join('\n');
  const thinker = makeThinker(reply);
  const { hub } = await newHub(t, { brainstormThink: thinker.think });
  const device = hub.registerDevice(makeManifest({ name: '母机' }));
  hub.updateSettings({ mainDeviceId: device.id });

  const first = await hub.chatBrainstorm({
    message: '你来创建任务，不用我过手：把反腐看板拆成可执行任务',
  });
  assert.equal(first.error, null);
  assert.equal(first.session.autonomy, true, '主人授权后会话应记住直接执行授权');
  // 提示词带授权状态，模型知道可以输出 actions 块。
  assert.ok(thinker.captured[0].user.includes('## 执行授权'));
  assert.ok(thinker.captured[0].user.includes('已授权'));
  // 动作块从正文剥离，但把执行结果写回消息。
  assert.ok(!first.reply.includes('```actions'), '正文不应残留 actions 代码块');
  assert.ok(first.reply.includes('本轮已直接执行'));
  assert.equal(first.actions.length, 1);
  const taskId = first.actions[0].taskId;
  assert.match(taskId, /^task_/);
  const task = hub.getTask(taskId);
  assert.equal(task.priority, 6);
  assert.equal(task.instruction, '在反腐项目目录新增只读看板页面，跑通后截图验收');
  assert.equal(task.requirements.deviceId, device.id, '未指定设备时默认落到主设备，避免永远排队');
  assert.equal(task.context.brainstorm, true);
  assert.equal(task.context.sessionId, first.session.id);
  // 消息上的执行记录随会话返回（UI 可展示真实 task id）。
  const assistant = first.session.messages[1];
  assert.deepEqual(assistant.actions.map((item) => item.taskId), [taskId]);

  // 第二轮沿用同一会话的授权，无需再授权一次。
  thinker.reply = '## 结论\n继续。\n\n```actions\n[{"action":"create_task","instruction":"补一版看板交互说明文档并提交"}]\n```';
  const second = await hub.chatBrainstorm({ sessionId: first.session.id, message: '继续推进' });
  assert.equal(second.actions.length, 1);
  assert.notEqual(second.actions[0].taskId, taskId);
});

test('未授权：actions 块被丢弃，不建任务，正文不出现 JSON', async (t) => {
  const reply = [
    '## 结论',
    '先聊方向。',
    '',
    '```actions',
    '[{"action":"create_task","instruction":"这条任务在没有授权时不应被创建"}]',
    '```',
  ].join('\n');
  const thinker = makeThinker(reply);
  const { hub } = await newHub(t, { brainstormThink: thinker.think });

  const first = await hub.chatBrainstorm({ message: '先聊聊方向' });
  assert.equal(first.session.autonomy, false);
  assert.equal(first.actions.length, 0);
  assert.equal(first.session.messages[1].text, '## 结论\n先聊方向。');
  assert.equal([...hub.tasks.values()].length, 0);
  assert.ok(thinker.captured[0].user.includes('未授权'));
});

test('授权与消息动作随存档恢复（autonomy / actions 不被字段白名单丢弃）', async (t) => {
  const reply = '## 结论\n开干。\n\n```actions\n[{"action":"create_task","instruction":"跑一遍反腐看板的冒烟测试并记录结果"}]\n```';
  const thinker = makeThinker(reply);
  const { hub } = await newHub(t, { brainstormThink: thinker.think });
  const first = await hub.chatBrainstorm({ message: '授权给你，以后这类任务你直接创建' });
  const taskId = first.actions[0].taskId;

  const restored = restoreBrainstorm(hub._brainstormStateForPersist());
  const session = restored.sessions.find((item) => item.id === first.session.id);
  assert.ok(session, '会话应被恢复');
  assert.equal(session.autonomy, true);
  assert.deepEqual(session.messages[1].actions.map((item) => item.taskId), [taskId]);
});

test('历史会话里说过授权：重启恢复后不用再授权就按已授权执行', async (t) => {
  const now = new Date().toISOString();
  const sessionId = 'bs_history_authorized';
  const reply = '## 结论\n继续推进。\n\n```actions\n[{"action":"create_task","instruction":"继续推进反腐看板的下一步并提交结果"}]\n```';
  const thinker = makeThinker(reply);
  const { hub } = await newHub(t, {
    brainstormThink: thinker.think,
    brainstorm: {
      activeId: sessionId,
      sessions: [
        {
          id: sessionId,
          title: '旧会话',
          createdAt: now,
          updatedAt: now,
          messages: [
            { id: 'msg_old_1', role: 'user', at: now, text: '以后这种事你就自己办' },
            { id: 'msg_old_2', role: 'assistant', at: now, text: '好的。' },
          ],
        },
      ],
    },
  });
  const device = hub.registerDevice(makeManifest({ name: '母机' }));
  hub.updateSettings({ mainDeviceId: device.id });

  const result = await hub.chatBrainstorm({ sessionId, message: '继续' });
  assert.equal(result.session.autonomy, true, '历史消息里的授权应被回溯识别');
  assert.equal(result.actions.length, 1);
  assert.ok(result.reply.includes('本轮已直接执行'));
});

test('chat 参数校验：空消息与非法 sessionId；未知会话自动新建', async (t) => {
  const thinker = makeThinker();
  const { hub } = await newHub(t, { brainstormThink: thinker.think });
  await assert.rejects(() => hub.chatBrainstorm({ message: '   ' }), /message 必填/);
  await assert.rejects(() => hub.chatBrainstorm({ message: 'hi', sessionId: '   ' }), /sessionId 过长/);

  const created = await hub.chatBrainstorm({ message: '新的对话', sessionId: 'bs_not_exist' });
  assert.equal(created.session.title, '新的对话');
  assert.notEqual(created.session.id, 'bs_not_exist');
  assert.equal(hub.getBrainstorm().sessions.length, 1);
});

test('会话创建/删除与 activeId 回落', async (t) => {
  const { hub } = await newHub(t);
  const first = hub.createBrainstormSession();
  assert.match(first.id, /^bs_/);
  assert.equal(first.title, '新对话');
  assert.deepEqual(first.messages, []);
  assert.equal(hub.getBrainstorm().activeId, first.id);

  const second = hub.createBrainstormSession();
  assert.equal(hub.getBrainstorm().sessions.length, 2);
  assert.equal(hub.getBrainstorm().activeId, second.id);

  hub.deleteBrainstormSession(second.id);
  assert.equal(hub.getBrainstorm().sessions.length, 1);
  assert.equal(hub.getBrainstorm().activeId, first.id);
  assert.throws(() => hub.deleteBrainstormSession('bs_missing'), /对话不存在/);
});

test('持久化：serializeState 含 brainstorm，重启后会话/消息/activeId 恢复', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-brainstorm-persist-'));
  const thinker = makeThinker('## 结论\n先做 A。');
  const hub = await createHub({
    dataDir,
    silent: true,
    persistDebounceMs: 5,
    nightlyReview: false,
    brainTickMs: 3600000,
    goalTickMs: 3600000,
    brainstormThink: thinker.think,
  });
  try {
    const first = await hub.chatBrainstorm({ message: '帮我把目标拆成行动' });
    await hub.chatBrainstorm({ sessionId: first.session.id, message: '第一步是什么？' });
    const persisted = hub.serializeState();
    assert.equal(persisted.brainstorm.sessions.length, 1);
    assert.equal(persisted.brainstorm.sessions[0].messages.length, 4);
    assert.equal(persisted.brainstorm.activeId, first.session.id);

    await hub.flushState();
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
    assert.equal(onDisk.brainstorm.sessions[0].messages.length, 4);
  } finally {
    await hub.close();
  }

  const restored = await createHub({
    dataDir,
    silent: true,
    persistDebounceMs: 5,
    nightlyReview: false,
    brainTickMs: 3600000,
    goalTickMs: 3600000,
    brainstormThink: thinker.think,
  });
  try {
    const view = restored.getBrainstorm();
    assert.equal(view.sessions.length, 1);
    assert.equal(view.activeId, view.session.id);
    assert.equal(view.session.messages.length, 4);
    assert.ok(view.session.title.includes('帮我把目标拆成行动'));
  } finally {
    await restored.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('HTTP GET /api/brainstorm：列表、指定会话与消息条数', async (t) => {
  const thinker = makeThinker('## 回复\n收到。');
  const env = await startTestHub(t, { brainstormThink: thinker.think });

  let res = await request(env.base, 'GET', '/api/brainstorm', { headers: adminHeaders(env) });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.session, null);
  assert.equal(res.json.brainstorm.activeId, null);
  assert.equal(res.json.brainstorm.sessions.length, 0);
  assert.equal(typeof res.json.hubTime, 'string');

  res = await request(env.base, 'POST', '/api/brainstorm/chat', {
    headers: adminHeaders(env),
    body: { message: '帮我想想求职方向' },
  });
  assert.equal(res.status, 200, res.text);
  const sessionId = res.json.session.id;
  assert.equal(res.json.session.messages.length, 2);

  res = await request(env.base, 'GET', `/api/brainstorm?session=${sessionId}`, { headers: adminHeaders(env) });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.brainstorm.sessions.length, 1);
  assert.equal(res.json.session.id, sessionId);
  assert.equal(res.json.session.messages.length, 2);
  assert.equal(res.json.brainstorm.activeId, sessionId);

  res = await request(env.base, 'GET', `/api/brainstorm?session=${sessionId}&messages=1`, { headers: adminHeaders(env) });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.session.messages.length, 1);

  res = await request(env.base, 'GET', '/api/brainstorm');
  assert.equal(res.status, 401);
});

test('HTTP POST /api/brainstorm/chat：成功、参数非法 400、模型失败仍 200', async (t) => {
  const thinker = makeThinker('## 回复\n收到。');
  const env = await startTestHub(t, { brainstormThink: thinker.think });

  let res = await request(env.base, 'POST', '/api/brainstorm/chat', {
    headers: adminHeaders(env),
    body: { message: '帮我想想求职方向' },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.error, null);
  assert.ok(res.json.reply.startsWith('## 回复'));
  const sessionId = res.json.session.id;

  res = await request(env.base, 'POST', '/api/brainstorm/chat', {
    headers: adminHeaders(env),
    body: { sessionId, message: '给三个具体方案' },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.session.messages.length, 4);

  res = await request(env.base, 'POST', '/api/brainstorm/chat', {
    headers: adminHeaders(env),
    body: { message: '' },
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error.message, /message 必填/);

  res = await request(env.base, 'POST', '/api/brainstorm/chat', {
    headers: adminHeaders(env),
    body: { message: 'hi', sessionId: '   ' },
  });
  assert.equal(res.status, 400);

  res = await request(env.base, 'POST', '/api/brainstorm/chat', {
    body: { message: 'hi' },
  });
  assert.equal(res.status, 401);

  // 模型失败：HTTP 仍 200，error 说明原因，assistant 消息带 error。
  thinker.fail = true;
  res = await request(env.base, 'POST', '/api/brainstorm/chat', {
    headers: adminHeaders(env),
    body: { sessionId, message: '再想想' },
  });
  assert.equal(res.status, 200, res.text);
  assert.ok(res.json.error.includes('模型超时'));
  assert.equal(res.json.reply, null);
  assert.equal(res.json.session.messages[res.json.session.messages.length - 1].error, '模型超时');

  res = await request(env.base, 'GET', '/api/brainstorm/chat', { headers: adminHeaders(env) });
  assert.equal(res.status, 404);
});

test('HTTP POST /api/brainstorm/sessions 与 DELETE /api/brainstorm/sessions/:id', async (t) => {
  const env = await startTestHub(t, { brainstormThink: async () => '## 回复' });

  let res = await request(env.base, 'POST', '/api/brainstorm/sessions', {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.session.title, '新对话');
  assert.equal(res.json.session.messages.length, 0);
  assert.equal(res.json.brainstorm.sessions.length, 1);
  const sessionId = res.json.session.id;

  res = await request(env.base, 'DELETE', `/api/brainstorm/sessions/${sessionId}`, { headers: adminHeaders(env) });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.brainstorm.sessions.length, 0);
  assert.equal(res.json.brainstorm.activeId, null);

  res = await request(env.base, 'DELETE', '/api/brainstorm/sessions/bs_missing', { headers: adminHeaders(env) });
  assert.equal(res.status, 404);

  res = await request(env.base, 'GET', `/api/brainstorm/sessions/${sessionId}`, { headers: adminHeaders(env) });
  assert.equal(res.status, 404);
});

test('HTTP POST /api/brainstorm/to-task：生成任务并关联目标，校验 404/400', async (t) => {
  const env = await startTestHub(t, { brainstormThink: async () => '## 结论\n先做 A，再做 B。' });

  let res = await request(env.base, 'POST', '/api/goals', {
    headers: adminHeaders(env),
    body: { title: '求职', nickname: '求职' },
  });
  assert.equal(res.status, 200, res.text);
  const goalId = res.json.goal.id;

  res = await request(env.base, 'POST', '/api/brainstorm/chat', {
    headers: adminHeaders(env),
    body: { message: '帮我把求职目标拆成本周行动' },
  });
  assert.equal(res.status, 200, res.text);
  const sessionId = res.json.session.id;
  const assistant = res.json.session.messages[1];

  res = await request(env.base, 'POST', '/api/brainstorm/to-task', {
    headers: adminHeaders(env),
    body: { sessionId, messageId: assistant.id, goalId },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.task.priority, 6);
  assert.equal(res.json.task.goalId, goalId);
  assert.equal(res.json.task.context.brainstorm, true);
  assert.equal(res.json.task.context.sessionId, sessionId);
  assert.equal(res.json.task.context.messageId, assistant.id);
  assert.equal(res.json.session.id, sessionId);

  assert.ok(env.hub.getGoal(goalId).taskIds.includes(res.json.task.id));

  res = await request(env.base, 'POST', '/api/brainstorm/to-task', {
    headers: adminHeaders(env),
    body: { sessionId, messageId: 'bm_missing' },
  });
  assert.equal(res.status, 404);

  res = await request(env.base, 'POST', '/api/brainstorm/to-task', {
    headers: adminHeaders(env),
    body: { sessionId: 'bs_missing', messageId: assistant.id },
  });
  assert.equal(res.status, 404);

  res = await request(env.base, 'POST', '/api/brainstorm/to-task', {
    headers: adminHeaders(env),
    body: { sessionId, messageId: assistant.id },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.task.priority, 6);
  assert.equal(res.json.task.goalId, null);

  res = await request(env.base, 'GET', '/api/brainstorm/to-task', { headers: adminHeaders(env) });
  assert.equal(res.status, 404);
});
