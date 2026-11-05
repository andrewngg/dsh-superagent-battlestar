#!/usr/bin/env node
'use strict';

/**
 * BattleStar Hub 启动入口（零依赖）。
 *
 * 用法：
 *   node hub/server.js [--port 7317] [--host 0.0.0.0] [--data-dir hub/data]
 *
 * 环境变量：
 *   BUTLER_ADMIN_TOKEN  固定管理员令牌（缺省自动生成并持久化）
 *   BUTLER_JOIN_CODE    固定设备加入码（缺省自动生成并持久化）
 *   BUTLER_HOST / BUTLER_PORT / BUTLER_DATA_DIR / BUTLER_TTL_MS 同命令行参数（命令行优先）
 */

const fs = require('node:fs');
const path = require('node:path');

const { createHub, startHub, Hub } = require('./lib/hub');

function readPackageVersion() {
  try {
    // eslint-disable-next-line global-require
    const pkg = require('../package.json');
    return typeof pkg.version === 'string' ? pkg.version : '0.1.0';
  } catch {
    return '0.1.0';
  }
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    const eq = arg.indexOf('=');
    const key = eq >= 0 ? arg.slice(0, eq) : arg;
    const inlineValue = eq >= 0 ? arg.slice(eq + 1) : undefined;
    const takeValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      i += 1;
      return i < argv.length ? String(argv[i]) : undefined;
    };
    switch (key) {
      case '--port':
      case '-p':
        options.port = Number(takeValue());
        break;
      case '--host':
        options.host = takeValue();
        break;
      case '--data-dir':
        options.dataDir = takeValue();
        break;
      case '--web-dir':
        options.webDir = takeValue();
        break;
      case '--admin-token':
        options.adminToken = takeValue();
        break;
      case '--join-code':
        options.joinCode = takeValue();
        break;
      case '--ttl-ms':
        options.ttlMs = Number(takeValue());
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--version':
      case '-v':
        options.showVersion = true;
        break;
      default:
        if (key.startsWith('-')) options.unknown = key;
        break;
    }
  }
  return options;
}

function printHelp(version) {
  const lines = [
    `BattleStar Hub v${version}`,
    '',
    '用法：node hub/server.js [选项]',
    '',
    '  --port <端口>        监听端口，默认 7317（0 表示随机端口）',
    '  --host <地址>        监听地址，默认 0.0.0.0',
    '  --data-dir <目录>    状态目录，默认 hub/data（state.json）',
    '  --web-dir <目录>     静态前端目录，默认 hub/web',
    '  --admin-token <值>   固定管理员令牌（也可用 BUTLER_ADMIN_TOKEN）',
    '  --join-code <值>     固定设备加入码（也可用 BUTLER_JOIN_CODE）',
    '  --ttl-ms <毫秒>      设备离线判定 TTL，默认 30000（也可用 BUTLER_TTL_MS）',
    '  -h, --help           显示帮助',
    '  -v, --version        显示版本',
  ];
  console.log(lines.join('\n'));
}

function printStartup(hub, version) {
  const token = encodeURIComponent(hub.adminToken);
  const lan = hub.lanUrl;
  const lines = [
    '',
    `  BattleStar Hub v${version}`,
    `  监听地址    ${hub.host}:${hub.port}`,
    `  管理员令牌  ${hub.adminToken}`,
    `  加入码      ${hub.joinCode}`,
    `  手机控制台  ${lan}/m?token=${token}`,
    `  本机控制台  http://127.0.0.1:${hub.port}/?token=${token}`,
    `  数据目录    ${hub.dataDir}`,
  ];
  if (!fs.existsSync(path.join(hub.webDir, 'index.html'))) {
    lines.push('  提示        hub/web 静态前端尚未就绪，/ 与 /m 暂返回 404（API 不受影响）');
  }
  lines.push('  按 Ctrl+C 停止', '');
  console.log(lines.join('\n'));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const version = readPackageVersion();

  if (options.help) {
    printHelp(version);
    return;
  }
  if (options.showVersion) {
    console.log(version);
    return;
  }
  if (options.unknown) {
    console.error(`[hub] 未知参数：${options.unknown}（用 --help 查看用法）`);
    process.exitCode = 1;
    return;
  }

  const port = Number.isFinite(options.port)
    ? options.port
    : Number(process.env.BUTLER_PORT || process.env.PORT || 7317);
  const host = options.host || process.env.BUTLER_HOST || '0.0.0.0';
  const dataDir = options.dataDir || process.env.BUTLER_DATA_DIR || path.join(__dirname, 'data');
  const webDir = options.webDir || path.join(__dirname, 'web');

  let hub;
  try {
    hub = await startHub({
      port,
      host,
      dataDir,
      webDir,
      version,
      adminToken: options.adminToken || process.env.BUTLER_ADMIN_TOKEN,
      joinCode: options.joinCode || process.env.BUTLER_JOIN_CODE,
      ttlMs: options.ttlMs || Number(process.env.BUTLER_TTL_MS) || undefined,
    });
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`[hub] 端口 ${port} 已被占用，请换一个端口（--port）或停止占用进程。`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  printStartup(hub, version);

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[hub] 收到 ${signal}，正在优雅关闭…`);
    try {
      await hub.close();
      console.log('[hub] 已停止。');
      process.exit(0);
    } catch (err) {
      console.error('[hub] 关闭时出错：', err);
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    console.error('[hub] 未处理的 Promise 拒绝：', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[hub] 未捕获异常：', err);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[hub] 启动失败：', err);
    process.exit(1);
  });
}

module.exports = { createHub, startHub, Hub, readPackageVersion, parseArgs };
