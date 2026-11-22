'use strict';

/**
 * Hub 系统设置（系统默认语言、派发主设备）。
 *
 * 保存位置：<dataDir>/settings.json（gitignore，和 state.json 同级）。
 * 语言值：'zh-CN'（默认）| 'en'。
 * 主设备（母机）：mainDeviceId；空字符串表示自动使用 Hub 所在的本机设备。
 * 手机提示音：taskSoundEnabled；false = 静音模式（任务开始/完成不在 APK 上响铃，免打扰模式始终静音）。
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SETTINGS = Object.freeze({ language: 'zh-CN', mainDeviceId: '', taskSoundEnabled: true });
const SUPPORTED_LANGUAGES = Object.freeze(['zh-CN', 'en']);
const LANGUAGE_LABELS = Object.freeze({ 'zh-CN': '简体中文', en: 'English' });
const MAX_MAIN_DEVICE_ID_LENGTH = 120;

function normalizeLanguage(value, fallback = DEFAULT_SETTINGS.language) {
  const text = typeof value === 'string' ? value.trim() : '';
  return SUPPORTED_LANGUAGES.includes(text) ? text : fallback;
}

/**
 * 严格校验语言值：非法值抛错（用于管理端 PATCH）。
 * @param {unknown} value
 * @returns {string}
 */
function assertLanguage(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!SUPPORTED_LANGUAGES.includes(text)) {
    throw new Error(`language 仅支持 ${SUPPORTED_LANGUAGES.join(' / ')}，收到：${String(value)}`);
  }
  return text;
}

/** 主设备 id：允许空字符串（自动选择本机设备）；仅裁剪空白与长度。 */
function normalizeMainDeviceId(value, fallback = DEFAULT_SETTINGS.mainDeviceId) {
  if (value === undefined) return fallback;
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  if (text.length > MAX_MAIN_DEVICE_ID_LENGTH) {
    throw new Error(`mainDeviceId 最多 ${MAX_MAIN_DEVICE_ID_LENGTH} 字符`);
  }
  return text;
}

function assertMainDeviceId(value) {
  return normalizeMainDeviceId(value, '');
}

/** 手机提示音开关：布尔值；持久化损坏时静默回退默认值。 */
function normalizeTaskSoundEnabled(value, fallback = DEFAULT_SETTINGS.taskSoundEnabled) {
  return typeof value === 'boolean' ? value : fallback;
}

/** 严格校验提示音开关：非布尔值抛错（用于管理端 PATCH）。 */
function assertTaskSoundEnabled(value) {
  if (typeof value !== 'boolean') {
    throw new Error(`taskSoundEnabled 仅支持 true / false，收到：${String(value)}`);
  }
  return value;
}

function mergeSettings(base, patch) {
  const next = { ...DEFAULT_SETTINGS, ...(base && typeof base === 'object' ? base : {}) };
  if (patch && typeof patch === 'object' && patch.language !== undefined) {
    next.language = normalizeLanguage(patch.language, next.language);
  }
  if (patch && typeof patch === 'object' && patch.mainDeviceId !== undefined) {
    next.mainDeviceId = normalizeMainDeviceId(patch.mainDeviceId, next.mainDeviceId);
  }
  if (patch && typeof patch === 'object' && patch.taskSoundEnabled !== undefined) {
    next.taskSoundEnabled = normalizeTaskSoundEnabled(patch.taskSoundEnabled, next.taskSoundEnabled);
  }
  return next;
}

function settingsFile(dataDir) {
  return path.join(String(dataDir || '.'), 'settings.json');
}

/**
 * 读取持久化设置；不存在或损坏时返回 null。
 * @param {string} dataDir
 * @returns {{language: string, mainDeviceId: string}|null}
 */
function readSettings(dataDir) {
  try {
    const raw = fs.readFileSync(settingsFile(dataDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return mergeSettings(DEFAULT_SETTINGS, parsed);
  } catch {
    return null;
  }
}

/** 写入设置（原子写：先写 .tmp 再 rename）。 */
function writeSettings(dataDir, settings) {
  const file = settingsFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(mergeSettings(DEFAULT_SETTINGS, settings), null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

module.exports = {
  DEFAULT_SETTINGS,
  SUPPORTED_LANGUAGES,
  LANGUAGE_LABELS,
  MAX_MAIN_DEVICE_ID_LENGTH,
  normalizeLanguage,
  assertLanguage,
  normalizeMainDeviceId,
  assertMainDeviceId,
  normalizeTaskSoundEnabled,
  assertTaskSoundEnabled,
  mergeSettings,
  settingsFile,
  readSettings,
  writeSettings,
};
