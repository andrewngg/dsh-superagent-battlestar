'use strict';

/**
 * 心智（Soul/Skill）Hub 集成测试（docs/SOUL-SKILL-DESIGN.md §9.5-§9.7）。
 *
 * 验证：默认心智、updateMind 更新与持久化、resetSoul/resetSkill、
 * buildBrainPrompt 注入、Hub 思考提示词包含当前心智、mind.updated
 * 不写常规事件、HTTP GET/PATCH /api/mind 与鉴权、state.json 落盘。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DEFAULT_SOUL, DEFAULT_SKILL } = require('../lib/soul.js');
const { buildBrainPrompt } = require('../lib/brain.js');
const { createHub } = require('../lib/hub.js');
const { startTestHub, request, adminHeaders, readStateFile } = require('./_helpers.js');

const HUB_OPTIONS = {
  silent: true,
  persistDebounceMs: 5,
  nightlyReview: false,
  brainTickMs: 3600000,
  goalTickMs: 3600000,
};

async function newHub(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-mind-hub-'));
  const hub = await createHub({ dataDir, ...HUB_OPTIONS, ...overrides });
  t.after(async () => {
    try {
      await hub.close();
    } catch {
      /* 已关闭 */
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return hub;
}

test('默认心智：getMind 返回默认灵魂与工作方法', async (t) => {
  const hub = await newHub(t);
  const mind = hub.getMind();

  assert.equal(mind.soul, DEFAULT_SOUL);
  assert.equal(mind.skill, DEFAULT_SKILL);
  assert.equal(mind.updatedAt, null);
  assert.equal(mind.soulIsDefault, true);
  assert.equal(mind.skillIsDefault, true);
  assert.deepEqual(mind.limits, { soul: 6000, skill: 12000 });
  assert.equal(mind.soulChars, DEFAULT_SOUL.length);
  assert.equal(mind.skillChars, DEFAULT_SKILL.length);

  const state = hub.serializeState();
  assert.deepEqual(state.mind, { soul: DEFAULT_SOUL, skill: DEFAULT_SKILL, updatedAt: null });
});

test('updateMind：更新文本、写入 updatedAt 与序列化状态', async (t) => {
  const hub = await newHub(t);
  const before = Date.now();

  const mind = await hub.updateMind({ soul: '新的灵魂：先胜后战', skill: '新的流程：先观察再动手' });
  assert.equal(mind.soul, '新的灵魂：先胜后战');
  assert.equal(mind.skill, '新的流程：先观察再动手');
  assert.equal(mind.soulIsDefault, false);
  assert.equal(mind.skillIsDefault, false);
  assert.equal(typeof mind.updatedAt, 'string');
  assert.ok(Date.parse(mind.updatedAt) >= before - 1000);

  const state = hub.serializeState();
  assert.equal(state.mind.soul, '新的灵魂：先胜后战');
  assert.equal(state.mind.skill, '新的流程：先观察再动手');
  assert.equal(state.mind.updatedAt, mind.updatedAt);
});

test('updateMind：非法补丁抛 400 且不改变当前心智', async (t) => {
  const hub = await newHub(t);
  await hub.updateMind({ soul: '稳定灵魂' });

  assert.throws(() => hub.updateMind({ soul: '' }), /灵魂不能为空/);
  assert.throws(() => hub.updateMind({ skill: 'x'.repeat(12001) }), /工作流程不能超过 12000 字/);

  assert.equal(hub.getMind().soul, '稳定灵魂');
  assert.equal(hub.getMind().skillIsDefault, true);
});

