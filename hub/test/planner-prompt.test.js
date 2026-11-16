'use strict';

/**
 * 规划器 prompt：要求每个子任务指令自包含，避免“这里/上述/该项目”这类指代
 * 在交给别的设备执行时失去上下文。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPrompt } = require('../lib/planner.js');

test('buildPrompt：要求子任务指令自包含并禁止指代', () => {
  const prompt = buildPrompt('把这里的 GUI 做成 exe，并检查 run 日志', {}, 3, 1800, []);
  assert.match(prompt, /每个子任务指令必须自包含/);
  assert.match(prompt, /绝对路径或明确名称/);
  assert.match(prompt, /禁止使用「这里」「上述」「刚才」「该项目」「之前的对话」/);
  assert.match(prompt, /复述进子任务指令/);
});
