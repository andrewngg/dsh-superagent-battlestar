'use strict';

/**
 * 自主大脑（Autonomous Brain）。
 *
 * Hub 内置的定时 Agent：读取目标 / 任务 / 设备 / 待确认状态，调用 LLM 决策，
 * 并按白名单执行最小动作（重试、续做、建任务、关联目标），把每次决策记录在案，
 * 控制台“自主大脑”卡片与抽屉里可见。
 *
 * 本模块的纯函数（归一化 / 提示构建 / 解析 / 记录）不依赖 Hub 实例，便于单测；
 * createBrainThinker 负责 OpenAI 兼容的 chat/completions 调用。
 */

const protocol = require('../../shared/protocol.js');
const util = require('./util');
const { MAX_SKILL_CHARS, MAX_SOUL_CHARS } = require('./soul');

const BRAIN_MODES = ['auto', 'suggest'];
const BRAIN_ACTIONS = [
  'retry_task',
  'resume_thread',
  'create_task',
  'update_task',
  'link_task',
  'consult_worker',
  'remember',
  'none',
];
const MAX_DECISIONS = 30;
const MAX_ACTIONS_PER_DECISION = 3;
/** auto 模式下置信度低于该值的动作只记录不执行。 */
const MIN_AUTO_CONFIDENCE = 0.6;
const MIN_INTERVAL_SEC = 60;
const MAX_INTERVAL_SEC = 3600;
const DEFAULT_INTERVAL_SEC = 180;
const DEFAULT_MAX_ACTIONS = 2;
/** 自适应节律的空闲下限上限：连续没活时至少可以拉长到 30 分钟一次。 */
const MAX_IDLE_SEC = 1800;
/** 空闲退避最多放大到基准间隔的 4 倍（再受 MAX_BACKOFF_SEC 约束）。 */
const MAX_IDLE_MULTIPLIER = 4;
/** 退避硬上限：连续没活/连续失败时最多 6 小时思考一次。 */
const MAX_BACKOFF_SEC = 6 * 3600;
/** 连续失败计数封顶（到顶后按最长退避重试）。 */
const MAX_FAILURE_STREAK = 6;
const MAX_ASSESSMENT_LENGTH = 400;
const MAX_OWNER_ASK_LENGTH = 500;
/** 通知栏可点选项：最多 4 个，每个标签 40 字（Android 通知栏最多放 3 个动作按钮，多余的在页面里展示）。 */
const MAX_OWNER_ASK_OPTIONS = 4;
const MAX_OWNER_OPTION_LABEL = 40;
/** 每个选项的细节说明（做什么、代价、成功/失败后果），让主人不翻历史也能选。 */
const MAX_OWNER_OPTION_DETAIL = 240;
/** 主人自由文本回复的长度上限（选项之外的补充说明）。 */
const MAX_OWNER_REPLY_LENGTH = 1000;
/** 咨询 worker：问题与保存的回答长度、保留条数（跨轮上下文）。 */
const MAX_CONSULT_QUESTION = 600;
const MAX_CONSULT_ANSWER = 800;
const MAX_CONSULTATIONS = 20;
/** 管家记忆：单条 ≤400 字，最多保留 20 条（长期上下文，每轮注入提示词）。 */
const MAX_NOTE_LENGTH = 400;
const MAX_NOTES = 20;
const MAX_SUMMARY_LENGTH = 1200;
const MAX_INSTRUCTION_LENGTH = 2000;
const MAX_REASON_LENGTH = 500;
const MAX_MODEL_LENGTH = 120;
/**
 * 单次思考的输出上限。六步 assessment 加上动作说明（尤其 create_task 的长 instruction）
 * 很容易超过 2000 tokens；一旦被截断，模型返回的 JSON 就不完整，只能丢弃整轮思考。
 * 默认放宽到 4000，可用 BRAIN_MAX_TOKENS 覆盖（1000–8000）。
 */
const DEFAULT_MAX_COMPLETION_TOKENS = 4000;
const MIN_MAX_COMPLETION_TOKENS = 1000;
const MAX_MAX_COMPLETION_TOKENS = 8000;

/** 六步思考协议的字段（顺序即思考顺序）。 */
const BRAIN_ASSESSMENT_KEYS = ['goals', 'progress', 'betterWay', 'improvement', 'myMove', 'ownerAsk'];

const DEFAULT_BRAIN = Object.freeze({
  enabled: true,
  mode: 'auto',
  intervalSec: DEFAULT_INTERVAL_SEC,
  maxActions: DEFAULT_MAX_ACTIONS,
  model: null,
  // 自适应节律：没活时自动拉长间隔，省掉无意义的模型调用。
  adaptive: true,
  idleStreak: 0,
  effectiveIntervalSec: DEFAULT_INTERVAL_SEC,
  nextThinkAt: null,
  skippedCycles: 0,
  /** 连续思考失败次数：用于失败退避，成功一次即清零。 */
  consecutiveFailures: 0,
  lastThinkAt: null,
  lastError: null,
  lastSummary: '',
  lastAssessment: null,
  ownerAsk: null,
  /** 主人对上一次 ownerAsk 的选择；下一轮思考会带上并在成功后清空。 */
  ownerReply: null,
  /**
   * 咨询 worker 的记录（持久化）：{at, taskId, deviceId, deviceName, project, question, answer, ok}。
   * 回答会进入下一轮提示词的「咨询记录」，让大脑知道该问题已经有答案、不必再问。
   */
  consultations: [],
  /** 管家长期记忆（持久化）：{at, text}，每轮注入提示词「管家记忆」。 */
  notes: [],
  decisions: [],
});

class BrainError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BrainError';
    this.statusCode = 502;
  }
}

function cloneDefault() {
  return {
    ...DEFAULT_BRAIN,
    decisions: [],
    consultations: [],
    notes: [],
  };
}

/**
 * 归一化大脑设置补丁（PATCH 语义，只校验出现的字段）。
 * @param {unknown} patch
 * @param {{intervalSec?:number}} [base]
 * @returns {{ok:true, value:object}|{ok:false, errors:string[]}}
 */
function normalizeBrainPatch(patch, base = DEFAULT_BRAIN) {
  const src = util.isPlainObject(patch) ? patch : {};
  const prev = util.isPlainObject(base) ? base : DEFAULT_BRAIN;
  const errors = [];
  const value = {};
  if (src.enabled !== undefined) {
    if (typeof src.enabled !== 'boolean') errors.push('enabled 必须是布尔值');
    else value.enabled = src.enabled;
  }
  if (src.mode !== undefined) {
    if (!BRAIN_MODES.includes(src.mode)) {
      errors.push(`mode 必须是 ${BRAIN_MODES.join(' / ')}`);
    } else {
      value.mode = src.mode;
    }
  }
  if (src.intervalSec !== undefined) {
    const seconds = Number(src.intervalSec);
    if (!Number.isFinite(seconds) || seconds < MIN_INTERVAL_SEC || seconds > MAX_INTERVAL_SEC) {
      errors.push(`思考间隔必须在 ${MIN_INTERVAL_SEC}~${MAX_INTERVAL_SEC} 秒之间`);
    } else {
      value.intervalSec = Math.trunc(seconds);
    }
  }
  if (src.maxActions !== undefined) {
    const max = Number(src.maxActions);
    if (!Number.isFinite(max) || max < 1 || max > MAX_ACTIONS_PER_DECISION) {
      errors.push(`每轮最多动作数必须在 1~${MAX_ACTIONS_PER_DECISION} 之间`);
    } else {
      value.maxActions = Math.trunc(max);
    }
  }
  if (src.model !== undefined) {
    if (src.model === null) {
      value.model = null;
    } else {
      const model = util.str(src.model, MAX_MODEL_LENGTH).trim();
      value.model = model || null;
    }
  }
  if (src.adaptive !== undefined) {
    if (typeof src.adaptive !== 'boolean') errors.push('adaptive 必须是布尔值');
    else value.adaptive = src.adaptive;
  }
  if (src.ownerAskAck !== undefined) {
    if (typeof src.ownerAskAck !== 'boolean') errors.push('ownerAskAck 必须是布尔值');
    else if (src.ownerAskAck) value.ownerAskAck = true;
  }
  if (errors.length) return { ok: false, errors };
  // 未提供任何可识别字段时也保持幂等。
  void prev;
  return { ok: true, value };
}

