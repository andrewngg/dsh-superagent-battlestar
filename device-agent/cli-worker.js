#!/usr/bin/env node
'use strict';

/**
 * BattleStar 本机 CLI 执行器 worker（零依赖）。
 *
 * 由 device-agent 的 `cli` 执行器启动，负责把一条任务指令交给本机的 CLI Agent：
 *   - hermes   : `hermes --cli -z "<instruction>"`（可执行本机工具命令，默认）
 *   - opencode : `opencode run "<instruction>" -m deepseek/deepseek-flash --format json`
 *   - shell    : `pwsh -NoProfile -NonInteractive -Command "<instruction>"`（需显式允许）
 *
 * stdout 只输出一行 JSON（设备代理解析）；日志/进度写 stderr。
 *
 * 用法：
 *   node cli-worker.js --instruction "列出当前目录" --mode auto
 *   node cli-worker.js --instruction "写一个 hello.js" --mode opencode --workdir "C:\work"
 *   node cli-worker.js --instruction "!node -v" --mode shell --allow-shell
 *
 * 环境变量（由 device-agent 传入，可覆盖）：
 *   BUTLER_CLI_WORKDIR, BUTLER_CLI_HERMES_HOME, BUTLER_CLI_HERMES_EXE,
 *   BUTLER_CLI_OPENCODE_EXE, BUTLER_CLI_OPENCODE_MODEL, BUTLER_CLI_TIMEOUT_MS
 */

const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { ensureProject } = require('./lib/hermes-projects');

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const CODE_RE = /(写代码|代码|脚本|实现|重构|修复|函数|类|接口|测试|编译|部署|html|css|javascript|typescript|python|node|api|\bbug\b|\bcode\b|\bfix\b|\bscript\b|\bbuild\b|\brefactor\b|\btest\b)/i;
const SHELL_PREFIX_RE = /^\s*(?:!|\/run\s+|\$ )/i;

const DEFAULTS = {
  mode: 'auto',
  timeoutMs: 15 * 60 * 1000,
  opencodeModel: 'deepseek/deepseek-flash',
  streamProgress: true,
};

/**
 * 进度行前缀：cli-worker 把执行过程中的工具调用/步骤以该前缀写到 stderr，
 * device-agent 的 cli 执行器逐行读取并转成 Hub 进度（见 device-agent/lib/executors.js）。
 */
const PROGRESS_PREFIX = '@@BUTLER_PROGRESS@@ ';
const PROGRESS_MIN_PERCENT = 8;
const PROGRESS_TOOL_STEP = 3;
const PROGRESS_TOOL_MAX = 85;
const STREAM_STDERR_TAIL = 20000;

function stripAnsi(text) {
  return String(text == null ? '' : text).replace(ANSI_RE, '');
}

function truncate(text, max) {
  const s = String(text == null ? '' : text);
  return s.length > max ? `${s.slice(0, max)}\n…（已截断，共 ${s.length} 字符）` : s;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function defaultHermesHome() {
  if (nonEmptyString(process.env.HERMES_HOME)) return process.env.HERMES_HOME.trim();
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'hermes');
}

