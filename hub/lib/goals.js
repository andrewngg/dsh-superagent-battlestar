'use strict';

/**
 * 长期目标（Goals）。
 *
 * 目标 = 一件需要持续跟踪的事：用户给出标题/描述/计划，Hub 按计划（每天某个时间
 * 或每隔 N 分钟）自动创建一次「跟进任务」，让在线设备检查目标相关任务的进展并
 * 给出建议；任务结束后把结果回写到目标（lastSummary / checks），控制台可查看。
 *
 * 本模块只做纯数据归一化与时间计算，不依赖 Hub 实例，便于单测。
 */

const protocol = require('../../shared/protocol.js');
const util = require('./util');

const GOAL_STATUSES = ['active', 'paused', 'stopped', 'completed'];
const GOAL_STATUS_SET = new Set(GOAL_STATUSES);
const SCHEDULE_TYPES = ['daily', 'interval'];
const DEFAULT_SCHEDULE = { type: 'daily', time: '09:00' };
const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
const MAX_CHECKS = 20;
const MAX_TITLE = 120;
const MAX_NICKNAME = 40;
const MAX_DESCRIPTION = 4000;
const MAX_SUMMARY = 4000;
const MAX_GUIDANCE_ENTRIES = 20;
const MAX_GUIDANCE_TEXT = 2000;
/** 目标固定工作机（硬性指向）的设备 id 最大长度。 */
const MAX_DEVICE_ID = 80;
/** 「暂停到某个时间」的最长跨度（自动恢复）。 */
const MAX_PAUSE_MS = 366 * 24 * 60 * 60 * 1000;

function bad(errors) {
  return { ok: false, errors };
}

function normalizeTime(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text);
  if (!match) return fallback;
  return `${String(Number(match[1])).padStart(2, '0')}:${match[2]}`;
}

/**
 * 归一化计划。支持 {type:'daily',time:'HH:mm'} 与 {type:'interval',minutes:N}。
 * @param {unknown} raw
 * @param {{type:string,time?:string,minutes?:number}|null} base 编辑时的旧计划（缺省字段回退到它）
 * @returns {{type:'daily',time:string}|{type:'interval',minutes:number}}
 */
function normalizeSchedule(raw, base = null) {
  const src = util.isPlainObject(raw) ? raw : null;
  const prev = util.isPlainObject(base) ? base : null;
  const type = src && SCHEDULE_TYPES.includes(src.type)
    ? src.type
    : prev && SCHEDULE_TYPES.includes(prev.type)
      ? prev.type
      : DEFAULT_SCHEDULE.type;
  if (type === 'interval') {
    const fallback = prev && prev.type === 'interval' && Number.isFinite(Number(prev.minutes))
      ? Number(prev.minutes)
      : 24 * 60;
    const minutes = util.clampInt(
      src && src.minutes !== undefined ? src.minutes : fallback,
      fallback,
      MIN_INTERVAL_MINUTES,
      MAX_INTERVAL_MINUTES,
    );
    return { type: 'interval', minutes };
  }
  const fallbackTime = prev && prev.type === 'daily' && typeof prev.time === 'string'
    ? normalizeTime(prev.time, DEFAULT_SCHEDULE.time)
    : DEFAULT_SCHEDULE.time;
  return { type: 'daily', time: normalizeTime(src && src.time, fallbackTime) };
}

/**
 * 计算下一次跟进时间（ISO 字符串）。
 * daily：本地时区今天 HH:mm；若已过则明天同一时间。
 * interval：从 fromMs 起算 N 分钟后。
 */
function computeNextCheckAt(schedule, fromMs = Date.now()) {
  const normalized = normalizeSchedule(schedule);
  const from = Number.isFinite(Number(fromMs)) ? Number(fromMs) : Date.now();
  if (normalized.type === 'interval') {
    return new Date(from + normalized.minutes * 60 * 1000).toISOString();
  }
  const [hour, minute] = normalized.time.split(':').map(Number);
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= from + 1000) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

/**
 * 跳过下一次自动跟进：把 nextCheckAt 推进一个计划周期，目标保持 active。
 * - daily：nextCheckAt 的次日同一时刻；
 * - interval：nextCheckAt + N 分钟。
 * nextCheckAt 缺失或已过期时，先按「现在」重新计算，再推进一个周期。
 * @param {{type:'daily',time:string}|{type:'interval',minutes:number}} schedule
 * @param {string|null} nextCheckAt
 * @param {number} fromMs
 * @returns {string} ISO 时间
 */
