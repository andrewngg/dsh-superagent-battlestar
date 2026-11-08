'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  startTestHub,
  startHubAt,
  makeTempDir,
  request,
  makeManifest,
  registerDevice,
  createTask,
  ackTask,
  resultTask,
  adminHeaders,
  waitFor,
} = require('./_helpers.js');

test('系统设置：默认中文，可切换英语并持久化，snapshot 同步下发', async (t) => {
  const dataDir = await makeTempDir('butler-settings-');
  t.after(() => fs.promises.rm(dataDir, { recursive: true, force: true }));

  const first = await startHubAt(dataDir);
  const initial = await request(first.base, 'GET', '/api/settings', {
    headers: adminHeaders(first),
  });
  assert.equal(initial.status, 200);
  assert.equal(initial.json.settings.language, 'zh-CN');
  assert.deepEqual(initial.json.supportedLanguages.sort(), ['en', 'zh-CN']);

  const snapBefore = await request(first.base, 'GET', '/api/snapshot', {
    headers: adminHeaders(first),
  });
  assert.equal(snapBefore.json.settings.language, 'zh-CN');

  const updated = await request(first.base, 'PATCH', '/api/settings', {
    headers: adminHeaders(first),
    body: { language: 'en' },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.settings.language, 'en');
  assert.ok(fs.existsSync(path.join(dataDir, 'settings.json')));

  const invalid = await request(first.base, 'PATCH', '/api/settings', {
    headers: adminHeaders(first),
    body: { language: 'fr' },
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.json.error.message, /language/);

  const unauthorized = await request(first.base, 'GET', '/api/settings', {});
  assert.equal(unauthorized.status, 401);

  await first.hub.close();

  const second = await startHubAt(dataDir);
  try {
    const reloaded = await request(second.base, 'GET', '/api/settings', {
      headers: adminHeaders(second),
    });
    assert.equal(reloaded.json.settings.language, 'en');
    const snap = await request(second.base, 'GET', '/api/snapshot', {
      headers: adminHeaders(second),
    });
    assert.equal(snap.json.settings.language, 'en');
  } finally {
    await second.hub.close();
  }
});

test('执行记录 API：列表/搜索/详情/markdown 下载', async (t) => {
  const env = await startTestHub(t);
  const device = await registerDevice(env, makeManifest());
  const task = await createTask(env, {
    instruction: '记录 API 测试任务',
    requirements: { deviceId: device.deviceId },
  });
  await ackTask(env, device, task.id);
  await resultTask(env, device, task.id, { ok: true, output: { text: 'API 记录完成' } });

  const file = path.join(env.hub.recordDir, String(task.createdAt).slice(0, 10), `${task.id}.md`);
  await waitFor(() => fs.existsSync(file), { label: '记录 md 写入', timeout: 5000 });

  const list = await request(env.base, 'GET', '/api/records?limit=10', {
    headers: adminHeaders(env),
  });
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.json.records));
  const item = list.json.records.find((record) => record.taskId === task.id);
  assert.ok(item, '列表应包含任务记录');
  assert.equal(item.status, 'completed');
  assert.equal(item.hasFile, true);
  assert.ok(item.size > 0);
  assert.match(item.summary, /记录 API 测试任务/);
  assert.ok(list.json.recordDir);

  const searched = await request(env.base, 'GET', '/api/records?q=记录 API', {
    headers: adminHeaders(env),
  });
  assert.ok(searched.json.records.some((record) => record.taskId === task.id));

  const filtered = await request(env.base, 'GET', '/api/records?status=failed', {
    headers: adminHeaders(env),
  });
  assert.equal(filtered.json.records.some((record) => record.taskId === task.id), false);

  const detail = await request(env.base, 'GET', `/api/records/${task.id}`, {
    headers: adminHeaders(env),
  });
  assert.equal(detail.status, 200);
  assert.match(detail.json.record.markdown, /记录 API 测试任务/);
  assert.match(detail.json.record.markdown, /API 记录完成/);
  assert.equal(detail.json.record.taskId, task.id);

  const markdown = await request(env.base, 'GET', `/api/records/${task.id}?format=md`, {
    headers: adminHeaders(env),
  });
  assert.equal(markdown.status, 200);
  assert.match(markdown.headers['content-type'], /text\/markdown/);
  assert.match(markdown.text, /# 任务执行记录/);

  const missing = await request(env.base, 'GET', '/api/records/task_missing', {
    headers: adminHeaders(env),
  });
  assert.equal(missing.status, 404);
});
