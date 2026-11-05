'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createExecutor } = require('../lib/executors.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'butler-comfy-test-'));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

test('comfyui 执行器：提交工作流、轮询历史、下载图片', async () => {
  const tmp = tempDir();
  const workflowFile = path.join(tmp, 'workflow.json');
  const outputDir = path.join(tmp, 'out');
  fs.writeFileSync(workflowFile, JSON.stringify({
    '3': { class_type: 'CLIPTextEncode', inputs: { text: 'old prompt' } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: 'old negative' } },
    '6': { class_type: 'KSampler', inputs: { seed: 1, steps: 20 } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'butler' } },
  }, null, 2));

  let submittedBody = null;
  let historyCalls = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/prompt') {
      submittedBody = JSON.parse(await readBody(req));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ prompt_id: 'p_test_1', number: 1, node_errors: {} }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/history/p_test_1') {
      historyCalls += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (historyCalls < 2) {
        res.end(JSON.stringify({}));
        return;
      }
      res.end(JSON.stringify({
        p_test_1: {
          status: { completed: true, status_str: 'success' },
          outputs: {
            '9': { images: [{ filename: 'out.png', subfolder: 'sub', type: 'output' }] },
          },
        },
      }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/view') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(Buffer.from('89504E470D0A1A0A', 'hex'));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/interrupt') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const executor = createExecutor({
      config: {
        executor: {
          type: 'comfyui',
          comfyui: {
            baseUrl: `http://127.0.0.1:${port}`,
            workflowFile,
            promptNodeId: '3',
            negativeNodeId: '7',
            negativePrompt: 'low quality',
            seedNodeId: '6',
            outputDir,
            timeoutMs: 30000,
            pollMs: 50,
          },
        },
      },
    });
    assert.ok(executor.availableTypes.includes('comfyui'));
    const result = await executor.run({
      task: { id: 'task_c1', instruction: '一只在窗边晒太阳的橘猫，胶片风格' },
      device: { name: '第二台电脑 · ComfyUI' },
      progress: async () => {},
    });
    assert.equal(result.error, undefined);
    assert.equal(submittedBody.prompt['3'].inputs.text, '一只在窗边晒太阳的橘猫，胶片风格');
    assert.equal(submittedBody.prompt['7'].inputs.text, 'low quality');
    assert.notEqual(submittedBody.prompt['6'].inputs.seed, 1);
    assert.equal(result.output.data.executor, 'comfyui');
    assert.equal(result.output.data.promptId, 'p_test_1');
    assert.equal(result.output.data.imageCount, 1);
    assert.equal(result.output.artifacts.length, 1);
    const artifact = result.output.artifacts[0];
    assert.ok(fs.existsSync(artifact.path), 'downloaded image should exist');
    assert.equal(fs.readFileSync(artifact.path).subarray(0, 4).toString('hex'), '89504e47');
    assert.match(result.output.text, /ComfyUI 生成完成/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('comfyui 执行器：缺少工作流配置时拒绝执行', async () => {
  const executor = createExecutor({
    config: { executor: { type: 'comfyui', comfyui: { baseUrl: 'http://127.0.0.1:8188' } } },
  });
  await assert.rejects(
    () => executor.run({ task: { id: 'task_c2', instruction: '生成一张图' } }),
    /workflowFile/,
  );
});