function computeSkipNextCheckAt(schedule, nextCheckAt = null, fromMs = Date.now()) {
  const normalized = normalizeSchedule(schedule);
  const from = Number.isFinite(Number(fromMs)) ? Number(fromMs) : Date.now();
  const base = Date.parse(nextCheckAt);
  const anchor = Number.isFinite(base) && base > from ? base : from;
  if (normalized.type === 'interval') {
    return new Date(anchor + normalized.minutes * 60 * 1000).toISOString();
  }
  return computeNextCheckAt(normalized, anchor);
}

/**
 * 归一化「暂停到某个时间」。
 * - 未提供（undefined）：返回 {ok:true, value:undefined}，调用方保留原值；
 * - null / ''：手动暂停，返回 {ok:true, value:null}；
 * - 字符串 / 毫秒数：必须晚于当前时间且不超过 366 天。
 * @returns {{ok:true, value:string|null|undefined}|{ok:false, error:string}}
 */
function normalizePausedUntil(value, fromMs = Date.now()) {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null || value === '') return { ok: true, value: null };
  const from = Number.isFinite(Number(fromMs)) ? Number(fromMs) : Date.now();
  const ms = typeof value === 'number'
    ? value
    : (typeof value === 'string' ? Date.parse(value) : NaN);
  if (!Number.isFinite(ms)) return { ok: false, error: '暂停结束时间格式不正确' };
  if (ms <= from) return { ok: false, error: '暂停结束时间必须晚于当前时间' };
  if (ms - from > MAX_PAUSE_MS) return { ok: false, error: '暂停最长 366 天' };
  return { ok: true, value: new Date(ms).toISOString() };
}

/**
 * 归一化「新的指导指令」：用户给目标追加的一条方向性说明，会加入之后的跟进任务。
 * @returns {{ok:true, value:{text:string}}|{ok:false, error:string}}
 */
function normalizeGuidanceEntry(input) {
  const src = util.isPlainObject(input) ? input : {};
  const text = typeof src.text === 'string' ? src.text.trim() : '';
  if (!text) return { ok: false, error: '指导指令不能为空' };
  if ([...text].length > MAX_GUIDANCE_TEXT) {
    return { ok: false, error: `指导指令最多 ${MAX_GUIDANCE_TEXT} 字` };
  }
  return { ok: true, value: { text } };
}

/** 归一化目标创建/更新请求；partial=true 时只校验出现的字段（PATCH 语义）。 */
function normalizeGoalRequest(input, { partial = false, base = null, nowMs = Date.now() } = {}) {
  const src = util.isPlainObject(input) ? input : {};
  const prev = util.isPlainObject(base) ? base : {};
  const errors = [];
  const value = {};

  const titleProvided = src.title !== undefined || !partial;
  if (titleProvided) {
    const title = util.str(src.title !== undefined ? src.title : prev.title, MAX_TITLE).trim();
    if (!title) errors.push('目标标题不能为空');
    else value.title = title;
  }

  if (src.nickname !== undefined || !partial) {
    value.nickname = util.str(
      src.nickname !== undefined ? src.nickname : prev.nickname,
      MAX_NICKNAME,
    ).trim();
  }

  if (src.description !== undefined || !partial) {
    value.description = util.str(
      src.description !== undefined ? src.description : prev.description,
      MAX_DESCRIPTION,
    ).trim();
  }

  // 固定工作机（硬性指向）：null / 空串表示「自动派发」，不写死设备。
  if (src.deviceId !== undefined || !partial) {
    const rawDeviceId = src.deviceId !== undefined ? src.deviceId : prev.deviceId;
    if (rawDeviceId === null || rawDeviceId === undefined || rawDeviceId === '') {
      value.deviceId = null;
    } else if (typeof rawDeviceId !== 'string') {
      errors.push('deviceId 必须是设备 id 字符串或 null');
    } else {
      const deviceId = rawDeviceId.trim();
      if (deviceId.length > MAX_DEVICE_ID) errors.push(`deviceId 最多 ${MAX_DEVICE_ID} 个字符`);
      else value.deviceId = deviceId || null;
    }
  }

  if (src.schedule !== undefined || !partial) {
    value.schedule = normalizeSchedule(src.schedule, prev.schedule || null);
  }

  if (src.status !== undefined) {
    if (!GOAL_STATUS_SET.has(src.status)) {
      errors.push(`目标状态必须是 ${GOAL_STATUSES.join(' / ')}`);
    } else {
      value.status = src.status;
    }
  }

  if (src.pausedUntil !== undefined) {
    const parsed = normalizePausedUntil(src.pausedUntil, nowMs);
    if (!parsed.ok) errors.push(parsed.error);
    else value.pausedUntil = parsed.value;
  }
  const resultingStatus = value.status !== undefined ? value.status : (prev.status || 'active');
  if (value.pausedUntil && resultingStatus !== 'paused') {
    errors.push('只有已暂停的目标可以设置暂停结束时间');
  }

  let requirements;
  if (src.requirements !== undefined) {
    if (!util.isPlainObject(src.requirements)) {
      errors.push('requirements 必须是对象');
    } else {
      try {
        requirements = JSON.parse(JSON.stringify(src.requirements));
      } catch {
        errors.push('requirements 不是合法 JSON');
      }
    }
  } else if (!partial && util.isPlainObject(prev.requirements)) {
    requirements = { ...prev.requirements };
  }
  if (requirements !== undefined) value.requirements = requirements;

  if (errors.length) return bad(errors);
  return { ok: true, value };
}

