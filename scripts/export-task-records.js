#!/usr/bin/env node
'use strict';

/**
 * 离线导出任务执行记录（Markdown）。
 *
 * 读取 hub/data/state.json（Hub 未运行也可以），为每个任务生成可 backtrace 的 md：
 *   <outDir>/index.md                 总索引
 *   <outDir>/YYYY-MM-DD/<taskId>.md   单任务记录
 *
 * 用法：
 *   node scripts/export-task-records.js                    # 默认输出到 <仓库>/task-records
 *   node scripts/export-task-records.js --dir <目录>
 *   node scripts/export-task-records.js --data-dir hub/data
 *   node scripts/export-task-records.js --task task_xxx    # 只导出单个任务（不写 index）
 */

const fs = require('node:fs');
const path = require('node:path');

const { writeTaskRecord, writeTaskIndex } = require('../hub/lib/task-record');

const REPO_ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const options = {
    dataDir: path.join(REPO_ROOT, 'hub', 'data'),
    outDir: path.join(REPO_ROOT, 'task-records'),
    taskId: '',
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    const eq = arg.indexOf('=');
    const key = eq >= 0 ? arg.slice(0, eq) : arg;
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
    const take = () => {
      if (inline !== undefined) return inline;
      i += 1;
      return i < argv.length ? String(argv[i]) : '';
    };
    if (key === '--data-dir') options.dataDir = path.resolve(take());
    else if (key === '--dir' || key === '--out') options.outDir = path.resolve(take());
    else if (key === '--task') options.taskId = take();
    else if (key === '--help' || key === '-h') options.help = true;
    else if (key.startsWith('-')) options.unknown = key;
  }
  return options;
}

/**
 * 从 state.json 导出记录。
 * @param {{dataDir: string, outDir: string, taskId?: string}} options
 * @returns {{written: number, total: number, outDir: string, indexFile: string|null}}
 */
function exportRecords(options = {}) {
  const dataDir = path.resolve(String(options.dataDir || path.join(REPO_ROOT, 'hub', 'data')));
  const outDir = path.resolve(String(options.outDir || path.join(REPO_ROOT, 'task-records')));
  const stateFile = path.join(dataDir, 'state.json');
  if (!fs.existsSync(stateFile)) throw new Error(`找不到状态文件：${stateFile}（Hub 尚未运行过？）`);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const hubEvents = Array.isArray(state.events) ? state.events : [];
  const taskId = typeof options.taskId === 'string' ? options.taskId.trim() : '';
  const targets = taskId ? tasks.filter((task) => task && task.id === taskId) : tasks;
  if (!targets.length) {
    throw new Error(taskId ? `state.json 中找不到任务 ${taskId}` : 'state.json 中没有任何任务');
  }
  for (const task of targets) {
    writeTaskRecord(outDir, task, { allTasks: tasks, hubEvents });
  }
  let indexFile = null;
  if (!taskId) {
    indexFile = writeTaskIndex(outDir, tasks).file;
  }
  return { written: targets.length, total: tasks.length, outDir, indexFile };
}

function printHelp() {
  console.log(
    [
      'BattleStar 任务记录导出',
      '',
      '用法：node scripts/export-task-records.js [选项]',
      '',
      '  --data-dir <目录>  状态目录（默认 <仓库>/hub/data）',
      '  --dir <目录>       输出目录（默认 <仓库>/task-records）',
      '  --task <task_id>   只导出单个任务',
      '  -h, --help         显示帮助',
    ].join('\n'),
  );
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  if (options.unknown) {
    console.error(`[task-records] 未知参数：${options.unknown}（用 --help 查看用法）`);
    return 1;
  }
  try {
    const result = exportRecords(options);
    console.log(`[task-records] 已导出 ${result.written}/${result.total} 个任务 → ${result.outDir}`);
    if (result.indexFile) console.log(`[task-records] 索引：${result.indexFile}`);
    return 0;
  } catch (err) {
    console.error(`[task-records] 导出失败：${err && err.message ? err.message : err}`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { REPO_ROOT, parseArgs, exportRecords, main };