function normalizeActions(raw) {
  if (!Array.isArray(raw)) return [];
  const actions = [];
  for (const item of raw) {
    if (!util.isPlainObject(item)) continue;
    const action = typeof item.action === 'string' ? item.action.trim() : '';
    if (!BRAIN_ACTIONS.includes(action)) continue;
    const confidence = Number(item.confidence);
    // create_task 可指定超时与路由要求：多步文件/分析任务默认 300s 往往不够，
    // 且 requirements 能避免把纯文件任务派到手机或纯 ComfyUI 设备。
    const rawTimeout = Number(item.timeoutSec);
    const timeoutSec = Number.isFinite(rawTimeout)
      ? util.clampInt(rawTimeout, 600, 60, 3600)
      : null;
    const requirements = util.isPlainObject(item.requirements)
      ? protocol.normalizeRequirements(item.requirements)
      : null;
    actions.push({
      action,
      taskId: util.str(item.taskId, 80) || null,
      goalId: util.str(item.goalId, 80) || null,
      instruction: util.str(item.instruction, MAX_INSTRUCTION_LENGTH).trim(),
      reason: util.str(item.reason, MAX_REASON_LENGTH).trim(),
      // consult_worker 用 question 向设备提问；remember 用 note 写长期记忆。
      question: util.str(item.question, MAX_CONSULT_QUESTION).trim(),
      note: util.str(item.note, MAX_NOTE_LENGTH).trim(),
      timeoutSec,
      requirements,
      confidence: Number.isFinite(confidence)
        ? Math.min(1, Math.max(0, confidence))
        : 0.6,
    });
    if (actions.length >= MAX_ACTIONS_PER_DECISION) break;
  }
  return actions;
}

/** 容错恢复「咨询 worker」记录（最多 20 条，旧的非法条目直接丢弃）。 */
function normalizeBrainConsultations(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => util.isPlainObject(item) && (item.question || item.answer))
    .slice(-MAX_CONSULTATIONS)
    .map((item) => ({
      at: util.str(item.at, 40) || null,
      taskId: util.str(item.taskId, 80) || null,
      deviceId: util.str(item.deviceId, 80) || null,
      deviceName: util.str(item.deviceName, 120) || null,
      project: util.str(item.project, 120) || null,
      question: util.str(item.question, MAX_CONSULT_QUESTION) || '',
      answer: util.str(item.answer, MAX_CONSULT_ANSWER) || '',
      ok: item.ok === true,
    }));
}

/** 容错恢复「管家记忆」（最多 20 条）。 */
function normalizeBrainNotes(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => util.isPlainObject(item) && util.str(item.text, MAX_NOTE_LENGTH).trim())
    .slice(-MAX_NOTES)
    .map((item) => ({
      at: util.str(item.at, 40) || null,
      text: util.str(item.text, MAX_NOTE_LENGTH).trim(),
    }));
}

/** 恢复持久化的大脑状态（容错：非法值回退默认值；running 标记不恢复）。 */
function restoreBrain(raw) {
  const src = util.isPlainObject(raw) ? raw : {};
  const brain = cloneDefault();
  brain.enabled = src.enabled === false ? false : src.enabled === true ? true : DEFAULT_BRAIN.enabled;
  brain.mode = BRAIN_MODES.includes(src.mode) ? src.mode : DEFAULT_BRAIN.mode;
  const intervalSec = Number(src.intervalSec);
  brain.intervalSec = Number.isFinite(intervalSec)
    ? util.clampInt(intervalSec, DEFAULT_INTERVAL_SEC, MIN_INTERVAL_SEC, MAX_INTERVAL_SEC)
    : DEFAULT_INTERVAL_SEC;
  const maxActions = Number(src.maxActions);
  brain.maxActions = Number.isFinite(maxActions)
    ? util.clampInt(maxActions, DEFAULT_MAX_ACTIONS, 1, MAX_ACTIONS_PER_DECISION)
    : DEFAULT_MAX_ACTIONS;
  brain.model = src.model === null || src.model === undefined
    ? null
    : (util.str(src.model, MAX_MODEL_LENGTH).trim() || null);
  brain.lastThinkAt = typeof src.lastThinkAt === 'string' ? src.lastThinkAt : null;
  brain.lastError = src.lastError ? util.str(src.lastError, 2000) : null;
  brain.lastSummary = util.str(src.lastSummary, MAX_SUMMARY_LENGTH) || '';
  brain.adaptive = src.adaptive === false ? false : true;
  brain.idleStreak = util.clampInt(Number(src.idleStreak), 0, 0, 20);
  const effective = Number(src.effectiveIntervalSec);
  brain.effectiveIntervalSec = Number.isFinite(effective)
    ? util.clampInt(effective, brain.intervalSec, brain.intervalSec, idleIntervalCapSec(brain.intervalSec))
    : brain.intervalSec;
  brain.nextThinkAt = typeof src.nextThinkAt === 'string' ? src.nextThinkAt : null;
  brain.skippedCycles = util.clampInt(Number(src.skippedCycles), 0, 0, 1000);
  brain.consecutiveFailures = util.clampInt(Number(src.consecutiveFailures), 0, 0, MAX_FAILURE_STREAK);
  brain.lastAssessment = normalizeAssessment(src.lastAssessment);
  brain.ownerAsk = normalizeOwnerAsk(src.ownerAsk);
  brain.ownerReply = normalizeOwnerReply(src.ownerReply);
  brain.consultations = normalizeBrainConsultations(src.consultations);
  brain.notes = normalizeBrainNotes(src.notes);
  const decisions = Array.isArray(src.decisions) ? src.decisions : [];
  brain.decisions = decisions
    .filter((item) => util.isPlainObject(item)
      && (item.at || item.summary || item.assessment || item.ownerAsk || item.decisions))
    .slice(-MAX_DECISIONS)
    .map((item) => ({
      id: util.str(item.id, 80) || protocol.randomId('brain'),
      at: util.str(item.at, 40) || protocol.nowIso(),
      trigger: util.str(item.trigger, 40) || 'schedule',
      mode: BRAIN_MODES.includes(item.mode) ? item.mode : brain.mode,
      model: util.str(item.model, MAX_MODEL_LENGTH) || null,
      durationMs: util.clampInt(item.durationMs, 0, 0, 600000),
      summary: util.str(item.summary, MAX_SUMMARY_LENGTH) || '',
      assessment: normalizeAssessment(item.assessment),
      ownerAsk: normalizeOwnerAsk(item.ownerAsk),
      actions: Array.isArray(item.actions) ? normalizeDecisionActionRecords(item.actions) : [],
      error: item.error ? util.str(item.error, 2000) : null,
    }));
  return brain;
}

/**
 * 归一化六步思考结论；全空时返回 null。
 * @param {unknown} raw
 * @returns {object|null}
 */