function resolveExecutable(explicit, candidates) {
  const list = [];
  const trimmed = nonEmptyString(explicit);
  if (trimmed) list.push(trimmed);
  for (const c of candidates) if (c) list.push(c);
  for (const candidate of list) {
    try {
      if (candidate === 'opencode' || candidate === 'hermes') return candidate;
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return list[list.length - 1] || '';
}

function defaultHermesExe(home) {
  return resolveExecutable(process.env.BUTLER_CLI_HERMES_EXE, [
    path.join(home, 'bin', 'hermes.exe'),
    path.join(home, 'bin', 'hermes.cmd'),
    'hermes',
  ]);
}

function defaultOpencodeExe() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return resolveExecutable(process.env.BUTLER_CLI_OPENCODE_EXE, [
    path.join(appData, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
    path.join(appData, 'npm', 'node_modules', 'opencode-ai', 'node_modules', 'opencode-windows-x64', 'bin', 'opencode.exe'),
    'opencode',
  ]);
}

/**
 * 检查 Hermes home 是否可写；返回空字符串表示没问题，否则返回错误码。
 * 运行在受限沙箱（如 DSH workspace-write）或被 ACL 限制时，Hermes 会瞬间退出码 1 且无任何输出。
 */
function hermesHomeProblem(home) {
  const target = nonEmptyString(home);
  if (!target) return '';
  try {
    fs.accessSync(target, fs.constants.W_OK);
    return '';
  } catch (err) {
    const code = err && err.code ? err.code : String(err && err.message);
    if (code === 'ENOENT') return ''; // 允许 Hermes 自行创建
    return code;
  }
}

/** Hermes 非零退出码 → 可读错误（无输出时附带最可能的根因，避免只剩“退出码 1”）。 */
function describeHermesExit(code, text, home) {
  const output = String(text == null ? '' : text).trim();
  if (output) return `Hermes CLI 退出码 ${code}：${truncate(output, 300)}`;
  const problem = hermesHomeProblem(home);
  const hint = problem
    ? `Hermes 无法访问 HERMES_HOME（${home}，${problem}）。设备代理可能运行在受限沙箱/权限不足的环境中，请在普通用户会话中启动设备代理`
    : `Hermes 没有产生任何输出；请确认 HERMES_HOME（${home || '未配置'}）可写、Hermes 网关正常运行`;
  return `Hermes CLI 退出码 ${code}（无输出）：${hint}`;
}

function defaultShellExe() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return resolveExecutable('', [
    path.join(local, 'Microsoft', 'WindowsApps', 'pwsh.exe'),
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'pwsh',
    'powershell',
  ]);
}

/** Hermes profile 的 home：hermes-<name> → <home>/profiles/<name>。 */
function hermesProfileHome(home, profile) {
  const p = nonEmptyString(profile);
  if (!p) return home;
  if (/^hermes$/i.test(p)) return home;
  const match = /^hermes[-_/](.+)$/i.exec(p);
  if (!match) return home;
  const candidate = path.join(home, 'profiles', match[1]);
  return fs.existsSync(candidate) ? candidate : home;
}

/** 选择本机 CLI 后端。 */
function chooseBackend({ mode = 'auto', profile = '', instruction = '', allowShell = false } = {}) {
  const explicit = nonEmptyString(mode).toLowerCase();
  if (explicit === 'shell' || explicit === 'command') {
    if (!allowShell) throw new Error('shell 模式未启用：请先在执行器配置中设置 allowShell=true');
    return 'shell';
  }
  if (explicit === 'hermes' || explicit === 'opencode') return explicit;

  const p = nonEmptyString(profile).toLowerCase();
  if (p === 'shell' || p === 'cli-shell') {
    if (!allowShell) throw new Error('shell 模式未启用：请先在执行器配置中设置 allowShell=true');
    return 'shell';
  }
  if (p === 'opencode' || p.startsWith('opencode')) return 'opencode';
  if (p === 'hermes' || p.startsWith('hermes')) return 'hermes';
  if (SHELL_PREFIX_RE.test(instruction)) {
    if (!allowShell) throw new Error('指令以 shell 前缀开头，但 shell 模式未启用');
    return 'shell';
  }
  if (CODE_RE.test(instruction)) return 'opencode';
  return 'hermes';
}

function buildHermesArgs({ instruction, model = '', provider = '', skills = '', sessionId = '', workdir = '', yolo = true }) {
  const args = ['--cli'];
  if (yolo) args.push('--yolo');
  if (model) args.push('-m', model);
  if (provider) args.push('--provider', provider);
  if (skills) args.push('--skills', skills);
  if (sessionId) args.push('--resume', sessionId);
  if (workdir) args.push('--in', workdir);
  args.push('-z', String(instruction || ''));
  return args;
}

/**
 * `hermes chat -q … --format stream-json`：stdout 每行一个 JSON 事件（system/text/tool_use/
 * tool_result/result），可以实时看到 Agent 正在调用哪些工具、派发了哪些子任务。
 *
 * 显式 `--source cli`：Hermes 默认把有限次运行记成 source='oneshot'（在 TUI/Desktop
 * 会话列表里被隐藏）；加上该参数后会话会出现在 Hermes agent 的会话记录里，
 * 并按 cwd 归入对应项目（见 lib/hermes-projects.js）。
 */
function buildHermesStreamArgs({ instruction, model = '', provider = '', skills = '', sessionId = '', workdir = '', source = 'cli' }) {
  const args = ['chat', '-q', String(instruction || ''), '--format', 'stream-json'];
  if (source) args.push('--source', source);
  args.push('--yolo');
  if (model) args.push('-m', model);
  if (provider) args.push('--provider', provider);
  if (skills) args.push('--skills', skills);
  if (sessionId) args.push('--resume', sessionId);
  if (workdir) args.push('--in', workdir);
  return args;
}

function shortenLine(text, max) {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, Math.max(1, max - 1))}…` : value;
}

function firstStringField(data, keys) {
  for (const key of keys) {
    const value = data && typeof data === 'object' ? data[key] : null;
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** 把一次工具调用描述成人类可读的执行步骤（子代理/计划工具单独识别）。 */
function describeHermesTool(name, input) {
  const tool = nonEmptyString(name) || 'tool';
  const data = input && typeof input === 'object' ? input : {};
  if (/delegate|subagent/i.test(tool)) {
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    const goals = tasks
      .map((item) => (item && typeof item === 'object'
        ? nonEmptyString(item.goal) || nonEmptyString(item.description) || nonEmptyString(item.prompt)
        : ''))
      .filter(Boolean);
    const goal = goals[0]
      || nonEmptyString(data.goal)
      || nonEmptyString(data.description)
      || nonEmptyString(data.prompt);
    if (goal) return `子任务：${shortenLine(goal, 100)}${goals.length > 1 ? `（共 ${goals.length} 个）` : ''}`;
    return `派发子任务（${tool}）`;
  }
  if (/todo/i.test(tool)) {
    const todos = Array.isArray(data.todos) ? data.todos.filter((item) => item && typeof item === 'object') : [];
    const active = todos.find((item) => String(item.status) === 'in_progress');
    if (active && nonEmptyString(active.content)) return `执行步骤：${shortenLine(active.content, 100)}`;
    const done = todos.filter((item) => String(item.status) === 'completed').length;
    if (todos.length) return `更新执行计划：${done}/${todos.length} 步完成`;
    return '查看执行计划';
  }
  const detail = firstStringField(data, ['command', 'file_path', 'path', 'query', 'pattern', 'url', 'description', 'prompt', 'name', 'code']);
  return detail ? `正在执行：${tool} · ${shortenLine(detail, 90)}` : `正在执行：${tool}`;
}

/** 计划清单里已完成比例 → 进度百分比（让进度条跟 todo 推进）。 */
function planPercentForTodos(todos) {
  const list = Array.isArray(todos) ? todos.filter((item) => item && typeof item === 'object') : [];
  if (!list.length) return null;
  const done = list.filter((item) => String(item.status) === 'completed').length;
  return Math.min(PROGRESS_TOOL_MAX, PROGRESS_MIN_PERCENT + 4 + Math.round(70 * (done / list.length)));
}

/** 把 JSONL 字节流切成完整行（容忍半行/CRLF/超长垃圾行）。 */
function createJsonlSplitter(onLine) {
  let buffer = '';
  const emit = (rawLine) => {
    const line = String(rawLine).replace(/\r$/, '').trim();
    if (line) onLine(line);
  };
  return {
    push(chunk) {
      buffer += String(chunk == null ? '' : chunk);
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        emit(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
      if (buffer.length > 1000000) buffer = '';
    },
    end() {
      if (buffer) emit(buffer);
      buffer = '';
    },
  };
}

function initialHermesStreamState() {
  return {
    text: '',
    sessionId: '',
    sawResult: false,
    exitCode: null,
    tools: 0,
    lastPercent: PROGRESS_MIN_PERCENT,
    result: null,
  };
}

/** Hermes stream-json 事件 → 一条 Hub 进度（没有可展示步骤时返回 null）。 */
function hermesEventProgress(event, state) {
  if (!event || typeof event !== 'object' || !state) return null;
  if (event.type === 'tool_use') {
    state.tools += 1;
    let percent = Math.min(PROGRESS_TOOL_MAX, PROGRESS_MIN_PERCENT + 4 + state.tools * PROGRESS_TOOL_STEP);
    if (/todo/i.test(String(event.name || '')) && event.input && Array.isArray(event.input.todos)) {
      const planPercent = planPercentForTodos(event.input.todos);
      if (planPercent !== null) percent = planPercent;
    }
    return { message: describeHermesTool(event.name, event.input), percent };
  }
  if (event.type === 'tool_result' && event.is_error) {
    const detail = shortenLine(event.output, 80);
    return { message: `工具失败：${nonEmptyString(event.name) || 'tool'}${detail ? `：${detail}` : ''}` };
  }
  return null;
}

/** 进度百分比保持单调，避免计划更新时进度条回退。 */
function normalizeProgressPayload(payload, state) {
  const message = shortenLine(payload && payload.message, 200);
  if (!message) return null;
  let percent = state.lastPercent;
  if (Number.isFinite(payload.percent)) {
    const next = Math.max(1, Math.min(99, Math.round(payload.percent)));
    percent = next > state.lastPercent ? next : state.lastPercent;
    state.lastPercent = percent;
  }
  return { message, percent };
}

/**
 * 增量解析 Hermes 的 JSONL 事件流。
 * @returns {{push:(chunk:any)=>void, end:()=>void, result:()=>({text:string,sessionId:string,sawResult:boolean,exitCode:number|null,result:object|null})}}
 */
function createHermesStreamParser(handlers = {}) {
  const state = initialHermesStreamState();
  const splitter = createJsonlSplitter((line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return; // 非 JSON 行（诊断输出）忽略
    }
    if (!event || typeof event !== 'object') return;
    if (event.type === 'text' && typeof event.text === 'string') {
      state.text += event.text;
    } else if (event.type === 'system') {
      if (event.session_id) state.sessionId = String(event.session_id);
    } else if (event.type === 'result') {
      state.sawResult = true;
      state.result = event;
      if (event.session_id) state.sessionId = String(event.session_id);
      if (Number.isFinite(event.exit_code)) state.exitCode = event.exit_code;
      if (typeof event.text === 'string' && event.text) state.text = event.text;
    }
    const progress = hermesEventProgress(event, state);
    if (progress && typeof handlers.onProgress === 'function') {
      const normalized = normalizeProgressPayload(progress, state);
      if (normalized) handlers.onProgress(normalized);
    }
  });
  return {
    push(chunk) {
      splitter.push(chunk);
    },
    end() {
      splitter.end();
    },
    result() {
      return {
        text: state.text,
        sessionId: state.sessionId,
        sawResult: state.sawResult,
        exitCode: state.exitCode,
        result: state.result,
      };
    },
  };
}

function readSessionMap() {
  const file = nonEmptyString(process.env.BUTLER_CLI_SESSION_FILE);
  if (!file) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {
    return {};
  }
}

function saveSessionId(threadId, sessionId) {
  const file = nonEmptyString(process.env.BUTLER_CLI_SESSION_FILE);
  if (!file || !threadId || !sessionId) return;
  try {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const map = readSessionMap();
    map[threadId] = sessionId;
    fs.writeFileSync(file, JSON.stringify(map, null, 2));
  } catch {
    /* 会话缓存失败不影响本次任务 */
  }
}

function extractHermesSessionId(text) {
  const match = /(?:session[_\s-]*id|会话\s*ID)\s*[:=]\s*([A-Za-z0-9._:-]{6,})/i.exec(String(text || ''));
  return match ? match[1] : '';
}

function listHermesSessionIds(exe, env, cwd) {
  try {
    const output = execFileSync(exe, ['sessions', 'list', '--limit', '10'], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
    return new Set([...String(output).matchAll(/local-[0-9a-f]{32,}/g)].map((match) => match[0]));
  } catch {
    return new Set();
  }
}

/** 把工作机的前缀要求放在用户指令前，确保 Hermes 优先使用指定 skill。 */
function composePrompt(prefix, instruction) {
  const head = nonEmptyString(prefix);
  const body = String(instruction || '');
  return head ? `${head}\n\n用户任务：\n${body}` : body;
}

/** 运行约束标记：存在即不重复追加。 */
const RUNTIME_GUARD_MARK = '【运行约束】';
const RUNTIME_GUARD_TEXT = '这是无人值守的一次性任务：不要启动常驻服务或后台服务器（如 python xxx.py、flask run、npm run dev）；验证网页用静态文件检查或一次性命令。确需后台进程时必须真正分离（例如 Start-Process 且立即返回），保证当前命令几秒内结束并交出输出，否则整条命令会一直挂着直到任务超时。';

/**
 * 本机 CLI 任务的运行约束：任务是一锤子买卖，后台常驻进程会把命令管道占住。
 * 事故 task_f0dq7lou：OpenCode 用 Start-Process 起了 python 原型服务器，bash 工具
 * 不再返回，13 分钟没有任何新输出，最后撞 900s 硬上限。
 */
function withRuntimeGuard(instruction) {
  const body = String(instruction || '');
  if (!body || body.includes(RUNTIME_GUARD_MARK)) return body;
  return `${body}\n\n${RUNTIME_GUARD_MARK}${RUNTIME_GUARD_TEXT}`;
}

/**
 * Hermes 会话键：普通任务/继续任务按 threadId 复用会话；
 * 计划子任务不共享父任务会话（否则兄弟子任务的对话会互相污染、越跑越偏），
 * 改为按 taskId 隔离，只允许该子任务自己的重试/恢复复用。
 */
function sessionKeyFor(ctx = {}) {
  const taskId = nonEmptyString(ctx.taskId);
  const parentTaskId = nonEmptyString(ctx.parentTaskId);
  if (parentTaskId && taskId) return `task:${taskId}`;
  return nonEmptyString(ctx.threadId);
}

/** 根据模型名/显式映射选择 Hermes provider，避免把 Agnes 模型发给 DeepSeek。 */
function providerForModel(model, modelProviders = {}) {
  const name = nonEmptyString(model);
  if (!name) return '';
  const map = modelProviders && typeof modelProviders === 'object' ? modelProviders : {};
  if (nonEmptyString(map[name])) return map[name].trim();
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(map)) {
    if (String(key).toLowerCase() === lower && nonEmptyString(value)) return String(value).trim();
  }
  if (lower.startsWith('deepseek')) return 'deepseek';
  if (lower.startsWith('agnes')) return 'custom';
  return '';
}

function buildOpencodeArgs({ instruction, model, workdir = '', auto = true }) {
  const args = ['run', String(instruction || ''), '-m', model, '--format', 'json'];
  if (workdir) args.push('--dir', workdir);
  if (auto) args.push('--auto');
  return args;
}

/** 从 opencode `--format json` 的 JSONL 中提取助手正文与错误。 */
function extractOpencodeText(stdout) {
  const lines = String(stdout || '').split(/\r?\n/);
  const chunks = [];
  let error = '';
  const push = (text) => {
    const value = String(text || '');
    if (!value) return;
    if (chunks[chunks.length - 1] !== value) chunks.push(value);
  };
  const walk = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 6) return;
    if (value.type === 'error' && value.error) {
      const data = value.error.data || {};
      const message = data.message || value.error.name || 'OpenCode 返回错误';
      error = message;
      return;
    }
    if (value.type === 'text' && typeof value.text === 'string') push(value.text);
    else if (value.part && value.part.type === 'text' && typeof value.part.text === 'string') {
      push(value.part.text);
    } else if (value.type === 'message.part.updated' && value.properties) {
      walk(value.properties, depth + 1);
    } else if (value.part) {
      walk(value.part, depth + 1);
    }
    for (const key of Object.keys(value)) {
      if (key === 'error' || key === 'part' || key === 'properties') continue;
      walk(value[key], depth + 1);
    }
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      walk(JSON.parse(trimmed));
    } catch {
      /* 非 JSON 行忽略 */
    }
  }
  return { text: chunks.join('').trim(), error };
}

function parseCliArgs(argv) {
  const out = {
    mode: DEFAULTS.mode,
    allowShell: false,
    fallbackHermes: false,
    json: true,
    modelProviders: {},
    streamProgress: DEFAULTS.streamProgress,
    project: '',
    projectFolder: '',
    taskId: '',
    parentTaskId: '',
  };
  const take = (index, key) => {
    if (!argv[index + 1]) throw new Error(`${key} 缺少值`);
    return argv[index + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    const eq = arg.indexOf('=');
    const key = eq >= 0 ? arg.slice(0, eq) : arg;
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
    const value = () => (inline !== undefined ? inline : take(i, key));
    switch (key) {
      case '--instruction':
        out.instruction = value();
        if (inline === undefined) i += 1;
        break;
      case '--mode':
        out.mode = value();
        if (inline === undefined) i += 1;
        break;
      case '--profile':
        out.profile = value();
        if (inline === undefined) i += 1;
        break;
      case '--model':
        out.model = value();
        if (inline === undefined) i += 1;
        break;
      case '--skills':
        out.skills = value();
        if (inline === undefined) i += 1;
        break;
      case '--thread-id':
        out.threadId = value();
        if (inline === undefined) i += 1;
        break;
      case '--prompt-prefix':
        out.promptPrefix = value();
        if (inline === undefined) i += 1;
        break;
      case '--provider':
        out.provider = value();
        if (inline === undefined) i += 1;
        break;
      case '--task-id':
        out.taskId = value();
        if (inline === undefined) i += 1;
        break;
      case '--parent-task-id':
        out.parentTaskId = value();
        if (inline === undefined) i += 1;
        break;
      case '--workdir':
        out.workdir = value();
        if (inline === undefined) i += 1;
        break;
      case '--project':
        out.project = value();
        if (inline === undefined) i += 1;
        break;
      case '--project-folder':
        out.projectFolder = value();
        if (inline === undefined) i += 1;
        break;
      case '--timeout-ms':
        out.timeoutMs = Number(value());
        if (inline === undefined) i += 1;
        break;
      case '--progress-file':
        out.progressFile = value();
        if (inline === undefined) i += 1;
        break;
      case '--opencode-model':
        out.opencodeModel = value();
        if (inline === undefined) i += 1;
        break;
      case '--model-providers':
        try {
          out.modelProviders = JSON.parse(value());
        } catch {
          throw new Error('--model-providers 必须是 JSON 对象');
        }
        if (inline === undefined) i += 1;
        break;
      case '--allow-shell':
        out.allowShell = true;
        break;
      case '--fallback-hermes':
        out.fallbackHermes = true;
        break;
      case '--stream-progress':
        out.streamProgress = true;
        break;
      case '--no-stream-progress':
        out.streamProgress = false;
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }
  return out;
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    child.once('error', (err) => done(reject, err));
    child.once('exit', (code, signal) => done(resolve, { code, signal }));
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killTree(child);
        done(reject, new Error(`执行超时（${timeoutMs}ms），已终止`));
      }, timeoutMs);
      if (timer.unref) timer.unref();
    }
  });
}

function killTree(child) {
  if (!child || !child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', () => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      });
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
}

/** 以文件重定向的方式运行子进程（避免管道 spawn 在受限环境被拒绝）。 */
async function runProcess({ exe, args, cwd, env, timeoutMs, label, onStdout = null, pollMs = 1000 }) {
  if (!exe) throw new Error(`${label}：找不到可执行文件`);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'butler-cli-'));
  const outFile = path.join(dir, 'stdout.log');
  const errFile = path.join(dir, 'stderr.log');
  const outFd = fs.openSync(outFile, 'a');
  const errFd = fs.openSync(errFile, 'a');
  const startedAt = Date.now();
  let child;
  try {
    child = spawn(exe, args, {
      cwd,
      env,
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
      shell: false,
    });
  } catch (err) {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    throw new Error(`${label}启动失败：${err.message}`);
  }
  // 轮询 stdout 文件把增量输出转成进度（opencode --format json 是 JSONL）。
  let pollTimer = null;
  if (typeof onStdout === 'function') {
    pollTimer = setInterval(() => {
      try {
        onStdout(outFile, Date.now() - startedAt);
      } catch {
        /* 解析进度失败不影响任务 */
      }
    }, pollMs);
    if (pollTimer.unref) pollTimer.unref();
  }
  let outcome;
  try {
    outcome = await waitForExit(child, timeoutMs);
  } finally {
    if (pollTimer) clearInterval(pollTimer);
    try {
      fs.closeSync(outFd);
      fs.closeSync(errFd);
    } catch {
      /* ignore */
    }
  }
  const stdout = stripAnsi(await fsp.readFile(outFile, 'utf8'));
  const stderr = stripAnsi(await fsp.readFile(errFile, 'utf8'));
  const durationMs = Date.now() - startedAt;
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  return { code: outcome.code, signal: outcome.signal, stdout, stderr, durationMs };
}

function baseEnv(extra = {}) {
  return {
    ...process.env,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    TERM: 'dumb',
    PYTHONIOENCODING: 'utf-8',
    ...extra,
  };
}

async function runHermesLegacy(ctx) {
  const home = ctx.hermesHome;
  const exe = ctx.hermesExe;
  const profileHome = hermesProfileHome(home, ctx.profile);
  const sessionMap = readSessionMap();
  const sessionKey = sessionKeyFor(ctx);
  const sessionId = sessionKey ? sessionMap[sessionKey] || '' : '';
  const env = baseEnv({ HERMES_HOME: profileHome, HERMES_PROFILE: ctx.profile || '' });
  const targetDir = ctx.projectDir || ctx.workdir;
  const beforeSessions = sessionKey ? listHermesSessionIds(exe, env, targetDir) : new Set();
  const buildArgs = (resumeId) => buildHermesArgs({
    instruction: composePrompt(ctx.promptPrefix, ctx.instruction),
    model: ctx.model || '',
    provider: ctx.provider || '',
    skills: ctx.skills || '',
    sessionId: resumeId,
    workdir: targetDir,
    yolo: ctx.yolo !== false,
  });
  const run = (resumeId) => runProcess({
    exe,
    args: buildArgs(resumeId),
    cwd: targetDir,
    env,
    timeoutMs: ctx.timeoutMs,
    label: 'Hermes CLI',
  });
  let res = await run(sessionId);
  // 会话 ID 失效/隐私模式重启时，回退到新会话，避免整个任务失败。
  if (sessionId && res.code !== 0) res = await run('');
  const text = res.stdout.trim() || res.stderr.trim();
  const foundSession = extractHermesSessionId(`${res.stdout}\n${res.stderr}`);
  if (foundSession && sessionKey) saveSessionId(sessionKey, foundSession);
  if (!foundSession && sessionKey) {
    const afterSessions = listHermesSessionIds(exe, env, targetDir);
    const created = [...afterSessions].find((id) => !beforeSessions.has(id));
    if (created) saveSessionId(sessionKey, created);
  }
  if (res.code !== 0) {
    throw new Error(describeHermesExit(res.code, text, home));
  }
  if (!text) throw new Error('Hermes CLI 未返回任何内容');
  return {
    backend: 'hermes',
    model: ctx.model || 'hermes-default',
    text: truncate(text, 200000),
    stdout: res.stdout,
    stderr: res.stderr,
    exitCode: res.code,
    durationMs: res.durationMs,
    commandPreview: `hermes --cli -z "${truncate(ctx.instruction, 80)}"`,
  };
}

/**
 * 用 `chat -q … --format stream-json` 执行一次 Hermes，实时把工具调用转成进度回调。
 * 返回可直接用于 saveSessionId / 组装的原始结果。
 */
function runHermesStreamAttempt(ctx, resumeId) {
  const env = baseEnv({
    HERMES_HOME: hermesProfileHome(ctx.hermesHome, ctx.profile),
    HERMES_PROFILE: ctx.profile || '',
  });
  const targetDir = ctx.projectDir || ctx.workdir;
  const args = buildHermesStreamArgs({
    instruction: composePrompt(ctx.promptPrefix, ctx.instruction),
    model: ctx.model || '',
    provider: ctx.provider || '',
    skills: ctx.skills || '',
    sessionId: resumeId,
    workdir: targetDir,
  });
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(ctx.hermesExe, args, {
        cwd: targetDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
    } catch (err) {
      reject(new Error(`Hermes CLI启动失败：${err.message}`));
      return;
    }
    const parser = createHermesStreamParser({
      onProgress: (payload) => {
        if (typeof ctx.onProgress !== 'function') return;
        try {
          ctx.onProgress(payload);
        } catch {
          /* 进度上报失败不影响任务 */
        }
      },
    });
    let stderrTail = '';
    let settled = false;
    let timer = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        parser.end();
      } catch {
        /* ignore */
      }
      callback(value);
    };
    if (child.stdout && child.stdout.setEncoding) child.stdout.setEncoding('utf8');
    if (child.stdout) child.stdout.on('data', (chunk) => parser.push(chunk));
    if (child.stderr && child.stderr.setEncoding) child.stderr.setEncoding('utf8');
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        const text = String(chunk);
        stderrTail = (stderrTail + text).slice(-STREAM_STDERR_TAIL);
        try {
          process.stderr.write(text);
        } catch {
          /* ignore */
        }
      });
    }
    child.once('error', (err) => {
      finish(reject, new Error(`Hermes CLI启动失败：${err.message}`));
    });
    child.once('close', (code, signal) => {
      const state = parser.result();
      finish(resolve, {
        code,
        signal,
        stderr: stripAnsi(stderrTail),
        durationMs: Date.now() - startedAt,
        args,
        ...state,
      });
    });
    if (ctx.timeoutMs > 0) {
      timer = setTimeout(() => {
        killTree(child);
        finish(reject, new Error(`执行超时（${ctx.timeoutMs}ms），已终止`));
      }, ctx.timeoutMs);
      if (timer.unref) timer.unref();
    }
  });
}

async function runHermesStream(ctx) {
  const home = ctx.hermesHome;
  const exe = ctx.hermesExe;
  if (!exe) throw new Error('Hermes CLI：找不到可执行文件');
  const env = baseEnv({
    HERMES_HOME: hermesProfileHome(home, ctx.profile),
    HERMES_PROFILE: ctx.profile || '',
  });
  const sessionMap = readSessionMap();
  const sessionKey = sessionKeyFor(ctx);
  const desiredSession = sessionKey ? sessionMap[sessionKey] || '' : '';
  const targetDir = ctx.projectDir || ctx.workdir;
  const beforeSessions = sessionKey ? listHermesSessionIds(exe, env, targetDir) : new Set();

  let res = await runHermesStreamAttempt(ctx, desiredSession);
  if (desiredSession && !res.sawResult && res.code !== 0) {
    // 会话失效时换新会话重试一次（与旧版 -z 行为一致）。
    res = await runHermesStreamAttempt(ctx, '');
  }
  const text = String(res.text || '').trim() || String(res.stderr || '').trim();
  // 有 result 事件时以事件里的 exit_code 为准（CLI 进程本身可能始终返回 0）。
  const effectiveCode = res.sawResult && Number.isFinite(res.exitCode) ? res.exitCode : res.code;
  const foundSession = res.sessionId
    || extractHermesSessionId(`${res.text || ''}\n${res.stderr || ''}`);
  if (foundSession && sessionKey) saveSessionId(sessionKey, foundSession);
  if (!foundSession && sessionKey) {
    const afterSessions = listHermesSessionIds(exe, env, targetDir);
    const created = [...afterSessions].find((id) => !beforeSessions.has(id));
    if (created) saveSessionId(sessionKey, created);
  }
  if (effectiveCode !== 0 && !res.sawResult) {
    const err = new Error(describeHermesExit(res.code, text, home));
    if (res.code === 2 && /(unrecognized|invalid choice|--format|requires -q)/i.test(res.stderr || '')) {
      err.streamUnsupported = true;
    }
    throw err;
  }
  if (effectiveCode !== 0) throw new Error(describeHermesExit(effectiveCode, text, home));
  if (!text) throw new Error('Hermes CLI 未返回任何内容');
  return {
    backend: 'hermes',
    model: ctx.model || 'hermes-default',
    text: truncate(text, 200000),
    stdout: res.text || '',
    stderr: res.stderr,
    exitCode: effectiveCode,
    durationMs: res.durationMs,
    commandPreview: `hermes chat -q "${truncate(ctx.instruction, 80)}" --format stream-json`,
  };
}

/** 优先 stream-json（实时步骤），旧版 Hermes 不支持时回退旧的 -z 一次性调用。 */
async function runHermes(ctx) {
  if (ctx.streamProgress !== false) {
    try {
      return await runHermesStream(ctx);
    } catch (err) {
      if (!(err && err.streamUnsupported)) throw err;
      // 旧版 Hermes 不认识 --format stream-json：回退到 -z，把执行过程看不到当作已知限制。
    }
  }
  return runHermesLegacy(ctx);
}

/** 把 opencode `--format json` 的单个事件描述成人类可读进度（无可用信息返回空串）。 */
function describeOpencodeEvent(event) {
  if (!event || typeof event !== 'object') return '';
  const describePart = (part) => {
    if (!part || typeof part !== 'object') return '';
    if (part.type === 'text' && typeof part.text === 'string') {
      return `输出：${shortenLine(part.text, 60)}`;
    }
    if (part.type === 'tool') {
      const name = part.tool || (part.state && part.state.title) || 'tool';
      const status = part.state && part.state.status ? `（${part.state.status}）` : '';
      return `工具 ${name}${status}`;
    }
    return '';
  };
  const direct = describePart(event);
  if (direct) return direct;
  const part = event.part || (event.properties && event.properties.part) || null;
  const nested = describePart(part);
  if (nested) return nested;
  if (event.type === 'step-start') return '开始新一轮';
  if (event.type === 'error') {
    const data = event.error && event.error.data ? event.error.data : {};
    return `错误：${shortenLine(data.message || (event.error && event.error.name) || event.message || '', 80)}`;
  }
  return '';
}

async function runOpencode(ctx) {
  const args = buildOpencodeArgs({
    instruction: ctx.instruction,
    model: ctx.opencodeModel,
    workdir: ctx.workdir,
    auto: true,
  });
  // OpenCode 不支持 Hermes 的 stream-json，但 `--format json` 是 JSONL：
  // 轮询 stdout 把工具调用/文本增量转成进度，避免整个执行期间控制台停在 2%。
  const onProgress = typeof ctx.onProgress === 'function' ? ctx.onProgress : null;
  let offset = 0;
  let remainder = '';
  let lastEmitAt = 0;
  const seen = new Set();
  const emit = (message, percent, opts) => {
    if (!onProgress || !message) return;
    const now = Date.now();
    if (now - lastEmitAt < 900) return;
    lastEmitAt = now;
    try {
      const payload = { message: String(message).slice(0, 200), percent };
      // silent：仅用于「还活着」心跳，不算真实进度。executors 的卡死 watchdog 靠它
      // 区分「OpenCode 在稳步干活」和「进程还在、但其实 10 分钟没任何输出」。
      if (opts && opts.silent === true) payload.silent = true;
      onProgress(payload);
    } catch {
      /* 进度失败不影响任务 */
    }
  };
  const onStdout = (file, elapsedMs) => {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    if (text.length > offset) {
      remainder += text.slice(offset);
      offset = text.length;
      const lines = remainder.split('\n');
      remainder = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const desc = describeOpencodeEvent(JSON.parse(trimmed));
          if (desc && !seen.has(desc)) {
            seen.add(desc);
            emit(`OpenCode：${desc}`, 30);
          }
        } catch {
          /* 非 JSON 行忽略 */
        }
      }
    }
    if (Date.now() - lastEmitAt >= 15000) {
      emit(`OpenCode 执行中（已 ${Math.round(elapsedMs / 1000)}s）…`, 20, { silent: true });
    }
  };
  const res = await runProcess({
    exe: ctx.opencodeExe,
    args,
    cwd: ctx.workdir,
    env: baseEnv(),
    timeoutMs: ctx.timeoutMs,
    label: 'OpenCode CLI',
    onStdout,
    pollMs: 1000,
  });
  const parsed = extractOpencodeText(res.stdout);
  if (parsed.error) {
    throw new Error(`OpenCode：${parsed.error}`);
  }
  if (!parsed.text && res.stderr.trim()) {
    throw new Error(`OpenCode 未返回正文：${truncate(res.stderr.trim(), 200)}`);
  }
  if (res.code !== 0) {
    throw new Error(`OpenCode 退出码 ${res.code}${parsed.text ? `：${truncate(parsed.text, 300)}` : ''}`);
  }
  return {
    backend: 'opencode',
    model: ctx.opencodeModel,
    text: truncate(parsed.text, 200000),
    stdout: res.stdout,
    stderr: res.stderr,
    exitCode: res.code,
    durationMs: res.durationMs,
    commandPreview: `opencode run -m ${ctx.opencodeModel}`,
  };
}

async function runShell(ctx) {
  const command = String(ctx.instruction || '').replace(SHELL_PREFIX_RE, '');
  const shellExe = defaultShellExe();
  const args = ['-NoProfile', '-NonInteractive', '-Command', command];
  const res = await runProcess({
    exe: shellExe,
    args,
    cwd: ctx.workdir,
    env: baseEnv(),
    timeoutMs: ctx.timeoutMs,
    label: 'Shell',
  });
  const text = (res.stdout || res.stderr).trim();
  return {
    backend: 'shell',
    model: 'local-shell',
    text: truncate(text || '（命令无输出）', 200000),
    stdout: res.stdout,
    stderr: res.stderr,
    exitCode: res.code,
    durationMs: res.durationMs,
    commandPreview: truncate(command, 300),
  };
}

async function runTask(options) {
  const instruction = String(options.instruction || '').trim();
  if (!instruction) throw new Error('缺少 --instruction 任务指令');
  const workdir = nonEmptyString(options.workdir) || process.cwd();
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.min(Math.max(options.timeoutMs, 5000), 60 * 60 * 1000)
    : DEFAULTS.timeoutMs;
  const hermesHome = nonEmptyString(options.hermesHome) || defaultHermesHome();
  // 项目归属：把任务会话记到 Hermes 的对应项目里（项目名或绝对路径）。
  // 解析/写库失败不影响任务本身，只在输出里带 reason 便于排查。
  let projectInfo = null;
  if (nonEmptyString(options.project)) {
    try {
      projectInfo = ensureProject({
        home: hermesProfileHome(hermesHome, nonEmptyString(options.profile)),
        workdir,
        project: options.project,
        folder: options.projectFolder,
      });
    } catch (err) {
      projectInfo = {
        ok: false,
        dir: '',
        name: String(options.project).slice(0, 120),
        slug: '',
        projectId: null,
        created: false,
        reason: err && err.message ? err.message : String(err),
      };
    }
  }
  const projectDir = projectInfo && projectInfo.ok ? projectInfo.dir : '';
  const ctx = {
    instruction,
    profile: nonEmptyString(options.profile),
    model: nonEmptyString(options.model),
    skills: nonEmptyString(options.skills),
    promptPrefix: nonEmptyString(options.promptPrefix),
    threadId: nonEmptyString(options.threadId),
    taskId: nonEmptyString(options.taskId),
    parentTaskId: nonEmptyString(options.parentTaskId),
    provider: nonEmptyString(options.provider) || providerForModel(options.model, options.modelProviders),
    workdir,
    projectDir,
    project: projectInfo,
    timeoutMs,
    hermesHome,
    hermesExe: nonEmptyString(options.hermesExe) || defaultHermesExe(hermesHome),
    opencodeExe: nonEmptyString(options.opencodeExe) || defaultOpencodeExe(),
    opencodeModel: nonEmptyString(options.opencodeModel) || DEFAULTS.opencodeModel,
    allowShell: options.allowShell === true,
    streamProgress: options.streamProgress !== false,
    onProgress: typeof options.onProgress === 'function' ? options.onProgress : null,
  };
  const backend = chooseBackend({
    mode: options.mode,
    profile: ctx.profile,
    instruction,
    allowShell: ctx.allowShell,
  });

  if (backend === 'shell') {
    return { ...(await runShell(ctx)), profile: ctx.profile, fallbackFrom: null, project: ctx.project };
  }
  // AI 后端（Hermes/OpenCode）追加运行约束，避免启动常驻服务把命令挂死。
  ctx.instruction = withRuntimeGuard(ctx.instruction);
  if (backend === 'opencode') {
    try {
      return { ...(await runOpencode(ctx)), profile: ctx.profile, fallbackFrom: null, project: ctx.project };
    } catch (err) {
      if (!options.fallbackHermes) throw err;
      const result = await runHermes(ctx);
      return { ...result, profile: ctx.profile, fallbackFrom: 'opencode', fallbackReason: truncate(err.message, 300), project: ctx.project };
    }
  }
  return { ...(await runHermes(ctx)), profile: ctx.profile, fallbackFrom: null, project: ctx.project };
}

/**
 * 生成进度写入函数：把 payload 写成一行 `@@BUTLER_PROGRESS@@ {json}`。
 * silent=true 会一起写进去——executors 侧据此判断「这只是心跳，不算真实进度」。
 * 没有 progressFile 时退回 stderr，便于本地手工跑。
 * @param {string} progressFile
 * @param {(text:string)=>void} [stderrWriter]
 */
function createProgressEmitter(progressFile, stderrWriter) {
  const write = typeof stderrWriter === 'function' ? stderrWriter : (text) => process.stderr.write(text);
  return (payload) => {
    if (!payload || !payload.message) return;
    try {
      const line = {
        message: String(payload.message),
        percent: Number.isFinite(payload.percent) ? payload.percent : undefined,
        at: new Date().toISOString(),
      };
      if (payload.silent === true) line.silent = true;
      const text = `${PROGRESS_PREFIX}${JSON.stringify(line)}\n`;
      if (nonEmptyString(progressFile)) {
        fs.appendFileSync(progressFile, text);
      } else {
        write(text);
      }
    } catch {
      /* ignore */
    }
  };
}

async function main(argv) {
  const options = parseCliArgs(argv);
  if (options.help) {
    process.stdout.write(
      '用法：node cli-worker.js --instruction <指令> [--mode auto|hermes|opencode|shell] '
      + '[--profile <profile>] [--model <model>] [--skills <skills>] [--prompt-prefix <text>] '
      + '[--workdir <dir>] [--project <项目名|目录>] [--project-folder <dir>] '
      + '[--thread-id <id>] [--task-id <id>] [--parent-task-id <id>] '
      + '[--allow-shell] [--fallback-hermes] [--no-stream-progress]\n',
    );
    return 0;
  }
  // 环境变量作为默认值（由 device-agent 传入）
  if (!options.workdir && process.env.BUTLER_CLI_WORKDIR) options.workdir = process.env.BUTLER_CLI_WORKDIR;
  if (!options.timeoutMs && process.env.BUTLER_CLI_TIMEOUT_MS) {
    options.timeoutMs = Number(process.env.BUTLER_CLI_TIMEOUT_MS);
  }
  if (!options.opencodeModel && process.env.BUTLER_CLI_OPENCODE_MODEL) {
    options.opencodeModel = process.env.BUTLER_CLI_OPENCODE_MODEL;
  }
  if (!options.skills && process.env.BUTLER_CLI_SKILLS) options.skills = process.env.BUTLER_CLI_SKILLS;
  if (!options.promptPrefix && process.env.BUTLER_CLI_PROMPT_PREFIX) {
    options.promptPrefix = process.env.BUTLER_CLI_PROMPT_PREFIX;
  }
  options.hermesHome = process.env.BUTLER_CLI_HERMES_HOME || options.hermesHome;
  options.hermesExe = process.env.BUTLER_CLI_HERMES_EXE || options.hermesExe;
  options.opencodeExe = process.env.BUTLER_CLI_OPENCODE_EXE || options.opencodeExe;
  options.progressFile = process.env.BUTLER_CLI_PROGRESS_FILE || options.progressFile;
  options.project = process.env.BUTLER_CLI_PROJECT || options.project;
  options.projectFolder = process.env.BUTLER_CLI_PROJECT_FOLDER || options.projectFolder;
  if (process.env.BUTLER_CLI_STREAM_PROGRESS === '0') options.streamProgress = false;

  // 实时执行步骤写进度文件（魔法前缀行），由 executors.js 轮询解析后转成 Hub 进度。
  const emitProgress = createProgressEmitter(options.progressFile);

  try {
    const result = await runTask({ ...options, onProgress: emitProgress });
    const payload = {
      ok: true,
      backend: result.backend,
      model: result.model,
      profile: result.profile || '',
      text: result.text,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      commandPreview: result.commandPreview,
      fallbackFrom: result.fallbackFrom || null,
      fallbackReason: result.fallbackReason || null,
      project: result.project || null,
      at: new Date().toISOString(),
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return 0;
  } catch (err) {
    const payload = {
      ok: false,
      error: truncate(err && err.message ? err.message : String(err), 4000),
      at: new Date().toISOString(),
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
      process.exit(1);
    });
}

module.exports = {
  DEFAULTS,
  CODE_RE,
  SHELL_PREFIX_RE,
  PROGRESS_PREFIX,
  createProgressEmitter,
  parseCliArgs,
  chooseBackend,
  buildHermesArgs,
  buildHermesStreamArgs,
  providerForModel,
  composePrompt,
  withRuntimeGuard,
  sessionKeyFor,
  buildOpencodeArgs,
  extractOpencodeText,
  stripAnsi,
  shortenLine,
  describeHermesTool,
  planPercentForTodos,
  createJsonlSplitter,
  hermesEventProgress,
  normalizeProgressPayload,
  createHermesStreamParser,
  hermesProfileHome,
  hermesHomeProblem,
  describeHermesExit,
  defaultHermesHome,
  defaultHermesExe,
  defaultOpencodeExe,
  defaultShellExe,
  runTask,
  main,
};
