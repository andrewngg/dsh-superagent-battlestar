'use strict';

/**
 * 指令里的「设备点名」识别。
 *
 * 用户经常在任务指令里直接写「用 mika 工作机」「交给手机跑」，
 * 但任务请求里可能同时带着下拉选择器或上一线程继承来的 deviceId，
 * 于是硬 pin 覆盖了指令本意。这个模块只负责一件事：
 * 从自然语言里找出用户在点名哪一台设备，交给 Hub 优先采用。
 *
 * 设计取舍：
 * - 只认「能唯一映射到一台设备」的别名（同名多台直接不认，宁可回退选择器也不误派）；
 * - 必须有路由语境（前面是「用/交给/让…」或后面是「工作机/电脑/上…」），
 *   否则一句「mika 的简历没问题」也会被误判成派给 Mika；
 * - 否定语境（不要用/别用/不用…）跳过，允许「不要用 Mika，改用母机」这种句子；
 * - 别名去空白后做 canonical 比较，兼容「用 Mika 工作机」与「用Mika工作机」。
 */

// 设备名/昵称里的分隔符：取片段当别名（如「手机工作机 · OPPO PDCM00」）。
const SPLIT_RE = /[·•|｜/\\()（）[\]【】,，、;；:：\s]+/;
// 地名前的路由动词。末尾允许空白，因为 canonical 文本已去空白；保留空白兼容直接传入原文的测试。
const ROUTING_BEFORE_RE =
  /(?:用|使用|改用|换成|换到|交给|派给|指派给|让|由|在|到|发到|投到|放到|转到|拿|@)\s*$/;
// 地名后的设备/动作后缀。
const ROUTING_AFTER_RE =
  /^(?:工作机|工作电脑|电脑|主机|机器|设备|机上|上|端|那边|来|去|跑|执行|处理|做|负责)/;
// 地名前的否定语境（最多跨 6 个字符，避免把「不要用这个，改用 Mika」误伤成否定 Mika）。
const NEGATION_RE = /(?:不要|不用|别|勿|禁止|切忌|无需|不需要)[^，。；;!?！？\n]{0,6}$/;
const LATIN_OR_DIGIT_RE = /[a-z0-9]/;

function canonical(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, '')
    .toLowerCase();
}

function displayName(device) {
  if (!device) return '';
  return device.nickname || device.name || device.id || '';
}

function pushAlias(map, raw, weight, device) {
  const text = String(raw == null ? '' : raw)
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return;
  const key = canonical(text);
  // 单字/两字拉丁缩写太容易误命中（如 id 片段），只保留至少 2 个字符且不像缩写短词。
  if (key.length < 2) return;
  if (/^[0-9a-z]{1,2}$/.test(key)) return;
  const record = map.get(key) || { text, weight: 0, devices: new Map() };
  if (!record.devices.has(device.id)) record.devices.set(device.id, device);
  record.weight = Math.max(record.weight, weight);
  map.set(key, record);
}

/**
 * 收集全部设备别名。权重：id 5 > 昵称 4 > 名称/名称片段 3 > 标签 2。
 * @param {Iterable<object>} devices
 * @returns {Map<string, {text: string, weight: number, devices: Map<string, object>}>}
 */
function collectAliases(devices) {
  const map = new Map();
  const list = devices ? [...devices] : [];
  for (const device of list) {
    if (!device || !device.id || device.disabled) continue;
    pushAlias(map, device.id, 5, device);
    if (device.nickname) pushAlias(map, device.nickname, 4, device);
    if (device.name) {
      pushAlias(map, device.name, 3, device);
      for (const part of String(device.name).split(SPLIT_RE)) {
        if (part && canonical(part).length >= 2) pushAlias(map, part, 3, device);
      }
    }
    for (const tag of Array.isArray(device.tags) ? device.tags : []) {
      if (typeof tag === 'string' && canonical(tag).length >= 2) pushAlias(map, tag, 2, device);
    }
  }
  // 只注册了一台 Android 设备时，「手机」「安卓」就是无歧义别名。
  const androids = list.filter(
    (device) => device && device.id && !device.disabled && String(device.platform || '').toLowerCase() === 'android',
  );
  if (androids.length === 1) {
    const device = androids[0];
    const existing = map.get(canonical('手机'));
    if (!existing || !existing.devices.has(device.id)) pushAlias(map, '手机', 2, device);
    const existingAndroid = map.get(canonical('安卓'));
    if (!existingAndroid || !existingAndroid.devices.has(device.id)) pushAlias(map, '安卓', 1, device);
  }
  return map;
}

/** 拉丁别名避免命中更长英文单词内部（mikafoo 不算 mika）。 */
function hasCleanBoundary(text, index, length) {
  const first = text[index];
  const last = text[index + length - 1];
  const prev = index > 0 ? text[index - 1] : '';
  const next = index + length < text.length ? text[index + length] : '';
  if (prev && LATIN_OR_DIGIT_RE.test(prev) && LATIN_OR_DIGIT_RE.test(first)) return false;
  if (next && LATIN_OR_DIGIT_RE.test(next) && LATIN_OR_DIGIT_RE.test(last)) return false;
  return true;
}

/**
 * 从指令中解析设备点名。
 * @param {string} instruction
 * @param {Iterable<object>|null} devices Hub 内部设备（含 id/name/nickname/tags/platform/disabled）
 * @returns {{deviceId: string, deviceName: string, alias: string, matchedText: string, score: number}|null}
 */
function resolveDeviceMention(instruction, devices) {
  const text = canonical(instruction);
  if (!text) return null;
  const aliasMap = collectAliases(devices);
  const matches = [];
  for (const record of aliasMap.values()) {
    // 别名同时指向多台设备时不认，避免「工作机」这类通用词误派。
    if (record.devices.size !== 1) continue;
    const alias = canonical(record.text);
    if (!alias) continue;
    let from = 0;
    while (true) {
      const index = text.indexOf(alias, from);
      if (index < 0) break;
      from = index + alias.length;
      if (!hasCleanBoundary(text, index, alias.length)) continue;
      const before = text.slice(Math.max(0, index - 28), index);
      const after = text.slice(index + alias.length, index + alias.length + 24);
      if (NEGATION_RE.test(before)) continue;
      const beforeHit = ROUTING_BEFORE_RE.test(before);
      const afterHit = ROUTING_AFTER_RE.test(after);
      // 整句只有设备名时也认（用户可能在跟进里只写「Mika」）。
      if (!beforeHit && !afterHit && text !== alias) continue;
      const device = [...record.devices.values()][0];
      matches.push({
        deviceId: device.id,
        deviceName: displayName(device),
        alias: record.text,
        matchedText: record.text,
        score: record.weight * 10 + alias.length + (beforeHit ? 6 : 0) + (afterHit ? 3 : 0),
        index,
        aliasLength: alias.length,
      });
    }
  }
  if (!matches.length) return null;
  matches.sort(
    (a, b) => b.score - a.score || b.aliasLength - a.aliasLength || a.index - b.index,
  );
  const best = matches[0];
  const runnerUp = matches.find((match) => match.deviceId !== best.deviceId);
  // 不同设备得分相同 → 歧义，交给原来的选择器/继承逻辑处理。
  if (runnerUp && runnerUp.score === best.score) return null;
  return {
    deviceId: best.deviceId,
    deviceName: best.deviceName,
    alias: best.alias,
    matchedText: best.matchedText,
    score: best.score,
  };
}

module.exports = { resolveDeviceMention, collectAliases };
