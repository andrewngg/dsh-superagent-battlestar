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
const { spawn } = require('node:child_process');

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const CODE_RE = /(写代码|代码|脚本|实现|重构|修复|函数|类|接口|测试|编译|部署|html|css|javascript|typescript|python|node|api|\bbug\b|\bcode\b|\bfix\b|\bscript\b|\bbuild\b|\brefactor\b|\btest\b)/i;
const SHELL_PREFIX_RE = /^\s*(?:!|\/run\s+|\$ )/i;

const DEFAULTS = {
  mode: 'auto',
  timeoutMs: 15 * 60 * 1000,
  opencodeModel: 'deepseek/deepseek-flash',
};

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

function buildHermesArgs({ instruction, model = '', provider = '', workdir = '', yolo = true }) {
  const args = ['--cli'];
  if (yolo) args.push('--yolo');
  if (model) args.push('-m', model);
  if (provider) args.push('--provider', provider);
  if (workdir) args.push('--in', workdir);
  args.push('-z', String(instruction || ''));
  return args;
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
  const out = { mode: DEFAULTS.mode, allowShell: false, fallbackHermes: false, json: true, modelProviders: {} };
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
      case '--provider':
        out.provider = value();
        if (inline === undefined) i += 1;
        break;
      case '--task-id':
        out.taskId = value();
        if (inline === undefined) i += 1;
        break;
      case '--workdir':
        out.workdir = value();
        if (inline === undefined) i += 1;
        break;
      case '--timeout-ms':
        out.timeoutMs = Number(value());
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
async function runProcess({ exe, args, cwd, env, timeoutMs, label }) {
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
  let outcome;
  try {
    outcome = await waitForExit(child, timeoutMs);
  } finally {
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

async function runHermes(ctx) {
  const home = ctx.hermesHome;
  const exe = ctx.hermesExe;
  const profileHome = hermesProfileHome(home, ctx.profile);
  const args = buildHermesArgs({
    instruction: ctx.instruction,
    model: ctx.model || '',
    provider: ctx.provider || '',
    workdir: ctx.workdir,
    yolo: ctx.yolo !== false,
  });
  const res = await runProcess({
    exe,
    args,
    cwd: ctx.workdir,
    env: baseEnv({ HERMES_HOME: profileHome, HERMES_PROFILE: ctx.profile || '' }),
    timeoutMs: ctx.timeoutMs,
    label: 'Hermes CLI',
  });
  const text = res.stdout.trim() || res.stderr.trim();
  if (res.code !== 0) {
    throw new Error(`Hermes CLI 退出码 ${res.code}${text ? `：${truncate(text, 300)}` : ''}`);
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

async function runOpencode(ctx) {
  const args = buildOpencodeArgs({
    instruction: ctx.instruction,
    model: ctx.opencodeModel,
    workdir: ctx.workdir,
    auto: true,
  });
  const res = await runProcess({
    exe: ctx.opencodeExe,
    args,
    cwd: ctx.workdir,
    env: baseEnv(),
    timeoutMs: ctx.timeoutMs,
    label: 'OpenCode CLI',
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
  const ctx = {
    instruction,
    profile: nonEmptyString(options.profile),
    model: nonEmptyString(options.model),
    provider: nonEmptyString(options.provider) || providerForModel(options.model, options.modelProviders),
    workdir,
    timeoutMs,
    hermesHome,
    hermesExe: nonEmptyString(options.hermesExe) || defaultHermesExe(hermesHome),
    opencodeExe: nonEmptyString(options.opencodeExe) || defaultOpencodeExe(),
    opencodeModel: nonEmptyString(options.opencodeModel) || DEFAULTS.opencodeModel,
    allowShell: options.allowShell === true,
  };
  const backend = chooseBackend({
    mode: options.mode,
    profile: ctx.profile,
    instruction,
    allowShell: ctx.allowShell,
  });

  if (backend === 'shell') {
    return { ...(await runShell(ctx)), profile: ctx.profile, fallbackFrom: null };
  }
  if (backend === 'opencode') {
    try {
      return { ...(await runOpencode(ctx)), profile: ctx.profile, fallbackFrom: null };
    } catch (err) {
      if (!options.fallbackHermes) throw err;
      const result = await runHermes(ctx);
      return { ...result, profile: ctx.profile, fallbackFrom: 'opencode', fallbackReason: truncate(err.message, 300) };
    }
  }
  return { ...(await runHermes(ctx)), profile: ctx.profile, fallbackFrom: null };
}

async function main(argv) {
  const options = parseCliArgs(argv);
  if (options.help) {
    process.stdout.write(
      '用法：node cli-worker.js --instruction <指令> [--mode auto|hermes|opencode|shell] '
      + '[--profile <profile>] [--model <model>] [--workdir <dir>] [--allow-shell] [--fallback-hermes]\n',
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
  options.hermesHome = process.env.BUTLER_CLI_HERMES_HOME || options.hermesHome;
  options.hermesExe = process.env.BUTLER_CLI_HERMES_EXE || options.hermesExe;
  options.opencodeExe = process.env.BUTLER_CLI_OPENCODE_EXE || options.opencodeExe;

  try {
    const result = await runTask(options);
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
  parseCliArgs,
  chooseBackend,
  buildHermesArgs,
  providerForModel,
  buildOpencodeArgs,
  extractOpencodeText,
  stripAnsi,
  hermesProfileHome,
  defaultHermesHome,
  defaultHermesExe,
  defaultOpencodeExe,
  defaultShellExe,
  runTask,
  main,
};
