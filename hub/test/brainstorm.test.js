'use strict';

/**
 * 头脑风暴（brainstorm）纯函数单测：默认值/常量、标题清洗、会话创建、
 * 消息追加与裁剪、恢复容错、对外投影、请求归一化、上下文渲染、提示词组装、
 * 模型配置复用。契约见 docs/GOAL-BRAIN-DESIGN.md §7。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_BRAINSTORM,
  MAX_SESSIONS,
  MAX_MESSAGES,
  MAX_TEXT,
  MAX_TITLE,
  MAX_TITLE_TEXT,
  MAX_PREVIEW,
  MAX_SESSION_ID,
  HISTORY_LIMIT,
  DEFAULT_TITLE,
  ROLES,
  BRAINSTORM_SYSTEM_PROMPT,
  appendMessage,
  brainstormFileModelConfig,
  brainstormModelConfig,
  brainstormToJson,
  buildBrainstormPrompt,
  createBrainstormThinker,
  createSession,
  detectAutonomyGrant,
  findSession,
  normalizeBrainstormActions,
  normalizeChatRequest,
  renderContext,
  restoreBrainstorm,
  selectBrainstormModel,
  sessionSummary,
  splitBrainstormActionBlock,
  titleFromText,
} = require('../lib/brainstorm.js');

const MODEL_ENV_KEYS = [
  'BRAIN_API_KEY',
  'AGNES_API_KEY',
  'BUTLER_AGNES_API_KEY',
  'BRAIN_BASE_URL',
  'AGNES_BASE_URL',
  'BRAIN_MODEL',
  'AGNES_MODEL',
  'BRAIN_TIMEOUT_MS',
  'BRAIN_MAX_TOKENS',
  'DEEPSEEK_API_KEY',
  'BRAINSTORM_API_KEY',
  'BRAINSTORM_BASE_URL',
  'BRAINSTORM_MODEL',
  'BRAINSTORM_FILE_API_KEY',
  'BRAINSTORM_FILE_BASE_URL',
  'BRAINSTORM_FILE_MODEL',
];

/** 临时清空/设置模型相关环境变量，结束后恢复（宿主机可能配置了真实密钥）。 */
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

function at(offsetSeconds = 0) {
  return new Date(Date.UTC(2026, 0, 2, 10, 0, offsetSeconds)).toISOString();
}

test('默认值与上限符合设计约定', () => {
  assert.deepEqual(DEFAULT_BRAINSTORM, { activeId: null, sessions: [] });
  assert.equal(MAX_SESSIONS, 30);
  assert.equal(MAX_MESSAGES, 200);
  assert.equal(MAX_TEXT, 8000);
  assert.equal(MAX_TITLE, 80);
  assert.equal(MAX_TITLE_TEXT, 40);
  assert.equal(MAX_PREVIEW, 120);
  assert.equal(MAX_SESSION_ID, 80);
  assert.equal(HISTORY_LIMIT, 12);
  assert.equal(DEFAULT_TITLE, '新对话');
  assert.deepEqual(ROLES, ['user', 'assistant']);
  assert.equal(typeof BRAINSTORM_SYSTEM_PROMPT, 'string');
  for (const keyword of ['头脑风暴', '不要输出 JSON', '事实', '方案', '下一步']) {
    assert.ok(BRAINSTORM_SYSTEM_PROMPT.includes(keyword), `缺少提示词关键词：${keyword}`);
  }
});

test('titleFromText：取首行、去 Markdown 装饰并截断 40 字', () => {
  assert.equal(titleFromText('## 求职方向 **梳理**'), '求职方向 梳理');
  assert.equal(titleFromText('\n\n  # 第二行才是标题'), '第二行才是标题');
  assert.equal(titleFromText('**加粗**标题'), '加粗标题');
  assert.equal(titleFromText('   '), DEFAULT_TITLE);
  assert.equal(titleFromText(''), DEFAULT_TITLE);
  assert.equal(titleFromText(null), DEFAULT_TITLE);
  const long = titleFromText('a'.repeat(60));
  assert.equal(long, `${'a'.repeat(39)}…`);
  assert.equal(long.length, MAX_TITLE_TEXT);
});

