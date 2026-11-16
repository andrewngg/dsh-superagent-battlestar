'use strict';

/**
 * 管家心路（journal）：把「思考」与「工作」按天记成时间线，并生成每日实质推进总结。
 *
 * 纯数据/纯函数模块，不依赖 Hub 实例；Hub 负责装配、持久化、广播与模型调用。
 * 结构见 docs/GOAL-BRAIN-DESIGN.md §6。
 */

const protocol = require('../../shared/protocol.js');
const util = require('./util.js');
const { brainModelConfig, createBrainThinker } = require('./brain');

const JOURNAL_KINDS = ['thought', 'work', 'milestone', 'daily'];
const JOURNAL_KIND_SET = new Set(JOURNAL_KINDS);
const MAX_ENTRIES = 800;
const MAX_DAYS = 180;
const MAX_TEXT = 4000;
const MAX_TITLE = 200;
const MAX_DAY_TEXT = 12000;
const DEFAULT_SUMMARY_TIME = '23:30';

const DEFAULT_JOURNAL = {
  enabled: true,
  summaryTime: DEFAULT_SUMMARY_TIME,
  lastSummaryDate: null,
  entries: [],
  days: {},
};

const KIND_LABELS = {
  thought: '思考',
  work: '工作',
  milestone: '里程碑',
  daily: '每日总结',
};

/** 系统本地时区（每日边界用）；Intl 不可用时退回 UTC。 */
function systemTimeZone() {
  try {
    const tz = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return util.str(tz, 100) || 'UTC';
  } catch {
    return 'UTC';
  }
}

function safeTimeZone(timeZone) {
  const candidate = util.str(timeZone, 100) || systemTimeZone();
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: candidate });
    return candidate;
  } catch {
    return systemTimeZone();
  }
}

function formatInZone(nowMs, timeZone, options) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: safeTimeZone(timeZone), ...options }).format(
    new Date(nowMs),
  );
}

