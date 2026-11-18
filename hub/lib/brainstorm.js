'use strict';

/**
 * 头脑风暴（brainstorm）：与自主大脑多轮对话，用于梳理方向、拆解目标、评估取舍。
 *
 * 纯数据/纯函数模块，不依赖 Hub 实例；Hub 负责装配、持久化、广播与模型调用。
 * 结构见 docs/GOAL-BRAIN-DESIGN.md §7。
 */

const path = require('node:path');
const protocol = require('../../shared/protocol.js');
const util = require('./util.js');
const { MAX_ATTACHMENTS, MAX_TOTAL_CHARS } = require('./file-reader.js');
const { brainModelConfig, createBrainThinker } = require('./brain');

const MAX_SESSIONS = 30;
const MAX_MESSAGES = 200;
const MAX_TEXT = 8000;
const MAX_TITLE = 80;
const MAX_TITLE_TEXT = 40;
const MAX_PREVIEW = 120;
const MAX_SESSION_ID = 80;
// 直接执行：主人授权后，模型可以在回复末尾附 ```actions 代码块，由 Hub 真正建任务。
const MAX_ACTIONS = 2;
const MAX_ACTION_INSTRUCTION = 4000;
const ACTION_FENCE = 'actions';
const BRAINSTORM_ACTIONS = ['create_task'];
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

/** 附件元数据（消息里只存名称/路径/大小，不存正文）。 */
function normalizeAttachmentMeta(raw) {
  if (!util.isPlainObject(raw)) return null;
  const name = util.str(raw.name, 200) || (raw.path ? String(raw.path).split(/[\\/]/).pop() : '');
  if (!name) return null;
  const meta = { name };
  const pathValue = util.str(raw.path, 4000);
  if (pathValue) meta.path = pathValue;
  const size = Number(raw.size);
  if (Number.isFinite(size) && size >= 0) meta.size = Math.floor(size);
  if (raw.truncated === true) meta.truncated = true;
  return meta;
}

/** 请求里的附件：{path}（Hub 本机文件）或 {name,text}（前端上传文本）。 */
function normalizeAttachmentInputs(raw) {
  if (!Array.isArray(raw)) return { ok: true, value: [] };
  if (raw.length > MAX_ATTACHMENTS) return { ok: false, error: `附件最多 ${MAX_ATTACHMENTS} 个` };
  const value = [];
  for (const item of raw) {
    if (!util.isPlainObject(item)) return { ok: false, error: '附件格式无效' };
    if (typeof item.path === 'string' && item.path.trim()) {
      value.push({ path: util.str(item.path, 4000) });
      continue;
    }
    if (typeof item.text === 'string') {
      value.push({ name: util.str(item.name, 200) || 'attachment', text: item.text });
      continue;
    }
    return { ok: false, error: '附件格式无效（需要 {path} 或 {name,text}）' };
  }
  return { ok: true, value };
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
  const attachmentMeta = (Array.isArray(raw.attachments) ? raw.attachments : [])
    .map(normalizeAttachmentMeta)
    .filter(Boolean)
    .slice(0, MAX_ATTACHMENTS);
  if (attachmentMeta.length) message.attachments = attachmentMeta;
  // 直接执行结果（本轮真正建了哪些任务 / 为何失败），供 UI 展示与重启后保留。
  const actionRecords = normalizeActionRecords(raw.actions);
  if (actionRecords.length) message.actions = actionRecords;
  return message;
}

/** 消息上记录的执行结果：只保留 taskId/goalId/error/instruction，避免存档膨胀。 */
function normalizeActionRecords(raw) {
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!util.isPlainObject(item)) continue;
    const record = { action: util.str(item.action, 40) || 'create_task' };
    const taskId = util.str(item.taskId, 80);
    if (taskId) record.taskId = taskId;
    const goalId = util.str(item.goalId, 80);
    if (goalId) record.goalId = goalId;
    const instruction = util.str(item.instruction, 300);
    if (instruction) record.instruction = instruction;
    const error = util.str(item.error, 300);
    if (error) record.error = error;
    out.push(record);
  }
  return out.slice(0, MAX_ACTIONS);
}

