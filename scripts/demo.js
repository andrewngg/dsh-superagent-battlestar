#!/usr/bin/env node
'use strict';

/**
 * BattleStar 一键 Demo。
 *
 * 流程：
 *   1. 探测 Hub（默认 http://127.0.0.1:7317）；未运行则 spawn hub/server.js
 *      （固定 BUTLER_ADMIN_TOKEN=demo-admin-token、BUTLER_JOIN_CODE=demo-join-code，
 *        状态/日志写入 tmp/demo/，输出重定向到文件，不使用 pipe）
 *   2. 启动 3 台模拟设备（书房工作站 / 客厅媒体中心 / 手机 Pixel）
 *   3. 等待设备在线，打印桌面控制台 URL、手机 URL、加入码
 *   4. 派发几条示例任务（可 --no-sample 关闭），持续运行直到 Ctrl+C
 *   5. Ctrl+C：先让设备优雅注销退出，再关闭 demo 启动的 Hub，不留孤儿进程
 *
 * 用法：
 *   node scripts/demo.js                     # 一键启动 Hub + 3 台设备
 *   node scripts/demo.js --no-hub            # 仅启动设备（Hub 已在别处运行）
 *   node scripts/demo.js --port 7318 --no-sample
 *   node scripts/demo.js --duration 10       # 10 秒后自动退出（自动化验证用）
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { requestJson, joinUrl, normalizeBaseUrl } = require('../device-agent/lib/http');
const { createLogger } = require('../device-agent/lib/logger');
const { startDevices } = require('./simulate-devices.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const HUB_ENTRY = path.join(REPO_ROOT, 'hub', 'server.js');
const DEMO_DIR = path.join(REPO_ROOT, 'tmp', 'demo');

const DEFAULT_ADMIN_TOKEN = 'demo-admin-token';
const DEFAULT_JOIN_CODE = 'demo-join-code';
const DEFAULT_PORT = 7317;

const SAMPLE_TASKS = [
  {
    instruction: '把本周家庭开销整理成 Word 报告，顺便把客厅空调调到 24 度',
    requirements: { skills: ['office-docx'] },
    priority: 6,
    timeoutSec: 120,
  },
  {
    instruction: '播放今晚的轻音乐歌单，并把客厅灯光调成暖色',
    requirements: { skills: ['home-control'] },
    priority: 5,
    timeoutSec: 120,
  },
  {
    instruction: '把明天的日程提醒推送到我的手机，并整理今天的照片',
    requirements: { skills: ['notifications'] },
    priority: 5,
    timeoutSec: 120,
  },
];

class DemoError extends Error {
  constructor(message, hint = '') {
    super(message);
    this.name = 'DemoError';
    this.hint = hint;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv = []) {
  const result = { tags: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    const eq = arg.indexOf('=');
    const key = eq >= 0 ? arg.slice(0, eq) : arg;
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
    const take = () => {
      if (inline !== undefined) return inline;
      i += 1;
      return i < argv.length ? String(argv[i]) : undefined;
    };
    switch (key) {
      case '--hub':
        result.hub = take();
        break;
      case '--port':
        result.port = Number(take());
        break;
      case '--join-code':
        result.joinCode = take();
        break;
      case '--admin-token':
        result.adminToken = take();
        break;
      case '--no-hub':
        result.noHub = true;
        break;
      case '--no-sample':
        result.noSample = true;
        break;
      case '--fresh':
        result.fresh = true;
        break;
      case '--verbose':
        result.verbose = true;
        break;
      case '--duration':
        result.durationSec = Number(take());
        break;
      case '--help':
      case '-h':
        result.help = true;
        break;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }
  return result;
}

function printHelp() {
  console.log(
    [
      'BattleStar 一键 Demo',
      '',
      '用法：node scripts/demo.js [选项]',
      '',
      '  --hub <url>          使用已运行的 Hub 地址（默认 http://127.0.0.1:7317）',
      '  --port <端口>        未指定 --hub 时，本机启动 Hub 的端口（默认 7317）',
      '  --join-code <code>   加入码，默认 demo-join-code',
      '  --admin-token <tok>  管理员令牌，默认 demo-admin-token',
      '  --no-hub             不启动 Hub（要求 Hub 已运行）',
      '  --no-sample          不派发示例任务',
      '  --fresh              清空 tmp/demo 后重新开始（设备重新注册）',
      '  --verbose            设备日志输出到当前终端（默认写日志文件）',
      '  --duration <秒>      运行指定秒数后自动停止（自动化验证用）',
      '  -h, --help           显示帮助',
      '',
      '启动后用浏览器打开打印出的“桌面控制台”或“手机控制台”URL 即可操作。',
    ].join('\n'),
  );
}

function detectLanIp() {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses || []) {
      if (!address || address.family !== 'IPv4' || address.internal) continue;
      candidates.push({ name, address: address.address });
    }
  }
  // 优先常见家庭内网网段
  const preferred = candidates.find(
    (item) => /^192\.168\./.test(item.address) || /^10\./.test(item.address) || /^172\.(1[6-9]|2\d|3[01])\./.test(item.address),
  );
  return (preferred || candidates[0] || {}).address || '127.0.0.1';
}

async function checkHealth(hubUrl) {
  try {
    const res = await requestJson(joinUrl(hubUrl, '/api/health'), { timeoutMs: 1500 });
    if (res.status === 200 && res.json && res.json.ok) return res.json;
    return null;
  } catch {
    return null;
  }
}

async function waitForHealth(hubUrl, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await checkHealth(hubUrl);
    if (health) return health;
    await sleep(400);
  }
  return null;
}

async function adminRequest(hubUrl, adminToken, pathname, options = {}) {
  const res = await requestJson(joinUrl(hubUrl, pathname), {
    ...options,
    headers: { 'x-butler-token': adminToken, ...(options.headers || {}) },
    timeoutMs: options.timeoutMs || 5000,
    body: options.body,
    method: options.method || 'GET',
  });
  if (res.status === 401 || res.status === 403) {
    throw new DemoError(
      `Hub 拒绝管理员令牌（HTTP ${res.status}），当前使用：${adminToken}`,
      '若 7317 上已有正在运行的 Hub，请用 --admin-token 传入它的令牌（或先停止它再运行 demo）。',
    );
  }
  if (res.status < 200 || res.status >= 300) {
    throw new DemoError(`Hub 接口 ${pathname} 返回 HTTP ${res.status}`);
  }
  return res.json;
}

async function listDevices(hubUrl, adminToken) {
  const json = await adminRequest(hubUrl, adminToken, '/api/devices');
  return Array.isArray(json && json.devices) ? json.devices : [];
}

async function waitForDevicesOnline(hubUrl, adminToken, expectedNames, logger, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  const wanted = new Set(expectedNames);
  let lastOnline = 0;
  while (Date.now() < deadline) {
    const devices = await listDevices(hubUrl, adminToken);
    const ours = devices.filter((device) => wanted.has(device.name));
    const online = ours.filter((device) => device.online);
    if (online.length !== lastOnline) {
      logger.info(`设备上线 ${online.length}/${expectedNames.length}：${online.map((device) => device.name).join('、') || '（暂无）'}`);
      lastOnline = online.length;
    }
    if (online.length >= expectedNames.length) return ours;
    await sleep(500);
  }
  const devices = await listDevices(hubUrl, adminToken).catch(() => []);
  const onlineCount = devices.filter((device) => device.online && wanted.has(device.name)).length;
  throw new DemoError(
    `等待设备上线超时：${onlineCount}/${expectedNames.length} 在线`,
    `请检查 ${path.join(DEMO_DIR, 'devices', 'logs')} 下的设备日志（常见原因：加入码不一致/端口不通）。`,
  );
}

async function dispatchSampleTasks(hubUrl, adminToken, logger) {
  logger.info('派发示例任务…');
  const created = [];
  for (const sample of SAMPLE_TASKS) {
    try {
      const json = await adminRequest(hubUrl, adminToken, '/api/tasks', {
        method: 'POST',
        body: sample,
      });
      const task = json && json.task;
      if (!task) continue;
      created.push(task);
      if (task.assignedDeviceName) {
        logger.info(`  示例任务 → ${task.assignedDeviceName}（${task.status}）：${sample.instruction}`);
      } else {
        const reason = (task.route && task.route.reason) || '无匹配设备';
        logger.warn(`  示例任务暂未路由（${reason}）：${sample.instruction}`);
      }
    } catch (err) {
      logger.warn(`派发示例任务失败：${err.message}`);
    }
  }
  return created;
}

/** 跟踪示例任务状态，最多跟踪 maxMs，状态变化时打印一行。 */
async function watchSampleTasks(hubUrl, adminToken, taskIds, logger, maxMs = 120000) {
  if (!taskIds.length) return;
  const terminal = new Set(['completed', 'failed', 'cancelled', 'timeout']);
  const lastStatus = new Map();
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    let done = true;
    try {
      const json = await adminRequest(hubUrl, adminToken, '/api/tasks?limit=50');
      const tasks = Array.isArray(json && json.tasks) ? json.tasks : [];
      for (const task of tasks) {
        if (!taskIds.includes(task.id)) continue;
        if (lastStatus.get(task.id) === task.status) {
          if (!terminal.has(task.status)) done = false;
          continue;
        }
        lastStatus.set(task.id, task.status);
        const progress = task.progress && task.progress.message ? ` — ${task.progress.message}` : '';
        const error = task.error ? `（${task.error}）` : '';
        logger.info(`  ${task.id} ${task.status}${error}${progress}`);
        if (!terminal.has(task.status)) done = false;
      }
    } catch {
      /* 忽略轮询错误，继续跟踪 */
    }
    if (done) return;
    await sleep(1200);
  }
}

