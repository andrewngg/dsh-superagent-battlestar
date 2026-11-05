'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { discover, loadConfig, detectPlatform } = require('../lib/discovery');

// ---------------------------------------------------------------------------
// 测试辅助：临时 DSH_HOME + mock HTTP（Ollama / OpenAI 兼容网关）
// ---------------------------------------------------------------------------

async function makeTempDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeFile(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content, 'utf8');
}

async function createFakeDshHome(options = {}) {
  const dshHome = await makeTempDir('butler-dsh-');

  const desktopDir = path.join(dshHome, 'profiles', 'desktop');
  await writeFile(
    path.join(desktopDir, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-profile-desktop',
        dependencies: { '@ebony-vinyl/dsh-our-free-model': '2.8.0' },
        dsh: {
          profile: {
            bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
          },
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(desktopDir, 'cordis.patch.yml'),
    [
      '- id: agent-default-model',
      '  name: "@deepseek-ai/dsh-agent-default-model"',
      '  config:',
      '    provider: deepseek-account',
      '    model: deepseek-flash',
      '- id: ui-theme',
      '  name: "@deepseek-ai/dsh-client-ui-theme"',
      '  config:',
      '    preference: dark',
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(desktopDir, 'cordis.yml'),
    '# profile root\n[]\n',
  );

  await writeFile(
    path.join(dshHome, 'profiles', 'web', 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-profile-web',
        dependencies: {},
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
      },
      null,
      2,
    ),
  );
  // node_modules 应被跳过
  await writeFile(
    path.join(dshHome, 'profiles', 'node_modules', 'ignored', 'package.json'),
    JSON.stringify({ name: 'ignored' }),
  );

  if (options.withGateway) {
    await writeFile(path.join(dshHome, 'openai-gateway', 'api-key'), 'test-key-do-not-read');
  }

  await writeFile(
    path.join(dshHome, 'skills', 'office-docx', 'SKILL.md'),
    ['---', 'name: Word 文档', 'description: 生成与编辑 Word 文档', '---', '', '# Word 文档', ''].join('\n'),
  );
  await writeFile(
    path.join(dshHome, 'skills', 'office-docx', 'package.json'),
    JSON.stringify({ name: 'office-docx', version: '1.2.0' }),
  );

  await writeFile(
    path.join(dshHome, 'settings.yaml.imported'),
    ['llm-deepseek:', '  baseURL: https://api.deepseek.com', 'locale:', '  preference: zh', ''].join('\n'),
  );

  return dshHome;
}

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = req.url || '/';
      let body = null;
      if (url === '/api/tags') {
        body = {
          models: [
            { name: 'qwen2.5vl:7b', model: 'qwen2.5vl:7b', details: { family: 'qwen2vl', families: ['qwen2vl', 'clip'] } },
            { name: 'qwen2.5:7b', model: 'qwen2.5:7b', details: { family: 'qwen2' } },
          ],
        };
      } else if (url.endsWith('/models')) {
        body = { data: [{ id: 'gpt-4o-mini' }, { id: 'local-fast' }] };
      }
      if (body) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      } else {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'not_found', message: 'mock 未实现' } }));
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      resolve({ url, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

test('DSH + Ollama 探测：profiles/插件/模型/技能/gateway/资源', async () => {
  const dshHome = await createFakeDshHome({ withGateway: true });
  const homeDir = await makeTempDir('butler-home-');
  const server = await startMockServer();
  try {
    const result = await discover({
      dshHome,
      homeDir,
      env: { OLLAMA_HOST: server.url, DSH_OPENAI_GATEWAY_URL: `${server.url}/v1` },
      ollamaTimeoutMs: 1000,
      config: {
        name: '书房工作站',
        tags: ['书房', '夜间可跑'],
        limits: { maxConcurrentTasks: 2 },
      },
    });
    const { manifest, warnings, probing } = result;

    assert.equal(manifest.name, '书房工作站');
    assert.equal(manifest.kind, 'dsh');
    assert.equal(manifest.platform, detectPlatform());
    assert.equal(probing.dshFound, true);
    assert.equal(probing.ollama.available, true);

    assert.deepEqual(manifest.profiles.map((p) => p.id).sort(), ['desktop', 'web']);
    const desktop = manifest.profiles.find((p) => p.id === 'desktop');
    assert.ok(desktop.plugins.includes('@deepseek-ai/dsh-web-app'));
    assert.ok(desktop.plugins.includes('@deepseek-ai/dsh-agent-default-model'));
    assert.ok(desktop.plugins.includes('@ebony-vinyl/dsh-our-free-model'));

    const modelIds = manifest.models.map((m) => m.id).sort();
    assert.ok(modelIds.includes('deepseek-flash'));
    assert.ok(modelIds.includes('qwen2.5vl:7b'));
    assert.ok(modelIds.includes('qwen2.5:7b'));
    const flash = manifest.models.find((m) => m.id === 'deepseek-flash');
    assert.equal(flash.provider, 'deepseek-account');
    assert.ok(flash.strengths.includes('chat'));
    const qwen = manifest.models.find((m) => m.id === 'qwen2.5vl:7b');
    assert.equal(qwen.provider, 'ollama');
    assert.ok(qwen.strengths.includes('vision'));

    assert.deepEqual(manifest.skills.map((s) => s.id), ['office-docx']);
    assert.equal(manifest.skills[0].name, 'Word 文档');

    assert.equal(manifest.gateways.length, 1);
    assert.equal(manifest.gateways[0].id, 'openai-gateway');
    assert.equal(manifest.gateways[0].baseUrl, `${server.url}/v1`);
    assert.deepEqual(manifest.gateways[0].models.sort(), ['gpt-4o-mini', 'local-fast']);

    assert.equal(manifest.limits.maxConcurrentTasks, 2);
    assert.deepEqual(manifest.tags, ['书房', '夜间可跑']);
    assert.ok(manifest.resources.cpuCores > 0);
    assert.ok(manifest.resources.os);
    assert.equal(manifest.agentVersion, require('../../package.json').version);
    // 探测不应产生致命告警
    assert.equal(warnings.filter((w) => w.includes('无法') || w.includes('失败')).length, 0);
  } finally {
    await server.close();
    await fsp.rm(dshHome, { recursive: true, force: true });
    await fsp.rm(homeDir, { recursive: true, force: true });
  }
});

test('config 合并：标量优先、数组按 id 去重、tags 并集', async () => {
  const dshHome = await createFakeDshHome({ withGateway: false });
  const homeDir = await makeTempDir('butler-home-');
  try {
    const result = await discover({
      dshHome,
      homeDir,
      env: { OLLAMA_HOST: 'http://127.0.0.1:1' },
      ollamaTimeoutMs: 150,
      config: {
        name: '定制设备',
        tags: ['书房'],
        models: [
          { id: 'deepseek-flash', provider: 'deepseek', available: false },
          { id: 'custom-model', provider: 'custom', strengths: ['code'], contextWindow: 32000 },
        ],
        profiles: [{ id: 'desktop', name: '我的桌面', plugins: ['my/plugin'] }],
        limits: { maxConcurrentTasks: 3 },
        discovery: { gateway: false },
      },
    });
    const { manifest } = result;

    assert.equal(manifest.name, '定制设备');
    assert.deepEqual(manifest.tags, ['书房']);

    const flash = manifest.models.find((m) => m.id === 'deepseek-flash');
    assert.equal(flash.provider, 'deepseek'); // config 覆盖探测值 deepseek-account
    assert.equal(flash.available, false);
    const custom = manifest.models.find((m) => m.id === 'custom-model');
    assert.ok(custom);
    assert.equal(custom.contextWindow, 32000);

    const desktop = manifest.profiles.find((p) => p.id === 'desktop');
    assert.equal(desktop.name, '我的桌面');
    assert.deepEqual(desktop.plugins, ['my/plugin']);
    assert.equal(manifest.profiles.length, 2); // web 保留
    assert.equal(manifest.limits.maxConcurrentTasks, 3);
  } finally {
    await fsp.rm(dshHome, { recursive: true, force: true });
    await fsp.rm(homeDir, { recursive: true, force: true });
  }
});

test('config replaceArrays 整组替换探测结果', async () => {
  const dshHome = await createFakeDshHome();
  const homeDir = await makeTempDir('butler-home-');
  try {
    const result = await discover({
      dshHome,
      homeDir,
      env: { OLLAMA_HOST: 'http://127.0.0.1:1' },
      ollamaTimeoutMs: 150,
      config: {
        replaceArrays: ['models'],
        models: [{ id: 'only-model', provider: 'test' }],
        discovery: { gateway: false, ollama: false },
      },
    });
    assert.deepEqual(result.manifest.models.map((m) => m.id), ['only-model']);
    // 未列入 replaceArrays 的数组仍按 id 合并（profiles 保留探测结果）
    assert.ok(result.manifest.profiles.length >= 1);
  } finally {
    await fsp.rm(dshHome, { recursive: true, force: true });
    await fsp.rm(homeDir, { recursive: true, force: true });
  }
});

test('无 DSH、Ollama 不可达：只记 warnings 不崩，name 有兜底', async () => {
  const homeDir = await makeTempDir('butler-home-');
  try {
    const result = await discover({
      homeDir,
      dshHome: path.join(homeDir, '.dsh-not-exist'),
      env: { OLLAMA_HOST: 'http://127.0.0.1:1' },
      ollamaTimeoutMs: 150,
      config: { discovery: { gateway: false } },
    });
    assert.equal(result.manifest.kind, 'custom');
    assert.match(result.manifest.name, /^设备-/);
    assert.ok(result.warnings.some((w) => w.includes('未发现 DSH 目录')));
    assert.ok(result.warnings.some((w) => w.includes('Ollama')));
    assert.equal(result.manifest.models.length, 0);
  } finally {
    await fsp.rm(homeDir, { recursive: true, force: true });
  }
});

test('关闭探测开关时不做网络请求', async () => {
  const homeDir = await makeTempDir('butler-home-');
  try {
    const result = await discover({
      homeDir,
      dshHome: path.join(homeDir, '.dsh'),
      env: { OLLAMA_HOST: 'http://127.0.0.1:1' },
      config: { discovery: { dsh: false, ollama: false } },
    });
    assert.equal(result.manifest.kind, 'custom');
    assert.equal(result.probing.dshFound, false);
    assert.equal(result.probing.ollama.available, false);
  } finally {
    await fsp.rm(homeDir, { recursive: true, force: true });
  }
});

test('DSH profile package.json 损坏：记录 warning 继续', async () => {
  const dshHome = await makeTempDir('butler-dsh-broken-');
  const homeDir = await makeTempDir('butler-home-');
  try {
    await writeFile(path.join(dshHome, 'profiles', 'broken', 'package.json'), '{ not json');
    const result = await discover({
      dshHome,
      homeDir,
      env: {},
      config: { discovery: { ollama: false, gateway: false } },
    });
    assert.ok(result.warnings.some((w) => w.includes('解析失败')));
    assert.ok(result.manifest.profiles.some((p) => p.id === 'broken'));
  } finally {
    await fsp.rm(dshHome, { recursive: true, force: true });
    await fsp.rm(homeDir, { recursive: true, force: true });
  }
});

test('loadConfig 读取合法 JSON，非法/缺失文件抛出可读错误', async () => {
  const dir = await makeTempDir('butler-config-');
  try {
    const valid = path.join(dir, 'config.json');
    await fsp.writeFile(valid, JSON.stringify({ name: '测试', limits: { maxConcurrentTasks: 2 } }), 'utf8');
    const loaded = await loadConfig(valid);
    assert.equal(loaded.name, '测试');
    assert.equal(loaded.limits.maxConcurrentTasks, 2);

    const invalid = path.join(dir, 'invalid.json');
    await fsp.writeFile(invalid, '{ nope', 'utf8');
    await assert.rejects(() => loadConfig(invalid), /不是合法 JSON/);

    await assert.rejects(() => loadConfig(path.join(dir, 'missing.json')), /配置文件不存在/);

    const arrayRoot = path.join(dir, 'array.json');
    await fsp.writeFile(arrayRoot, '[]', 'utf8');
    await assert.rejects(() => loadConfig(arrayRoot), /根节点必须是 JSON 对象/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('平台推断：android 环境变量优先', () => {
  assert.equal(detectPlatform({ ANDROID_ROOT: '/system' }), 'android');
  assert.equal(detectPlatform({ TERMUX_VERSION: '0.118' }), 'android');
  const inferred = detectPlatform({});
  assert.ok(['windows', 'macos', 'linux', 'other'].includes(inferred));
  assert.equal(inferred, detectPlatform({}));
});