/**
 * 主人是否在明确授权「你直接建任务 / 开任务」。
 * 只影响当前头脑风暴会话：授权后模型才能输出 actions 块，Hub 才会真的建任务。
 */
const AUTONOMY_PATTERNS = [
  /授权给你/,
  /授权你/,
  /你(来|直接|自己)(创建|建|开|起|做|执行|派发|处理)/,
  /不用(我|主人)(过手|手动|插手|管|来)/,
  /不(需要|用)每次(都)?(我|主人)?(来)?(过手|手动|操心|管)/,
  /不需要?(我|主人)(来)?(过手|手动|操心|管)/,
  /(以后|往后|这类|这些|这种|此类|类似)(的)?(事|任务|操作|活)?(就|都)?(由)?你(就|都|要|会)?(来|直接|自己)/,
  /(这|那)(种|类|些|样)(的)?(事|任务|操作|活)?(就|都)?(由)?你(就|都|要|会)?(来|直接|自己)/,
];

function detectAutonomyGrant(text) {
  const value = util.str(text, MAX_TEXT);
  if (!value) return false;
  return AUTONOMY_PATTERNS.some((re) => re.test(value));
}

/** 把模型给的 JSON（数组 / {actions:[...]} / 单个动作对象）统一成动作列表。 */
function extractActionList(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (util.isPlainObject(parsed)) {
    if (Array.isArray(parsed.actions)) return parsed.actions;
    if (parsed.action || parsed.type || parsed.name) return [parsed];
  }
  return [];
}

function parseActionJson(body) {
  const raw = String(body || '').trim();
  if (!raw) return [];
  try {
    return extractActionList(JSON.parse(raw));
  } catch {
    // 模型偶尔在代码块里加说明文字：截取第一个 [ / { 到最后一个 ] / } 再试一次。
  }
  const start = raw.search(/[[{]/);
  const end = Math.max(raw.lastIndexOf(']'), raw.lastIndexOf('}'));
  if (start >= 0 && end > start) {
    try {
      return extractActionList(JSON.parse(raw.slice(start, end + 1)));
    } catch {
      return [];
    }
  }
  return [];
}

/** 校验并规范化动作：只接受 create_task，指令太短/缺失的丢弃。 */
function normalizeBrainstormActions(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    if (!util.isPlainObject(item)) continue;
    const name = util.str(item.action || item.type || item.name, 40).toLowerCase().replace(/[\s-]+/g, '_');
    if (!BRAINSTORM_ACTIONS.includes(name)) continue;
    const instruction = util.str(item.instruction || item.task, MAX_ACTION_INSTRUCTION).trim();
    if (instruction.length < 8) continue;
    const action = { action: 'create_task', instruction };
    const goalId = util.str(item.goalId, 80);
    if (goalId) action.goalId = goalId;
    const deviceId = util.str(item.deviceId, 80);
    if (deviceId) action.deviceId = deviceId;
    const project = util.str(item.project, 120);
    if (project) action.project = project;
    const reason = util.str(item.reason, 200);
    if (reason) action.reason = reason;
    const timeoutSec = Number(item.timeoutSec);
    if (Number.isFinite(timeoutSec)) action.timeoutSec = util.clampInt(timeoutSec, 600, 60, 3600);
    out.push(action);
    if (out.length >= MAX_ACTIONS) break;
  }
  return out;
}

/**
 * 拆出回复末尾的 ```actions 代码块：返回 { text, actions }。
 * 代码块永远从可见正文里剥离（避免把 JSON 漏给主人），解析失败时 actions 为空。
 */
function splitBrainstormActionBlock(raw) {
  const text = util.str(raw, MAX_TEXT);
  const re = new RegExp('```(?:' + ACTION_FENCE + ')[ \\t]*\\r?\\n([\\s\\S]*?)```', 'gi');
  let match;
  let last = null;
  while ((match = re.exec(text)) !== null) last = match;
  if (!last) return { text, actions: [] };
  const actions = normalizeBrainstormActions(parseActionJson(last[1]));
  const cleaned = `${text.slice(0, last.index)}${text.slice(last.index + last[0].length)}`
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: cleaned, actions };
}

