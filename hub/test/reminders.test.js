'use strict';

/**
 * 提醒（Reminders）后端测试：
 * - 纯函数：请求归一化、nextDueAt 周期推进、恢复容错、对外 JSON；
 * - REST：鉴权、CRUD、校验错误、快照、404；
 * - 到点回写 fire：one-shot 停用、daily/weekly 推进且不早于当前时间；
 * - SSE 广播 reminder.created/updated/deleted/fired；
 * - 重启持久化与损坏数据容错。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  startTestHub,
  startHubAt,
  makeTempDir,
  request,
  adminHeaders,
  openSse,
  readStateFile,
  snapshot,
} = require('./_helpers.js');
const {
  REMINDER_REPEATS,
  REMINDER_NOTIFY_STYLES,
  DEFAULT_NOTIFY_STYLE,
  DAY_MS,
  WEEK_MS,
  normalizeReminderRequest,
  nextDueAt,
  restoreReminder,
  reminderToJson,
} = require('../lib/reminders.js');

function iso(ms) {
  return new Date(ms).toISOString();
}

async function createReminder(env, body) {
  const res = await request(env.base, 'POST', '/api/reminders', { headers: adminHeaders(env), body });
  assert.equal(res.status, 200, res.text);
  return res.json.reminder;
}

async function getReminder(env, reminderId) {
  return request(env.base, 'GET', `/api/reminders/${encodeURIComponent(reminderId)}`, {
    headers: adminHeaders(env),
  });
}

test('提醒纯函数：归一化/nextDueAt/恢复容错/对外 JSON', () => {
  assert.deepEqual(REMINDER_REPEATS, ['none', 'daily', 'weekly']);
  assert.deepEqual(REMINDER_NOTIFY_STYLES, ['gentle', 'alarm']);
  assert.equal(DEFAULT_NOTIFY_STYLE, 'gentle');
  const due = 1760000000000;

  const valid = normalizeReminderRequest({ title: ' 喝水 ', dueAt: due });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.value, {
    title: '喝水',
    note: '',
    dueAt: due,
    repeat: 'none',
    notifyStyle: 'gentle',
    enabled: true,
  });

  // notifyStyle：显式 alarm 合法；partial 时只校验出现的字段。
  const alarm = normalizeReminderRequest({ title: '闹钟', dueAt: due, notifyStyle: 'alarm' });
  assert.equal(alarm.ok, true);
  assert.equal(alarm.value.notifyStyle, 'alarm');
  const partialNotify = normalizeReminderRequest({ notifyStyle: 'alarm' }, { partial: true });
  assert.deepEqual(partialNotify.value, { notifyStyle: 'alarm' });

  // PATCH 语义：只校验并返回出现的字段。
  const partial = normalizeReminderRequest(
    { note: '只改备注' },
    { partial: true, base: { title: '喝水', note: '', dueAt: due, repeat: 'none', enabled: true } },
  );
  assert.equal(partial.ok, true);
  assert.deepEqual(partial.value, { note: '只改备注' });

  const emptyTitle = normalizeReminderRequest({ title: '   ', dueAt: due });
  assert.equal(emptyTitle.ok, false);
  assert.deepEqual(emptyTitle.errors, ['提醒标题不能为空']);

  // 超长标题/备注按上限截断（与 goals 的 util.str 行为一致）。
  const longTitle = normalizeReminderRequest({ title: '提'.repeat(120), dueAt: due });
  assert.equal(longTitle.ok, true);
  assert.equal(longTitle.value.title.length, 80);
  const longNote = normalizeReminderRequest({ title: 'x', note: '备'.repeat(800), dueAt: due });
  assert.equal(longNote.value.note.length, 500);

  assert.equal(normalizeReminderRequest({ title: 'x' }).ok, false);
  assert.equal(normalizeReminderRequest({ title: 'x', dueAt: '1760000000000' }).ok, false);
  assert.equal(normalizeReminderRequest({ title: 'x', dueAt: 1760000000000.5 }).ok, false);
  const badRepeat = normalizeReminderRequest({ title: 'x', dueAt: due, repeat: 'monthly' });
  assert.equal(badRepeat.ok, false);
  assert.match(badRepeat.errors.join('；'), /none \/ daily \/ weekly/);
  const badNotify = normalizeReminderRequest({ title: 'x', dueAt: due, notifyStyle: 'loud' });
  assert.equal(badNotify.ok, false);
  assert.deepEqual(badNotify.errors, ['提醒方式只能是 gentle 或 alarm']);
  assert.equal(normalizeReminderRequest({ title: 'x', dueAt: due, enabled: 'true' }).ok, false);

  // nextDueAt：daily / weekly 按整周期推进到 > fromMs，且至少推进一个周期。
  const noon = new Date(2026, 0, 5, 12, 0, 0, 0).getTime();
  assert.equal(nextDueAt(noon, 'none', noon), null);
  assert.equal(nextDueAt(noon, 'daily', noon), noon + DAY_MS);
  assert.equal(nextDueAt(noon - 3600 * 1000, 'daily', noon), noon - 3600 * 1000 + DAY_MS);
  assert.equal(nextDueAt(noon - 2 * DAY_MS, 'daily', noon), noon + DAY_MS);
  assert.equal(nextDueAt(noon + 5000, 'daily', noon), noon + 5000 + DAY_MS);
  assert.equal(nextDueAt(noon - 2 * WEEK_MS, 'weekly', noon), noon + WEEK_MS);
  assert.equal(nextDueAt(null, 'daily', noon), noon + DAY_MS);

  // restoreReminder：损坏条目跳过、缺失 id 重建、非法字段回默认。
  const restored = restoreReminder({
    title: '补水',
    dueAt: due,
    repeat: 'weekly',
    enabled: false,
    fireCount: 3,
  });
  assert.match(restored.id, /^rem_/);
  assert.equal(restored.title, '补水');
  assert.equal(restored.repeat, 'weekly');
  assert.equal(restored.notifyStyle, DEFAULT_NOTIFY_STYLE);
  assert.equal(restored.enabled, false);
  assert.equal(restored.fireCount, 3);
  assert.equal(restored.lastFiredAt, null);
  assert.equal(restoreReminder(null), null);
  assert.equal(restoreReminder({ title: '没有到期时间' }), null);
  const sanitized = restoreReminder({
    id: 'rem_ok',
    dueAt: due,
    repeat: 'yearly',
    notifyStyle: 'loud',
    enabled: 'false',
    fireCount: -2,
  });
  assert.equal(sanitized.repeat, 'none');
  assert.equal(sanitized.notifyStyle, DEFAULT_NOTIFY_STYLE);
  assert.equal(sanitized.enabled, true);
  assert.equal(sanitized.fireCount, 0);
  assert.equal(restoreReminder({ id: 'rem_alarm', dueAt: due, notifyStyle: 'alarm' }).notifyStyle, 'alarm');

  // 对外 JSON：固定字段、深拷贝、不带内部字段。
  const raw = {
    id: 'rem_1',
    title: 't',
    note: '',
    dueAt: due,
    repeat: 'none',
    notifyStyle: 'alarm',
    enabled: true,
    createdAt: 'a',
    updatedAt: 'b',
    lastFiredAt: null,
    fireCount: 1,
    secret: 'x',
  };
  const json = reminderToJson(raw);
  assert.deepEqual(Object.keys(json), [
    'id',
    'title',
    'note',
    'dueAt',
    'repeat',
    'notifyStyle',
    'enabled',
    'createdAt',
    'updatedAt',
    'lastFiredAt',
    'fireCount',
  ]);
  assert.equal(json.notifyStyle, 'alarm');
  assert.equal(json.secret, undefined);
  json.title = 'changed';
  assert.equal(raw.title, 't');
});

test('提醒 notifyStyle：默认 gentle、alarm 创建、非法值 400、PATCH 与快照', async (t) => {
  const env = await startTestHub(t);
  const base = Date.now();

  // 未提供时默认 gentle。
  const gentle = await createReminder(env, { title: '普通通知', dueAt: base + 1000 });
  assert.equal(gentle.notifyStyle, 'gentle');

  // 显式 alarm 创建成功。
  const alarm = await createReminder(env, {
    title: '闹钟通知',
    dueAt: base + 2000,
    repeat: 'daily',
    notifyStyle: 'alarm',
  });
  assert.equal(alarm.notifyStyle, 'alarm');

  // 非法值 400，错误信息为冻结文案。
  const badCreate = await request(env.base, 'POST', '/api/reminders', {
    headers: adminHeaders(env),
    body: { title: '非法方式', dueAt: base + 3000, notifyStyle: 'loud' },
  });
  assert.equal(badCreate.status, 400, badCreate.text);
  assert.equal(badCreate.json.error.message, '提醒方式只能是 gentle 或 alarm');

  // PATCH 单独修改 notifyStyle；未提供时保持原值。
  const patched = await request(env.base, 'PATCH', `/api/reminders/${gentle.id}`, {
    headers: adminHeaders(env),
    body: { notifyStyle: 'alarm' },
  });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.json.reminder.notifyStyle, 'alarm');
  assert.equal(patched.json.reminder.title, '普通通知');

  const badPatch = await request(env.base, 'PATCH', `/api/reminders/${gentle.id}`, {
    headers: adminHeaders(env),
    body: { notifyStyle: 'silent' },
  });
  assert.equal(badPatch.status, 400, badPatch.text);
  assert.equal(badPatch.json.error.message, '提醒方式只能是 gentle 或 alarm');

  const patchedTitle = await request(env.base, 'PATCH', `/api/reminders/${alarm.id}`, {
    headers: adminHeaders(env),
    body: { title: '闹钟通知改' },
  });
  assert.equal(patchedTitle.status, 200, patchedTitle.text);
  assert.equal(patchedTitle.json.reminder.notifyStyle, 'alarm');

  // 快照与列表都带 notifyStyle。
  const listed = await request(env.base, 'GET', '/api/reminders', { headers: adminHeaders(env) });
  assert.deepEqual(
    listed.json.reminders.map((item) => item.notifyStyle),
    ['alarm', 'alarm'],
  );
  const snap = await snapshot(env);
  assert.equal(snap.reminders.find((item) => item.id === alarm.id).notifyStyle, 'alarm');

  // fire 不改变 notifyStyle。
  const fired = await request(env.base, 'POST', `/api/reminders/${alarm.id}/fire`, {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(fired.status, 200, fired.text);
  assert.equal(fired.json.reminder.notifyStyle, 'alarm');
});

test('提醒 API：创建/列表/快照/编辑/删除/鉴权/校验', async (t) => {
  const env = await startTestHub(t);
  const base = Date.now();

  const unauthorized = await request(env.base, 'GET', '/api/reminders', {});
  assert.equal(unauthorized.status, 401);
  const unauthorizedCreate = await request(env.base, 'POST', '/api/reminders', {
    body: { title: '无令牌', dueAt: base + 60000 },
  });
  assert.equal(unauthorizedCreate.status, 401);

  const empty = await request(env.base, 'GET', '/api/reminders', { headers: adminHeaders(env) });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json.reminders, []);
  assert.ok(empty.json.hubTime);

  const first = await createReminder(env, {
    title: '喝水提醒',
    note: '每天八杯水',
    dueAt: base + 3000,
    repeat: 'daily',
  });
  assert.match(first.id, /^rem_/);
  assert.equal(first.title, '喝水提醒');
  assert.equal(first.note, '每天八杯水');
  assert.equal(first.dueAt, base + 3000);
  assert.equal(first.repeat, 'daily');
  assert.equal(first.notifyStyle, 'gentle');
  assert.equal(first.enabled, true);
  assert.equal(first.lastFiredAt, null);
  assert.equal(first.fireCount, 0);
  assert.ok(Number.isFinite(Date.parse(first.createdAt)));
  assert.ok(Number.isFinite(Date.parse(first.updatedAt)));

  // 校验错误：中文、多个错误用「；」连接。
  const missing = await request(env.base, 'POST', '/api/reminders', {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error.code, 'bad_request');
  assert.match(missing.json.error.message, /提醒标题不能为空/);
  assert.match(missing.json.error.message, /；/);

  const badRepeat = await request(env.base, 'POST', '/api/reminders', {
    headers: adminHeaders(env),
    body: { title: '非法重复', dueAt: base + 1000, repeat: 'monthly' },
  });
  assert.equal(badRepeat.status, 400);
  assert.match(badRepeat.json.error.message, /提醒重复方式/);

  const badDueAt = await request(env.base, 'POST', '/api/reminders', {
    headers: adminHeaders(env),
    body: { title: '非法时间', dueAt: String(base + 1000) },
  });
  assert.equal(badDueAt.status, 400);
  assert.match(badDueAt.json.error.message, /毫秒时间戳/);

  const badNotifyStyle = await request(env.base, 'POST', '/api/reminders', {
    headers: adminHeaders(env),
    body: { title: '非法提醒方式', dueAt: base + 1000, notifyStyle: 'loud' },
  });
  assert.equal(badNotifyStyle.status, 400);
  assert.match(badNotifyStyle.json.error.message, /提醒方式只能是 gentle 或 alarm/);

  // 列表按 dueAt 升序。
  await createReminder(env, { title: '排第二', dueAt: base + 2000 });
  await createReminder(env, { title: '排第一', dueAt: base + 1000 });
  const listed = await request(env.base, 'GET', '/api/reminders', { headers: adminHeaders(env) });
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.json.reminders.map((item) => item.dueAt),
    [base + 1000, base + 2000, base + 3000],
  );

  // 快照必须带 reminders（APK 每 5s 轮询）。
  const snap = await snapshot(env);
  assert.equal(snap.reminders.length, 3);
  assert.equal(snap.reminders[0].id, listed.json.reminders[0].id);

  // notifyStyle：显式 alarm 创建成功，默认值保持 gentle。
  const alarmReminder = await createReminder(env, {
    title: '闹钟提醒',
    dueAt: base + 4000,
    notifyStyle: 'alarm',
  });
  assert.equal(alarmReminder.notifyStyle, 'alarm');
  const gotAlarm = await getReminder(env, alarmReminder.id);
  assert.equal(gotAlarm.json.reminder.notifyStyle, 'alarm');

  const got = await getReminder(env, first.id);
  assert.equal(got.status, 200);
  assert.equal(got.json.reminder.title, '喝水提醒');
  assert.ok(got.json.hubTime);

  // PATCH 部分更新：未出现的字段保持不变。
  const patched = await request(env.base, 'PATCH', `/api/reminders/${first.id}`, {
    headers: adminHeaders(env),
    body: { title: '多喝水', note: '' },
  });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.json.reminder.title, '多喝水');
  assert.equal(patched.json.reminder.note, '');
  assert.equal(patched.json.reminder.dueAt, base + 3000);
  assert.equal(patched.json.reminder.repeat, 'daily');
  assert.equal(patched.json.reminder.notifyStyle, 'gentle');
  assert.ok(patched.json.reminder.updatedAt >= first.updatedAt);

  // PATCH 可单独修改 notifyStyle；未提供时保持原值。
  const patchedStyle = await request(env.base, 'PATCH', `/api/reminders/${first.id}`, {
    headers: adminHeaders(env),
    body: { notifyStyle: 'alarm' },
  });
  assert.equal(patchedStyle.status, 200, patchedStyle.text);
  assert.equal(patchedStyle.json.reminder.notifyStyle, 'alarm');
  assert.equal(patchedStyle.json.reminder.title, '多喝水');
  const badStylePatch = await request(env.base, 'PATCH', `/api/reminders/${first.id}`, {
    headers: adminHeaders(env),
    body: { notifyStyle: 'loud' },
  });
  assert.equal(badStylePatch.status, 400);
  assert.match(badStylePatch.json.error.message, /提醒方式只能是 gentle 或 alarm/);

  // PATCH 显式 enabled:true 且 dueAt 已过期：不自动改 dueAt（交给客户端表单处理）。
  const expired = await createReminder(env, {
    title: '已过期',
    dueAt: base - 60000,
    repeat: 'none',
    enabled: false,
  });
  const reenabled = await request(env.base, 'PATCH', `/api/reminders/${expired.id}`, {
    headers: adminHeaders(env),
    body: { enabled: true },
  });
  assert.equal(reenabled.status, 200, reenabled.text);
  assert.equal(reenabled.json.reminder.enabled, true);
  assert.equal(reenabled.json.reminder.dueAt, base - 60000);

  const badPatch = await request(env.base, 'PATCH', `/api/reminders/${first.id}`, {
    headers: adminHeaders(env),
    body: { title: '   ' },
  });
  assert.equal(badPatch.status, 400);

  // 不存在 / 非法 id。
  for (const [method, suffix] of [
    ['GET', ''],
    ['PATCH', ''],
    ['DELETE', ''],
    ['POST', '/fire'],
  ]) {
    const res = await request(env.base, method, `/api/reminders/rem_missing${suffix}`, {
      headers: adminHeaders(env),
      body: method === 'GET' || method === 'DELETE' ? undefined : {},
    });
    assert.equal(res.status, 404, `${method} 缺失提醒应 404：${res.text}`);
    assert.equal(res.json.error.code, 'not_found');
    assert.equal(res.json.error.message, '提醒不存在');
  }

  // 删除：返回 { deleted, reminderId, hubTime }，列表不再包含。
  const deleted = await request(env.base, 'DELETE', `/api/reminders/${first.id}`, {
    headers: adminHeaders(env),
  });
  assert.equal(deleted.status, 200, deleted.text);
  assert.equal(deleted.json.deleted, true);
  assert.equal(deleted.json.reminderId, first.id);
  assert.ok(deleted.json.hubTime);
  const afterDelete = await request(env.base, 'GET', '/api/reminders', { headers: adminHeaders(env) });
  assert.equal(afterDelete.json.reminders.length, 4);
  assert.ok(!afterDelete.json.reminders.some((item) => item.id === first.id));
});

test('提醒到点回写：one-shot 停用、daily/weekly 推进到未来并累计触发次数', async (t) => {
  const env = await startTestHub(t);
  const base = Date.now();

  const once = await createReminder(env, {
    title: '一次性提醒',
    dueAt: base - 5000,
    repeat: 'none',
  });
  const firedOnce = await request(env.base, 'POST', `/api/reminders/${once.id}/fire`, {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(firedOnce.status, 200, firedOnce.text);
  const onceJson = firedOnce.json.reminder;
  assert.equal(onceJson.repeat, 'none');
  assert.equal(onceJson.notifyStyle, 'gentle');
  assert.equal(onceJson.enabled, false);
  assert.equal(onceJson.fireCount, 1);
  assert.equal(onceJson.dueAt, base - 5000);
  assert.ok(Number.isFinite(Date.parse(onceJson.lastFiredAt)));
  assert.equal(onceJson.lastFiredAt, onceJson.updatedAt);

  const daily = await createReminder(env, {
    title: '每日提醒',
    dueAt: base - 1000,
    repeat: 'daily',
  });
  const firedDaily = await request(env.base, 'POST', `/api/reminders/${daily.id}/fire`, {
    headers: adminHeaders(env),
    body: { firedAt: iso(base) },
  });
  assert.equal(firedDaily.status, 200, firedDaily.text);
  const dailyJson = firedDaily.json.reminder;
  assert.equal(dailyJson.repeat, 'daily');
  assert.equal(dailyJson.enabled, true);
  assert.equal(dailyJson.fireCount, 1);
  assert.ok(dailyJson.dueAt > Date.now(), `dueAt 应推进到未来：${dailyJson.dueAt}`);
  assert.ok(dailyJson.dueAt > base);

  // 再次触发：继续推进一个周期，fireCount 累加。
  const firstNext = dailyJson.dueAt;
  const firedAgain = await request(env.base, 'POST', `/api/reminders/${daily.id}/fire`, {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(firedAgain.status, 200, firedAgain.text);
  assert.equal(firedAgain.json.reminder.fireCount, 2);
  assert.equal(firedAgain.json.reminder.dueAt, firstNext + DAY_MS);
  assert.equal(firedAgain.json.reminder.enabled, true);

  const weekly = await createReminder(env, {
    title: '每周提醒',
    dueAt: base - 1000,
    repeat: 'weekly',
  });
  const firedWeekly = await request(env.base, 'POST', `/api/reminders/${weekly.id}/fire`, {
    headers: adminHeaders(env),
    body: { firedAt: iso(base) },
  });
  assert.equal(firedWeekly.status, 200, firedWeekly.text);
  const weeklyJson = firedWeekly.json.reminder;
  assert.ok(weeklyJson.dueAt > Date.now());
  assert.equal(weeklyJson.dueAt, base - 1000 + WEEK_MS);
  assert.equal(weeklyJson.enabled, true);

  // firedAt 非法时回退到当前时间，仍能推进。
  const firedBadAt = await request(env.base, 'POST', `/api/reminders/${weekly.id}/fire`, {
    headers: adminHeaders(env),
    body: { firedAt: 'not-a-date' },
  });
  assert.equal(firedBadAt.status, 200, firedBadAt.text);
  assert.ok(firedBadAt.json.reminder.dueAt > Date.now());

  // 不存在的提醒。
  const missing = await request(env.base, 'POST', '/api/reminders/rem_missing/fire', {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.message, '提醒不存在');
});

test('提醒 SSE：created/updated/deleted/fired 四种广播', async (t) => {
  const env = await startTestHub(t);
  const sse = openSse(env);
  const state = await sse.ready;
  assert.equal(state.status, 200);
  t.after(() => sse.close());

  const created = await request(env.base, 'POST', '/api/reminders', {
    headers: adminHeaders(env),
    body: { title: '广播提醒', dueAt: Date.now() + 60000, repeat: 'daily' },
  });
  assert.equal(created.status, 200, created.text);
  const reminderId = created.json.reminder.id;
  const createdEvent = await sse.waitForEvent('reminder.created', {
    timeout: 3000,
    predicate: (data) => data && data.reminder && data.reminder.id === reminderId,
  });
  assert.equal(createdEvent.data.reminder.title, '广播提醒');
  assert.equal(createdEvent.data.reminder.notifyStyle, 'gentle');

  const patched = await request(env.base, 'PATCH', `/api/reminders/${reminderId}`, {
    headers: adminHeaders(env),
    body: { title: '广播提醒改名' },
  });
  assert.equal(patched.status, 200, patched.text);
  const updatedEvent = await sse.waitForEvent('reminder.updated', {
    timeout: 3000,
    predicate: (data) => data && data.reminder && data.reminder.id === reminderId,
  });
  assert.equal(updatedEvent.data.reminder.title, '广播提醒改名');

  const fired = await request(env.base, 'POST', `/api/reminders/${reminderId}/fire`, {
    headers: adminHeaders(env),
    body: {},
  });
  assert.equal(fired.status, 200, fired.text);
  const firedEvent = await sse.waitForEvent('reminder.fired', {
    timeout: 3000,
    predicate: (data) => data && data.reminder && data.reminder.id === reminderId,
  });
  assert.equal(firedEvent.data.reminder.fireCount, 1);

  const deleted = await request(env.base, 'DELETE', `/api/reminders/${reminderId}`, {
    headers: adminHeaders(env),
  });
  assert.equal(deleted.status, 200, deleted.text);
  const deletedEvent = await sse.waitForEvent('reminder.deleted', {
    timeout: 3000,
    predicate: (data) => data && data.reminderId === reminderId,
  });
  assert.equal(deletedEvent.data.reminderId, reminderId);
});

test('提醒持久化：重启后恢复字段、state.json dueAt 为数字', async (t) => {
  const dataDir = await makeTempDir('butler-reminders-');
  const base = Date.now();
  const created = [];
  const first = await startHubAt(dataDir);
  try {
    created.push(
      await createReminder(first, {
        title: '持久化一次性',
        note: '重启后仍在',
        dueAt: base + 3600 * 1000,
        repeat: 'none',
        notifyStyle: 'alarm',
      }),
    );
    const daily = await createReminder(first, {
      title: '持久化每日',
      dueAt: base - 1000,
      repeat: 'daily',
    });
    const fired = await request(first.base, 'POST', `/api/reminders/${daily.id}/fire`, {
      headers: adminHeaders(first),
      body: { firedAt: iso(base) },
    });
    assert.equal(fired.status, 200, fired.text);
    created.push(fired.json.reminder);
    await first.hub.flushState();

    const state = await readStateFile(dataDir);
    assert.equal(state.reminders.length, 2);
    for (const item of state.reminders) {
      assert.equal(typeof item.dueAt, 'number');
      assert.equal(item.lastFiredAt === null || typeof item.lastFiredAt === 'string', true);
    }
    const dailyState = state.reminders.find((item) => item.id === daily.id);
    assert.equal(dailyState.repeat, 'daily');
    assert.equal(dailyState.fireCount, 1);
    assert.equal(dailyState.notifyStyle, 'gentle');
    const onceState = state.reminders.find((item) => item.title === '持久化一次性');
    assert.equal(onceState.notifyStyle, 'alarm');
  } finally {
    await first.hub.close();
  }

  const second = await startHubAt(dataDir);
  try {
    const res = await request(second.base, 'GET', '/api/reminders', { headers: adminHeaders(second) });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.reminders.length, 2);
    for (const expected of created) {
      const actual = res.json.reminders.find((item) => item.id === expected.id);
      assert.ok(actual, `重启后应恢复提醒 ${expected.id}`);
      assert.equal(actual.title, expected.title);
      assert.equal(actual.note, expected.note);
      assert.equal(actual.repeat, expected.repeat);
      assert.equal(actual.notifyStyle, expected.notifyStyle);
      assert.equal(actual.dueAt, expected.dueAt);
      assert.equal(actual.fireCount, expected.fireCount);
      assert.equal(actual.lastFiredAt, expected.lastFiredAt);
    }
    const snap = await snapshot(second);
    assert.equal(snap.reminders.length, 2);
  } finally {
    await second.hub.close();
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  }
});

test('提醒恢复容错：跳过损坏条目并重建缺失 id', async (t) => {
  const dataDir = await makeTempDir('butler-reminders-corrupt-');
  const dueAt = Date.now() + 3600 * 1000;
  await fs.promises.writeFile(
    path.join(dataDir, 'state.json'),
    JSON.stringify({
      version: 1,
      reminders: [
        null,
        'garbage',
        { title: '缺少 dueAt' },
        { id: 'rem_bad_due', title: '非法 dueAt', dueAt: 'tomorrow' },
        {
          title: '无 id 提醒',
          note: '恢复时重建 id',
          dueAt,
          repeat: 'daily',
          enabled: true,
          fireCount: 2,
        },
      ],
    }),
    'utf8',
  );

  const env = await startHubAt(dataDir);
  try {
    const res = await request(env.base, 'GET', '/api/reminders', { headers: adminHeaders(env) });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.reminders.length, 1);
    const [reminder] = res.json.reminders;
    assert.match(reminder.id, /^rem_/);
    assert.equal(reminder.title, '无 id 提醒');
    assert.equal(reminder.note, '恢复时重建 id');
    assert.equal(reminder.dueAt, dueAt);
    assert.equal(reminder.repeat, 'daily');
    assert.equal(reminder.notifyStyle, 'gentle');
    assert.equal(reminder.fireCount, 2);
  } finally {
    await env.hub.close();
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  }
});
