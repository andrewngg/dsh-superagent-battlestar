'use strict';

/**
 * 提醒（Reminders）。
 *
 * 提醒 = 用户在某个时间点要被通知的一件事：手机 APK 用原生 AlarmManager 在到点时
 * 弹出通知，Hub 只负责持久化与同步（列表、增删改、到点回写）。因此本模块与 Hub 都
 * 不做轮询调度，只提供纯数据归一化与「下一次到期时间」计算，便于单测。
 *
 * 时间约定：dueAt 一律是数字 epoch 毫秒（state.json / snapshot / REST API 一致）；
 * createdAt / updatedAt / lastFiredAt 是 ISO 字符串。
 */

const protocol = require('../../shared/protocol.js');
const util = require('./util');

const REMINDER_REPEATS = ['none', 'daily', 'weekly'];
const REMINDER_REPEAT_SET = new Set(REMINDER_REPEATS);
// 通知方式：gentle=普通系统通知（默认），alarm=闹钟式（响亮提示音 + 震动），由 APK 决定实际表现。
const REMINDER_NOTIFY_STYLES = ['gentle', 'alarm'];
const REMINDER_NOTIFY_STYLE_SET = new Set(REMINDER_NOTIFY_STYLES);
const DEFAULT_NOTIFY_STYLE = 'gentle';
const MAX_TITLE = 80;
const MAX_NOTE = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function bad(errors) {
  return { ok: false, errors };
}

/** 重复周期对应的毫秒数；none 返回 null。 */
function repeatIntervalMs(repeat) {
  if (repeat === 'daily') return DAY_MS;
  if (repeat === 'weekly') return WEEK_MS;
  return null;
}

/**
 * 计算下一次到期时间（epoch ms）。
 *
 * none：不重复，返回 null。
 * daily / weekly：在 dueAt 的基础上按整周期推进，保证结果 > fromMs 且至少推进一个
 * 周期（即使 dueAt 还在未来，也推进一个周期，避免刚触发就再次到期）。
 *
 * @param {number} dueAtMs 原到期时间（epoch ms）
 * @param {'none'|'daily'|'weekly'} repeat 重复方式
 * @param {number} [fromMs] 参考时间（通常是触发时间/当前时间）
 * @returns {number|null}
 */
function nextDueAt(dueAtMs, repeat, fromMs = Date.now()) {
  const step = repeatIntervalMs(repeat);
  if (step === null) return null;
  const from = Number.isFinite(fromMs) ? Number(fromMs) : Date.now();
  const due = Number.isFinite(dueAtMs) ? Number(dueAtMs) : null;
  if (due === null) return from + step;
  let periods = Math.max(1, Math.floor((from - due) / step) + 1);
  if (due + periods * step <= from) periods += 1;
  return due + periods * step;
}

/**
 * 归一化提醒创建/更新请求；partial=true 时只校验出现的字段（PATCH 语义）。
 * @param {unknown} input
 * @param {{partial?:boolean,base?:object|null}} [options]
 * @returns {{ok:true,value:object}|{ok:false,errors:string[]}}
 */
