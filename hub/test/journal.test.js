'use strict';

/**
 * 管家心路（journal）纯函数单测：默认值、PATCH 归一化、恢复/裁剪、追加/上限、
 * 时区日期键、每日统计、对外展示结构、每日总结 prompt/解析/降级、模型配置复用。
 * 契约见 docs/GOAL-BRAIN-DESIGN.md §6。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const brain = require('../lib/brain.js');
const {
  DEFAULT_JOURNAL,
  DEFAULT_SUMMARY_TIME,
  JOURNAL_KINDS,
  KIND_LABELS,
  MAX_DAYS,
  MAX_ENTRIES,
  MAX_TEXT,
  appendJournalEntry,
  buildDailySummaryPrompt,
  countEntries,
  createJournalThinker,
  dayKey,
  fallbackDailySummary,
  journalDefaults,
  journalModelConfig,
  journalStatsForDay,
  journalToJson,
  localDateKey,
  localTimeKey,
  normalizeEntry,
  normalizeJournalPatch,
  parseDailySummary,
  restoreJournal,
} = require('../lib/journal.js');

const MODEL_ENV_KEYS = [
  'BRAIN_API_KEY',
  'AGNES_API_KEY',
  'BUTLER_AGNES_API_KEY',
  'BRAIN_BASE_URL',
  'AGNES_BASE_URL',
  'BRAIN_MODEL',
  'AGNES_MODEL',
  'BRAIN_TIMEOUT_MS',
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

test('默认日志结构与常量符合设计约定', () => {
  assert.deepEqual(DEFAULT_JOURNAL, {
    enabled: true,
    summaryTime: '23:30',
    lastSummaryDate: null,
    entries: [],
    days: {},
  });
  assert.equal(DEFAULT_SUMMARY_TIME, '23:30');
  assert.deepEqual([...JOURNAL_KINDS], ['thought', 'work', 'milestone', 'daily']);
  assert.equal(MAX_ENTRIES, 800);
  assert.equal(MAX_DAYS, 180);
  assert.equal(MAX_TEXT, 4000);
  assert.deepEqual(KIND_LABELS, {
    thought: '思考',
    work: '工作',
    milestone: '里程碑',
    daily: '每日总结',
  });

  // journalDefaults 每次返回独立副本，避免 Hub 之间共享可变状态。
  const first = journalDefaults();
  const second = journalDefaults();
  first.entries.push({ id: 'x' });
  assert.deepEqual(second, DEFAULT_JOURNAL);
  assert.notEqual(first, second);
});

test('normalizeJournalPatch：合法补丁合并与归一化', () => {
  assert.deepEqual(normalizeJournalPatch({}), {
    ok: true,
    value: { enabled: true, summaryTime: '23:30' },
  });
  assert.deepEqual(normalizeJournalPatch({ enabled: false, summaryTime: '21:40' }), {
    ok: true,
    value: { enabled: false, summaryTime: '21:40' },
  });

  // 只改 enabled 时保留 base 的 summaryTime。
  const merged = normalizeJournalPatch({ enabled: true }, { enabled: false, summaryTime: '07:05' });
  assert.deepEqual(merged, { ok: true, value: { enabled: true, summaryTime: '07:05' } });

  // util.str 先截断再校验：' 21:40:30 ' → '21:40'。
  assert.equal(normalizeJournalPatch({ summaryTime: ' 21:40:30 ' }).value.summaryTime, '21:40');
  // base 中非法的 summaryTime 回退默认值。
  assert.equal(
    normalizeJournalPatch({}, { enabled: true, summaryTime: 'bad' }).value.summaryTime,
    DEFAULT_SUMMARY_TIME,
  );
});

test('normalizeJournalPatch：非法值一次性汇总错误', () => {
  const bad = normalizeJournalPatch({ enabled: 'yes', summaryTime: '25:00' });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors, [
    'enabled 必须是布尔值',
    'summaryTime 必须是 HH:MM（00:00–23:59）',
  ]);
  for (const badTime of ['24:00', '23:60', '9:40', '1200', '']) {
    assert.equal(normalizeJournalPatch({ summaryTime: badTime }).ok, false, `应拒绝 ${badTime}`);
  }
  assert.equal(normalizeJournalPatch({ summaryTime: '23:59' }).ok, true);
  assert.equal(normalizeJournalPatch({ summaryTime: '00:00' }).ok, true);
});

test('normalizeEntry：字段归一化、kind 白名单与引用过滤', () => {
  const entry = normalizeEntry({
    id: 'e1',
    at: '2026-01-02T10:00:00.000Z',
    kind: 'thought',
    title: '  思考标题  ',
    text: 'x'.repeat(4100),
    refs: { taskId: ' t1 ', goalId: '', decisionId: 123, other: 'x' },
    meta: { a: 1 },
  });
  assert.equal(entry.id, 'e1');
  assert.equal(entry.kind, 'thought');
  assert.equal(entry.title, '思考标题');
  assert.equal(entry.text.length, MAX_TEXT);
  assert.deepEqual(entry.refs, { taskId: 't1' });
  assert.deepEqual(entry.meta, { a: 1 });
  assert.equal(entry.at, '2026-01-02T10:00:00.000Z');
  assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/);

  const fallback = normalizeEntry({ kind: 'bogus', title: '', at: 'not-a-date', refs: null, meta: 'x' });
  assert.equal(fallback.kind, 'work');
  assert.match(fallback.id, /^jrn_/);
  assert.equal(fallback.title, '工作');
  assert.deepEqual(fallback.refs, {});
  assert.deepEqual(fallback.meta, {});
  assert.match(fallback.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(fallback.at, /^\d{4}-\d{2}-\d{2}T/);

  assert.equal(normalizeEntry({ kind: 'milestone' }).title, '里程碑');
});

test('restoreJournal：容错恢复、条目/天数裁剪与时间排序', () => {
  const days = {};
  for (let i = 0; i < 200; i += 1) {
    const date = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    days[date] = { summary: `s${i}`, entryCount: i };
  }
  days.bad = { summary: '非法日期键应被跳过' };
  days['2026-06-01'] = {
    summary: 'x'.repeat(13000),
    highlights: ['纯文本', { text: '要点', category: '推进' }, null, { text: 'y'.repeat(400) }],
    stats: { a: 1 },
    entryCount: '5',
    model: 'm',
    error: 'err',
  };
  const manyEntries = Array.from({ length: 810 }, (_, i) => ({
    id: `e${i}`,
    at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    kind: 'work',
    title: `t${i}`,
  }));
  const journal = restoreJournal({
    enabled: 'yes',
    summaryTime: '25:00',
    lastSummaryDate: 'bad',
    entries: [null, 'x', ...manyEntries],
    days,
  });

  assert.equal(journal.enabled, true); // 只有显式 false 才关闭
  assert.equal(journal.summaryTime, DEFAULT_SUMMARY_TIME);
  assert.equal(journal.lastSummaryDate, null);
  assert.equal(journal.entries.length, MAX_ENTRIES);
  assert.equal(journal.entries[0].id, 'e10');
  assert.equal(journal.entries.at(-1).id, 'e809');

  const keys = Object.keys(journal.days);
  assert.equal(keys.length, MAX_DAYS);
  assert.equal(keys[0], new Date(Date.UTC(2026, 0, 21)).toISOString().slice(0, 10));
  assert.equal(journal.days.bad, undefined);

  const day = journal.days['2026-06-01'];
  assert.equal(day.summary.length, 12000);
  assert.equal(day.highlights.length, 4);
  assert.deepEqual(day.highlights[0], { text: '纯文本', category: '其他' });
  assert.deepEqual(day.highlights[1], { text: '要点', category: '推进' });
  assert.equal(day.highlights[3].text.length, 300);
  assert.equal(day.entryCount, 5);
  assert.equal(day.model, 'm');
  assert.equal(day.error, 'err');
});

test('appendJournalEntry：同 id 幂等、上限裁剪与当日计数刷新', () => {
  const journal = journalDefaults();
  const first = appendJournalEntry(journal, {
    id: 'j1',
    at: '2026-01-02T10:00:00.000Z',
    kind: 'thought',
    title: '第一条',
  });
  journal.days[first.date] = {
    date: first.date,
    summary: '',
    highlights: [],
    stats: {},
    entryCount: 0,
  };
  assert.equal(journal.entries.length, 1);

  appendJournalEntry(journal, {
    id: 'j2',
    at: '2026-01-02T11:00:00.000Z',
    kind: 'work',
    title: '第二条',
  });
  assert.equal(journal.entries.length, 2);
  assert.equal(journal.days[first.date].entryCount, 2);

  const again = appendJournalEntry(journal, {
    id: 'j1',
    at: '2026-01-02T10:00:00.000Z',
    kind: 'work',
    title: '重复',
  });
  assert.equal(again.id, 'j1');
  assert.equal(journal.entries.length, 2);
  assert.equal(journal.entries[0].title, '第一条');
  assert.equal(journal.days[first.date].entryCount, 2);

  const capped = journalDefaults();
  for (let i = 0; i < 805; i += 1) {
    appendJournalEntry(capped, {
      id: `e${i}`,
      at: new Date(Date.UTC(2026, 0, 2, 0, 0, i)).toISOString(),
      kind: 'work',
      title: `t${i}`,
    });
  }
  assert.equal(capped.entries.length, MAX_ENTRIES);
  assert.equal(capped.entries[0].id, 'e5');
  assert.equal(capped.entries.at(-1).id, 'e804');
  assert.equal(countEntries(capped, capped.entries[0].date), capped.entries.length);
});

test('localDateKey / localTimeKey / dayKey：时区确定性', () => {
  const at = Date.UTC(2026, 0, 2, 20, 30, 0);
  assert.equal(localDateKey(at, 'UTC'), '2026-01-02');
  assert.equal(localTimeKey(at, 'UTC'), '20:30');
  assert.equal(localDateKey(at, 'Asia/Shanghai'), '2026-01-03');
  assert.equal(localTimeKey(at, 'Asia/Shanghai'), '04:30');

  assert.equal(dayKey('2026-01-02T23:30:00.000Z', 'UTC'), '2026-01-02');
  assert.equal(dayKey('2026-01-02T23:30:00.000Z', 'Asia/Shanghai'), '2026-01-03');
  // 非法时间/时区退回当前系统时区，不抛错。
  assert.match(dayKey('not-a-date'), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(localDateKey(at, 'Not/AZone'), /^\d{4}-\d{2}-\d{2}$/);
});

test('journalStatsForDay：按类型与任务状态统计', () => {
  const entries = [
    { kind: 'work', meta: { taskStatus: 'completed' }, refs: { goalId: 'g1' } },
    { kind: 'work', meta: { taskStatus: 'failed' }, refs: { goalId: 'g2' } },
    { kind: 'work', meta: { taskStatus: 'timeout' } },
    { kind: 'work', meta: { taskStatus: 'cancelled' } },
    { kind: 'thought', refs: { goalId: 'g1' } },
    { kind: 'milestone' },
    { kind: 'daily' },
  ];
  assert.deepEqual(journalStatsForDay(entries), {
    thought: 1,
    work: 4,
    milestone: 1,
    daily: 1,
    total: 7,
    completedTasks: 1,
    failedTasks: 3,
    goalsTouched: 2,
  });
  assert.equal(journalStatsForDay().total, 0);
});

test('journalToJson：天数/条目倒序、日期过滤与限额', () => {
  const journal = journalDefaults();
  const makeDay = (date, extra = {}) => ({
    date,
    summary: '',
    highlights: [],
    stats: {},
    generatedAt: null,
    model: null,
    entryCount: 0,
    error: null,
    ...extra,
  });
  journal.days['2026-01-01'] = makeDay('2026-01-01');
  journal.days['2026-01-02'] = makeDay('2026-01-02');
  journal.days['2026-01-03'] = makeDay('2026-01-03', { stats: { total: 9, thought: 9 } });
  journal.entries = [
    { id: 'e1', at: '2026-01-01T10:00:00.000Z', date: '2026-01-01', kind: 'thought' },
    { id: 'e2', at: '2026-01-01T11:00:00.000Z', date: '2026-01-01', kind: 'work' },
    { id: 'e3', at: '2026-01-03T10:00:00.000Z', date: '2026-01-03', kind: 'work' },
    { id: 'e4', at: '2026-01-03T11:00:00.000Z', date: '2026-01-03', kind: 'milestone' },
  ].map((entry) => normalizeEntry(entry));

  const view = journalToJson(journal, { entries: 2, days: 2, nowMs: Date.UTC(2026, 0, 5, 12, 0) });
  assert.equal(view.enabled, true);
  assert.equal(view.summaryTime, DEFAULT_SUMMARY_TIME);
  assert.equal(view.lastSummaryDate, null);
  assert.equal(typeof view.timeZone, 'string');
  assert.match(view.today, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(view.nowTime, /^\d{2}:\d{2}$/);
  assert.deepEqual(view.days.map((day) => day.date), ['2026-01-03', '2026-01-02']);
  assert.deepEqual(view.entries.map((entry) => entry.id), ['e4', 'e3']);
  assert.equal(view.days[0].entryCount, 2);
  assert.equal(view.days[0].stats.total, 9); // 已有 stats 原样保留
  assert.equal(view.days[1].entryCount, 0);
  assert.equal(view.days[1].stats.total, 0); // 缺失 stats 时按条目回算

  const filtered = journalToJson(journal, { date: '2026-01-03', entries: 50, days: 10 });
  assert.deepEqual(filtered.entries.map((entry) => entry.id), ['e4', 'e3']);
  assert.deepEqual(filtered.days.map((day) => day.date), ['2026-01-03']);
});

test('fallbackDailySummary：空日与有内容的确定性汇总', () => {
  const empty = fallbackDailySummary({ date: '2026-01-02', entries: [] });
  assert.match(empty, /^## 2026-01-02 管家总结/);
  assert.match(empty, /今天没有记录到明显的推进/);

  const entries = [
    normalizeEntry({ kind: 'work', title: '完成任务 A', meta: { taskStatus: 'completed' } }),
    normalizeEntry({ kind: 'work', title: '任务 B 失败', meta: { taskStatus: 'failed' } }),
    normalizeEntry({ kind: 'milestone', title: '计划卡点：写报告' }),
    normalizeEntry({ kind: 'thought', title: '思考：继续推进' }),
  ];
  const stats = journalStatsForDay(entries);
  const text = fallbackDailySummary({ date: '2026-01-02', entries, stats });
  assert.match(text, /今天共记录 4 条（思考 1 · 工作 2 · 里程碑 1）/);
  assert.match(text, /### 实质推进[\s\S]*- 完成任务 A/);
  assert.match(text, /### 卡点与阻塞[\s\S]*- 计划卡点：写报告/);
  assert.match(text, /### 未完成[\s\S]*- 任务 B 失败/);
  assert.match(text, /### 管家思考[\s\S]*- 思考：继续推进/);
});

test('parseDailySummary：JSON、围栏与纯文本降级', () => {
  const json = parseDailySummary(
    JSON.stringify({
      summary: '今天完成了 A。',
      highlights: [{ text: '完成 A', category: '推进' }, { text: '继续 B' }],
      verdict: '稳步',
    }),
  );
  assert.equal(json.summary, '今天完成了 A。');
  assert.deepEqual(json.highlights, [
    { text: '完成 A', category: '推进' },
    { text: '继续 B', category: '推进' },
  ]);
  assert.equal(json.verdict, '稳步');

  const fenced = parseDailySummary(
    `\`\`\`json\n${JSON.stringify({ summary: '围栏总结', highlights: [] })}\n\`\`\``,
  );
  assert.equal(fenced.summary, '围栏总结');
  assert.deepEqual(fenced.highlights, []);

  const plain = parseDailySummary('## 今日总结\n今天完成了 A。');
  assert.equal(plain.summary, '## 今日总结\n今天完成了 A。');
  assert.deepEqual(plain.highlights, []);
  assert.equal(plain.verdict, '');

  assert.deepEqual(parseDailySummary(''), { summary: '', highlights: [], verdict: '' });
  // 合法 JSON 但没有 summary 时降级为整段文本。
  assert.equal(parseDailySummary(JSON.stringify({ highlights: [] })).summary, '{"highlights":[]}');
  assert.equal(parseDailySummary('[1,2]').summary, '[1,2]');
});

test('buildDailySummaryPrompt：包含当日条目、统计与严格 JSON 指令', () => {
  const entries = [
    normalizeEntry({
      at: '2026-01-02T10:00:00.000Z',
      kind: 'work',
      title: '完成任务 A',
      text: '输出结果',
      refs: { taskId: 'task_1' },
      meta: { taskStatus: 'completed' },
    }),
  ];
  const stats = journalStatsForDay(entries);
  const prompt = buildDailySummaryPrompt({
    date: '2026-01-02',
    entries,
    stats,
    goals: [
      { id: 'goal_1', nickname: '求职目标', status: 'active', lastCheckStatus: 'completed', lastSummary: '已投递 3 家' },
    ],
    tasks: [{ id: 'task_1', instruction: '投递简历', status: 'completed', goalId: 'goal_1' }],
    timeZone: 'UTC',
  });
  assert.match(prompt.system, /BattleStar 家庭 AI 管家/);
  assert.match(prompt.system, /只输出严格 JSON/);
  assert.match(prompt.user, /日期：2026-01-02（时区 UTC）/);
  assert.match(prompt.user, /"total":1/);
  assert.match(prompt.user, /今天的日志条目（JSON）：/);
  assert.match(prompt.user, /完成任务 A/);
  assert.match(prompt.user, /求职目标/);
  assert.match(prompt.user, /投递简历/);
  assert.match(prompt.user, /"summary"/);
  assert.match(prompt.user, /"highlights"/);
  // 空入参也生成合法 prompt，不抛错。
  assert.equal(typeof buildDailySummaryPrompt({}).user, 'string');
});

test('journalModelConfig / createJournalThinker 复用自主大脑模型配置', async () => {
  await withModelEnv({}, async () => {
    assert.deepEqual(journalModelConfig(), brain.brainModelConfig());
    assert.deepEqual(journalModelConfig({ model: 'journal-model' }), brain.brainModelConfig({ model: 'journal-model' }));
    assert.equal(journalModelConfig().apiKey, '');
    await assert.rejects(
      () => createJournalThinker({})({ system: 's', user: 'u' }),
      /未配置自主大脑模型/,
    );
  });

  await withModelEnv({ AGNES_API_KEY: ' agnes-key ', AGNES_MODEL: 'journal-env-model' }, async () => {
    const config = journalModelConfig();
    assert.equal(config.apiKey, 'agnes-key');
    assert.equal(config.model, 'journal-env-model');
  });

  // BRAIN_* 优先于 AGNES_*（与大脑共用同一套环境变量）。
  await withModelEnv({ BRAIN_API_KEY: 'brain-key', AGNES_API_KEY: 'agnes-key' }, async () => {
    assert.equal(journalModelConfig().apiKey, 'brain-key');
  });

  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: '{"summary":"模型总结"}' } }] }),
    };
  };
  // createJournalThinker 在创建时读取环境变量中的 apiKey（config.apiKey 会被忽略），
  // 因此需要在环境变量存在期间创建并调用。
  await withModelEnv({ BRAIN_API_KEY: 'test-key' }, async () => {
    const think = createJournalThinker({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1/',
      model: 'journal-model',
      fetchImpl,
    });
    const reply = await think({ system: 'sys', user: 'usr' });
    assert.equal(reply, '{"summary":"模型总结"}');
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.test/v1/chat/completions');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-key');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'journal-model');
  assert.deepEqual(body.messages.map((message) => message.role), ['system', 'user']);
});
