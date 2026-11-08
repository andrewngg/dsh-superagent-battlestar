'use strict';

/**
 * DSH bridge 地址：桌面版 DSH 每次启动端口可能变化，Hub 必须能在运行时被插件改写，
 * 并把新地址落盘，保证 Hub 重启后仍然指向正确的 DSH Web 端口。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const {
  makeTempDir,
  startTestHub,
  startHubAt,
  request,
  adminHeaders,
} = require('./_helpers.js');

function startFakeDsh(t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      seen.push({ method: req.method, url: req.url, body });
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.url === '/super-butler/api/dsh/status') {
        return send(200, { ok: true, session: { id: 'fake-session' }, seen: seen.length });
      }
      if (req.url === '/super-butler/api/dsh/chat') {
        return send(200, { job: { id: 'job_fake_1', status: 'running' }, echo: body });
      }
      return send(404, { error: { code: 'not_found', message: '未知路由' } });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      t.after(() => {
        server.close();
      });
      resolve({ origin, bridge: `${origin}/super-butler/api/dsh`, seen });
    });
  });
}

test('GET/POST /api/dsh/bridge requires the admin token', async (t) => {
  const env = await startTestHub(t);
  const unauth = await request(env.base, 'GET', '/api/dsh/bridge');
  assert.equal(unauth.status, 401);
  const unauthPost = await request(env.base, 'POST', '/api/dsh/bridge', { body: { url: 'http://127.0.0.1:1/x' } });
  assert.equal(unauthPost.status, 401);
});

test('POST /api/dsh/bridge validates the URL and updates the running bridge', async (t) => {
  const env = await startTestHub(t);
  const before = await request(env.base, 'GET', '/api/dsh/bridge', { headers: adminHeaders(env) });
  assert.equal(before.status, 200);
  assert.match(before.json.url, /^http:\/\/127\.0\.0\.1:\d+\/super-butler\/api\/dsh$/);

  const bad = await request(env.base, 'POST', '/api/dsh/bridge', {
    headers: adminHeaders(env),
    body: { url: 'ftp://example.com/bridge' },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'bad_request');

  const fake = await startFakeDsh(t);
  const saved = await request(env.base, 'POST', '/api/dsh/bridge', {
    headers: adminHeaders(env),
    body: { url: fake.bridge },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.url, fake.bridge);

  const after = await request(env.base, 'GET', '/api/dsh/bridge', { headers: adminHeaders(env) });
  assert.equal(after.json.url, fake.bridge);
});

test('the dev bridge proxies status/chat through the synced DSH address', async (t) => {
  const env = await startTestHub(t);
  const fake = await startFakeDsh(t);
  await request(env.base, 'POST', '/api/dsh/bridge', {
    headers: adminHeaders(env),
    body: { url: fake.bridge },
  });

  const status = await request(env.base, 'GET', '/api/dsh/status', { headers: adminHeaders(env) });
  assert.equal(status.status, 200);
  assert.equal(status.json.ok, true);
  assert.equal(status.json.session.id, 'fake-session');

  const chat = await request(env.base, 'POST', '/api/dsh/chat', {
    headers: adminHeaders(env),
    body: { message: '把按钮改成两列', scope: 'global' },
  });
  assert.equal(chat.status, 200);
  assert.equal(chat.json.job.id, 'job_fake_1');
  const forwarded = fake.seen.find((item) => item.url === '/super-butler/api/dsh/chat');
  assert.ok(forwarded, 'chat must be forwarded to the DSH plugin route');
  assert.equal(forwarded.body.message, '把按钮改成两列');
  assert.equal(forwarded.body.scope, 'global');
});

test('a bridge URL written by the plugin heals a Hub that started with the old port', async (t) => {
  const env = await startTestHub(t);
  // 先让 Hub 记住旧地址（默认端口），模拟「Hub 比 DSH 先启动、手里还是旧端口」。
  const initial = await request(env.base, 'GET', '/api/dsh/bridge', { headers: adminHeaders(env) });
  assert.equal(initial.status, 200);

  const fake = await startFakeDsh(t);
  await fs.promises.writeFile(
    path.join(env.dataDir, 'dsh-bridge.json'),
    `${JSON.stringify({ url: fake.bridge, source: 'dsh-plugin' }, null, 2)}\n`,
    'utf8',
  );

  // 不发 POST：请求失败后 Hub 应自己重读文件、换新地址并重试一次。
  const status = await request(env.base, 'GET', '/api/dsh/status', { headers: adminHeaders(env) });
  assert.equal(status.status, 200);
  assert.equal(status.json.session.id, 'fake-session');
  const now = await request(env.base, 'GET', '/api/dsh/bridge', { headers: adminHeaders(env) });
  assert.equal(now.json.url, fake.bridge);
});

test('the synced bridge survives a Hub restart', async (t) => {
  const dataDir = await makeTempDir('butler-hub-bridge-');
  t.after(() => fs.promises.rm(dataDir, { recursive: true, force: true }));
  const bridge = 'http://127.0.0.1:60974/super-butler/api/dsh';

  const first = await startHubAt(dataDir);
  try {
    const saved = await request(first.base, 'POST', '/api/dsh/bridge', {
      headers: adminHeaders(first),
      body: { url: bridge },
    });
    assert.equal(saved.status, 200);
  } finally {
    await first.hub.close();
  }

  const stored = JSON.parse(
    await fs.promises.readFile(path.join(dataDir, 'dsh-bridge.json'), 'utf8'),
  );
  assert.equal(stored.url, bridge);

  const second = await startHubAt(dataDir);
  try {
    const res = await request(second.base, 'GET', '/api/dsh/bridge', { headers: adminHeaders(second) });
    assert.equal(res.status, 200);
    assert.equal(res.json.url, bridge, 'a restarted Hub must reuse the persisted bridge URL');
  } finally {
    await second.hub.close();
  }
});
