'use strict';

/**
 * C 方案测试：Agnes 规划器接收设备清单，子任务可指派 deviceId / tags；
 * Hub 校验非法值并回退，且优先级为：用户显式 deviceId > Agnes 指派 > 自动路由。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  startTestHub,
  makeManifest,
  makeTempDir,
  registerDevice,
  createTask,
} = require('./_helpers');

test('Agnes 规划：收到设备清单，并按子任务指派有效 deviceId', async (t) => {
  let captured = null;
  let plannedDeviceId = '';
  const env = await startTestHub(t, {
    preflight: false,
    planner: async (args) => {
      captured = args;
      return {
        title: '拆分测试',
        subtasks: [
          { instruction: '在手机上打开设置页面', timeoutSec: 300, deviceId: plannedDeviceId },
          { instruction: '整理今天的会议记录', timeoutSec: 300 },
        ],
      };
    },
  });
  const local = await registerDevice(env, makeManifest({ name: '主工作机', tags: ['本机'] }));
  const phone = await registerDevice(
    env,
    makeManifest({ name: '手机工作机', platform: 'android', tags: ['手机'], skills: [{ id: 'phone-control' }] }),
  );
  plannedDeviceId = phone.deviceId;

  const parent = await createTask(env, {
    instruction: '打开手机设置页面，并整理今天的会议记录',
    timeoutSec: 900,
    split: true,
  });

  assert.equal(parent.isPlan, true);
  assert.ok(captured, '规划器没有被调用');
  assert.ok(Array.isArray(captured.devices), '规划器没有收到设备清单');
  assert.deepEqual(
    captured.devices.map((device) => device.id).sort(),
    [local.deviceId, phone.deviceId].sort(),
  );
  const inventoryPhone = captured.devices.find((device) => device.id === phone.deviceId);
  assert.ok(inventoryPhone.tags.includes('手机'));
  const inventoryLocal = captured.devices.find((device) => device.id === local.deviceId);
  assert.equal(inventoryLocal.local, true);

  const children = parent.childTaskIds.map((id) => env.hub.getTask(id));
  assert.equal(children.length, 2);
  const [first, second] = children;
  assert.equal(first.requirements.deviceId, phone.deviceId);
  assert.equal(first.assignedDeviceId, phone.deviceId);
  assert.ok(first.routingAdvice && first.routingAdvice.planner);
  assert.equal(first.routingAdvice.planner.deviceId, phone.deviceId);
  assert.match(first.route.reason, /Agnes 指派/);
  assert.equal(second.requirements.deviceId, null);
});

test('Agnes 规划：不存在的 deviceId 被忽略，子任务回退自动路由', async (t) => {
  const env = await startTestHub(t, {
    preflight: false,
    planner: async () => ({
      title: '非法指派',
      subtasks: [
        { instruction: '子任务一', timeoutSec: 300, deviceId: 'dev_missing' },
        { instruction: '子任务二', timeoutSec: 300, deviceId: 'dev_missing' },
      ],
    }),
  });
  const first = await registerDevice(env, makeManifest({ name: '设备一', tags: [] }));
  const second = await registerDevice(env, makeManifest({ name: '设备二', tags: [] }));

  const parent = await createTask(env, { instruction: '拆一条长任务', timeoutSec: 900, split: true });
  const children = parent.childTaskIds.map((id) => env.hub.getTask(id));
  for (const child of children) {
    assert.equal(child.requirements.deviceId, null);
    assert.equal(child.routingAdvice, null);
    assert.ok([first.deviceId, second.deviceId].includes(child.assignedDeviceId));
  }
});

test('Agnes 规划：用户显式 deviceId 优先于规划器指派', async (t) => {
  let plannedDeviceId = '';
  const env = await startTestHub(t, {
    preflight: false,
    planner: async () => ({
      title: '用户优先',
      subtasks: [
        { instruction: '在另一台机器上执行', timeoutSec: 300, deviceId: plannedDeviceId },
        { instruction: '继续第二步', timeoutSec: 300 },
      ],
    }),
  });
  // 单并发设备上第二个子任务会排队，给 2 个槽位以便同时验证两个子任务的指派。
  const preferred = await registerDevice(env, makeManifest({ name: '指定设备', tags: [], limits: { maxConcurrentTasks: 2 } }));
  const other = await registerDevice(env, makeManifest({ name: '另一台', tags: [] }));
  plannedDeviceId = other.deviceId;

  const parent = await createTask(env, {
    instruction: '按我的指定执行这条长任务',
    requirements: { deviceId: preferred.deviceId },
    timeoutSec: 900,
    split: true,
  });
  assert.equal(parent.requirements.deviceId, preferred.deviceId);

  const children = parent.childTaskIds.map((id) => env.hub.getTask(id));
  for (const child of children) {
    assert.equal(child.requirements.deviceId, preferred.deviceId);
    assert.equal(child.assignedDeviceId, preferred.deviceId);
  }
  assert.equal(children[0].routingAdvice, null);
});

test('Agnes 规划：子任务指令命中本机文件时，预检优先于规划器指派', async (t) => {
  const root = await makeTempDir('butler-plan-devices-root-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'Downloads'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Downloads', 'resume.pdf'), 'pdf');
  let plannedDeviceId = '';
  const env = await startTestHub(t, {
    preflight: { roots: [root], maxDepth: 2 },
    planner: async () => ({
      title: '预检优先',
      subtasks: [
        { instruction: '用 resume.pdf 更新投递材料', timeoutSec: 300, deviceId: plannedDeviceId },
        { instruction: '检查网络连接是否正常', timeoutSec: 300, deviceId: plannedDeviceId },
      ],
    }),
  });
  const local = await registerDevice(env, makeManifest({ name: '主工作机', tags: ['本机'] }));
  const other = await registerDevice(env, makeManifest({ name: '另一台', tags: [] }));
  plannedDeviceId = other.deviceId;

  const parent = await createTask(env, {
    instruction: '整理求职材料并检查网络',
    timeoutSec: 900,
    split: true,
  });
  const children = parent.childTaskIds.map((id) => env.hub.getTask(id));

  assert.equal(children[0].requirements.deviceId, local.deviceId);
  assert.ok(children[0].routingAdvice && children[0].routingAdvice.preflight);
  assert.equal(children[0].assignedDeviceId, local.deviceId);
  assert.equal(children[1].requirements.deviceId, other.deviceId);
  assert.ok(children[1].routingAdvice && children[1].routingAdvice.planner);
});

test('Agnes 规划：tags 只保留已注册设备上存在的，并在无 deviceId 时生效', async (t) => {
  const env = await startTestHub(t, {
    preflight: false,
    planner: async () => ({
      title: '按标签指派',
      subtasks: [
        { instruction: '在手机上执行', timeoutSec: 300, tags: ['手机'] },
        { instruction: '在未知设备上执行', timeoutSec: 300, tags: ['不存在的标签'] },
      ],
    }),
  });
  const local = await registerDevice(env, makeManifest({ name: '主工作机', tags: ['本机'] }));
  const phone = await registerDevice(env, makeManifest({ name: '手机工作机', platform: 'android', tags: ['手机'] }));

  const parent = await createTask(env, { instruction: '按标签拆一条长任务', timeoutSec: 900, split: true });
  const children = parent.childTaskIds.map((id) => env.hub.getTask(id));

  assert.deepEqual(children[0].requirements.tags, ['手机']);
  assert.equal(children[0].assignedDeviceId, phone.deviceId);
  assert.deepEqual(children[1].requirements.tags, []);
  assert.ok([local.deviceId, phone.deviceId].includes(children[1].assignedDeviceId));
});
