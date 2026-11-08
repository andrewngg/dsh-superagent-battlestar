'use strict';

/**
 * 任务执行记录（Markdown）生成器。
 *
 * 目标：为每个任务落一份可直接阅读/检索的 md，方便 backtrace「卡点到底在哪」：
 *   - 概要（状态、设备、尝试次数、超时、耗时、错误）
 *   - 完整指令 / 结果输出
 *   - 事件时间线（含距上一个事件的时间差，卡点一眼可见）
 *   - 关键耗时分解、路由原因、相关 Hub 日志
 *   - 父子任务链接（长任务拆分/线程）
 *
 * 目录结构（默认 <recordDir>）：
 *   index.md                 所有任务的总索引（按创建时间倒序）
 *   YYYY-MM-DD/<taskId>.md   单个任务记录
 *
 * 注意：记录里会包含任务原文/输出，可能含私人信息；默认写入 gitignore 的目录，不要提交。
 */

const fs = require('node:fs');
const path = require('node:path');

const STATUS_LABELS = {
  queued: '排队中',
  assigned: '已派发',
  running: '执行中',
  waiting: '等待回答',
  completed: '已完成',
  failed: '失败',
  timeout: '超时',
  cancelled: '已取消',
};

function fmtStatus(status) {
  const key = String(status || '');
  return `${key || 'unknown'}（${STATUS_LABELS[key] || key || '未知'}）`;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function dayOf(iso) {
  const text = String(iso || '');
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : 'unknown-date';
}

function fmtAt(iso) {
  const text = String(iso || '');
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(text);
  if (!m) return text || '—';
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}`;
}

function parseMs(iso) {
  const n = Date.parse(String(iso || ''));
  return Number.isFinite(n) ? n : null;
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec - min * 60;
  return `${min}m${sec.toFixed(1)}s`;
}

function taskDurationMs(task) {
  const start = parseMs(task.startedAt || task.createdAt);
  const end = parseMs(task.finishedAt || task.updatedAt);
  if (start === null || end === null) return null;
  return Math.max(0, end - start);
}

function fence(text, lang = 'text') {
  const body = String(text == null ? '' : text);
  let ticks = '```';
  while (body.includes(ticks)) ticks += '`';
  return `${ticks}${lang}\n${body}\n${ticks}`;
}

function cell(text, max = 120) {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  const shortened = value.length > max ? `${value.slice(0, max)}…` : value;
  return shortened.replace(/\|/g, '\\|') || '—';
}

function relativeLink(fromTask, targetTask) {
  const fromDay = dayOf(fromTask && fromTask.createdAt);
  const targetDay = dayOf(targetTask && targetTask.createdAt);
  const target = `${targetTask.id}.md`;
  if (fromDay === targetDay) return target;
  return `${targetDay}/${target}`;
}

function collectTaskEvents(task) {
  let prevAt = null;
  return (Array.isArray(task.events) ? task.events : []).map((event) => {
    const at = event && event.at ? event.at : '';
    const atMs = parseMs(at);
    const prevMs = prevAt === null ? null : parseMs(prevAt);
    const deltaMs = atMs !== null && prevMs !== null ? atMs - prevMs : null;
    prevAt = at;
    return {
      at,
      deltaMs,
      type: String((event && event.type) || ''),
      message: String((event && event.message) || ''),
    };
  });
}

function collectRelatedLogs(task, hubEvents) {
  const events = Array.isArray(hubEvents) ? hubEvents : [];
  return events
    .filter((event) => {
      if (!event) return false;
      if (event.taskId && event.taskId === task.id) return true;
      const message = typeof event.message === 'string' ? event.message : '';
      return message ? message.includes(task.id) : false;
    })
    .slice(-80);
}

function timingBreakdown(events) {
  const byType = (type) => events.find((event) => event.type === type) || null;
  const firstProgress = events.find((event) => event.type === 'progress') || null;
  const lastEvent = events.length ? events[events.length - 1] : null;
  const ack = byType('ack');
  const assigned = byType('assigned');
  const rows = [];
  const gap = (from, to) => {
    if (!from || !to) return null;
    const a = parseMs(from.at);
    const b = parseMs(to.at);
    return a === null || b === null ? null : b - a;
  };
  rows.push(['派发 → 设备 ack', fmtDuration(gap(assigned, ack))]);
  rows.push(['ack → 第一次进度', fmtDuration(gap(ack, firstProgress))]);
  rows.push(['第一次进度 → 最后事件', fmtDuration(gap(firstProgress, lastEvent))]);
  return rows;
}