function normalizeAssessment(raw) {
  if (!util.isPlainObject(raw)) return null;
  const assessment = {};
  let hasValue = false;
  for (const key of BRAIN_ASSESSMENT_KEYS) {
    // ownerAsk 允许对象 {text, options}：六步结论里只保留文本，选项另外解析。
    const source = key === 'ownerAsk' && util.isPlainObject(raw[key])
      ? raw[key].text
      : raw[key];
    const text = clampText(source || '', MAX_ASSESSMENT_LENGTH);
    assessment[key] = text;
    if (text) hasValue = true;
  }
  return hasValue ? assessment : null;
}

/**
 * 归一化「需要主人」提醒：接受字符串或 {text, at, goalId, options}。
 * options 可以是字符串数组或 {label} 对象数组；归一化后带稳定 id（o1..o4），
 * 供手机通知栏的动作按钮与 /api/brain/owner-ask/choose 使用。
 * @param {unknown} raw
 * @returns {{text:string, at:string, goalId:string|null, options:object[]|null}|null}
 */
function normalizeOwnerAsk(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    const text = clampText(raw, MAX_OWNER_ASK_LENGTH);
    return text ? { text, at: protocol.nowIso(), goalId: null, options: null } : null;
  }
  if (!util.isPlainObject(raw)) return null;
  const text = clampText(raw.text || '', MAX_OWNER_ASK_LENGTH);
  if (!text) return null;
  return {
    text,
    at: util.str(raw.at, 40) || protocol.nowIso(),
    goalId: util.str(raw.goalId, 80) || null,
    options: normalizeOwnerOptions(raw.options),
  };
}

/**
 * 归一化通知栏选项：至少 2 个、最多 {@link MAX_OWNER_ASK_OPTIONS} 个；标签去重。
 * 每个选项可带 detail（细节说明），旧数据只有标签时 detail 为空字符串。
 * @param {unknown} raw
 * @returns {Array<{id:string,label:string,detail:string}>|null}
 */
function normalizeOwnerOptions(raw) {
  if (!Array.isArray(raw)) return null;
  const options = [];
  const seen = new Set();
  for (const item of raw) {
    const label = util.str(
      typeof item === 'string' ? item : (util.isPlainObject(item) ? (item.label || item.text) : ''),
      MAX_OWNER_OPTION_LABEL,
    ).trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    const detail = util.isPlainObject(item)
      ? util.str(item.detail || item.details || item.desc || item.consequence || '', MAX_OWNER_OPTION_DETAIL).trim()
      : '';
    options.push({ id: `o${options.length + 1}`, label, detail });
    if (options.length >= MAX_OWNER_ASK_OPTIONS) break;
  }
  return options.length >= 2 ? options : null;
}

/**
 * 归一化主人回复：两种形态。
 * - 选项：{optionId, label, question, at, goalId}（手机通知栏/选项按钮）。
 * - 自由文本：{text, question, at, goalId}，optionId 为 null，label 取文本前 40 字做摘要。
 * @param {unknown} raw
 * @returns {{optionId:string|null, label:string, text:string, question:string, at:string, goalId:string|null}|null}
 */
function normalizeOwnerReply(raw) {
  if (!util.isPlainObject(raw)) return null;
  const optionId = util.str(raw.optionId, 40).trim();
  const text = clampText(raw.text || '', MAX_OWNER_REPLY_LENGTH);
  const label = util.str(raw.label, MAX_OWNER_OPTION_LABEL).trim();
  // 二者必须有其一：选了选项，或者写了文字回复。
  if (!optionId && !text) return null;
  if (optionId && !label) return null;
  return {
    optionId: optionId || null,
    label: optionId ? label : clampText(text, MAX_OWNER_OPTION_LABEL),
    text: text || '',
    question: clampText(raw.question || '', MAX_OWNER_ASK_LENGTH),
    at: util.str(raw.at, 40) || protocol.nowIso(),
    goalId: util.str(raw.goalId, 80) || null,
  };
}

function normalizeDecisionActionRecords(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(util.isPlainObject)
    .slice(0, MAX_ACTIONS_PER_DECISION)
    .map((item) => ({
      action: util.str(item.action, 40) || 'none',
      taskId: util.str(item.taskId, 80) || null,
      goalId: util.str(item.goalId, 80) || null,
      instruction: util.str(item.instruction, MAX_INSTRUCTION_LENGTH) || '',
      reason: util.str(item.reason, MAX_REASON_LENGTH) || '',
      confidence: Number.isFinite(Number(item.confidence))
        ? Math.min(1, Math.max(0, Number(item.confidence)))
        : 0,
      executed: item.executed === true,
      skippedReason: util.str(item.skippedReason, 200) || null,
      error: item.error ? util.str(item.error, 2000) : null,
      // 记录里保留 create_task 的超时/路由要求，便于复盘“为什么派到了某台设备”。
      ...(Number.isFinite(Number(item.timeoutSec)) && item.timeoutSec !== null
        ? { timeoutSec: util.clampInt(Number(item.timeoutSec), 600, 60, 3600) }
        : {}),
      ...(util.isPlainObject(item.requirements) ? { requirements: { ...item.requirements } } : {}),
    }));
}

/**
 * 计算下一次思考时间：优先使用显式 nextThinkAt（Hub 按自适应节律排期），
 * 否则回退到 lastThinkAt + 实际间隔。
 */
function computeNextThinkAt(brain, { nowMs = Date.now(), enabled } = {}) {
  const isEnabled = enabled === undefined ? brain.enabled : enabled === true;
  if (!isEnabled) return null;
  const explicit = Date.parse(brain.nextThinkAt || '');
  if (Number.isFinite(explicit)) return new Date(explicit).toISOString();
  const base = Date.parse(brain.lastThinkAt || '');
  if (!Number.isFinite(base)) return new Date(nowMs).toISOString();
  const interval = effectiveIntervalSec(brain);
  return new Date(base + interval * 1000).toISOString();
}

/**
 * 空闲/失败退避的上限（秒）：至少 30 分钟，最多基准间隔的 4 倍，且不超过 6 小时。
 * 这样基准间隔较大（如 1800s）时退避才真正生效，而不是被 MAX_IDLE_SEC 卡住。
 */
function idleIntervalCapSec(intervalSec) {
  const base = Number.isFinite(Number(intervalSec))
    ? Math.max(MIN_INTERVAL_SEC, Math.trunc(Number(intervalSec)))
    : DEFAULT_INTERVAL_SEC;
  return Math.min(Math.max(MAX_IDLE_SEC, base * MAX_IDLE_MULTIPLIER), MAX_BACKOFF_SEC);
}

/** 当前使用的思考间隔（秒）：自适应时取 effectiveIntervalSec。 */
function effectiveIntervalSec(brain) {
  const base = brain && brain.intervalSec ? brain.intervalSec : DEFAULT_INTERVAL_SEC;
  if (!brain || brain.adaptive === false) return base;
  const effective = Number(brain.effectiveIntervalSec);
  if (!Number.isFinite(effective)) return base;
  return Math.min(Math.max(effective, base), idleIntervalCapSec(base));
}

