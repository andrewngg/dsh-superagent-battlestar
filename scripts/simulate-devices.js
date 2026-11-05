#!/usr/bin/env node
'use strict';

/**
 * 启动 3 台模拟设备（用于 demo 与本地联调）：
 *   1. 书房工作站  —— DSH / Windows / deepseek-chat + deepseek-reasoner / office 技能 / 并发 2
 *   2. 客厅媒体中心 —— Ollama / Linux / qwen2.5 / 家居技能 / 并发 1
 *   3. 手机 Pixel   —— DSH / Android / deepseek-chat / 手机技能 / 并发 1
 *
 * 每台设备是一个独立子进程（node device-agent/agent.js），默认把日志写入 stateDir/logs/<key>.log。
 * Ctrl+C 会向子进程发送 SIGINT，让设备优雅注销退出，避免留下孤儿进程。
 *
 * 用法：
 *   node scripts/simulate-devices.js --hub http://127.0.0.1:7317 --join-code demo-join-code
 *   node scripts/simulate-devices.js --hub http://127.0.0.1:7317 --join-code XXX --log inherit
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { createLogger } = require('../device-agent/lib/logger');
const { normalizeBaseUrl } = require('../device-agent/lib/http');

const REPO_ROOT = path.resolve(__dirname, '..');
const AGENT_ENTRY = path.join(REPO_ROOT, 'device-agent', 'agent.js');
const DEFAULT_STATE_DIR = path.join(REPO_ROOT, 'tmp', 'demo', 'devices');

// 三台设备的差异化能力（全部通过 --config 显式申报，不依赖本机探测）
const DEVICE_PROFILES = [
  {
    key: 'desktop',
    name: '书房工作站',
    executor: { type: 'simulate', simulate: { minDurationMs: 2000, maxDurationMs: 6000, minSteps: 3, maxSteps: 6 } },
    manifest: {
      name: '书房工作站',
      platform: 'windows',
      kind: 'dsh',
      tags: ['书房', '夜间可跑', 'Windows'],
      models: [
        {
          id: 'deepseek-chat',
          provider: 'deepseek',
          contextWindow: 128000,
          strengths: ['code', 'reasoning', 'writing'],
          available: true,
        },
        {
          id: 'deepseek-reasoner',
          provider: 'deepseek',
          contextWindow: 128000,
          strengths: ['reasoning', 'math'],
          available: true,
        },
      ],
      profiles: [
        {
          id: 'desktop',
          name: 'DSH Desktop',
          plugins: ['@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-base'],
        },
      ],
      gateways: [
        {
          id: 'openai-gateway',
          kind: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:8787/v1',
          models: ['gpt-4o-mini'],
        },
      ],
      skills: [
        { id: 'office-docx', name: 'Word 文档', version: '1.0.0' },
        { id: 'office-xlsx', name: 'Excel 表格', version: '1.0.0' },
        { id: 'office-pptx', name: 'PPT 演示', version: '1.0.0' },
        { id: 'web-research', name: '联网调研', version: '1.0.0' },
      ],
      resources: { cpuCores: 16, memoryGB: 32, gpu: 'RTX 4070', os: 'Windows 11' },
      limits: { maxConcurrentTasks: 2 },
    },
  },
  {
    key: 'media',
    name: '客厅媒体中心',
    executor: { type: 'simulate', simulate: { minDurationMs: 1500, maxDurationMs: 4000, minSteps: 3, maxSteps: 5 } },
    manifest: {
      name: '客厅媒体中心',
      platform: 'linux',
      kind: 'ollama',
      tags: ['客厅', '常开', '影音'],
      models: [
        {
          id: 'qwen2.5',
          provider: 'ollama',
          contextWindow: 32768,
          strengths: ['chat', 'writing', 'vision'],
          available: true,
        },
      ],
      profiles: [],
      gateways: [],
      skills: [
        { id: 'home-control', name: '家居控制', version: '0.9.0' },
        { id: 'media-player', name: '影音播放', version: '1.1.0' },
        { id: 'photo-album', name: '相册整理', version: '0.8.0' },
      ],
      resources: { cpuCores: 4, memoryGB: 8, gpu: '', os: 'Linux 6.6' },
      limits: { maxConcurrentTasks: 1 },
    },
  },
  {
    key: 'phone',
    name: '手机 Pixel',
    executor: { type: 'simulate', simulate: { minDurationMs: 1000, maxDurationMs: 3000, minSteps: 3, maxSteps: 5 } },
    manifest: {
      name: '手机 Pixel',
      platform: 'android',
      kind: 'dsh',
      tags: ['随身', '移动', 'Android'],
      models: [
        {
          id: 'deepseek-chat',
          provider: 'deepseek',
          contextWindow: 128000,
          strengths: ['chat', 'writing'],
          available: true,
        },
      ],
      profiles: [
        { id: 'mobile', name: 'DSH Mobile', plugins: ['@deepseek-ai/dsh-web-app'] },
      ],
      gateways: [],
      skills: [
        { id: 'android-control', name: '手机控制', version: '0.5.0' },
        { id: 'notifications', name: '通知提醒', version: '0.6.0' },
        { id: 'camera', name: '拍照记录', version: '0.4.0' },
      ],
      resources: { cpuCores: 8, memoryGB: 8, gpu: '', os: 'Android 15' },
      limits: { maxConcurrentTasks: 1 },
    },
  },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** profile → agent 的 --config JSON（能力全显式，关闭本机探测保证 demo 可复现）。 */
