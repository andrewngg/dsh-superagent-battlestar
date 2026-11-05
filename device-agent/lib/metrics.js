'use strict';

/**
 * 轻量系统指标采样：CPU 使用率（两次采样差值）、内存占用、运行时长。
 * 全部基于 node:os，零依赖；读不到时返回 null 而不是抛错。
 */

const os = require('node:os');

function cpuTimes() {
  return os.cpus().map((cpu) => (cpu && cpu.times ? { ...cpu.times } : null));
}

function sumTimes(times) {
  const total = { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 };
  for (const t of times) {
    if (!t) continue;
    total.user += t.user || 0;
    total.nice += t.nice || 0;
    total.sys += t.sys || 0;
    total.idle += t.idle || 0;
    total.irq += t.irq || 0;
  }
  return total;
}

/**
 * 创建指标采样器：首次调用返回 null cpuPct（没有基准），之后返回相对上次的差值。
 * @returns {() => {cpuPct:number|null, memPct:number|null, uptimeSec:number}}
 */
function createMetricsSampler() {
  let prev = cpuTimes();
  const startedAt = Date.now();

  return function sample() {
    const now = cpuTimes();
    let cpuPct = null;
    try {
      if (prev.length === now.length && prev.length > 0) {
        const a = sumTimes(prev);
        const b = sumTimes(now);
        const idleDelta = b.idle - a.idle;
        const totalDelta = b.user - a.user + (b.nice - a.nice) + (b.sys - a.sys) + idleDelta + (b.irq - a.irq);
        if (totalDelta > 0) {
          cpuPct = Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
        }
      }
      prev = now;
    } catch {
      cpuPct = null;
    }

    let memPct = null;
    try {
      const total = os.totalmem();
      if (total > 0) memPct = Math.max(0, Math.min(100, Math.round((1 - os.freemem() / total) * 100)));
    } catch {
      memPct = null;
    }

    return {
      cpuPct,
      memPct,
      uptimeSec: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
    };
  };
}

module.exports = { createMetricsSampler };
