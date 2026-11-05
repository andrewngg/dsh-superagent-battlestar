'use strict';

/**
 * 可插拔任务执行器：
 *  - simulate（默认）：生成真实感中文进度 + 结构化结果，默认总耗时 2-6s，可配置缩短；
 *  - dsh-cli：命令模板（默认 `dsh run --print {instruction}`），输出重定向到临时文件后截断；
 *  - shell：命令模板（默认 echo）；
 *  - http：POST 到设备本地服务（不允许指向 Hub 自身，仅本机/内网）；
 *  - ollama：POST {OLLAMA_HOST}/api/generate；
 *  - cli：调用本机 CLI Agent（Hermes / OpenCode / shell），见 device-agent/cli-worker.js；
 *  - comfyui：提交 ComfyUI API 工作流、轮询历史并下载生成图片；
 *  - mika：调用 Mika CLI，在 Android 手机上执行任务并等待结果。
 *
 * 所有执行器共享同一接口：
 *   run({ task, command, device, signal, progress, log }) -> { output, error? }
 * 取消：signal 触发后中止子进程/HTTP 请求，抛出 name === 'AbortError' 的错误。
 * 注意：Windows 沙箱下不能 pipe 子进程 stdio，命令执行器统一用 'ignore' + 文件重定向。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { requestJson, joinUrl, normalizeBaseUrl } = require('./http');

const PROGRESS_MIN_INTERVAL_MS = 800;
const DEFAULT_SIMULATE = Object.freeze({
  minDurationMs: 2000,
  maxDurationMs: 6000,
  minSteps: 3,
  maxSteps: 6,
  minStepMs: 120,
});

class ExecutorTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExecutorTimeoutError';
    this.code = 'timeout';
  }
}

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function clampInt(value, min, max, fallback) {
  const n = Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function randomInt(min, max) {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  if (hi <= lo) return lo;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function truncate(text, maxChars) {
  const value = String(text == null ? '' : text);
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n…（输出已截断，共 ${value.length} 字符）`;
}

function makeAbortError(signal) {
  const reason = signal && signal.reason;
  const err = new Error(typeof reason === 'string' && reason === 'timeout' ? '执行超时' : '任务已取消');
  err.name = 'AbortError';
  err.code = typeof reason === 'string' ? reason : 'cancelled';
  return err;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw makeAbortError(signal);
}

/** 可被 AbortSignal 打断的 sleep。 */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(makeAbortError(signal));
      return;
    }
    let timer = null;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(makeAbortError(signal));
    };
    timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// 进度节流：任意两次上报间隔 >= 800ms（中间进度直接丢弃，避免刷爆 Hub）
// ---------------------------------------------------------------------------

/**
 * @param {(message:string, percent?:number)=>any} send
 * @param {{minIntervalMs?:number}} [options]
 * @returns {(message:string, percent?:number)=>Promise<void>}
 */
function makeProgressThrottle(send, options = {}) {
  const minIntervalMs = clampInt(options.minIntervalMs, 0, 60000, PROGRESS_MIN_INTERVAL_MS);
  let lastAt = 0;
  return async function reportProgress(message, percent) {
    const now = Date.now();
    if (now - lastAt < minIntervalMs) return;
    lastAt = now;
    try {
      await send(message, percent);
    } catch {
      // 进度上报失败不能影响任务执行；下次还会继续尝试
    }
  };
}

// ---------------------------------------------------------------------------
// simulate 执行器
// ---------------------------------------------------------------------------

const SIMULATE_FLAVORS = {
  office: {
    label: '办公文档',
    match: /word|docx|excel|xlsx|ppt|pptx|文档|表格|报告|账单|开销|账本|汇总|整理|排版|幻灯|演示/i,
    steps: [
      '解析需求与交付格式',
      '读取原始数据与家庭账本',
      '清洗数据并核对异常条目',
      '生成图表与结论摘要',
      '排版并导出最终文档',
    ],
    artifact(instruction) {
      const title = deriveTitle(instruction, '任务报告');
      const ext = /excel|xlsx|表格|账本|清单/i.test(instruction)
        ? '.xlsx'
        : /ppt|pptx|演示|幻灯/i.test(instruction)
          ? '.pptx'
          : '.docx';
      return { name: `${title}${ext}` };
    },
    conclusion(instruction) {
      return `已完成文档整理，输出了「${deriveTitle(instruction, '任务报告')}」，包含数据核对、图表与结论。`;
    },
  },
  research: {
    label: '联网调研',
    match: /调研|研究|搜索|检索|资料|查一下|查查|资料|新闻|趋势|对比/i,
    steps: [
      '拆解检索问题与关键词',
      '检索近一周的公开资料',
      '交叉核对来源可信度',
      '提炼关键结论与风险提示',
      '生成调研摘要',
    ],
    artifact(instruction) {
      return { name: `${deriveTitle(instruction, '调研摘要')}.md` };
    },
    conclusion(instruction) {
      return `已完成「${deriveTitle(instruction, '调研摘要')}」的资料整理，共归纳 5 条关键结论与 2 条风险提示。`;
    },
  },
  home: {
    label: '家居自动化',
    match: /空调|灯|窗帘|扫地|净化器|温度|湿度|回家|离家|家居|家电|客厅|卧室/i,
    steps: [
      '解析家居指令与当前设备状态',
      '检查家庭网络与设备在线情况',
      '下发控制指令并等待回执',
      '校验执行结果与能耗变化',
      '汇总本次家庭自动化结果',
    ],
    artifact(instruction) {
      return { name: `${deriveTitle(instruction, '家居执行记录')}.json` };
    },
    conclusion(instruction) {
      return `家居指令已执行：${summarizeInstruction(instruction)}；已确认目标设备回执正常。`;
    },
  },
  code: {
    label: '代码任务',
    match: /代码|脚本|bug|程序|函数|接口|部署|测试|编译|npm|node|python/i,
    steps: [
      '解析代码任务与依赖环境',
      '定位相关文件与失败点',
      '编写并运行验证脚本',
      '执行测试并修复问题',
      '汇总变更与验证结论',
    ],
    artifact(instruction) {
      return { name: `${deriveTitle(instruction, '代码任务报告')}.md` };
    },
    conclusion(instruction) {
      return `代码任务已完成：${summarizeInstruction(instruction)}；验证脚本全部通过。`;
    },
  },
  media: {
    label: '媒体处理',
    match: /播放|音乐|电影|相册|照片|视频|投屏|歌单|媒体/i,
    steps: [
      '识别媒体类型与目标设备',
      '扫描本地媒体库与播放列表',
      '生成播放与整理方案',
      '下发播放或归档指令',
      '确认媒体状态与结果',
    ],
    artifact(instruction) {
      return { name: `${deriveTitle(instruction, '媒体整理清单')}.json` };
    },
    conclusion(instruction) {
      return `媒体任务已完成：${summarizeInstruction(instruction)}；播放列表与归档清单已更新。`;
    },
  },
  general: {
    label: '通用任务',
    match: null,
    steps: [
      '理解任务目标与约束',
      '拆分执行步骤并准备环境',
      '逐步执行并检查中间结果',
      '汇总产出与注意事项',
      '生成最终结果',
    ],
    artifact(instruction) {
      return { name: `${deriveTitle(instruction, '任务结果')}.md` };
    },
    conclusion(instruction) {
      return `任务已完成：${summarizeInstruction(instruction)}。`;
    },
  },
};