function createSession({ title, at } = {}) {
  const ts = util.str(at, 40) || nowIso();
  return {
    id: util.generateToken('bs'),
    title: util.str(title, MAX_TITLE) || DEFAULT_TITLE,
    createdAt: ts,
    updatedAt: ts,
    // 主人是否已授权本会话直接建任务（授权后模型可输出 actions 块）。
    autonomy: false,
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
    autonomy: raw.autonomy === true,
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
    autonomy: session.autonomy === true,
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
          autonomy: session.autonomy === true,
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
  const attachments = normalizeAttachmentInputs(src.attachments);
  if (!attachments.ok) errors.push(attachments.error);
  return errors.length
    ? { ok: false, errors }
    : {
        ok: true,
        value: {
          sessionId: sessionId || null,
          message,
          attachments: attachments.ok ? attachments.value : [],
        },
      };
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
  '1. 全程使用中文，回答以结构化 Markdown 呈现（小标题、列表、必要时表格），不要输出 JSON（唯一例外是末尾的 actions 任务块，见规则 8）。',
  '2. 先给结论，再展开论证；区分「事实」（来自上下文）与「假设/推测」。',
  '3. 涉及决策时给出 2–3 个方案，明确推荐一个，并说明取舍与风险。',
  '4. 不编造上下文里没有的任务 ID、目标 ID、数据或进度。',
  '5. 信息不足时，先用 1–2 个关键问题澄清，不要凭空假设。',
  '6. 结尾给出「下一步」：可执行、可验收的行动建议。',
  '7. BattleStar Hub 会把主人指定的文件内容注入本轮提示词（见「用户提供的文件」）。你本身没有文件系统访问权，但注入内容就是文件全文；不要声称「无法访问本地文件系统」。若「附件读取失败」列出了文件，请直接说明失败路径与原因，并建议改用附件上传或放到 Hub 主机后再试。',
  '8. 「执行授权」为「已授权」时，你可以直接创建任务：把工作写成自包含指令（做什么、在哪台机器/哪个路径、步骤、验收标准、时间预算），然后在正文之后追加一个 ```actions 代码块，内容为 JSON 数组，最多 2 条，例如：\n```actions\n[{"action":"create_task","instruction":"……","goalId":"可选的目标 ID","deviceId":"可选的设备 ID","reason":"为什么建","timeoutSec":600}]\n```\n正文里不要出现这段 JSON；「执行授权」为「未授权」时不要输出 actions 块。',
  '9. 建任务前先看「管家上下文」里的相关任务：与排队中/执行中的任务重复的不要重复创建；只把真正可执行的下一步写成任务，不要为凑数把讨论性内容写成任务。',
  '10. 口头承诺不算执行：只有写了 actions 块，Hub 才会真的建任务；没写就在正文里说明「可以点『转成任务』」。',
  '11. 上下文里出现「本轮已直接执行」时，用一句话向主人说明已建了哪些任务，不要重复建。',
].join('\n');

const LANGUAGE_BY_EXT = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.json': 'json',
  '.md': 'markdown',
  '.py': 'python',
  '.ps1': 'powershell',
  '.psm1': 'powershell',
  '.sh': 'bash',
  '.bat': 'batch',
  '.cmd': 'batch',
  '.html': 'html',
  '.css': 'css',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'toml',
  '.sql': 'sql',
  '.java': 'java',
  '.xml': 'xml',
  '.csv': 'csv',
  '.log': 'text',
  '.txt': 'text',
};

function fenceFor(text) {
  return String(text || '').includes('```') ? '````' : '```';
}