async function startHub(hubUrl, port, adminToken, joinCode, logger) {
  if (!fs.existsSync(HUB_ENTRY)) {
    throw new DemoError(
      `找不到 Hub 入口：${HUB_ENTRY}`,
      'Hub 由其他成员实现；请先用 node hub/server.js 启动，或等 hub 就绪后再运行 demo。',
    );
  }
  const dataDir = path.join(DEMO_DIR, 'hub-data');
  const logFile = path.join(DEMO_DIR, 'logs', 'hub.log');
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.mkdir(path.dirname(logFile), { recursive: true });

  const outFd = fs.openSync(logFile, 'a');
  const errFd = fs.openSync(logFile, 'a');
  let child;
  try {
    child = spawn(
      process.execPath,
      [HUB_ENTRY, '--port', String(port), '--data-dir', dataDir, '--admin-token', adminToken, '--join-code', joinCode],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, BUTLER_ADMIN_TOKEN: adminToken, BUTLER_JOIN_CODE: joinCode },
        stdio: ['ignore', outFd, errFd],
        windowsHide: true,
      },
    );
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }

  const entry = { child, logFile, exit: null };
  child.on('exit', (code, signal) => {
    entry.exit = { code, signal };
    logger.warn(`Hub 进程退出（code=${code} signal=${signal}），日志：${logFile}`);
  });

  const health = await waitForHealth(hubUrl, 20000);
  if (!health) {
    throw new DemoError(
      `Hub 在 ${hubUrl} 启动超时`,
      `请查看日志：${logFile}（可能是端口被占用或 hub/server.js 启动失败）。`,
    );
  }
  logger.info(`Hub 已启动：${hubUrl}（日志 ${logFile}）`);
  return entry;
}