test('createSession：默认标题/空消息/时间戳与 ID 前缀', () => {
  const session = createSession();
  assert.match(session.id, /^bs_/);
  assert.equal(session.title, DEFAULT_TITLE);
  assert.deepEqual(session.messages, []);
  assert.match(session.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(session.createdAt, session.updatedAt);

  const titled = createSession({ title: ' 求职规划 ', at: at(5) });
  assert.equal(titled.title, '求职规划');
  assert.equal(titled.createdAt, at(5));
  assert.equal(titled.updatedAt, at(5));
});

test('appendMessage：角色/正文校验、截断、标题与 updatedAt 更新', () => {
  const session = createSession();
  assert.equal(appendMessage(session, { role: 'system', text: 'x' }), null);
  assert.equal(appendMessage(session, { role: 'user', text: '   ' }), null);
  assert.equal(appendMessage(null, { role: 'user', text: 'x' }), null);

  const first = appendMessage(session, { role: 'user', text: '  帮我想想求职方向  ' }, at(1));
  assert.equal(first.role, 'user');
  assert.equal(first.text, '帮我想想求职方向');
  assert.equal(first.at, at(1));
  assert.match(first.id, /^bm_/);
  assert.equal(session.updatedAt, at(1));
  assert.equal(session.title, '帮我想想求职方向');

  const second = appendMessage(session, { role: 'assistant', text: '先定方向。', model: 'agnes-2.5-flash' }, at(2));
  assert.equal(second.model, 'agnes-2.5-flash');
  assert.equal(session.updatedAt, at(2));
  // 标题只由首条用户消息决定。
  appendMessage(session, { role: 'user', text: '第二个问题' }, at(3));
  assert.equal(session.title, '帮我想想求职方向');

  const long = appendMessage(session, { role: 'user', text: 'x'.repeat(9000) }, at(4));
  assert.equal(long.text.length, MAX_TEXT);
  assert.equal(session.title, '帮我想想求职方向');

  const withError = appendMessage(session, { role: 'assistant', text: '（大脑暂时无法回答）', error: '模型超时' }, at(5));
  assert.equal(withError.error, '模型超时');
});

test('appendMessage：消息数超过 200 时保留最近消息', () => {
  const session = createSession();
  for (let i = 0; i < 205; i += 1) {
    appendMessage(session, { role: 'user', text: `消息 ${i}` }, at(i));
  }
  assert.equal(session.messages.length, MAX_MESSAGES);
  assert.equal(session.messages[0].text, '消息 5');
  assert.equal(session.messages[session.messages.length - 1].text, '消息 204');
  assert.equal(session.updatedAt, at(204));
  assert.equal(session.title, '消息 0');
});

test('sessionSummary：摘要字段与 preview 截断', () => {
  const session = createSession({ title: '求职规划', at: at() });
  assert.deepEqual(sessionSummary(session), {
    id: session.id,
    title: '求职规划',
    createdAt: at(),
    updatedAt: at(),
    messageCount: 0,
    lastMessageAt: at(),
    preview: '',
    autonomy: false,
  });

  appendMessage(session, { role: 'assistant', text: 'y'.repeat(200) }, at(1));
  const summary = sessionSummary(session);
  assert.equal(summary.messageCount, 1);
  assert.equal(summary.lastMessageAt, at(1));
  assert.equal(summary.preview.length, MAX_PREVIEW);
  assert.ok(summary.preview.endsWith('…'));
});

test('restoreBrainstorm：容错恢复、排序、上限与 activeId 校验', () => {
  assert.deepEqual(restoreBrainstorm(null), { activeId: null, sessions: [] });
  assert.deepEqual(restoreBrainstorm({ sessions: 'nope' }), { activeId: null, sessions: [] });

  const raw = {
    activeId: 'bs_keep',
    sessions: [
      null,
      42,
      { id: 'bs_old', title: '旧会话', updatedAt: at(1), messages: [] },
      {
        id: 'bs_keep',
        title: '',
        createdAt: at(2),
        updatedAt: at(3),
        messages: [
          { role: 'user', text: '帮我把求职拆成行动' },
          { role: 'system', text: '应被丢弃' },
          { role: 'assistant', text: '' },
          { role: 'assistant', text: '先做 A 再做 B', at: at(3) },
        ],
      },
    ],
  };
  const restored = restoreBrainstorm(raw);
  assert.equal(restored.sessions.length, 2);
  assert.equal(restored.sessions[0].id, 'bs_keep');
  assert.equal(restored.sessions[1].id, 'bs_old');
  assert.equal(restored.activeId, 'bs_keep');
  const session = restored.sessions[0];
  // 标题由首条用户消息回填；非法角色/空正文被丢弃。
  assert.equal(session.title, '帮我把求职拆成行动');
  assert.equal(session.messages.length, 2);
  assert.deepEqual(session.messages.map((message) => message.role), ['user', 'assistant']);

  // activeId 不存在 / 指向被裁剪的会话时置空。
  assert.equal(restoreBrainstorm({ activeId: 'missing', sessions: [] }).activeId, null);
});

test('restoreBrainstorm：会话与消息上限裁剪', () => {
  const sessions = [];
  for (let i = 0; i < 35; i += 1) {
    sessions.push({ id: `bs_${i}`, title: `会话 ${i}`, updatedAt: at(i), messages: [] });
  }
  const restored = restoreBrainstorm({ activeId: 'bs_34', sessions });
  assert.equal(restored.sessions.length, MAX_SESSIONS);
  assert.equal(restored.sessions[0].id, 'bs_34');
  assert.equal(restored.activeId, 'bs_34');
  assert.equal(restored.sessions.some((session) => session.id === 'bs_0'), false);

  const messages = [];
  for (let i = 0; i < 205; i += 1) {
    messages.push({ role: 'user', text: `m${i}`, at: at(i) });
  }
  const capped = restoreBrainstorm({ sessions: [{ id: 'bs_big', updatedAt: at(), messages }] });
  assert.equal(capped.sessions[0].messages.length, MAX_MESSAGES);
  assert.equal(capped.sessions[0].messages[0].text, 'm5');
});

test('brainstormToJson：会话排序、session 解析与消息条数限制', () => {
  const empty = brainstormToJson(DEFAULT_BRAINSTORM);
  assert.deepEqual(empty, { activeId: null, sessions: [], session: null });

  const sessionA = createSession({ title: 'A', at: at(1) });
  for (let i = 0; i < 6; i += 1) {
    appendMessage(sessionA, { role: 'user', text: `A-${i}` }, at(10 + i));
  }
  const sessionB = createSession({ title: 'B', at: at(2) });
  appendMessage(sessionB, { role: 'user', text: 'B-0' }, at(2));
  const brainstorm = { activeId: sessionA.id, sessions: [sessionA, sessionB] };

  const view = brainstormToJson(brainstorm, { messages: 3 });
  assert.equal(view.activeId, sessionA.id);
  assert.deepEqual(view.sessions.map((item) => item.id), [sessionA.id, sessionB.id]);
  assert.equal(view.session.id, sessionA.id);
  assert.deepEqual(view.session.messages.map((message) => message.text), ['A-3', 'A-4', 'A-5']);

  // 指定 sessionId 优先；未知 sessionId 回落到 activeId。
  assert.equal(brainstormToJson(brainstorm, { sessionId: sessionB.id }).session.id, sessionB.id);
  assert.equal(brainstormToJson(brainstorm, { sessionId: 'missing' }).session.id, sessionA.id);
  // 无 activeId 时回落到最近更新的会话（sessionA 更新更晚）。
  const noActive = brainstormToJson({ activeId: null, sessions: [sessionA, sessionB] });
  assert.equal(noActive.session.id, sessionA.id);
  // messages 越界收敛到 1..200。
  assert.equal(brainstormToJson(brainstorm, { messages: 0 }).session.messages.length, 1);
  assert.equal(brainstormToJson(brainstorm, { messages: 999 }).session.messages.length, 6);

  assert.equal(findSession(brainstorm, sessionB.id).id, sessionB.id);
  assert.equal(findSession(brainstorm, 'missing'), null);
  assert.equal(findSession(brainstorm, null), null);
});

test('normalizeChatRequest：消息必填与 sessionId 长度校验', () => {
  assert.deepEqual(normalizeChatRequest({ message: '  ' }), { ok: false, errors: ['message 必填'] });
  assert.deepEqual(normalizeChatRequest({}), { ok: false, errors: ['message 必填'] });
  assert.deepEqual(normalizeChatRequest(null), { ok: false, errors: ['message 必填'] });

  // 纯空白或超长的 sessionId 视为非法（避免静默截断后串到别的会话）。
  assert.deepEqual(normalizeChatRequest({ message: 'hi', sessionId: '   ' }), {
    ok: false,
    errors: ['sessionId 过长'],
  });
  const tooLong = normalizeChatRequest({ message: 'hi', sessionId: 'x'.repeat(MAX_SESSION_ID + 5) });
  assert.equal(tooLong.ok, false);
  assert.deepEqual(tooLong.errors, ['sessionId 过长']);

  assert.deepEqual(normalizeChatRequest({ message: '  帮我想想  ', sessionId: ' bs_1 ' }), {
    ok: true,
    value: { sessionId: 'bs_1', message: '帮我想想', attachments: [] },
  });
  assert.deepEqual(normalizeChatRequest({ message: 'hi' }), {
    ok: true,
    value: { sessionId: null, message: 'hi', attachments: [] },
  });
  // 超长正文被截断而不是报错。
  assert.equal(normalizeChatRequest({ message: 'x'.repeat(9000) }).value.message.length, MAX_TEXT);
});

test('renderContext：字符串/对象渲染与数量上限', () => {
  assert.equal(renderContext(' 自定义上下文 '), '自定义上下文');
  assert.equal(renderContext({}), '');
  assert.equal(renderContext(null), '');

  const goals = [];
  for (let i = 0; i < 12; i += 1) {
    goals.push({ title: `目标 ${i}`, status: 'active', lastSummary: `最近进展 ${i}` });
  }
  const tasks = [];
  for (let i = 0; i < 20; i += 1) {
    tasks.push({ instruction: `任务 ${i}`, status: i === 0 ? 'failed' : 'assigned', error: i === 0 ? '超时' : null });
  }
  const rendered = renderContext({
    now: at(),
    goals,
    tasks,
    journal: [
      { date: '2026-01-03', summary: '完成报表' },
      { date: '2026-01-02', summary: '整理资料' },
      { date: '2026-01-01', summary: '' },
      { date: '2025-12-31', summary: '更早' },
    ],
    approvals: [
      { goalTitle: '求职', reason: '需要确认' },
      { goalTitle: '学习', reason: '需要确认 2' },
    ],
  });
  assert.ok(rendered.includes(`当前时间：${at()}`));
  assert.ok(rendered.includes('长期目标：'));
  assert.ok(rendered.includes('- 目标 0（active，最近：最近进展 0）'));
  assert.ok(rendered.includes('相关任务：'));
  assert.ok(rendered.includes('- [failed] 任务 0，错误：超时'));
  assert.ok(rendered.includes('最近进展：'));
  assert.ok(rendered.includes('- 2026-01-03：完成报表'));
  assert.ok(rendered.includes('待确认：'));
  assert.ok(rendered.includes('- 求职：需要确认'));
  // 上限：目标 10 个、任务 16 条、心路 3 天。
  assert.equal(goals.some((goal, index) => index === 10 && rendered.includes(goal.title)), false);
  assert.ok(rendered.includes('任务 15'));
  assert.equal(rendered.includes('任务 16'), false);
  assert.equal(rendered.includes('2025-12-31'), false);
});

test('buildBrainstormPrompt：system/上下文/最近历史/本轮消息', () => {
  const history = [];
  for (let i = 0; i < 14; i += 1) {
    history.push({ role: i % 2 === 0 ? 'user' : 'assistant', text: `历史消息 ${i}` });
  }
  history.unshift({ role: 'system', text: '系统消息不应出现' });

  const prompt = buildBrainstormPrompt({
    history,
    userMessage: '那第一步具体怎么做？',
    context: '长期目标：求职（active）',
  });
  assert.equal(prompt.system, BRAINSTORM_SYSTEM_PROMPT);
  assert.ok(prompt.user.startsWith('## 管家上下文\n长期目标：求职（active）'));
  assert.ok(prompt.user.includes('## 最近对话'));
  assert.ok(prompt.user.includes('## 本轮消息\n那第一步具体怎么做？'));
  // 只保留最近 12 条会话消息，最早两条与非法角色被丢弃。
  const historyLines = prompt.user.split('\n');
  assert.equal(historyLines.includes('主人：历史消息 0'), false);
  assert.equal(historyLines.includes('大脑：历史消息 1'), false);
  assert.ok(historyLines.includes('主人：历史消息 2'));
  assert.equal(historyLines.includes('系统消息不应出现'), false);
  assert.ok(prompt.user.includes('主人：历史消息 12'));
  assert.ok(prompt.user.includes('大脑：历史消息 13'));

  const noContext = buildBrainstormPrompt({ userMessage: '你好' });
  assert.equal(noContext.user.includes('## 管家上下文'), false);
  // 提示词末尾固定带「执行授权」段（未授权也明确告知），本轮消息在最后。
  assert.ok(noContext.user.startsWith('## 执行授权'));
  assert.ok(noContext.user.endsWith('## 本轮消息\n你好'));

  // 单条历史正文超长时截断到 1200（含省略号）。
  const longPrompt = buildBrainstormPrompt({
    history: [{ role: 'user', text: 'z'.repeat(3000) }],
    userMessage: '继续',
  });
  assert.ok(longPrompt.user.includes(`主人：${'z'.repeat(1199)}…`));
});

test('brainstormModelConfig：复用大脑默认配置与环境变量优先级', async () => {
  await withModelEnv({}, async () => {
    const config = brainstormModelConfig();
    assert.deepEqual(config, {
      apiKey: '',
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      model: 'agnes-2.5-flash',
      timeoutMs: 60000,
    });
  });

  await withModelEnv(
    {
      AGNES_API_KEY: '  agnes-key  ',
      AGNES_BASE_URL: 'https://agnes.test/v1///',
      AGNES_MODEL: 'agnes-model',
      BRAIN_TIMEOUT_MS: '90000',
    },
    async () => {
      const config = brainstormModelConfig();
      assert.equal(config.apiKey, 'agnes-key');
      assert.equal(config.baseUrl, 'https://agnes.test/v1');
      assert.equal(config.model, 'agnes-model');
      assert.equal(config.timeoutMs, 90000);
    },
  );

  await withModelEnv({ BRAIN_API_KEY: 'brain-key', BRAIN_MODEL: 'brain-model', AGNES_API_KEY: 'agnes-key' }, async () => {
    const config = brainstormModelConfig();
    assert.equal(config.apiKey, 'brain-key');
    assert.equal(config.model, 'brain-model');
  });
});

test('brainstormModelConfig：BRAINSTORM_* 独立覆盖，DEEPSEEK_API_KEY 自动切换', async () => {
  await withModelEnv(
    {
      BRAIN_API_KEY: 'brain-key',
      BRAINSTORM_API_KEY: 'bs-key',
      BRAINSTORM_BASE_URL: 'https://bs.test/v1///',
      BRAINSTORM_MODEL: 'bs-model',
    },
    async () => {
      const config = brainstormModelConfig();
      assert.equal(config.apiKey, 'bs-key');
      assert.equal(config.baseUrl, 'https://bs.test/v1');
      assert.equal(config.model, 'bs-model');
    },
  );

  await withModelEnv({ DEEPSEEK_API_KEY: 'ds-key' }, async () => {
    const config = brainstormModelConfig();
    assert.equal(config.apiKey, 'ds-key');
    assert.equal(config.baseUrl, 'https://api.deepseek.com');
    assert.equal(config.model, 'deepseek-chat');
  });

  await withModelEnv({ BRAINSTORM_MODEL: 'deepseek-reasoner' }, async () => {
    assert.equal(brainstormModelConfig().model, 'deepseek-reasoner');
  });
});

test('selectBrainstormModel：普通对话用默认模型，涉及文件时切 DeepSeek', async () => {
  await withModelEnv(
    {
      AGNES_API_KEY: 'agnes-key',
      AGNES_BASE_URL: 'https://agnes.test/v1',
      AGNES_MODEL: 'agnes-model',
      DEEPSEEK_API_KEY: 'ds-key',
    },
    async () => {
      const normal = selectBrainstormModel({});
      assert.equal(normal.model, 'agnes-model');
      assert.equal(normal.provider, 'default');
      const withFile = selectBrainstormModel({ fileMode: true });
      assert.equal(withFile.apiKey, 'ds-key');
      assert.equal(withFile.baseUrl, 'https://api.deepseek.com');
      assert.equal(withFile.model, 'deepseek-chat');
      assert.equal(withFile.provider, 'deepseek');
    },
  );

  // 没配 DeepSeek key：文件请求回退默认模型（附件内容仍会注入）。
  await withModelEnv({ AGNES_API_KEY: 'agnes-key', AGNES_MODEL: 'agnes-model' }, async () => {
    const withFile = selectBrainstormModel({ fileMode: true });
    assert.equal(withFile.model, 'agnes-model');
    assert.equal(brainstormFileModelConfig(), null);
  });

  // 文件模式模型可单独覆盖；只有 DEEPSEEK_API_KEY 时普通对话也用它。
  await withModelEnv(
    { DEEPSEEK_API_KEY: 'ds-key', BRAINSTORM_FILE_MODEL: 'deepseek-reasoner' },
    async () => {
      assert.equal(brainstormFileModelConfig().model, 'deepseek-reasoner');
      assert.equal(brainstormFileModelConfig().baseUrl, 'https://api.deepseek.com');
      const normal = selectBrainstormModel({});
      assert.equal(normal.model, 'deepseek-chat');
      assert.equal(normal.provider, 'deepseek');
    },
  );
});

test('createBrainstormThinker：未配置 key 拒绝；配置后按约定调用模型', async () => {
  await withModelEnv({}, async () => {
    const think = createBrainstormThinker();
    await assert.rejects(() => think({ system: 'sys', user: 'usr' }), /未配置自主大脑模型/);
  });

  await withModelEnv({ BRAIN_API_KEY: 'test-key' }, async () => {
    let captured = null;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ choices: [{ message: { content: '## 结论\n先做 A。' } }] });
        },
      };
    };
    const think = createBrainstormThinker({ model: 'brainstorm-model', fetchImpl });
    const reply = await think({ system: 'sys', user: 'usr' });
    assert.equal(reply, '## 结论\n先做 A。');
    assert.equal(captured.url, 'https://apihub.agnes-ai.com/v1/chat/completions');
    assert.equal(captured.init.method, 'POST');
    assert.equal(captured.init.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(captured.init.body);
    assert.equal(body.model, 'brainstorm-model');
    assert.equal(body.temperature, 0.2);
    assert.equal(body.max_tokens, 4000);
    assert.deepEqual(body.messages, [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
  });
});

