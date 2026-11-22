'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startTestHub,
  makeManifest,
  request,
  adminHeaders,
  deviceHeaders,
  registerDevice,
  heartbeat,
  readStateFile,
  openSse,
  waitFor,
} = require('./_helpers.js');

const JOIN_CODE_RE = /^join_[0-9a-f]{16,}$/;

test('加入码：管理员可轮换，旧码立即失效、新码可注册，并持久化到 state.json', async (t) => {
  const env = await startTestHub(t);
  const oldCode = env.joinCode;
  assert.match(oldCode, JOIN_CODE_RE);

  const current = await request(env.base, 'GET', '/api/admin/join-code', {
    headers: adminHeaders(env),
  });
  assert.equal(current.status, 200);
  assert.equal(current.json.joinCode, oldCode);
  assert.ok(Date.parse(current.json.hubTime) > 0);

  const rotated = await request(env.base, 'POST', '/api/admin/join-code', {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(rotated.status, 200);
  const newCode = rotated.json.joinCode;
  assert.match(newCode, JOIN_CODE_RE);
  assert.notEqual(newCode, oldCode);
  assert.equal(rotated.json.joinCode, env.hub.joinCode);

  // 旧码立即失效，新码可以注册
  const withOld = await request(env.base, 'POST', '/api/devices/register', {
    headers: { 'x-butler-join-code': oldCode },
    body: makeManifest(),
  });
  assert.equal(withOld.status, 403);
  assert.equal(withOld.json.error.code, 'forbidden');

  const withNew = await request(env.base, 'POST', '/api/devices/register', {
    headers: { 'x-butler-join-code': newCode },
    body: makeManifest(),
  });
  assert.equal(withNew.status, 200);
  assert.equal(withNew.json.joinCode, newCode);

  // 轮换结果已持久化（Hub 停掉后重启也从 state.json 读新码）
  const state = await waitFor(
    async () => {
      const file = await readStateFile(env.dataDir).catch(() => null);
      return file && file.joinCode === newCode ? file : null;
    },
    { label: 'state.json 写入新加入码' },
  );
  assert.equal(state.joinCode, newCode);

  // 管理端快照与设置接口同步下发当前加入码
  const snap = await request(env.base, 'GET', '/api/snapshot', { headers: adminHeaders(env) });
  assert.equal(snap.status, 200);
  assert.equal(snap.json.joinCode, newCode);
  const settings = await request(env.base, 'GET', '/api/settings', { headers: adminHeaders(env) });
  assert.equal(settings.status, 200);
  assert.equal(settings.json.joinCode, newCode);
});

test('加入码：注册/心跳/manifest 响应都下发当前加入码，供设备自动同步', async (t) => {
  const env = await startTestHub(t);
  const device = await registerDevice(env, makeManifest());
  assert.equal(device.response.json.joinCode, env.joinCode);

  const rotated = await request(env.base, 'POST', '/api/admin/join-code', {
    headers: adminHeaders(env),
    body: {},
  });
  const newCode = rotated.json.joinCode;

  const hb = await heartbeat(env, device, { status: 'idle' });
  assert.equal(hb.status, 200);
  assert.equal(hb.json.joinCode, newCode);

  const manifestRes = await request(
    env.base,
    'POST',
    `/api/devices/${device.deviceId}/manifest`,
    { headers: deviceHeaders(device), body: makeManifest({ name: '改名后的设备' }) },
  );
  assert.equal(manifestRes.status, 200);
  assert.equal(manifestRes.json.joinCode, newCode);
  assert.equal(manifestRes.json.device.name, '改名后的设备');
});

test('加入码管理接口鉴权：无令牌 401、设备令牌 403，失败不轮换', async (t) => {
  const env = await startTestHub(t);
  const device = await registerDevice(env, makeManifest());

  const noToken = await request(env.base, 'GET', '/api/admin/join-code');
  assert.equal(noToken.status, 401);
  assert.equal(noToken.json.error.code, 'unauthorized');

  const viaDevice = await request(env.base, 'POST', '/api/admin/join-code', {
    headers: deviceHeaders(device),
    body: {},
  });
  assert.equal(viaDevice.status, 403);
  assert.equal(viaDevice.json.error.code, 'forbidden');

  const current = await request(env.base, 'GET', '/api/admin/join-code', {
    headers: adminHeaders(env),
  });
  assert.equal(current.json.joinCode, env.joinCode);
});

test('加入码轮换广播 SSE joinCode.updated（不写事件历史）', async (t) => {
  const env = await startTestHub(t);
  const sse = openSse(env);
  await sse.ready;
  t.after(() => sse.close());
  await sse.waitForEvent('snapshot', { timeout: 3000 });

  const rotated = await request(env.base, 'POST', '/api/admin/join-code', {
    headers: adminHeaders(env),
    body: {},
  });
  const newCode = rotated.json.joinCode;

  const event = await sse.waitForEvent('joinCode.updated', { timeout: 3000 });
  assert.equal(event.data.joinCode, newCode);
  assert.ok(Date.parse(event.data.hubTime) > 0);

  // record:false：不把明文加入码写进事件历史
  assert.ok(!env.hub.snapshot(50).events.some((item) => item.type === 'joinCode.updated'));
});