function buildDeviceConfig(profile) {
  return {
    ...profile.manifest,
    executor: profile.executor,
    discovery: { dsh: false, ollama: false, gateway: false, skills: false },
  };
}

function resolveOptions(options = {}) {
  return {
    hub: normalizeBaseUrl(options.hub || 'http://127.0.0.1:7317'),
    joinCode: options.joinCode || 'demo-join-code',
    stateDir: path.resolve(options.stateDir || DEFAULT_STATE_DIR),
    logMode: options.logMode === 'inherit' ? 'inherit' : 'file',
    verbose: Boolean(options.verbose),
    stopTimeoutMs: Number.isFinite(options.stopTimeoutMs) ? options.stopTimeoutMs : 6000,
  };
}

/**
 * 启动全部模拟设备（子进程）。
 * @param {object} [options]
 * @returns {Promise<{devices:Array, options:object, stop:Function}>}
 */
async function startDevices(options = {}) {
  const opts = resolveOptions(options);
  const logger = options.logger || createLogger({ level: 'info', prefix: 'devices' });

  await fsp.mkdir(path.join(opts.stateDir, 'configs'), { recursive: true });
  await fsp.mkdir(path.join(opts.stateDir, 'logs'), { recursive: true });

  const devices = [];
  let stopping = false;

  for (const profile of DEVICE_PROFILES) {
    const configFile = path.join(opts.stateDir, 'configs', `${profile.key}.json`);
    await fsp.writeFile(configFile, `${JSON.stringify(buildDeviceConfig(profile), null, 2)}\n`, 'utf8');

    const args = [
      AGENT_ENTRY,
      '--hub',
      opts.hub,
      '--join-code',
      opts.joinCode,
      '--name',
      profile.name,
      '--config',
      configFile,
      '--state-dir',
      path.join(opts.stateDir, 'agents', profile.key),
    ];
    if (opts.verbose) args.push('--log-level', 'debug');

    const logFile = path.join(opts.stateDir, 'logs', `${profile.key}.log`);
    let child;
    if (opts.logMode === 'inherit') {
      child = spawn(process.execPath, args, {
        cwd: REPO_ROOT,
        env: process.env,
        stdio: 'inherit',
        windowsHide: true,
      });
    } else {
      // 注意：不能用 pipe（受限沙箱会 EPERM），直接重定向到日志文件
      const outFd = fs.openSync(logFile, 'a');
      const errFd = fs.openSync(logFile, 'a');
      try {
        child = spawn(process.execPath, args, {
          cwd: REPO_ROOT,
          env: process.env,
          stdio: ['ignore', outFd, errFd],
          windowsHide: true,
        });
      } finally {
        fs.closeSync(outFd);
        fs.closeSync(errFd);
      }
    }

    const entry = { key: profile.key, name: profile.name, configFile, logFile, child, exit: null };
    child.on('exit', (code, signal) => {
      entry.exit = { code, signal };
      if (!stopping) logger.warn(`设备「${profile.name}」进程退出（code=${code} signal=${signal}），日志：${logFile}`);
    });
    child.on('error', (err) => logger.error(`设备「${profile.name}」启动失败：${err.message}`));
    devices.push(entry);
  }

  logger.info(`已启动 ${devices.length} 台模拟设备 → ${opts.hub}（加入码 ${opts.joinCode}）`);
  for (const device of devices) {
    logger.info(`  · ${device.name}（日志 ${device.logFile}）`);
  }

  async function stop() {
    if (stopping) return;
    stopping = true;
    const active = devices.filter((device) => !device.exit);
    for (const device of active) {
      try {
        device.child.kill('SIGINT');
      } catch {
        /* ignore */
      }
    }
    const deadline = Date.now() + opts.stopTimeoutMs;
    while (active.some((device) => !device.exit) && Date.now() < deadline) {
      await sleep(100);
    }
    for (const device of active) {
      if (device.exit) continue;
      try {
        device.child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }

  return { devices, options: opts, stop };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv = []) {
  const result = {};
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
      case '--join-code':
        result.joinCode = take();
        break;
      case '--state-dir':
        result.stateDir = take();
        break;
      case '--log':
        result.logMode = take();
        break;
      case '--duration':
        result.durationSec = Number(take());
        break;
      case '--verbose':
        result.verbose = true;
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
      'BattleStar 模拟设备启动器',
      '',
      '用法：node scripts/simulate-devices.js [选项]',
      '',
      '  --hub <url>          Hub 地址，默认 http://127.0.0.1:7317',
      '  --join-code <code>  设备加入码，默认 demo-join-code',
      '  --state-dir <dir>   配置/日志/状态目录，默认 tmp/demo/devices',
      '  --log <mode>        file（默认，写日志文件）| inherit（输出到当前终端）',
      '  --duration <秒>     运行指定秒数后自动退出（便于自动化验证）',
      '  --verbose           设备日志使用 debug 级别',
      '  -h, --help          显示帮助',
      '',
      '启动后每台设备会独立注册、心跳、领任务并执行（simulate 执行器）。',
    ].join('\n'),
  );
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

  const logger = createLogger({ level: args.verbose ? 'debug' : 'info', prefix: 'devices' });
  const handle = await startDevices({
    hub: args.hub,
    joinCode: args.joinCode,
    stateDir: args.stateDir,
    logMode: args.logMode,
    verbose: args.verbose,
    logger,
  });

  let closing = false;
  const shutdown = async (reason) => {
    if (closing) return;
    closing = true;
    logger.info(`收到 ${reason}，正在停止模拟设备…`);
    await handle.stop();
    logger.info('全部模拟设备已停止');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  if (Number.isFinite(args.durationSec) && args.durationSec > 0) {
    setTimeout(() => void shutdown(`--duration ${args.durationSec}s`), args.durationSec * 1000);
  }
  logger.info('按 Ctrl+C 停止全部设备');
  return new Promise(() => {});
}

if (require.main === module) {
  main()
    .then((code) => {
      if (code) process.exitCode = code;
    })
    .catch((err) => {
      console.error(`启动失败：${err && err.message ? err.message : err}`);
      process.exitCode = 1;
    });
}

module.exports = { DEVICE_PROFILES, buildDeviceConfig, startDevices, resolveOptions };
