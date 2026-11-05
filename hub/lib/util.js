'use strict';

/** Hub 内部通用小工具（零依赖）。 */

const os = require('node:os');
const crypto = require('node:crypto');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function str(value, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function clampInt(value, dflt, min, max) {
  const n = Number.isFinite(value) ? Math.trunc(value) : dflt;
  return Math.min(max, Math.max(min, n));
}

function clampNumber(value, dflt, min, max) {
  const n = Number.isFinite(value) ? value : dflt;
  return Math.min(max, Math.max(min, n));
}

/** 定长/非空字符串的恒定时间比较，避免令牌被时序探测。 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function generateToken(prefix) {
  return `${prefix}_${crypto.randomBytes(24).toString('hex')}`;
}

/** 取本机第一个可用的局域网 IPv4（优先常见家用网段）。 */
function lanIPv4() {
  const ifaces = os.networkInterfaces();
  const list = [];
  for (const addrs of Object.values(ifaces)) {
    for (const addr of arr(addrs)) {
      if (!addr) continue;
      const family = addr.family;
      if (family !== 'IPv4' && family !== 4) continue;
      if (addr.internal) continue;
      list.push(addr.address);
    }
  }
  const score = (ip) => {
    if (ip.startsWith('192.168.')) return 0;
    if (ip.startsWith('10.')) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
    if (ip.startsWith('169.254.')) return 9; // 链路本地，通常不可用
    return 5;
  };
  list.sort((a, b) => score(a) - score(b));
  return list[0] || '127.0.0.1';
}

function truncate(value, max = 80) {
  const s = String(value == null ? '' : value);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer.unref) timer.unref();
  });
}

module.exports = {
  isPlainObject,
  arr,
  str,
  clampInt,
  clampNumber,
  safeEqual,
  generateToken,
  lanIPv4,
  truncate,
  delay,
};
