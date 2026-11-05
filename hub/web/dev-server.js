'use strict';

/**
 * Super Butler · 独立 Mock API + 静态服务器（零依赖）
 *
 * 用途：不依赖真实 hub/server.js 的情况下开发与截图 hub/web 前端。
 *   node hub/web/dev-server.js          → http://127.0.0.1:7399
 *   PORT=7400 node hub/web/dev-server.js
 *
 * 提供与 docs/PROTOCOL.md 对齐的接口：
 *   GET  /api/health
 *   GET  /api/snapshot
 *   GET  /api/devices          PATCH/DELETE /api/devices/:id
 *   GET  /api/tasks            GET /api/tasks/:id
 *   POST /api/tasks            POST /api/tasks/:id/cancel | retry
 *   GET  /api/events           （SSE，连接即发 snapshot，运行中模拟任务进度）
 *   GET  /  /m  /assets/*      静态文件
 *
 * 说明：这是演示服务器，仅校验令牌非空（任意令牌均接受），不要用于生产。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 7399);
const HOST = process.env.HOST || '127.0.0.1';
const VERSION = '0.1.0-dev';
const STARTED_AT = Date.now();
const WEB_ROOT = __dirname;

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
function randomId(prefix) {
  let s = '';
  for (let i = 0; i < 8; i += 1) s += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  return `${prefix}_${s}`;
}
const nowIso = () => new Date().toISOString();
const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();
const clampInt = (v, dflt, min, max) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Math.trunc(Number(v)))) : dflt);

/* ==================================================================
 * 内存数据
 * ================================================================== */
const devices = new Map();
const tasks = [];
const eventLog = [];
const sseClients = new Set();

function logEvent(type, message, level = 'info') {
  eventLog.unshift({ at: nowIso(), type, message, level });
  if (eventLog.length > 60) eventLog.length = 60;
}

function deviceModel(id, provider, contextWindow, strengths, available = true) {
  return { id, provider, contextWindow, strengths, available };
}
function skill(id, name, version = '1.0.0') {
  return { id, name, version };
}