/** 对外 JSON（不含 thinking；Hub 的 getBrain 会补上运行态字段）。 */
function brainToJson(brain, { decisions = 10, nowMs = Date.now() } = {}) {
  const safeDecisions = Math.max(0, Math.min(MAX_DECISIONS, Math.trunc(Number(decisions)) || 0));
  const list = Array.isArray(brain.decisions) ? brain.decisions : [];
  // 注意 slice(-0) 会返回整个数组，decisions<=0 时必须显式返回空列表。
  const picked = safeDecisions > 0 ? list.slice(-safeDecisions) : [];
  return {
    enabled: brain.enabled !== false,
    mode: BRAIN_MODES.includes(brain.mode) ? brain.mode : DEFAULT_BRAIN.mode,
    intervalSec: brain.intervalSec,
    maxActions: brain.maxActions,
    model: brain.model || null,
    adaptive: brain.adaptive !== false,
    effectiveIntervalSec: effectiveIntervalSec(brain),
    idleStreak: util.clampInt(Number(brain.idleStreak), 0, 0, 20),
    skippedCycles: util.clampInt(Number(brain.skippedCycles), 0, 0, 1000),
    consecutiveFailures: util.clampInt(Number(brain.consecutiveFailures), 0, 0, MAX_FAILURE_STREAK),
    /** 空闲退避能达到的最长间隔（秒），供控制台展示。 */
    idleLimitSec: idleIntervalCapSec(brain.intervalSec),
    lastThinkAt: brain.lastThinkAt || null,
    nextThinkAt: computeNextThinkAt(brain, { nowMs }),
    lastError: brain.lastError || null,
    lastSummary: brain.lastSummary || '',
    lastAssessment: brain.lastAssessment ? JSON.parse(JSON.stringify(brain.lastAssessment)) : null,
    ownerAsk: brain.ownerAsk ? JSON.parse(JSON.stringify(brain.ownerAsk)) : null,
    ownerReply: brain.ownerReply ? JSON.parse(JSON.stringify(brain.ownerReply)) : null,
    consultations: util.arr(brain.consultations).slice(-MAX_CONSULTATIONS).map((item) => JSON.parse(JSON.stringify(item))),
    notes: util.arr(brain.notes).slice(-MAX_NOTES).map((item) => JSON.parse(JSON.stringify(item))),
    configured: brainConfigured({ model: brain.model }),
    decisions: picked.map((item) => JSON.parse(JSON.stringify(item))),
  };
}

/** 记录一次决策，裁剪到上限。 */
function recordBrainDecision(brain, decision) {
  if (!brain || !Array.isArray(brain.decisions) || !decision) return null;
  brain.decisions.push(decision);
  if (brain.decisions.length > MAX_DECISIONS) {
    brain.decisions.splice(0, brain.decisions.length - MAX_DECISIONS);
  }
  return decision;
}

