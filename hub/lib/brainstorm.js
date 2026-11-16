'use strict';

/**
 * 头脑风暴（brainstorm）：与自主大脑多轮对话，用于梳理方向、拆解目标、评估取舍。
 *
 * 纯数据/纯函数模块，不依赖 Hub 实例；Hub 负责装配、持久化、广播与模型调用。
 * 结构见 docs/GOAL-BRAIN-DESIGN.md §7。
 */

const protocol = require('../../shared/protocol.js');
const util = require('./util.js');
const { brainModelConfig, createBrainThinker } = require('./brain');

const MAX_SESSIONS = 30;
const MAX_MESSAGES = 200;
const MAX_TEXT = 8000;
const MAX_TITLE = 80;
const MAX_TITLE_TEXT = 40;
const MAX_PREVIEW = 120;
const MAX_SESSION_ID = 80;
const HISTORY_LIMIT = 12;
const MAX_CONTEXT = 6000;
const MAX_CONTEXT_GOALS = 10;
const MAX_CONTEXT_TASKS = 16;
const MAX_CONTEXT_JOURNAL_DAYS = 3;
const DEFAULT_TITLE = '新对话';
const ROLES = ['user', 'assistant'];

const DEFAULT_BRAINSTORM = {
  activeId: null,
  sessions: [],
};