function seedDevices() {
  const common = {
    online: true,
    disabled: false,
  };
  const list = [
    {
      ...common,
      id: 'dev_ws07a1',
      name: '书房工作站',
      platform: 'windows',
      kind: 'dsh',
      agentVersion: '0.1.0',
      endpoint: 'http://192.168.1.20:7788',
      tags: ['书房', '夜间可跑'],
      registeredAt: isoAgo(8 * 86400000),
      lastSeenAt: isoAgo(4000),
      status: 'busy',
      load: { running: 1, max: 2 },
      metrics: { cpuPct: 18, memPct: 46, uptimeSec: 38210 },
      capabilities: {
        models: [
          deviceModel('deepseek-chat', 'deepseek', 128000, ['code', 'reasoning', 'writing']),
          deviceModel('deepseek-reasoner', 'deepseek', 128000, ['reasoning', 'math']),
        ],
        profiles: [
          { id: 'desktop', name: 'DSH Desktop', plugins: ['@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-experimental-agent-team-profile'] },
        ],
        gateways: [
          { id: 'openai-gateway', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8787/v1', models: ['gpt-4o-mini'] },
        ],
        skills: [
          skill('office-docx', 'Word 文档'),
          skill('office-xlsx', 'Excel 表格'),
          skill('office-pptx', 'PPT 演示'),
          skill('web-research', '联网调研'),
        ],
        resources: { cpuCores: 16, memoryGB: 32, gpu: 'RTX 4070', os: 'Windows 11' },
        limits: { maxConcurrentTasks: 2 },
      },
    },
    {
      ...common,
      id: 'dev_mb3f2c',
      name: '客厅 MacBook',
      platform: 'macos',
      kind: 'dsh',
      agentVersion: '0.1.0',
      endpoint: 'http://192.168.1.31:7788',
      tags: ['客厅', '白天可用'],
      registeredAt: isoAgo(3 * 86400000),
      lastSeenAt: isoAgo(1500),
      status: 'idle',
      load: { running: 0, max: 2 },
      metrics: { cpuPct: 9, memPct: 34, uptimeSec: 9120 },
      capabilities: {
        models: [
          deviceModel('deepseek-chat', 'deepseek', 128000, ['code', 'writing']),
          deviceModel('qwen2.5-coder', 'ollama', 32768, ['code']),
        ],
        profiles: [{ id: 'laptop', name: 'DSH Laptop', plugins: ['@deepseek-ai/dsh-web-app'] }],
        gateways: [{ id: 'local-ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', models: ['qwen2.5-coder'] }],
        skills: [
          skill('office-xlsx', 'Excel 表格'),
          skill('web-research', '联网调研'),
          skill('image-gen', '图像生成', '0.4.2'),
        ],
        resources: { cpuCores: 10, memoryGB: 24, gpu: 'M3 Pro', os: 'macOS 15.2' },
        limits: { maxConcurrentTasks: 2 },
      },
    },
    {
      ...common,
      id: 'dev_nas9d4e',
      name: '家庭 NAS',
      platform: 'linux',
      kind: 'ollama',
      agentVersion: '0.1.0',
      endpoint: 'http://192.168.1.44:11434',
      tags: ['存储', '7×24'],
      registeredAt: isoAgo(21 * 86400000),
      lastSeenAt: isoAgo(9000),
      status: 'idle',
      load: { running: 0, max: 1 },
      metrics: { cpuPct: 6, memPct: 52, uptimeSec: 428000 },
      capabilities: {
        models: [
          deviceModel('llama3.1:8b', 'ollama', 131072, ['writing', 'summary']),
          deviceModel('qwen2.5:7b', 'ollama', 32768, ['reasoning']),
        ],
        profiles: [],
        gateways: [{ id: 'ollama', kind: 'ollama', baseUrl: 'http://192.168.1.44:11434', models: ['llama3.1:8b', 'qwen2.5:7b'] }],
        skills: [skill('file-organize', '文件整理'), skill('media-index', '媒体索引')],
        resources: { cpuCores: 8, memoryGB: 16, gpu: '', os: 'Debian 12' },
        limits: { maxConcurrentTasks: 1 },
      },
    },
    {
      id: 'dev_old5b20',
      name: '备用旧手机',
      platform: 'android',
      kind: 'custom',
      agentVersion: '0.0.8',
      endpoint: '',
      tags: ['备用'],
      online: false,
      disabled: false,
      registeredAt: isoAgo(40 * 86400000),
      lastSeenAt: isoAgo(6 * 60000),
      status: 'offline',
      load: { running: 0, max: 1 },
      metrics: { cpuPct: 0, memPct: 0, uptimeSec: 0 },
      capabilities: {
        models: [],
        profiles: [],
        gateways: [],
        skills: [skill('notification', '通知转发')],
        resources: { cpuCores: 8, memoryGB: 6, gpu: '', os: 'Android 13' },
        limits: { maxConcurrentTasks: 1 },
      },
    },
  ];
  for (const device of list) devices.set(device.id, device);
}

function taskEvent(type, message, percent) {
  const event = { at: nowIso(), type, message };
  if (Number.isFinite(percent)) event.percent = percent;
  return event;
}

function makeTask({ instruction, status = 'queued', deviceId = null, requirements = {}, priority = 5, timeoutSec = 300, maxAttempts = 2, createdAt, startedAt = null, finishedAt = null, attempts = 1, progress = null, output = null, error = null, route = null, events = [], durationMs = null }) {
  const device = deviceId ? devices.get(deviceId) : null;
  return {
    id: randomId('task'),
    instruction,
    requirements,
    priority,
    timeoutSec,
    maxAttempts,
    attempts,
    status,
    assignedDeviceId: device ? device.id : null,
    assignedDeviceName: device ? device.name : null,
    createdAt: createdAt || nowIso(),
    updatedAt: nowIso(),
    startedAt,
    finishedAt,
    progress,
    output,
    error,
    route,
    events: events.slice(),
    durationMs,
  };
}

function routeSort(a, b) {
  return b.score - a.score || (Date.parse(b.lastSeenAt) || 0) - (Date.parse(a.lastSeenAt) || 0);
}

/** 简化的路由实现（与 PROTOCOL §7 对齐）。返回 route 对象。 */
function computeRoute(requirements = {}) {
  const candidates = [];
  const excluded = [];
  const req = requirements || {};
  for (const device of devices.values()) {
    const caps = device.capabilities;
    if (device.disabled) {
      excluded.push({ deviceId: device.id, deviceName: device.name, reason: '设备已禁用' });
      continue;
    }
    if (!device.online) {
      excluded.push({ deviceId: device.id, deviceName: device.name, reason: '设备离线' });
      continue;
    }
    const missing = [];
    if (req.deviceId && req.deviceId !== device.id) missing.push(`device:${req.deviceId}`);
    if (req.model && !caps.models.some((m) => m.id === req.model && m.available !== false)) missing.push(`model:${req.model}`);
    for (const s of Array.isArray(req.skills) ? req.skills : []) {
      if (!caps.skills.some((skillItem) => skillItem.id === s)) missing.push(`skill:${s}`);
    }
    if (req.profile && !caps.profiles.some((p) => p.id === req.profile)) missing.push(`profile:${req.profile}`);
    if (req.gateway && !caps.gateways.some((g) => g.id === req.gateway)) missing.push(`gateway:${req.gateway}`);
    for (const tag of Array.isArray(req.tags) ? req.tags : []) {
      if (!device.tags.includes(tag)) missing.push(`tag:${tag}`);
    }
    if (missing.length) {
      excluded.push({ deviceId: device.id, deviceName: device.name, reason: `缺少 ${missing.join('、')}` });
      continue;
    }
    const max = Math.max(1, caps.limits.maxConcurrentTasks);
    if (device.load.running >= max) {
      excluded.push({ deviceId: device.id, deviceName: device.name, reason: `并发已满（${device.load.running}/${max}）` });
      continue;
    }
    let score = 100;
    score -= 20 * Math.min(1, device.load.running / max);
    if (req.deviceId && req.deviceId === device.id) score += 15;
    const age = Date.now() - Date.parse(device.lastSeenAt);
    score += Math.max(0, 3 - Math.floor(age / 10000));
    const matched = [];
    if (req.model) matched.push(`model:${req.model}`);
    for (const s of Array.isArray(req.skills) ? req.skills : []) matched.push(`skill:${s}`);
    if (req.deviceId) matched.push('device:exact');
    candidates.push({ deviceId: device.id, deviceName: device.name, score: Math.round(score), matched, lastSeenAt: device.lastSeenAt });
  }
  candidates.sort(routeSort);
  return { candidates, excluded };
}

function applyRoute(task) {
  const { candidates, excluded } = computeRoute(task.requirements);
  const picked = candidates[0];
  if (picked) {
    task.status = 'assigned';
    task.assignedDeviceId = picked.deviceId;
    task.assignedDeviceName = picked.deviceName;
    task.route = {
      reason: `matched ${candidates.length} candidate(s); picked ${picked.deviceId} (score ${picked.score})`,
      candidates: candidates.slice(0, 5),
      excluded: excluded.slice(0, 10),
    };
    task.events.push(taskEvent('routed', `路由到 ${picked.deviceName}（${picked.score} 分）`));
    task.events.push(taskEvent('assigned', '等待设备接受任务'));
    task.updatedAt = nowIso();
    logEvent('task', `任务已路由到 ${picked.deviceName}`, 'ok');
  } else {
    task.status = 'queued';
    task.assignedDeviceId = null;
    task.assignedDeviceName = null;
    task.route = {
      reason: excluded.length
        ? `no available device; ${excluded.length} excluded`
        : 'no available device',
      candidates: [],
      excluded: excluded.slice(0, 10),
    };
    task.events.push(taskEvent('queued', '没有匹配的在线设备，任务已排队等待'));
    task.updatedAt = nowIso();
    logEvent('task', '任务排队等待设备上线', 'warn');
  }
  broadcast('task.created', { task });
  broadcast('task.updated', { task });
  broadcast('snapshot', snapshot());
  return task;
}

/** 分配成功后模拟设备接单并开始执行。 */
function simulateStart(task) {
  const device = devices.get(task.assignedDeviceId);
  if (!device) return;
  device.load.running = Math.min(device.load.max, device.load.running + 1);
  device.status = 'busy';
  task.status = 'running';
  task.startedAt = nowIso();
  task.updatedAt = nowIso();
  task.progress = 2;
  task.events.push(taskEvent('ack', `${device.name} 已接受任务`, 2));
  broadcast('task.updated', { task });
  broadcast('device.updated', { device });
  broadcast('snapshot', snapshot());
}

function completeTask(task) {
  const device = devices.get(task.assignedDeviceId);
  task.status = 'completed';
  task.progress = 100;
  task.finishedAt = nowIso();
  task.updatedAt = nowIso();
  task.durationMs = task.startedAt ? Date.parse(task.finishedAt) - Date.parse(task.startedAt) : 8000;
  task.output = {
    text: `已完成：${task.instruction}`,
    markdown: buildOutputMarkdown(task),
  };
  task.events.push(taskEvent('completed', '任务执行完成', 100));
  if (device) {
    device.load.running = Math.max(0, device.load.running - 1);
    device.status = device.load.running > 0 ? 'busy' : 'idle';
    broadcast('device.updated', { device });
  }
  logEvent('task', `任务完成：${task.instruction.slice(0, 24)}`, 'ok');
  broadcast('task.completed', { task });
  broadcast('snapshot', snapshot());
}

function buildOutputMarkdown(task) {
  return [
    '## 执行结果',
    '',
    `**任务**：${task.instruction}`,
    '',
    '### 摘要',
    '- 已按需求完成处理，并做格式与完整性校验',
    '- 生成 1 个文件，附统计数据与来源说明',
    '- 执行设备负载正常，无重试',
    '',
    '### 关键数字',
    '- 处理条目：**128**',
    '- 总耗时：**12.8 秒**',
    '- 告警：0 条',
    '',
    '> 结果已保存到 `~/Documents/butler/output/`',
    '',
    '```text',
    'artifacts: 输出文件 (128 KB)',
    '```',
  ].join('\n');
}

function seedTasks() {
  /* 1) 运行中 */
  const running = makeTask({
    instruction: '把本周的开销记录整理成 Word 报告，并附上汇总表格',
    requirements: { skills: ['office-docx'] },
    priority: 7,
    status: 'running',
    deviceId: 'dev_ws07a1',
    createdAt: isoAgo(6 * 60000),
    startedAt: isoAgo(5 * 60000 + 20000),
    progress: 42,
    events: [
      { at: isoAgo(6 * 60000), type: 'created', message: '任务已创建' },
      { at: isoAgo(6 * 60000 + 2000), type: 'routed', message: '路由到 书房工作站（118 分）' },
      { at: isoAgo(5 * 60000 + 40000), type: 'ack', message: '书房工作站 已接受任务' },
      { at: isoAgo(5 * 60000 + 20000), type: 'progress', message: '正在解析表格数据', percent: 18 },
      { at: isoAgo(2 * 60000), type: 'progress', message: '生成 Word 文档结构与图表', percent: 42 },
    ],
    route: {
      reason: 'matched 1 candidate(s); picked dev_ws07a1 (score 118)',
      candidates: [
        { deviceId: 'dev_ws07a1', deviceName: '书房工作站', score: 118, matched: ['skill:office-docx'], lastSeenAt: isoAgo(4000) },
      ],
      excluded: [
        { deviceId: 'dev_mb3f2c', deviceName: '客厅 MacBook', reason: '缺少 skill:office-docx' },
        { deviceId: 'dev_nas9d4e', deviceName: '家庭 NAS', reason: '缺少 skill:office-docx' },
        { deviceId: 'dev_old5b20', deviceName: '备用旧手机', reason: '设备离线' },
      ],
    },
  });
  tasks.push(running);

  /* 2) 已完成 */
  const completed = makeTask({
    instruction: '汇总昨天浏览器里下载的文件，按类型分类并列出重复项',
    requirements: { skills: ['file-organize'] },
    priority: 5,
    status: 'completed',
    deviceId: 'dev_mb3f2c',
    createdAt: isoAgo(22 * 60000),
    startedAt: isoAgo(21 * 60000),
    finishedAt: isoAgo(20 * 60000 + 50000),
    durationMs: 8420,
    progress: 100,
    output: {
      text: '已汇总 37 个文件，归类为 6 类，发现 3 组重复。',
      markdown: [
        '## 下载文件汇总',
        '',
        '共扫描 **37** 个文件，按类型归类如下：',
        '',
        '- **文档** 12 个（PDF / Word）',
        '- **图片** 9 个',
        '- **压缩包** 6 个',
        '- **安装包** 5 个',
        '- 其他 5 个',
        '',
        '### 重复文件',
        '1. `report-final.pdf`（2 份）',
        '2. `screenshot-2026-11-04.png`（3 份）',
        '3. `setup.exe`（2 份）',
        '',
        '> 建议保留最新版本，其余移动到 `Downloads/duplicates/`。',
      ].join('\n'),
    },
    events: [
      { at: isoAgo(22 * 60000), type: 'created', message: '任务已创建' },
      { at: isoAgo(21 * 60000 + 55000), type: 'routed', message: '路由到 客厅 MacBook（103 分）' },
      { at: isoAgo(21 * 60000 + 50000), type: 'ack', message: '客厅 MacBook 已接受任务' },
      { at: isoAgo(21 * 60000 + 20000), type: 'progress', message: '扫描下载目录', percent: 38 },
      { at: isoAgo(20 * 60000 + 58000), type: 'progress', message: '计算文件指纹并去重', percent: 82 },
      { at: isoAgo(20 * 60000 + 50000), type: 'completed', message: '任务执行完成', percent: 100 },
    ],
    route: {
      reason: 'matched 2 candidate(s); picked dev_mb3f2c (score 103)',
      candidates: [
        { deviceId: 'dev_mb3f2c', deviceName: '客厅 MacBook', score: 103, matched: ['skill:file-organize'], lastSeenAt: isoAgo(1500) },
        { deviceId: 'dev_nas9d4e', deviceName: '家庭 NAS', score: 98, matched: ['skill:file-organize'], lastSeenAt: isoAgo(9000) },
      ],
      excluded: [{ deviceId: 'dev_old5b20', deviceName: '备用旧手机', reason: '设备离线' }],
    },
  });
  tasks.push(completed);

  /* 3) 失败 */
  const failed = makeTask({
    instruction: '扫描局域网内的智能设备并生成网络拓扑图',
    requirements: { model: 'llama3.1:8b' },
    priority: 5,
    status: 'failed',
    deviceId: 'dev_nas9d4e',
    createdAt: isoAgo(41 * 60000),
    startedAt: isoAgo(40 * 60000),
    finishedAt: isoAgo(38 * 60000),
    durationMs: 118000,
    error: 'ollama 连接被拒绝：127.0.0.1:11434（设备端执行器已重试 2 次）',
    events: [
      { at: isoAgo(41 * 60000), type: 'created', message: '任务已创建' },
      { at: isoAgo(40 * 60000 + 30000), type: 'routed', message: '路由到 家庭 NAS（101 分）' },
      { at: isoAgo(40 * 60000), type: 'ack', message: '家庭 NAS 已接受任务' },
      { at: isoAgo(39 * 60000), type: 'progress', message: '枚举子网 192.168.1.0/24', percent: 45 },
      { at: isoAgo(38 * 60000), type: 'failed', message: '执行失败：ollama 连接被拒绝' },
    ],
    route: {
      reason: 'matched 1 candidate(s); picked dev_nas9d4e (score 101)',
      candidates: [
        { deviceId: 'dev_nas9d4e', deviceName: '家庭 NAS', score: 101, matched: ['model:llama3.1:8b'], lastSeenAt: isoAgo(9000) },
      ],
      excluded: [
        { deviceId: 'dev_ws07a1', deviceName: '书房工作站', reason: '缺少 model:llama3.1:8b' },
        { deviceId: 'dev_mb3f2c', deviceName: '客厅 MacBook', reason: '缺少 model:llama3.1:8b' },
        { deviceId: 'dev_old5b20', deviceName: '备用旧手机', reason: '设备离线' },
      ],
    },
  });
  tasks.push(failed);

  /* 4) 排队（无设备具备 office-pptx 之外的额外要求：需要未申报能力） */
  const queued = makeTask({
    instruction: '生成第三季度经营汇报 PPT，包含趋势图与结论页',
    requirements: { skills: ['office-pptx'], model: 'deepseek-chat' },
    priority: 6,
    createdAt: isoAgo(3 * 60000),
    events: [
      { at: isoAgo(3 * 60000), type: 'created', message: '任务已创建' },
      { at: isoAgo(3 * 60000 - 500), type: 'queued', message: '没有匹配的在线设备，任务已排队等待' },
    ],
    route: {
      reason: 'no available device; 4 excluded',
      candidates: [],
      excluded: [
        { deviceId: 'dev_ws07a1', deviceName: '书房工作站', reason: '缺少 skill:office-pptx' },
        { deviceId: 'dev_mb3f2c', deviceName: '客厅 MacBook', reason: '缺少 skill:office-pptx' },
        { deviceId: 'dev_nas9d4e', deviceName: '家庭 NAS', reason: '缺少 model:deepseek-chat、skill:office-pptx' },
        { deviceId: 'dev_old5b20', deviceName: '备用旧手机', reason: '设备离线' },
      ],
    },
  });
  queued.events[0].at = isoAgo(3 * 60000);
  tasks.push(queued);

  /* 5) 已取消（历史） */
  const cancelled = makeTask({
    instruction: '下载最新一集播客并转成文字稿',
    requirements: { skills: ['media-index'] },
    priority: 3,
    status: 'cancelled',
    deviceId: 'dev_nas9d4e',
    createdAt: isoAgo(74 * 60000),
    startedAt: isoAgo(73 * 60000),
    finishedAt: isoAgo(72 * 60000),
    durationMs: 41000,
    events: [
      { at: isoAgo(74 * 60000), type: 'created', message: '任务已创建' },
      { at: isoAgo(73 * 60000), type: 'routed', message: '路由到 家庭 NAS（99 分）' },
      { at: isoAgo(73 * 60000), type: 'ack', message: '家庭 NAS 已接受任务' },
      { at: isoAgo(72 * 60000), type: 'cancelled', message: '用户取消了任务' },
    ],
    route: {
      reason: 'matched 1 candidate(s); picked dev_nas9d4e (score 99)',
      candidates: [{ deviceId: 'dev_nas9d4e', deviceName: '家庭 NAS', score: 99, matched: ['skill:media-index'], lastSeenAt: isoAgo(9000) }],
      excluded: [],
    },
  });
  tasks.push(cancelled);

  logEvent('device', '书房工作站 心跳正常', 'ok');
  logEvent('device', '客厅 MacBook 已上线', 'ok');
  logEvent('task', '任务完成：汇总昨天浏览器里下载的文件', 'ok');
  logEvent('device', '家庭 NAS 负载 0/1，空闲', 'info');
  logEvent('task', '任务失败：扫描局域网内的智能设备', 'error');
}

/* ==================================================================
 * 快照与统计
 * ================================================================== */
function stats() {
  const list = Array.from(devices.values());
  return {
    devicesTotal: list.length,
    devicesOnline: list.filter((d) => d.online).length,
    tasksQueued: tasks.filter((t) => t.status === 'queued').length,
    tasksAssigned: tasks.filter((t) => t.status === 'assigned').length,
    tasksRunning: tasks.filter((t) => t.status === 'running').length,
    tasksCompleted: tasks.filter((t) => t.status === 'completed').length,
    tasksFailed: tasks.filter((t) => t.status === 'failed' || t.status === 'timeout').length,
  };
}

function sortedTasks(limit = 50) {
  return tasks
    .slice()
    .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))
    .slice(0, limit);
}