// ------------------------------------------------- 直接执行（actions 块）

test('detectAutonomyGrant：识别主人明确授权的说法', () => {
  for (const text of [
    '授权给你，以后这类任务你直接创建',
    '你来创建任务吧，不用我过手',
    '以后这种事你就自己办',
    '这类的活由你来处理',
    '不需要每次都我来过手，你来创建或者开任务',
  ]) {
    assert.equal(detectAutonomyGrant(text), true, text);
  }
  for (const text of ['帮我想想方向', '这个任务你觉得怎么拆？', '先别建任务，我们聊聊', '']) {
    assert.equal(detectAutonomyGrant(text), false, text);
  }
});

test('splitBrainstormActionBlock：剥离末尾 actions 块并解析 create_task', () => {
  const raw = [
    '## 结论',
    '先做只读看板。',
    '',
    '```actions',
    JSON.stringify([
      { action: 'create_task', instruction: '在反腐目录新增只读看板并截图验收', goalId: 'goal_x', timeoutSec: 120 },
      { action: 'unknown_action', instruction: '这条会被忽略，因为动作类型不支持' },
      { action: 'create_task', instruction: '短' },
    ]),
    '```',
  ].join('\n');
  const parsed = splitBrainstormActionBlock(raw);
  assert.equal(parsed.text, '## 结论\n先做只读看板。');
  assert.equal(parsed.actions.length, 1);
  assert.equal(parsed.actions[0].action, 'create_task');
  assert.equal(parsed.actions[0].instruction, '在反腐目录新增只读看板并截图验收');
  assert.equal(parsed.actions[0].goalId, 'goal_x');
  assert.equal(parsed.actions[0].timeoutSec, 120);
});

