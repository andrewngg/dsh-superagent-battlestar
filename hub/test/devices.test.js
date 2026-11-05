'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startTestHub,
  request,
  makeManifest,
  registerDevice,
  heartbeat,
  adminHeaders,
  deviceHeaders,
  createTask,
  snapshot,
  waitFor,
} = require('./_helpers.js');

test('注册后设备出现在快照中，能力与运行字段按协议规范化', async (t) => {
  const env = await startTestHub(t);
  const device = await registerDevice(
    env,
    makeManifest({
      name: '书房工作站',
      platform: 'windows',
      kind: 'dsh',
      tags: ['书房', '夜间可跑'],
      models: [{ id: 'deepseek-chat', provider: 'deepseek', strengths: ['code'] }],
      skills: [{ id: 'office-docx' }],
      limits: { maxConcurrentTasks: 2 },
    }),
  );

  const snap = await snapshot(env);
  assert.equal(snap.devices.length, 1);
  const dev = snap.devices[0];
  assert.equal(dev.id, device.deviceId);
  assert.equal(dev.name, '书房工作站');
  assert.equal(dev.platform, 'windows');
  assert.equal(dev.kind, 'dsh');
  assert.equal(dev.online, true);
  assert.equal(dev.status, 'idle');
  assert.equal(dev.disabled, false);
  assert.deepEqual(dev.tags, ['书房', '夜间可跑']);
  assert.deepEqual(dev.load, { running: 0, max: 2 });
  assert.ok(Date.parse(dev.registeredAt) > 0);
  assert.ok(Date.parse(dev.lastSeenAt) > 0);
  // 能力规范化：available 缺省 true，limits 保留
  assert.equal(dev.capabilities.models[0].id, 'deepseek-chat');
  assert.equal(dev.capabilities.models[0].available, true);
  assert.deepEqual(dev.capabilities.skills.map((s) => s.id), ['office-docx']);
  assert.equal(dev.capabilities.limits.maxConcurrentTasks, 2);
  // 设备令牌不可泄漏
  assert.equal(dev.deviceToken, undefined);
  assert.equal(dev.token, undefined);
  // 统计
  assert.deepEqual(snap.stats, {
    devicesTotal: 1,
    devicesOnline: 1,
    tasksQueued: 0,
    tasksAssigned: 0,
    tasksRunning: 0,
    tasksCompleted: 0,
    tasksFailed: 0,
  });
});

test('心跳刷新 lastSeenAt/metrics/status，命令随心跳下发；上报 load 不覆盖任务负载', async (t) => {
  const env = await startTestHub(t);
  const device = await registerDevice(env, makeManifest());

  const before = await request(env.base, 'GET', `/api/devices/${device.deviceId}`, {
    headers: adminHeaders(env),
  });
  const firstSeen = before.json.device.lastSeenAt;

  const beat = await heartbeat(env, device, {
    status: 'busy',
    load: { running: 99, max: 8 },
    metrics: { cpuPct: 12, memPct: 48, uptimeSec: 3600 },
  });
  assert.equal(beat.status, 200);
  assert.equal(beat.json.ok, true);
  assert.equal(beat.json.heartbeatIntervalMs, 10000);
  assert.equal(beat.json.ttlSec, 30);
  assert.deepEqual(beat.json.commands, []);

  const after = await request(env.base, 'GET', `/api/devices/${device.deviceId}`, {
    headers: adminHeaders(env),
  });
  const dev = after.json.device;
  assert.equal(dev.status, 'busy');
  assert.ok(Date.parse(dev.lastSeenAt) >= Date.parse(firstSeen));
  assert.equal(dev.metrics.cpuPct, 12);
  assert.equal(dev.metrics.memPct, 48);
  assert.equal(dev.metrics.uptimeSec, 3600);
  // load.running 由 Hub 任务生命周期维护，心跳上报只作参考（且被 clamp 到上限）
  assert.equal(dev.load.running, 0);
  assert.equal(dev.load.max, 1);

  // 任务创建后，命令可通过心跳响应直接领取
  const task = await createTask(env, { instruction: '整理文档', requirements: { skills: ['office-docx'] } });
  assert.equal(task.status, 'assigned');
  const beat2 = await heartbeat(env, device, { status: 'idle' });
  assert.equal(beat2.json.commands.length, 1);
  const command = beat2.json.commands[0];
  assert.match(command.id, /^cmd_/);
  assert.equal(command.type, 'run_task');
  assert.equal(command.taskId, task.id);
  assert.equal(command.payload.instruction, '整理文档');
  assert.equal(command.payload.timeoutSec, task.timeoutSec);
  assert.equal(command.payload.context.deviceName, '测试设备');
});

test('超过 TTL 未心跳 → 离线并广播 device.offline；心跳恢复 → device.online', async (t) => {
  const env = await startTestHub(t, { ttlMs: 300 });
  const device = await registerDevice(env, makeManifest());

  const offline = await waitFor(
    async () => {
      const snap = await snapshot(env);
      return snap.devices[0] && snap.devices[0].online === false ? snap : null;
    },
    { label: '设备因心跳超时离线', timeout: 5000 },
  );
  assert.equal(offline.devices[0].status, 'offline');
  assert.ok(
    offline.events.some((event) => event.type === 'device.offline' && event.deviceId === device.deviceId),
    '快照事件中应包含 device.offline',
  );

  const beat = await heartbeat(env, device, { status: 'idle' });
  assert.equal(beat.status, 200);

  const online = await waitFor(
    async () => {
      const snap = await snapshot(env);
      return snap.devices[0] && snap.devices[0].online === true ? snap : null;
    },
    { label: '设备心跳恢复上线', timeout: 3000 },
  );
  assert.equal(online.devices[0].status, 'idle');
  assert.ok(
    online.events.some((event) => event.type === 'device.online' && event.deviceId === device.deviceId),
    '快照事件中应包含 device.online',
  );
});