function snapshot() {
  return {
    server: { version: VERSION, uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000), hubTime: nowIso() },
    stats: stats(),
    devices: Array.from(devices.values()),
    tasks: sortedTasks(50),
    events: eventLog.slice(0, 20),
  };
}

/* ==================================================================
 * SSE
 * ================================================================== */
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

function sseHandler(req, res, url) {
  const token = req.headers['x-butler-token'] || url.searchParams.get('token') || '';
  if (!token) {
    sendJson(res, 401, { error: { code: 'unauthorized', message: '缺少管理员令牌' } });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(': connected\n\n');
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
  sseClients.add(res);
  console.log(`[dev-server] SSE 客户端连接（共 ${sseClients.size}）`);

  const pingTimer = setInterval(() => {
    try {
      res.write(`event: ping\ndata: ${JSON.stringify({ hubTime: nowIso() })}\n\n`);
    } catch {
      clearInterval(pingTimer);
    }
  }, 15000);

  const cleanup = () => {
    clearInterval(pingTimer);
    sseClients.delete(res);
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('error', cleanup);
}

/* ==================================================================
 * 模拟执行
 * ================================================================== */
function tick() {
  for (const task of tasks) {
    if (task.status !== 'running') continue;
    const device = devices.get(task.assignedDeviceId);
    if (!device) continue;
    const current = Number.isFinite(task.progress) ? task.progress : 10;
    const step = 2 + Math.random() * 5;
    const next = Math.min(100, current + step);
    task.progress = Math.round(next);
    task.updatedAt = nowIso();
    const messages = [
      '正在解析输入数据',
      '调用模型生成内容',
      '整理输出文件',
      '校验结果完整性',
      '写入本地产出目录',
    ];
    const message = messages[Math.min(messages.length - 1, Math.floor(task.progress / 22))];
    task.events.push(taskEvent('progress', message, task.progress));
    if (task.events.length > 80) task.events.splice(0, task.events.length - 80);
    if (task.progress >= 100) {
      completeTask(task);
      continue;
    }
    device.metrics.cpuPct = Math.min(95, 20 + Math.round(Math.random() * 40));
    broadcast('task.updated', { task });
    broadcast('device.updated', { device });
  }
}

function heartbeatTick() {
  const now = nowIso();
  const changed = [];
  for (const device of devices.values()) {
    if (!device.online) continue;
    device.lastSeenAt = now;
    if (device.metrics) {
      const jitter = Math.round(Math.random() * 8) - 4;
      device.metrics.cpuPct = Math.max(2, Math.min(99, Number(device.metrics.cpuPct || 10) + jitter));
      device.metrics.memPct = Math.max(10, Math.min(95, Number(device.metrics.memPct || 40) + Math.round(Math.random() * 4) - 2));
      device.metrics.uptimeSec = Number(device.metrics.uptimeSec || 0) + 3;
    }
    changed.push(device);
  }
  for (const device of changed) broadcast('device.updated', { device });
  broadcast('snapshot', snapshot());
}

/* ==================================================================
 * HTTP 工具
 * ================================================================== */
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Butler-Token, X-Butler-Join-Code, X-Butler-Device-Token',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  });
  res.end(body);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(Object.assign(new Error('请求体过大'), { status: 413, code: 'bad_request' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('JSON 解析失败'), { status: 400, code: 'bad_request' }));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(res, pathname) {
  let relative;
  if (pathname === '/' || pathname === '/m' || pathname === '/m/' || pathname === '/index.html') {
    relative = 'index.html';
  } else if (pathname.startsWith('/assets/')) {
    relative = pathname.replace(/^\/+/, '');
  } else {
    sendError(res, 404, 'not_found', `未找到 ${pathname}`);
    return;
  }
  const filePath = path.resolve(WEB_ROOT, relative);
  if (!filePath.startsWith(path.resolve(WEB_ROOT) + path.sep) && filePath !== path.join(path.resolve(WEB_ROOT), 'index.html')) {
    sendError(res, 403, 'forbidden', '非法路径');
    return;
  }
  fs.readFile(filePath, (err, buffer) => {
    if (err) {
      sendError(res, 404, 'not_found', `未找到 ${relative}`);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buffer.length,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(buffer);
  });
}

/* ==================================================================
 * API 路由
 * ================================================================== */
async function handleApi(req, res, url, pathname) {
  const token = req.headers['x-butler-token'] || url.searchParams.get('token') || '';
  const isPublic = pathname === '/api/health';

  if (!isPublic && !token) {
    sendError(res, 401, 'unauthorized', '缺少管理员令牌（X-Butler-Token 或 ?token=）');
    return;
  }

  /* 健康检查 */
  if (pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      name: 'super-butler',
      version: VERSION,
      protocol: 1,
      uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
      hubTime: nowIso(),
    });
    return;
  }

  /* 快照 */
  if (pathname === '/api/snapshot' && req.method === 'GET') {
    sendJson(res, 200, snapshot());
    return;
  }

  /* 设备列表 */
  if (pathname === '/api/devices' && req.method === 'GET') {
    sendJson(res, 200, { devices: Array.from(devices.values()), hubTime: nowIso() });
    return;
  }

  const deviceMatch = /^\/api\/devices\/([^/]+)$/.exec(pathname);
  if (deviceMatch) {
    const id = decodeURIComponent(deviceMatch[1]);
    const device = devices.get(id);
    if (!device) {
      sendError(res, 404, 'not_found', '设备不存在');
      return;
    }
    if (req.method === 'GET') {
      sendJson(res, 200, { device });
      return;
    }
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      if (typeof body.name === 'string') {
        const name = body.name.trim().slice(0, 64);
        if (!name) {
          sendError(res, 400, 'bad_request', 'name 不能为空');
          return;
        }
        device.name = name;
      }
      if (Array.isArray(body.tags)) {
        device.tags = body.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20);
      }
      if (typeof body.disabled === 'boolean') device.disabled = body.disabled;
      logEvent('device', `设备 ${device.name} 已更新`, 'info');
      broadcast('device.updated', { device });
      broadcast('snapshot', snapshot());
      sendJson(res, 200, { device });
      return;
    }
    if (req.method === 'DELETE') {
      devices.delete(id);
      logEvent('device', `设备 ${device.name} 已删除`, 'warn');
      broadcast('snapshot', snapshot());
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  /* 任务列表 */
  if (pathname === '/api/tasks' && req.method === 'GET') {
    const statusFilter = url.searchParams.get('status') || '';
    const deviceFilter = url.searchParams.get('deviceId') || '';
    const limit = clampInt(url.searchParams.get('limit'), 100, 1, 500);
    let list = sortedTasks(limit);
    if (statusFilter) list = list.filter((t) => t.status === statusFilter);
    if (deviceFilter) list = list.filter((t) => t.assignedDeviceId === deviceFilter);
    sendJson(res, 200, { tasks: list });
    return;
  }

  /* 创建任务 */
  if (pathname === '/api/tasks' && req.method === 'POST') {
    const body = await readBody(req);
    const instruction = typeof body.instruction === 'string' ? body.instruction.trim().slice(0, 8000) : '';
    if (!instruction) {
      sendError(res, 400, 'bad_request', 'instruction 必填');
      return;
    }
    const requirements = body.requirements && typeof body.requirements === 'object' ? body.requirements : {};
    const task = makeTask({
      instruction,
      requirements,
      priority: clampInt(body.priority, 5, 0, 9),
      timeoutSec: clampInt(body.timeoutSec, 300, 30, 3600),
      maxAttempts: clampInt(body.maxAttempts, 2, 1, 3),
      events: [taskEvent('created', '任务已创建')],
    });
    task.updatedAt = nowIso();
    tasks.push(task);
    logEvent('task', `新任务：${instruction.slice(0, 24)}`, 'ok');
    broadcast('task.created', { task });
    applyRoute(task);
    const started = task.status === 'assigned' ? task : null;
    if (started) {
      setTimeout(() => {
        if (started.status === 'assigned') simulateStart(started);
      }, 900);
    }
    broadcast('snapshot', snapshot());
    sendJson(res, 200, { task });
    return;
  }

  /* 单个任务 */
  const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(pathname);
  if (taskMatch && req.method === 'GET') {
    const id = decodeURIComponent(taskMatch[1]);
    const task = tasks.find((t) => t.id === id);
    if (!task) {
      sendError(res, 404, 'not_found', '任务不存在');
      return;
    }
    sendJson(res, 200, { task });
    return;
  }

  /* 取消 / 重试 */
  const actionMatch = /^\/api\/tasks\/([^/]+)\/(cancel|retry)$/.exec(pathname);
  if (actionMatch && req.method === 'POST') {
    const id = decodeURIComponent(actionMatch[1]);
    const action = actionMatch[2];
    const task = tasks.find((t) => t.id === id);
    if (!task) {
      sendError(res, 404, 'not_found', '任务不存在');
      return;
    }
    if (action === 'cancel') {
      if (!['queued', 'assigned', 'running'].includes(task.status)) {
        sendError(res, 409, 'conflict', `任务当前状态为 ${task.status}，无法取消`);
        return;
      }
      const device = devices.get(task.assignedDeviceId);
      task.status = 'cancelled';
      task.finishedAt = nowIso();
      task.updatedAt = nowIso();
      task.durationMs = task.startedAt ? Date.parse(task.finishedAt) - Date.parse(task.startedAt) : 0;
      task.events.push(taskEvent('cancelled', '用户取消了任务'));
      if (device) {
        device.load.running = Math.max(0, device.load.running - 1);
        device.status = device.load.running > 0 ? 'busy' : 'idle';
        broadcast('device.updated', { device });
      }
      logEvent('task', '任务已取消', 'warn');
      broadcast('task.updated', { task });
      broadcast('snapshot', snapshot());
      sendJson(res, 200, { task });
      return;
    }
    if (action === 'retry') {
      if (!['failed', 'timeout', 'cancelled'].includes(task.status)) {
        sendError(res, 409, 'conflict', `任务当前状态为 ${task.status}，无法重试`);
        return;
      }
      task.status = 'queued';
      task.attempts = Math.min(3, (task.attempts || 1) + 1);
      task.assignedDeviceId = null;
      task.assignedDeviceName = null;
      task.startedAt = null;
      task.finishedAt = null;
      task.durationMs = null;
      task.progress = null;
      task.output = null;
      task.error = null;
      task.updatedAt = nowIso();
      task.events.push(taskEvent('retry', `第 ${task.attempts} 次尝试，重新入队`));
      logEvent('task', '任务重新入队', 'info');
      applyRoute(task);
      if (task.status === 'assigned') {
        setTimeout(() => {
          if (task.status === 'assigned') simulateStart(task);
        }, 900);
      }
      broadcast('snapshot', snapshot());
      sendJson(res, 200, { task });
      return;
    }
  }

  /* 单设备其它子路径（本 mock 未实现） */
  sendError(res, 404, 'not_found', `未实现 ${req.method} ${pathname}`);
}

/* ==================================================================
 * 服务器
 * ================================================================== */
function main() {
  seedDevices();
  seedTasks();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, X-Butler-Token, X-Butler-Join-Code, X-Butler-Device-Token',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return;
    }

    if (pathname === '/api/events') {
      sseHandler(req, res, url);
      return;
    }

    if (pathname.startsWith('/api/')) {
      try {
        await handleApi(req, res, url, pathname);
      } catch (err) {
        const status = err && err.status ? err.status : 500;
        if (status >= 500) console.error('[dev-server] API 错误', err);
        sendError(res, status, (err && err.code) || 'internal', (err && err.message) || '服务器内部错误');
      }
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(res, pathname);
      return;
    }
    sendError(res, 405, 'bad_request', '不支持的请求方法');
  });

  server.listen(PORT, HOST, () => {
    const base = `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`;
    console.log('┌─ Super Butler · Mock Dev Server ──────────────────────────');
    console.log(`│  桌面控制台: ${base}/?token=demo`);
    console.log(`│  手机控制台: ${base}/m?token=demo`);
    console.log(`│  健康检查 : ${base}/api/health`);
    console.log(`│  静态目录 : ${WEB_ROOT}`);
    console.log('│  端口 7399 专用于 mock，不会占用真实 hub 的 7317');
    console.log('└──────────────────────────────────────────────────────────');
  });

  setInterval(tick, 1000);
  setInterval(heartbeatTick, 3000);

  const shutdown = () => {
    console.log('\n[dev-server] 正在关闭…');
    for (const client of sseClients) {
      try {
        client.end();
      } catch {
        /* ignore */
      }
    }
    sseClients.clear();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 800);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