test('splitBrainstormActionBlock：无块/坏 JSON 时安全降级', () => {
  const plain = splitBrainstormActionBlock('## 结论\n没有动作。');
  assert.equal(plain.text, '## 结论\n没有动作。');
  assert.deepEqual(plain.actions, []);

  const broken = splitBrainstormActionBlock('## 结论\n先做 A。\n\n```actions\nnot-json\n```');
  assert.equal(broken.text, '## 结论\n先做 A。');
  assert.deepEqual(broken.actions, []);
});

test('normalizeBrainstormActions：最多 2 条、超时钳制到安全区间', () => {
  const actions = normalizeBrainstormActions([
    { action: 'create_task', instruction: '第一条可执行指令' },
    { action: 'create_task', instruction: '第二条可执行指令', timeoutSec: 5 },
    { action: 'create_task', instruction: '第三条应被裁掉' },
  ]);
  assert.equal(actions.length, 2);
  assert.equal(actions[1].timeoutSec, 60);
});

test('授权状态进入提示词：已授权/未授权两套说法', () => {
  const granted = buildBrainstormPrompt({ userMessage: '继续', autonomy: true });
  assert.ok(granted.user.includes('## 执行授权'));
  assert.ok(granted.user.includes('已授权'));
  const denied = buildBrainstormPrompt({ userMessage: '继续', autonomy: false });
  assert.ok(denied.user.includes('未授权'));
});

test('会话与消息：autonomy 与 actions 字段可持久化', () => {
  const session = createSession({ title: '任务' });
  assert.equal(session.autonomy, false);
  session.autonomy = true;
  appendMessage(session, {
    role: 'assistant',
    text: '已建任务',
    actions: [{ action: 'create_task', taskId: 'task_abc', instruction: '做点事' }],
  });
  const restored = restoreBrainstorm({ activeId: session.id, sessions: [session] });
  assert.equal(restored.sessions[0].autonomy, true);
  assert.equal(restored.sessions[0].messages[0].actions[0].taskId, 'task_abc');
  assert.equal(brainstormToJson(restored).session.autonomy, true);
  assert.equal(sessionSummary(restored.sessions[0]).autonomy, true);
});
