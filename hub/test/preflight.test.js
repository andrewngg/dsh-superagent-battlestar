'use strict';

/**
 * 本地文件预检（A 方案）测试：
 * - 引用提取：绝对路径 / 相对路径 / 裸文件名，忽略 URL 与邮箱
 * - 本地解析：临时目录里的真实文件
 * - Hub 集成：命中本机文件 → 固定到「本机」设备，route.reason / routingAdvice 可审计
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const preflight = require('../lib/preflight');
const {
  makeTempDir,
  startTestHub,
  makeManifest,
  registerDevice,
  ackTask,
  resultTask,
  request,
  createTask,
  getTask,
  adminHeaders,
} = require('./_helpers');

function writeFile(root, relative, content = 'x') {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

test('extractReferences：识别路径与文件名，忽略 URL 和邮箱', () => {
  const refs = preflight.extractReferences(
    '修改 C:\\work\\job_seeker\\applier.py，并把 resume.pdf 放到 Downloads；参考 https://example.com/doc/a.js 与 me@example.com',
  );
  const values = refs.map((ref) => ref.value.toLowerCase());
  assert.ok(values.some((value) => value.endsWith('applier.py')), `未提取 applier.py：${values}`);
  assert.ok(values.includes('resume.pdf'), `未提取 resume.pdf：${values}`);
  assert.ok(!refs.some((ref) => /example\.com/.test(ref.value)));
  assert.ok(refs.some((ref) => ref.kind === 'absolute'));
});

test('resolveReferences：命中临时目录里的裸文件名与绝对路径', async () => {
  const root = await makeTempDir('butler-preflight-');
  try {
    writeFile(root, 'job_seeker/applier.py');
    writeFile(root, 'resume.pdf');
    const refs = preflight.extractReferences('先改 applier.py，再读 resume.pdf；绝对路径 ' + path.join(root, 'resume.pdf') + '，然后继续');
    const result = preflight.resolveReferences(refs, { roots: [root], maxDepth: 3 });
    assert.equal(result.hit, true);
    const hitPaths = result.matches.map((match) => match.path.toLowerCase());
    assert.ok(hitPaths.some((p) => p.endsWith('applier.py')), `未命中 applier.py：${hitPaths}`);
    assert.ok(hitPaths.some((p) => p.endsWith('resume.pdf')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveReferences：路径后紧跟中文/全角标点也能截断命中', async () => {
  const root = await makeTempDir('butler-preflight-');
  try {
    const abs = writeFile(root, 'notes/todo.md');
    const refs = preflight.extractReferences(`请打开 ${abs}，然后按里面的清单执行`);
    const result = preflight.resolveReferences(refs, { roots: [root], maxDepth: 2 });
    assert.equal(result.hit, true, `未命中：${JSON.stringify(refs)}`);
    assert.ok(result.matches[0].path.toLowerCase().endsWith('todo.md'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('preflightInstruction：没有文件引用时直接返回未命中', () => {
  const result = preflight.preflightInstruction('整理一下今天的工作计划');
  assert.equal(result.hit, false);
  assert.equal(result.reason, '');
});

test('Hub：指令提到本机文件时，任务固定到「本机」设备并可审计', async (t) => {
  const root = await makeTempDir('butler-preflight-root-');
  writeFile(root, 'job_seeker/applier.py');
  writeFile(root, 'resume.pdf');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const env = await startTestHub(t, { preflight: { roots: [root], maxDepth: 3 } });
  const local = await registerDevice(env, makeManifest({ name: '主工作机', tags: ['本机'] }));
  await registerDevice(env, makeManifest({ name: '手机工作机', platform: 'android', tags: ['手机'] }));

  const task = await createTask(env, {
    instruction: '给 applier.py 加一个 --auto-submit 参数，并确认 resume.pdf 在 Downloads',
    timeoutSec: 300,
  });

  assert.equal(task.requirements.deviceId, local.deviceId, '应把 deviceId pin 到本机');
  assert.equal(task.assignedDeviceId, local.deviceId, '应派发到本机');
  assert.ok(task.routingAdvice && task.routingAdvice.preflight, '缺少 routingAdvice.preflight');
  assert.equal(task.routingAdvice.preflight.deviceId, local.deviceId);
  assert.ok(Array.isArray(task.routingAdvice.preflight.matches) && task.routingAdvice.preflight.matches.length >= 1);
  assert.match(task.route.reason, /本地文件预检/);
  assert.ok(task.events.some((event) => event.type === 'preflight'), '缺少 preflight 事件');
});

test('Hub：未命中本机文件时不 pin，交给自动路由', async (t) => {
  const root = await makeTempDir('butler-preflight-root-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = await startTestHub(t, { preflight: { roots: [root] } });
  const first = await registerDevice(env, makeManifest({ name: '设备一', tags: ['本机'] }));
  const second = await registerDevice(env, makeManifest({ name: '设备二', tags: [] }));

  const task = await createTask(env, { instruction: '整理一下今天的工作计划', timeoutSec: 300 });
  assert.equal(task.requirements.deviceId, null);
  assert.equal(task.routingAdvice, null);
  assert.ok([first.deviceId, second.deviceId].includes(task.assignedDeviceId));
});

test('Hub：用户显式指定 deviceId 优先，不被预检覆盖', async (t) => {
  const root = await makeTempDir('butler-preflight-root-');
  writeFile(root, 'job_seeker/applier.py');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = await startTestHub(t, { preflight: { roots: [root], maxDepth: 3 } });
  const local = await registerDevice(env, makeManifest({ name: '主工作机', tags: ['本机'] }));
  const other = await registerDevice(env, makeManifest({ name: '另一台', tags: [] }));

  const task = await createTask(env, {
    instruction: '修改 applier.py',
    requirements: { deviceId: other.deviceId },
    timeoutSec: 300,
  });
  assert.equal(task.requirements.deviceId, other.deviceId);
  assert.equal(task.assignedDeviceId, other.deviceId);
  assert.equal(task.routingAdvice, null);
  assert.equal(local.deviceId, local.deviceId); // 本机存在但未被选中
});

test('Hub：跟进任务（follow-up）命中本机文件时同样 pin 本机', async (t) => {
  const root = await makeTempDir('butler-preflight-root-');
  writeFile(root, 'resume.pdf');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = await startTestHub(t, { preflight: { roots: [root], maxDepth: 2 } });
  const local = await registerDevice(env, makeManifest({ name: '主工作机', tags: ['本机'] }));
  const other = await registerDevice(env, makeManifest({ name: '另一台', tags: [] }));

  const source = await createTask(env, { instruction: '准备求职材料', timeoutSec: 300 });
  const device = source.assignedDeviceId === local.deviceId ? local : other;
  await ackTask(env, device, source.id);
  await resultTask(env, device, source.id, { ok: true, output: { text: '材料已准备' } });

  const res = await request(env.base, 'POST', `/api/tasks/${source.id}/follow-up`, {
    headers: adminHeaders(env),
    body: { instruction: '用 resume.pdf 继续投递', timeoutSec: 300 },
  });
  assert.equal(res.status, 200);
  const followUp = res.json.task;
  assert.equal(followUp.requirements.deviceId, local.deviceId);
  assert.ok(followUp.routingAdvice && followUp.routingAdvice.preflight);
  assert.equal(followUp.assignedDeviceId, local.deviceId);
  assert.notEqual(local.deviceId, other.deviceId);
});

test('Hub：routingAdvice 进入序列化/恢复（持久化不丢审计信息）', async (t) => {
  const root = await makeTempDir('butler-preflight-root-');
  writeFile(root, 'resume.pdf');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = await startTestHub(t, { preflight: { roots: [root], maxDepth: 2 } });
  const local = await registerDevice(env, makeManifest({ name: '主工作机', tags: ['本机'] }));

  const task = await createTask(env, { instruction: '把 resume.pdf 发到邮箱', timeoutSec: 300 });
  assert.equal(task.requirements.deviceId, local.deviceId);
  const restored = env.hub._restoreTask(env.hub.taskToJson(task));
  assert.ok(restored.routingAdvice && restored.routingAdvice.preflight);
  assert.equal(restored.routingAdvice.preflight.deviceId, local.deviceId);
  const state = env.hub.serializeState();
  const serialized = state.tasks.find((item) => item.id === task.id);
  assert.ok(serialized && serialized.routingAdvice && serialized.routingAdvice.preflight);
});