const FLAVOR_ORDER = ['office', 'research', 'home', 'code', 'media'];

function shorten(text, maxLength) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function deriveTitle(instruction, fallback) {
  const text = String(instruction || '')
    .replace(/[\\/:*?"<>|\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return fallback;
  // 取前 18 个字符做文件名主体，过短则用默认标题
  return text.length >= 6 ? shorten(text, 18) : fallback;
}

function summarizeInstruction(instruction) {
  return shorten(instruction, 42) || '（无指令内容）';
}

function pickFlavor(instruction) {
  const text = String(instruction || '');
  for (const key of FLAVOR_ORDER) {
    const flavor = SIMULATE_FLAVORS[key];
    if (flavor.match && flavor.match.test(text)) return { key, flavor };
  }
  return { key: 'general', flavor: SIMULATE_FLAVORS.general };
}

function selectSimulateSteps(flavor, count) {
  const steps = flavor.steps;
  const take = Math.min(count, steps.length);
  if (take <= 1) return steps.slice(0, 1);
  // 始终保留最后一步（产出/汇总），前面步骤按顺序取
  return [...steps.slice(0, take - 1), steps[steps.length - 1]];
}

function createSimulateExecutor(options = {}) {
  const cfg = isPlainObject(options.executorCfg) ? options.executorCfg : {};
  const minDurationMs = clampInt(cfg.minDurationMs, 0, 3600000, DEFAULT_SIMULATE.minDurationMs);
  const maxDurationMs = clampInt(cfg.maxDurationMs, minDurationMs, 3600000, DEFAULT_SIMULATE.maxDurationMs);
  const minSteps = clampInt(cfg.minSteps, 1, 8, DEFAULT_SIMULATE.minSteps);
  const maxSteps = clampInt(cfg.maxSteps, minSteps, 8, DEFAULT_SIMULATE.maxSteps);
  const minStepMs = clampInt(cfg.minStepMs, 0, 60000, DEFAULT_SIMULATE.minStepMs);

  return {
    async run(ctx = {}) {
      const signal = ctx.signal || null;
      const progress = typeof ctx.progress === 'function' ? ctx.progress : async () => {};
      const task = ctx.task || {};
      const instruction = String(task.instruction || '');
      const startedAt = Date.now();

      const { key, flavor } = pickFlavor(instruction);
      const stepCount = randomInt(minSteps, maxSteps);
      const steps = selectSimulateSteps(flavor, stepCount);
      const totalMs = randomInt(minDurationMs, maxDurationMs);

      // 按权重把总时长分摊到各步骤
      const weights = steps.map(() => 0.6 + Math.random() * 0.8);
      const weightSum = weights.reduce((sum, w) => sum + w, 0) || 1;
      const stepDurations = weights.map((w) =>
        Math.max(minStepMs, Math.round((totalMs * w) / weightSum)),
      );

      const executed = [];
      for (let i = 0; i < steps.length; i += 1) {
        throwIfAborted(signal);
        await delay(stepDurations[i], signal);
        const percent = i === steps.length - 1 ? 100 : Math.round(((i + 1) / steps.length) * 96);
        executed.push({ index: i + 1, message: steps[i], percent, at: new Date().toISOString() });
        await progress(steps[i], percent);
      }

      const durationMs = Date.now() - startedAt;
      const artifacts = [flavor.artifact(instruction)];
      const model =
        (task.requirements && task.requirements.model) ||
        (ctx.device &&
          ctx.device.capabilities &&
          Array.isArray(ctx.device.capabilities.models) &&
          ctx.device.capabilities.models.find((m) => m && m.available !== false) &&
          ctx.device.capabilities.models.find((m) => m && m.available !== false).id) ||
        'simulate';
      const deviceName = (ctx.device && ctx.device.name) || '本机设备';
      const createdAt = new Date().toISOString();

      const output = {
        text: [
          `任务已完成（模拟执行，用时 ${(durationMs / 1000).toFixed(1)}s）。`,
          `指令：${summarizeInstruction(instruction)}`,
          `设备：${deviceName}｜模型：${model}｜类别：${flavor.label}`,
          `步骤：${executed.map((step) => step.message).join(' → ')}`,
          `结论：${flavor.conclusion(instruction)}`,
        ].join('\n'),
        markdown: [
          `## ✅ 任务已完成（${flavor.label}）`,
          '',
          `> 指令：${summarizeInstruction(instruction)}`,
          '',
          '### 执行步骤',
          ...executed.map((step, index) => `${index + 1}. ${step.message}（${step.percent}%）`),
          '',
          '### 结论',
          flavor.conclusion(instruction),
          '',
          `- 设备：\`${deviceName}\``,
          `- 模型：\`${model}\``,
          `- 用时：${(durationMs / 1000).toFixed(1)}s`,
          '- 执行方式：simulate（模拟执行器，未真正调用外部服务）',
        ].join('\n'),
        artifacts,
        data: {
          simulated: true,
          flavor: key,
          flavorLabel: flavor.label,
          model,
          deviceName,
          instruction,
          createdAt,
          durationMs,
          steps: executed,
        },
      };

      return { output, durationMs };
    },
  };
}

// ---------------------------------------------------------------------------
// 命令执行器（dsh-cli / shell）
// ---------------------------------------------------------------------------

function quoteForShell(value) {
  const text = String(value == null ? '' : value).replace(/\r?\n/g, ' ');
  if (process.platform === 'win32') {
    // cmd.exe：去掉双引号、转义 %，避免环境变量展开；其余元字符在双引号内按字面处理
    const escaped = text.replace(/"/g, '').replace(/%/g, '%%');
    return `"${escaped}"`;
  }
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function renderCommandTemplate(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : whole,
  );
}

async function readFileSafe(file) {
  try {
    const buffer = await fsp.readFile(file);
    return buffer.toString('utf8');
  } catch {
    return '';
  }
}

async function removeDirSafe(dir) {
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** 杀死进程及其子进程树（Windows 用 taskkill /T /F；其它平台 SIGTERM→SIGKILL）。 */
function killProcessTree(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode) {
      resolve();
      return;
    }
    const pid = child.pid;
    if (!pid) {
      resolve();
      return;
    }

    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    // 兜底：即使拿不到退出事件，也不能永远挂住
    const guard = setTimeout(done, 4000);
    if (guard.unref) guard.unref();
    if (child.exitCode === null && !child.signalCode) {
      child.once('exit', done);
    } else {
      done();
    }

    const forceDirect = () => {
      if (child.exitCode !== null || child.signalCode) return;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    };

    if (process.platform === 'win32') {
      try {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.once('exit', () => {
          // 受限沙箱里 taskkill 可能返回“拒绝访问”，此时退化杀掉直接子进程
          forceDirect();
        });
        killer.once('error', forceDirect);
      } catch {
        forceDirect();
      }
      return;
    }

    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    const timer = setTimeout(forceDirect, 300);
    if (timer.unref) timer.unref();
  });
}

function waitForChild(child, { timeoutMs = 0, signal = null, label = '命令' } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };

    const onAbort = () => {
      void killProcessTree(child).then(() => settle(reject, makeAbortError(signal)));
    };

    child.once('error', (err) => settle(reject, err));
    child.once('exit', (code, sig) => {
      if (timedOut) settle(reject, new ExecutorTimeoutError(`${label}执行超时（${timeoutMs}ms），已终止`));
      else if (signal && signal.aborted) settle(reject, makeAbortError(signal));
      else settle(resolve, { code, signal: sig });
    });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        void killProcessTree(child);
      }, timeoutMs);
      if (timer.unref) timer.unref();
    }

    if (signal) {
      if (signal.aborted) {
        void killProcessTree(child).then(() => settle(reject, makeAbortError(signal)));
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
  });
}

