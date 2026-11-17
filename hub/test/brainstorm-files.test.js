'use strict';

/**
 * 头脑风暴附件：本机文件读取、路径自动识别、上传文本、提示词注入与 HTTP 端到端。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createHub } = require('../lib/hub.js');
const { request, adminHeaders, startTestHub } = require('./_helpers.js');
const {
  extractFilePaths,
  isProbablyText,
  isSensitivePath,
  readAttachments,
  readTextFile,
} = require('../lib/file-reader.js');
const {
  MAX_ATTACHMENTS,
  buildBrainstormPrompt,
  normalizeChatRequest,
} = require('../lib/brainstorm.js');

async function newHub(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-brainstorm-files-'));
  const hub = await createHub({
    dataDir,
    silent: true,
    persistDebounceMs: 5,
    nightlyReview: false,
    brainTickMs: 3600000,
    goalTickMs: 3600000,
    ...overrides,
  });
  t.after(async () => {
    await hub.close().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { hub, dataDir };
}

function makeFiles(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-brainstorm-attach-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const textFile = path.join(dir, '方案.md');
  fs.writeFileSync(textFile, '# 自由职业方案\n\n服务线 A：Python 自动化与数据管道。\n', 'utf8');
  const binaryFile = path.join(dir, '截图.png');
  fs.writeFileSync(binaryFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  const sensitiveFile = path.join(dir, '.env');
  fs.writeFileSync(sensitiveFile, 'BRAIN_API_KEY=should-not-be-read\n', 'utf8');
  return { dir, textFile, binaryFile, sensitiveFile };
}

/** 可切换行为的 brainstormThink 桩，记录提示词。 */
function makeThinker(reply = '## 结论\n已阅读附件。') {
  const state = { captured: [], fail: false, reply };
  state.think = async ({ system, user }) => {
    state.captured.push({ system, user });
    if (state.fail) throw new Error('模型超时');
    return state.reply;
  };
  return state;
}

test('file-reader：读取文本、识别二进制、拒绝敏感文件、支持上传文本', (t) => {
  const { dir, textFile, binaryFile, sensitiveFile } = makeFiles(t);

  const read = readTextFile(textFile);
  assert.equal(read.ok, true);
  assert.equal(read.name, '方案.md');
  assert.ok(read.text.includes('服务线 A'));
  assert.equal(read.truncated, false);

  const binary = readTextFile(binaryFile);
  assert.equal(binary.ok, false);
  assert.match(binary.error, /二进制/);

  assert.equal(isSensitivePath(sensitiveFile), true);
  const secret = readTextFile(sensitiveFile);
  assert.equal(secret.ok, false);
  assert.match(secret.error, /密钥|凭据/);

  const missing = readTextFile(path.join(dir, 'nope.txt'));
  assert.equal(missing.ok, false);

  const combined = readAttachments([
    { path: textFile },
    { name: '补充.txt', text: '上传的补充说明' },
  ]);
  assert.equal(combined.errors.length, 0);
  assert.equal(combined.attachments.length, 2);
  assert.ok(combined.attachments[0].path.endsWith('方案.md'));
  assert.equal(combined.attachments[1].path, '');
  assert.equal(combined.attachments[1].text, '上传的补充说明');
});

test('file-reader：从消息正文识别本机路径（引号/裸路径），忽略不存在的文件', (t) => {
  const { textFile, binaryFile } = makeFiles(t);
  const found = extractFilePaths(`请参考 "${textFile}" 和 ${textFile}，另外 ${path.join(path.dirname(textFile), 'nope.md')} 不存在。`);
  assert.equal(found.length, 1);
  assert.equal(path.resolve(found[0]), path.resolve(textFile));
  assert.deepEqual(extractFilePaths(`看下 ${binaryFile}`), [path.resolve(binaryFile)].filter(() => false));
});

test('normalizeChatRequest：接受 attachments（path / 上传文本），限制数量与格式', () => {
  const ok = normalizeChatRequest({
    message: '读一下方案',
    attachments: [{ path: 'C:\\docs\\plan.md' }, { name: 'a.txt', text: 'hi' }],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.attachments.length, 2);

  const tooMany = normalizeChatRequest({
    message: 'x',
    attachments: Array.from({ length: MAX_ATTACHMENTS + 1 }, () => ({ name: 'a.txt', text: 'x' })),
  });
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.errors.join('；'), /最多/);

  const invalid = normalizeChatRequest({ message: 'x', attachments: [{ bogus: true }] });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join('；'), /附件格式/);
});