/** YYYY-MM-DD（指定时区；默认系统时区）。 */
function localDateKey(nowMs = Date.now(), timeZone) {
  return formatInZone(nowMs, timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' });
}

/** HH:MM（指定时区；默认系统时区）。 */
function localTimeKey(nowMs = Date.now(), timeZone) {
  return formatInZone(nowMs, timeZone, { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** ISO 时间戳 → 本地日期键（无法解析时退回当前日期）。 */
function dayKey(at, timeZone) {
  const ms = Date.parse(at);
  return localDateKey(Number.isFinite(ms) ? ms : Date.now(), timeZone);
}

function validDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function validSummaryTime(value) {
  const text = util.str(value, 5);
  if (!/^\d{2}:\d{2}$/.test(text)) return false;
  const [hour, minute] = text.split(':').map((item) => Number(item));
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function journalDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_JOURNAL));
}

/** 归一化 PATCH /api/journal 的 body。 */
function normalizeJournalPatch(patch, base = DEFAULT_JOURNAL) {
  const src = util.isPlainObject(patch) ? patch : {};
  const value = {};
  const errors = [];
  if (src.enabled !== undefined) {
    if (typeof src.enabled !== 'boolean') errors.push('enabled 必须是布尔值');
    else value.enabled = src.enabled;
  }
  if (src.summaryTime !== undefined) {
    const text = util.str(src.summaryTime, 5).trim();
    if (!validSummaryTime(text)) errors.push('summaryTime 必须是 HH:MM（00:00–23:59）');
    else value.summaryTime = text;
  }
  if (errors.length) return { ok: false, errors };
  const merged = { ...base, ...value };
  return {
    ok: true,
    value: {
      enabled: merged.enabled !== false,
      summaryTime: validSummaryTime(merged.summaryTime) ? merged.summaryTime : DEFAULT_SUMMARY_TIME,
    },
  };
}

function normalizeRefs(refs) {
  const src = util.isPlainObject(refs) ? refs : {};
  const result = {};
  for (const key of ['taskId', 'goalId', 'decisionId']) {
    const value = util.str(src[key], 80);
    if (value) result[key] = value;
  }
  return result;
}

function normalizeEntry(raw, { timeZone } = {}) {
  const src = util.isPlainObject(raw) ? raw : {};
  const at = util.str(src.at, 40) || protocol.nowIso();
  const kind = JOURNAL_KIND_SET.has(src.kind) ? src.kind : 'work';
  const entry = {
    id: util.str(src.id, 60) || protocol.randomId('jrn'),
    at,
    date: validDateKey(src.date) ? src.date : dayKey(at, timeZone),
    kind,
    title: util.truncate(util.str(src.title, MAX_TITLE) || KIND_LABELS[kind], MAX_TITLE),
    text: util.truncate(util.str(src.text, MAX_TEXT), MAX_TEXT),
    refs: normalizeRefs(src.refs),
    meta: util.isPlainObject(src.meta) ? src.meta : {},
  };
  const ms = Date.parse(at);
  entry.at = Number.isFinite(ms) ? new Date(ms).toISOString() : protocol.nowIso();
  return entry;
}

/** 容错恢复：坏条目跳过，超限裁剪，按时间升序。 */
function restoreJournal(raw) {
  const src = util.isPlainObject(raw) ? raw : {};
  const journal = journalDefaults();
  journal.enabled = src.enabled !== false;
  journal.summaryTime = validSummaryTime(src.summaryTime) ? src.summaryTime : DEFAULT_SUMMARY_TIME;
  journal.lastSummaryDate = validDateKey(src.lastSummaryDate) ? src.lastSummaryDate : null;

  const entries = [];
  for (const item of util.arr(src.entries)) {
    if (!util.isPlainObject(item)) continue;
    entries.push(normalizeEntry(item));
  }
  entries.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  journal.entries = entries.slice(-MAX_ENTRIES);

  const days = {};
  if (util.isPlainObject(src.days)) {
    for (const [key, value] of Object.entries(src.days)) {
      if (!validDateKey(key) || !util.isPlainObject(value)) continue;
      days[key] = {
        date: key,
        summary: util.truncate(util.str(value.summary, MAX_DAY_TEXT), MAX_DAY_TEXT),
        highlights: util.arr(value.highlights).slice(0, 12).map((item) => ({
          text: util.truncate(util.str(util.isPlainObject(item) ? item.text : item, 300), 300),
          category: util.str(util.isPlainObject(item) ? item.category : '', 40) || '其他',
        })),
        stats: util.isPlainObject(value.stats) ? { ...value.stats } : {},
        generatedAt: util.str(value.generatedAt, 40) || null,
        model: util.str(value.model, 120) || null,
        entryCount: Number(value.entryCount) || 0,
        error: util.str(value.error, 500) || null,
      };
    }
  }
  const orderedKeys = Object.keys(days).sort().slice(-MAX_DAYS);
  for (const key of orderedKeys) journal.days[key] = days[key];
  return journal;
}

/**
 * 追加一条条目（同 id 幂等），返回归一化后的 entry；超出上限丢弃最旧。
 */
function appendJournalEntry(journal, raw, { timeZone } = {}) {
  const entry = normalizeEntry(raw, { timeZone });
  if (journal.entries.some((item) => item.id === entry.id)) return entry;
  journal.entries.push(entry);
  journal.entries.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  if (journal.entries.length > MAX_ENTRIES) {
    journal.entries.splice(0, journal.entries.length - MAX_ENTRIES);
  }
  const day = journal.days[entry.date];
  if (day) day.entryCount = countEntries(journal, entry.date);
  return entry;
}

function countEntries(journal, date) {
  return (journal.entries || []).filter((entry) => entry.date === date).length;
}

function entriesForDate(journal, date) {
  return (journal.entries || []).filter((entry) => entry.date === date);
}

/** 每日统计（用于总结与前端展示）。 */
function journalStatsForDay(entries) {
  const list = util.arr(entries);
  const stats = {
    thought: 0,
    work: 0,
    milestone: 0,
    daily: 0,
    total: list.length,
    completedTasks: 0,
    failedTasks: 0,
    goalsTouched: 0,
  };
  const goals = new Set();
  for (const entry of list) {
    if (stats[entry.kind] !== undefined) stats[entry.kind] += 1;
    if (entry.kind === 'work' && entry.meta && entry.meta.taskStatus === 'completed') {
      stats.completedTasks += 1;
    }
    if (
      entry.kind === 'work' &&
      entry.meta &&
      ['failed', 'timeout', 'cancelled'].includes(entry.meta.taskStatus)
    ) {
      stats.failedTasks += 1;
    }
    if (entry.refs && entry.refs.goalId) goals.add(entry.refs.goalId);
  }
  stats.goalsTouched = goals.size;
  return stats;
}

/** 对外展示结构：按天倒序 + 可选日期过滤的条目（倒序）。 */
function journalToJson(journal, { entries = 200, days = 60, date = null, nowMs = Date.now() } = {}) {
  const safeEntries = util.clampInt(entries, 200, 1, MAX_ENTRIES);
  const safeDays = util.clampInt(days, 60, 1, MAX_DAYS);
  const dayList = Object.values(journal.days || {})
    .filter((day) => !date || day.date === date)
    .map((day) => ({
      ...day,
      entryCount: countEntries(journal, day.date),
      stats: Object.keys(day.stats || {}).length
        ? day.stats
        : journalStatsForDay(entriesForDate(journal, day.date)),
    }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, safeDays);

  const selected = (journal.entries || [])
    .filter((entry) => !date || entry.date === date)
    .slice(-safeEntries)
    .reverse()
    .map((entry) => JSON.parse(JSON.stringify(entry)));

  return {
    enabled: journal.enabled !== false,
    summaryTime: journal.summaryTime || DEFAULT_SUMMARY_TIME,
    lastSummaryDate: journal.lastSummaryDate || null,
    timeZone: systemTimeZone(),
    today: localDateKey(nowMs),
    nowTime: localTimeKey(nowMs),
    days: dayList,
    entries: selected,
  };
}

/** 模型不可用/失败时的确定性总结。 */
function fallbackDailySummary({ date, entries, stats } = {}) {
  const list = util.arr(entries);
  const counts = stats || journalStatsForDay(list);
  const lines = [`## ${date || localDateKey()} 管家总结`];
  if (!counts.total) {
    lines.push('', '今天没有记录到明显的推进，也没有新的思考与任务结果。');
    return lines.join('\n');
  }
  lines.push('', `今天共记录 ${counts.total} 条（思考 ${counts.thought} · 工作 ${counts.work} · 里程碑 ${counts.milestone}）。`);
  const completed = list.filter(
    (entry) => entry.kind === 'work' && entry.meta && entry.meta.taskStatus === 'completed',
  );
  const failed = list.filter(
    (entry) =>
      entry.kind === 'work' &&
      entry.meta &&
      ['failed', 'timeout', 'cancelled'].includes(entry.meta.taskStatus),
  );
  const milestones = list.filter((entry) => entry.kind === 'milestone');
  if (completed.length) {
    lines.push('', '### 实质推进', ...completed.slice(-8).map((entry) => `- ${entry.title}`));
  }
  if (milestones.length) {
    lines.push('', '### 卡点与阻塞', ...milestones.slice(-6).map((entry) => `- ${entry.title}`));
  }
  if (failed.length) {
    lines.push('', '### 未完成', ...failed.slice(-6).map((entry) => `- ${entry.title}`));
  }
  const thoughts = list.filter((entry) => entry.kind === 'thought');
  if (thoughts.length) {
    lines.push('', '### 管家思考', ...thoughts.slice(-4).map((entry) => `- ${entry.title}`));
  }
  return lines.join('\n');
}

function buildDailySummaryPrompt({ date, entries, stats, goals, tasks, timeZone } = {}) {
  const list = util.arr(entries);
  const counts = stats || journalStatsForDay(list);
  const compact = list.slice(-80).map((entry) => ({
    at: entry.at,
    kind: entry.kind,
    title: util.truncate(entry.title, 160),
    text: util.truncate(entry.text, 600),
    refs: entry.refs || {},
    meta: entry.meta || {},
  }));
  const goalBrief = util.arr(goals).slice(0, 12).map((goal) => ({
    id: goal.id,
    name: goalDisplayNameLite(goal),
    status: goal.status,
    lastCheckStatus: goal.lastCheckStatus || null,
    lastSummary: util.truncate(util.str(goal.lastSummary, 400), 400),
  }));
  const taskBrief = util.arr(tasks).slice(0, 30).map((task) => ({
    id: task.id,
    instruction: util.truncate(task.instruction, 160),
    status: task.status,
    goalId: task.goalId || null,
  }));

  const system = [
    '你是 BattleStar 家庭 AI 管家，负责写「管家心路」的每日总结。',
    '只输出严格 JSON，不要 Markdown 围栏。',
    '语气克制、务实、第一人称；不要编造日志里没有的事实。',
    '重点回答：今天做了什么实质推进（可验收的结果）、遇到什么卡点、明天最重要的 1-3 步。',
    '如果当天没有实质推进，要直接说明，不要把计划/想法包装成结果。',
  ].join('\n');

  const user = [
    `日期：${date || localDateKey()}（时区 ${safeTimeZone(timeZone)}）`,
    `条目统计：${JSON.stringify(counts)}`,
    '今天的日志条目（JSON）：',
    JSON.stringify(compact, null, 2),
    '涉及的目标（JSON）：',
    JSON.stringify(goalBrief, null, 2),
    '今天的任务（JSON）：',
    JSON.stringify(taskBrief, null, 2),
    '',
    '请输出：',
    '{"summary":"Markdown 总结，3-6 段，包含「实质推进 / 卡点 / 明天建议」","highlights":[{"text":"一句话亮点","category":"推进|卡点|思考"}],"verdict":"一句话结论"}',
  ].join('\n');

  return { system, user };
}

function goalDisplayNameLite(goal) {
  return util.str(goal && (goal.nickname || goal.title), 120) || (goal && goal.id) || '目标';
}

/** 解析每日总结回复：JSON / 围栏 / 纯 Markdown 均可。 */
function parseDailySummary(text) {
  const raw = util.str(text, MAX_DAY_TEXT).trim();
  if (!raw) return { summary: '', highlights: [], verdict: '' };
  const candidates = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  const braces = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (braces >= 0 && lastBrace > braces) candidates.push(raw.slice(braces, lastBrace + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!util.isPlainObject(parsed)) continue;
      const summary = util.str(parsed.summary, MAX_DAY_TEXT).trim();
      if (!summary) continue;
      return {
        summary,
        highlights: util.arr(parsed.highlights).slice(0, 12).map((item) => ({
          text: util.truncate(util.str(util.isPlainObject(item) ? item.text : item, 300), 300),
          category: util.str(util.isPlainObject(item) ? item.category : '', 40) || '推进',
        })),
        verdict: util.str(parsed.verdict, 300),
      };
    } catch {
      // 继续尝试下一个候选
    }
  }
  return { summary: raw, highlights: [], verdict: '' };
}

/** 每日总结默认模型（与自主大脑共用一份配置）。 */
function journalModelConfig(overrides) {
  return brainModelConfig(overrides);
}

function createJournalThinker(config) {
  return createBrainThinker(config);
}

module.exports = {
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
  entriesForDate,
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
  systemTimeZone,
  validDateKey,
  validSummaryTime,
};
