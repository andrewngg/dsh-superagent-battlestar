'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startTestHub,
  makeManifest,
  registerDevice,
  heartbeat,
  ackTask,
  resultTask,
  createTask,
  openSse,
  request,
  adminHeaders,
  waitFor,
} = require('./_helpers.js');

test('SSE 鉴权与首帧 snapshot', async (t) => {
  const env = await startTestHub(t);

  const unauthorized = await request(env.base, 'GET', '/api/events');
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.json.error.code, 'unauthorized');

  const sse = openSse(env);
  const state = await sse.ready;
  assert.equal(state.status, 200);
  const first = await sse.waitForEvent('snapshot', { timeout: 3000 });
  assert.ok(first.data.server);
  assert.equal(typeof first.data.server.version, 'string');
  assert.equal(first.data.stats.devicesTotal, 0);
  assert.deepEqual(first.data.devices, []);
  assert.deepEqual(first.data.tasks, []);
  assert.ok(Array.isArray(first.data.events));

  // SSE 也支持管理员令牌走请求头
  const viaHeader = openSse(env, { token: null, headers: { 'x-butler-token': env.adminToken } });
  const headerState = await viaHeader.ready;
  assert.equal(headerState.status, 200);
  await viaHeader.waitForEvent('snapshot');
  viaHeader.close();

  sse.close();
  await waitFor(() => env.hub.sseClients.size === 0, { label: '断开后清理 SSE 连接' });
});

test('SSE 推送 device/task 事件与 ping', async (t) => {
  const env = await startTestHub(t, { pingIntervalMs: 80 });
  const sse = openSse(env);
  await sse.ready;
  await sse.waitForEvent('snapshot');

  const device = await registerDevice(env, makeManifest({ name: 'SSE 设备' }));
  const deviceEvent = await sse.waitForEvent('device.updated', {
    predicate: (data) => data.device && data.device.id === device.deviceId,
  });
  assert.equal(deviceEvent.data.device.online, true);

  const task = await createTask(env, {
    instruction: 'SSE 任务',
    requirements: { deviceId: device.deviceId },
  });
  await sse.waitForEvent('task.created', { predicate: (data) => data.task && data.task.id === task.id });
  await sse.waitForEvent('task.updated', {
    predicate: (data) => data.task && data.task.id === task.id && data.task.status === 'assigned',
  });

  await ackTask(env, device, task.id);
  await sse.waitForEvent('task.updated', {
    predicate: (data) => data.task && data.task.id === task.id && data.task.status === 'running',
  });

  await resultTask(env, device, task.id, { ok: true, output: { text: '完成' } });
  const completed = await sse.waitForEvent('task.completed', {
    predicate: (data) => data.task && data.task.id === task.id,
  });
  assert.equal(completed.data.task.status, 'completed');

  // 心跳保活
  await sse.waitForEvent('ping', { timeout: 3000 });
  assert.ok(sse.events.some((event) => event.event === 'log'), '应至少收到一条 log 事件');
  sse.close();
});

test('SSE 推送 device.offline / device.online', async (t) => {
  const env = await startTestHub(t, { ttlMs: 250 });
  const sse = openSse(env);
  await sse.ready;
  await sse.waitForEvent('snapshot');

  const device = await registerDevice(env, makeManifest({ name: '会掉线的设备' }));
  await sse.waitForEvent('device.updated', {
    predicate: (data) => data.device && data.device.id === device.deviceId,
  });

  const offline = await sse.waitForEvent('device.offline', {
    timeout: 5000,
    predicate: (data) => data.deviceId === device.deviceId,
  });
  assert.equal(offline.data.deviceId, device.deviceId);
  assert.equal(offline.data.name, '会掉线的设备');
  assert.ok(Date.parse(offline.data.at) > 0);

  await heartbeat(env, device, { status: 'idle' });
  const online = await sse.waitForEvent('device.online', {
    timeout: 3000,
    predicate: (data) => data.deviceId === device.deviceId,
  });
  assert.equal(online.data.name, '会掉线的设备');

  sse.close();
});

test('快照 limit 只截断任务与事件，设备始终完整', async (t) => {
  const env = await startTestHub(t);
  const device = await registerDevice(env, makeManifest());
  for (let i = 0; i < 3; i += 1) {
    await createTask(env, { instruction: `任务 ${i}`, requirements: { deviceId: device.deviceId } });
  }
  const snap = await request(env.base, 'GET', '/api/snapshot?limit=2', {
    headers: adminHeaders(env),
  });
  assert.equal(snap.status, 200);
  assert.equal(snap.json.tasks.length, 2);
  assert.equal(snap.json.devices.length, 1);
  assert.ok(snap.json.events.length <= 2);
  // 任务按创建时间倒序
  assert.ok(Date.parse(snap.json.tasks[0].createdAt) >= Date.parse(snap.json.tasks[1].createdAt));
});