test('updateMind：resetSoul / resetSkill 恢复默认且只影响目标字段', async (t) => {
  const hub = await newHub(t);
  await hub.updateMind({ soul: '自定义灵魂', skill: '自定义流程' });

  const soulReset = await hub.updateMind({ resetSoul: true });
  assert.equal(soulReset.soul, DEFAULT_SOUL);
  assert.equal(soulReset.soulIsDefault, true);
  assert.equal(soulReset.skill, '自定义流程', 'resetSoul 不应影响工作流程');

  const skillReset = await hub.updateMind({ resetSkill: true });
  assert.equal(skillReset.skill, DEFAULT_SKILL);
  assert.equal(skillReset.skillIsDefault, true);
  assert.equal(skillReset.soul, DEFAULT_SOUL);

  const bothReset = await hub.updateMind({ resetSoul: true, resetSkill: true });
  assert.equal(bothReset.soul, DEFAULT_SOUL);
  assert.equal(bothReset.skill, DEFAULT_SKILL);
});

test('构造参数 mind 注入：启动时使用注入的心智', async (t) => {
  const hub = await newHub(t, { mind: { soul: '注入灵魂', skill: '注入流程' } });
  const mind = hub.getMind();
  assert.equal(mind.soul, '注入灵魂');
  assert.equal(mind.skill, '注入流程');
  assert.equal(mind.soulIsDefault, false);
});

