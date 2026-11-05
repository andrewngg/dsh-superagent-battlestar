'use strict';

/**
 * 极简日志器（零依赖）。
 * 支持等级、彩色输出、子前缀；测试可注入 silent logger 或自定义 stream。
 */

const LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
});

const COLORS = Object.freeze({
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  reset: '\x1b[0m',
});

function normalizeLevel(level) {
  if (typeof level === 'number' && Number.isFinite(level)) return level;
  const key = String(level || 'info').toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, key) ? LEVELS[key] : LEVELS.info;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 本地时间 HH:MM:SS.mmm，便于人读。 */
function formatTime(date = new Date()) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}.${String(
    date.getMilliseconds(),
  ).padStart(3, '0')}`;
}

function stringify(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  if (value === null || typeof value !== 'object') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * @param {object} [options]
 * @param {string|number} [options.level] debug|info|warn|error|silent 或等级数字
 * @param {string} [options.prefix] 日志前缀（如设备名）
 * @param {{write:Function, isTTY?:boolean}} [options.stream]
 * @param {boolean} [options.color] 是否使用 ANSI 颜色
 */
function createLogger(options = {}) {
  const level = normalizeLevel(options.level ?? process.env.BUTLER_LOG_LEVEL ?? 'info');
  const stream = options.stream || process.stdout;
  const useColor = options.color ?? Boolean(stream.isTTY && !process.env.NO_COLOR);
  const prefix = options.prefix ? `[${options.prefix}] ` : '';

  function write(lvl, args) {
    if (LEVELS[lvl] < level) return;
    const text = args.map(stringify).join(' ');
    const color = useColor ? COLORS[lvl] || '' : '';
    const reset = useColor ? COLORS.reset : '';
    stream.write(`${color}${formatTime()} ${lvl.toUpperCase().padEnd(5)} ${prefix}${text}${reset}\n`);
  }

  const logger = {
    level,
    prefix,
    debug: (...args) => write('debug', args),
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
    child(childPrefix) {
      return createLogger({
        level,
        stream,
        color: useColor,
        prefix: `${prefix}[${childPrefix}] `,
      });
    },
    isLevelEnabled(lvl) {
      return LEVELS[normalizeLevel(lvl)] <= level;
    },
  };
  return logger;
}

/** 测试/静默场景用；不写任何输出。 */
function createSilentLogger() {
  return createLogger({
    level: 'silent',
    stream: { write() {}, isTTY: false },
    color: false,
  });
}

module.exports = {
  LEVELS,
  createLogger,
  createSilentLogger,
  normalizeLevel,
  formatTime,
};
