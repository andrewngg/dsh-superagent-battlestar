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
const BRAIN_ACTIONS = ['retry_task', 'resume_thread', 'create_task', 'link_task', 'none'];
const MAX_DECISIONS = 30;
const MAX_ACTIONS_PER_DECISION = 3;
/** auto 模式下置信度低于该值的动作只记录不执行。 */
const MIN_AUTO_CONFIDENCE = 0.6;
const MIN_INTERVAL_SEC = 60;
const MAX_INTERVAL_SEC = 3600;
const DEFAULT_INTERVAL_SEC = 180;
const DEFAULT_MAX_ACTIONS = 2;
/** 自适应节律的空闲上限：连续没活时最多拉长到 30 分钟一次。 */
const MAX_IDLE_SEC = 1800;
const MAX_ASSESSMENT_LENGTH = 400;
const MAX_OWNER_ASK_LENGTH = 500;
const MAX_SUMMARY_LENGTH = 1200;
const MAX_INSTRUCTION_LENGTH = 2000;
const MAX_REASON_LENGTH = 500;
const MAX_MODEL_LENGTH = 120;

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
  lastThinkAt: null,
  lastError: null,
  lastSummary: '',
  lastAssessment: null,
  ownerAsk: null,
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
    actions.push({
      action,
      taskId: util.str(item.taskId, 80) || null,
      goalId: util.str(item.goalId, 80) || null,
      instruction: util.str(item.instruction, MAX_INSTRUCTION_LENGTH).trim(),
      reason: util.str(item.reason, MAX_REASON_LENGTH).trim(),
      confidence: Number.isFinite(confidence)
        ? Math.min(1, Math.max(0, confidence))
        : 0.6,
    });
    if (actions.length >= MAX_ACTIONS_PER_DECISION) break;
  }
  return actions;
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
    ? util.clampInt(effective, brain.intervalSec, brain.intervalSec, MAX_IDLE_SEC)
    : brain.intervalSec;
  brain.nextThinkAt = typeof src.nextThinkAt === 'string' ? src.nextThinkAt : null;
  brain.skippedCycles = util.clampInt(Number(src.skippedCycles), 0, 0, 1000);
  brain.lastAssessment = normalizeAssessment(src.lastAssessment);
  brain.ownerAsk = normalizeOwnerAsk(src.ownerAsk);
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
    const text = clampText(raw[key] || '', MAX_ASSESSMENT_LENGTH);
    assessment[key] = text;
    if (text) hasValue = true;
  }
  return hasValue ? assessment : null;
}

/**
 * 归一化「需要主人」提醒：接受字符串或 {text, at, goalId}。
 * @param {unknown} raw
 * @returns {{text:string, at:string, goalId:string|null}|null}
 */
