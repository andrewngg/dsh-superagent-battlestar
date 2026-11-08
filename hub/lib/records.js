'use strict';

/**
 * 任务执行记录目录/API 支持：列出记录、读取单任务 Markdown。
 *
 * 记录文件由 hub/lib/task-record.js 生成：<recordDir>/YYYY-MM-DD/<taskId>.md，
 * 总索引为 <recordDir>/index.md。
 */

const fs = require('node:fs');
const path = require('node:path');

const { dayOf, taskDurationMs } = require('./task-record');

function resolveRecordDir(recordDir) {
  return path.resolve(String(recordDir || '.'));
}

/** 单个任务的记录文件路径。 */
function recordFilePath(recordDir, task) {
  return path.join(resolveRecordDir(recordDir), dayOf(task && task.createdAt), `${task.id}.md`);
}

function statFile(file) {
  try {
    const stat = fs.statSync(file);
    return { size: stat.size, updatedAt: stat.mtime.toISOString() };
  } catch {
    return null;
  }
}

function taskToRecordItem(hub, task) {
  const file = recordFilePath(hub.recordDir, task);
  const stat = statFile(file);
  return {
    taskId: task.id,
    status: task.status,
    createdAt: task.createdAt,
    startedAt: task.startedAt || null,
    finishedAt: task.finishedAt || null,
    durationMs: taskDurationMs(task),
    device: task.assignedDeviceName || '',
    deviceId: task.assignedDeviceId || null,
    summary: task.instruction || '',
    error: task.error || '',
    parentTaskId: task.parentTaskId || null,
    isPlan: task.isPlan === true,
    archived: task.archived === true,
    file,
    hasFile: Boolean(stat),
    size: stat ? stat.size : 0,
    updatedAt: stat ? stat.updatedAt : null,
  };
}

function matchesQuery(item, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  return [item.taskId, item.summary, item.error, item.device]
    .join('\n')
    .toLowerCase()
    .includes(q);
}

/**
 * 列出任务执行记录（按创建时间倒序）。
 * @param {object} hub
 * @param {{q?: string, status?: string, limit?: number, offset?: number}} [options]
 */
function listRecords(hub, options = {}) {
  const query = typeof options.q === 'string' ? options.q : '';
  const status = typeof options.status === 'string' ? options.status.trim() : '';
  const limit = Math.min(200, Math.max(1, Number.isFinite(options.limit) ? Math.trunc(options.limit) : 50));
  const offset = Math.max(0, Number.isFinite(options.offset) ? Math.trunc(options.offset) : 0);

  let items = [...hub.tasks.values()].map((task) => taskToRecordItem(hub, task));
  if (status) items = items.filter((item) => item.status === status);
  if (query) items = items.filter((item) => matchesQuery(item, query));
  items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return {
    records: items.slice(offset, offset + limit),
    total: items.length,
    limit,
    offset,
    recordDir: hub.recordDir,
  };
}

/** 在记录目录里按日期目录查找某个任务的文件（任务已从 Hub 删除时使用）。 */
function findRecordFile(recordDir, taskId) {
  const dir = resolveRecordDir(recordDir);
  const direct = path.join(dir, 'index.md');
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { file: null, dir, indexFile: fs.existsSync(direct) ? direct : null };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(dir, entry.name, `${taskId}.md`);
    if (fs.existsSync(candidate)) return { file: candidate, dir, indexFile: direct };
  }
  return { file: null, dir, indexFile: fs.existsSync(direct) ? direct : null };
}

/**
 * 读取一条任务执行记录。
 * @returns {{taskId:string, file:string, markdown:string, size:number, updatedAt:string|null, task:object|null}|null}
 */
function readRecord(hub, taskId) {
  const id = String(taskId || '').trim();
  if (!id || !/^[\w.-]+$/.test(id)) return null;
  const task = hub.tasks.get(id) || null;
  let file = task ? recordFilePath(hub.recordDir, task) : null;
  if (!file || !fs.existsSync(file)) {
    const found = findRecordFile(hub.recordDir, id);
    file = found.file;
  }
  if (!file || !fs.existsSync(file)) return null;
  const markdown = fs.readFileSync(file, 'utf8');
  const stat = statFile(file);
  return {
    taskId: id,
    file,
    markdown,
    size: stat ? stat.size : markdown.length,
    updatedAt: stat ? stat.updatedAt : null,
    task: task ? taskToRecordItem(hub, task) : null,
  };
}

module.exports = {
  resolveRecordDir,
  recordFilePath,
  findRecordFile,
  listRecords,
  readRecord,
};