function createCommandExecutor(kind, options = {}) {
  const cfg = isPlainObject(options.executorCfg) ? options.executorCfg : {};
  const env = options.env || process.env;
  const label = kind === 'dsh-cli' ? 'DSH CLI' : 'Shell 命令';
  const defaultTemplate = kind === 'dsh-cli' ? 'dsh run --print {instruction}' : 'echo {instruction}';
  const template = nonEmptyString(cfg.command) ? cfg.command : defaultTemplate;
  const useShell = cfg.shell !== false;
  const capture = cfg.capture === 'inherit' ? 'inherit' : 'file';
  const maxOutputChars = clampInt(cfg.maxOutputChars, 200, 400000, 16000);
  const defaultTimeoutMs = clampInt(cfg.timeoutMs, 1000, 3600000, 300000);
  const cwd = nonEmptyString(cfg.cwd) ? cfg.cwd : options.cwd || process.cwd();
  const extraEnv = isPlainObject(cfg.env) ? cfg.env : {};

  return {
    async run(ctx = {}) {
      const signal = ctx.signal || null;
      const progress = typeof ctx.progress === 'function' ? ctx.progress : async () => {};
      const task = ctx.task || {};
      throwIfAborted(signal);

      const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), `butler-${kind}-`));
      const outputFile = path.join(workDir, 'output.log');
      const deviceName = (ctx.device && ctx.device.name) || '';
      const values = {
        instruction: quoteForShell(task.instruction || ''),
        prompt: quoteForShell(task.instruction || ''),
        taskId: quoteForShell(task.id || ''),
        deviceName: quoteForShell(deviceName),
        model: quoteForShell((task.requirements && task.requirements.model) || ''),
        outputFile: quoteForShell(outputFile),
        outputDir: quoteForShell(workDir),
      };

      let command = renderCommandTemplate(template, values);
      if (capture === 'file') command = `${command} > ${values.outputFile} 2>&1`;

      await progress(`正在执行${label}…`, 10);
      const startedAt = Date.now();
      let child;
      try {
        child = spawn(command, {
          shell: useShell,
          cwd,
          env: { ...env, ...extraEnv },
          stdio: capture === 'inherit' ? ['ignore', 'inherit', 'inherit'] : 'ignore',
          windowsHide: true,
        });
      } catch (err) {
        await removeDirSafe(workDir);
        return { output: { text: '' }, error: `启动${label}失败：${err.message}` };
      }

      try {
        const timeoutMs = defaultTimeoutMs;
        const { code } = await waitForChild(child, { timeoutMs, signal, label });
        let text = capture === 'file' ? await readFileSafe(outputFile) : '';
        text = truncate(text, maxOutputChars).trim();
        const durationMs = Date.now() - startedAt;
        const output = {
          text: text || `（${label}无输出）`,
          data: { executor: kind, exitCode: code, durationMs, command: shorten(command, 500) },
        };
        if (code !== 0) {
          return {
            output,
            error: `${label}执行失败（退出码 ${code}）${text ? `：${shorten(text, 300)}` : ''}`,
          };
        }
        await progress(`${label}执行完成`, 90);
        return { output, durationMs };
      } finally {
        await removeDirSafe(workDir);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 本机 CLI 执行器（Hermes / OpenCode / shell）
// ---------------------------------------------------------------------------

/**
 * 把任务交给本机 CLI Agent 执行（device-agent/cli-worker.js）。
 *
 * "executor": {
 *   "type": "cli",
 *   "cli": {
 *     "mode": "auto",                     // auto | hermes | opencode | shell
 *     "workdir": "C:\\Users\\me\\work",   // CLI 工作目录
 *     "allowShell": false,                // 是否允许指令以 ! 或 /run 直接执行 shell
 *     "fallbackToHermes": true,           // OpenCode 不可用时回退 Hermes
 *     "timeoutMs": 900000,
 *     "hermes":   { "home": "C:\\Users\\me\\AppData\\Local\\hermes" },
 *     "opencode": { "model": "opencode/deepseek-v4-flash-free" }
 *   }
 * }
 */
function createCliExecutor(options = {}) {
  const cfg = isPlainObject(options.executorCfg) ? options.executorCfg : {};
  const worker = nonEmptyString(cfg.worker) ? cfg.worker : path.join(__dirname, '..', 'cli-worker.js');
  const workdir = nonEmptyString(cfg.workdir) ? cfg.workdir : options.cwd || process.cwd();
  const mode = nonEmptyString(cfg.mode) ? cfg.mode : 'auto';
  const timeoutMs = clampInt(cfg.timeoutMs, 5000, 60 * 60 * 1000, 15 * 60 * 1000);
  const maxOutputChars = clampInt(cfg.maxOutputChars, 200, 400000, 40000);
  const allowShell = cfg.allowShell === true;
  const fallbackToHermes = cfg.fallbackToHermes !== false;
  const hermes = isPlainObject(cfg.hermes) ? cfg.hermes : {};
  const opencode = isPlainObject(cfg.opencode) ? cfg.opencode : {};
  const extraEnv = isPlainObject(cfg.env) ? cfg.env : {};
  const label = '本机 CLI';

  return {
    async run(ctx = {}) {
      const signal = ctx.signal || null;
      const progress = typeof ctx.progress === 'function' ? ctx.progress : async () => {};
      const task = ctx.task || {};
      const requirements = isPlainObject(task.requirements) ? task.requirements : {};
      throwIfAborted(signal);

      const instruction = String(task.instruction || '').trim();
      if (!instruction) return { output: { text: '' }, error: '任务指令为空' };

      const args = [
        worker,
        '--instruction', instruction,
        '--mode', mode,
        '--workdir', workdir,
        '--timeout-ms', String(timeoutMs),
      ];
      if (allowShell) args.push('--allow-shell');
      if (fallbackToHermes) args.push('--fallback-hermes');
      if (requirements.profile) args.push('--profile', String(requirements.profile));
      if (requirements.model) args.push('--model', String(requirements.model));
      if (nonEmptyString(opencode.model)) args.push('--opencode-model', opencode.model);

      const env = { ...process.env, ...options.env, ...extraEnv };
      if (nonEmptyString(hermes.home)) env.BUTLER_CLI_HERMES_HOME = hermes.home;
      if (nonEmptyString(hermes.exe)) env.BUTLER_CLI_HERMES_EXE = hermes.exe;
      if (nonEmptyString(opencode.exe)) env.BUTLER_CLI_OPENCODE_EXE = opencode.exe;
      env.BUTLER_CLI_WORKDIR = workdir;
      env.BUTLER_CLI_TIMEOUT_MS = String(timeoutMs);
      env.NO_COLOR = '1';

      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'butler-cli-exec-'));
      const outFile = path.join(dir, 'worker.stdout.log');
      const errFile = path.join(dir, 'worker.stderr.log');
      const outFd = fs.openSync(outFile, 'a');
      const errFd = fs.openSync(errFile, 'a');
      const closeFds = () => {
        for (const fd of [outFd, errFd]) {
          try {
            fs.closeSync(fd);
          } catch {
            /* ignore */
          }
        }
      };

      await progress(`正在执行${label}（${mode}）…`, 10);
      const startedAt = Date.now();
      let child;
      try {
        child = spawn(process.execPath, args, {
          cwd: workdir,
          env,
          stdio: ['ignore', outFd, errFd],
          windowsHide: true,
        });
      } catch (err) {
        closeFds();
        await removeDirSafe(dir);
        return { output: { text: '' }, error: `启动${label}失败：${err.message}` };
      }

      try {
        let outcome;
        try {
          outcome = await waitForChild(child, { timeoutMs, signal, label });
        } catch (err) {
          return { output: { text: '' }, error: err.message };
        }
        closeFds();

        const stdout = await readFileSafe(outFile);
        const stderr = await readFileSafe(errFile);
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        let payload = null;
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          try {
            const parsed = JSON.parse(lines[i]);
            if (parsed && typeof parsed === 'object' && (parsed.ok === true || parsed.ok === false)) {
              payload = parsed;
              break;
            }
          } catch {
            /* 非 JSON 行 */
          }
        }

        const durationMs = Date.now() - startedAt;
        const rawText = payload && typeof payload.text === 'string'
          ? payload.text
          : stdout.trim() || stderr.trim();
        const text = truncate(rawText, maxOutputChars).trim();

        if (payload && payload.ok === false) {
          return {
            output: { text: text || '（无输出）', data: { executor: 'cli', backend: payload.backend || mode, durationMs } },
            error: payload.error || `${label}执行失败`,
          };
        }
        if (!payload && outcome.code !== 0) {
          return {
            output: { text: text || '（无输出）' },
            error: `${label}执行失败（退出码 ${outcome.code}）${text ? `：${shorten(text, 300)}` : ''}`,
          };
        }
        await progress(`${label}执行完成`, 92);
        return {
          output: {
            text: text || `（${label}无输出）`,
            data: {
              executor: 'cli',
              backend: payload ? payload.backend : mode,
              model: payload ? payload.model : '',
              profile: payload ? payload.profile : requirements.profile || '',
              fallbackFrom: payload ? payload.fallbackFrom || null : null,
              fallbackReason: payload ? payload.fallbackReason || null : null,
              exitCode: payload ? payload.exitCode : outcome.code,
              durationMs,
              commandPreview: payload ? payload.commandPreview : null,
            },
          },
          durationMs,
        };
      } finally {
        closeFds();
        await removeDirSafe(dir);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// http 执行器
// ---------------------------------------------------------------------------

function assertEndpointAllowed(endpoint, blockedOrigins = []) {
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(`http 执行器 url 非法：${endpoint}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`http 执行器仅支持 http/https：${endpoint}`);
  }
  const targetOrigin = `${parsed.protocol}//${parsed.host}`;
  for (const blocked of blockedOrigins) {
    if (!blocked) continue;
    let blockedParsed;
    try {
      blockedParsed = new URL(blocked);
    } catch {
      continue;
    }
    if (`${blockedParsed.protocol}//${blockedParsed.host}` === targetOrigin) {
      throw new Error('http 执行器不能指向 Hub 自身（避免递归/越权）');
    }
  }
  const host = parsed.hostname;
  const isLocalOrLan =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host);
  if (!isLocalOrLan) {
    throw new Error(`http 执行器只允许本机或内网地址，收到：${host}`);
  }
}

function createHttpExecutor(options = {}) {
  const cfg = isPlainObject(options.executorCfg) ? options.executorCfg : {};
  const url = nonEmptyString(cfg.url) ? cfg.url : '';
  const blockedOrigins = Array.isArray(options.blockedOrigins) ? options.blockedOrigins : [];
  const defaultTimeoutMs = clampInt(cfg.timeoutMs, 1000, 3600000, 120000);
  const headers = isPlainObject(cfg.headers) ? cfg.headers : {};

  return {
    async run(ctx = {}) {
      if (!url) throw new Error('http 执行器缺少 url 配置（config.executor.http.url）');
      assertEndpointAllowed(url, blockedOrigins);
      const signal = ctx.signal || null;
      throwIfAborted(signal);
      const progress = typeof ctx.progress === 'function' ? ctx.progress : async () => {};
      const task = ctx.task || {};
      await progress('正在调用设备本地执行服务…', 15);
      const res = await requestJson(url, {
        method: 'POST',
        headers,
        timeoutMs: defaultTimeoutMs,
        signal,
        body: {
          taskId: task.id || null,
          instruction: task.instruction || '',
          requirements: task.requirements || {},
          timeoutSec: task.timeoutSec || null,
          device: {
            id: (ctx.device && ctx.device.id) || null,
            name: (ctx.device && ctx.device.name) || null,
          },
        },
      });

      if (res.status < 200 || res.status >= 300) {
        return {
          output: { text: truncate(res.text, 2000) },
          error: `http 执行器返回 HTTP ${res.status}`,
        };
      }
      const body = res.json;
      if (!body || typeof body !== 'object') {
        return { output: { text: truncate(res.text, 2000) } };
      }
      let output;
      if (typeof body.output === 'string') output = { text: body.output };
      else if (isPlainObject(body.output)) output = body.output;
      else if (nonEmptyString(body.text)) output = { text: body.text };
      else output = { text: truncate(res.text, 2000) };
      if (body.error) return { output, error: String(body.error) };
      return { output };
    },
  };
}

// ---------------------------------------------------------------------------
// ollama 执行器
// ---------------------------------------------------------------------------

function createOllamaExecutor(options = {}) {
  const cfg = isPlainObject(options.executorCfg) ? options.executorCfg : {};
  const env = options.env || process.env;
  const baseUrl = normalizeBaseUrl(cfg.baseUrl || env.OLLAMA_HOST || 'http://127.0.0.1:11434');
  const defaultTimeoutMs = clampInt(cfg.timeoutMs, 1000, 3600000, 180000);
  const maxOutputChars = clampInt(cfg.maxOutputChars, 200, 400000, 16000);
  const defaultPrompt = '你是家庭智能管家。请用中文完成下面的任务，给出清晰、可执行的结论：\n\n{instruction}';

  return {
    async run(ctx = {}) {
      const signal = ctx.signal || null;
      throwIfAborted(signal);
      const progress = typeof ctx.progress === 'function' ? ctx.progress : async () => {};
      const task = ctx.task || {};
      const capabilities = (ctx.device && ctx.device.capabilities) || {};
      const models = asArray(capabilities.models).filter((m) => m && m.available !== false);
      const requestedModel = (task.requirements && task.requirements.model) || '';
      let model = nonEmptyString(cfg.model) ? cfg.model : requestedModel;
      if (!model) {
        const ollamaModel = models.find((m) => m.provider === 'ollama');
        model = (ollamaModel || models[0] || {}).id || '';
      }
      if (!model) {
        throw new Error('未找到可用的 Ollama 模型：请确认 Ollama 已启动，或用 --config 指定 models / executor.ollama.model');
      }

      const instruction = String(task.instruction || '');
      const promptTemplate = nonEmptyString(cfg.prompt) ? cfg.prompt : defaultPrompt;
      const prompt = promptTemplate.split('{instruction}').join(instruction);

      await progress(`正在调用本地模型 ${model} 生成结果…`, 20);
      const res = await requestJson(joinUrl(baseUrl, '/api/generate'), {
        method: 'POST',
        timeoutMs: defaultTimeoutMs,
        signal,
        body: {
          model,
          prompt,
          stream: false,
          options: isPlainObject(cfg.options) ? cfg.options : undefined,
        },
      });

      if (res.status < 200 || res.status >= 300) {
        return {
          output: { text: truncate(res.text, 2000) },
          error: `Ollama /api/generate 返回 HTTP ${res.status}`,
        };
      }
      const body = res.json || {};
      const text = typeof body.response === 'string' ? body.response : '';
      if (!text) return { output: { text: '' }, error: 'Ollama 未返回结果（response 为空）' };
      await progress('本地模型生成完成', 95);
      return {
        output: {
          text: truncate(text, maxOutputChars),
          data: {
            executor: 'ollama',
            model,
            baseUrl,
            evalCount: body.eval_count || null,
            totalDurationMs: body.total_duration ? Math.round(body.total_duration / 1e6) : null,
          },
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// ComfyUI 执行器
// ---------------------------------------------------------------------------

function findComfyPromptNode(workflow, preferredId) {
  if (preferredId && workflow[preferredId] && isPlainObject(workflow[preferredId].inputs)) {
    return workflow[preferredId];
  }
  for (const node of Object.values(workflow)) {
    if (!isPlainObject(node) || !isPlainObject(node.inputs)) continue;
    const cls = String(node.class_type || '');
    if (/CLIPTextEncode|TextEncode/i.test(cls) && typeof node.inputs.text === 'string') return node;
  }
  return null;
}

function comfyClientId() {
  return `super-butler-${Math.random().toString(36).slice(2, 10)}`;
}

async function fetchBinary(url, { signal = null, timeoutMs = 60000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('download timeout')), timeoutMs);
  const onAbort = () => controller.abort(signal && signal.reason);
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      throw makeAbortError(signal);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}：${url}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function createComfyuiExecutor(options = {}) {
  const cfg = isPlainObject(options.executorCfg) ? options.executorCfg : {};
  const baseUrl = normalizeBaseUrl(nonEmptyString(cfg.baseUrl) ? cfg.baseUrl : 'http://127.0.0.1:8188');
  const workflowFile = nonEmptyString(cfg.workflowFile) ? cfg.workflowFile : '';
  const promptNodeId = cfg.promptNodeId != null ? String(cfg.promptNodeId) : '';
  const negativeNodeId = cfg.negativeNodeId != null ? String(cfg.negativeNodeId) : '';
  const negativePrompt = typeof cfg.negativePrompt === 'string' ? cfg.negativePrompt : 'blurry, low quality, watermark';
  const seedNodeId = cfg.seedNodeId != null ? String(cfg.seedNodeId) : '';
  const promptTemplate = nonEmptyString(cfg.promptTemplate) ? cfg.promptTemplate : '{instruction}';
  const outputDir = nonEmptyString(cfg.outputDir)
    ? cfg.outputDir
    : path.join(options.cwd || process.cwd(), 'comfyui-output');
  const timeoutMs = clampInt(cfg.timeoutMs, 5000, 3600000, 600000);
  const pollMs = clampInt(cfg.pollMs, 200, 30000, 1500);
  const maxImages = clampInt(cfg.maxImages, 1, 32, 8);
  const blockedOrigins = Array.isArray(options.blockedOrigins) ? options.blockedOrigins : [];
  const label = 'ComfyUI';

  return {
    async run(ctx = {}) {
      assertEndpointAllowed(baseUrl, blockedOrigins);
      if (!workflowFile) throw new Error('ComfyUI 执行器缺少 workflowFile（API 格式工作流 JSON）');
      const signal = ctx.signal || null;
      const progress = typeof ctx.progress === 'function' ? ctx.progress : async () => {};
      const task = ctx.task || {};
      const instruction = String(task.instruction || '').trim();
      if (!instruction) return { output: { text: '' }, error: '任务指令为空' };
      throwIfAborted(signal);

      await progress('已提交 ComfyUI 工作流，等待生成…', 10);
      const startedAt = Date.now();
      let workflow;
      try {
        workflow = JSON.parse(await readFileSafe(workflowFile));
      } catch (err) {
        return { output: { text: '' }, error: `读取 ComfyUI 工作流失败：${err.message}` };
      }
      if (!isPlainObject(workflow)) return { output: { text: '' }, error: 'ComfyUI 工作流必须是 API 格式 JSON 对象' };

      const promptNode = findComfyPromptNode(workflow, promptNodeId);
      if (!promptNode) {
        return {
          output: { text: '' },
          error: '未找到文本编码节点：请在工作流中设置 promptNodeId，或导出包含 CLIPTextEncode 的 API 格式工作流',
        };
      }
      const promptText = promptTemplate.split('{instruction}').join(instruction);
      promptNode.inputs = { ...(promptNode.inputs || {}), text: promptText };
      if (negativeNodeId && workflow[negativeNodeId] && isPlainObject(workflow[negativeNodeId].inputs)) {
        workflow[negativeNodeId].inputs.text = negativePrompt;
      }
      if (seedNodeId && workflow[seedNodeId] && isPlainObject(workflow[seedNodeId].inputs)) {
        workflow[seedNodeId].inputs.seed = cfg.fixedSeed ?? randomInt(1, 2 ** 31 - 1);
      }

      let submitted;
      try {
        submitted = await requestJson(joinUrl(baseUrl, '/prompt'), {
          method: 'POST',
          timeoutMs: 30000,
          signal,
          body: { prompt: workflow, client_id: comfyClientId() },
        });
      } catch (err) {
        return { output: { text: '' }, error: `提交 ComfyUI 工作流失败：${err.message}` };
      }
      if (submitted.status < 200 || submitted.status >= 300) {
        return {
          output: { text: truncate(submitted.text, 2000) },
          error: `ComfyUI /prompt 返回 HTTP ${submitted.status}`,
        };
      }
      const promptId = submitted.json && submitted.json.prompt_id;
      if (!promptId) return { output: { text: truncate(submitted.text, 2000) }, error: 'ComfyUI 未返回 prompt_id' };
      if (submitted.json.node_errors && Object.keys(submitted.json.node_errors).length) {
        return {
          output: { text: truncate(JSON.stringify(submitted.json.node_errors), 2000) },
          error: 'ComfyUI 工作流节点校验失败',
        };
      }

      const deadline = startedAt + timeoutMs;
      let entry = null;
      try {
        while (Date.now() < deadline) {
          throwIfAborted(signal);
          const res = await requestJson(joinUrl(baseUrl, `/history/${encodeURIComponent(promptId)}`), {
            timeoutMs: 15000,
            signal,
          });
          if (res.status >= 200 && res.status < 300 && res.json && res.json[promptId]) {
            entry = res.json[promptId];
            const status = entry.status || {};
            if (status.status_str === 'error') {
              return { output: { text: truncate(JSON.stringify(status), 2000) }, error: 'ComfyUI 生成失败' };
            }
            if (status.completed) break;
          }
          const elapsed = Math.round((Date.now() - startedAt) / 1000);
          await progress(`ComfyUI 生成中…（已等待 ${elapsed}s）`, Math.min(85, 15 + elapsed));
          await delay(pollMs, signal);
        }
      } catch (err) {
        if (err && err.name === 'AbortError') {
          try {
            await requestJson(joinUrl(baseUrl, '/interrupt'), { method: 'POST', timeoutMs: 5000, body: {} });
          } catch {
            /* ignore */
          }
          throw err;
        }
        return { output: { text: '' }, error: err.message };
      }
      if (!entry) return { output: { text: '' }, error: `ComfyUI 生成超时（${Math.round(timeoutMs / 1000)}s）` };

      const images = [];
      for (const out of Object.values(entry.outputs || {})) {
        if (!isPlainObject(out)) continue;
        for (const key of ['images', 'gifs', 'videos']) {
          for (const image of asArray(out[key]).slice(0, maxImages)) {
            if (image && image.filename) images.push(image);
          }
        }
      }
      if (!images.length) {
        return { output: { text: truncate(JSON.stringify(entry), 2000) }, error: 'ComfyUI 工作流完成但没有产出图片' };
      }

      await fsp.mkdir(outputDir, { recursive: true });
      const artifacts = [];
      for (const image of images.slice(0, maxImages)) {
        const query = new URLSearchParams({
          filename: image.filename,
          subfolder: image.subfolder || '',
          type: image.type || 'output',
        });
        const safeName = `${Date.now()}-${path.basename(image.filename).replace(/[^\w.\-]+/g, '_')}`;
        const dest = path.join(outputDir, safeName);
        try {
          const buffer = await fetchBinary(joinUrl(baseUrl, `/view?${query.toString()}`), {
            signal,
            timeoutMs: 60000,
          });
          await fsp.writeFile(dest, buffer);
          artifacts.push({ name: image.filename, path: dest, type: 'image', bytes: buffer.length });
        } catch (err) {
          return { output: { text: '' }, error: `下载 ComfyUI 图片失败：${err.message}` };
        }
      }

      const durationMs = Date.now() - startedAt;
      await progress('ComfyUI 生成完成', 96);
      return {
        output: {
          text: [
            `ComfyUI 生成完成，共 ${artifacts.length} 张图片。`,
            `prompt_id: ${promptId}`,
            `工作流：${workflowFile}`,
            ...artifacts.map((item) => `- ${item.name} → ${item.path}`),
          ].join('\n'),
          artifacts,
          data: {
            executor: 'comfyui',
            promptId,
            workflowFile,
            baseUrl,
            imageCount: artifacts.length,
            durationMs,
          },
        },
        durationMs,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Mika（Android 手机）执行器
// ---------------------------------------------------------------------------

function parseJsonOutput(text) {
  const lines = String(text || '').trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const value = JSON.parse(lines[i]);
      if (value && typeof value === 'object') return value;
    } catch {
      /* not JSON */
    }
  }
  return null;
}

function mikaErrorText(payload) {
  if (!payload) return '';
  if (payload.error && typeof payload.error === 'object') {
    const code = payload.error.code || 'mika_error';
    return `${code}: ${payload.error.message || 'Mika 返回错误'}`;
  }
  return '';
}

function extractMikaAnswer(task) {
  for (const key of ['answer', 'result', 'reply', 'output', 'summary', 'text', 'message']) {
    const value = task[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (isPlainObject(value) || Array.isArray(value)) {
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        /* ignore */
      }
    }
  }
  if (Array.isArray(task.progress) && task.progress.length) {
    const last = task.progress[task.progress.length - 1];
    if (typeof last === 'string') return last;
    if (last && typeof last.message === 'string') return last.message;
  }
  return '';
}

function extractMikaArtifacts(task) {
  const list = asArray(task.artifacts || task.attachments || task.files);
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (item.path || item.url) {
      out.push({
        name: String(item.name || path.basename(String(item.path || item.url)) || 'file'),
        path: item.path ? String(item.path) : '',
        url: item.url ? String(item.url) : '',
      });
    }
  }
  return out.slice(0, 20);
}

function createMikaExecutor(options = {}) {
  const cfg = isPlainObject(options.executorCfg) ? options.executorCfg : {};
  const command = nonEmptyString(cfg.command) ? cfg.command : 'mika';
  const commandArgs = asArray(cfg.commandArgs).map((x) => String(x)).filter(Boolean);
  const interpreter = nonEmptyString(cfg.interpreter) ? cfg.interpreter : '';
  const device = nonEmptyString(cfg.device) ? cfg.device : '';
  const url = nonEmptyString(cfg.url) ? cfg.url : '';
  const tokenFile = nonEmptyString(cfg.tokenFile) ? cfg.tokenFile : '';
  const adb = nonEmptyString(cfg.adb) ? cfg.adb : '';
  const workdir = nonEmptyString(cfg.workdir) ? cfg.workdir : options.cwd || process.cwd();
  const timeoutMs = clampInt(cfg.timeoutMs, 30000, 3600000, 15 * 60 * 1000);
  const waitSeconds = clampInt(cfg.waitSeconds, 1, 50, 45);
  const maxOutputChars = clampInt(cfg.maxOutputChars, 200, 400000, 40000);
  const extraEnv = isPlainObject(cfg.env) ? cfg.env : {};
  const envBase = options.env || process.env;
  const label = 'Mika';

  function executable() {
    if (interpreter) return { exe: interpreter, args: [command, ...commandArgs] };
    return { exe: command, args: commandArgs };
  }

  async function runCli(args, { timeout, signal }) {
    const { exe, args: prefix } = executable();
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'butler-mika-'));
    const outFile = path.join(dir, 'stdout.log');
    const errFile = path.join(dir, 'stderr.log');
    const outFd = fs.openSync(outFile, 'a');
    const errFd = fs.openSync(errFile, 'a');
    let child;
    try {
      child = spawn(exe, [...prefix, ...args], {
        cwd: workdir,
        env: { ...envBase, ...extraEnv },
        stdio: ['ignore', outFd, errFd],
        windowsHide: true,
      });
    } catch (err) {
      fs.closeSync(outFd);
      fs.closeSync(errFd);
      await removeDirSafe(dir);
      throw new Error(`启动 Mika CLI 失败：${err.message}`);
    }
    try {
      const { code } = await waitForChild(child, { timeoutMs: timeout, signal, label });
      const stdout = await readFileSafe(outFile);
      const stderr = await readFileSafe(errFile);
      return { code, payload: parseJsonOutput(stdout) || parseJsonOutput(stderr), stdout, stderr };
    } finally {
      fs.closeSync(outFd);
      fs.closeSync(errFd);
      await removeDirSafe(dir);
    }
  }

  function connectionArgs() {
    const args = [];
    if (device) args.push('--device', device);
    if (url) args.push('--url', url);
    if (tokenFile) args.push('--token-file', tokenFile);
    if (adb) args.push('--adb', adb);
    return args;
  }

  return {
    async run(ctx = {}) {
      const signal = ctx.signal || null;
      const progress = typeof ctx.progress === 'function' ? ctx.progress : async () => {};
      const task = ctx.task || {};
      const instruction = String(task.instruction || '').trim();
      if (!instruction) return { output: { text: '' }, error: '任务指令为空' };
      throwIfAborted(signal);
      if (url && !tokenFile) throw new Error('Mika Wi-Fi 模式需要 tokenFile');

      const startedAt = Date.now();
      const deadline = startedAt + timeoutMs;
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'butler-mika-goal-'));
      const goalFile = path.join(dir, 'goal.txt');
      await fsp.writeFile(goalFile, instruction, 'utf8');
      let taskId = '';
      let snapshot = null;
      try {
        await progress('正在通过 Mika 派发手机任务…', 8);
        const run = await runCli([...connectionArgs(), '--json', 'task', 'run', '--goal-file', goalFile], {
          timeout: 120000,
          signal,
        });
        const runError = mikaErrorText(run.payload);
        if (runError) return { output: { text: truncate(run.stdout || run.stderr, 2000) }, error: `Mika：${runError}` };
        if (!run.payload || !run.payload.task_id) {
          return { output: { text: truncate(run.stdout || run.stderr, 2000) }, error: 'Mika 未返回 task_id' };
        }
        taskId = String(run.payload.task_id);
        snapshot = run.payload;

        let waits = 0;
        while (true) {
          const status = snapshot && snapshot.status;
          if (status === 'done') break;
          if (status === 'failed' || status === 'cancelled') break;
          if (status === 'waiting_for_answer' || status === 'waiting_on_phone') {
            const question = snapshot.question || (snapshot.options ? JSON.stringify(snapshot.options) : '');
            return {
              output: {
                text: truncate(extractMikaAnswer(snapshot) || JSON.stringify(snapshot), maxOutputChars),
                data: { executor: 'mika', taskId, status },
              },
              error: status === 'waiting_for_answer'
                ? `Mika 任务需要回答（task_id=${taskId}）${question ? `：${question}` : ''}`
                : `Mika 任务需要在手机上操作（task_id=${taskId}）`,
            };
          }
          throwIfAborted(signal);
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          const budget = Math.max(1, Math.min(waitSeconds, Math.floor(remaining / 1000)));
          waits += 1;
          await progress(`Mika 执行中（第 ${waits} 次等待，状态 ${status || 'running'}）…`, Math.min(88, 15 + waits * 6));
          const waited = await runCli([...connectionArgs(), '--json', 'task', 'wait', taskId, '--timeout', String(budget)], {
            timeout: (budget + 10) * 1000,
            signal,
          });
          const waitError = mikaErrorText(waited.payload);
          if (waitError) return { output: { text: truncate(waited.stdout || waited.stderr, 2000) }, error: `Mika：${waitError}` };
          if (waited.payload && waited.payload.task_id) snapshot = waited.payload;
          if (!snapshot || !snapshot.status) {
            return { output: { text: truncate(waited.stdout || waited.stderr, 2000) }, error: 'Mika 返回的任务状态无效' };
          }
          if (snapshot.status === 'done' || snapshot.status === 'failed' || snapshot.status === 'cancelled') break;
        }

        const durationMs = Date.now() - startedAt;
        if (!snapshot) return { output: { text: '' }, error: 'Mika 未返回任务状态' };
        if (snapshot.status === 'done') {
          const answer = extractMikaAnswer(snapshot) || 'Mika 已完成任务（未返回文本结果）';
          const verified = snapshot.verified === true ? true : snapshot.verified === false ? false : null;
          await progress('Mika 手机任务完成', 96);
          return {
            output: {
              text: truncate(answer, maxOutputChars),
              artifacts: extractMikaArtifacts(snapshot),
              data: {
                executor: 'mika',
                taskId,
                status: snapshot.status,
                verified,
                durationMs,
                snapshot: truncate(JSON.stringify(snapshot), 8000),
              },
            },
            durationMs,
          };
        }
        if (snapshot.status === 'cancelled') {
          return { output: { text: truncate(extractMikaAnswer(snapshot), 2000) }, error: `Mika 任务已取消（task_id=${taskId}）` };
        }
        if (snapshot.status === 'failed') {
          return {
            output: { text: truncate(extractMikaAnswer(snapshot) || JSON.stringify(snapshot), 2000) },
            error: `Mika 任务失败（task_id=${taskId}）`,
          };
        }
        return {
          output: {
            text: truncate(extractMikaAnswer(snapshot) || JSON.stringify(snapshot), 2000),
            data: { executor: 'mika', taskId, status: snapshot.status },
          },
          error: `Mika 任务等待超时（task_id=${taskId}，仍在手机运行，可用 task status 继续查询）`,
        };
      } catch (err) {
        if (err && err.name === 'AbortError') {
          if (taskId) {
            try {
              await runCli([...connectionArgs(), '--json', 'task', 'cancel', taskId], { timeout: 15000, signal: null });
            } catch {
              /* best effort */
            }
          }
          throw err;
        }
        return { output: { text: '' }, error: `Mika 执行失败：${err.message}` };
      } finally {
        await removeDirSafe(dir);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

/**
 * 创建执行器实例。
 * @param {object} options
 * @param {object} [options.config] agent 配置（读取 config.executor）
 * @param {string} [options.type] 覆盖执行器类型
 * @param {string} [options.hubUrl] 用于禁止 http 执行器指向 Hub
 * @param {object} [options.env]
 * @param {string} [options.cwd]
 * @returns {{type:string, run:Function, availableTypes:string[]}}
 */
function createExecutor(options = {}) {
  const config = isPlainObject(options.config) ? options.config : {};
  const execCfg = isPlainObject(config.executor) ? config.executor : {};
  const type = nonEmptyString(options.type) ? options.type : nonEmptyString(execCfg.type) ? execCfg.type : 'simulate';
  const common = {
    config,
    env: options.env || process.env,
    cwd: options.cwd,
    hubUrl: options.hubUrl,
    log: options.log,
  };

  const implementations = {
    simulate: createSimulateExecutor({
      ...common,
      executorCfg: isPlainObject(execCfg.simulate) ? execCfg.simulate : execCfg,
    }),
    'dsh-cli': createCommandExecutor('dsh-cli', {
      ...common,
      executorCfg: isPlainObject(execCfg['dsh-cli']) ? execCfg['dsh-cli'] : execCfg,
    }),
    shell: createCommandExecutor('shell', {
      ...common,
      executorCfg: isPlainObject(execCfg.shell) ? execCfg.shell : execCfg,
    }),
    http: createHttpExecutor({
      ...common,
      executorCfg: isPlainObject(execCfg.http) ? execCfg.http : execCfg,
      blockedOrigins: [options.hubUrl].filter(Boolean),
    }),
    ollama: createOllamaExecutor({
      ...common,
      executorCfg: isPlainObject(execCfg.ollama) ? execCfg.ollama : execCfg,
    }),
    cli: createCliExecutor({
      ...common,
      executorCfg: isPlainObject(execCfg.cli) ? execCfg.cli : execCfg,
    }),
    comfyui: createComfyuiExecutor({
      ...common,
      executorCfg: isPlainObject(execCfg.comfyui) ? execCfg.comfyui : execCfg,
      blockedOrigins: [options.hubUrl].filter(Boolean),
    }),
    mika: createMikaExecutor({
      ...common,
      executorCfg: isPlainObject(execCfg.mika) ? execCfg.mika : execCfg,
    }),
  };

  const implementation = implementations[type];
  if (!implementation) {
    throw new Error(`未知执行器类型：${type}（可选：${Object.keys(implementations).join(' / ')}）`);
  }
  return {
    type,
    availableTypes: Object.keys(implementations),
    run: (ctx) => implementation.run(ctx),
  };
}

module.exports = {
  PROGRESS_MIN_INTERVAL_MS,
  DEFAULT_SIMULATE,
  SIMULATE_FLAVORS,
  ExecutorTimeoutError,
  createExecutor,
  createCliExecutor,
  createComfyuiExecutor,
  createMikaExecutor,
  makeProgressThrottle,
  assertEndpointAllowed,
  killProcessTree,
  quoteForShell,
  truncate,
};