test('buildBrainPrompt：注入灵魂与工作方法段落，且保留六步协议', async (t) => {
  const hub = await newHub(t);
  await hub.updateMind({ soul: '我的灵魂是行动优先', skill: '我的流程是先列清单' });

  const withMind = buildBrainPrompt({}, { mind: { soul: hub.mind.soul, skill: hub.mind.skill } });
  assert.match(withMind.system, /## 你的灵魂（个性与价值观）/);
  assert.match(withMind.system, /我的灵魂是行动优先/);
  assert.match(withMind.system, /## 你的工作方法（思考与行动流程）/);
  assert.match(withMind.system, /我的流程是先列清单/);
  assert.match(withMind.system, /先按上面的灵魂与工作方法推进判断，再把它压缩进六步 assessment/);
  assert.match(withMind.system, /六步/);

  const withoutMind = buildBrainPrompt({}, {});
  assert.doesNotMatch(withoutMind.system, /## 你的灵魂（个性与价值观）/);
  assert.match(withoutMind.system, /六步/);
});

test('Hub 思考：注入 brainThink 收到的 system 包含当前心智', async (t) => {
  const captured = [];
  const hub = await newHub(t, {
    brainThink: async (payload) => {
      captured.push(payload);
      return JSON.stringify({ summary: '保持观察，无需动作', actions: [] });
    },
  });
  await hub.updateMind({ soul: '思考时的灵魂文本', skill: '思考时的工作流程文本' });

  const decision = await hub.requestBrainThink({ trigger: 'manual' });
  assert.equal(decision.error, null);
  assert.equal(captured.length, 1);
  assert.match(captured[0].system, /## 你的灵魂（个性与价值观）/);
  assert.match(captured[0].system, /思考时的灵魂文本/);
  assert.match(captured[0].system, /## 你的工作方法（思考与行动流程）/);
  assert.match(captured[0].system, /思考时的工作流程文本/);
});

test('mind.updated 广播不写入常规事件记录', async (t) => {
  const hub = await newHub(t);
  const before = hub.events.length;

  await hub.updateMind({ soul: '不写事件测试' });

  const added = hub.events.slice(before);
  assert.equal(
    added.some((event) => event && event.type === 'mind.updated'),
    false,
    'mind.updated 应使用 record:false，不进入常规事件',
  );
});

test('持久化：flushState 后重启恢复自定义心智', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-mind-persist-'));
  let hub = await createHub({ dataDir, ...HUB_OPTIONS });
  try {
    const updated = await hub.updateMind({ soul: '重启后仍存在的灵魂', skill: '重启后仍存在的流程' });
    await hub.flushState();
    await hub.close();

    hub = await createHub({ dataDir, ...HUB_OPTIONS });
    const restored = hub.getMind();
    assert.equal(restored.soul, '重启后仍存在的灵魂');
    assert.equal(restored.skill, '重启后仍存在的流程');
    assert.equal(restored.updatedAt, updated.updatedAt);

    const state = hub.serializeState();
    assert.equal(state.mind.soul, '重启后仍存在的灵魂');

    const onDisk = await readStateFile(dataDir);
    assert.equal(onDisk.mind.soul, '重启后仍存在的灵魂');
    assert.equal(onDisk.mind.skill, '重启后仍存在的流程');
  } finally {
    await hub.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('HTTP GET /api/mind：返回默认心智与限制，未授权 401', async (t) => {
  const env = await startTestHub(t, { brainTickMs: 3600000, goalTickMs: 3600000 });

  const res = await request(env.base, 'GET', '/api/mind', { headers: adminHeaders(env) });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(Object.keys(res.json).sort(), ['hubTime', 'mind']);
  assert.equal(res.json.mind.soul, DEFAULT_SOUL);
  assert.equal(res.json.mind.soulIsDefault, true);
  assert.deepEqual(res.json.mind.limits, { soul: 6000, skill: 12000 });
  assert.equal(typeof res.json.hubTime, 'string');

  const unauthorized = await request(env.base, 'GET', '/api/mind');
  assert.equal(unauthorized.status, 401);
});

test('HTTP PATCH /api/mind：更新、空文本 400、reset 恢复默认', async (t) => {
  const env = await startTestHub(t, { brainTickMs: 3600000, goalTickMs: 3600000 });

  const patched = await request(env.base, 'PATCH', '/api/mind', {
    headers: adminHeaders(env),
    body: { soul: 'HTTP 灵魂', skill: 'HTTP 流程' },
  });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.json.mind.soul, 'HTTP 灵魂');
  assert.equal(patched.json.mind.skill, 'HTTP 流程');
  assert.equal(patched.json.mind.soulIsDefault, false);
  assert.equal(typeof patched.json.mind.updatedAt, 'string');
  assert.equal(env.hub.getMind().soul, 'HTTP 灵魂');

  const invalid = await request(env.base, 'PATCH', '/api/mind', {
    headers: adminHeaders(env),
    body: { soul: '   ' },
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.text, /灵魂不能为空/);

  const reset = await request(env.base, 'PATCH', '/api/mind', {
    headers: adminHeaders(env),
    body: { resetSoul: true, resetSkill: true },
  });
  assert.equal(reset.status, 200, reset.text);
  assert.equal(reset.json.mind.soul, DEFAULT_SOUL);
  assert.equal(reset.json.mind.skill, DEFAULT_SKILL);
  assert.equal(reset.json.mind.soulIsDefault, true);

  const unauthorized = await request(env.base, 'PATCH', '/api/mind', { body: { soul: 'x' } });
  assert.equal(unauthorized.status, 401);
});

test('HTTP PATCH /api/mind：部分更新不清空另一字段', async (t) => {
  const env = await startTestHub(t, { brainTickMs: 3600000, goalTickMs: 3600000 });

  const initial = await request(env.base, 'PATCH', '/api/mind', {
    headers: adminHeaders(env),
    body: { soul: '初始灵魂', skill: '初始流程' },
  });
  assert.equal(initial.status, 200, initial.text);

  const soulOnly = await request(env.base, 'PATCH', '/api/mind', {
    headers: adminHeaders(env),
    body: { soul: '仅更新灵魂' },
  });
  assert.equal(soulOnly.status, 200, soulOnly.text);
  assert.equal(soulOnly.json.mind.soul, '仅更新灵魂');
  assert.equal(soulOnly.json.mind.skill, '初始流程', '只传 soul 时不应清空 skill');

  const fetched = await request(env.base, 'GET', '/api/mind', { headers: adminHeaders(env) });
  assert.equal(fetched.status, 200, fetched.text);
  assert.equal(fetched.json.mind.soul, '仅更新灵魂');
  assert.equal(fetched.json.mind.skill, '初始流程');

  const resetSoul = await request(env.base, 'PATCH', '/api/mind', {
    headers: adminHeaders(env),
    body: { resetSoul: true },
  });
  assert.equal(resetSoul.status, 200, resetSoul.text);
  assert.equal(resetSoul.json.mind.soul, DEFAULT_SOUL);
  assert.equal(resetSoul.json.mind.skill, '初始流程', 'resetSoul 不应清空 skill');
});
