'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  slugifyName,
  stateFileName,
  resolveStateDir,
  resolveStateFile,
  loadState,
  saveState,
  clearState,
} = require('../lib/state');

async function makeTempDir(prefix = 'butler-state-') {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('状态文件名清洗与 Hub 隔离', () => {
  assert.equal(slugifyName('书房工作站'), '书房工作站');
  assert.equal(slugifyName('书房 工作站/测试'), '书房-工作站-测试');
  assert.equal(slugifyName('   '), 'device');
  assert.equal(stateFileName('书房工作站', 'http://127.0.0.1:7317'), '书房工作站@127.0.0.1.json');
  assert.equal(stateFileName('书房工作站', 'not-a-url'), '书房工作站.json');
});

test('状态目录默认 ~/.super-butler，可用 stateDir 覆盖', () => {
  const homeDir = path.join(path.sep, 'tmp', 'fake-home');
  assert.equal(resolveStateDir({ homeDir, env: {} }), path.join(homeDir, '.super-butler'));
  assert.equal(resolveStateDir({ homeDir, env: {}, stateDir: 'C:\\butler-state' }), path.resolve('C:\\butler-state'));
  assert.equal(resolveStateDir({ homeDir, env: { BUTLER_STATE_DIR: './custom-state' } }), path.resolve('./custom-state'));
});

test('状态文件保存 → 读取 → 清除（原子写）', async () => {
  const dir = await makeTempDir();
  try {
    const file = resolveStateFile({ stateDir: dir, name: '测试设备', hubUrl: 'http://127.0.0.1:7317' });
    const missing = await loadState(file);
    assert.equal(missing.state, null);
    assert.equal(missing.error, null);

    await saveState(file, {
      hub: 'http://127.0.0.1:7317',
      deviceId: 'dev_abc123',
      deviceToken: 'tok_abc123',
      name: '测试设备',
    });
    const loaded = await loadState(file);
    assert.equal(loaded.error, null);
    assert.equal(loaded.state.deviceId, 'dev_abc123');
    assert.equal(loaded.state.deviceToken, 'tok_abc123');
    assert.equal(loaded.state.version, 1);
    assert.ok(loaded.state.updatedAt);

    // 再保存一次（覆盖）不应残留临时文件
    await saveState(file, { deviceId: 'dev_new', deviceToken: 'tok_new' });
    const entries = await fsp.readdir(dir);
    assert.deepEqual(
      entries.filter((name) => name.includes('.tmp-')),
      [],
    );
    const reloaded = await loadState(file);
    assert.equal(reloaded.state.deviceId, 'dev_new');

    await clearState(file);
    const afterClear = await loadState(file);
    assert.equal(afterClear.state, null);
    assert.equal(afterClear.error, null);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('损坏的状态文件返回错误而不是抛异常', async () => {
  const dir = await makeTempDir();
  try {
    const file = path.join(dir, 'broken.json');
    await fsp.writeFile(file, '{ 这不是 JSON', 'utf8');
    const loaded = await loadState(file);
    assert.equal(loaded.state, null);
    assert.match(loaded.error, /读取状态文件失败/);

    await fsp.writeFile(file, JSON.stringify({ hub: 'x' }), 'utf8');
    const incomplete = await loadState(file);
    assert.equal(incomplete.state, null);
    assert.match(incomplete.error, /缺少 deviceId\/deviceToken/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
