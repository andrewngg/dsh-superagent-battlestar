'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startTestHub,
  request,
  makeManifest,
  registerDevice,
  adminHeaders,
  deviceHeaders,
} = require('./_helpers.js');

test('GET /api/health 公开，其余管理接口要求管理员令牌', async (t) => {
  const env = await startTestHub(t);

  const health = await request(env.base, 'GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  assert.equal(health.json.name, 'BattleStar');
  assert.equal(health.json.protocol, 1);
  assert.equal(typeof health.json.version, 'string');
  assert.equal(typeof health.json.uptimeSec, 'number');
  assert.ok(Date.parse(health.json.hubTime) > 0);

  const missing = await request(env.base, 'GET', '/api/devices');
  assert.equal(missing.status, 401);
  assert.equal(missing.json.error.code, 'unauthorized');
  assert.equal(typeof missing.json.error.message, 'string');

  const wrong = await request(env.base, 'GET', '/api/devices', {
    headers: { 'x-butler-token': 'adm_wrong' },
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.error.code, 'unauthorized');

  const ok = await request(env.base, 'GET', '/api/devices', { headers: adminHeaders(env) });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.devices, []);
  assert.ok(Date.parse(ok.json.hubTime) > 0);

  const unknown = await request(env.base, 'GET', '/api/not-exist', { headers: adminHeaders(env) });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, 'not_found');
});

test('设备注册：加入码必需且必须正确，manifest 非法返回 400', async (t) => {
  const env = await startTestHub(t);

  const noCode = await request(env.base, 'POST', '/api/devices/register', {
    body: makeManifest(),
  });
  assert.equal(noCode.status, 401);
  assert.equal(noCode.json.error.code, 'unauthorized');

  const badCode = await request(env.base, 'POST', '/api/devices/register', {
    headers: { 'x-butler-join-code': 'join_wrong' },
    body: makeManifest(),
  });
  assert.equal(badCode.status, 403);
  assert.equal(badCode.json.error.code, 'forbidden');

  const badManifest = await request(env.base, 'POST', '/api/devices/register', {
    headers: { 'x-butler-join-code': env.joinCode },
    body: { platform: 'windows', kind: 'dsh' },
  });
  assert.equal(badManifest.status, 400);
  assert.equal(badManifest.json.error.code, 'bad_request');
  assert.match(badManifest.json.error.message, /name/);

  const malformedJson = await request(env.base, 'POST', '/api/devices/register', {
    headers: { 'x-butler-join-code': env.joinCode, 'content-type': 'application/json' },
    body: '{"name":',
  });
  assert.equal(malformedJson.status, 400);
  assert.equal(malformedJson.json.error.code, 'bad_request');

  const ok = await request(env.base, 'POST', '/api/devices/register', {
    headers: { 'x-butler-join-code': env.joinCode },
    body: makeManifest({ name: '书房工作站' }),
  });
  assert.equal(ok.status, 200);
  assert.match(ok.json.deviceId, /^dev_[a-z0-9]+$/);
  assert.ok(ok.json.deviceToken);
  assert.equal(ok.json.heartbeatIntervalMs, 10000);
  assert.equal(ok.json.ttlSec, 30);
  assert.ok(Date.parse(ok.json.hubTime) > 0);
});

test('设备令牌只能访问自己的 /api/devices/:id/*，管理令牌可访问全部', async (t) => {
  const env = await startTestHub(t);
  const deviceA = await registerDevice(env, makeManifest({ name: '设备 A' }));
  const deviceB = await registerDevice(env, makeManifest({ name: '设备 B' }));

  const own = await request(env.base, 'POST', `/api/devices/${deviceA.deviceId}/heartbeat`, {
    headers: deviceHeaders(deviceA),
    body: { status: 'idle' },
  });
  assert.equal(own.status, 200);
  assert.deepEqual(own.json.commands, []);

  const cross = await request(env.base, 'POST', `/api/devices/${deviceB.deviceId}/heartbeat`, {
    headers: deviceHeaders(deviceA),
    body: {},
  });
  assert.equal(cross.status, 403);
  assert.equal(cross.json.error.code, 'forbidden');

  const asAdmin = await request(env.base, 'POST', `/api/devices/${deviceB.deviceId}/heartbeat`, {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(asAdmin.status, 200);

  const noToken = await request(env.base, 'POST', `/api/devices/${deviceA.deviceId}/heartbeat`, {
    body: {},
  });
  assert.equal(noToken.status, 401);

  // 设备令牌不能访问管理员接口
  const deviceOnAdmin = await request(env.base, 'GET', '/api/snapshot', {
    headers: deviceHeaders(deviceA),
  });
  assert.equal(deviceOnAdmin.status, 403);
  assert.equal(deviceOnAdmin.json.error.code, 'forbidden');

  // 伪造管理员令牌访问设备接口
  const fakeAdmin = await request(env.base, 'POST', `/api/devices/${deviceA.deviceId}/heartbeat`, {
    headers: { 'x-butler-token': 'adm_fake' },
    body: {},
  });
  assert.equal(fakeAdmin.status, 401);
});

test('已注册设备可用 deviceId + 设备令牌恢复注册并更新 manifest', async (t) => {
  const env = await startTestHub(t);
  const device = await registerDevice(env, makeManifest({ name: '旧名字' }));

  const restored = await request(env.base, 'POST', '/api/devices/register', {
    headers: {
      'x-butler-device-id': device.deviceId,
      'x-butler-device-token': device.deviceToken,
    },
    body: makeManifest({ name: '新名字', skills: [{ id: 'office-pdf', name: 'PDF' }] }),
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.json.deviceId, device.deviceId);
  assert.equal(restored.json.deviceToken, device.deviceToken);

  const detail = await request(env.base, 'GET', `/api/devices/${device.deviceId}`, {
    headers: adminHeaders(env),
  });
  assert.equal(detail.status, 200);
  assert.equal(detail.json.device.name, '新名字');
  assert.deepEqual(
    detail.json.device.capabilities.skills.map((skill) => skill.id),
    ['office-pdf'],
  );

  const badToken = await request(env.base, 'POST', '/api/devices/register', {
    headers: { 'x-butler-device-id': device.deviceId, 'x-butler-device-token': 'dtok_bad' },
    body: makeManifest(),
  });
  assert.equal(badToken.status, 403);

  const unknownDevice = await request(env.base, 'POST', '/api/devices/register', {
    headers: { 'x-butler-device-id': 'dev_missing', 'x-butler-device-token': device.deviceToken },
    body: makeManifest(),
  });
  assert.equal(unknownDevice.status, 404);
  assert.equal(unknownDevice.json.error.code, 'not_found');
});