function clampText(value, max) {
  const text = util.str(value, max);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 把任务集合压缩成一句子任务进度描述（用于提示词）。 */
function planProgressText(task, tasksById) {
  const ids = Array.isArray(task.childTaskIds) ? task.childTaskIds : [];
  if (!ids.length) return null;
  const children = ids.map((id) => tasksById.get(id)).filter(Boolean);
  const completed = children.filter((child) => child.status === 'completed').length;
  const failed = children.filter((child) => ['failed', 'timeout', 'cancelled'].includes(child.status)).length;
  const running = children.filter((child) => ['assigned', 'running', 'waiting'].includes(child.status)).length;
  return `${completed}/${children.length} 完成${failed ? `，${failed} 失败` : ''}${running ? `，${running} 进行中` : ''}`;
}

/** 把时间点渲染成相对时长（给模型判断“卡了多久”用）。 */
function formatAge(iso, nowMs) {
  const at = Date.parse(iso || '');
  if (!Number.isFinite(at)) return null;
  const diff = Math.max(0, nowMs - at);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/**
 * 构建大脑提示词。
 * @param {object} snapshot 由 Hub._brainSnapshot() 生成（见字段说明）
 * @param {{mind?:{soul?:string,skill?:string}, maxActions?:number}} [options] 心智 / 本轮动作上限
 * @returns {{system:string, user:string}}
 */
function buildBrainPrompt(snapshot, options = {}) {
  const snap = util.isPlainObject(snapshot) ? snapshot : {};
  const mind = util.isPlainObject(options) && util.isPlainObject(options.mind) ? options.mind : {};
  const maxActions = util.clampInt(
    util.isPlainObject(options) && options.maxActions !== undefined ? options.maxActions : DEFAULT_MAX_ACTIONS,
    DEFAULT_MAX_ACTIONS,
    1,
    MAX_ACTIONS_PER_DECISION,
  );
  const nowMs = Date.parse(snap.now || '') || Date.now();
  const soul = clampText(mind.soul || '', MAX_SOUL_CHARS).trim();
  const skill = clampText(mind.skill || '', MAX_SKILL_CHARS).trim();
  const mindLines = [];
  if (soul) mindLines.push('## 你的灵魂（个性与价值观）', soul);
  if (skill) mindLines.push('## 你的工作方法（思考与行动流程）', skill);
  if (mindLines.length) {
    mindLines.push('先按上面的灵魂与工作方法推进判断，再把它压缩进六步 assessment；输出仍然必须是下面的严格 JSON 结构。');
  }
  const system = [
    '你是 BattleStar（对战星）的自主管家大脑，负责在用户不在时推动长期目标与任务继续前进。',
    '你只能输出严格 JSON，不要输出 Markdown 代码围栏以外的解释。',
    '每次思考必须按六步走：1) 现在有什么目标 2) 进度在哪里 3) 有什么更好的工作方式 4) 我需要改进哪里 5) 我可以做什么推进进度 6) 是否需要提醒主人做什么、主人参与哪部分能加速。',
    'JSON 结构：{"assessment":{"goals":"现在有什么目标","progress":"进度在哪里","betterWay":"有什么更好的工作方式","improvement":"我需要改进哪里","myMove":"我可以做什么推进进度","ownerAsk":"需要主人做什么，没有就留空字符串；需要主人在几个方案里选时写成 {\\"text\\":\\"问题背景（发生了什么、为什么需要主人拍板）\\",\\"options\\":[{\\"label\\":\\"选项A（≤20字）\\",\\"detail\\":\\"这个选项具体做什么、大概要多久/多少代价、成功或失败分别会怎样（≤100字）\\"},{\\"label\\":\\"选项B\\",\\"detail\\":\\"...\\"}]}（2–4 个互斥选项，会显示成按钮和说明）"},"summary":"一句话结论","actions":[{"action":"retry_task|resume_thread|create_task|update_task|link_task|consult_worker|remember|none","taskId":"可空","goalId":"可空","instruction":"可空，仅 resume_thread/create_task 使用","reason":"为什么这么做","confidence":0.0,"timeoutSec":"可空，仅 create_task/consult_worker 使用，60–3600 秒","question":"可空，仅 consult_worker 使用：向设备提出的只读问题","note":"可空，仅 remember 使用：要长期记住的上下文","requirements":"可空，仅 create_task/update_task/consult_worker 使用：{skills:[],project,deviceId,model,tags}"}]}',
    '动作含义：retry_task 只重试 failed/timeout/cancelled 且有剩余次数的任务（可解开计划卡点）；已完成(completed)的任务想再做，用 resume_thread 说明下一步；resume_thread 对已结束但还需要下一步的任务创建跟进（instruction 写下一步）；create_task 新建任务（只在确有新工作且没有重复任务时）；link_task 把已有任务关联到目标；consult_worker 向指定设备提一个只读问题（需要 requirements.deviceId），系统创建咨询任务并把回答带回下一轮；update_task 修改排队中任务的需求（taskId + requirements/priority/timeoutSec，改完系统会立即重新派发，用来补上任务缺的能力/设备）；remember 把长期有用的上下文写入「管家记忆」，之后每轮都会看到。',
    'create_task 的任务默认 600 秒；涉及多步读写文件、代码分析、打包等任务请显式给 timeoutSec（建议 900–1800）。任务需要特定能力时填 requirements：例如纯文件/CLI 任务用 {"skills":[],"deviceId":"主工作机或图像处理机的设备 id"} 或指定 project；不要给日志/代码/文件类任务指定手机或纯 ComfyUI 设备。requirements.tags 是设备能力标签，只能填设备清单里实际出现过的标签（如「本机」「手机」「GPU」）；一般任务不要填 tags，用 project 或 deviceId 定位即可。千万不要用项目名/任务名自造标签（例如「反腐AI」「验证」）——没有任何设备会声明它们，任务会一直排队。任务如果包含「多个仓库 / 发布 / 部署 / 迁移 / 全量验证」等跨阶段工作，拆成 2–3 个 create_task（实现 → 发布或验证），每个任务目标单一、能在 15 分钟内跑完；不要把一段需要 20 分钟以上的工作塞进一个任务，本机 CLI 有硬性执行上限，超时会整单作废。任务必须按主机拆分：python/adb/命令行/脚本/Windows 路径/本机文件等电脑侧步骤派母机；手机 App 界面操作派手机；不要把电脑命令和手机操作混进同一条指令，否则会被系统改派到母机或被拒绝。',
    '队列健康：如果「任务」里有排队超过 2 小时的任务，本轮不要 create_task；先 update_task 补 requirements（deviceId/skills/project）或 retry_task 重派，实在推进不了才考虑取消。',
    '排队中的计划子任务若「依赖」里的前置任务未完成，不要对它 retry（会一直等待）；应先推进前置任务，或选择 none 观察。',
    '六步要求：assessment 六项都要认真填，即使没有变化也要写清结论；ownerAsk 只在确实需要主人做决策/授权/偏好选择/确认方向时填写，否则留空；myMove 要与 actions 一致。',
    'ownerAsk 禁止询问机器可查的事实：文件/目录/脚本/简历的路径、文件是否存在、版本号、密码、设备在线状态、任务 id 等。任务因路径缺失或路径不对而失败时，先看下面的「路径核查」：有候选路径就把候选路径写进自包含的 create_task（指定有文件能力的设备）去处理；确认不存在就创建定位/重规划任务，不要问主人。',
    '输出要精简：assessment 每项尽量 ≤120 字，summary ≤120 字，动作 instruction ≤400 字；避免 JSON 过长被输出上限截断而导致整轮作废。',
    'ownerAsk 带 options 时：2–4 个互斥选项，label ≤20 字且指向明确动作；每个选项必须给 detail：具体做什么、大概多久/什么代价、成功与失败分别会怎样（≤100 字，用人话写，主人要能只看这几行就做决定）；detail 里不要写任务 id、文件路径这类机器细节，也不要写「其他」「你自己决定」。ownerAsk.text 也要自带背景（发生了什么、为什么需要主人拍板），让主人不用翻历史就能判断。同一问题若已在「最近决策」的「当轮提问」里出现过，不要重复问。',
    '如果给不出选项细节（比如还没查清原因），先不要问主人：用 consult_worker 或 create_task 查清楚，下一轮再带着细节问；确实要问时至少把已知事实和不确定点写进 ownerAsk.text。',
    '凡是请主人在几个方案里拍板（例如 A/B/C、要不要继续、选哪个方向），ownerAsk 必须是带 options 的对象，不能只写一段文字问题；只写文字等于让主人无从选择，会被要求重问。',
    '咨询 worker：缺少只有某台设备知道的事实（文件路径、项目目录、环境、设备状态）时，不要问主人，也不要凭空猜——用 consult_worker 向那台设备提问。设备选择顺序：下面「项目 ↔ 主机」映射 > 最近执行该项目的设备 > 母机；requirements.deviceId 必填。问题要简短、只读、可回答（例如「列出 applier.py 的绝对路径和 job_search 项目目录」）；每轮最多 1 个咨询，不要用它代替实际工作，也不要发给手机/纯 ComfyUI 设备。如果问题涉及 python/adb/命令行/Windows 路径/本机文件/版本号，必须选母机（本机），手机只能回答手机 App 界面、通知、文件是否在手机里这类问题。',
    '记住上下文：remember 用来保存长期有用的事实（项目位置、关键约定、上次结论、设备分工），note ≤300 字、一条一个事实；每轮提示词都会带上「管家记忆」，不要重复记同一件事，也不要把临时进度写进来。',
    ...mindLines,
    `保守原则：优先重试/续做/关联已有任务，而不是新建；同一轮最多 ${maxActions} 个动作；没有明确必要时 actions 为空数组；置信度低于 0.6 的动作会被系统拒绝，请如实给出。`,
    '禁止：臆造任务 id / 目标 id / 设备；编造用户没有要求的工作；重复创建已存在的任务；回答问题或执行设备上的具体操作。',
    '如果某个任务在等待用户回答、或需要用户决定方向，不要代替用户决定：actions 用 none，把要确认的内容写进 assessment.ownerAsk 与 summary。',
  ].join('\n');

  const byId = new Map();
  for (const task of util.arr(snap.tasks)) {
    if (task && task.id) byId.set(task.id, task);
  }

  const lines = [];
  lines.push(`当前时间：${snap.now || protocol.nowIso()}`);
  if (snap.stats) {
    lines.push(
      `Hub 概览：设备 ${snap.stats.devicesOnline || 0}/${snap.stats.devicesTotal || 0} 在线；`
        + `任务 排队 ${snap.stats.tasksQueued || 0} / 执行中 ${(snap.stats.tasksRunning || 0) + (snap.stats.tasksWaiting || 0)} / 完成 ${snap.stats.tasksCompleted || 0} / 失败 ${snap.stats.tasksFailed || 0}`,
    );
  }

  const goals = util.arr(snap.goals);
  lines.push(`\n## 长期目标（${goals.length} 个）`);
  if (!goals.length) lines.push('（无）');
  goals.forEach((goal, index) => {
    const scheduleText =
      goal.schedule && goal.schedule.type === 'interval'
        ? `每 ${goal.schedule.minutes} 分钟`
        : `每天 ${goal.schedule && goal.schedule.time ? goal.schedule.time : '09:00'}`;
    const name = goal.nickname || goal.title || goal.id;
    const linked = goal.linkedStats || {};
    lines.push(
      `${index + 1}. ${name}（${goal.id}）｜状态 ${goal.status}｜计划 ${scheduleText}｜下次 ${goal.nextCheckAt || '未排期'}`
        + `｜关联任务 ${linked.total || 0}（完成 ${linked.completed || 0}，进行中 ${(linked.running || 0) + (linked.waiting || 0)}，失败 ${linked.failed || 0}${linked.planTotal ? `，计划 ${linked.planCompleted || 0}/${linked.planTotal}` : ''}）`,
    );
    if (goal.deviceId) {
      const pinned = util.arr(snap.devices).find((device) => device && device.id === goal.deviceId);
      const label = pinned ? (pinned.nickname || pinned.name || pinned.id) : goal.deviceId;
      lines.push(
        `   固定工作机（硬性）：${label}（${goal.deviceId}）——为该目标创建任务时必须把 requirements.deviceId 设为这台设备，不要改用其它设备。`
          + '但如果本步需要电脑侧操作（python/adb/脚本/Windows 文件），不要写进这条手机任务：把电脑侧步骤单独 create_task 派给母机，手机任务只描述手机 App 上的操作。',
      );
    }
    if (goal.lastCheckStatus) lines.push(`   上次跟进：${goal.lastCheckStatus}｜${clampText(goal.lastSummary || '', 300)}`);
    if (goal.runningTaskId) lines.push(`   正在执行的任务：${goal.runningTaskId}`);
    if (goal.pendingApproval) lines.push(`   待用户确认：${clampText(goal.pendingApproval.reason || '', 160)}`);
    const guidance = util.arr(goal.guidance).slice(-3);
    if (guidance.length) {
      for (const entry of guidance) {
        // goals.js 存的指导是 {text, createdAt}；兼容旧的纯字符串。
        const text = entry && typeof entry === 'object' ? entry.text : entry;
        const at = entry && typeof entry === 'object' ? entry.createdAt : null;
        if (!text) continue;
        lines.push(`   用户指导${at ? `（${at}）` : ''}：${clampText(text, 200)}`);
      }
    }
  });

  const tasks = util.arr(snap.tasks);
  lines.push(`\n## 任务（${tasks.length} 条：进行中 / 排队 / 失败 / 等待回答 + 最近完成）`);
  if (!tasks.length) lines.push('（无）');
  tasks.forEach((task, index) => {
    const planText = task.isPlan ? planProgressText(task, byId) : null;
    const ageSource =
      task.status === 'completed'
        ? task.finishedAt || task.updatedAt
        : task.status === 'queued'
          ? task.createdAt
          : task.updatedAt || task.createdAt;
    const ageLabel = task.status === 'completed' ? '完成' : task.status === 'queued' ? '排队' : '更新';
    const age = formatAge(ageSource, nowMs);
    lines.push(
      `${index + 1}. ${task.id}｜${task.status}｜${clampText(task.instruction || '', 200)}`
        + `${task.goalId ? `｜目标 ${task.goalId}` : ''}`
        + `${task.project ? `｜项目 ${task.project}` : ''}`
        + `${task.assignedDeviceName ? `｜设备 ${task.assignedDeviceName}` : ''}`
        + `${task.assignedDeviceId ? `｜设备id ${task.assignedDeviceId}` : ''}`
        + `${task.attempts !== undefined ? `｜尝试 ${task.attempts}/${task.maxAttempts || '?'}` : ''}`
        + `${age ? `｜${ageLabel} ${age}` : ''}`
        + `${planText ? `｜计划 ${planText}` : ''}`
        + `${util.arr(task.dependsOn).length ? `｜依赖 ${util.arr(task.dependsOn).join(',')}` : ''}`,
    );
    if (task.progress && (task.progress.message || task.progress.waiting)) {
      lines.push(`   进度：${clampText(task.progress.message || '', 160)}${task.progress.waiting ? '（等待回答）' : ''}`);
    }
    if (task.error) lines.push(`   错误：${clampText(task.error, 200)}`);
    if (task.lastEvent && task.lastEvent.message) lines.push(`   最近事件：${clampText(task.lastEvent.message, 160)}`);
  });

  // 项目 ↔ 主机：让大脑知道「这个问题该问谁」，而不是回头来问主人。
  const projectHosts = util.arr(snap.projectHosts);
  if (projectHosts.length) {
    lines.push(`\n## 项目 ↔ 主机（${projectHosts.length} 个；缺少项目上下文时优先向这里的设备 consult_worker）`);
    projectHosts.forEach((entry, index) => {
      const label = entry.deviceName || entry.deviceId || '未知设备';
      lines.push(`${index + 1}. ${clampText(entry.project || '', 120)} → ${label}（${entry.deviceId || '?'}）`);
    });
  }

  // 咨询记录：worker 已经回答过的问题，避免大脑重复问同一件事。
  const consultations = util.arr(snap.consultations).slice(-5);
  if (consultations.length) {
    lines.push('\n## 咨询记录（worker 已回答；同一问题不要重复咨询）');
    consultations.forEach((entry, index) => {
      const who = entry.deviceName || entry.deviceId || '设备';
      lines.push(`${index + 1}. 问 ${who}：${clampText(entry.question || '', 200)}${entry.ok ? '' : '（未成功）'}`);
      if (entry.answer) lines.push(`   回答：${clampText(entry.answer, 400)}`);
    });
  }

  // 管家记忆：长期上下文，让大脑跨轮、跨重启都不会忘。
  const notes = util.arr(snap.notes).slice(-8);
  if (notes.length) {
    lines.push('\n## 管家记忆（长期上下文，按需使用，不要重复记录）');
    notes.forEach((entry, index) => lines.push(`${index + 1}. ${clampText(entry.text || '', 300)}`));
  }

  // 路径核查：把任务里提到的文件在 Hub 主机上实测一遍，避免模型凭空判断或反复问主人。
  const pathAudit = util.arr(snap.pathAudit);
  if (pathAudit.length) {
    const host = util.isPlainObject(snap.host) ? snap.host : {};
    const hostLabel = host.user ? `${host.user}@${host.platform || 'unknown'}` : 'Hub 主机';
    lines.push(`\n## 路径核查（在 ${hostLabel} 上实测；其它设备上的路径可能不同）`);
    pathAudit.forEach((entry, index) => {
      const statusText =
        entry && entry.status === 'exists'
          ? '存在'
          : entry && entry.status === 'candidates'
            ? `Hub 主机上该路径不存在，但找到同名文件：${util.arr(entry.paths).slice(0, 3).join('；')}`
            : 'Hub 主机上不存在（可能属于其它设备）';
      const ref = entry && entry.ref ? entry.ref : '（未知文件）';
      lines.push(`${index + 1}. ${clampText(ref, 200)} → ${statusText}`);
    });
    lines.push('路径核查只代表 Hub 主机；设备侧文件请用 create_task 让对应设备自查，不要据此向主人提问。');
  }

  // 决策记忆：把最近几轮结论与失败原因带上，避免模型重复同样的无效动作。

  // 动作命中率（P5）：最近若干轮动作实际执行/跳过的比例与主要跳过原因。
  const statDecisions = util.arr(snap.decisions).slice(0, 12);
  const actionStats = { total: 0, executed: 0, skipped: 0 };
  const skipReasons = new Map();
  for (const decision of statDecisions) {
    for (const action of util.arr(decision && decision.actions)) {
      actionStats.total += 1;
      if (action.executed) {
        actionStats.executed += 1;
        continue;
      }
      actionStats.skipped += 1;
      const reason = clampText(action.skippedReason || action.error || '未执行', 60);
      skipReasons.set(reason, (skipReasons.get(reason) || 0) + 1);
    }
  }
  if (actionStats.total >= 3) {
    const rate = Math.round((actionStats.executed / actionStats.total) * 100);
    const topReasons = [...skipReasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([reason, count]) => `${reason}×${count}`)
      .join('；');
    lines.push(
      `\n## 动作命中率（最近 ${statDecisions.length} 轮，共 ${actionStats.total} 个动作：执行率 ${rate}%）`,
      `跳过 ${actionStats.skipped} 个${topReasons ? `，主要原因：${topReasons}` : ''}。同一类动作反复被跳过/拒绝说明方向不对，下一轮换做法。`,
    );
  }

  const decisions = util.arr(snap.decisions).slice(0, 3);
  lines.push('\n## 最近决策（最新在前，重复以下无效动作会被再次拒绝）');
  if (!decisions.length) lines.push('（无）');
  decisions.forEach((decision, index) => {
    const age = formatAge(decision.at, nowMs);
    const head = [age, decision.summary ? clampText(decision.summary, 120) : ''].filter(Boolean).join('｜');
    lines.push(`${index + 1}. ${head || '（无结论）'}`);
    if (decision.ownerAsk) lines.push(`   当轮提问：${clampText(decision.ownerAsk, 160)}（已问过，除非有全新信息不要重复问）`);
    for (const action of util.arr(decision.actions)) {
      const target = action.taskId ? ` ${action.taskId}` : action.goalId ? ` ${action.goalId}` : '';
      const flag = action.executed
        ? '已执行'
        : action.skippedReason
          ? `跳过：${clampText(action.skippedReason, 60)}`
          : action.error
            ? `失败：${clampText(action.error, 60)}`
            : '未执行';
      lines.push(`   动作 ${action.action}${target} → ${flag}`);
    }
  });

  const approvals = util.arr(snap.approvals);
  if (approvals.length) {
    lines.push(`\n## 待用户确认的跟进提案（${approvals.length} 个）`);
    approvals.forEach((appr, index) => {
      lines.push(`${index + 1}. 目标 ${appr.goalId}（${appr.goalTitle || ''}）：${clampText(appr.reason || '', 160)}`);
    });
  }

  const devices = util.arr(snap.devices);
  lines.push(`\n## 设备（${devices.length} 台）`);
  if (!devices.length) lines.push('（无）');
  devices.forEach((device, index) => {
    lines.push(
      `${index + 1}. ${device.name || device.id}｜${device.kind || ''}｜${device.online ? '在线' : '离线'}｜负载 ${device.load ? `${device.load.running}/${device.load.max}` : '?'}${Array.isArray(device.tags) && device.tags.length ? `｜标签 ${device.tags.join(',')}` : ''}`,
    );
  });

  const ownerReply = util.isPlainObject(snap.ownerReply) ? snap.ownerReply : null;
  if (ownerReply) {
    const age = formatAge(ownerReply.at, nowMs);
    const freeText = clampText(ownerReply.text || '', MAX_OWNER_REPLY_LENGTH);
    if (freeText) {
      // 主人自由输入的回答（可能不是选项之一，例如「先手动补投递」）。
      const replyQuestion = clampText(ownerReply.question || '', 300);
      lines.push('\n## 主人对上次提问的回复');
      if (replyQuestion) lines.push(`${age ? `${age}前｜` : ''}问题：${replyQuestion}`);
      lines.push(`我的回答：${freeText}`);
    } else {
      lines.push('\n## 主人对上次提问的选择');
      lines.push(`${age ? `${age}前｜` : ''}问题：${clampText(ownerReply.question || '', 300)}`);
      lines.push(`选择：${clampText(ownerReply.label || '', MAX_OWNER_OPTION_LABEL)}`);
    }
    lines.push('请基于这个回复继续推进，不要再次询问同一个问题。');
    lines.push('例外：如果主人的回复明确要求「重新问一遍 / 把选项讲清楚 / 给我选项和细节」，就必须重新给出带 2–4 个 options 的 ownerAsk（每个选项带 detail），即使这个问题在「最近决策」里问过，也不算重复提问；这一轮只提问，不做其它动作。');
  }

  lines.push(
    '\n请按六步思考后决策：优先推动与长期目标相关、且已经卡住或接近完成的任务；没有值得执行的动作就返回空数组。',
    '只输出 JSON，例如：{"assessment":{"goals":"目标 A 仍是主线","progress":"计划 2/5 完成，第 3 步失败","betterWay":"先重试失败步骤","improvement":"上次没有及时重试","myMove":"重试 task_x","ownerAsk":""},"summary":"第 3 步失败，重试即可继续","actions":[{"action":"retry_task","taskId":"task_x","reason":"失败步骤卡住后续","confidence":0.8}]}',
  );
  return { system, user: lines.join('\n') };
}

/**
 * 去掉 BOM 与 Markdown 围栏。模型常把 JSON 包在 ```json 里，
 * 偶尔还会漏掉收尾的 ```，所以围栏未闭合时也尽量剥掉开头标记。
 * @param {unknown} text
 * @returns {string}
 */
function stripReplyWrapping(text) {
  let raw = String(text).replace(/^\uFEFF/, '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(raw);
  if (fence) return fence[1].trim();
  const open = /^```(?:json)?\s*/i.exec(raw);
  if (open) raw = raw.slice(open[0].length).replace(/```\s*$/, '').trim();
  return raw;
}

/** 从文本里截出第一个括号配平的 JSON 对象（忽略字符串内的括号）；截断时返回 null。 */
function sliceBalancedObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** 删除字符串外的尾随逗号（`{"a":1,}` / `[1,2,]`）：模型偶尔会这样输出。 */
function stripTrailingCommas(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += ch;
  }
  return out;
}

/**
 * 尽力修复被输出上限截断的 JSON：丢掉最后一个没写完的字段，补上未闭合的字符串与容器。
 * 只用于兜底，修复结果仍需通过 JSON.parse；失败就按原样报错。
 */
function repairTruncatedJson(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  const src = text.slice(start);
  // 找最后一个“完整值边界”（字符串外的逗号或闭合括号）。
  let lastSafe = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === ',' || ch === '}' || ch === ']') lastSafe = i;
  }
  if (lastSafe < 0) return null;
  const body = src.slice(0, src[lastSafe] === ',' ? lastSafe : lastSafe + 1);
  const stack = [];
  inString = false;
  escaped = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let repaired = body;
  if (inString) repaired += '"';
  if (/:\s*$/.test(repaired)) repaired = repaired.replace(/:\s*$/, ':null');
  if (/,\s*$/.test(repaired)) repaired = repaired.replace(/,\s*$/, '');
  for (let i = stack.length - 1; i >= 0; i -= 1) repaired += stack[i];
  return repaired;
}

