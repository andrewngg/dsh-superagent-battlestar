'use strict';

/**
 * 计划子任务的设备端上下文注入：
 * 把主任务目标 / 计划步骤 / 兄弟子任务拼进交给执行器的 instruction，
 * 避免设备级 promptPrefix 把“日志检索/代码分析”误当成图像生成任务。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Agent } = require('../agent');
const { createSilentLogger } = require('../lib/logger');

function createHarness(t) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-agent-context-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const agent = new Agent({
    hub: 'http://127.0.0.1:1',
    name: 'context-test',
    stateDir,
    discoverHub: false,
    env: {},
    logger: createSilentLogger(),
  });
  const captured = [];
  agent.client = {
    deviceId: 'dev_test02',
    ack: async () => ({ status: 200, json: { ok: true } }),
    progress: async () => ({ status: 200, json: { ok: true } }),
    result: async () => ({ status: 200, json: { ok: true, ignored: false } }),
  };
  agent.executor = {
    run: async ({ task }) => {
      captured.push({ ...task });
      return { output: { text: 'ok' } };
    },
  };
  agent._pump = () => {};
  agent.device = { id: 'dev_test02' };
  return { agent, captured };
}

function planCommand() {
  return {
    id: 'cmd_ctx1',
    type: 'run_task',
    taskId: 'task_child_2',
    createdAt: new Date().toISOString(),
    payload: {
      instruction: '分析 GUI 项目的源代码结构和依赖项，为打包做准备',
      threadId: 'thread_p',
      threadStep: 1,
      replyToTaskId: null,
      parentTaskId: 'task_parent_p',
      context: {
        taskId: 'task_child_2',
        threadId: 'thread_p',
        parentTaskId: 'task_parent_p',
        parentInstruction: '把 C:\\work\\gui 项目做成任意目录可运行的 exe，并检查 run 日志',
        planStep: 2,
        planTotal: 3,
        planTitle: 'GUI 打包计划',
        planSiblings: [
          { id: 'task_child_1', step: 1, status: 'completed', instruction: '检查 run 日志' },
          { id: 'task_child_2', step: 2, status: 'assigned', instruction: '分析 GUI 项目代码结构' },
          { id: 'task_child_3', step: 3, status: 'queued', instruction: '用 PyInstaller 打包 exe' },
        ],
      },
    },
  };
}

test('计划子任务：instruction 注入主任务背景与计划进度', async (t) => {
  const { agent, captured } = createHarness(t);
  await agent._runCommand(planCommand());

  assert.equal(captured.length, 1);
  const instruction = captured[0].instruction;
  assert.match(instruction, /【BattleStar 主任务背景】/);
  assert.match(instruction, /主任务 id：task_parent_p/);
  assert.match(instruction, /主任务目标：\n把 C:\\work\\gui 项目做成任意目录可运行的 exe/);
  assert.match(instruction, /第 2\/3 个子任务/);
  assert.match(instruction, /主任务的其他子任务：/);
  assert.match(instruction, /1\. 检查 run 日志 \[completed\]/);
  assert.match(instruction, /2\. 分析 GUI 项目代码结构（当前任务） \[assigned\]/);
  assert.match(instruction, /不要调用 ComfyUI/);
  assert.match(instruction, /【当前任务】\n分析 GUI 项目的源代码结构和依赖项/);
  assert.equal(captured[0].parentTaskId, 'task_parent_p');
});

test('普通任务：不加主任务背景，instruction 保持原样', async (t) => {
  const { agent, captured } = createHarness(t);
  await agent._runCommand({
    id: 'cmd_plain',
    type: 'run_task',
    taskId: 'task_plain',
    createdAt: new Date().toISOString(),
    payload: { instruction: '普通任务', threadId: 'thread_plain' },
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0].instruction, '普通任务');
  assert.equal(captured[0].parentTaskId, null);
});
