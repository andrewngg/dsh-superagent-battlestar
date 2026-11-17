'use strict';

/**
 * 极简 .env 读取（零依赖）。
 *
 * 目的：让用户把 DEEPSEEK_API_KEY 等模型配置写进仓库根目录或 hub/ 下的 .env，
 * 启动 Hub 时自动加载，不必手工设置系统环境变量。
 *
 * 规则：
 * - 只支持 KEY=VALUE 形式（可带 `export ` 前缀），忽略空行与 # 注释；
 * - 值两端的成对引号会被去掉（不处理转义）；
 * - 已存在的 process.env 优先，绝不覆盖系统环境（避免误伤宿主配置）；
 * - 不打印任何值，日志只记录键名，避免密钥进日志。
 */

const fs = require('node:fs');
const path = require('node:path');

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function unquote(value) {
  const text = String(value == null ? '' : value).trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1);
    }
  }
  return text;
}

/**
 * 解析 .env 文本。
 * @param {string} text
 * @returns {Record<string,string>}
 */
function parseEnvText(text) {
  const values = {};
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!KEY_RE.test(key)) continue;
    values[key] = unquote(line.slice(eq + 1));
  }
  return values;
}

/**
 * 加载 .env 文件（文件不存在时静默跳过）。
 * @param {string} file
 * @param {{ env?: Record<string,string|undefined>, fsImpl?: typeof fs }} [options]
 * @returns {{ file: string, applied: string[], skipped: string[] }}
 */
function loadEnvFile(file, options = {}) {
  const env = options.env || process.env;
  const fsImpl = options.fsImpl || fs;
  const applied = [];
  const skipped = [];
  let text = '';
  try {
    text = fsImpl.readFileSync(file, 'utf8');
  } catch {
    return { file, applied, skipped };
  }
  const values = parseEnvText(text);
  for (const [key, value] of Object.entries(values)) {
    if (env[key] !== undefined) {
      skipped.push(key);
      continue;
    }
    env[key] = value;
    applied.push(key);
  }
  return { file, applied, skipped };
}

/**
 * 依次加载多个 .env 文件；先到先得，已存在的变量不覆盖。
 * @param {string[]} files
 * @param {{ env?: Record<string,string|undefined>, fsImpl?: typeof fs }} [options]
 */
function loadEnvFiles(files, options = {}) {
  const env = options.env || process.env;
  const results = [];
  for (const file of Array.isArray(files) ? files : []) {
    if (!file) continue;
    results.push(loadEnvFile(path.resolve(String(file)), { env, fsImpl: options.fsImpl }));
  }
  return results;
}

module.exports = {
  KEY_RE,
  loadEnvFile,
  loadEnvFiles,
  parseEnvText,
};