/** 依次尝试原样 / 去尾逗号 / 截取配平对象 / 修复截断，返回第一个能解析的对象。 */
function tryParseBrainJson(raw) {
  const balanced = sliceBalancedObject(raw);
  const candidates = [raw, stripTrailingCommas(raw), balanced, balanced ? stripTrailingCommas(balanced) : null];
  if (!balanced) {
    const repaired = repairTruncatedJson(raw);
    if (repaired) candidates.push(repaired, stripTrailingCommas(repaired));
  }
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (util.isPlainObject(parsed)) return parsed;
    } catch {
      // 换下一个候选
    }
  }
  return null;
}

/**
 * 解析大脑返回（容忍 ```json 围栏、前后解释文字、尾随逗号与被截断的 JSON）。
 * 六步思考结论放在 assessment；ownerAsk 从 assessment.ownerAsk 提取。
 * @param {unknown} text
 * @returns {{summary:string, actions:object[], assessment:object|null, ownerAsk:object|null}}
 */
function parseBrainReply(text) {
  const raw = typeof text === 'string' ? stripReplyWrapping(text) : '';
  if (!raw) throw new BrainError('大脑返回为空');
  const parsed = tryParseBrainJson(raw);
  if (!parsed) {
    // 把输出开头带进错误里：控制台/日志能直接看出是截断、跑题还是夹带了别的格式。
    const snippet = raw.replace(/\s+/g, ' ').slice(0, 160);
    throw new BrainError(`大脑返回不是合法 JSON（开头：${snippet}${raw.length > 160 ? '…' : ''}）`);
  }
  const summary = clampText(parsed.summary || '', MAX_SUMMARY_LENGTH);
  const actions = normalizeActions(parsed.actions);
  const assessment = normalizeAssessment(parsed.assessment);
  // ownerAsk 可能是字符串，也可能是 {text, options}；从原始 assessment 里取对象保留选项。
  const rawOwner = util.isPlainObject(parsed.assessment) && parsed.assessment.ownerAsk
    ? parsed.assessment.ownerAsk
    : parsed.ownerAsk;
  const ownerAsk = rawOwner ? normalizeOwnerAsk(rawOwner) : null;
  if (!summary && !actions.length && !assessment && !ownerAsk) {
    throw new BrainError('大脑没有给出任何结论或动作');
  }
  return { summary, actions, assessment, ownerAsk };
}

