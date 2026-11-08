'use strict';

/**
 * Hub 系统设置（目前只有「系统默认语言」）。
 *
 * 保存位置：<dataDir>/settings.json（gitignore，和 state.json 同级）。
 * 语言值：'zh-CN'（默认）| 'en'。
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SETTINGS = Object.freeze({ language: 'zh-CN' });
const SUPPORTED_LANGUAGES = Object.freeze(['zh-CN', 'en']);
const LANGUAGE_LABELS = Object.freeze({ 'zh-CN': '简体中文', en: 'English' });

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

function mergeSettings(base, patch) {
  const next = { ...DEFAULT_SETTINGS, ...(base && typeof base === 'object' ? base : {}) };
  if (patch && typeof patch === 'object' && patch.language !== undefined) {
    next.language = normalizeLanguage(patch.language, next.language);
  }
  return next;
}

function settingsFile(dataDir) {
  return path.join(String(dataDir || '.'), 'settings.json');
}

/**
 * 读取持久化设置；不存在或损坏时返回 null。
 * @param {string} dataDir
 * @returns {{language: string}|null}
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
  normalizeLanguage,
  assertLanguage,
  mergeSettings,
  settingsFile,
  readSettings,
  writeSettings,
};