/**
 * 生成单任务 Markdown。
 * @param {object} task Hub 内部任务对象（taskToJson 形态即可）
 * @param {{allTasks?: object[], hubEvents?: object[], generatedAt?: string}} [options]
 */
function buildTaskRecordMarkdown(task, options = {}) {
  if (!task || !task.id) throw new Error('buildTaskRecordMarkdown 需要 task.id');
  const allTasks = Array.isArray(options.allTasks) ? options.allTasks : [];
  const generatedAt = options.generatedAt || new Date().toISOString();
  const events = collectTaskEvents(task);
  const relatedLogs = collectRelatedLogs(task, options.hubEvents);
  const output = task.output || null;
  const durationMs = taskDurationMs(task);
  const parent = task.parentTaskId ? allTasks.find((item) => item.id === task.parentTaskId) || null : null;
  const children = allTasks
    .filter((item) => item.parentTaskId === task.id)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  const lines = [];
  lines.push(`# 任务执行记录 · ${task.id}`);
  lines.push('');
  lines.push(`> 生成时间：${fmtAt(generatedAt)}　｜　由 BattleStar Hub 自动生成（原始数据：\`hub/data/state.json\`）`);
  lines.push('');
  lines.push('## 概要');
  lines.push('');
  lines.push('| 字段 | 值 |');
  lines.push('| --- | --- |');
  lines.push(`| 任务 ID | \`${task.id}\` |`);
  lines.push(`| 状态 | ${fmtStatus(task.status)} |`);
  lines.push(`| 指令摘要 | ${cell(task.instruction, 100)} |`);
  lines.push(`| 执行设备 | ${cell(task.assignedDeviceName || '—', 60)}${task.assignedDeviceId ? ` (\`${task.assignedDeviceId}\`)` : ''} |`);
  lines.push(`| 优先级 | ${Number.isFinite(task.priority) ? task.priority : '—'} |`);
  lines.push(`| 超时设置 | ${Number.isFinite(task.timeoutSec) ? `${task.timeoutSec}s` : '—'}（自动重试：${task.autoRetry === false ? '关闭' : '开启'}） |`);
  lines.push(`| 尝试次数 | ${Number.isFinite(task.attempts) ? task.attempts : '—'} / ${Number.isFinite(task.maxAttempts) ? task.maxAttempts : '—'} |`);
  lines.push(`| 创建时间 | ${fmtAt(task.createdAt)} |`);
  lines.push(`| 开始时间 | ${fmtAt(task.startedAt)} |`);
  lines.push(`| 结束时间 | ${fmtAt(task.finishedAt)} |`);
  lines.push(`| 总耗时 | ${fmtDuration(durationMs)} |`);
  lines.push(`| 计划父任务 | ${parent ? `[${parent.id}](${relativeLink(task, parent)})（${fmtStatus(parent.status)}）` : '—'} |`);
  lines.push(`| 子任务数 | ${children.length} |`);
  lines.push(`| 线程 / 步骤 | ${cell(task.threadId || '—', 80)} / ${Number.isFinite(task.threadStep) ? task.threadStep : 1} |`);
  lines.push(`| 归档 | ${task.archived ? '是' : '否'} |`);
  lines.push(`| 错误 | ${cell(task.error || '—', 300)} |`);
  lines.push('');

  lines.push('## 指令（原文）');
  lines.push('');
  lines.push(fence(task.instruction || '（空）', 'text'));
  lines.push('');

  if (task.requirements && typeof task.requirements === 'object') {
    lines.push('## 路由要求');
    lines.push('');
    lines.push(fence(JSON.stringify(task.requirements, null, 2), 'json'));
    lines.push('');
  }

  lines.push('## 结果输出');
  lines.push('');
  if (output && (output.text || output.markdown || output.data || (output.artifacts && output.artifacts.length))) {
    if (output.text) {
      lines.push('### 文本');
      lines.push('');
      lines.push(fence(output.text, 'text'));
      lines.push('');
    }
    if (output.markdown) {
      lines.push('### Markdown');
      lines.push('');
      lines.push(fence(output.markdown, 'markdown'));
      lines.push('');
    }
    if (output.data !== undefined && output.data !== null) {
      lines.push('### 结构化数据');
      lines.push('');
      lines.push(fence(JSON.stringify(output.data, null, 2), 'json'));
      lines.push('');
    }
    if (Array.isArray(output.artifacts) && output.artifacts.length) {
      lines.push('### 产物');
      lines.push('');
      for (const artifact of output.artifacts) {
        lines.push(`- ${artifact.name || '(未命名)'}${artifact.path ? ` — \`${artifact.path}\`` : ''}${artifact.url ? ` — ${artifact.url}` : ''}`);
      }
      lines.push('');
    }
  } else {
    lines.push('（无输出）');
    lines.push('');
  }

  if (task.progress) {
    const progress = task.progress;
    lines.push('## 最后进度');
    lines.push('');
    lines.push(`- 消息：${progress.message || '—'}`);
    lines.push(`- 百分比：${Number.isFinite(progress.percent) ? `${progress.percent}%` : '—'}`);
    lines.push(`- 等待回答：${progress.waiting ? '是' : '否'}${progress.question ? `（${cell(progress.question, 200)}）` : ''}`);
    lines.push(`- 时间：${fmtAt(progress.at)}`);
    lines.push('');
  }

  lines.push(`## 事件时间线（共 ${events.length} 条）`);
  lines.push('');
  lines.push('| # | 时间 | 距上一事件 | 类型 | 说明 |');
  lines.push('| --- | --- | --- | --- | --- |');
  events.forEach((event, index) => {
    lines.push(
      `| ${index + 1} | ${fmtAt(event.at)} | ${event.deltaMs === null ? '—' : fmtDuration(event.deltaMs)} | ${cell(event.type, 40)} | ${cell(event.message, 300)} |`,
    );
  });
  if (!events.length) lines.push('| 1 | — | — | — | （无事件） |');
  lines.push('');

  lines.push('## 关键耗时');
  lines.push('');
  for (const [label, value] of timingBreakdown(events)) lines.push(`- ${label}：${value}`);
  lines.push(`- 创建 → 结束：${fmtDuration(taskDurationMs(task))}`);
  lines.push('');

  if (task.route) {
    lines.push('## 路由决策');
    lines.push('');
    lines.push(`- 原因：${cell(task.route.reason || '—', 400)}`);
    const candidates = Array.isArray(task.route.candidates) ? task.route.candidates : [];
    const excluded = Array.isArray(task.route.excluded) ? task.route.excluded : [];
    if (candidates.length) {
      lines.push('- 候选：');
      for (const candidate of candidates) {
        lines.push(`  - \`${candidate.deviceId}\` score=${candidate.score}${Array.isArray(candidate.matched) && candidate.matched.length ? `（命中：${candidate.matched.join('、')}）` : ''}`);
      }
    }
    if (excluded.length) {
      lines.push('- 排除：');
      for (const item of excluded) lines.push(`  - \`${item.deviceId}\`：${item.reason || '—'}`);
    }
    lines.push('');
  }

  if (children.length) {
    lines.push(`## 子任务（${children.length}）`);
    lines.push('');
    lines.push('| 子任务 | 状态 | 耗时 | 错误 | 记录 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const child of children) {
      lines.push(
        `| \`${child.id}\` | ${fmtStatus(child.status)} | ${fmtDuration(taskDurationMs(child))} | ${cell(child.error || '—', 120)} | [${child.id}](${relativeLink(task, child)}) |`,
      );
    }
    lines.push('');
  }

  const attachments = Array.isArray(task.attachments) ? task.attachments : [];
  if (attachments.length) {
    lines.push('## 附件');
    lines.push('');
    for (const file of attachments) {
      lines.push(`- ${file.name || '(未命名)'}${file.mime ? `（${file.mime}）` : ''}${Number.isFinite(file.size) ? ` — ${file.size} bytes` : ''}`);
    }
    lines.push('');
  }

  lines.push('## 相关 Hub 日志');
  lines.push('');
  if (relatedLogs.length) {
    for (const entry of relatedLogs) {
      const message = entry.message || (entry.data && entry.data.message) || entry.type || '';
      const level = entry.data && entry.data.level ? ` ${entry.data.level}` : '';
      lines.push(`- [${fmtAt(entry.at)}] ${entry.type}${level}：${cell(message, 400)}`);
    }
  } else {
    lines.push('（无）');
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`记录文件：\`${dayOf(task.createdAt)}/${task.id}.md\`　｜　索引：\`index.md\``);
  lines.push('');
  return lines.join('\n');
}

/**
 * 生成总索引 Markdown（所有任务按创建时间倒序）。
 * @param {object[]} tasks
 * @param {{generatedAt?: string, recordDir?: string}} [options]
 */
function buildIndexMarkdown(tasks, options = {}) {
  const list = Array.isArray(tasks) ? [...tasks] : [];
  const generatedAt = options.generatedAt || new Date().toISOString();
  list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const counts = new Map();
  for (const task of list) counts.set(task.status, (counts.get(task.status) || 0) + 1);
  const countText = [...counts.entries()].map(([status, count]) => `${status} ${count}`).join(' / ');

  const lines = [];
  lines.push('# BattleStar 任务执行记录索引');
  lines.push('');
  lines.push(`> 生成时间：${fmtAt(generatedAt)}　｜　任务数：${list.length}（${countText || '无'}）`);
  lines.push('>');
  lines.push('> 本目录用于任务 backtrace：每个任务一份 `<日期>/<taskId>.md`，包含指令、结果、事件时间线、耗时分解、路由与相关日志。');
  lines.push('> 记录可能包含私人内容，目录已在 `.gitignore` 中，请勿提交或分享。');
  lines.push('');
  lines.push('| 创建时间 | 任务 | 状态 | 耗时 | 设备 | 指令摘要 | 错误 | 记录 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const task of list) {
    lines.push(
      `| ${fmtAt(task.createdAt)} | \`${task.id}\` | ${fmtStatus(task.status)} | ${fmtDuration(taskDurationMs(task))} | ${cell(task.assignedDeviceName || '—', 30)} | ${cell(task.instruction, 40)} | ${cell(task.error || '—', 60)} | [${task.id}](${relativeLink({}, task)}) |`,
    );
  }
  if (!list.length) lines.push('| — | — | — | — | — | — | — | — |');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('手动补导（Hub 未运行时也可用）：');
  lines.push('');
  lines.push('```bash');
  lines.push('node scripts/export-task-records.js                 # 默认导出到 <仓库>/task-records');
  lines.push('node scripts/export-task-records.js --dir <目录>     # 指定输出目录');
  lines.push('node scripts/export-task-records.js --task task_xxx  # 只导出单个任务');
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 写入单任务记录，返回文件路径。 */
function writeTaskRecord(recordDir, task, options = {}) {
  const base = path.resolve(String(recordDir || '.'));
  const dayDir = path.join(base, dayOf(task.createdAt));
  ensureDir(dayDir);
  const file = path.join(dayDir, `${task.id}.md`);
  const content = buildTaskRecordMarkdown(task, options);
  fs.writeFileSync(file, content, 'utf8');
  return { file };
}

/** 写入总索引，返回文件路径。 */
function writeTaskIndex(recordDir, tasks, options = {}) {
  const base = path.resolve(String(recordDir || '.'));
  ensureDir(base);
  const file = path.join(base, 'index.md');
  fs.writeFileSync(file, buildIndexMarkdown(tasks, options), 'utf8');
  return { file };
}

module.exports = {
  STATUS_LABELS,
  fmtStatus,
  fmtAt,
  fmtDuration,
  dayOf,
  taskDurationMs,
  collectTaskEvents,
  collectRelatedLogs,
  buildTaskRecordMarkdown,
  buildIndexMarkdown,
  writeTaskRecord,
  writeTaskIndex,
};