function normalizeOwnerAsk(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    const text = clampText(raw, MAX_OWNER_ASK_LENGTH);
    return text ? { text, at: protocol.nowIso(), goalId: null } : null;
  }
  if (!util.isPlainObject(raw)) return null;
  const text = clampText(raw.text || '', MAX_OWNER_ASK_LENGTH);
  if (!text) return null;
  return {
    text,
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

/** 当前使用的思考间隔（秒）：自适应时取 effectiveIntervalSec。 */
function effectiveIntervalSec(brain) {
  const base = brain && brain.intervalSec ? brain.intervalSec : DEFAULT_INTERVAL_SEC;
  if (!brain || brain.adaptive === false) return base;
  const effective = Number(brain.effectiveIntervalSec);
  if (!Number.isFinite(effective)) return base;
  return Math.min(Math.max(effective, base), MAX_IDLE_SEC);
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
    lastThinkAt: brain.lastThinkAt || null,
    nextThinkAt: computeNextThinkAt(brain, { nowMs }),
    lastError: brain.lastError || null,
    lastSummary: brain.lastSummary || '',
    lastAssessment: brain.lastAssessment ? JSON.parse(JSON.stringify(brain.lastAssessment)) : null,
    ownerAsk: brain.ownerAsk ? JSON.parse(JSON.stringify(brain.ownerAsk)) : null,
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

/**
 * 构建大脑提示词。
 * @param {object} snapshot 由 Hub._brainSnapshot() 生成（见字段说明）
 * @param {{mind?:{soul?:string,skill?:string}}} [options] 心智（灵魂 / 工作流程）
 * @returns {{system:string, user:string}}
 */
function buildBrainPrompt(snapshot, options = {}) {
  const snap = util.isPlainObject(snapshot) ? snapshot : {};
  const mind = util.isPlainObject(options) && util.isPlainObject(options.mind) ? options.mind : {};
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
    'JSON 结构：{"assessment":{"goals":"现在有什么目标","progress":"进度在哪里","betterWay":"有什么更好的工作方式","improvement":"我需要改进哪里","myMove":"我可以做什么推进进度","ownerAsk":"需要主人做什么，没有就留空字符串"},"summary":"一句话结论","actions":[{"action":"retry_task|resume_thread|create_task|link_task|none","taskId":"可空","goalId":"可空","instruction":"可空，仅 resume_thread/create_task 使用","reason":"为什么这么做","confidence":0.0}]}',
    '动作含义：retry_task 只重试 failed/timeout/cancelled 且有剩余次数的任务（可解开计划卡点）；已完成(completed)的任务想再做，用 resume_thread 说明下一步；resume_thread 对已结束但还需要下一步的任务创建跟进（instruction 写下一步）；create_task 新建任务（只在确有新工作且没有重复任务时）；link_task 把已有任务关联到目标；none 表示观察，不执行。',
    '排队中的计划子任务若「依赖」里的前置任务未完成，不要对它 retry（会一直等待）；应先推进前置任务，或选择 none 观察。',
    '六步要求：assessment 六项都要认真填，即使没有变化也要写清结论；ownerAsk 只在确实需要主人决策/授权/提供信息/确认方向时填写，否则留空；myMove 要与 actions 一致。',
    ...mindLines,
    '保守原则：优先重试/续做/关联已有任务，而不是新建；同一轮最多 2 个动作；没有明确必要时 actions 为空数组；置信度低于 0.6 的动作会被系统拒绝，请如实给出。',
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
  lines.push(`\n## 任务（最近 ${tasks.length} 条，含失败/等待/进行中）`);
  if (!tasks.length) lines.push('（无）');
  tasks.forEach((task, index) => {
    const planText = task.isPlan ? planProgressText(task, byId) : null;
    lines.push(
      `${index + 1}. ${task.id}｜${task.status}｜${clampText(task.instruction || '', 200)}`
        + `${task.goalId ? `｜目标 ${task.goalId}` : ''}`
        + `${task.assignedDeviceName ? `｜设备 ${task.assignedDeviceName}` : ''}`
        + `${task.attempts !== undefined ? `｜尝试 ${task.attempts}/${task.maxAttempts || '?'}` : ''}`
        + `${planText ? `｜计划 ${planText}` : ''}`
        + `${util.arr(task.dependsOn).length ? `｜依赖 ${util.arr(task.dependsOn).join(',')}` : ''}`,
    );
    if (task.progress && (task.progress.message || task.progress.waiting)) {
      lines.push(`   进度：${clampText(task.progress.message || '', 160)}${task.progress.waiting ? '（等待回答）' : ''}`);
    }
    if (task.error) lines.push(`   错误：${clampText(task.error, 200)}`);
    if (task.lastEvent && task.lastEvent.message) lines.push(`   最近事件：${clampText(task.lastEvent.message, 160)}`);
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

  lines.push(
    '\n请按六步思考后决策：优先推动与长期目标相关、且已经卡住或接近完成的任务；没有值得执行的动作就返回空数组。',
    '只输出 JSON，例如：{"assessment":{"goals":"求职目标（goal_hukqu34i）仍是主线","progress":"投递计划 2/5 完成，第 3 步失败导致后续暂停","betterWay":"先重试第 3 步，再让 Mika 手机继续投递","improvement":"上次没有及时重试失败步骤，卡了 20 分钟","myMove":"重试 task_xxx","ownerAsk":""},"summary":"求职目标下的投递计划第 3 步子任务失败，重试它即可继续","actions":[{"action":"retry_task","taskId":"task_xxx","reason":"第 3 步失败导致后续投递暂停","confidence":0.8}]}',
  );
  return { system, user: lines.join('\n') };
}

/**
 * 解析大脑返回（容忍 ```json 围栏与前后解释文字）。
 * 六步思考结论放在 assessment；ownerAsk 从 assessment.ownerAsk 提取。
 * @param {unknown} text
 * @returns {{summary:string, actions:object[], assessment:object|null, ownerAsk:object|null}}
 */
function parseBrainReply(text) {
  let raw = typeof text === 'string' ? text.trim() : '';
  if (!raw) throw new BrainError('大脑返回为空');
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(raw);
  if (fence) raw = fence[1].trim();
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // 模型偶尔会加一句解释：尝试截取第一个 { 到最后一个 }。
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(raw.slice(start, end + 1));
      } catch {
        parsed = null;
      }
    }
  }
  if (!util.isPlainObject(parsed)) {
    throw new BrainError('大脑返回不是合法 JSON');
  }
  const summary = clampText(parsed.summary || '', MAX_SUMMARY_LENGTH);
  const actions = normalizeActions(parsed.actions);
  const assessment = normalizeAssessment(parsed.assessment);
  const ownerText = assessment && assessment.ownerAsk
    ? assessment.ownerAsk
    : clampText(parsed.ownerAsk || '', MAX_OWNER_ASK_LENGTH);
  const ownerAsk = ownerText ? normalizeOwnerAsk(ownerText) : null;
  if (!summary && !actions.length && !assessment && !ownerAsk) {
    throw new BrainError('大脑没有给出任何结论或动作');
  }
  return { summary, actions, assessment, ownerAsk };
}

/** 解析模型配置（环境变量 + 覆盖值）。 */
function brainModelConfig(overrides = {}) {
  const src = util.isPlainObject(overrides) ? overrides : {};
  const env = process.env;
  const model = util.str(src.model, MAX_MODEL_LENGTH).trim()
    || util.str(env.BRAIN_MODEL, MAX_MODEL_LENGTH).trim()
    || util.str(env.AGNES_MODEL, MAX_MODEL_LENGTH).trim()
    || 'agnes-2.5-flash';
  const baseUrl = (
    util.str(src.baseUrl, 300).trim()
    || util.str(env.BRAIN_BASE_URL, 300).trim()
    || util.str(env.AGNES_BASE_URL, 300).trim()
    || 'https://apihub.agnes-ai.com/v1'
  ).replace(/\/+$/, '');
  const apiKey = util.str(env.BRAIN_API_KEY, 300).trim()
    || util.str(env.AGNES_API_KEY, 300).trim()
    || util.str(env.BUTLER_AGNES_API_KEY, 300).trim()
    || '';
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

/**
 * 创建大脑模型调用器。
 * @param {{model?:string, baseUrl?:string, timeoutMs?:number, fetchImpl?:Function}} [config]
 * @returns {(prompt:{system:string,user:string}) => Promise<string>}
 */
function createBrainThinker(config = {}) {
  const cfg = brainModelConfig(config);
  const fetchImpl = typeof config.fetchImpl === 'function' ? config.fetchImpl : globalThis.fetch;
  return async function think({ system, user } = {}) {
    if (!cfg.apiKey) {
      throw new BrainError('未配置自主大脑模型（BRAIN_API_KEY / AGNES_API_KEY）');
    }
    if (typeof fetchImpl !== 'function') {
      throw new BrainError('当前 Node 环境不支持 fetch，无法调用大脑模型');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            { role: 'system', content: system || '' },
            { role: 'user', content: user || '' },
          ],
          temperature: 0.2,
          max_tokens: 2000,
          stream: false,
        }),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new BrainError(`大脑模型调用失败（HTTP ${res.status}）：${util.truncate(text, 300)}`);
      }
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        throw new BrainError('大脑模型返回不是合法 JSON（响应体）');
      }
      const content = json
        && json.choices
        && json.choices[0]
        && json.choices[0].message
        && json.choices[0].message.content;
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
  MAX_ASSESSMENT_LENGTH,
  MAX_OWNER_ASK_LENGTH,
  BrainError,
  normalizeBrainPatch,
  normalizeActions,
  normalizeAssessment,
  normalizeOwnerAsk,
  normalizeDecisionActionRecords,
  restoreBrain,
  computeNextThinkAt,
  effectiveIntervalSec,
  brainToJson,
  recordBrainDecision,
  buildBrainPrompt,
  parseBrainReply,
  brainModelConfig,
  brainConfigured,
  createBrainThinker,
};