function normalizeReminderRequest(input, { partial = false, base = null } = {}) {
  const src = util.isPlainObject(input) ? input : {};
  const prev = util.isPlainObject(base) ? base : {};
  const errors = [];
  const value = {};

  if (src.title !== undefined || !partial) {
    const title = util.str(src.title !== undefined ? src.title : prev.title, MAX_TITLE).trim();
    if (!title) errors.push('提醒标题不能为空');
    else value.title = title;
  }

  if (src.note !== undefined || !partial) {
    value.note = util.str(src.note !== undefined ? src.note : prev.note, MAX_NOTE).trim();
  }

  if (src.dueAt !== undefined || !partial) {
    const dueAt = src.dueAt !== undefined ? src.dueAt : prev.dueAt;
    if (typeof dueAt !== 'number' || !Number.isFinite(dueAt) || !Number.isInteger(dueAt)) {
      errors.push('提醒时间必须是毫秒时间戳（整数）');
    } else {
      value.dueAt = dueAt;
    }
  }

  if (src.repeat !== undefined || !partial) {
    const repeat = src.repeat !== undefined ? src.repeat : prev.repeat !== undefined ? prev.repeat : 'none';
    if (!REMINDER_REPEAT_SET.has(repeat)) {
      errors.push(`提醒重复方式必须是 ${REMINDER_REPEATS.join(' / ')}`);
    } else {
      value.repeat = repeat;
    }
  }

  if (src.notifyStyle !== undefined || !partial) {
    const notifyStyle = src.notifyStyle !== undefined
      ? src.notifyStyle
      : prev.notifyStyle !== undefined ? prev.notifyStyle : DEFAULT_NOTIFY_STYLE;
    if (!REMINDER_NOTIFY_STYLE_SET.has(notifyStyle)) {
      errors.push(`提醒方式只能是 ${REMINDER_NOTIFY_STYLES.join(' 或 ')}`);
    } else {
      value.notifyStyle = notifyStyle;
    }
  }

  if (src.enabled !== undefined || !partial) {
    const enabled = src.enabled !== undefined ? src.enabled : prev.enabled !== undefined ? prev.enabled : true;
    if (typeof enabled !== 'boolean') {
      errors.push('提醒启用状态必须是布尔值');
    } else {
      value.enabled = enabled;
    }
  }

  if (errors.length) return bad(errors);
  return { ok: true, value };
}

/** 从持久化数据恢复一个提醒（容错：损坏条目返回 null，缺失 id 时重建）。 */
function restoreReminder(raw) {
  if (!util.isPlainObject(raw)) return null;
  const dueAt = typeof raw.dueAt === 'number' && Number.isFinite(raw.dueAt)
    ? Math.trunc(raw.dueAt)
    : null;
  // 没有有效到期时间的条目无法使用，视为损坏跳过。
  if (dueAt === null) return null;
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : protocol.nowIso();
  return {
    id: util.str(raw.id, 80) || protocol.randomId('rem'),
    title: util.str(raw.title, MAX_TITLE) || '未命名提醒',
    note: util.str(raw.note, MAX_NOTE) || '',
    dueAt,
    repeat: REMINDER_REPEAT_SET.has(raw.repeat) ? raw.repeat : 'none',
    notifyStyle: REMINDER_NOTIFY_STYLE_SET.has(raw.notifyStyle) ? raw.notifyStyle : DEFAULT_NOTIFY_STYLE,
    enabled: raw.enabled !== false,
    createdAt,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : createdAt,
    lastFiredAt: typeof raw.lastFiredAt === 'string' ? raw.lastFiredAt : null,
    fireCount: Number.isFinite(raw.fireCount) ? Math.max(0, Math.trunc(raw.fireCount)) : 0,
  };
}

/** 仅输出对外字段（深拷贝，避免调用方改到内部状态）。 */
function reminderToJson(reminder) {
  return {
    id: reminder.id,
    title: reminder.title,
    note: reminder.note || '',
    dueAt: reminder.dueAt,
    repeat: reminder.repeat,
    notifyStyle: REMINDER_NOTIFY_STYLE_SET.has(reminder.notifyStyle) ? reminder.notifyStyle : DEFAULT_NOTIFY_STYLE,
    enabled: reminder.enabled !== false,
    createdAt: reminder.createdAt,
    updatedAt: reminder.updatedAt,
    lastFiredAt: reminder.lastFiredAt || null,
    fireCount: Number.isFinite(reminder.fireCount) ? reminder.fireCount : 0,
  };
}

/** 提醒的展示名称（通知标题）。 */
function reminderDisplayName(reminder) {
  return util.str(reminder && reminder.title, MAX_TITLE).trim() || '未命名提醒';
}

module.exports = {
  REMINDER_REPEATS,
  REMINDER_REPEAT_SET,
  REMINDER_NOTIFY_STYLES,
  REMINDER_NOTIFY_STYLE_SET,
  DEFAULT_NOTIFY_STYLE,
  MAX_TITLE,
  MAX_NOTE,
  DAY_MS,
  WEEK_MS,
  repeatIntervalMs,
  nextDueAt,
  normalizeReminderRequest,
  restoreReminder,
  reminderToJson,
  reminderDisplayName,
};
