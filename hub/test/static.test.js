'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { startTestHub, request } = require('./_helpers.js');

test('静态文件：web 未就绪返回 404 不崩；/、/m、/assets 与 MIME 正确', async (t) => {
  const env = await startTestHub(t);

  // hub/web 尚不存在时：页面 404，但 API 正常
  const missing = await request(env.base, 'GET', '/');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'not_found');
  const health = await request(env.base, 'GET', '/api/health');
  assert.equal(health.status, 200);

  // 模拟前端产物就绪
  await fs.promises.mkdir(path.join(env.webDir, 'assets'), { recursive: true });
  await fs.promises.mkdir(path.join(env.webDir, 'm'), { recursive: true });
  await fs.promises.writeFile(
    path.join(env.webDir, 'index.html'),
    '<!doctype html><html><body>desktop-console</body></html>',
  );
  await fs.promises.writeFile(
    path.join(env.webDir, 'm', 'index.html'),
    '<!doctype html><html><body>mobile-console</body></html>',
  );
  await fs.promises.writeFile(path.join(env.webDir, 'assets', 'app.js'), 'console.log("app");');
  await fs.promises.writeFile(path.join(env.webDir, 'assets', 'style.css'), 'body{color:red}');

  const root = await request(env.base, 'GET', '/');
  assert.equal(root.status, 200);
  assert.match(root.text, /desktop-console/);
  assert.match(String(root.headers['content-type']), /text\/html/);

  const mobile = await request(env.base, 'GET', '/m?token=fake');
  assert.equal(mobile.status, 200);
  assert.match(mobile.text, /mobile-console/);

  const asset = await request(env.base, 'GET', '/assets/app.js');
  assert.equal(asset.status, 200);
  assert.match(String(asset.headers['content-type']), /javascript/);
  assert.match(asset.text, /console\.log/);

  const css = await request(env.base, 'GET', '/assets/style.css');
  assert.equal(css.status, 200);
  assert.match(String(css.headers['content-type']), /text\/css/);

  // m/index.html 不存在时 /m 回退到 index.html
  await fs.promises.rm(path.join(env.webDir, 'm', 'index.html'));
  const fallback = await request(env.base, 'GET', '/m');
  assert.equal(fallback.status, 200);
  assert.match(fallback.text, /desktop-console/);

  // HEAD 请求
  const head = await request(env.base, 'HEAD', '/');
  assert.equal(head.status, 200);
  assert.equal(head.text, '');

  // 不存在的文件
  const unknown = await request(env.base, 'GET', '/nope.js');
  assert.equal(unknown.status, 404);

  // 路径穿越（编码后不会被客户端 URL 规范化掉）
  const traversal = await request(env.base, 'GET', '/assets/%2e%2e/%2e%2e/package.json');
  assert.equal(traversal.status, 404);
  assert.equal(traversal.json.error.code, 'not_found');

  const nulByte = await request(env.base, 'GET', '/assets/app%00.js');
  assert.equal(nulByte.status, 404);
});

test('静态页面不拦截 /api/*，未知 API 返回统一错误', async (t) => {
  const env = await startTestHub(t);
  const unknownApi = await request(env.base, 'GET', '/api/unknown');
  assert.equal(unknownApi.status, 404);
  assert.equal(unknownApi.json.error.code, 'not_found');
  const unknownApiWithToken = await request(env.base, 'GET', '/api/unknown', {
    headers: { 'x-butler-token': env.adminToken },
  });
  assert.equal(unknownApiWithToken.status, 404);
});
