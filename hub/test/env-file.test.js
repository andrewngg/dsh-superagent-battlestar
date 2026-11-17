'use strict';

/**
 * .env 加载：解析、引号、注释、已有环境变量优先、文件缺失静默。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseEnvText, loadEnvFile, loadEnvFiles } = require('../lib/env-file.js');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('parseEnvText：注释/空行/export/引号/非法键', () => {
  const values = parseEnvText(
    [
      '# 注释',
      '',
      'DEEPSEEK_API_KEY=sk-test-value',
      'export BRAINSTORM_MODEL="deepseek-chat"',
      "BRAINSTORM_BASE_URL='https://api.deepseek.com'",
      'EMPTY=',
      'not a key=value',
      '1INVALID=x',
      'SPACED =  padded  ',
    ].join('\r\n'),
  );
  assert.deepEqual(values, {
    DEEPSEEK_API_KEY: 'sk-test-value',
    BRAINSTORM_MODEL: 'deepseek-chat',
    BRAINSTORM_BASE_URL: 'https://api.deepseek.com',
    EMPTY: '',
    SPACED: 'padded',
  });
});

test('loadEnvFile：不覆盖已有环境变量，缺文件不抛错', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'A=from-file\nB=from-file\n', 'utf8');
  const env = { A: 'from-env' };
  const result = loadEnvFile(file, { env });
  assert.equal(env.A, 'from-env');
  assert.equal(env.B, 'from-file');
  assert.deepEqual(result.applied, ['B']);
  assert.deepEqual(result.skipped, ['A']);

  const missing = loadEnvFile(path.join(dir, 'missing.env'), { env });
  assert.deepEqual(missing.applied, []);
  assert.deepEqual(missing.skipped, []);
});

test('loadEnvFiles：按顺序加载，先到先得', (t) => {
  const dir = tempDir(t);
  const first = path.join(dir, 'a.env');
  const second = path.join(dir, 'b.env');
  fs.writeFileSync(first, 'DEEPSEEK_API_KEY=first\nMODEL=first\n', 'utf8');
  fs.writeFileSync(second, 'DEEPSEEK_API_KEY=second\nOTHER=second\n', 'utf8');
  const env = {};
  const results = loadEnvFiles([first, second], { env });
  assert.equal(env.DEEPSEEK_API_KEY, 'first');
  assert.equal(env.MODEL, 'first');
  assert.equal(env.OTHER, 'second');
  assert.equal(results.length, 2);
  assert.deepEqual(results[1].skipped, ['DEEPSEEK_API_KEY']);
});