test('POST /api/devices/:id/manifest 需要设备令牌，能力变化自动重试排队任务', async (t) => {
  const env = await startTestHub(t);
  const device = await registerDevice(env, makeManifest({ skills: [{ id: 'office-xlsx' }] }));

  const task = await createTask(env, {
    instruction: '生成 PDF',
    requirements: { skills: ['office-pdf'] },
  });
  assert.equal(task.status, 'queued');
  assert.match(task.route.reason, /no matching device/);
  assert.match(task.route.excluded[0].reason, /missing skill:office-pdf/);

  const denied = await request(env.base, 'POST', `/api/devices/${device.deviceId}/manifest`, {
    body: makeManifest(),
  });
  assert.equal(denied.status, 401);

  const updated = await request(env.base, 'POST', `/api/devices/${device.deviceId}/manifest`, {
    headers: deviceHeaders(device),
    body: makeManifest({ skills: [{ id: 'office-pdf', name: 'PDF' }] }),
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.ok, true);
  assert.deepEqual(updated.json.device.capabilities.skills.map((s) => s.id), ['office-pdf']);

  const routed = await waitFor(
    async () => {
      const snap = await snapshot(env);
      const found = snap.tasks.find((item) => item.id === task.id);
      return found && found.status === 'assigned' ? found : null;
    },
    { label: 'manifest 更新后任务自动路由', timeout: 3000 },
  );
  assert.equal(routed.assignedDeviceId, device.deviceId);
  assert.equal(routed.attempts, 1);
});

test('命令长轮询：已有命令立即返回，空队列等待后返回空数组，挂起时可被新命令唤醒', async (t) => {
  const env = await startTestHub(t);
  const device = await registerDevice(env, makeManifest());

  const task1 = await createTask(env, {
    instruction: '任务一',
    requirements: { deviceId: device.deviceId },
  });
  assert.equal(task1.status, 'assigned');

  const poll1 = await request(
    env.base,
    'GET',
    `/api/devices/${device.deviceId}/commands?waitMs=2000&limit=5`,
    { headers: deviceHeaders(device) },
  );
  assert.equal(poll1.status, 200);
  assert.equal(poll1.json.commands.length, 1);
  assert.equal(poll1.json.commands[0].taskId, task1.id);

  const emptyStart = Date.now();
  const poll2 = await request(
    env.base,
    'GET',
    `/api/devices/${device.deviceId}/commands?waitMs=150&limit=5`,
    { headers: deviceHeaders(device) },
  );
  const elapsed = Date.now() - emptyStart;
  assert.equal(poll2.status, 200);
  assert.deepEqual(poll2.json.commands, []);
  assert.ok(elapsed >= 100, `长轮询应至少等待约 150ms，实际 ${elapsed}ms`);

  // 挂起中的长轮询应被新命令唤醒
  const pending = request(
    env.base,
    'GET',
    `/api/devices/${device.deviceId}/commands?waitMs=5000&limit=5`,
    { headers: deviceHeaders(device) },
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  const task2 = await createTask(env, {
    instruction: '任务二',
    requirements: { deviceId: device.deviceId },
  });
  const woke = await pending;
  assert.equal(woke.status, 200);
  assert.equal(woke.json.commands.length, 1);
  assert.equal(woke.json.commands[0].taskId, task2.id);
});

test('PATCH / DELETE / unregister 设备', async (t) => {
  const env = await startTestHub(t);
  const device = await registerDevice(env, makeManifest({ name: '旧名', tags: ['旧标签'] }));

  const patched = await request(env.base, 'PATCH', `/api/devices/${device.deviceId}`, {
    headers: adminHeaders(env),
    body: { name: '新名', tags: ['书房', '书房', '夜间'], disabled: false },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.device.name, '新名');
  assert.deepEqual(patched.json.device.tags, ['书房', '夜间']);

  const badPatch = await request(env.base, 'PATCH', `/api/devices/${device.deviceId}`, {
    headers: adminHeaders(env),
    body: { name: '   ' },
  });
  assert.equal(badPatch.status, 400);

  const disabled = await request(env.base, 'PATCH', `/api/devices/${device.deviceId}`, {
    headers: adminHeaders(env),
    body: { disabled: true },
  });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.json.device.disabled, true);

  const deleted = await request(env.base, 'DELETE', `/api/devices/${device.deviceId}`, {
    headers: adminHeaders(env),
  });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.json.ok, true);

  const gone = await request(env.base, 'GET', `/api/devices/${device.deviceId}`, {
    headers: adminHeaders(env),
  });
  assert.equal(gone.status, 404);

  const second = await registerDevice(env, makeManifest({ name: '待注销' }));
  const unregister = await request(env.base, 'POST', `/api/devices/${second.deviceId}/unregister`, {
    headers: deviceHeaders(second),
    body: {},
  });
  assert.equal(unregister.status, 200);
  assert.equal(unregister.json.ok, true);
  const list = await request(env.base, 'GET', '/api/devices', { headers: adminHeaders(env) });
  assert.deepEqual(list.json.devices, []);

  const unknown = await request(env.base, 'POST', '/api/devices/dev_missing/heartbeat', {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(unknown.status, 404);
});
