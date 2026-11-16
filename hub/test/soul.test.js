'use strict';

/**
 * 心智（Soul/Skill）纯函数测试（docs/SOUL-SKILL-DESIGN.md §9.4）。
 *
 * 只覆盖 hub/lib/soul.js 的纯函数：默认值、字数上限、PATCH 归一化、
 * 容错恢复与 JSON 视图。默认文本由 soul-defaults.js 自动生成，
 * 这里只断言非空/不超上限，不断言具体措辞。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_SOUL,
  DEFAULT_SKILL,
  MAX_SOUL_CHARS,
  MAX_SKILL_CHARS,
  MAX_MIND_TEXT,
  defaultMind,
  normalizeMindPatch,
  restoreMind,
  mindToJson,
} = require('../lib/soul.js');

const BASE = { soul: '基准灵魂', skill: '基准流程' };

test('默认心智：非空、在上限内、updatedAt 为 null', () => {
  assert.equal(typeof DEFAULT_SOUL, 'string');
  assert.equal(typeof DEFAULT_SKILL, 'string');
  assert.ok(DEFAULT_SOUL.trim().length > 0, '默认灵魂不能为空');
  assert.ok(DEFAULT_SKILL.trim().length > 0, '默认工作流程不能为空');
  assert.ok(DEFAULT_SOUL.length <= MAX_SOUL_CHARS);
  assert.ok(DEFAULT_SKILL.length <= MAX_SKILL_CHARS);
  assert.equal(MAX_SOUL_CHARS, 6000);
  assert.equal(MAX_SKILL_CHARS, 12000);
  assert.equal(MAX_MIND_TEXT, MAX_SKILL_CHARS);

  const mind = defaultMind();
  assert.deepEqual(mind, { soul: DEFAULT_SOUL, skill: DEFAULT_SKILL, updatedAt: null });
});

test('normalizeMindPatch：空补丁 / 未识别字段返回基准值', () => {
  for (const patch of [{}, null, undefined, { foo: 1 }]) {
    const res = normalizeMindPatch(patch, BASE);
    assert.equal(res.ok, true);
    assert.deepEqual(res.value, { soul: BASE.soul, skill: BASE.skill });
  }
});

test('normalizeMindPatch：文本 trim 与 CRLF 归一化', () => {
  const res = normalizeMindPatch({ soul: '  新灵魂\r\n第二行  ', skill: '\t新流程\n' }, BASE);
  assert.equal(res.ok, true);
  assert.equal(res.value.soul, '新灵魂\n第二行');
  assert.equal(res.value.skill, '新流程');
});

test('normalizeMindPatch：空白文本报错', () => {
  const soul = normalizeMindPatch({ soul: '   ' }, BASE);
  assert.equal(soul.ok, false);
  assert.deepEqual(soul.errors, ['灵魂不能为空']);

  const skill = normalizeMindPatch({ skill: '' }, BASE);
  assert.equal(skill.ok, false);
  assert.deepEqual(skill.errors, ['工作流程不能为空']);
});

test('normalizeMindPatch：非字符串报错', () => {
  const soul = normalizeMindPatch({ soul: 42 }, BASE);
  assert.equal(soul.ok, false);
  assert.deepEqual(soul.errors, ['灵魂必须是文本']);

  const skill = normalizeMindPatch({ skill: { text: 'x' } }, BASE);
  assert.equal(skill.ok, false);
  assert.deepEqual(skill.errors, ['工作流程必须是文本']);
});

test('normalizeMindPatch：超过字数上限报错', () => {
  const soul = normalizeMindPatch({ soul: 'a'.repeat(MAX_SOUL_CHARS + 1) }, BASE);
  assert.equal(soul.ok, false);
  assert.deepEqual(soul.errors, [`灵魂不能超过 ${MAX_SOUL_CHARS} 字（当前 ${MAX_SOUL_CHARS + 1} 字）`]);

  const skill = normalizeMindPatch({ skill: 'b'.repeat(MAX_SKILL_CHARS + 1) }, BASE);
  assert.equal(skill.ok, false);
  assert.deepEqual(skill.errors, [`工作流程不能超过 ${MAX_SKILL_CHARS} 字（当前 ${MAX_SKILL_CHARS + 1} 字）`]);
});

test('normalizeMindPatch：部分补丁沿用基准字段（合并语义）', () => {
  const soulOnly = normalizeMindPatch({ soul: 'x' }, { soul: 'a', skill: 'b' });
  assert.equal(soulOnly.ok, true);
  assert.deepEqual(soulOnly.value, { soul: 'x', skill: 'b' });

  const skillOnly = normalizeMindPatch({ skill: 'y' }, { soul: 'a', skill: 'b' });
  assert.equal(skillOnly.ok, true);
  assert.deepEqual(skillOnly.value, { soul: 'a', skill: 'y' });
});

test('normalizeMindPatch：resetSoul / resetSkill 恢复默认', () => {
  const soul = normalizeMindPatch({ resetSoul: true }, BASE);
  assert.equal(soul.ok, true);
  assert.equal(soul.value.soul, DEFAULT_SOUL);
  assert.equal(soul.value.skill, BASE.skill, 'resetSoul 不应影响工作流程');

  const both = normalizeMindPatch({ resetSoul: true, resetSkill: true }, BASE);
  assert.equal(both.ok, true);
  assert.equal(both.value.soul, DEFAULT_SOUL);
  assert.equal(both.value.skill, DEFAULT_SKILL);
});

test('normalizeMindPatch：显式文本优先于 reset', () => {
  const soul = normalizeMindPatch({ soul: '显式灵魂', resetSoul: true }, BASE);
  assert.equal(soul.ok, true);
  assert.equal(soul.value.soul, '显式灵魂');

  const skill = normalizeMindPatch({ resetSkill: true, skill: '显式流程' }, BASE);
  assert.equal(skill.ok, true);
  assert.equal(skill.value.skill, '显式流程');
});

test('normalizeMindPatch：reset 字段类型错误会被收集', () => {
  const onlyInvalidReset = normalizeMindPatch({ resetSoul: 'yes' }, BASE);
  assert.equal(onlyInvalidReset.ok, false);
  assert.deepEqual(onlyInvalidReset.errors, ['resetSoul 必须是布尔值']);

  const soul = normalizeMindPatch({ resetSoul: 'yes', soul: 'x' }, BASE);
  assert.equal(soul.ok, false);
  assert.deepEqual(soul.errors, ['resetSoul 必须是布尔值']);

  const skill = normalizeMindPatch({ skill: 'x', resetSkill: 1 }, BASE);
  assert.equal(skill.ok, false);
  assert.deepEqual(skill.errors, ['resetSkill 必须是布尔值']);
});

test('restoreMind：非法输入回退默认值', () => {
  const expected = defaultMind();
  for (const raw of [null, undefined, '文本', 42, [1, 2], { soul: '', skill: '   ', updatedAt: 5 }]) {
    assert.deepEqual(restoreMind(raw), expected);
  }
  // 非字符串 updatedAt 一律 null
  assert.equal(restoreMind({ soul: '', skill: '', updatedAt: 5 }).updatedAt, null);
});

test('restoreMind：截断到上限并保留合法 updatedAt', () => {
  const updatedAt = '2026-01-02T03:04:05.000Z';
  const mind = restoreMind({
    soul: `  ${'s'.repeat(MAX_SOUL_CHARS + 500)}  `,
    skill: `  ${'k'.repeat(MAX_SKILL_CHARS + 500)}  `,
    updatedAt,
  });
  assert.equal(mind.soul.length, MAX_SOUL_CHARS);
  assert.equal(mind.skill.length, MAX_SKILL_CHARS);
  assert.equal(mind.updatedAt, updatedAt);
});

test('mindToJson：默认值、字数与 limits/defaults', () => {
  const view = mindToJson({});
  assert.equal(view.soul, DEFAULT_SOUL);
  assert.equal(view.skill, DEFAULT_SKILL);
  assert.equal(view.updatedAt, null);
  assert.equal(view.soulIsDefault, true);
  assert.equal(view.skillIsDefault, true);
  assert.equal(view.soulChars, DEFAULT_SOUL.length);
  assert.equal(view.skillChars, DEFAULT_SKILL.length);
  assert.deepEqual(view.limits, { soul: MAX_SOUL_CHARS, skill: MAX_SKILL_CHARS });
  assert.deepEqual(view.defaults, { soul: DEFAULT_SOUL, skill: DEFAULT_SKILL });
});

test('mindToJson：自定义文本与空文本回退', () => {
  const updatedAt = '2026-02-03T04:05:06.000Z';
  const custom = mindToJson({ soul: '自定义灵魂', skill: '自定义流程', updatedAt });
  assert.equal(custom.soul, '自定义灵魂');
  assert.equal(custom.skill, '自定义流程');
  assert.equal(custom.updatedAt, updatedAt);
  assert.equal(custom.soulIsDefault, false);
  assert.equal(custom.skillIsDefault, false);
  assert.equal(custom.soulChars, '自定义灵魂'.length);
  assert.equal(custom.skillChars, '自定义流程'.length);

  const empty = mindToJson({ soul: '', skill: '', updatedAt: null });
  assert.equal(empty.soul, DEFAULT_SOUL);
  assert.equal(empty.skill, DEFAULT_SKILL);
  assert.equal(empty.soulIsDefault, true);
  assert.equal(empty.skillIsDefault, true);
});
