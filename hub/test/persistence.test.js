'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  makeTempDir,
  startHubAt,
  makeManifest,
  registerDevice,
  heartbeat,
  ackTask,
  resultTask,
  createTask,
  getTask,
  snapshot,
  request,
  adminHeaders,
  waitFor,
} = require('./_helpers.js');

test('重启恢复：令牌/加入码持久化，设备离线，assigned 重排，running 失败，历史保留', async (t) => {
  const dataDir = await makeTempDir('butler-persist-');
  t.after(async () => {
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  });

  const first = await startHubAt(dataDir, {
    adminToken: 'adm_fixed_token',
    joinCode: 'join_fixed_code',
  });
  const device = await registerDevice(
    first,
    makeManifest({ name: '持久设备', limits: { maxConcurrentTasks: 3 } }),
  );

  const assignedTask = await createTask(first, {
    instruction: '未确认任务',
    requirements: { skills: ['office-docx'] },
  });
  assert.equal(assignedTask.status, 'assigned');

  const runningTask = await createTask(first, {
    instruction: '运行中任务',
    requirements: { skills: ['office-docx'] },
  });
  await ackTask(first, device, runningTask.id);

  const completedTask = await createTask(first, {
    instruction: '已完成任务',
    requirements: { skills: ['office-docx'] },
  });
  await ackTask(first, device, completedTask.id);
  await resultTask(first, device, completedTask.id, { ok: true, output: { text: 'done' } });

  await first.hub.close();

  const stateFile = path.join(dataDir, 'state.json');
  assert.ok(fs.existsSync(stateFile), 'state.json 应存在');
  const state = JSON.parse(await fs.promises.readFile(stateFile, 'utf8'));
  assert.equal(state.adminToken, 'adm_fixed_token');
  assert.equal(state.joinCode, 'join_fixed_code');
  assert.equal(state.devices.length, 1);
  assert.equal(state.tasks.length, 3);
  assert.ok(state.events.length > 0);
  assert.ok(state.tasks.every((task) => typeof task.id === 'string' && task.id));
  const leftovers = (await fs.promises.readdir(dataDir)).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftovers, [], '原子写不应遗留临时文件');

  const second = await startHubAt(dataDir);
  try {
    assert.equal(second.hub.adminToken, 'adm_fixed_token');
    assert.equal(second.hub.joinCode, 'join_fixed_code');

    const snap = await snapshot(second);
    assert.equal(snap.devices.length, 1);
    const restoredDevice = snap.devices[0];
    assert.equal(restoredDevice.online, false);
    assert.equal(restoredDevice.status, 'offline');
    assert.equal(restoredDevice.load.running, 0);
    assert.equal(restoredDevice.disabled, false);

    const byId = new Map(snap.tasks.map((task) => [task.id, task]));
    const restoredAssigned = byId.get(assignedTask.id);
    assert.equal(restoredAssigned.status, 'queued');
    assert.equal(restoredAssigned.assignedDeviceId, null);
    assert.equal(restoredAssigned.attempts, 1);
    assert.ok(restoredAssigned.events.some((event) => event.type === 'requeued'));

    const restoredRunning = byId.get(runningTask.id);
    assert.equal(restoredRunning.status, 'failed');
    assert.match(restoredRunning.error, /hub restarted/);
    assert.equal(restoredRunning.assignedDeviceId, device.deviceId);
    assert.equal(restoredRunning.attempts, 1);

    const restoredCompleted = byId.get(completedTask.id);
    assert.equal(restoredCompleted.status, 'completed');
    assert.equal(restoredCompleted.output.text, 'done');
    assert.ok(snap.events.length > 0);
    assert.ok(snap.stats.tasksFailed >= 1);

    // 设备重新心跳 → 重启前 assigned 的任务自动重派（第 2 次尝试）
    const beat = await heartbeat(
      second,
      { deviceId: device.deviceId, deviceToken: device.deviceToken },
      { status: 'idle' },
    );
    assert.equal(beat.status, 200);
    const routed = await waitFor(
      async () => {
        const current = await getTask(second, assignedTask.id);
        return current.status === 'assigned' ? current : null;
      },
      { label: '重启后设备上线，排队任务自动重派', timeout: 3000 },
    );
    assert.equal(routed.assignedDeviceId, device.deviceId);
    assert.equal(routed.attempts, 2);
  } finally {
    await second.hub.close();
  }
});

test('重启后旧管理员令牌/设备令牌仍有效，设备可恢复注册并上线', async (t) => {
  const dataDir = await makeTempDir('butler-persist-token-');
  t.after(async () => {
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  });

  const first = await startHubAt(dataDir);
  const device = await registerDevice(first, makeManifest({ name: '旧名字' }));
  const oldAdminToken = first.hub.adminToken;
  const oldJoinCode = first.hub.joinCode;
  await first.hub.close();

  const second = await startHubAt(dataDir);
  try {
    const withOldToken = await request(second.base, 'GET', '/api/devices', {
      headers: { 'x-butler-token': oldAdminToken },
    });
    assert.equal(withOldToken.status, 200);
    assert.equal(withOldToken.json.devices.length, 1);
    assert.equal(withOldToken.json.devices[0].online, false);

    // 设备用 deviceId + 设备令牌走 register（更新 manifest + 恢复在线）
    const restored = await request(second.base, 'POST', '/api/devices/register', {
      headers: {
        'x-butler-device-id': device.deviceId,
        'x-butler-device-token': device.deviceToken,
      },
      body: makeManifest({ name: '恢复后的设备' }),
    });
    assert.equal(restored.status, 200);
    assert.equal(restored.json.deviceId, device.deviceId);
    assert.equal(restored.json.deviceToken, device.deviceToken);

    const detail = await request(second.base, 'GET', `/api/devices/${device.deviceId}`, {
      headers: adminHeaders(second),
    });
    assert.equal(detail.json.device.name, '恢复后的设备');
    assert.equal(detail.json.device.online, true);

    // 持久化的加入码仍可注册新设备
    const newDevice = await registerDevice(second, makeManifest({ name: '新设备' }), {
      joinCode: oldJoinCode,
    });
    assert.equal(newDevice.deviceId.startsWith('dev_'), true);
  } finally {
    await second.hub.close();
  }
});

test('state.json 损坏时 Hub 仍可启动并重新生成令牌', async (t) => {
  const dataDir = await makeTempDir('butler-persist-corrupt-');
  t.after(async () => {
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  });
  await fs.promises.writeFile(path.join(dataDir, 'state.json'), '{ this is not json', 'utf8');

  const env = await startHubAt(dataDir);
  try {
    assert.ok(env.hub.adminToken);
    const health = await request(env.base, 'GET', '/api/health');
    assert.equal(health.status, 200);
    const snap = await snapshot(env);
    assert.deepEqual(snap.devices, []);
    assert.deepEqual(snap.tasks, []);
  } finally {
    await env.hub.close();
  }

  const repaired = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(typeof repaired.adminToken, 'string');
  assert.ok(repaired.adminToken.length > 0);
});
