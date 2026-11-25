'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  looksLikePcOnlyInstruction,
  pcOnlyReason,
} = require('../lib/instruction-host.js');
const {
  startTestHub,
  makeManifest,
  registerDevice,
  heartbeat,
  createTask,
  request,
  adminHeaders,
} = require('./_helpers.js');

test('指令主机识别：电脑侧操作判定', () => {
  const pcSamples = [
    '在 C:\\Users\\me\\job_seeker 执行 python applier.py --help',
    'python --version',
    'python applier.py --auto-submit --jobs-count 3',
    '运行 adb devices，确认手机是否在线',
    '执行 adb shell getprop | findstr mika',
    'powershell -File scripts\\recover.ps1',
    '打开 cmd /c dir 看下',
    'node scripts/mika-phone-recovery.js --check',
    '在母机上执行一次修复',
    '能否执行只读Python命令？',
    '通过ADB测试连接',
  ];
  for (const instruction of pcSamples) {
    assert.equal(looksLikePcOnlyInstruction(instruction), true, `应识别为电脑侧：${instruction}`);
  }

  const phoneSamples = [
    '打开求职 App 投递简历',
    '帮我把手机通知清一下',
    '在 Mika 手机上确认 resume.pdf 在不在 Download 文件夹',
    '用mika工作机把 tracking 层的都处理掉',
    '继续上一轮任务',
    '',
  ];
  for (const instruction of phoneSamples) {
    assert.equal(looksLikePcOnlyInstruction(instruction), false, `应识别为手机侧：${instruction}`);
  }

  assert.equal(pcOnlyReason('python --version'), 'python 命令');
  assert.equal(pcOnlyReason(''), null);
});

async function setupEnv(t) {
  const env = await startTestHub(t);
  const main = await registerDevice(
    env,
    makeManifest({ name: '主工作机 · DESKTOP-T3', platform: 'windows', tags: ['本机', '母机'] }),
  );
  const mika = await registerDevice(
    env,
    makeManifest({
      name: 'Mika手机',
      platform: 'android',
      kind: 'mika',
      tags: ['手机', 'Mika'],
      limits: { maxConcurrentTasks: 2 },
    }),
  );
  await heartbeat(env, main, {});
  await heartbeat(env, mika, {});
  return { env, main, mika };
}

test('主机守卫：电脑侧指令即使指定 Mika 也改派母机', async (t) => {
  const { env, main, mika } = await setupEnv(t);
  const task = await createTask(env, {
    instruction: '在 C:\\Users\\me\\job_seeker 执行 python applier.py --help',
    requirements: { deviceId: mika.deviceId },
  });
  assert.equal(task.requirements.deviceId, main.deviceId);
  assert.equal(task.assignedDeviceId, main.deviceId);
  const guard = task.events.find((event) => event.type === 'host-guard');
  assert.ok(guard, `应有 host-guard 事件：${JSON.stringify(task.events)}`);
  assert.match(guard.message, /电脑侧操作/);
  assert.match(guard.message, /改派母机/);
});

test('主机守卫：手机侧指令仍派给 Mika', async (t) => {
  const { env, mika } = await setupEnv(t);
  const task = await createTask(env, {
    instruction: '打开求职 App，把今天的推荐岗位投递一下',
    requirements: { deviceId: mika.deviceId },
  });
  assert.equal(task.requirements.deviceId, mika.deviceId);
  assert.equal(task.assignedDeviceId, mika.deviceId);
  assert.ok(!task.events.some((event) => event.type === 'host-guard'));
});

test('主机守卫：长期目标固定 Mika 时电脑侧指令不锁手机', async (t) => {
  const { env, main, mika } = await setupEnv(t);
  const goalRes = await request(env.base, 'POST', '/api/goals', {
    headers: adminHeaders(env),
    body: { title: '求职', deviceId: mika.deviceId },
  });
  assert.equal(goalRes.status, 200, JSON.stringify(goalRes.json));
  const goal = goalRes.json.goal;
  assert.equal(goal.deviceId, mika.deviceId);

  const task = await createTask(env, {
    instruction: '运行 adb devices 检查 Mika 手机连接是否正常',
    goalId: goal.id,
    requirements: { deviceId: mika.deviceId },
  });
  assert.equal(task.requirements.deviceId, main.deviceId);
  assert.equal(task.assignedDeviceId, main.deviceId);
  const guard = task.events.find((event) => event.type === 'host-guard');
  assert.ok(guard, `应有 host-guard 事件：${JSON.stringify(task.events)}`);
  assert.match(guard.message, /不适用于电脑侧步骤/);
});