/** 从持久化数据恢复一个目标（容错：非法字段重置为默认值）。 */
function restoreGoal(raw) {
  if (!util.isPlainObject(raw)) return null;
  const id = util.str(raw.id, 80);
  if (!id) return null;
  const status = GOAL_STATUS_SET.has(raw.status) ? raw.status : 'active';
  const pausedUntil = status === 'paused'
    && typeof raw.pausedUntil === 'string'
    && Number.isFinite(Date.parse(raw.pausedUntil))
    ? new Date(Date.parse(raw.pausedUntil)).toISOString()
    : null;
  const schedule = normalizeSchedule(raw.schedule, null);
  const checks = (Array.isArray(raw.checks) ? raw.checks : [])
    .filter(util.isPlainObject)
    .slice(-MAX_CHECKS)
    .map((check) => ({
      at: util.str(check.at, 40) || new Date(0).toISOString(),
      taskId: util.str(check.taskId, 80) || null,
      status: util.str(check.status, 40) || 'unknown',
      summary: util.str(check.summary, MAX_SUMMARY) || '',
      error: check.error ? util.str(check.error, MAX_SUMMARY) : null,
    }));
  const nextCheckAt = typeof raw.nextCheckAt === 'string' ? raw.nextCheckAt : null;
  const guidance = (Array.isArray(raw.guidance) ? raw.guidance : [])
    .filter(util.isPlainObject)
    .map((entry) => ({
      id: util.str(entry.id, 80) || protocol.randomId('gd'),
      text: util.str(entry.text, MAX_GUIDANCE_TEXT),
      createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : protocol.nowIso(),
    }))
    .filter((entry) => entry.text)
    .slice(-MAX_GUIDANCE_ENTRIES);
  const pendingApproval = (() => {
    const pending = util.isPlainObject(raw.pendingApproval) ? raw.pendingApproval : null;
    if (!pending) return null;
    const instruction = util.str(pending.instruction, 6000);
    if (!instruction) return null;
    return {
      id: util.str(pending.id, 80) || 'appr_restored',
      at: util.str(pending.at, 40) || protocol.nowIso(),
      reason: util.str(pending.reason, 300) || '',
      instruction,
      source: util.str(pending.source, 40) || 'schedule',
    };
  })();
  return {
    id,
    title: util.str(raw.title, MAX_TITLE) || '未命名目标',
    nickname: util.str(raw.nickname, MAX_NICKNAME) || '',
    description: util.str(raw.description, MAX_DESCRIPTION) || '',
    status,
    schedule,
    requirements: util.isPlainObject(raw.requirements) ? { ...raw.requirements } : null,
    deviceId: util.str(raw.deviceId, MAX_DEVICE_ID).trim() || null,
    nextCheckAt: status === 'active' ? nextCheckAt || computeNextCheckAt(schedule) : null,
    pausedUntil,
    guidance,
    lastCheckAt: typeof raw.lastCheckAt === 'string' ? raw.lastCheckAt : null,
    lastCheckStatus: util.str(raw.lastCheckStatus, 40) || null,
    lastSummary: util.str(raw.lastSummary, MAX_SUMMARY) || '',
    lastTaskId: util.str(raw.lastTaskId, 80) || null,
    runningTaskId: util.str(raw.runningTaskId, 80) || null,
    pendingApproval,
    taskIds: (Array.isArray(raw.taskIds) ? raw.taskIds : [])
      .map((item) => util.str(item, 80))
      .filter(Boolean)
      .slice(-50),
    checks,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : protocol.nowIso(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : protocol.nowIso(),
    stoppedAt: typeof raw.stoppedAt === 'string' ? raw.stoppedAt : null,
  };
}

function goalToJson(goal) {
  return {
    id: goal.id,
    title: goal.title,
    nickname: goal.nickname || '',
    description: goal.description,
    status: goal.status,
    schedule: { ...goal.schedule },
    requirements: goal.requirements ? { ...goal.requirements } : null,
    deviceId: goal.deviceId || null,
    nextCheckAt: goal.nextCheckAt,
    pausedUntil: goal.pausedUntil || null,
    guidance: (goal.guidance || []).map((entry) => ({ ...entry })),
    lastCheckAt: goal.lastCheckAt,
    lastCheckStatus: goal.lastCheckStatus,
    lastSummary: goal.lastSummary,
    lastTaskId: goal.lastTaskId,
    runningTaskId: goal.runningTaskId,
    pendingApproval: goal.pendingApproval ? { ...goal.pendingApproval } : null,
    taskIds: [...goal.taskIds],
    checks: goal.checks.map((check) => ({ ...check })),
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    stoppedAt: goal.stoppedAt,
  };
}

/** 目标的称呼：优先昵称，其次标题。 */
function goalDisplayName(goal) {
  const nickname = util.str(goal && goal.nickname, MAX_NICKNAME).trim();
  if (nickname) return nickname;
  return util.str(goal && goal.title, MAX_TITLE).trim() || '未命名目标';
}

/**
 * 生成跟进任务指令：让设备检查目标进展并给出建议（中文 Markdown）。
 * @param {object} goal
 * @param {string|null} [deviceLabel] 固定工作机的展示名（由 Hub 按设备表解析）
 */
function buildGoalCheckInstruction(goal, deviceLabel = null) {
  const scheduleText =
    goal.schedule && goal.schedule.type === 'interval'
      ? `每 ${goal.schedule.minutes} 分钟`
      : `每天 ${goal.schedule && goal.schedule.time ? goal.schedule.time : '09:00'}`;
  const pinnedDeviceId = goal.deviceId || null;
  const pinnedLabel = deviceLabel || pinnedDeviceId;
  const recent = (goal.checks || [])
    .slice(-3)
    .map((check) => `- ${check.at}（${check.status}）：${util.truncate(check.summary || check.error || '', 200)}`)
    .join('\n');
  const guidance = (goal.guidance || [])
    .slice(-6)
    .map((entry) => `- ${entry.createdAt}：${util.truncate(entry.text, 300)}`)
    .join('\n');
  const lines = [
    '【长期目标跟进】',
    `目标：${goalDisplayName(goal)}`,
    goal.nickname ? `正式标题：${goal.title}` : '',
    `描述：${goal.description || '（未填写）'}`,
    pinnedDeviceId
      ? `固定工作机（硬性规矩）：${pinnedLabel}（${pinnedDeviceId}）——本次跟进必须在该设备上执行，不要改用其它设备。`
      : '',
    guidance ? `用户指导（按时间顺序，越靠后越新；请优先遵守）：\n${guidance}` : '',
    `计划：${scheduleText}`,
    `上次检查：${goal.lastCheckAt || '尚未检查'}（${goal.lastCheckStatus || '无'}）`,
    goal.lastSummary ? `上次建议：\n${goal.lastSummary}` : '上次建议：无',
    recent ? `最近检查记录：\n${recent}` : '',
    '',
    '请检查这个长期目标的当前进展（可结合 Hub 任务列表/最近任务结果与执行记录），然后输出：',
    '1. 当前进度（已完成 / 进行中 / 受阻，并简要说明依据）',
    '2. 风险或阻塞点（没有就写“无”）',
    '3. 下一步建议（1-3 条，尽量具体可执行）',
    '请用简洁的中文 Markdown 回复，不要重复目标原文。',
  ];
  return lines.filter((line) => line !== '').join('\n').slice(0, 6000);
}

module.exports = {
  GOAL_STATUSES,
  GOAL_STATUS_SET,
  SCHEDULE_TYPES,
  DEFAULT_SCHEDULE,
  MAX_CHECKS,
  MAX_NICKNAME,
  MAX_PAUSE_MS,
  MAX_DEVICE_ID,
  MAX_GUIDANCE_ENTRIES,
  MAX_GUIDANCE_TEXT,
  normalizeSchedule,
  computeNextCheckAt,
  computeSkipNextCheckAt,
  normalizePausedUntil,
  normalizeGuidanceEntry,
  normalizeGoalRequest,
  restoreGoal,
  goalToJson,
  goalDisplayName,
  buildGoalCheckInstruction,
};
