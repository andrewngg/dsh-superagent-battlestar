'use strict';

/**
 * 设备本地状态文件：保存 deviceId / deviceToken，重启后凭它恢复注册。
 * 默认位置：<stateDir>/<设备名>.json，stateDir 默认 ~/.super-butler
 * 采用“写临时文件 + rename”的原子写法，避免进程被杀导致半截 JSON。
 */

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const STATE_VERSION = 1;

/** 把设备名清洗成可用文件名：保留中英文数字与 -_，其余替换成 '-'。 */
function slugifyName(name, fallback = 'device') {
  const raw = String(name || '').trim();
  const cleaned = raw
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/[^\p{L}\p{N}\-_]/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || fallback;
}

/** 根据设备名与 Hub 生成稳定的状态文件名，避免同名设备互相覆盖。 */
function stateFileName(name, hubUrl) {
  const slug = slugifyName(name);
  let host = '';
  try {
    host = new URL(hubUrl).hostname.replace(/[^a-zA-Z0-9.-]/g, '');
  } catch {
    host = '';
  }
  return host ? `${slug}@${host}.json` : `${slug}.json`;
}

/** @returns {string} 状态目录绝对路径 */
function resolveStateDir(options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const explicit = options.stateDir || env.BUTLER_STATE_DIR;
  if (explicit) return path.resolve(explicit);
  return path.join(homeDir, '.super-butler');
}

function resolveStateFile(options = {}) {
  if (options.stateFile) return path.resolve(options.stateFile);
  const dir = options.stateDir
    ? path.resolve(options.stateDir)
    : resolveStateDir({ env: options.env, homeDir: options.homeDir });
  return path.join(dir, stateFileName(options.name, options.hubUrl));
}

/**
 * 读取状态文件。损坏/不存在都返回 { state:null, error }，调用方决定是否重新注册。
 */
async function loadState(file) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || !data.deviceId || !data.deviceToken) {
      return { state: null, error: `状态文件缺少 deviceId/deviceToken：${file}` };
    }
    return { state: data, error: null };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { state: null, error: null };
    return { state: null, error: `读取状态文件失败：${err.message}` };
  }
}

/** 原子写入状态文件。 */
async function saveState(file, state) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const payload = {
    version: STATE_VERSION,
    ...state,
    updatedAt: new Date().toISOString(),
  };
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  try {
    await fsp.rename(tmp, file);
  } catch (err) {
    // Windows 上目标文件被占用时 rename 可能失败，退化为先删后写。
    try {
      await fsp.unlink(file);
    } catch {
      /* ignore */
    }
    await fsp.rename(tmp, file);
  }
  return payload;
}

/** 删除状态文件（例如令牌确认失效后重新使用加入码）。 */
async function clearState(file) {
  try {
    await fsp.unlink(file);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
}

module.exports = {
  STATE_VERSION,
  slugifyName,
  stateFileName,
  resolveStateDir,
  resolveStateFile,
  loadState,
  saveState,
  clearState,
};