async function stopHub(entry, logger) {
  if (!entry || !entry.child || entry.exit) return;
  try {
    entry.child.kill('SIGINT');
  } catch {
    /* ignore */
  }
  const deadline = Date.now() + 6000;
  while (!entry.exit && Date.now() < deadline) await sleep(100);
  if (!entry.exit) {
    try {
      entry.child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    logger.warn('Hub 未在 6s 内优雅退出，已强制结束');
  } else {
    logger.info('Hub 已停止');
  }
}

function printBanner(context) {
  const { hubUrl, port, adminToken, joinCode, devices, lanIp, hubSpawned } = context;
  const desktopUrl = `${hubUrl}/?token=${encodeURIComponent(adminToken)}`;
  const phoneUrl = `http://${lanIp}:${port}/m?token=${encodeURIComponent(adminToken)}`;
  const lines = [
    '',
    '════════════════ BattleStar Demo ════════════════',
    `  桌面控制台   ${desktopUrl}`,
    `  手机控制台   ${phoneUrl}`,
    `  加入码       ${joinCode}   （新设备用 --join-code 接入）`,
    `  管理员令牌   ${adminToken}`,
    `  Hub          ${hubUrl}${hubSpawned ? '（本次由 demo 启动）' : '（复用已运行的 Hub）'}`,
    '  在线设备',
    ...devices.map((device) => `    · ${device.name}｜${device.platform}/${device.kind}｜在线｜并发 ${(device.load && device.load.max) || 1}`),
    `  日志目录     ${path.join(DEMO_DIR, 'logs')}`,
    '  Ctrl+C 停止全部设备与 Hub（不会留下孤儿进程）',
    '═══════════════════════════════════════════════════',
    '',
  ];
  console.log(lines.join('\n'));
}

async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`参数错误：${err.message}`);
    printHelp();
    return 2;
  }
  if (args.help) {
    printHelp();
    return 0;
  }

  const logger = createLogger({ level: args.verbose ? 'debug' : 'info', prefix: 'demo' });
  const adminToken = args.adminToken || DEFAULT_ADMIN_TOKEN;
  const joinCode = args.joinCode || DEFAULT_JOIN_CODE;
  const explicitPort = Number.isFinite(args.port) ? args.port : null;
  const hubUrl = normalizeBaseUrl(args.hub || `http://127.0.0.1:${explicitPort || DEFAULT_PORT}`);
  const port = explicitPort || Number(new URL(hubUrl).port || 80) || DEFAULT_PORT;

  if (args.fresh) {
    await fsp.rm(DEMO_DIR, { recursive: true, force: true });
    logger.info(`已清空 demo 目录：${DEMO_DIR}`);
  }
  await fsp.mkdir(path.join(DEMO_DIR, 'logs'), { recursive: true });

  let devicesHandle = null;
  let hubEntry = null;
  let closing = false;

  const cleanup = async () => {
    if (devicesHandle) {
      await devicesHandle.stop().catch(() => {});
      devicesHandle = null;
    }
    await stopHub(hubEntry, logger);
  };
  const shutdown = async (reason) => {
    if (closing) return;
    closing = true;
    logger.info(`收到 ${reason}，正在清理…`);
    try {
      await cleanup();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    // 1. Hub
    const health = await checkHealth(hubUrl);
    let hubSpawned = false;
    if (health) {
      logger.info(`检测到已运行的 Hub：${hubUrl}`);
    } else if (args.noHub) {
      throw new DemoError(
        `--no-hub 模式下 ${hubUrl} 没有可用的 Hub`,
        '请先运行 node hub/server.js，或去掉 --no-hub 由 demo 自动启动。',
      );
    } else {
      hubEntry = await startHub(hubUrl, port, adminToken, joinCode, logger);
      hubSpawned = true;
    }

    // 2. 校验管理员令牌，避免设备白等
    const devicesBefore = await listDevices(hubUrl, adminToken).catch((err) => {
      throw err instanceof DemoError ? err : new DemoError(`无法访问 Hub：${err.message}`);
    });
    if (devicesBefore.length > 0) {
      logger.info(`Hub 上已有 ${devicesBefore.length} 台设备（demo 将再启动 3 台模拟设备）`);
    }

    // 3. 设备
    devicesHandle = await startDevices({
      hub: hubUrl,
      joinCode,
      stateDir: path.join(DEMO_DIR, 'devices'),
      logMode: args.verbose ? 'inherit' : 'file',
      verbose: args.verbose,
      logger,
    });

    const expectedNames = devicesHandle.devices.map((device) => device.name);
    const devices = await waitForDevicesOnline(hubUrl, adminToken, expectedNames, logger, 30000);

    // 4. 横幅
    printBanner({
      hubUrl,
      port,
      adminToken,
      joinCode,
      devices,
      lanIp: detectLanIp(),
      hubSpawned,
    });

    // 5. 示例任务
    if (!args.noSample) {
      const created = await dispatchSampleTasks(hubUrl, adminToken, logger);
      const watch = watchSampleTasks(
        hubUrl,
        adminToken,
        created.map((task) => task.id),
        logger,
      ).catch(() => {});
      if (Number.isFinite(args.durationSec) && args.durationSec > 0) {
        await Promise.race([watch, sleep(args.durationSec * 1000)]);
      } else {
        // 后台跟踪，不阻塞主流程
        void watch;
      }
    }

    logger.info('Demo 运行中：可在控制台发送指令、查看设备与任务进度（Ctrl+C 退出）');

    // 6. 保持运行，直到 Ctrl+C 或 --duration
    if (Number.isFinite(args.durationSec) && args.durationSec > 0) {
      await sleep(args.durationSec * 1000);
      await shutdown(`--duration ${args.durationSec}s`);
      return 0;
    }
    return new Promise(() => {});
  } catch (err) {
    if (err instanceof DemoError) {
      logger.error(err.message);
      if (err.hint) logger.error(`提示：${err.hint}`);
      await cleanup();
      return 2;
    }
    logger.error(`Demo 启动失败：${err && err.stack ? err.stack : err}`);
    await cleanup();
    return 1;
  }
}

if (require.main === module) {
  main()
    .then((code) => {
      if (code !== undefined) process.exitCode = code;
    })
    .catch((err) => {
      console.error(`未捕获错误：${err && err.stack ? err.stack : err}`);
      process.exitCode = 1;
    });
}

module.exports = { SAMPLE_TASKS, parseArgs, detectLanIp, checkHealth, main };
