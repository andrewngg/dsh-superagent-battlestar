'use strict';

/**
 * 局域网 Hub 自动发现：扫描本机所有 IPv4 /24 网段的指定端口，
 * 请求 /api/health 并根据协议标识识别 BattleStar Hub。
 *
 * 零依赖；只用于 Hub IP 变化后的兜底，不替代配置里的固定地址。
 */

const http = require('node:http');
const os = require('node:os');

const DEFAULT_PORT = 7317;

function hubPortFromUrl(hubUrl, fallback = DEFAULT_PORT) {
  try {
    const url = new URL(String(hubUrl || ''));
    const port = Number(url.port);
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
  } catch {
    /* ignore */
  }
  return fallback;
}

function buildCandidates() {
  const targets = new Set();
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (!entry || entry.family !== 'IPv4' || entry.internal) continue;
      const host = String(entry.address || '');
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) continue;
      if (host.startsWith('127.') || host.startsWith('169.254.')) continue;
      const parts = host.split('.');
      const prefix = `${parts[0]}.${parts[1]}.${parts[2]}.`;
      // 自己也可能就是母机（例如 Hub 和桥在同一台电脑），所以不排除本机 LAN IP。
      for (let i = 1; i <= 254; i += 1) targets.add(`${prefix}${i}`);
    }
  }
  return [...targets];
}

function probeHub(ip, port, timeoutMs = 700) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = http.get(
      { host: ip, port, path: '/api/health', timeout: timeoutMs, headers: { Accept: 'application/json' } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (body.length < 64 * 1024) body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) return finish(null);
          try {
            const json = JSON.parse(body);
            if (!json || json.ok !== true || !Number.isFinite(Number(json.protocol))) return finish(null);
            return finish({
              baseUrl: `http://${ip}:${port}`,
              ip,
              port,
              name: typeof json.name === 'string' ? json.name : 'BattleStar',
              version: typeof json.version === 'string' ? json.version : '',
              protocol: Number(json.protocol),
            });
          } catch {
            return finish(null);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => finish(null));
  });
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

async function discoverHub(options = {}) {
  const port = Number.isInteger(options.port) ? options.port : DEFAULT_PORT;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 700;
  const concurrency = Number.isInteger(options.concurrency) ? options.concurrency : 48;
  const candidates = buildCandidates();
  if (!candidates.length) return null;
  const found = await mapLimit(candidates, concurrency, (ip) => probeHub(ip, port, timeoutMs));
  const hubs = found.filter(Boolean);
  if (!hubs.length) return null;
  hubs.sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
  return hubs[0];
}

module.exports = {
  DEFAULT_PORT,
  hubPortFromUrl,
  buildCandidates,
  probeHub,
  discoverHub,
};