/**
 * 解析模型配置（环境变量 + 覆盖值）。
 *
 * 供应商切换：
 * - 显式 BRAIN_BASE_URL / BRAIN_MODEL（或 AGNES_* 兼容名）优先；
 * - 只配了 DEEPSEEK_API_KEY 时自动使用 DeepSeek（OpenAI 兼容接口）；
 * - 否则沿用默认的 Agnes。
 */
function brainModelConfig(overrides = {}) {
  const src = util.isPlainObject(overrides) ? overrides : {};
  const env = process.env;
  const deepseekKey = util.str(env.DEEPSEEK_API_KEY, 300).trim();
  const explicitModel = util.str(src.model, MAX_MODEL_LENGTH).trim()
    || util.str(env.BRAIN_MODEL, MAX_MODEL_LENGTH).trim()
    || util.str(env.AGNES_MODEL, MAX_MODEL_LENGTH).trim();
  const explicitBaseUrl = util.str(src.baseUrl, 300).trim()
    || util.str(env.BRAIN_BASE_URL, 300).trim()
    || util.str(env.AGNES_BASE_URL, 300).trim();
  const apiKey = util.str(src.apiKey, 300).trim()
    || util.str(env.BRAIN_API_KEY, 300).trim()
    || util.str(env.AGNES_API_KEY, 300).trim()
    || util.str(env.BUTLER_AGNES_API_KEY, 300).trim()
    || deepseekKey
    || '';
  const useDeepseek = Boolean(deepseekKey) && Boolean(apiKey === deepseekKey) && !explicitBaseUrl;
  const model = explicitModel || (useDeepseek ? 'deepseek-chat' : 'agnes-2.5-flash');
  const baseUrl = (
    explicitBaseUrl
    || (useDeepseek ? 'https://api.deepseek.com' : 'https://apihub.agnes-ai.com/v1')
  ).replace(/\/+$/, '');
  // BRAIN_TIMEOUT_MS 来自 process.env 时是字符串，clampInt 只接受有限数字，需先 Number()。
  const rawTimeout = src.timeoutMs !== undefined ? src.timeoutMs : env.BRAIN_TIMEOUT_MS;
  const timeoutNumber = Number(rawTimeout);
  const timeoutMs =
    rawTimeout === undefined || rawTimeout === null || rawTimeout === '' || !Number.isFinite(timeoutNumber)
      ? 60000
      : util.clampInt(timeoutNumber, 60000, 5000, 300000);
  return { apiKey, baseUrl, model, timeoutMs };
}

