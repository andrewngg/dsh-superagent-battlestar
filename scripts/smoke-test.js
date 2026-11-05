#!/usr/bin/env node
'use strict';

/**
 * Super Butler 端到端冒烟测试（零依赖，约 15-25 秒）。
 *
 *   node scripts/smoke-test.js
 *
 * 覆盖：
 *   1. Hub 启动（固定令牌/加入码、短 TTL、临时数据目录）
 *   2. 3 台设备真实进程注册 → 在线 → 能力申报（models/profiles/gateways/skills）
 *   3. 按 skills / model 路由任务 → ack → progress → result → completed
 *   4. 杀掉设备 → TTL 后离线 → 新任务 queued（route.excluded 给出原因）
 *   5. 新设备上线 → 排队任务自动路由并完成
 *   6. SSE 首帧 snapshot
 *
 * 需要：Node >= 18、本项目目录、本机允许 spawn 子进程。
 * Windows 下子进程日志写到 tmp/smoke/logs，失败时可直接查看。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, 'tmp', 'smoke');
const LOGS = path.join(TMP, 'logs');
const PORT = Number(process.env.SMOKE_PORT || 7451);
const HUB = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = 'smoke-admin-token';
const JOIN_CODE = 'smoke-join-code';
const TTL_MS = 15000; // 必须大于代理心跳间隔（默认 10s），否则设备会被误判离线

const children = [];
let failed = false;

function log(message) {
  console.log(`[smoke] ${message}`);
}

function fail(message) {
  failed = true;
  console.error(`[smoke] ✗ ${message}`);
  throw new Error(message);
}

function openLog(name) {
  fs.mkdirSync(LOGS, { recursive: true });
  return fs.openSync(path.join(LOGS, `${name}.log`), 'a');
}

function startProcess(name, args, env = {}) {
  const fd = openLog(name);
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  children.push({ name, child });
  child.on('exit', (code, signal) => {
    if (failed) log(`${name} 退出 code=${code} signal=${signal}`);
  });
  return child;
}

function stopAll() {
  for (const { child } of children) {
    try {
      if (!child.killed && child.exitCode === null) child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, fn, { timeoutMs = 15000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  fail(`等待超时：${label}${lastError ? `（最后错误：${lastError.message}）` : ''}`);
  return undefined;
}

async function api(pathname, { method = 'GET', body, token = ADMIN_TOKEN } = {}) {
  const headers = { 'X-Butler-Token': token };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${HUB}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${method} ${pathname} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return json;
}

function writeDeviceConfig(slug, config) {
  const dir = path.join(TMP, 'configs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slug}.json`);
  fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf8');
  return file;
}

function startDevice(slug, config) {
  const configFile = writeDeviceConfig(slug, config);
  return startProcess(slug, [
    path.join(ROOT, 'device-agent', 'agent.js'),
    '--hub', HUB,
    '--join-code', JOIN_CODE,
    '--config', configFile,
    '--state-dir', path.join(TMP, 'state', slug),
    '--no-dsh',
    '--no-ollama',
  ]);
}

async function devices() {
  const res = await api('/api/devices');
  return res.devices;
}

async function findDeviceByName(name) {
  const list = await devices();
  return list.find((d) => d.name === name);
}

async function waitTaskStatus(taskId, statuses, timeoutMs = 25000) {
  return waitFor(`任务 ${taskId} → ${statuses.join('/')}`, async () => {
    const { task } = await api(`/api/tasks/${taskId}`);
    return statuses.includes(task.status) ? task : null;
  }, { timeoutMs, intervalMs: 250 });
}

const SIM_EXECUTOR = {
  type: 'simulate',
  simulate: { minDurationMs: 300, maxDurationMs: 700, minSteps: 2, maxSteps: 3 },
};

const DEVICES = {
  desktop: {
    name: '书房工作站',
    platform: 'windows',
    kind: 'dsh',
    tags: ['书房'],
    models: [{ id: 'deepseek-chat', provider: 'deepseek', strengths: ['code'], available: true }],
    profiles: [{ id: 'desktop', name: 'DSH Desktop' }],
    gateways: [{ id: 'openai-gateway', kind: 'openai-compatible' }],
    skills: [
      { id: 'office-docx', name: 'Word 文档' },
      { id: 'office-xlsx', name: 'Excel 表格' },
    ],
    resources: { cpuCores: 16, memoryGB: 32 },
    limits: { maxConcurrentTasks: 2 },
    executor: SIM_EXECUTOR,
  },
  media: {
    name: '客厅媒体中心',
    platform: 'linux',
    kind: 'ollama',
    tags: ['客厅'],
    models: [{ id: 'qwen2.5', provider: 'ollama', strengths: ['vision'], available: true }],
    skills: [{ id: 'home-media', name: '影音控制' }],
    limits: { maxConcurrentTasks: 1 },
    executor: SIM_EXECUTOR,
  },
  phone: {
    name: '手机 Pixel',
    platform: 'android',
    kind: 'dsh',
    tags: ['随身'],
    models: [{ id: 'deepseek-chat', provider: 'deepseek', available: true }],
    skills: [{ id: 'calendar', name: '日程' }],
    limits: { maxConcurrentTasks: 1 },
    executor: SIM_EXECUTOR,
  },
};

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(LOGS, { recursive: true });

  log(`启动 Hub :${PORT}（TTL ${TTL_MS}ms）…`);
  startProcess('hub', [
    path.join(ROOT, 'hub', 'server.js'),
    '--port', String(PORT),
    '--host', '127.0.0.1',
    '--data-dir', path.join(TMP, 'hub-data'),
    '--admin-token', ADMIN_TOKEN,
    '--join-code', JOIN_CODE,
    '--ttl-ms', String(TTL_MS),
  ]);

  await waitFor('Hub /api/health', async () => {
    const res = await fetch(`${HUB}/api/health`);
    return res.ok;
  }, { timeoutMs: 10000 });

  log('启动 3 台模拟设备…');
  startDevice('desktop', DEVICES.desktop);
  startDevice('media', DEVICES.media);
  startDevice('phone', DEVICES.phone);

  await waitFor('3 台设备在线', async () => {
    const list = await devices();
    return list.length === 3 && list.every((d) => d.online) ? list : null;
  }, { timeoutMs: 15000 });

  const list = await devices();
  for (const [slug, config] of Object.entries(DEVICES)) {
    const device = list.find((d) => d.name === config.name);
    if (!device) fail(`设备未注册：${config.name}`);
    const caps = device.capabilities || {};
    if (!Array.isArray(caps.models) || caps.models.length !== config.models.length) {
      fail(`${config.name} 申报的 models 数量不符`);
    }
    if (!Array.isArray(caps.skills) || caps.skills.length !== config.skills.length) {
      fail(`${config.name} 申报的 skills 数量不符`);
    }
    log(`✓ ${device.name} 在线 | kind=${device.kind} models=${caps.models.length} skills=${caps.skills.length} max=${caps.limits.maxConcurrentTasks}`);
  }

  log('按 skills 路由任务…');
  const { task: docTask } = await api('/api/tasks', {
    method: 'POST',
    body: {
      instruction: '把本周家庭开销整理成 Word 报告',
      requirements: { skills: ['office-docx'] },
      timeoutSec: 60,
    },
  });
  if (docTask.assignedDeviceName !== '书房工作站') {
    fail(`office-docx 任务路由错误：${docTask.assignedDeviceName}`);
  }
  const doneDoc = await waitTaskStatus(docTask.id, ['completed']);
  if (!doneDoc.output || !doneDoc.output.text) fail('完成的任务没有 output.text');
  log(`✓ 任务 ${docTask.id} → 书房工作站 completed（${doneDoc.output.text.length} 字）`);

  const { task: mediaTask } = await api('/api/tasks', {
    method: 'POST',
    body: {
      instruction: '播放今晚的轻音乐歌单，并把客厅灯光调成暖色',
      requirements: { model: 'qwen2.5', skills: ['home-media'] },
      timeoutSec: 60,
    },
  });
  if (mediaTask.assignedDeviceName !== '客厅媒体中心') {
    fail(`home-media 任务路由错误：${mediaTask.assignedDeviceName}`);
  }
  const doneMedia = await waitTaskStatus(mediaTask.id, ['completed']);
  log(`✓ 任务 ${mediaTask.id} → 客厅媒体中心 completed（${doneMedia.output.text.slice(0, 24)}…）`);

  log('杀掉客厅媒体中心，等待 TTL 离线…');
  const mediaBefore = await findDeviceByName('客厅媒体中心');
  const mediaId = mediaBefore && mediaBefore.id;
  const mediaProc = children.find((c) => c.name === 'media');
  if (mediaProc) mediaProc.child.kill('SIGTERM');
  await waitFor('客厅媒体中心离线', async () => {
    const device = (await devices()).find((d) => d.id === mediaId);
    return device && !device.online ? true : null;
  }, { timeoutMs: 30000, intervalMs: 500 });
  log('✓ 设备已标记离线');

  const { task: queuedTask } = await api('/api/tasks', {
    method: 'POST',
    body: {
      instruction: '把客厅音响切到夜间模式',
      requirements: { skills: ['home-media'] },
      timeoutSec: 60,
    },
  });
  if (queuedTask.status !== 'queued') fail(`离线设备任务应排队，实际：${queuedTask.status}`);
  if (!Array.isArray(queuedTask.route.excluded) || queuedTask.route.excluded.length === 0) {
    fail('排队任务缺少 route.excluded 原因');
  }
  log(`✓ 离线时任务 ${queuedTask.id} 保持 queued，excluded=${queuedTask.route.excluded.length}`);

  log('重新启动客厅媒体中心，验证自动路由…');
  startDevice('media-2', DEVICES.media);
  await waitFor('客厅媒体中心恢复在线（新设备）', async () => {
    const device = (await devices()).find(
      (d) => d.name === '客厅媒体中心' && d.online && d.id !== mediaId,
    );
    return device ? device : null;
  }, { timeoutMs: 20000 });
  const routed = await waitTaskStatus(queuedTask.id, ['completed'], 30000);
  log(`✓ 排队任务自动恢复并完成（设备：${routed.assignedDeviceName}）`);

  log('验证 SSE 首帧…');
  const controller = new AbortController();
  const sseRes = await fetch(`${HUB}/api/events?token=${encodeURIComponent(ADMIN_TOKEN)}`, {
    signal: controller.signal,
    headers: { Accept: 'text/event-stream' },
  });
  const reader = sseRes.body.getReader();
  const { value } = await reader.read();
  const firstChunk = Buffer.from(value || []).toString('utf8');
  controller.abort();
  if (!firstChunk.includes('snapshot')) fail(`SSE 首帧不是 snapshot：${firstChunk.slice(0, 120)}`);
  log('✓ SSE 首帧 snapshot 正常');

  const snap = await api('/api/snapshot');
  log(`✓ 快照：设备 ${snap.stats.devicesOnline}/${snap.stats.devicesTotal} 在线，任务 completed=${snap.stats.tasksCompleted} failed=${snap.stats.tasksFailed}`);

  log('全部通过 ✅');
}

main()
  .then(() => {
    stopAll();
    // 给子进程一点退出时间
    setTimeout(() => process.exit(0), 300);
  })
  .catch((err) => {
    failed = true;
    console.error(`\n[smoke] 失败：${err.stack || err.message}`);
    console.error(`[smoke] 子进程日志：${LOGS}`);
    stopAll();
    setTimeout(() => process.exit(1), 300);
  });

process.on('SIGINT', () => {
  failed = true;
  stopAll();
  process.exit(130);
});