test('buildBrainstormPrompt：附件内容进入「用户提供的文件」，历史消息带附件名', () => {
  const prompt = buildBrainstormPrompt({
    userMessage: '帮我基于这些文件做取舍',
    context: { now: '2026-11-16T00:00:00.000Z' },
    attachments: [{ name: '方案.md', path: 'C:\\docs\\方案.md', size: 2048, text: '# 方案\n服务线 A' }],
    history: [{ role: 'user', text: '之前的问题', attachments: [{ name: 'old.txt' }] }],
  });
  assert.ok(prompt.user.includes('## 用户提供的文件'));
  assert.ok(prompt.user.includes('### 方案.md'));
  assert.ok(prompt.user.includes('服务线 A'));
  assert.ok(prompt.user.includes('（附件：old.txt）'));
  assert.ok(prompt.user.includes('## 本轮消息\n帮我基于这些文件做取舍'));
  assert.ok(prompt.user.includes('不要声称'));
});

test('hub.chatBrainstorm：显式附件 + 消息里的本机路径都会被读取并注入提示词', async (t) => {
  const thinker = makeThinker();
  const { hub } = await newHub(t, { brainstormThink: thinker.think });
  const { textFile } = makeFiles(t);

  const first = await hub.chatBrainstorm({
    message: `读一下这个文件：${textFile}`,
    attachments: [{ name: '补充说明.txt', text: '服务线 A 优先，客单价高。' }],
  });
  assert.equal(first.error, null);
  assert.equal(first.attachments.length, 2);
  assert.equal(first.attachmentErrors.length, 0);

  const prompt = thinker.captured[0].user;
  assert.ok(prompt.includes('## 用户提供的文件'));
  assert.ok(prompt.includes('服务线 A：Python 自动化与数据管道'));
  assert.ok(prompt.includes('服务线 A 优先'));

  const userMessage = first.session.messages[0];
  assert.equal(userMessage.role, 'user');
  assert.equal(userMessage.attachments.length, 2);
  // 只持久化元数据，不落盘正文。
  assert.ok(userMessage.attachments.every((item) => typeof item.text === 'undefined'));
  assert.ok(userMessage.attachments.some((item) => item.path && item.path.endsWith('方案.md')));
});

test('hub.chatBrainstorm：读取失败/敏感文件写进提示词提示，不阻断对话', async (t) => {
  const thinker = makeThinker();
  const { hub } = await newHub(t, { brainstormThink: thinker.think });
  const { sensitiveFile } = makeFiles(t);

  const result = await hub.chatBrainstorm({
    message: '看看这个配置',
    attachments: [{ path: sensitiveFile }, { path: path.join(os.tmpdir(), 'does-not-exist-xyz.txt') }],
  });
  assert.equal(result.error, null);
  assert.equal(result.attachments.length, 0);
  assert.equal(result.attachmentErrors.length, 2);
  assert.match(thinker.captured[0].user, /## 附件读取失败/);
  assert.match(thinker.captured[0].user, /密钥|凭据/);
  assert.match(thinker.captured[0].user, /does-not-exist-xyz\.txt/);
});

test('HTTP 头脑风暴附件：POST /api/brainstorm/chat 返回附件元数据与回复', async (t) => {
  const thinker = makeThinker('## 结论\n读到了。');
  const env = await startTestHub(t, { brainstormThink: thinker.think });
  const { textFile } = makeFiles(t);

  const res = await request(env.base, 'POST', '/api/brainstorm/chat', {
    headers: adminHeaders(env),
    body: {
      message: '基于附件给出建议',
      attachments: [
        { name: '上传.txt', text: '上传的文件内容 ABC' },
        { path: textFile },
      ],
    },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.error, null);
  assert.equal(res.json.attachments.length, 2);
  assert.equal(res.json.attachmentErrors.length, 0);
  assert.ok(thinker.captured[0].user.includes('上传的文件内容 ABC'));
  assert.ok(thinker.captured[0].user.includes('服务线 A'));

  const bad = await request(env.base, 'POST', '/api/brainstorm/chat', {
    headers: adminHeaders(env),
    body: { message: 'x', attachments: [{ bad: 1 }] },
  });
  assert.equal(bad.status, 400, bad.text);
});