/** 是否已配置可用模型（控制台展示用）。 */
function brainConfigured(overrides = {}) {
  return Boolean(brainModelConfig(overrides).apiKey);
}

/** 输出 token 上限：BRAIN_MAX_TOKENS 可覆盖，非法值/越界回落到默认值。 */
function brainMaxCompletionTokens(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? util.clampInt(parsed, DEFAULT_MAX_COMPLETION_TOKENS, MIN_MAX_COMPLETION_TOKENS, MAX_MAX_COMPLETION_TOKENS)
    : DEFAULT_MAX_COMPLETION_TOKENS;
}

/**
 * 创建大脑模型调用器。
 * @param {{model?:string, baseUrl?:string, timeoutMs?:number, fetchImpl?:Function}} [config]
 * @returns {(prompt:{system:string,user:string}) => Promise<string>}
 */
function createBrainThinker(config = {}) {
  const cfg = brainModelConfig(config);
  const fetchImpl = typeof config.fetchImpl === 'function' ? config.fetchImpl : globalThis.fetch;
  const maxTokens = brainMaxCompletionTokens(process.env.BRAIN_MAX_TOKENS);
  // DeepSeek 原生支持 JSON 输出模式：能显著减少围栏/解释/截断格式问题。
  const jsonMode = /https?:\/\/[^/]*deepseek\.com/i.test(cfg.baseUrl);
  return async function think({ system, user } = {}) {
    if (!cfg.apiKey) {
      throw new BrainError('未配置自主大脑模型（BRAIN_API_KEY / AGNES_API_KEY / DEEPSEEK_API_KEY）');
    }
    if (typeof fetchImpl !== 'function') {
      throw new BrainError('当前 Node 环境不支持 fetch，无法调用大脑模型');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    const request = (withJsonMode) => {
      const body = {
        model: cfg.model,
        messages: [
          { role: 'system', content: system || '' },
          { role: 'user', content: user || '' },
        ],
        temperature: 0.2,
        max_tokens: maxTokens,
        stream: false,
      };
      if (withJsonMode) body.response_format = { type: 'json_object' };
      return fetchImpl(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    };
    try {
      let res = await request(jsonMode);
      let text = await res.text();
      // 个别 OpenAI 兼容网关不接受 response_format：退回普通 JSON 提示。
      if (!res.ok && jsonMode && res.status === 400 && /response_format|json_object/i.test(text)) {
        res = await request(false);
        text = await res.text();
      }
      if (!res.ok) {
        throw new BrainError(`大脑模型调用失败（HTTP ${res.status}）：${util.truncate(text, 300)}`);
      }
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        throw new BrainError('大脑模型返回不是合法 JSON（响应体）');
      }
      const message = json && json.choices && json.choices[0] && json.choices[0].message;
      let content = message && message.content;
      // 少数网关把正文拆成 [{type:'text',text:'…'}] 片段。
      if (Array.isArray(content)) {
        content = content
          .map((part) => (typeof part === 'string' ? part : (part && (part.text || part.content)) || ''))
          .join('');
      }
      if ((typeof content !== 'string' || !content.trim()) && message && typeof message.reasoning_content === 'string') {
        // 推理模型把最终答案之外的内容放在 reasoning_content：尽量从里面捞出 JSON。
        content = message.reasoning_content;
      }
      if (typeof content !== 'string' || !content.trim()) {
        throw new BrainError('大脑模型没有返回内容');
      }
      return content;
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = {
  BRAIN_MODES,
  BRAIN_ACTIONS,
  BRAIN_ASSESSMENT_KEYS,
  DEFAULT_BRAIN,
  DEFAULT_INTERVAL_SEC,
  MAX_DECISIONS,
  MAX_ACTIONS_PER_DECISION,
  MIN_AUTO_CONFIDENCE,
  MIN_INTERVAL_SEC,
  MAX_INTERVAL_SEC,
  MAX_IDLE_SEC,
  MAX_IDLE_MULTIPLIER,
  MAX_BACKOFF_SEC,
  MAX_FAILURE_STREAK,
  MAX_ASSESSMENT_LENGTH,
  MAX_OWNER_ASK_LENGTH,
  MAX_OWNER_ASK_OPTIONS,
  MAX_OWNER_OPTION_LABEL,
  MAX_OWNER_OPTION_DETAIL,
  MAX_OWNER_REPLY_LENGTH,
  DEFAULT_MAX_COMPLETION_TOKENS,
  brainMaxCompletionTokens,
  BrainError,
  normalizeBrainPatch,
  normalizeActions,
  normalizeAssessment,
  normalizeOwnerAsk,
  normalizeOwnerReply,
  normalizeDecisionActionRecords,
  restoreBrain,
  computeNextThinkAt,
  effectiveIntervalSec,
  idleIntervalCapSec,
  formatAge,
  brainToJson,
  recordBrainDecision,
  buildBrainPrompt,
  parseBrainReply,
  brainModelConfig,
  brainConfigured,
  createBrainThinker,
};
