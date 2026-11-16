/**
 * 心智（Soul / Skill）纯函数：默认值、归一化、容错恢复与对外 JSON。
 * 契约见 docs/SOUL-SKILL-DESIGN.md §9。
 */
const util = require('./util');
const { DEFAULT_SOUL, DEFAULT_SKILL } = require('./soul-defaults');

const MAX_SOUL_CHARS = 6000;
const MAX_SKILL_CHARS = 12000;

/** 默认心智状态。 */
function defaultMind() {
  return { soul: DEFAULT_SOUL, skill: DEFAULT_SKILL, updatedAt: null };
}

function normalizeText(value, max, label, errors) {
  if (typeof value !== 'string') {
    errors.push(`${label}必须是文本`);
    return null;
  }
  const text = value.replace(/\r\n/g, '\n').trim();
  if (!text) {
    errors.push(`${label}不能为空`);
    return null;
  }
  if (text.length > max) {
    errors.push(`${label}不能超过 ${max} 字（当前 ${text.length} 字）`);
    return null;
  }
  return text;
}

/**
 * 归一化 PATCH 补丁；resetSoul/resetSkill 与显式文本同时出现时以显式文本优先。
 * @returns {{ok:true,value:object}|{ok:false,errors:string[]}}
 */
function normalizeMindPatch(patch = {}, base = defaultMind()) {
  const src = util.isPlainObject(patch) ? patch : {};
  const errors = [];
  const baseMind = util.isPlainObject(base) ? base : defaultMind();

  const hasSoul = Object.prototype.hasOwnProperty.call(src, 'soul');
  const hasSkill = Object.prototype.hasOwnProperty.call(src, 'skill');
  const resetSoul = src.resetSoul === true;
  const resetSkill = src.resetSkill === true;
  if (src.resetSoul !== undefined && typeof src.resetSoul !== 'boolean') {
    errors.push('resetSoul 必须是布尔值');
  }
  if (src.resetSkill !== undefined && typeof src.resetSkill !== 'boolean') {
    errors.push('resetSkill 必须是布尔值');
  }

  // 合并语义：未提供的字段沿用 base，避免部分 PATCH 把另一字段清空。
  let soul = typeof baseMind.soul === 'string' && baseMind.soul ? baseMind.soul : DEFAULT_SOUL;
  let skill = typeof baseMind.skill === 'string' && baseMind.skill ? baseMind.skill : DEFAULT_SKILL;

  if (hasSoul) {
    const next = normalizeText(src.soul, MAX_SOUL_CHARS, '灵魂', errors);
    if (next !== null) soul = next;
  } else if (resetSoul) {
    soul = DEFAULT_SOUL;
  }

  if (hasSkill) {
    const next = normalizeText(src.skill, MAX_SKILL_CHARS, '工作流程', errors);
    if (next !== null) skill = next;
  } else if (resetSkill) {
    skill = DEFAULT_SKILL;
  }

  if (errors.length) return { ok: false, errors };
  if (!hasSoul && !resetSoul && !hasSkill && !resetSkill) {
    // 幂等：没有可识别字段时返回原值。
    return { ok: true, value: { soul, skill } };
  }
  return { ok: true, value: { soul, skill } };
}

/** 容错恢复持久化心智：非法/缺失回退默认，超长截断。 */
function restoreMind(raw) {
  const mind = defaultMind();
  if (!util.isPlainObject(raw)) return mind;
  if (typeof raw.soul === 'string') {
    const soul = raw.soul.replace(/\r\n/g, '\n').trim();
    if (soul) mind.soul = soul.slice(0, MAX_SOUL_CHARS);
  }
  if (typeof raw.skill === 'string') {
    const skill = raw.skill.replace(/\r\n/g, '\n').trim();
    if (skill) mind.skill = skill.slice(0, MAX_SKILL_CHARS);
  }
  mind.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null;
  return mind;
}

/** 对外 JSON（含默认值、上限与是否仍为默认）。 */
function mindToJson(mind) {
  const src = util.isPlainObject(mind) ? mind : defaultMind();
  const soul = typeof src.soul === 'string' && src.soul ? src.soul : DEFAULT_SOUL;
  const skill = typeof src.skill === 'string' && src.skill ? src.skill : DEFAULT_SKILL;
  return {
    soul,
    skill,
    updatedAt: typeof src.updatedAt === 'string' ? src.updatedAt : null,
    soulIsDefault: soul === DEFAULT_SOUL,
    skillIsDefault: skill === DEFAULT_SKILL,
    soulChars: soul.length,
    skillChars: skill.length,
    defaults: { soul: DEFAULT_SOUL, skill: DEFAULT_SKILL },
    limits: { soul: MAX_SOUL_CHARS, skill: MAX_SKILL_CHARS },
  };
}

module.exports = {
  DEFAULT_SOUL,
  DEFAULT_SKILL,
  MAX_SOUL_CHARS,
  MAX_SKILL_CHARS,
  MAX_MIND_TEXT: MAX_SKILL_CHARS,
  defaultMind,
  normalizeMindPatch,
  restoreMind,
  mindToJson,
};