/** 把附件渲染成提示词段落；正文过长时截断并注明。 */
function renderAttachments(attachments) {
  const list = (Array.isArray(attachments) ? attachments : []).slice(0, MAX_ATTACHMENTS);
  if (!list.length) return '';
  const blocks = [];
  for (const item of list) {
    if (!item || !item.text) continue;
    const name = util.str(item.name, 200) || '附件';
    const meta = [
      item.path ? `路径：${item.path}` : '',
      item.size ? `${Math.max(1, Math.round(item.size / 1024))} KB` : '',
      item.truncated ? '内容已截断' : '',
    ].filter(Boolean).join(' · ');
    const fence = fenceFor(item.text);
    const lang = LANGUAGE_BY_EXT[String(item.path ? path.extname(item.path) : path.extname(name)).toLowerCase()] || '';
    blocks.push(`### ${name}${meta ? `（${meta}）` : ''}\n${fence}${lang}\n${item.text}\n${fence}`);
  }
  if (!blocks.length) return '';
  return [
    '## 用户提供的文件',
    '以下内容由 BattleStar Hub 从 Hub 所在机器的文件系统读取后原样注入，就是文件全文；你无需再次访问文件系统，请直接基于这些内容回答，不要声称“无法访问本地文件系统”。',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

/** 渲染附件读取失败提示（让模型直接说明哪个文件读不到、怎么处理）。 */
function renderAttachmentErrors(errors) {
  const list = (Array.isArray(errors) ? errors : [])
    .map((item) => util.str(item, 300))
    .filter(Boolean)
    .slice(0, MAX_ATTACHMENTS);
  if (!list.length) return '';
  return [
    '## 附件读取失败',
    '以下文件在 Hub 所在机器上未能读取（可能路径不在 Hub 主机、权限不足、文件不存在或不是文本文件）。请在回答里直接说明读取失败的路径与原因，并建议主人：① 用输入框的「附件」按钮上传文件；② 或把文件放到 Hub 所在机器上再发一次路径。',
    '',
    ...list.map((item) => `- ${item}`),
  ].join('\n');
}

/** 组装模型调用参数：system + user（上下文 + 执行授权 + 附件 + 最近历史 + 本轮消息）。 */
function buildBrainstormPrompt({
  history = [],
  userMessage,
  context,
  attachments = [],
  attachmentErrors = [],
  autonomy = false,
} = {}) {
  const parts = [];
  const contextText = renderContext(context);
  if (contextText) parts.push(`## 管家上下文\n${contextText}`);
  parts.push([
    '## 执行授权',
    autonomy
      ? '已授权：主人明确说过这类任务由你直接创建，本轮可以按规则 8 输出 actions 块，Hub 会真的建任务并按主设备派发。'
      : '未授权：本轮不要输出 actions 块，只给建议；主人点「转成任务」才会建任务。',
  ].join('\n'));
  const attachmentText = renderAttachments(attachments);
  if (attachmentText) parts.push(attachmentText);
  const errorText = renderAttachmentErrors(attachmentErrors);
  if (errorText) parts.push(errorText);
  const recent = (Array.isArray(history) ? history : [])
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .slice(-HISTORY_LIMIT)
    .map((message) => {
      const attachmentNote = Array.isArray(message.attachments) && message.attachments.length
        ? `（附件：${message.attachments.map((item) => item.name).join('、')}）`
        : '';
      return `${message.role === 'user' ? '主人' : '大脑'}：${util.truncate(message.text, 1200)}${attachmentNote}`;
    });
  if (recent.length) parts.push(`## 最近对话\n${recent.join('\n')}`);
  parts.push(`## 本轮消息\n${util.str(userMessage, MAX_TEXT)}`);
  return {
    system: BRAINSTORM_SYSTEM_PROMPT,
    user: util.truncate(parts.join('\n\n'), MAX_CONTEXT + MAX_TEXT + MAX_TOTAL_CHARS + 4000),
  };
}

/**
 * 头脑风暴模型配置；支持独立覆盖，优先于自主大脑配置。
 *
 * 环境变量（均为可选）：
 * - BRAINSTORM_API_KEY / BRAINSTORM_BASE_URL / BRAINSTORM_MODEL：仅头脑风暴
 * - DEEPSEEK_API_KEY：自动切换 DeepSeek（brainstorm 与自主大脑共用）
 * - BRAIN_* / AGNES_*：两者共用（原有配置）
 */
function brainstormModelConfig(overrides) {
  const env = process.env;
  const src = util.isPlainObject(overrides) ? { ...overrides } : {};
  if (!src.apiKey) src.apiKey = util.str(env.BRAINSTORM_API_KEY, 300).trim();
  if (!src.baseUrl) src.baseUrl = util.str(env.BRAINSTORM_BASE_URL, 300).trim();
  if (!src.model) src.model = util.str(env.BRAINSTORM_MODEL, 120).trim();
  return brainModelConfig(src);
}

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEEPSEEK_MODEL = 'deepseek-chat';

/**
 * 读文件专用模型配置：只要配置了 DEEPSEEK_API_KEY 就用 DeepSeek。
 *
 * 可用 BRAINSTORM_FILE_MODEL / BRAINSTORM_FILE_BASE_URL / BRAINSTORM_FILE_API_KEY
 * 单独覆盖「文件模式」的模型（默认 deepseek-chat）；未配置 key 时返回 null。
 */
function brainstormFileModelConfig(overrides = {}) {
  const env = process.env;
  const src = util.isPlainObject(overrides) ? overrides : {};
  const apiKey = util.str(src.apiKey, 300).trim()
    || util.str(env.BRAINSTORM_FILE_API_KEY, 300).trim()
    || util.str(env.DEEPSEEK_API_KEY, 300).trim();
  if (!apiKey) return null;
  const model = util.str(src.model, 120).trim()
    || util.str(env.BRAINSTORM_FILE_MODEL, 120).trim()
    || util.str(env.DEEPSEEK_MODEL, 120).trim()
    || DEEPSEEK_MODEL;
  const baseUrl = (
    util.str(src.baseUrl, 300).trim()
    || util.str(env.BRAINSTORM_FILE_BASE_URL, 300).trim()
    || DEEPSEEK_BASE_URL
  ).replace(/\/+$/, '');
  const rawTimeout = src.timeoutMs !== undefined ? src.timeoutMs : env.BRAIN_TIMEOUT_MS;
  const timeoutNumber = Number(rawTimeout);
  const timeoutMs =
    rawTimeout === undefined || rawTimeout === null || rawTimeout === '' || !Number.isFinite(timeoutNumber)
      ? 60000
      : util.clampInt(timeoutNumber, 60000, 5000, 300000);
  return { apiKey, baseUrl, model, timeoutMs, provider: 'deepseek' };
}

/**
 * 选择本轮头脑风暴使用的模型。
 *
 * - 普通对话：沿用默认配置（配了 Agnes key 就用 Agnes）；
 * - 本轮涉及文件（显式附件或消息里提到文件路径）：切到 DeepSeek 读取与回答，
 *   未配置 DEEPSEEK_API_KEY 时回退默认模型（附件内容仍会注入，模型可自行解释）。
 */
function selectBrainstormModel({ fileMode = false, overrides = {} } = {}) {
  const base = brainstormModelConfig(overrides);
  const fallback = {
    ...base,
    provider: /api\.deepseek\.com/i.test(base.baseUrl) ? 'deepseek' : 'default',
  };
  if (!fileMode) return fallback;
  return brainstormFileModelConfig(overrides) || fallback;
}

function createBrainstormThinker(overrides = {}) {
  const config = brainstormModelConfig(overrides);
  return createBrainThinker({
    model: config.model,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
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
  MAX_ATTACHMENTS,
  MAX_ACTIONS,
  MAX_ACTION_INSTRUCTION,
  BRAINSTORM_ACTIONS,
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
  normalizeActionRecords,
  normalizeAttachmentInputs,
  normalizeAttachmentMeta,
  normalizeBrainstormActions,
  normalizeChatRequest,
  normalizeSession,
  renderAttachments,
  renderContext,
  restoreBrainstorm,
  selectBrainstormModel,
  sessionSummary,
  splitBrainstormActionBlock,
  titleFromText,
};