/** 首条用户消息 → 会话标题（单行、去掉 markdown 装饰、截断）。 */
function titleFromText(text) {
  const raw = util.str(text, MAX_TEXT).split(/\r?\n/).find((line) => line.trim()) || '';
  const cleaned = raw
    .replace(/^[#>*\-\s]+/, '')
    .replace(/[`*_~]/g, '')
    .trim();
  return util.truncate(cleaned, MAX_TITLE_TEXT) || DEFAULT_TITLE;
}

function nowIso() {
  return protocol.nowIso();
}

function makeMessage(raw = {}, at = nowIso()) {
  const role = ROLES.includes(raw.role) ? raw.role : null;
  if (!role) return null;
  const text = util.str(raw.text, MAX_TEXT);
  if (!text) return null;
  const message = {
    id: util.str(raw.id, 80) || util.generateToken('bm'),
    role,
    at: util.str(raw.at, 40) || at,
    text,
  };
  const model = util.str(raw.model, 80);
  if (model) message.model = model;
  if (raw.error) message.error = util.str(raw.error, 800);
  return message;
}

function createSession({ title, at } = {}) {
  const ts = util.str(at, 40) || nowIso();
  return {
    id: util.generateToken('bs'),
    title: util.str(title, MAX_TITLE) || DEFAULT_TITLE,
    createdAt: ts,
    updatedAt: ts,
    messages: [],
  };
}

function normalizeSession(raw, at) {
  if (!util.isPlainObject(raw)) return null;
  const ts = util.str(raw.createdAt, 40) || util.str(raw.updatedAt, 40) || at || nowIso();
  const session = {
    id: util.str(raw.id, 80) || util.generateToken('bs'),
    title: util.str(raw.title, MAX_TITLE) || DEFAULT_TITLE,
    createdAt: ts,
    updatedAt: util.str(raw.updatedAt, 40) || ts,
    messages: [],
  };
  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  for (const item of messages) {
    const message = makeMessage(item);
    if (message) session.messages.push(message);
  }
  if (session.messages.length > MAX_MESSAGES) {
    session.messages = session.messages.slice(-MAX_MESSAGES);
  }
  const firstUser = session.messages.find((message) => message.role === 'user');
  if (session.title === DEFAULT_TITLE && firstUser) session.title = titleFromText(firstUser.text);
  return session;
}

/** 容错恢复（state.json 存档可能缺字段/脏数据）。 */
function restoreBrainstorm(raw) {
  const src = util.isPlainObject(raw) ? raw : {};
  const at = nowIso();
  const sessions = [];
  for (const item of Array.isArray(src.sessions) ? src.sessions : []) {
    const session = normalizeSession(item, at);
    if (session) sessions.push(session);
  }
  sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const capped = sessions.slice(0, MAX_SESSIONS);
  const activeId = capped.some((session) => session.id === src.activeId) ? src.activeId : null;
  return { activeId, sessions: capped };
}

function findSession(brainstorm, sessionId) {
  if (!brainstorm || !Array.isArray(brainstorm.sessions)) return null;
  const id = util.str(sessionId, MAX_SESSION_ID);
  if (!id) return null;
  return brainstorm.sessions.find((session) => session.id === id) || null;
}

/** 追加一条消息；返回消息对象，角色/正文非法时返回 null。 */
function appendMessage(session, raw = {}, at) {
  if (!session || typeof session !== 'object') return null;
  const message = makeMessage(raw, at);
  if (!message) return null;
  if (!Array.isArray(session.messages)) session.messages = [];
  session.messages.push(message);
  if (session.messages.length > MAX_MESSAGES) {
    session.messages.splice(0, session.messages.length - MAX_MESSAGES);
  }
  session.updatedAt = message.at;
  if (message.role === 'user' && session.title === DEFAULT_TITLE) {
    session.title = titleFromText(message.text);
  }
  return message;
}

function sessionSummary(session) {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const last = messages[messages.length - 1];
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: messages.length,
    lastMessageAt: last ? last.at : session.updatedAt,
    preview: last ? util.truncate(last.text, MAX_PREVIEW) : '',
  };
}

/** UI 用投影：会话摘要列表 + 指定会话的最近 N 条消息。 */
function brainstormToJson(brainstorm, { messages = 100, sessionId } = {}) {
  const src = util.isPlainObject(brainstorm) ? brainstorm : DEFAULT_BRAINSTORM;
  const sessions = (Array.isArray(src.sessions) ? src.sessions : [])
    .slice()
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const limit = util.clampInt(messages, 100, 1, MAX_MESSAGES);
  let session = findSession(src, sessionId);
  if (!session && src.activeId) session = findSession(src, src.activeId);
  if (!session) session = sessions[0] || null;
  return {
    activeId: session ? session.id : null,
    sessions: sessions.map(sessionSummary),
    session: session
      ? {
          id: session.id,
          title: session.title,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          messages: session.messages.slice(-limit),
        }
      : null,
  };
}

function normalizeChatRequest(body) {
  const src = util.isPlainObject(body) ? body : {};
  const errors = [];
  const message = util.str(src.message, MAX_TEXT);
  if (!message) errors.push('message 必填');
  const sessionId = util.str(src.sessionId, MAX_SESSION_ID);
  if (src.sessionId && (!sessionId || String(src.sessionId).trim().length > MAX_SESSION_ID)) {
    errors.push('sessionId 过长');
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: { sessionId: sessionId || null, message } };
}

/** 把 Hub 侧上下文对象渲染成提示词文本（也接受现成字符串）。 */
function renderContext(context) {
  if (!util.isPlainObject(context)) return util.str(context, MAX_CONTEXT);
  const lines = [];
  if (context.now) lines.push(`当前时间：${util.str(context.now, 60)}`);
  const goals = Array.isArray(context.goals) ? context.goals.slice(0, MAX_CONTEXT_GOALS) : [];
  if (goals.length) {
    lines.push('长期目标：');
    for (const goal of goals) {
      const name = util.str(goal.title || goal.nickname, 120) || '未命名目标';
      const extra = goal.lastSummary ? `，最近：${util.truncate(goal.lastSummary, 160)}` : '';
      lines.push(`- ${name}（${util.str(goal.status, 20) || 'active'}${extra}）`);
    }
  }
  const tasks = Array.isArray(context.tasks) ? context.tasks.slice(0, MAX_CONTEXT_TASKS) : [];
  if (tasks.length) {
    lines.push('相关任务：');
    for (const task of tasks) {
      const error = task.error ? `，错误：${util.truncate(task.error, 120)}` : '';
      lines.push(`- [${util.str(task.status, 20) || 'queued'}] ${util.truncate(task.instruction, 120)}${error}`);
    }
  }
  const journal = Array.isArray(context.journal) ? context.journal.slice(0, MAX_CONTEXT_JOURNAL_DAYS) : [];
  if (journal.length) {
    lines.push('最近进展：');
    for (const day of journal) {
      const summary = util.truncate(day.summary || day.verdict || '', 240);
      if (summary) lines.push(`- ${util.str(day.date, 40)}：${summary}`);
    }
  }
  const approvals = Array.isArray(context.approvals) ? context.approvals.slice(0, 5) : [];
  if (approvals.length) {
    lines.push('待确认：');
    for (const item of approvals) {
      lines.push(`- ${util.str(item.goalTitle, 120) || '目标'}：${util.truncate(item.reason || '', 160)}`);
    }
  }
  return util.truncate(lines.join('\n'), MAX_CONTEXT);
}

const BRAINSTORM_SYSTEM_PROMPT = [
  '你是 BattleStar 管家的大脑，正在和主人进行头脑风暴。',
  '规则：',
  '1. 全程使用中文，回答以结构化 Markdown 呈现（小标题、列表、必要时表格），不要输出 JSON。',
  '2. 先给结论，再展开论证；区分「事实」（来自上下文）与「假设/推测」。',
  '3. 涉及决策时给出 2–3 个方案，明确推荐一个，并说明取舍与风险。',
  '4. 不编造上下文里没有的任务 ID、目标 ID、数据或进度。',
  '5. 信息不足时，先用 1–2 个关键问题澄清，不要凭空假设。',
  '6. 结尾给出「下一步」：可执行、可验收的行动建议。',
].join('\n');

/** 组装模型调用参数：system + user（上下文 + 最近历史 + 本轮消息）。 */
function buildBrainstormPrompt({ history = [], userMessage, context } = {}) {
  const parts = [];
  const contextText = renderContext(context);
  if (contextText) parts.push(`## 管家上下文\n${contextText}`);
  const recent = (Array.isArray(history) ? history : [])
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .slice(-HISTORY_LIMIT)
    .map((message) => `${message.role === 'user' ? '主人' : '大脑'}：${util.truncate(message.text, 1200)}`);
  if (recent.length) parts.push(`## 最近对话\n${recent.join('\n')}`);
  parts.push(`## 本轮消息\n${util.str(userMessage, MAX_TEXT)}`);
  return {
    system: BRAINSTORM_SYSTEM_PROMPT,
    user: util.truncate(parts.join('\n\n'), MAX_CONTEXT + MAX_TEXT + 4000),
  };
}

/** 大脑/头脑风暴共用的模型配置；无 key 时 createBrainThinker 会抛错（由 Hub 兜底）。 */
function brainstormModelConfig(overrides) {
  return brainModelConfig(overrides);
}

function createBrainstormThinker(overrides = {}) {
  const config = brainstormModelConfig(overrides);
  return createBrainThinker({
    model: config.model,
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
    fetchImpl: overrides.fetchImpl,
  });
}

module.exports = {
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
  brainstormModelConfig,
  brainstormToJson,
  buildBrainstormPrompt,
  createBrainstormThinker,
  createSession,
  findSession,
  normalizeChatRequest,
  normalizeSession,
  renderContext,
  restoreBrainstorm,
  sessionSummary,
  titleFromText,
};
