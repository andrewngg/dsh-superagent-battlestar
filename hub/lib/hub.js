'use strict';

/**
 * Hub 核心：设备注册表、在线检测、任务编排、事件流、持久化恢复。
 * 仅依赖 Node 内置模块与 shared/protocol.js（协议唯一实现）。
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const protocol = require('../../shared/protocol.js');
const { createHttpServer } = require('./http');
const { StateStore } = require('./store');
const { badRequest, notFound, conflict } = require('./errors');
const { createPlan } = require('./planner');
const { writeTaskRecord, writeTaskIndex } = require('./task-record');
const preflight = require('./preflight');
const {
  DEFAULT_SETTINGS,
  SUPPORTED_LANGUAGES,
  assertLanguage,
  assertMainDeviceId,
  assertTaskSoundEnabled,
  mergeSettings,
  readSettings,
  writeSettings,
} = require('./settings');
const {
  GOAL_STATUS_SET,
  MAX_CHECKS,
  MAX_GUIDANCE_ENTRIES,
  buildGoalCheckInstruction,
  computeNextCheckAt,
  computeSkipNextCheckAt,
  goalDisplayName,
  goalToJson,
  normalizeGoalRequest,
  normalizeGuidanceEntry,
  restoreGoal,
} = require('./goals');
const {
  BRAIN_ACTIONS,
  MAX_CONSULT_ANSWER,
  MAX_CONSULTATIONS,
  MAX_IDLE_SEC,
  MAX_NOTES,
  MAX_OWNER_REPLY_LENGTH,
  MIN_AUTO_CONFIDENCE,
  brainToJson,
  buildBrainPrompt,
  createBrainThinker,
  idleIntervalCapSec,
  normalizeBrainPatch,
  parseBrainReply,
  recordBrainDecision,
  restoreBrain,
} = require('./brain');
const {
  DEFAULT_SUMMARY_TIME,
  JOURNAL_KINDS,
  MAX_DAYS,
  MAX_ENTRIES,
  appendJournalEntry,
  buildDailySummaryPrompt,
  createJournalThinker,
  dayKey,
  entriesForDate,
  fallbackDailySummary,
  journalModelConfig,
  journalStatsForDay,
  journalToJson,
  localDateKey: journalDateKey,
  localTimeKey: journalTimeKey,
  normalizeJournalPatch,
  parseDailySummary,
  restoreJournal,
  systemTimeZone,
  validDateKey,
} = require('./journal');
const {
  DEFAULT_BRAINSTORM,
  MAX_MESSAGES: BRAINSTORM_MAX_MESSAGES,
  MAX_SESSIONS: BRAINSTORM_MAX_SESSIONS,
  MAX_TEXT: BRAINSTORM_MAX_TEXT,
  appendMessage: appendBrainstormMessage,
  brainstormModelConfig,
  brainstormToJson,
  buildBrainstormPrompt,
  createSession: newBrainstormSession,
  createBrainstormThinker,
  detectAutonomyGrant,
  findSession: findBrainstormSession,
  normalizeChatRequest: normalizeBrainstormChatRequest,
  restoreBrainstorm,
  selectBrainstormModel,
  sessionSummary: brainstormSessionSummary,
  splitBrainstormActionBlock,
} = require('./brainstorm');
const {
  attachmentMeta: brainstormAttachmentMeta,
  extractFilePaths,
  readAttachments: readBrainstormAttachments,
} = require('./file-reader');
const {
  MAX_SKILL_CHARS,
  MAX_SOUL_CHARS,
  mindToJson,
  normalizeMindPatch,
  restoreMind,
} = require('./soul');
const {
  DEFAULT_NOTIFY_STYLE,
  nextDueAt,
  normalizeReminderRequest,
  reminderDisplayName,
  reminderToJson,
  restoreReminder,
} = require('./reminders');
const util = require('./util');

const { LIMITS, TASK_STATUS } = protocol;
const ACTIVE_TASK_STATUSES = new Set([TASK_STATUS.ASSIGNED, TASK_STATUS.RUNNING, TASK_STATUS.WAITING]);
const TERMINAL_TASK_STATUSES = new Set([
  TASK_STATUS.COMPLETED,
  TASK_STATUS.FAILED,
  TASK_STATUS.CANCELLED,
  TASK_STATUS.TIMEOUT,
]);
const DEVICE_STATUSES = new Set(['idle', 'busy', 'degraded', 'offline']);

/** 设备昵称是用户在本机设置的用途标签，与设备自报的 name 分开保存（重报 manifest 不会覆盖）。 */
const MAX_DEVICE_NICKNAME_LENGTH = 40;

/** 设备展示名：用户昵称优先，其次设备自报名称，最后回退设备 id。 */
function deviceDisplayName(device) {
  if (!device) return '';
  return device.nickname || device.name || device.id || '';
}
const TASK_MESSAGES = {
  completed: '任务完成',
  failed: '任务失败',
  timeout: '任务超时',
  cancelled: '任务已取消',
};

/** 计划执行方式的中文标签，用于进度/任务记录展示。 */
function planExecutionLabel(execution) {
  const strategy = execution && execution.strategy;
  if (strategy === 'parallel') return '并行执行';
  if (strategy === 'sequential') return '按顺序执行';
  return '并行 + 顺序依赖';
}

/**
 * 是否为「模型输出格式问题」（可通过重试修复）：非法 JSON、空输出、没有结论。
 * 网络/鉴权/配置类错误不在此列，直接向上抛。
 */
function isBrainParseFailure(err) {
  const message = String((err && err.message) || err || '');
  return /不是合法 JSON|没有给出任何结论|返回为空|没有返回内容/.test(message);
}

function normalizeOutput(input) {
  if (!util.isPlainObject(input)) return null;
  const out = {};
  if (typeof input.text === 'string') out.text = input.text.slice(0, 20000);
  if (typeof input.markdown === 'string') out.markdown = input.markdown.slice(0, 50000);
  if (Array.isArray(input.artifacts)) {
    out.artifacts = input.artifacts
      .filter(util.isPlainObject)
      .slice(0, 20)
      .map((a) => ({
        name: util.str(a.name, 200),
        url: util.str(a.url, 500),
        path: util.str(a.path, 500),
      }));
  }
  if (input.data !== undefined) out.data = input.data;
  return Object.keys(out).length ? out : null;
}

/** 归一化 HH:mm（非法值回退到 fallback）。 */
function normalizeClockTime(value, fallback) {
  const text = util.str(value, 10).trim();
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text);
  if (!match) return fallback;
  return `${String(Number(match[1])).padStart(2, '0')}:${match[2]}`;
}

/** 本地时区（用于每日总结的日期键与说明）。 */
function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
  } catch {
    return 'local';
  }
}

/** 本地日期键 YYYY-MM-DD。 */
function localDateKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

class Hub {
  constructor(options = {}) {
    this.version = typeof options.version === 'string' ? options.version : '0.1.0';
    this.host = typeof options.host === 'string' ? options.host : '0.0.0.0';
    this.requestedPort = Number.isFinite(options.port) ? options.port : 7317;
    this.dataDir = path.resolve(
      typeof options.dataDir === 'string' ? options.dataDir : path.join(__dirname, '..', 'data'),
    );
    this.webDir = path.resolve(
      typeof options.webDir === 'string' ? options.webDir : path.join(__dirname, '..', 'web'),
    );

    this.ttlMs = util.clampInt(options.ttlMs, LIMITS.HEARTBEAT_TTL_MS, 50, 24 * 3600 * 1000);
    this.heartbeatIntervalMs = util.clampInt(
      options.heartbeatIntervalMs,
      LIMITS.HEARTBEAT_INTERVAL_MS,
      100,
      3600 * 1000,
    );
    this.ackTimeoutMs = util.clampInt(options.ackTimeoutMs, LIMITS.ASSIGN_ACK_TIMEOUT_MS, 20, 3600 * 1000);
    // 任务运行超时后，在 maxAttempts 内自动重新排队（无需人工点「重试」）。
    this.autoRetryOnTimeout = options.autoRetryOnTimeout !== false;
    // 设备在线但忙碌（正在跑别的任务）时，ack 可能长时间不到。此时不按 ack timeout 重派，
    // 而是重投同一个 command 并按指数退避等待，最多累计等待该上限（避免排队中的任务被无限重派）。
    this.ackWaitMaxMs = Math.max(this.ackTimeoutMs * 4, 10 * 60 * 1000);
    // 排队寿命：queued 超过该时长仍等不到设备就主动失败（0=永不失效），
    // 避免历史任务排一整天后和设备重启时的「假满载」互相放大。
    this.queuedTtlMs = util.clampInt(options.queuedTtlMs, 6 * 3600 * 1000, 0, 30 * 24 * 3600 * 1000);
    // 单次重派预算：设备上线/重启/空槽释放时，一次最多补派多少条排队任务（0=不限），
    // 防止历史积压任务在同一秒全部涌出占满所有工作机。
    this.redispatchBudget = util.clampInt(options.redispatchBudget, 2, 0, 50);
    // 队列健康：排队的任务超过该时长时，自主大脑本轮不再 create_task，先处理积压（0=关闭）。
    this.queueStuckMs = util.clampInt(options.queueStuckMs, 2 * 3600 * 1000, 0, 24 * 3600 * 1000);
    // 系统自重启：先通知设备代理重启，留出心跳/长轮询窗口后再重启 Hub 自身。
    this.restartDelayMs = util.clampInt(options.restartDelayMs, 12000, 0, 60000);
    this.restartHandler = typeof options.restartHandler === 'function' ? options.restartHandler : null;
    this.gracefulRestart = options.gracefulRestart === true;
    this._restarting = false;
    // 仅测试使用：把所有任务的实际执行超时固定为该毫秒数（协议允许的 timeoutSec 最小 30s）
    this.timeoutOverrideMs =
      Number.isFinite(options.timeoutOverrideMs) && options.timeoutOverrideMs > 0
        ? options.timeoutOverrideMs
        : null;
    this.sweepIntervalMs = util.clampInt(
      options.sweepIntervalMs,
      Math.max(50, Math.min(1000, Math.floor(this.ttlMs / 3))),
      20,
      60000,
    );
    this.planner = typeof options.planner === 'function' ? options.planner : createPlan;
    this.splitThresholdChars = util.clampInt(options.splitThresholdChars, 800, 100, 100000);
    this.splitTimeoutSec = util.clampInt(options.splitTimeoutSec, 900, 30, 86400);
    this.pingIntervalMs = util.clampInt(options.pingIntervalMs, 15000, 20, 3600 * 1000);
    this.persistDebounceMs = util.clampInt(options.persistDebounceMs, 150, 0, 60000);
    this.eventLimit = util.clampInt(options.eventLimit, 200, 20, 2000);
    this.taskEventLimit = util.clampInt(options.taskEventLimit, 100, 10, 500);
    this.silent = options.silent === true;
    this.maxCommandsPerDevice = 200;
    // 任务执行记录（Markdown）：默认写到 <dataDir>/task-records，便于 backtrace；
    // 真实入口 hub/server.js 会覆盖为仓库根目录的 task-records/（已 gitignore）。
    this.recordDir = path.resolve(
      typeof options.recordDir === 'string' && options.recordDir.trim()
        ? options.recordDir
        : path.join(this.dataDir, 'task-records'),
    );
    this.recordEnabled = options.recordEnabled !== false;
    // 本地文件预检（A 方案）：任务提到本机文件时，自动把任务固定到「本机」设备执行。
    // 设置 options.preflight = false 或环境变量 BUTLER_PREFLIGHT=0 可关闭。
    const preflightOptions = util.isPlainObject(options.preflight) ? options.preflight : {};
    this.preflightEnabled =
      options.preflight !== false &&
      preflightOptions.enabled !== false &&
      process.env.BUTLER_PREFLIGHT !== '0';
    this.preflightRoots = Array.isArray(preflightOptions.roots)
      ? preflightOptions.roots.filter((root) => typeof root === 'string' && root.trim())
      : null;
    this.preflightMaxDepth = util.clampInt(preflightOptions.maxDepth, 3, 1, 8);
    this.preflightTimeoutMs = util.clampInt(preflightOptions.timeoutMs, 250, 10, 5000);
    this.preflightMaxMatches = util.clampInt(preflightOptions.maxMatches, 3, 1, 10);
    this.localDeviceId =
      util.str(options.localDeviceId, 80) || util.str(process.env.BUTLER_LOCAL_DEVICE_ID, 80) || null;
    this._preflightCache = new Map();
    this._recordTimers = new Map();
    this._recordIndexTimer = null;
    this._recordWarned = false;
    // 系统设置（系统默认语言 / 派发主设备）；持久化到 <dataDir>/settings.json。
    this.settings = mergeSettings(DEFAULT_SETTINGS, options.settings || {});
    // 项目亲和：project → 最近一次成功执行该项目的设备 id（随 state.json 持久化）。
    this.projectAffinity = new Map();
    // 项目别名标签：project → 该项目在任务要求里出现过的标签（随 state.json 持久化）。
    // 用途：设备做过某个项目后，自动获得该项目名与别名标签，避免大脑写的项目标签无人声明而永久排队。
    this.projectTags = new Map();
    // 长期目标：按计划自动创建跟进任务，goalTickMs 为调度扫描间隔。
    this.goalTickMs = util.clampInt(options.goalTickMs, 30000, 1000, 3600 * 1000);
    this.goals = new Map();
    this._goalTimer = null;
    // 提醒：数据存 Hub，到点通知由 APK 原生 AlarmManager 负责，Hub 不做轮询调度。
    this.reminders = new Map();
    // 每晚总结：每天 nightlyReviewTime 自动创建一次「每日总结」任务，复盘目标/任务进度并规划次日方向。
    this.nightlyReviewEnabled =
      options.nightlyReview !== false && String(process.env.BUTLER_NIGHTLY_REVIEW || '') !== '0';
    this.nightlyReviewTime = normalizeClockTime(
      util.str(options.nightlyReviewTime, 10) || process.env.BUTLER_NIGHTLY_REVIEW_TIME,
      '22:00',
    );
    this.nightlyReview = {
      date: null,
      taskId: null,
      status: null,
      startedAt: null,
      finishedAt: null,
      summary: '',
      error: null,
      lastSkipReason: '',
    };

    // 自主大脑：定时扫描目标/任务/设备状态，让模型决策并执行白名单动作。
    // 默认启用（用户想要的「会自己思考的大管家」），可在控制台切换为 suggest 或暂停。
    this.brainTickMs = util.clampInt(options.brainTickMs, 30000, 5000, 600000);
    this.brain = restoreBrain(options.brain);
    this._brainTimer = null;
    this._brainThinking = null;
    this._brainThinkInjected = typeof options.brainThink === 'function';
    this.brainThink = this._brainThinkInjected ? options.brainThink : null;
    this._brainThinker = this.brainThink;
    this._brainThinkerModel = this._brainThinkInjected ? '*' : null;

    // 管家心路：把思考与工作按天记成时间线，并在每日固定时间生成「实质推进」总结。
    this.journal = restoreJournal(options.journal);
    this._journalThinking = null;
    this._journalThinkInjected = typeof options.journalThink === 'function';
    this.journalThink = this._journalThinkInjected ? options.journalThink : null;
    this._journalThinker = this.journalThink;
    this._journalThinkerModel = this._journalThinkInjected ? '*' : null;

    // 头脑风暴：与大脑多轮对话，可把结论一键转成任务。
    this.brainstorm = restoreBrainstorm(options.brainstorm);
    this._brainstormThinkInjected = typeof options.brainstormThink === 'function';
    this.brainstormThink = this._brainstormThinkInjected ? options.brainstormThink : null;
    this._brainstormThinker = this.brainstormThink;
    this._brainstormThinkerModel = this._brainstormThinkInjected ? '*' : null;

    // 心智：灵魂（个性/价值观）与工作流程（Skill），每轮思考注入提示词。
    this.mind = restoreMind(options.mind);

    this.adminToken =
      util.str(options.adminToken, 300) || util.str(process.env.BUTLER_ADMIN_TOKEN, 300) || null;
    this.joinCode = util.str(options.joinCode, 100) || util.str(process.env.BUTLER_JOIN_CODE, 100) || null;

    this.devices = new Map();
    this.tasks = new Map();
    this.events = [];
    this.sseClients = new Set();
    this._timers = new Map(); // taskId -> { ack?: Timeout, timeout?: Timeout }
    this._sockets = new Set();
    this._initialized = false;
    this._closed = false;
    this.bootedAt = Date.now();
    this.server = null;
    this.port = null;
    this.url = null;

    this.store = new StateStore(path.join(this.dataDir, 'state.json'), () => this.serializeState(), {
      debounceMs: this.persistDebounceMs,
      onError: (err) => this.log('warn', `状态持久化失败：${err && err.message ? err.message : err}`),
    });

    this._sweepTimer = null;
    this._pingTimer = null;
  }

  // ---------------------------------------------------------------- 生命周期

  async init() {
    if (this._initialized) return this;
    this._initialized = true;

    const saved = await this.store.load();
    const savedObj = saved || {};

    if (!this.adminToken) {
      this.adminToken =
        typeof savedObj.adminToken === 'string' && savedObj.adminToken
          ? savedObj.adminToken
          : util.generateToken('adm');
    }
    if (!this.joinCode) {
      this.joinCode =
        typeof savedObj.joinCode === 'string' && savedObj.joinCode
          ? savedObj.joinCode
          : util.generateToken('join');
    }

    // 长期目标先于任务恢复：任务恢复时 _finishTask 可能回写目标检查结果。
    for (const raw of util.arr(savedObj.goals)) {
      const goal = restoreGoal(raw);
      if (goal) this.goals.set(goal.id, goal);
    }
    // 自主大脑状态：持久化过则以存档为准（包括用户暂停/模式/间隔）。
    if (savedObj.brain) this.brain = restoreBrain(savedObj.brain);
    // 提醒只做容错恢复；到点通知由 APK 负责，Hub 启动时不补发、不轮询。
    for (const raw of util.arr(savedObj.reminders)) {
      const reminder = restoreReminder(raw);
      if (reminder) this.reminders.set(reminder.id, reminder);
    }
    this.nightlyReview = this._restoreNightlyReview(savedObj.nightlyReview);
    for (const raw of util.arr(savedObj.devices)) {
      const device = this._restoreDevice(raw);
      if (device) this.devices.set(device.id, device);
    }
    // 项目亲和（项目 → 上次成功设备）：恢复后仍优先回到该项目熟悉的主机。
    const savedAffinity = util.isPlainObject(savedObj.routing) ? savedObj.routing.projectAffinity : null;
    if (util.isPlainObject(savedAffinity)) {
      for (const [project, deviceId] of Object.entries(savedAffinity)) {
        const key = util.str(project, 120);
        const id = util.str(deviceId, 80);
        if (key && id) this.projectAffinity.set(key, id);
      }
    }
    // 项目别名标签（project → tags）：恢复后设备仍能凭项目历史自动匹配这些标签。
    const savedProjectTags = util.isPlainObject(savedObj.routing) ? savedObj.routing.projectTags : null;
    if (util.isPlainObject(savedProjectTags)) {
      for (const [project, tags] of Object.entries(savedProjectTags)) {
        this._learnProjectTags(project, tags);
      }
    }
    for (const raw of util.arr(savedObj.tasks)) {
      const task = this._restoreTask(raw);
      if (task) this.tasks.set(task.id, task);
    }
    // 旧任务里已经写过的项目标签（如「反腐AI」）补学成项目别名，升级后不再丢标签语义。
    for (const task of this.tasks.values()) {
      const project = this._taskProject(task);
      if (project && util.arr(task.requirements && task.requirements.tags).length) {
        this._learnProjectTags(project, task.requirements.tags);
      }
    }
    this.events = util.arr(savedObj.events).slice(-this.eventLimit);

    // 管家心路：恢复日志；首次运行时用已有任务/大脑决策回填当天记录（只回填一次）。
    if (savedObj.journal) this.journal = restoreJournal(savedObj.journal);
    this._seedJournalFromHistory();

    // 头脑风暴：恢复对话历史。
    if (savedObj.brainstorm) this.brainstorm = restoreBrainstorm(savedObj.brainstorm);

    // 心智：恢复灵魂与工作流程（缺失时用默认内容）。
    if (savedObj.mind) this.mind = restoreMind(savedObj.mind);

    // 系统设置：优先读取持久化文件；文件不存在时写入默认值（默认中文）。
    const storedSettings = readSettings(this.dataDir);
    this.settings = mergeSettings(this.settings, storedSettings || {});
    if (!storedSettings) {
      try {
        writeSettings(this.dataDir, this.settings);
      } catch {
        /* 设置写入失败不阻塞启动 */
      }
    }

    // 重启语义：设备一律离线；assigned 重排（attempts 未超限），running 记 failed。
    // 例外：自重启（gracefulRestart）时运行中的任务自动重新排队，不占用重试次数，
    // 设备代理也在同一轮重启，避免“改个代码就把正在跑的长任务全丢掉”。
    for (const task of [...this.tasks.values()]) {
      if (task.status === TASK_STATUS.ASSIGNED) {
        if (task.attempts < task.maxAttempts) {
          task.status = TASK_STATUS.QUEUED;
          task.assignedDeviceId = null;
          task.assignedDeviceName = null;
          task.updatedAt = protocol.nowIso();
          task.route = { reason: 'hub restarted; waiting for redispatch', candidates: [], excluded: [] };
          this._pushTaskEvent(task, 'requeued', 'Hub 重启，任务重新排队');
          this.broadcast('task.updated', { task: this.taskToJson(task) });
        } else {
          this._finishTask(task, TASK_STATUS.FAILED, {
            error: 'hub restarted',
            eventMessage: 'Hub 重启，任务失败',
          });
        }
      } else if (task.status === TASK_STATUS.RUNNING || task.status === TASK_STATUS.WAITING) {
        if (this.gracefulRestart && !task.isPlan) {
          if (task.attempts > 0) task.attempts -= 1; // 自重启不算一次执行尝试
          task.status = TASK_STATUS.QUEUED;
          task.assignedDeviceId = null;
          task.assignedDeviceName = null;
          task.startedAt = null;
          task.finishedAt = null;
          task.output = null;
          task.error = null;
          task.updatedAt = protocol.nowIso();
          task.route = { reason: 'hub self-restart; waiting for redispatch', candidates: [], excluded: [] };
          this._pushTaskEvent(task, 'requeued', 'Hub 自重启，任务自动重新排队');
          this.broadcast('task.updated', { task: this.taskToJson(task) });
        } else if (task.isPlan) {
          // 规划父任务没有设备指令，保持 running 等待子任务收尾（_reconcileParent 会重算结果）。
          task.updatedAt = protocol.nowIso();
        } else {
          this._finishTask(task, TASK_STATUS.FAILED, {
            error: 'hub restarted',
            eventMessage: 'Hub 重启，运行中的任务失败',
          });
        }
      }
    }

    // 目标恢复：清理已不存在的运行中检查任务，并补齐下一次跟进时间。
    this._reconcileGoalsAfterRestore();

    this._sweepTimer = setInterval(() => this.sweepOffline(), this.sweepIntervalMs);
    if (this._sweepTimer.unref) this._sweepTimer.unref();
    this._pingTimer = setInterval(() => this._pingClients(), this.pingIntervalMs);
    if (this._pingTimer.unref) this._pingTimer.unref();
    this._goalTimer = setInterval(() => {
      this.runDueGoalChecks();
      this.runNightlyReview();
      this.runJournalCycle();
    }, this.goalTickMs);
    if (this._goalTimer.unref) this._goalTimer.unref();
    // 自主大脑定时器：到点才真正思考，思考失败只记录 lastError，不影响 Hub。
    this._brainTimer = setInterval(() => {
      this.runBrainCycle();
    }, this.brainTickMs);
    if (this._brainTimer.unref) this._brainTimer.unref();

    // 兼容旧数据：历史规划子任务可能只有 60/90/180s 的超时，按新规则抬高（终态任务保持原样）。
    for (const task of this.tasks.values()) {
      const floor = this._planSubtaskTimeoutFloor(task);
      if (!floor || TERMINAL_TASK_STATUSES.has(task.status) || task.timeoutSec >= floor) continue;
      task.timeoutSec = floor;
      task.updatedAt = protocol.nowIso();
      this._pushTaskEvent(task, 'progress', `子任务超时兜底到 ${floor}s`);
    }

    this.reconcilePlans();
    this.schedulePersist();
    // 启动只恢复「运行中→排队」，不主动把历史 queued 一次性重派：等设备上线/空槽时按预算补派。
    this.retryQueuedTasks('startup', 0);
    // 启动时补写/刷新全部任务的执行记录（历史任务也能 backtrace）。
    for (const task of this.tasks.values()) this._scheduleTaskRecord(task.id, 30);
    this._scheduleRecordIndex(120);
    return this;
  }

  async listen() {
    if (this.server) return this;
    this.server = createHttpServer(this);
    this.server.on('connection', (socket) => {
      this._sockets.add(socket);
      socket.on('close', () => this._sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        this.server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        this.server.removeListener('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.requestedPort, this.host);
    });
    const addr = this.server.address();
    this.port = addr && typeof addr === 'object' ? addr.port : this.requestedPort;
    const localHost = this.host === '0.0.0.0' || this.host === '::' || this.host === '' ? '127.0.0.1' : this.host;
    this.url = `http://${localHost}:${this.port}`;
    return this;
  }

  get lanUrl() {
    const ip = util.lanIPv4();
    return `http://${ip}:${this.port || this.requestedPort}`;
  }

  get uptimeSec() {
    return Math.max(0, Math.floor((Date.now() - this.bootedAt) / 1000));
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    if (this._sweepTimer) clearInterval(this._sweepTimer);
    if (this._pingTimer) clearInterval(this._pingTimer);
    if (this._goalTimer) clearInterval(this._goalTimer);
    if (this._brainTimer) clearInterval(this._brainTimer);
    this._sweepTimer = null;
    this._pingTimer = null;
    this._goalTimer = null;
    this._brainTimer = null;

    for (const timers of this._timers.values()) {
      if (timers.ack) clearTimeout(timers.ack);
      if (timers.timeout) clearTimeout(timers.timeout);
    }
    this._timers.clear();

    for (const client of this.sseClients) {
      try {
        if (!client.res.writableEnded) client.res.end();
      } catch {
        /* 忽略 */
      }
    }
    this.sseClients.clear();

    // 落盘所有待写的任务执行记录（Markdown），保证正常关闭/自重启前记录不丢。
    this.flushTaskRecords();

    for (const device of this.devices.values()) {
      for (const waiter of device.waiters.splice(0)) {
        try {
          waiter.settle([]);
        } catch {
          /* 忽略 */
        }
      }
    }

    try {
      await this.store.close();
    } catch {
      /* 忽略持久化失败 */
    }

    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        server.close(done);
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        for (const socket of this._sockets) {
          try {
            socket.destroy();
          } catch {
            /* 忽略 */
          }
        }
        this._sockets.clear();
        const timer = setTimeout(done, 2000);
        if (timer.unref) timer.unref();
      });
    }
  }

  // ---------------------------------------------------------------- 序列化 / 恢复

  serializeState() {
    return {
      version: protocol.PROTOCOL_VERSION,
      hubVersion: this.version,
      savedAt: protocol.nowIso(),
      adminToken: this.adminToken,
      joinCode: this.joinCode,
      devices: [...this.devices.values()].map((device) => ({
        id: device.id,
        deviceToken: device.deviceToken,
        name: device.name,
        nickname: device.nickname || '',
        platform: device.platform,
        kind: device.kind,
        agentVersion: device.agentVersion,
        endpoint: device.endpoint,
        tags: [...device.tags],
        capabilities: device.capabilities,
        disabled: device.disabled,
        registeredAt: device.registeredAt,
        lastSeenAt: device.lastSeenAt,
      })),
      tasks: [...this.tasks.values()].map((task) => ({
        ...this.taskToJson(task),
        attachments: (task.attachments || []).map((file) => ({ ...file })),
      })),
      // 派发亲和：项目 → 最近一次成功执行该项目的设备，重启后继续沿用。
      routing: {
        projectAffinity: Object.fromEntries(this.projectAffinity),
        projectTags: Object.fromEntries([...this.projectTags].map(([project, tags]) => [project, [...tags]])),
        mainDeviceId: this.settings.mainDeviceId || '',
      },
      goals: [...this.goals.values()].map((goal) => goalToJson(goal)),
      brain: this._brainStateForPersist(),
      journal: this._journalStateForPersist(),
      brainstorm: this._brainstormStateForPersist(),
      mind: {
        soul: this.mind.soul,
        skill: this.mind.skill,
        updatedAt: this.mind.updatedAt || null,
      },
      reminders: [...this.reminders.values()].map((reminder) => reminderToJson(reminder)),
      nightlyReview: { ...this.nightlyReview },
      events: this.events.slice(-this.eventLimit),
    };
  }

  _restoreDevice(raw) {
    if (!util.isPlainObject(raw)) return null;
    const id = util.str(raw.id, 80);
    if (!id) return null;
    const cap = util.isPlainObject(raw.capabilities) ? raw.capabilities : {};
    const limits = util.isPlainObject(cap.limits) ? cap.limits : {};
    const maxConcurrentTasks = util.clampInt(
      limits.maxConcurrentTasks,
      LIMITS.DEFAULT_CONCURRENT_TASKS,
      1,
      LIMITS.MAX_CONCURRENT_TASKS,
    );
    return {
      id,
      deviceToken: util.str(raw.deviceToken, 300),
      name: util.str(raw.name, LIMITS.MAX_NAME_LENGTH) || id,
      nickname: util.str(raw.nickname, MAX_DEVICE_NICKNAME_LENGTH),
      platform: util.str(raw.platform, 20) || 'other',
      kind: util.str(raw.kind, 30) || 'custom',
      agentVersion: util.str(raw.agentVersion, 40),
      endpoint: util.str(raw.endpoint, 300),
      tags: util.arr(raw.tags).map((t) => util.str(t, 40)).filter(Boolean),
      capabilities: {
        models: util.arr(cap.models),
        profiles: util.arr(cap.profiles),
        gateways: util.arr(cap.gateways),
        skills: util.arr(cap.skills),
        resources: util.isPlainObject(cap.resources) ? cap.resources : {},
        limits: { maxConcurrentTasks },
      },
      disabled: raw.disabled === true,
      online: false,
      status: 'offline',
      registeredAt: util.str(raw.registeredAt, 40) || protocol.nowIso(),
      lastSeenAt: util.str(raw.lastSeenAt, 40) || null,
      load: { running: 0, max: maxConcurrentTasks },
      reportedRunning: 0,
      metrics: {},
      commands: [],
      waiters: [],
    };
  }

  _restoreTask(raw) {
    if (!util.isPlainObject(raw)) return null;
    const id = util.str(raw.id, 80);
    if (!id) return null;
    const status = Object.values(TASK_STATUS).includes(raw.status) ? raw.status : TASK_STATUS.QUEUED;
    const createdAt = util.str(raw.createdAt, 40) || protocol.nowIso();
    const route = util.isPlainObject(raw.route)
      ? {
          reason: util.str(raw.route.reason, 500),
          candidates: util.arr(raw.route.candidates),
          excluded: util.arr(raw.route.excluded),
        }
      : { reason: '', candidates: [], excluded: [] };
    return {
      id,
      instruction: util.str(raw.instruction, LIMITS.MAX_INSTRUCTION_LENGTH),
      requirements: protocol.normalizeRequirements(raw.requirements),
      priority: util.clampInt(raw.priority, 5, 0, 9),
      status,
      assignedDeviceId: util.str(raw.assignedDeviceId, 80) || null,
      assignedDeviceName: util.str(raw.assignedDeviceName, LIMITS.MAX_NAME_LENGTH) || null,
      createdAt,
      updatedAt: util.str(raw.updatedAt, 40) || createdAt,
      startedAt: util.str(raw.startedAt, 40) || null,
      finishedAt: util.str(raw.finishedAt, 40) || null,
      attempts: util.clampInt(raw.attempts, 0, 0, 10),
      maxAttempts: util.clampInt(raw.maxAttempts, LIMITS.DEFAULT_TASK_ATTEMPTS, 1, LIMITS.MAX_TASK_ATTEMPTS),
      timeoutSec: util.clampInt(
        raw.timeoutSec,
        LIMITS.DEFAULT_TASK_TIMEOUT_SEC,
        LIMITS.MIN_TASK_TIMEOUT_SEC,
        LIMITS.MAX_TASK_TIMEOUT_SEC,
      ),
      output: raw.output === undefined ? null : raw.output,
      error: typeof raw.error === 'string' ? raw.error : null,
      autoRetry: raw.autoRetry !== false,
      progress: util.isPlainObject(raw.progress) ? raw.progress : null,
      route,
      events: util
        .arr(raw.events)
        .filter((e) => util.isPlainObject(e))
        .slice(-this.taskEventLimit),
      parentTaskId: util.str(raw.parentTaskId, 80) || null,
      childTaskIds: util.arr(raw.childTaskIds).map((id) => util.str(id, 80)).filter(Boolean),
      threadId: util.str(raw.threadId, 80) || id,
      replyToTaskId: util.str(raw.replyToTaskId, 80) || null,
      threadStep: util.clampInt(raw.threadStep, 1, 1, 10000),
      context: util.isPlainObject(raw.context) ? raw.context : null,
      goalId: util.str(raw.goalId, 80) || null,
      attachments: util.arr(raw.attachments).filter((file) => util.isPlainObject(file) && file.name && file.data),
      isPlan: raw.isPlan === true,
      archived: raw.archived === true,
      archivedAt: util.str(raw.archivedAt, 40) || null,
      trashedAt: util.str(raw.trashedAt, 40) || null,
      // 长任务拆分计划：步骤序号 / 并行组 / 依赖（持久化后重启仍按依赖顺序执行）。
      planStep: Number.isFinite(Number(raw.planStep)) && Number(raw.planStep) > 0 ? Math.trunc(Number(raw.planStep)) : null,
      planGroup: util.str(raw.planGroup, 60) || null,
      planDependsOn: util
        .arr(raw.planDependsOn)
        .map((n) => Math.trunc(Number(n)))
        .filter((n) => Number.isInteger(n) && n >= 0)
        .slice(0, 20),
      planDependsOnTaskIds: util
        .arr(raw.planDependsOnTaskIds)
        .map((value) => util.str(value, 80))
        .filter(Boolean)
        .slice(0, 20),
      plan: util.isPlainObject(raw.plan)
        ? {
            strategy: ['parallel', 'sequential', 'mixed'].includes(raw.plan.strategy) ? raw.plan.strategy : 'mixed',
            blockerPolicy: raw.plan.blockerPolicy === 'continue' ? 'continue' : 'stop-and-ask',
            groups: util
              .arr(raw.plan.groups)
              .filter((group) => util.isPlainObject(group))
              .slice(0, 6)
              .map((group) => ({
                name: util.str(group.name, 40) || '并行组',
                mode: group.mode === 'sequential' ? 'sequential' : 'parallel',
                subtaskIndexes: util
                  .arr(group.subtaskIndexes)
                  .map((n) => Math.trunc(Number(n)))
                  .filter((n) => Number.isInteger(n) && n >= 0)
                  .slice(0, 12),
              })),
          }
        : null,
      routingAdvice: this.normalizeRoutingAdvice(raw.routingAdvice),
      affinity:
        util.isPlainObject(raw.affinity) && util.str(raw.affinity.deviceId, 80)
          ? {
              deviceId: util.str(raw.affinity.deviceId, 80),
              reason: util.str(raw.affinity.reason, 200) || '',
              at: util.str(raw.affinity.at, 40) || null,
            }
          : null,
      consult:
        util.isPlainObject(raw.consult) && util.str(raw.consult.question, 600)
          ? {
              question: util.str(raw.consult.question, 600),
              deviceId: util.str(raw.consult.deviceId, 80) || null,
              project: util.str(raw.consult.project, 120) || null,
            }
          : null,
      _avoidDeviceIds: [],
    };
  }

  // ---------------------------------------------------------------- 视图

  deviceToJson(device) {
    return {
      id: device.id,
      name: device.name,
      nickname: device.nickname || '',
      platform: device.platform,
      kind: device.kind,
      agentVersion: device.agentVersion,
      endpoint: device.endpoint,
      tags: [...device.tags],
      // 自动标签：由设备成功执行过的项目（项目名 + 项目别名标签）推导，只用于能力匹配，不改 manifest。
      autoTags: this._autoTagsForDevice(device.id),
      online: device.online,
      status: device.status,
      registeredAt: device.registeredAt,
      lastSeenAt: device.lastSeenAt,
      disabled: device.disabled,
      load: { running: device.load.running, max: device.load.max },
      metrics: { ...device.metrics },
      capabilities: device.capabilities,
    };
  }

  taskToJson(task) {
    return {
      id: task.id,
      instruction: task.instruction,
      requirements: { ...task.requirements, skills: [...task.requirements.skills], tags: [...task.requirements.tags] },
      priority: task.priority,
      status: task.status,
      assignedDeviceId: task.assignedDeviceId,
      assignedDeviceName: task.assignedDeviceName,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      attempts: task.attempts,
      maxAttempts: task.maxAttempts,
      timeoutSec: task.timeoutSec,
      output: task.output,
      error: task.error,
      autoRetry: task.autoRetry !== false,
      progress: task.progress ? { ...task.progress } : null,
      parentTaskId: task.parentTaskId || null,
      childTaskIds: [...(task.childTaskIds || [])],
      threadId: task.threadId || task.id,
      replyToTaskId: task.replyToTaskId || null,
      threadStep: Number.isFinite(task.threadStep) ? task.threadStep : 1,
      context: task.context ? { ...task.context } : null,
      attachments: (task.attachments || []).map((file) => ({
        id: file.id,
        name: file.name,
        mime: file.mime,
        size: file.size,
      })),
      isPlan: Boolean(task.isPlan),
      planStep: task.planStep || null,
      planGroup: task.planGroup || null,
      planDependsOn: [...(task.planDependsOn || [])],
      planDependsOnTaskIds: [...(task.planDependsOnTaskIds || [])],
      plan: task.plan ? JSON.parse(JSON.stringify(task.plan)) : null,
      goalId: task.goalId || null,
      archived: Boolean(task.archived),
      archivedAt: task.archivedAt || null,
      trashed: Boolean(task.trashedAt),
      trashedAt: task.trashedAt || null,
      routingAdvice: task.routingAdvice ? JSON.parse(JSON.stringify(task.routingAdvice)) : null,
      // 派发亲和：首次派发到哪台主机，后续重试继续粘在同一台（避免丢失项目上下文）。
      affinity: task.affinity ? { ...task.affinity } : null,
      consult: task.consult ? { ...task.consult } : null,
      route: {
        reason: task.route.reason,
        candidates: task.route.candidates.map((c) => ({ ...c })),
        excluded: task.route.excluded.map((e) => ({ ...e })),
      },
      events: task.events.map((e) => ({ ...e })),
    };
  }

  stats() {
    let devicesOnline = 0;
    for (const device of this.devices.values()) if (device.online && !device.disabled) devicesOnline += 1;
    let tasksQueued = 0;
    let tasksAssigned = 0;
    let tasksRunning = 0;
    let tasksWaiting = 0;
    let tasksCompleted = 0;
    let tasksFailed = 0;
    for (const task of this.tasks.values()) {
      if (task.archived || task.trashedAt) continue;
      if (task.status === TASK_STATUS.QUEUED) tasksQueued += 1;
      else if (task.status === TASK_STATUS.ASSIGNED) tasksAssigned += 1;
      else if (task.status === TASK_STATUS.RUNNING) tasksRunning += 1;
      else if (task.status === TASK_STATUS.WAITING) tasksWaiting += 1;
      else if (task.status === TASK_STATUS.COMPLETED) tasksCompleted += 1;
      else if (task.status === TASK_STATUS.FAILED || task.status === TASK_STATUS.TIMEOUT) tasksFailed += 1;
    }
    return {
      devicesTotal: this.devices.size,
      devicesOnline,
      tasksQueued,
      tasksAssigned,
      tasksRunning,
      tasksWaiting,
      tasksCompleted,
      tasksFailed,
    };
  }

  snapshot(limit = 50) {
    this.reconcilePlans();
    const safeLimit = util.clampInt(limit, 50, 1, 200);
    const devices = [...this.devices.values()].map((device) => this.deviceToJson(device));
    const tasks = [...this.tasks.values()]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, safeLimit)
      .map((task) => this.taskToJson(task));
    return {
      server: { version: this.version, uptimeSec: this.uptimeSec, hubTime: protocol.nowIso() },
      settings: this.getSettings(),
      stats: this.stats(),
      devices,
      tasks,
      goals: this.listGoals(),
      brain: this.getBrain(),
      reminders: this.listReminders(),
      nightlyReview: this.getNightlyReview(),
      events: this.events.slice(-safeLimit).map((event) => ({ ...event })),
    };
  }

  // ---------------------------------------------------------------- 系统设置

  getSettings() {
    return { ...this.settings };
  }

  /**
   * 更新系统设置（language / mainDeviceId / taskSoundEnabled）。
   * @param {{language?: string, mainDeviceId?: string, taskSoundEnabled?: boolean}} patch
   * @returns {{language:string, mainDeviceId:string, taskSoundEnabled:boolean}}
   */
  updateSettings(patch = {}) {
    const input = util.isPlainObject(patch) ? patch : {};
    const next = { ...this.settings };
    if (input.language !== undefined) {
      try {
        next.language = assertLanguage(input.language);
      } catch (err) {
        throw badRequest(err.message);
      }
    }
    if (input.mainDeviceId !== undefined) {
      try {
        next.mainDeviceId = assertMainDeviceId(input.mainDeviceId);
      } catch (err) {
        throw badRequest(err.message);
      }
      // 指定的主设备必须已注册（空字符串表示自动使用本机）。
      if (next.mainDeviceId && !this.devices.has(next.mainDeviceId)) {
        throw badRequest(`主设备不存在：${next.mainDeviceId}`);
      }
    }
    if (input.taskSoundEnabled !== undefined) {
      try {
        next.taskSoundEnabled = assertTaskSoundEnabled(input.taskSoundEnabled);
      } catch (err) {
        throw badRequest(err.message);
      }
    }
    const changed = JSON.stringify(next) !== JSON.stringify(this.settings);
    if (!changed) return this.getSettings();
    this.settings = next;
    try {
      writeSettings(this.dataDir, this.settings);
    } catch (err) {
      this.log('warn', `系统设置写入失败：${err && err.message ? err.message : err}`);
    }
    this.broadcast('settings.updated', { settings: this.getSettings(), at: protocol.nowIso() });
    this.log('info', `系统设置更新：language=${this.settings.language} mainDeviceId=${this.settings.mainDeviceId || '(本机)'} taskSoundEnabled=${this.settings.taskSoundEnabled !== false}`);
    this.schedulePersist();
    return this.getSettings();
  }

  getSupportedLanguages() {
    return [...SUPPORTED_LANGUAGES];
  }

  // ---------------------------------------------------------------- 长期目标

  _requireGoal(goalId) {
    const id = util.str(goalId, 80);
    const goal = id ? this.goals.get(id) : null;
    if (!goal) throw notFound('长期目标不存在');
    return goal;
  }

  /** 列出长期目标（active 在前，其余按创建时间倒序）。 */
  listGoals(filter = {}) {
    const status = util.isPlainObject(filter) ? util.str(filter.status, 40) : '';
    const goals = [...this.goals.values()]
      .filter((goal) => !status || goal.status === status)
      .sort((a, b) => {
        const activeRank = (goal) => (goal.status === 'active' ? 0 : 1);
        const byStatus = activeRank(a) - activeRank(b);
        if (byStatus) return byStatus;
        return String(b.createdAt).localeCompare(String(a.createdAt));
      });
    return goals.map((goal) => {
      const json = goalToJson(goal);
      json.linkedStats = this._goalLinkedStats(goal);
      return json;
    });
  }

  getGoal(goalId) {
    return goalToJson(this._requireGoal(goalId));
  }

  /** 目标关联任务的聚合统计（列表页/大脑提示词共用）。 */
  _goalLinkedStats(goal) {
    const stats = {
      total: 0,
      running: 0,
      completed: 0,
      failed: 0,
      waiting: 0,
      planTotal: 0,
      planCompleted: 0,
    };
    const ids = util.arr(goal && goal.taskIds);
    let bestPlanTotal = 0;
    for (const id of ids) {
      const task = this.tasks.get(id);
      if (!task) continue;
      if (task.trashedAt) continue;
      stats.total += 1;
      if (task.status === TASK_STATUS.ASSIGNED || task.status === TASK_STATUS.RUNNING) stats.running += 1;
      else if (task.status === TASK_STATUS.WAITING) stats.waiting += 1;
      else if (task.status === TASK_STATUS.COMPLETED) stats.completed += 1;
      else if (
        task.status === TASK_STATUS.FAILED ||
        task.status === TASK_STATUS.TIMEOUT ||
        task.status === TASK_STATUS.CANCELLED
      ) {
        stats.failed += 1;
      }
      if (task.isPlan && util.arr(task.childTaskIds).length > bestPlanTotal) {
        bestPlanTotal = task.childTaskIds.length;
        const children = task.childTaskIds.map((childId) => this.tasks.get(childId)).filter(Boolean);
        stats.planTotal = task.childTaskIds.length;
        stats.planCompleted = children.filter((child) => child.status === TASK_STATUS.COMPLETED).length;
      }
    }
    return stats;
  }

  goalLinkedStats(goalId) {
    return this._goalLinkedStats(this._requireGoal(goalId));
  }

  /**
   * 目标详情页展示用的关联任务摘要列表（只列顶层任务；计划子任务折叠进 childProgress）。
   * @param {string} goalId
   */
  listGoalTasks(goalId) {
    const goal = this._requireGoal(goalId);
    const ids = util.arr(goal.taskIds);
    const idSet = new Set(ids);
    return ids
      .map((id) => this.tasks.get(id))
      .filter((task) => task && !task.trashedAt && !(task.parentTaskId && idSet.has(task.parentTaskId)))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((task) => this._goalTaskSummary(task));
  }

  _goalTaskSummary(task) {
    const progress = util.isPlainObject(task.progress)
      ? {
          message: util.str(task.progress.message, 500) || '',
          percent: Number.isFinite(Number(task.progress.percent))
            ? Math.max(0, Math.min(100, Math.trunc(Number(task.progress.percent))))
            : 0,
          waiting: task.progress.waiting === true,
          question: util.str(task.progress.question, 500) || null,
          at: task.progress.at || null,
        }
      : null;
    const children = util
      .arr(task.childTaskIds)
      .map((id) => this.tasks.get(id))
      .filter(Boolean);
    let childProgress = null;
    if (task.isPlan && children.length) {
      childProgress = {
        total: children.length,
        completed: children.filter((child) => child.status === TASK_STATUS.COMPLETED).length,
        failed: children.filter(
          (child) =>
            child.status === TASK_STATUS.FAILED ||
            child.status === TASK_STATUS.TIMEOUT ||
            child.status === TASK_STATUS.CANCELLED,
        ).length,
        running: children.filter(
          (child) => child.status === TASK_STATUS.ASSIGNED || child.status === TASK_STATUS.RUNNING,
        ).length,
        waiting: children.filter((child) => child.status === TASK_STATUS.WAITING).length,
      };
    }
    const events = util.arr(task.events);
    const last = events.length ? events[events.length - 1] : null;
    return {
      id: task.id,
      instruction: util.truncate(task.instruction || '', 400),
      status: task.status,
      goalId: task.goalId || null,
      isPlan: Boolean(task.isPlan),
      parentTaskId: task.parentTaskId || null,
      threadId: task.threadId || null,
      createdAt: task.createdAt || null,
      updatedAt: task.updatedAt || null,
      startedAt: task.startedAt || null,
      finishedAt: task.finishedAt || null,
      assignedDeviceName: task.assignedDeviceName || null,
      progress,
      error: task.error ? util.truncate(task.error, 300) : null,
      childProgress,
      planStep: task.planStep || null,
      planTitle: null,
      lastEvent: last
        ? { at: last.at, type: last.type, message: util.truncate(last.message || '', 200) }
        : null,
    };
  }

  /** 取消任务与目标的关联（不删除任务）。 */
  unlinkGoalTask(goalId, taskId) {
    const goal = this._requireGoal(goalId);
    const task = this._requireTask(util.str(taskId, 80));
    const now = protocol.nowIso();
    const index = goal.taskIds.indexOf(task.id);
    if (index >= 0) goal.taskIds.splice(index, 1);
    if (task.goalId === goal.id) task.goalId = null;
    task.updatedAt = now;
    if (goal.runningTaskId === task.id) goal.runningTaskId = null;
    if (task.isPlan) {
      for (const childId of util.arr(task.childTaskIds)) {
        const child = this.tasks.get(childId);
        if (!child || !util.isPlainObject(child.context)) continue;
        if (child.context.goalId !== goal.id) continue;
        const nextContext = { ...child.context };
        delete nextContext.goalId;
        child.context = Object.keys(nextContext).length ? nextContext : null;
        child.updatedAt = now;
        this.broadcast('task.updated', { task: this.taskToJson(child) });
      }
    }
    goal.updatedAt = now;
    this.broadcast('goal.updated', { goal: goalToJson(goal), at: now });
    this.broadcast('task.updated', { task: this.taskToJson(task) });
    this.log('info', `长期目标取消关联：${goal.id} ↮ ${task.id}`);
    this._journalEntry({
      kind: 'work',
      title: `取消关联目标「${util.truncate(goalDisplayName(goal), 40)}」`,
      text: util.truncate(task.instruction, 600),
      refs: { goalId: goal.id, taskId: task.id },
      meta: { action: 'unlink', taskStatus: task.status },
    });
    this.schedulePersist();
    return { goal, task };
  }

  /** 任务创建/关联到目标后的统一登记（去重、runningTaskId、广播）。 */
  _registerGoalTask(goalId, task) {
    if (!goalId || !task) return;
    const goal = this.goals.get(goalId);
    if (!goal) return;
    if (!goal.taskIds.includes(task.id)) {
      goal.taskIds.push(task.id);
      if (goal.taskIds.length > 50) goal.taskIds.splice(0, goal.taskIds.length - 50);
    }
    if (!TERMINAL_TASK_STATUSES.has(task.status)) {
      if (!goal.runningTaskId || !this._goalActiveTask(goal.runningTaskId)) {
        goal.runningTaskId = task.id;
      }
    }
    goal.updatedAt = protocol.nowIso();
    this.broadcast('goal.updated', { goal: goalToJson(goal), at: goal.updatedAt });
  }

  _goalActiveTask(taskId) {
    const task = taskId ? this.tasks.get(taskId) : null;
    return Boolean(task && !TERMINAL_TASK_STATUSES.has(task.status));
  }

  createGoal(input) {
    const normalized = normalizeGoalRequest(input, { partial: false });
    if (!normalized.ok) throw badRequest(normalized.errors.join('；'));
    const value = normalized.value;
    const now = protocol.nowIso();
    const status = value.status === 'paused' ? 'paused' : 'active';
    const goal = {
      id: protocol.randomId('goal'),
      title: value.title,
      nickname: value.nickname || '',
      description: value.description || '',
      status,
      schedule: value.schedule,
      requirements: value.requirements || null,
      nextCheckAt: status === 'active' ? computeNextCheckAt(value.schedule) : null,
      pausedUntil: status === 'paused' ? (value.pausedUntil || null) : null,
      guidance: [],
      lastCheckAt: null,
      lastCheckStatus: null,
      lastSummary: '',
      lastTaskId: null,
      runningTaskId: null,
      pendingApproval: null,
      taskIds: [],
      checks: [],
      createdAt: now,
      updatedAt: now,
      stoppedAt: null,
    };
    this.goals.set(goal.id, goal);
    this.broadcast('goal.created', { goal: goalToJson(goal), at: now });
    this.log('info', `长期目标创建：${goal.id}「${util.truncate(goalDisplayName(goal), 40)}」`);
    this.schedulePersist();
    return goal;
  }

  updateGoal(goalId, patch) {
    const goal = this._requireGoal(goalId);
    const normalized = normalizeGoalRequest(patch, { partial: true, base: goal });
    if (!normalized.ok) throw badRequest(normalized.errors.join('；'));
    const value = normalized.value;
    const now = protocol.nowIso();
    const previousStatus = goal.status;
    if (value.title !== undefined) goal.title = value.title;
    if (value.nickname !== undefined) goal.nickname = value.nickname;
    if (value.description !== undefined) goal.description = value.description;
    if (value.requirements !== undefined) goal.requirements = value.requirements;
    let scheduleChanged = false;
    if (value.schedule !== undefined && JSON.stringify(value.schedule) !== JSON.stringify(goal.schedule)) {
      goal.schedule = value.schedule;
      scheduleChanged = true;
    }
    if (value.status !== undefined) {
      goal.status = value.status;
      if (value.status === 'active') {
        // 暂停/停止后恢复：从现在开始重新计算，不补跑错过的检查。
        goal.nextCheckAt = computeNextCheckAt(goal.schedule);
        goal.stoppedAt = null;
        goal.pausedUntil = null;
      } else {
        goal.nextCheckAt = null;
        goal.pausedUntil = value.status === 'paused'
          ? (value.pausedUntil !== undefined
            ? value.pausedUntil
            : (previousStatus === 'paused' ? (goal.pausedUntil || null) : null))
          : null;
        goal.stoppedAt = value.status === 'stopped' || value.status === 'completed' ? now : goal.stoppedAt;
      }
    } else if (value.pausedUntil !== undefined && goal.status === 'paused') {
      // 仅调整暂停截止时间：保持暂停状态，等调度器到点自动恢复。
      goal.pausedUntil = value.pausedUntil;
    } else if (scheduleChanged && goal.status === 'active') {
      goal.nextCheckAt = computeNextCheckAt(goal.schedule);
    }
    // 状态变化后旧的「待确认跟进」提案失效，避免恢复 active 时误批。
    if (value.status !== undefined) goal.pendingApproval = null;
    goal.updatedAt = now;
    this.broadcast('goal.updated', { goal: goalToJson(goal), at: now });
    if (previousStatus !== goal.status) this.log('info', `长期目标状态：${goal.id} ${previousStatus} → ${goal.status}`);
    else this.log('info', `长期目标更新：${goal.id}`);
    this.schedulePersist();
    return goal;
  }

  /**
   * 跳过下一次自动跟进（一次）：推进 nextCheckAt 一个计划周期，目标保持 active。
   * 到点的待确认提案一并取消，避免用户稍后误批准这次想跳过的跟进。
   * @param {string} goalId
   * @returns {object} goal
   */
  skipNextGoalCheck(goalId) {
    const goal = this._requireGoal(goalId);
    if (goal.status !== 'active') throw conflict('只有进行中的目标可以跳过下一次跟进');
    const now = protocol.nowIso();
    const previous = goal.nextCheckAt;
    goal.nextCheckAt = computeSkipNextCheckAt(goal.schedule, goal.nextCheckAt, Date.parse(now));
    goal.pendingApproval = null;
    goal.updatedAt = now;
    this.broadcast('goal.updated', { goal: goalToJson(goal), at: now });
    this.log(
      'info',
      `长期目标跳过下一次跟进：${goal.id}「${util.truncate(goalDisplayName(goal), 40)}」`
        + `（${previous || '未排期'} → ${goal.nextCheckAt}）`,
    );
    this.schedulePersist();
    return goal;
  }

  /**
   * 给目标追加一条「新的指导指令」：会加入之后的跟进任务指令，并立即刷新待确认提案。
   * @param {string} goalId
   * @param {{text:string}} input
   * @returns {object} goal
   */
  addGoalGuidance(goalId, input) {
    const goal = this._requireGoal(goalId);
    const normalized = normalizeGuidanceEntry(input);
    if (!normalized.ok) throw badRequest(normalized.error);
    const now = protocol.nowIso();
    goal.guidance = [
      ...(goal.guidance || []),
      { id: protocol.randomId('gd'), text: normalized.value.text, createdAt: now },
    ].slice(-MAX_GUIDANCE_ENTRIES);
    goal.updatedAt = now;
    // 已有待确认提案时同步刷新指令，避免用户批准后仍用旧指导。
    if (goal.pendingApproval) goal.pendingApproval.instruction = buildGoalCheckInstruction(goal);
    this.broadcast('goal.updated', { goal: goalToJson(goal), at: now });
    this.log(
      'info',
      `长期目标新增指导指令：${goal.id}「${util.truncate(goalDisplayName(goal), 40)}」`
        + `（${util.truncate(normalized.value.text, 60)}）`,
    );
    this.schedulePersist();
    return goal;
  }

  deleteGoal(goalId) {
    const goal = this._requireGoal(goalId);
    this.goals.delete(goal.id);
    const now = protocol.nowIso();
    this.broadcast('goal.deleted', { goalId: goal.id, at: now });
    this.log('info', `长期目标删除：${goal.id}`);
    this.schedulePersist();
    return goal;
  }

  // ---------------------------------------------------------------- 提醒

  _requireReminder(reminderId) {
    const id = util.str(reminderId, 80);
    const reminder = id ? this.reminders.get(id) : null;
    if (!reminder) throw notFound('提醒不存在');
    return reminder;
  }

  /** 列出提醒（dueAt 升序；同一到期时间按 createdAt 升序，APK 与 Web 共用）。 */
  listReminders() {
    return [...this.reminders.values()]
      .sort((a, b) => {
        const byDue = a.dueAt - b.dueAt;
        if (byDue) return byDue;
        return String(a.createdAt).localeCompare(String(b.createdAt));
      })
      .map((reminder) => reminderToJson(reminder));
  }

  getReminder(reminderId) {
    return reminderToJson(this._requireReminder(reminderId));
  }

  createReminder(input) {
    const normalized = normalizeReminderRequest(input, { partial: false });
    if (!normalized.ok) throw badRequest(normalized.errors.join('；'));
    const value = normalized.value;
    const now = protocol.nowIso();
    const reminder = {
      id: protocol.randomId('rem'),
      title: value.title,
      note: value.note || '',
      dueAt: value.dueAt,
      repeat: value.repeat || 'none',
      notifyStyle: value.notifyStyle || DEFAULT_NOTIFY_STYLE,
      enabled: value.enabled !== false,
      createdAt: now,
      updatedAt: now,
      lastFiredAt: null,
      fireCount: 0,
    };
    this.reminders.set(reminder.id, reminder);
    this.broadcast('reminder.created', { reminder: reminderToJson(reminder), at: now });
    this.log('info', `提醒创建：${reminder.id}「${util.truncate(reminderDisplayName(reminder), 40)}」`);
    this.schedulePersist();
    return reminder;
  }

  updateReminder(reminderId, patch) {
    const reminder = this._requireReminder(reminderId);
    const normalized = normalizeReminderRequest(patch, { partial: true, base: reminder });
    if (!normalized.ok) throw badRequest(normalized.errors.join('；'));
    const value = normalized.value;
    if (value.title !== undefined) reminder.title = value.title;
    if (value.note !== undefined) reminder.note = value.note;
    if (value.dueAt !== undefined) reminder.dueAt = value.dueAt;
    if (value.repeat !== undefined) reminder.repeat = value.repeat;
    if (value.notifyStyle !== undefined) reminder.notifyStyle = value.notifyStyle;
    if (value.enabled !== undefined) reminder.enabled = value.enabled;
    // 显式 enabled:true 且 dueAt 已过期时不自动改 dueAt：过期由客户端表单处理，避免 Hub 擅自跳期。
    const now = protocol.nowIso();
    reminder.updatedAt = now;
    this.broadcast('reminder.updated', { reminder: reminderToJson(reminder), at: now });
    this.log('info', `提醒更新：${reminder.id}`);
    this.schedulePersist();
    return reminder;
  }

  deleteReminder(reminderId) {
    const reminder = this._requireReminder(reminderId);
    this.reminders.delete(reminder.id);
    const now = protocol.nowIso();
    this.broadcast('reminder.deleted', { reminderId: reminder.id, at: now });
    this.log('info', `提醒删除：${reminder.id}`);
    this.schedulePersist();
    return reminder;
  }

  /**
   * APK 回写到点事件（通知由 APK 原生层弹出，Hub 只更新数据并广播）。
   *
   * one-shot：enabled=false，dueAt 保留原值。
   * daily/weekly：dueAt 推进到下一次（> firedAt 且 > 当前时间），enabled=true，fireCount+1。
   *
   * @param {string} reminderId
   * @param {{firedAt?: string}} [options] firedAt 为 ISO 字符串，缺省/非法时用当前时间
   * @returns {object} 内部提醒对象
   */
  fireReminder(reminderId, { firedAt } = {}) {
    const reminder = this._requireReminder(reminderId);
    let firedAtMs = Date.now();
    if (typeof firedAt === 'string' && firedAt.trim()) {
      const parsed = Date.parse(firedAt);
      if (Number.isFinite(parsed)) firedAtMs = parsed;
    }
    const now = protocol.nowIso();
    reminder.lastFiredAt = now;
    reminder.fireCount = (Number.isFinite(reminder.fireCount) ? reminder.fireCount : 0) + 1;
    if (reminder.repeat === 'none' || !reminder.repeat) {
      reminder.enabled = false;
    } else {
      const from = Math.max(firedAtMs, Date.now());
      const next = nextDueAt(reminder.dueAt, reminder.repeat, from);
      if (next !== null) reminder.dueAt = next;
      reminder.enabled = true;
    }
    reminder.updatedAt = now;
    this.broadcast('reminder.fired', { reminder: reminderToJson(reminder), at: now });
    this.log('info', `提醒触发：${reminder.id}（${reminder.repeat}，下一次 ${new Date(reminder.dueAt).toISOString()}）`);
    this.schedulePersist();
    return reminder;
  }

  /**
   * 创建一次目标跟进任务（立即跟进或定时触发）。
   * @param {string} goalId
   * @param {{manual?: boolean}} [options]
   * @returns {{goal: object, task: object}}
   */
  requestGoalCheck(goalId, options = {}) {
    const goal = this._requireGoal(goalId);
    if (goal.status === 'stopped') throw conflict('目标已停止，无法继续跟进');
    if (goal.status === 'completed') throw conflict('目标已完成，无需继续跟进');
    if (goal.runningTaskId) {
      const running = this.tasks.get(goal.runningTaskId);
      if (running && !TERMINAL_TASK_STATUSES.has(running.status)) {
        throw conflict('该目标已有跟进任务正在执行，请稍后再试');
      }
      goal.runningTaskId = null;
    }
    // 手动/已批准的跟进视为用户已同意，清掉旧的待确认提案。
    goal.pendingApproval = null;
    const manual = options.manual !== false;
    const task = this.createTask({
      instruction: buildGoalCheckInstruction(goal),
      requirements: goal.requirements || {},
      priority: manual ? 7 : 4,
      timeoutSec: 600,
      maxAttempts: 2,
      autoRetry: true,
      goalId: goal.id,
      context: {
        goalId: goal.id,
        goalCheck: true,
        goalTitle: goalDisplayName(goal),
        trigger: manual ? 'manual' : 'schedule',
      },
    });
    const now = protocol.nowIso();
    goal.runningTaskId = task.id;
    if (!goal.taskIds.includes(task.id)) goal.taskIds.push(task.id);
    if (goal.taskIds.length > 50) goal.taskIds.splice(0, goal.taskIds.length - 50);
    goal.updatedAt = now;
    this.broadcast('goal.updated', { goal: goalToJson(goal), at: now });
    this.log('info', `长期目标跟进任务：${goal.id} → ${task.id}（${manual ? '手动' : '定时'}）`);
    this.schedulePersist();
    return { goal, task };
  }

  /**
   * 把一个已有任务关联到长期目标。
   * - 任务 goalId 指向目标，并加入 goal.taskIds；
   * - 任务已结束时，把它的结论写入目标（lastSummary / lastTaskId / checks），
   *   这样下一次跟进任务会带着这段结论继续。
   * @param {string} goalId
   * @param {string} taskId
   * @returns {{goal: object, task: object}}
   */
  linkGoalTask(goalId, taskId) {
    const goal = this._requireGoal(goalId);
    const task = this._requireTask(util.str(taskId, 80));
    const now = protocol.nowIso();
    if (!goal.taskIds.includes(task.id)) {
      goal.taskIds.push(task.id);
      if (goal.taskIds.length > 50) goal.taskIds.splice(0, goal.taskIds.length - 50);
    }
    task.goalId = goal.id;
    task.updatedAt = now;
    // 计划父任务：给子任务补归属上下文（仅 context.goalId，不写 child.goalId，
    // 这样只有父任务结束才回写目标，子任务不会各自制造跟进记录）。
    if (task.isPlan) {
      for (const childId of util.arr(task.childTaskIds)) {
        const child = this.tasks.get(childId);
        if (!child) continue;
        const context = util.isPlainObject(child.context) ? child.context : {};
        if (context.goalId === goal.id) continue;
        child.context = { ...context, goalId: goal.id };
        child.updatedAt = now;
        this.broadcast('task.updated', { task: this.taskToJson(child) });
      }
    }
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      const output = util.isPlainObject(task.output) ? task.output : null;
      const summary = util.str(
        (output && (output.text || output.markdown)) || (task.error ? `执行失败：${task.error}` : ''),
        4000,
      );
      const at = task.finishedAt || now;
      if (!goal.checks.some((check) => check && check.taskId === task.id)) {
        goal.checks.push({
          at,
          taskId: task.id,
          status: task.status,
          summary,
          error: task.error || null,
        });
        if (goal.checks.length > MAX_CHECKS) goal.checks.splice(0, goal.checks.length - MAX_CHECKS);
      }
      goal.lastCheckAt = at;
      goal.lastCheckStatus = task.status;
      goal.lastTaskId = task.id;
      goal.lastSummary = summary;
      if (goal.status === 'active') {
        goal.nextCheckAt = computeNextCheckAt(goal.schedule, Date.now());
      }
    } else if (!goal.runningTaskId || !this._goalActiveTask(goal.runningTaskId)) {
      goal.runningTaskId = task.id;
    }
    goal.updatedAt = now;
    this.broadcast('goal.updated', { goal: goalToJson(goal), at: now });
    this.broadcast('task.updated', { task: this.taskToJson(task) });
    this.log('info', `长期目标关联任务：${goal.id} ← ${task.id}`);
    this._journalEntry({
      kind: 'work',
      title: `关联任务到目标「${util.truncate(goalDisplayName(goal), 40)}」`,
      text: util.truncate(task.instruction, 600),
      refs: { goalId: goal.id, taskId: task.id },
      meta: { action: 'link', taskStatus: task.status },
    });
    this.schedulePersist();
    return { goal, task };
  }

  /**
   * 为一个到点的目标创建「待确认」提案：用户同意后才创建跟进任务。
   * @param {object} goal
   * @param {{source?: string}} [options]
   * @returns {{id:string, at:string, reason:string, instruction:string, source:string}}
   */
  requestGoalApproval(goal, { source = 'schedule' } = {}) {
    const now = protocol.nowIso();
    const scheduleText =
      goal.schedule && goal.schedule.type === 'interval'
        ? `每 ${goal.schedule.minutes} 分钟`
        : `每天 ${goal.schedule && goal.schedule.time ? goal.schedule.time : '09:00'}`;
    goal.pendingApproval = {
      id: protocol.randomId('appr'),
      at: now,
      reason: source === 'schedule' ? `到点跟进（${scheduleText}）` : '手动发起',
      instruction: buildGoalCheckInstruction(goal),
      source,
    };
    goal.updatedAt = now;
    this.broadcast('goal.updated', { goal: goalToJson(goal), at: now });
    this.broadcast('goal.approval', {
      goalId: goal.id,
      approval: { ...goal.pendingApproval },
      at: now,
    });
    this.log('info', `目标跟进待确认：${goal.id}「${util.truncate(goalDisplayName(goal), 40)}」`);
    this.schedulePersist();
    return goal.pendingApproval;
  }

  /** 列出所有等待用户确认的目标跟进。 */
  listApprovals() {
    return [...this.goals.values()]
      .filter((goal) => goal.pendingApproval)
      .map((goal) => ({
        goalId: goal.id,
        goalTitle: goalDisplayName(goal),
        createdAt: goal.pendingApproval.at,
        approval: { ...goal.pendingApproval },
      }))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  /** 用户同意目标跟进：创建跟进任务。 */
  approveGoalCheck(goalId) {
    const goal = this._requireGoal(goalId);
    if (!goal.pendingApproval) throw conflict('该目标没有待确认的跟进');
    goal.pendingApproval = null;
    return this.requestGoalCheck(goalId, { manual: true });
  }

  /** 用户否决目标跟进：清掉提案并暂缓目标，等用户下一步指令。 */
  rejectGoalCheck(goalId) {
    const goal = this._requireGoal(goalId);
    if (!goal.pendingApproval) throw conflict('该目标没有待确认的跟进');
    goal.pendingApproval = null;
    goal.status = 'paused';
    goal.pausedUntil = null;
    goal.nextCheckAt = null;
    goal.updatedAt = protocol.nowIso();
    this.broadcast('goal.updated', { goal: goalToJson(goal), at: goal.updatedAt });
    this.log('info', `目标跟进被否决，已暂缓：${goal.id}「${util.truncate(goalDisplayName(goal), 40)}」`);
    this.schedulePersist();
    return goalToJson(goal);
  }

  // ---------------------------------------------------------------- 每晚总结

  /** 生成「每日总结」任务指令：复盘所有目标与任务/子任务进度，规划明天的方向。 */
  _buildNightlyReviewInstruction(dateKey) {
    const goals = this.listGoals();
    const lines = [
      `【每日夜间总结】日期：${dateKey}（${localTimeZone()}）`,
      '现在是晚间复盘时间：请只做分析与规划，不要执行任务、不要修改文件、不要访问外部网站。',
      '',
      `## 长期目标（${goals.length} 个）`,
    ];
    goals.forEach((goal, index) => {
      const scheduleText =
        goal.schedule && goal.schedule.type === 'interval'
          ? `每 ${goal.schedule.minutes} 分钟`
          : `每天 ${goal.schedule && goal.schedule.time ? goal.schedule.time : '09:00'}`;
      const name = goalDisplayName(goal);
      const titleNote = goal.nickname && goal.nickname !== goal.title ? `（标题：${goal.title}）` : '';
      lines.push(
        `${index + 1}. ${name}${titleNote}（${goal.id}）｜状态 ${goal.status}｜计划 ${scheduleText}｜上次检查 ${goal.lastCheckAt || '无'}（${goal.lastCheckStatus || '无'}）`,
      );
      if (goal.description) lines.push(`   描述：${util.truncate(goal.description, 300)}`);
      if (goal.lastSummary) lines.push(`   上次结论：${util.truncate(goal.lastSummary, 800)}`);
      const recent = goal.checks
        .slice(-2)
        .map((check) => `   - ${check.at}（${check.status}）：${util.truncate(check.summary || check.error || '', 160)}`);
      if (recent.length) lines.push('   最近检查记录：', ...recent);
      if (goal.pendingApproval) {
        lines.push(`   待确认跟进：${util.truncate(goal.pendingApproval.reason || '', 120)}`);
      }
    });

    const cutoff = Date.now() - 24 * 3600 * 1000;
    const tasks = [...this.tasks.values()]
      .filter((task) => {
        if (task.archived || task.trashedAt) return false;
        if (ACTIVE_TASK_STATUSES.has(task.status)) return true;
        const created = Date.parse(task.createdAt);
        return Number.isFinite(created) && created >= cutoff;
      })
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .slice(-40);
    lines.push('', `## 今天的任务与子任务（${tasks.length} 个）`);
    for (const task of tasks) {
      const parent = task.parentTaskId ? `｜父任务 ${task.parentTaskId}` : '';
      lines.push(
        `- ${task.id}｜${task.status}｜${task.assignedDeviceName || '未分配'}${parent}｜${util.truncate(task.instruction, 120)}`,
      );
      const output = util.isPlainObject(task.output) ? task.output.text || task.output.markdown : '';
      if (output) lines.push(`  结果摘要：${util.truncate(output, 200)}`);
      if (task.error) lines.push(`  错误：${util.truncate(task.error, 160)}`);
      if (task.progress && task.progress.message) {
        lines.push(`  最新进度：${util.truncate(task.progress.message, 120)}`);
      }
    }

    const approvals = this.listApprovals();
    lines.push('', `## 等待老板确认的目标跟进（${approvals.length} 个）`);
    for (const item of approvals) {
      lines.push(`- ${item.goalTitle}（${item.goalId}）：${util.truncate(item.approval.reason || '', 120)}`);
    }

    lines.push(
      '',
      '请输出一份中文 Markdown，结构如下：',
      `# 每日总结 ${dateKey}`,
      '## 1. 目标进度（逐个目标：已完成 / 进行中 / 受阻，并给出依据）',
      '## 2. 任务与子任务复盘（今天的完成 / 失败 / 取消 / 滞留，瓶颈与原因）',
      '## 3. 明天的工作方向（按目标分组，具体动作、优先级、预计产出）',
      '## 4. 需要老板确认的事项（明天每个目标执行前的批准点）',
      '## 5. 目标下一步细节（每个目标 1-3 条可执行动作 + 验收标准）',
      '不要执行任何操作，只输出总结。',
    );
    return lines.join('\n').slice(0, 16000);
  }

  getNightlyReview() {
    const review = this.nightlyReview || {};
    const task = review.taskId ? this.tasks.get(review.taskId) : null;
    return {
      enabled: this.nightlyReviewEnabled,
      time: this.nightlyReviewTime,
      date: review.date || null,
      taskId: review.taskId || null,
      status: review.status || null,
      startedAt: review.startedAt || null,
      finishedAt: review.finishedAt || null,
      summary: review.summary || '',
      error: review.error || null,
      task: task ? this.taskToJson(task) : null,
    };
  }

  _restoreNightlyReview(raw) {
    const empty = {
      date: null,
      taskId: null,
      status: null,
      startedAt: null,
      finishedAt: null,
      summary: '',
      error: null,
      lastSkipReason: '',
    };
    if (!util.isPlainObject(raw)) return empty;
    return {
      date: util.str(raw.date, 20) || null,
      taskId: util.str(raw.taskId, 80) || null,
      status: util.str(raw.status, 40) || null,
      startedAt: util.str(raw.startedAt, 40) || null,
      finishedAt: util.str(raw.finishedAt, 40) || null,
      summary: util.str(raw.summary, 20000) || '',
      error: raw.error ? util.str(raw.error, 4000) : null,
      lastSkipReason: util.str(raw.lastSkipReason, 200) || '',
    };
  }

  /**
   * 到点创建「每日总结」任务（每晚一次）。
   * @param {number} [now]
   * @param {{force?: boolean}} [options] force=true 时忽略「今天已总结/未到点」，供手动触发。
   * @returns {object|null} 新建的任务；未触发时返回 null。
   */
  runNightlyReview(now = Date.now(), options = {}) {
    if (this._closed) return null;
    const force = options.force === true;
    if (!this.nightlyReviewEnabled && !force) return null;
    const at = new Date(Number(now) || Date.now());
    const dateKey = localDateKey(at);
    const review = this.nightlyReview || {};
    const activeTask = review.taskId ? this.tasks.get(review.taskId) : null;
    if (activeTask && ACTIVE_TASK_STATUSES.has(activeTask.status)) return null;
    if (!force) {
      if (review.date === dateKey) return null;
      const [hour, minute] = this.nightlyReviewTime.split(':').map(Number);
      const due = new Date(at);
      due.setHours(hour, minute, 0, 0);
      if (at.getTime() < due.getTime()) return null;
    }
    const task = this.createTask({
      instruction: this._buildNightlyReviewInstruction(dateKey),
      requirements: {},
      priority: 6,
      timeoutSec: 900,
      maxAttempts: 2,
      autoRetry: true,
      context: { nightlyReview: true, date: dateKey },
    });
    this.nightlyReview = {
      date: dateKey,
      taskId: task.id,
      status: task.status,
      startedAt: task.createdAt,
      finishedAt: null,
      summary: '',
      error: null,
      lastSkipReason: '',
    };
    this.broadcast('nightly.review.updated', { review: this.getNightlyReview() });
    this.log('info', `每日总结任务已创建：${task.id}（${dateKey}）`);
    this.schedulePersist();
    return task;
  }

  _nightlyReviewFinished(task) {
    if (!this.nightlyReview || this.nightlyReview.taskId !== task.id) return;
    const output = util.isPlainObject(task.output) ? task.output : null;
    this.nightlyReview.status = task.status;
    this.nightlyReview.finishedAt = task.finishedAt || protocol.nowIso();
    this.nightlyReview.summary = util.str(
      (output && (output.text || output.markdown)) || '',
      20000,
    );
    this.nightlyReview.error = task.error || null;
    this.broadcast('nightly.review.updated', { review: this.getNightlyReview() });
    this.log(
      task.status === 'completed' ? 'info' : 'warn',
      `每日总结${task.status === 'completed' ? '完成' : '未完成'}：${task.id}`,
    );
    this.schedulePersist();
  }

  /**
   * 自动恢复到期的「暂停到某个时间」：pausedUntil <= now 的目标恢复 active，
   * 并从当前时刻重新排下一次跟进（暂停期间的检查不补跑）。
   */
  _resumeExpiredGoalPauses(nowMs = Date.now()) {
    const timestamp = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    for (const goal of this.goals.values()) {
      if (goal.status !== 'paused' || !goal.pausedUntil) continue;
      const until = Date.parse(goal.pausedUntil);
      if (!Number.isFinite(until) || until > timestamp) continue;
      goal.status = 'active';
      goal.pausedUntil = null;
      goal.nextCheckAt = computeNextCheckAt(goal.schedule, timestamp);
      goal.updatedAt = protocol.nowIso();
      this.broadcast('goal.updated', { goal: goalToJson(goal), at: goal.updatedAt });
      this.log(
        'info',
        `长期目标暂停到期，自动恢复：${goal.id}（下次跟进 ${goal.nextCheckAt}）`,
      );
      this.schedulePersist();
    }
  }

  /** 调度器：扫描到点的 active 目标并创建跟进任务；返回本次触发的目标 id。 */
  runDueGoalChecks(now = Date.now()) {
    if (this._closed) return [];
    const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    this._resumeExpiredGoalPauses(timestamp);
    const triggered = [];
    for (const goal of [...this.goals.values()]) {
      if (goal.status !== 'active' || !goal.nextCheckAt) continue;
      const due = Date.parse(goal.nextCheckAt);
      if (!Number.isFinite(due) || due > timestamp) continue;
      if (goal.runningTaskId) {
        const running = this.tasks.get(goal.runningTaskId);
        if (running && !TERMINAL_TASK_STATUSES.has(running.status)) continue;
        goal.runningTaskId = null;
      }
      // 目标每次执行前都要老板确认：已有待确认提案时保持不动，等用户批准/否决。
      if (goal.pendingApproval) continue;
      try {
        this.requestGoalApproval(goal, { source: 'schedule' });
        triggered.push(goal.id);
      } catch (err) {
        this.log('warn', `长期目标自动跟进失败：${goal.id}：${err && err.message ? err.message : err}`);
      }
    }
    return triggered;
  }

  _reconcileGoalsAfterRestore() {
    for (const goal of this.goals.values()) {
      if (goal.status === 'active') {
        if (goal.runningTaskId) {
          const task = this.tasks.get(goal.runningTaskId);
          if (!task || TERMINAL_TASK_STATUSES.has(task.status)) goal.runningTaskId = null;
        }
        if (!goal.nextCheckAt) goal.nextCheckAt = computeNextCheckAt(goal.schedule);
      } else {
        goal.nextCheckAt = null;
        // 重启前已经到期的「暂停到某个时间」直接恢复为进行中。
        if (goal.status === 'paused' && goal.pausedUntil) {
          const until = Date.parse(goal.pausedUntil);
          if (Number.isFinite(until) && until <= Date.now()) {
            goal.status = 'active';
            goal.pausedUntil = null;
            goal.nextCheckAt = computeNextCheckAt(goal.schedule);
            goal.updatedAt = protocol.nowIso();
          }
        }
      }
    }
  }

  /** 计划父任务没有输出时，用子任务结果合成一句结论写回目标。 */
  _goalPlanSummary(task) {
    const children = util
      .arr(task.childTaskIds)
      .map((id) => this.tasks.get(id))
      .filter(Boolean);
    const completed = children.filter((child) => child.status === TASK_STATUS.COMPLETED).length;
    const failed = children.filter(
      (child) =>
        child.status === TASK_STATUS.FAILED ||
        child.status === TASK_STATUS.TIMEOUT ||
        child.status === TASK_STATUS.CANCELLED,
    );
    const failedText = failed.length
      ? `（失败步骤：${failed
          .map((child) => `第 ${child.planStep || '?'} 步 ${util.truncate(child.instruction || '', 60)}`)
          .join('；')}）`
      : '';
    return util.str(
      `计划「${util.truncate(task.instruction || '长任务', 30)}」共 ${children.length} 步：完成 ${completed}，失败 ${failed.length}${failedText}`,
      4000,
    );
  }

  /** 目标跟进/关联任务结束时回写检查结果与建议。 */
  _goalTaskFinished(task) {
    if (!task || !task.goalId) return;
    const goal = this.goals.get(task.goalId);
    if (!goal) return;
    const output = util.isPlainObject(task.output) ? task.output : null;
    let summary = util.str(
      (output && (output.text || output.markdown)) || (task.error ? `执行失败：${task.error}` : ''),
      4000,
    );
    if (!summary && task.isPlan) summary = this._goalPlanSummary(task);
    const at = task.finishedAt || protocol.nowIso();
    const record = { at, taskId: task.id, status: task.status, summary, error: task.error || null };
    const existing = goal.checks.find((check) => check && check.taskId === task.id);
    if (existing) {
      Object.assign(existing, record);
    } else {
      goal.checks.push(record);
      if (goal.checks.length > MAX_CHECKS) goal.checks.splice(0, goal.checks.length - MAX_CHECKS);
    }
    // 目标可能同时关联着另一个仍在跑的任务：这时不要清 runningTaskId，也不重排下次跟进。
    const stillRunning = goal.runningTaskId !== task.id && this._goalActiveTask(goal.runningTaskId);
    if (!stillRunning) {
      goal.runningTaskId = null;
      goal.pendingApproval = null;
    }
    goal.lastCheckAt = at;
    goal.lastCheckStatus = task.status;
    goal.lastTaskId = task.id;
    goal.lastSummary = summary;
    if (goal.status === 'active' && !stillRunning) {
      goal.nextCheckAt = computeNextCheckAt(goal.schedule, Date.now());
    }
    goal.updatedAt = protocol.nowIso();
    this.broadcast('goal.updated', { goal: goalToJson(goal), at: goal.updatedAt });
    this.log('info', `长期目标检查完成：${goal.id}（${task.status}）`);
    this._journalGoalCheck(goal, task, summary);
    this.schedulePersist();
  }

  // ---------------------------------------------------------------- 心智（Soul / Skill）

  /** 对外心智 JSON（含默认值、上限与字数）。 */
  getMind() {
    return mindToJson(this.mind);
  }

  /** 更新灵魂 / 工作流程；支持 resetSoul、resetSkill 恢复默认。 */
  updateMind(patch = {}) {
    const normalized = normalizeMindPatch(patch, this.mind);
    if (!normalized.ok) throw badRequest(normalized.errors.join('；'));
    this.mind = {
      soul: normalized.value.soul,
      skill: normalized.value.skill,
      updatedAt: protocol.nowIso(),
    };
    const mind = this.getMind();
    this.broadcast('mind.updated', { mind, at: this.mind.updatedAt }, { record: false });
    this.log('info', `心智更新：灵魂 ${mind.soulChars} 字 / 工作流程 ${mind.skillChars} 字`);
    this.schedulePersist();
    return mind;
  }

  // ---------------------------------------------------------------- 自主大脑

  /** 持久化到 state.json 的大脑精简结构（不含运行态 thinking）。 */
  _brainStateForPersist() {
    return {
      enabled: this.brain.enabled,
      mode: this.brain.mode,
      intervalSec: this.brain.intervalSec,
      maxActions: this.brain.maxActions,
      model: this.brain.model,
      adaptive: this.brain.adaptive,
      idleStreak: this.brain.idleStreak,
      effectiveIntervalSec: this.brain.effectiveIntervalSec,
      nextThinkAt: this.brain.nextThinkAt,
      skippedCycles: this.brain.skippedCycles,
      consecutiveFailures: this.brain.consecutiveFailures,
      lastThinkAt: this.brain.lastThinkAt,
      lastError: this.brain.lastError,
      lastSummary: this.brain.lastSummary,
      lastAssessment: this.brain.lastAssessment,
      ownerAsk: this.brain.ownerAsk,
      ownerReply: this.brain.ownerReply || null,
      // 咨询 worker 的回答与管家长期记忆：跨轮/跨重启都要保留。
      consultations: util.arr(this.brain.consultations).map((item) => ({ ...item })),
      notes: util.arr(this.brain.notes).map((item) => ({ ...item })),
      decisions: this.brain.decisions.slice(-30).map((decision) => ({ ...decision })),
    };
  }

  getBrain() {
    const json = brainToJson(this.brain, { decisions: 10 });
    json.thinking = Boolean(this._brainThinking);
    return json;
  }

  /** 决策历史（最新在前）。 */
  listBrainDecisions(limit = 20) {
    const safe = util.clampInt(limit, 20, 1, 30);
    return this.brain.decisions
      .slice(-safe)
      .reverse()
      .map((decision) => JSON.parse(JSON.stringify(decision)));
  }

  /** 更新大脑设置（enabled/mode/intervalSec/maxActions/model/adaptive/ownerAskAck）。 */
  updateBrain(patch = {}) {
    const normalized = normalizeBrainPatch(patch, this.brain);
    if (!normalized.ok) throw badRequest(normalized.errors.join('；'));
    const value = { ...normalized.value };
    const ackOwnerAsk = value.ownerAskAck === true;
    delete value.ownerAskAck;
    const modelChanged =
      Object.prototype.hasOwnProperty.call(value, 'model') && value.model !== this.brain.model;
    Object.assign(this.brain, value);
    if (ackOwnerAsk) this.brain.ownerAsk = null;
    if (value.enabled === true) {
      this.brain.lastError = null;
      this.brain.consecutiveFailures = 0;
    }
    if (value.intervalSec !== undefined || value.adaptive !== undefined) {
      // 改基准间隔/切换自适应后，从新基准重新开始，不保留旧的宽松间隔。
      this.brain.idleStreak = 0;
      this.brain.consecutiveFailures = 0;
      this.brain.effectiveIntervalSec = this.brain.intervalSec;
    }
    if (value.enabled === true) {
      // 重新启用后尽快思考一次。
      this.brain.nextThinkAt = protocol.nowIso();
    } else if (value.intervalSec !== undefined || value.adaptive !== undefined) {
      this._rescheduleBrainFromNow();
    }
    if (modelChanged && !this._brainThinkInjected) {
      this._brainThinker = null;
      this._brainThinkerModel = null;
    }
    const at = protocol.nowIso();
    this.broadcast('brain.updated', { brain: this.getBrain(), at });
    this.log(
      'info',
      `自主大脑设置更新：enabled=${this.brain.enabled} mode=${this.brain.mode} interval=${this.brain.intervalSec}s adaptive=${this.brain.adaptive !== false}`,
    );
    this.schedulePersist();
    return this.getBrain();
  }

  /**
   * 主人在通知栏/控制台里选择了 ownerAsk 的某个选项：
   * 记录选择供下一轮思考使用，并清除当前提问；没有选项时用 PATCH /api/brain {ownerAskAck:true} 确认。
   */
  chooseBrainOwnerAsk(optionId) {
    const ask = this.brain.ownerAsk;
    if (!ask) throw badRequest('当前没有等待主人决定的问题');
    const id = util.str(optionId, 40).trim();
    if (!id) throw badRequest('缺少选项 id');
    const picked = util.arr(ask.options).find((item) => item && item.id === id);
    if (!picked) throw badRequest('无效的选项');
    this.brain.ownerReply = {
      optionId: picked.id,
      label: picked.label,
      question: ask.text,
      goalId: ask.goalId || null,
      at: protocol.nowIso(),
    };
    this.brain.ownerAsk = null;
    const at = protocol.nowIso();
    this.broadcast('brain.updated', { brain: this.getBrain(), at });
    this.log('info', `主人选择（大脑提问）：${util.truncate(picked.label, 60)}`);
    this.schedulePersist();
    return this.getBrain();
  }

  /**
   * 主人回复大脑：可以是选项之外的文字，也可以在没有待决定问题时主动给方向
   * （例如「先放弃自动化，手动补投递」）。写入 ownerReply 供下一轮思考使用。
   */
  replyBrainOwnerAsk(text) {
    const ask = this.brain.ownerAsk || null;
    const reply = util.str(text, MAX_OWNER_REPLY_LENGTH).trim();
    if (!reply) throw badRequest('缺少回复内容');
    this.brain.ownerReply = {
      optionId: null,
      label: util.truncate(reply, 40),
      text: reply,
      question: ask ? ask.text : '',
      goalId: ask && ask.goalId ? ask.goalId : null,
      at: protocol.nowIso(),
    };
    this.brain.ownerAsk = null;
    const at = protocol.nowIso();
    this.broadcast('brain.updated', { brain: this.getBrain(), at });
    this.log('info', `主人回复（大脑）：${util.truncate(reply, 60)}`);
    this.schedulePersist();
    return this.getBrain();
  }

  /** 按当前节律从「现在」重新排下一次思考（改间隔 / 开关自适应时用）。 */
  _rescheduleBrainFromNow() {
    if (!this.brain.enabled) {
      this.brain.nextThinkAt = null;
      return;
    }
    const base = this.brain.intervalSec;
    if (this.brain.adaptive === false) {
      this.brain.idleStreak = 0;
      this.brain.effectiveIntervalSec = base;
      this.brain.nextThinkAt = new Date(Date.now() + base * 1000).toISOString();
      return;
    }
    const current = util.clampInt(
      Number(this.brain.effectiveIntervalSec),
      base,
      base,
      idleIntervalCapSec(base),
    );
    this.brain.effectiveIntervalSec = current;
    this.brain.nextThinkAt = new Date(Date.now() + current * 1000).toISOString();
  }

  /**
   * 统计「有活」信号：判断这一轮值不值得花 token 让模型思考。
   * @returns {{busy:boolean, counts:object}}
   */
  _brainWorkload(nowMs = Date.now()) {
    let activeTasks = 0;
    let waitingTasks = 0;
    let queuedTasks = 0;
    let retryable = 0;
    for (const task of this.tasks.values()) {
      if (task.archived || task.trashedAt) continue;
      if (ACTIVE_TASK_STATUSES.has(task.status)) {
        activeTasks += 1;
        if (task.status === TASK_STATUS.WAITING) waitingTasks += 1;
      } else if (task.status === TASK_STATUS.QUEUED) {
        queuedTasks += 1;
      } else if (
        task.status === TASK_STATUS.FAILED
        || task.status === TASK_STATUS.TIMEOUT
        || task.status === TASK_STATUS.CANCELLED
      ) {
        const maxAttempts = Number.isFinite(Number(task.maxAttempts)) ? Number(task.maxAttempts) : 1;
        const attempts = Number.isFinite(Number(task.attempts)) ? Number(task.attempts) : 0;
        // 用户手动取消的任务不算「有活」：否则 busy 会保持一整天，大脑无法降频省 token。
        // 只有 failed / timeout 且还有剩余重试次数的任务才算值得思考的活。
        if (task.status !== TASK_STATUS.CANCELLED && attempts < maxAttempts) retryable += 1;
      }
    }
    let approvals = 0;
    try {
      approvals = util.arr(this.listApprovals()).length;
    } catch {
      approvals = 0;
    }
    let onlineDevices = 0;
    for (const device of this.devices.values()) {
      if (device.online) onlineDevices += 1;
    }
    const windowMs = Math.max(120, Number(this.brain.intervalSec) || 180) * 2000;
    let dueGoals = 0;
    for (const goal of this.goals.values()) {
      if (goal.status !== 'active') continue;
      if (goal.runningTaskId || goal.pendingApproval) {
        dueGoals += 1;
        continue;
      }
      const nextAt = Date.parse(goal.nextCheckAt || '');
      if (Number.isFinite(nextAt) && nextAt <= nowMs + windowMs) dueGoals += 1;
    }
    const busy =
      activeTasks > 0
      || retryable > 0
      || approvals > 0
      || dueGoals > 0
      || (queuedTasks > 0 && onlineDevices > 0);
    return {
      busy,
      counts: { activeTasks, waitingTasks, queuedTasks, retryable, approvals, dueGoals, onlineDevices },
    };
  }

  /** 上次思考之后，任务/目标/审批/心路/头脑风暴是否有新变化。 */
  _brainHasNewSignalsSince(iso) {
    const base = Date.parse(iso || '');
    if (!Number.isFinite(base)) return true;
    const changed = (value) => {
      const at = Date.parse(value || '');
      return Number.isFinite(at) && at > base;
    };
    for (const task of this.tasks.values()) {
      if (task.archived || task.trashedAt) continue;
      if (changed(task.createdAt) || changed(task.updatedAt) || changed(task.finishedAt)) return true;
    }
    for (const goal of this.goals.values()) {
      if (changed(goal.updatedAt) || changed(goal.lastCheckAt)) return true;
    }
    for (const approval of util.arr(this.listApprovals())) {
      if (changed(approval.createdAt) || changed(approval.approval && approval.approval.at)) return true;
    }
    for (const entry of util.arr(this.journal && this.journal.entries).slice(-20)) {
      // 大脑自己写的「思考」条目不算新信号，否则每轮都会把自己叫醒。
      if (entry && entry.kind === 'thought') continue;
      if (changed(entry.at)) return true;
    }
    for (const session of util.arr(this.brainstorm && this.brainstorm.sessions)) {
      if (changed(session.updatedAt)) return true;
    }
    return false;
  }

  /** 没有活时跳过模型调用，并按 2 倍退避拉长间隔。 */
  _brainIdleSkip() {
    this.brain.skippedCycles = util.clampInt(Number(this.brain.skippedCycles) + 1, 0, 0, 1000);
    this.brain.idleStreak = util.clampInt(Number(this.brain.idleStreak) + 1, 0, 0, 20);
    this._brainApplyInterval();
    this.log(
      'debug',
      `自主大脑空闲：跳过本轮思考（无新变化），下次 ${this.brain.nextThinkAt}（间隔 ${this.brain.effectiveIntervalSec}s）`,
    );
    this.broadcast('brain.updated', {
      brain: this.getBrain(),
      at: protocol.nowIso(),
      skipped: true,
    });
    this.schedulePersist();
  }

  /** 按 idleStreak / 连续失败次数计算实际间隔与下一次思考时间。 */
  _brainApplyInterval() {
    const base = this.brain.intervalSec;
    if (this.brain.adaptive === false) {
      this.brain.effectiveIntervalSec = base;
      this.brain.nextThinkAt = new Date(Date.now() + base * 1000).toISOString();
      return;
    }
    const streak = util.clampInt(Number(this.brain.idleStreak), 0, 0, 20);
    const failures = util.clampInt(Number(this.brain.consecutiveFailures), 0, 0, 6);
    // 空闲与连续失败共用指数退避：取两者较大值，退避上限随基准间隔放大（见 idleIntervalCapSec）。
    const exponent = Math.max(streak, failures);
    const cap = idleIntervalCapSec(base);
    const effective = Math.min(base * Math.pow(2, exponent), cap);
    this.brain.effectiveIntervalSec = effective;
    this.brain.nextThinkAt = new Date(Date.now() + effective * 1000).toISOString();
  }

  /** 思考结束后更新节律：有活/有动作 → 回到基准；真没活 → 逐步拉长；失败 → 失败退避。 */
  _brainUpdateCadence(decision, workload) {
    const current = workload || this._brainCycleWorkload || this._brainWorkload();
    const executed = util.arr(decision && decision.actions).some((action) => action.executed);
    const failed = Boolean(decision && decision.error);
    if (failed) {
      // 连续失败按 2 倍退避，隔一段时间再试，避免模型故障时每个基准间隔都白烧一次。
      this.brain.consecutiveFailures = util.clampInt(
        Number(this.brain.consecutiveFailures) + 1,
        0,
        0,
        6,
      );
      this.brain.idleStreak = 0;
    } else {
      this.brain.consecutiveFailures = 0;
      if (current.busy || executed) {
        this.brain.idleStreak = 0;
      } else {
        this.brain.idleStreak = util.clampInt(Number(this.brain.idleStreak) + 1, 0, 0, 20);
      }
    }
    this.brain.skippedCycles = 0;
    this._brainApplyInterval();
    this.log(
      'debug',
      `自主大脑节律：busy=${current.busy} executed=${executed} failures=${this.brain.consecutiveFailures} 下轮间隔 ${this.brain.effectiveIntervalSec}s`,
    );
  }

  /** 定时器触发的自动思考：只在启用、未在思考、且已到下一次思考时间时执行。 */
  runBrainCycle() {
    if (this._closed || !this.brain.enabled) return Promise.resolve(null);
    if (this._brainThinking) return Promise.resolve(this._brainThinking);
    const nextAt = Date.parse(brainToJson(this.brain, { decisions: 0 }).nextThinkAt || '');
    if (Number.isFinite(nextAt) && nextAt > Date.now()) return Promise.resolve(null);
    // 省 token：没有活、且自上次思考后没有任何新变化时，直接跳过模型调用并拉长间隔。
    // 至少真实思考过一次（有决策记录）才允许跳过，避免重启后一直空转。
    // 工作量只评估一次（runBrainCycle 计算，思考结束后复用，见 P1 优化）。
    this._brainCycleWorkload = null;
    if (this.brain.adaptive !== false && this.brain.lastThinkAt && this.brain.decisions.length > 0) {
      const workload = this._brainWorkload();
      this._brainCycleWorkload = workload;
      if (!workload.busy && !this._brainHasNewSignalsSince(this.brain.lastThinkAt)) {
        this._brainIdleSkip();
        return Promise.resolve(null);
      }
    }
    return this.requestBrainThink({ trigger: 'schedule', workload: this._brainCycleWorkload }).catch((err) => {
      this.log('warn', `自主大脑思考失败：${err && err.message ? err.message : err}`);
      return null;
    });
  }

  /**
   * 立即思考一次（手动按钮/自动定时共用）。
   * 思考中重复调用会复用同一个 Promise；错误只写进 decision/lastError，不抛给调用方。
   * @param {{trigger?: 'manual'|'schedule', workload?: object|null}} [options]
   */
  requestBrainThink({ trigger = 'manual', workload = null } = {}) {
    if (this._closed) return Promise.resolve(null);
    if (this._brainThinking) return this._brainThinking;
    const pending = this._runBrainThink(trigger, workload).finally(() => {
      if (this._brainThinking === pending) this._brainThinking = null;
    });
    this._brainThinking = pending;
    return pending;
  }

  _getBrainThinker() {
    if (this._brainThinkInjected) return this.brainThink;
    const model = this.brain.model || null;
    if (!this._brainThinker || this._brainThinkerModel !== model) {
      this._brainThinker = createBrainThinker({ model });
      this._brainThinkerModel = model;
    }
    return this._brainThinker;
  }

  async _runBrainThink(trigger = 'schedule', workload = null) {
    const startedAt = Date.now();
    const decision = {
      id: protocol.randomId('brain'),
      at: protocol.nowIso(),
      trigger: trigger === 'manual' ? 'manual' : 'schedule',
      mode: this.brain.mode,
      model: this.brain.model || null,
      durationMs: 0,
      summary: '',
      assessment: null,
      ownerAsk: null,
      actions: [],
      error: null,
    };
    try {
      const snapshot = this._brainSnapshot();
      const prompt = buildBrainPrompt(snapshot, { mind: this.mind, maxActions: this.brain.maxActions });
      const think = this._getBrainThinker();
      const reply = await think(prompt);
      let parsed;
      try {
        parsed = parseBrainReply(reply);
      } catch (err) {
        // 模型偶尔会输出解释文字、Markdown 围栏或截断的 JSON：带修复提示重试一次，
        // 成功就照常决策；仍失败才记为错误（错误里带输出开头，方便在控制台定位）。
        if (!isBrainParseFailure(err)) throw err;
        this.log('warn', `自主大脑输出无法解析，带修复提示重试一次：${err.message}`);
        parsed = parseBrainReply(
          await think({
            system: prompt.system,
            user: `${prompt.user}\n\n【重要】你上一次的输出无法解析为 JSON（${err.message}）。请重新只输出一个完整合法的 JSON 对象：不要 Markdown 代码围栏、不要任何解释；字符串正确转义、括号闭合；内容过长时压缩 assessment 与 instruction。`,
          }),
        );
      }
      decision.summary = parsed.summary;
      decision.assessment = parsed.assessment;
      decision.ownerAsk = parsed.ownerAsk;
      this.brain.lastAssessment = parsed.assessment;
      this.brain.ownerAsk = parsed.ownerAsk;
      if (this.brain.mode === 'auto') {
        this._applyBrainActions(decision, parsed.actions);
      } else {
        decision.actions = parsed.actions.map((action) => ({
          ...action,
          executed: false,
          skippedReason: '建议模式（未执行）',
          error: null,
        }));
      }
      this.brain.lastError = null;
      this.brain.lastSummary = parsed.summary;
    } catch (err) {
      decision.error = err && err.message ? err.message : String(err);
      this.brain.lastError = decision.error;
      this.log('warn', `自主大脑思考失败（${decision.trigger}）：${decision.error}`);
    } finally {
      decision.durationMs = Date.now() - startedAt;
      this.brain.lastThinkAt = protocol.nowIso();
      this._brainUpdateCadence(decision, workload);
      recordBrainDecision(this.brain, decision);
      // 主人上一轮的选项已被本轮思考消费，清空以免重复引用。
      this.brain.ownerReply = null;
      this.broadcast('brain.updated', { brain: this.getBrain(), at: this.brain.lastThinkAt });
      this._journalBrainDecision(decision);
      this.schedulePersist();
    }
    const executed = decision.actions.filter((action) => action.executed).length;
    if (!decision.error) {
      this.log(
        'info',
        `自主大脑（${decision.trigger}）：${util.truncate(decision.summary || '无结论', 80)}${executed ? `，执行 ${executed} 个动作` : '，无动作'}｜下轮 ${this.brain.effectiveIntervalSec}s${decision.ownerAsk ? '｜需要主人' : ''}`,
      );
    }
    return decision;
  }

  /** 大脑输入快照：目标、可行动任务、最近决策、设备、待确认提案（结构见 docs/GOAL-BRAIN-DESIGN.md §2.4）。 */
  _brainSnapshot() {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const actionable = [];
    const recentDone = [];
    for (const task of this.tasks.values()) {
      if (task.archived || task.trashedAt) continue;
      if (
        ACTIVE_TASK_STATUSES.has(task.status)
        || task.status === TASK_STATUS.QUEUED
        || task.status === TASK_STATUS.FAILED
        || task.status === TASK_STATUS.TIMEOUT
      ) {
        actionable.push(task);
        continue;
      }
      // 已完成只保留最近 24h 的少量样本；cancelled 等噪音状态一律不喂给模型。
      if (task.status !== TASK_STATUS.COMPLETED) continue;
      const finishedAt = Date.parse(task.finishedAt || task.updatedAt || '');
      if (Number.isFinite(finishedAt) && finishedAt >= cutoff) recentDone.push(task);
    }
    // 失败/等待/执行中的任务排前面，其余按更新时间倒序；总量封顶 24 + 8。
    const priority = (status) => {
      if (status === TASK_STATUS.FAILED || status === TASK_STATUS.TIMEOUT) return 0;
      if (status === TASK_STATUS.WAITING) return 1;
      if (status === TASK_STATUS.RUNNING || status === TASK_STATUS.ASSIGNED) return 2;
      return 3; // queued
    };
    const byUpdatedAtDesc = (a, b) =>
      String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''));
    actionable.sort((a, b) => priority(a.status) - priority(b.status) || byUpdatedAtDesc(a, b));
    recentDone.sort((a, b) =>
      String(b.finishedAt || b.updatedAt || '').localeCompare(String(a.finishedAt || a.updatedAt || '')),
    );
    const picked = [...actionable.slice(0, 24), ...recentDone.slice(0, 8)];
    const tasks = picked.map((task) => {
      const progress = util.isPlainObject(task.progress) ? task.progress : null;
      const children = util
        .arr(task.childTaskIds)
        .map((id) => this.tasks.get(id))
        .filter(Boolean);
      const events = util.arr(task.events);
      const last = events.length ? events[events.length - 1] : null;
      return {
        id: task.id,
        instruction: util.truncate(task.instruction || '', 300),
        status: task.status,
        goalId: task.goalId || null,
        project: util.isPlainObject(task.requirements) && task.requirements.project ? util.str(task.requirements.project, 120) : null,
        assignedDeviceId: task.assignedDeviceId || null,
        isPlan: Boolean(task.isPlan),
        parentTaskId: task.parentTaskId || null,
        threadId: task.threadId || null,
        attempts: task.attempts,
        maxAttempts: task.maxAttempts,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        finishedAt: task.finishedAt || null,
        error: task.error ? util.truncate(task.error, 300) : null,
        progress: progress
          ? {
              message: util.str(progress.message, 300) || '',
              percent: Number.isFinite(Number(progress.percent)) ? Math.trunc(Number(progress.percent)) : 0,
              waiting: progress.waiting === true,
              question: util.str(progress.question, 300) || null,
            }
          : null,
        planStep: task.planStep || null,
        dependsOn: util.arr(task.planDependsOnTaskIds).slice(0, 6),
        childProgress:
          task.isPlan && children.length
            ? {
                total: children.length,
                completed: children.filter((child) => child.status === TASK_STATUS.COMPLETED).length,
                failed: children.filter(
                  (child) =>
                    child.status === TASK_STATUS.FAILED ||
                    child.status === TASK_STATUS.TIMEOUT ||
                    child.status === TASK_STATUS.CANCELLED,
                ).length,
                running: children.filter(
                  (child) => child.status === TASK_STATUS.ASSIGNED || child.status === TASK_STATUS.RUNNING,
                ).length,
                waiting: children.filter((child) => child.status === TASK_STATUS.WAITING).length,
              }
            : null,
        assignedDeviceName: task.assignedDeviceName || null,
        lastEvent: last
          ? { at: last.at, type: last.type, message: util.truncate(last.message || '', 200) }
          : null,
      };
    });
    const goals = [...this.goals.values()].map((goal) => ({
      id: goal.id,
      title: goal.title,
      nickname: goal.nickname || '',
      status: goal.status,
      schedule: goal.schedule,
      nextCheckAt: goal.nextCheckAt || null,
      lastCheckStatus: goal.lastCheckStatus || null,
      lastSummary: util.truncate(goal.lastSummary || '', 400),
      guidance: util.arr(goal.guidance).slice(-3).map((entry) => ({
        text: util.str(entry && entry.text, 300),
        createdAt: (entry && entry.createdAt) || null,
      })),
      taskIds: util.arr(goal.taskIds).slice(-20),
      runningTaskId: goal.runningTaskId || null,
      pendingApproval: goal.pendingApproval
        ? {
            reason: util.str(goal.pendingApproval.reason, 200),
            at: goal.pendingApproval.at || null,
          }
        : null,
      linkedStats: this._goalLinkedStats(goal),
    }));
    const approvals = this.listApprovals().map((entry) => ({
      goalId: entry.goalId,
      goalTitle: entry.goalTitle,
      createdAt: entry.createdAt,
      reason: util.str(entry.approval && entry.approval.reason, 200),
    }));
    const devices = [...this.devices.values()].map((device) => ({
      id: device.id,
      name: deviceDisplayName(device),
      kind: device.kind,
      online: Boolean(device.online && !device.disabled),
      tags: [...(device.tags || [])].slice(0, 5),
      load: {
        running: device.load ? device.load.running : 0,
        max: this._maxConcurrent(device),
      },
    }));
    // 决策记忆：最近 3 轮结论与动作结果，让模型知道哪些动作刚被拒绝、避免重复。
    const decisions = this.brain.decisions.slice(-3).map((item) => ({
      at: item.at || null,
      summary: util.truncate(item.summary || '', 160),
      ownerAsk: item.ownerAsk && item.ownerAsk.text ? util.truncate(item.ownerAsk.text, 200) : null,
      actions: util.arr(item.actions).slice(0, 3).map((action) => ({
        action: action.action,
        taskId: action.taskId || null,
        goalId: action.goalId || null,
        executed: action.executed === true,
        skippedReason: action.skippedReason || null,
        error: action.error ? util.truncate(action.error, 80) : null,
      })),
    }));
    const pathAudit = this._brainPathAudit(picked);
    // 项目 ↔ 主机：大脑据此把「问哪台设备」一步到位；咨询记录与管家记忆给跨轮上下文。
    const projectHosts = this._brainProjectHosts();
    const consultations = this.brain.consultations.slice(-5).map((item) => ({
      at: item.at || null,
      deviceId: item.deviceId || null,
      deviceName: item.deviceName || null,
      project: item.project || null,
      question: util.truncate(item.question || '', 200),
      answer: util.truncate(item.answer || '', 400),
      ok: item.ok === true,
    }));
    const notes = this.brain.notes.slice(-8).map((item) => ({
      at: item.at || null,
      text: util.truncate(item.text || '', 300),
    }));
    return {
      now: protocol.nowIso(),
      stats: this.stats(),
      goals,
      tasks,
      decisions,
      approvals,
      devices,
      ownerReply: this.brain.ownerReply || null,
      pathAudit,
      projectHosts,
      consultations,
      notes,
      host: { user: os.userInfo().username, platform: process.platform },
    };
  }

  /**
   * 项目 → 主机映射：让大脑知道「这个问题该问谁」。
   * 优先用成功执行过的项目亲和，其次用最近任务的执行设备补齐。
   * @returns {Array<{project:string,deviceId:string,deviceName:string|null,source:'affinity'|'task'}>}
   */
  _brainProjectHosts() {
    const entries = new Map();
    for (const [project, deviceId] of this.projectAffinity) {
      entries.set(project, { project, deviceId, deviceName: null, source: 'affinity' });
    }
    const recent = [...this.tasks.values()]
      .filter((task) => util.isPlainObject(task.requirements) && task.requirements.project && task.assignedDeviceId)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .slice(0, 60);
    for (const task of recent) {
      const project = util.str(task.requirements.project, 120);
      if (!project || entries.has(project)) continue;
      entries.set(project, {
        project,
        deviceId: task.assignedDeviceId,
        deviceName: task.assignedDeviceName || null,
        source: 'task',
      });
    }
    // 亲和表按写入顺序保存；取最近写入的 10 个项目，避免旧项目挤掉新项目。
    return [...entries.values()].slice(-10).map((entry) => {
      const device = this.devices.get(entry.deviceId);
      return { ...entry, deviceName: entry.deviceName || (device ? deviceDisplayName(device) : null) };
    });
  }

  /**
   * 大脑路径核查：从失败/排队任务的文件引用里提取路径，在 Hub 主机上探测存在性。
   * 目的：文件在不在母机是机器可查的事实，不能让大脑把这种问题升级成 ownerAsk。
   * @param {Array<object>} tasks
   * @returns {Array<{ref:string,status:'exists'|'missing'|'candidates',paths:string[]}>}
   */
  _brainPathAudit(tasks) {
    const refs = [];
    const seen = new Set();
    const lower = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
    const addRef = (raw) => {
      const value = util
        .str(raw, 200)
        .replace(/^[\s（("'`]+/, '')
        .replace(/[\s"'`，。；：、）)\]】>,。]+$/, '')
        .trim();
      if (value.length < 3) return;
      const key = lower(value);
      if (seen.has(key)) return;
      seen.add(key);
      refs.push(value);
    };
    const taskText = (task) =>
      [task.instruction, task.error, task.progress && task.progress.message, task.lastEvent && task.lastEvent.message]
        .filter(Boolean)
        .join('\n');
    for (const task of tasks) {
      const text = taskText(task);
      if (!text) continue;
      for (const match of text.matchAll(/[A-Za-z]:[\\/][^\s"'<>|，。；、）】]+/g)) addRef(match[0]);
      for (const match of text.matchAll(/(?:^|[\s（("'`])(\/[^\s"'<>|，。；、）】]+(?:\/[^\s"'<>|，。；、）】]*)+)/g)) {
        addRef(match[1]);
      }
      if (refs.length >= 10) break;
    }
    // 裸文件名：绝对路径里已经出现的同名文件不重复探测。
    const absKeys = refs.map((ref) => lower(ref.replace(/\\/g, '/')));
    for (const task of tasks) {
      const text = taskText(task);
      if (!text) continue;
      const pattern =
        /(?:^|[\s（("'`])([A-Za-z0-9_\-]+(?:\.[A-Za-z0-9_\-]+)*\.(?:py|js|cjs|mjs|ts|json|pdf|md|txt|csv|xlsx?|docx?|zip|gz|ps1|sh|bat|cmd|ya?ml|html?|css|png|jpe?g|gif|webp|log|sqlite|db))(?=$|[\s"'<>|，。；、）】,])/gi;
      for (const match of text.matchAll(pattern)) {
        const name = match[1];
        const tail = lower(`/${name}`);
        if (absKeys.some((abs) => abs.endsWith(tail))) continue;
        addRef(name);
        if (refs.length >= 10) break;
      }
      if (refs.length >= 10) break;
    }
    if (!refs.length) return [];
    const roots = this._brainScanRoots();
    const audit = [];
    for (const ref of refs.slice(0, 8)) {
      const entry = this._probeBrainPath(ref, roots);
      if (entry) audit.push(entry);
    }
    return audit;
  }

  /** 路径核查允许扫描的根目录：BRAIN_PATH_ROOTS（path.delimiter 分隔）优先，其次仓库/工作区/桌面/下载/cwd。 */
  _brainScanRoots() {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const home = os.homedir();
    const configured = String(process.env.BRAIN_PATH_ROOTS || '')
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean);
    const roots = [
      ...configured,
      repoRoot,
      path.join(repoRoot, 'worker-workspace'),
      path.join(home, 'Desktop'),
      path.join(home, 'Downloads'),
      process.cwd(),
    ];
    const unique = [];
    for (const root of roots) {
      try {
        if (fs.statSync(root).isDirectory() && !unique.includes(root)) unique.push(root);
      } catch {
        // 不存在的根目录直接跳过（例如没有下载目录的环境）。
      }
    }
    return unique.slice(0, 8);
  }

  /** 探测单个文件引用；绝对路径直接判断，裸文件名在允许根目录内做有界搜索。 */
  _probeBrainPath(ref, roots) {
    const home = os.homedir();
    const normalized = String(ref).replace(/^~(?=[\\/])/, home);
    const isAbsolute = /^[A-Za-z]:[\\/]/.test(normalized) || normalized.startsWith('/');
    const baseName = path.basename(normalized.replace(/[\\/]+$/, ''));
    if (isAbsolute) {
      try {
        if (fs.existsSync(normalized) && fs.statSync(normalized).isFile()) {
          return { ref, status: 'exists', paths: [normalized] };
        }
      } catch {
        // 权限/坏路径按不存在处理，交给模型决定下一步。
      }
    }
    const hasExtension = /\.[A-Za-z0-9]{1,8}$/.test(baseName) && !baseName.includes('*');
    if (!hasExtension) return { ref, status: 'missing', paths: [] };
    const candidates = this._brainFindFiles(roots, baseName);
    if (candidates.length) return { ref, status: 'candidates', paths: candidates.slice(0, 3) };
    return { ref, status: 'missing', paths: [] };
  }

  /** 有界广度搜索同名文件：最多 600 个目录、深度 4、命中 3 个即停。 */
  _brainFindFiles(roots, fileName) {
    const target = fileName.toLowerCase();
    const found = [];
    const queue = roots.map((root) => ({ dir: root, depth: 0 }));
    const skip = new Set(['node_modules', '.git', '.venv', '__pycache__', 'dist', 'build', 'target', '.cache', '.hermes-test']);
    let visited = 0;
    while (queue.length && visited < 600 && found.length < 3) {
      const item = queue.shift();
      if (!item || item.depth > 4) continue;
      let entries;
      try {
        entries = fs.readdirSync(item.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      visited += 1;
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.') || skip.has(entry.name)) continue;
          queue.push({ dir: path.join(item.dir, entry.name), depth: item.depth + 1 });
        } else if (entry.isFile() && entry.name.toLowerCase() === target) {
          found.push(path.join(item.dir, entry.name));
          if (found.length >= 3) break;
        }
      }
    }
    return found;
  }

  /** 按白名单执行大脑动作（auto 模式）；单条失败不影响其它动作。 */
  _applyBrainActions(decision, actions) {
    const limit = util.clampInt(this.brain.maxActions, 2, 1, 3);
    let executed = 0;
    for (const action of util.arr(actions)) {
      const record = {
        action: action.action,
        taskId: action.taskId || null,
        goalId: action.goalId || null,
        instruction: action.instruction || '',
        reason: action.reason || '',
        confidence: action.confidence,
        ...(Number.isFinite(action.timeoutSec) ? { timeoutSec: action.timeoutSec } : {}),
        ...(util.isPlainObject(action.requirements) ? { requirements: { ...action.requirements } } : {}),
        // consult_worker 的问题 / remember 的记忆内容留档，便于控制台回溯。
        ...(action.question ? { question: action.question } : {}),
        ...(action.note ? { note: action.note } : {}),
        executed: false,
        skippedReason: null,
        error: null,
      };
      decision.actions.push(record);
      if (!BRAIN_ACTIONS.includes(action.action) || action.action === 'none') {
        record.skippedReason = '无需动作';
        continue;
      }
      if (executed >= limit) {
        record.skippedReason = '超过本轮动作上限';
        continue;
      }
      if (!(action.confidence >= MIN_AUTO_CONFIDENCE)) {
        record.skippedReason = 'low-confidence';
        continue;
      }
      try {
        const outcome = this._applyBrainAction(action);
        if (outcome && outcome.skippedReason) record.skippedReason = outcome.skippedReason;
        if (outcome && outcome.taskId) record.taskId = outcome.taskId;
        if (outcome && outcome.goalId) record.goalId = outcome.goalId;
        record.executed = !record.skippedReason;
        if (record.executed) executed += 1;
      } catch (err) {
        record.error = err && err.message ? err.message : String(err);
        this.log('warn', `自主大脑动作失败（${action.action}）：${record.error}`);
      }
    }
  }

  _applyBrainAction(action) {
    switch (action.action) {
      case 'retry_task': {
        if (!action.taskId) return { skippedReason: '缺少 taskId' };
        const task = this.tasks.get(action.taskId);
        if (!task) return { skippedReason: 'task-not-found' };
        if (task.status === TASK_STATUS.QUEUED) {
          // 排队中的计划子任务要等前置步骤，不能越权重派。
          const blockedByDependency = util.arr(task.planDependsOnTaskIds).some((id) => {
            const dependency = this.tasks.get(id);
            return !dependency || dependency.status !== TASK_STATUS.COMPLETED;
          });
          if (blockedByDependency) {
            return { skippedReason: '前置任务未完成，等待推进', taskId: task.id };
          }
          // 普通排队任务不是「失败」，重新路由一次即可；仍无可用设备时保持排队。
          this.routeTask(task);
          if (task.status === TASK_STATUS.QUEUED) {
            return { skippedReason: '暂无可用设备，任务继续排队', taskId: task.id };
          }
          return { taskId: task.id, goalId: task.goalId || null };
        }
        if (task.status === TASK_STATUS.COMPLETED) {
          return { skippedReason: '已完成任务不能 retry，续做请用 resume_thread', taskId: task.id };
        }
        if (!TERMINAL_TASK_STATUSES.has(task.status)) {
          return { skippedReason: '任务不在可重试状态' };
        }
        if (task.attempts >= task.maxAttempts) return { skippedReason: '已用尽重试次数' };
        this.retryTask(task);
        return { taskId: task.id };
      }
      case 'resume_thread': {
        if (!action.taskId) return { skippedReason: '缺少 taskId' };
        const task = this.tasks.get(action.taskId);
        if (!task) return { skippedReason: 'task-not-found' };
        if (!TERMINAL_TASK_STATUSES.has(task.status)) return { skippedReason: '任务尚未结束' };
        const instruction = action.instruction || '继续此任务并推进下一步';
        const followUp = this.createFollowUp(task, { instruction });
        return { taskId: followUp.id };
      }
      case 'update_task': {
        if (!action.taskId) return { skippedReason: '缺少 taskId' };
        const task = this.tasks.get(action.taskId);
        if (!task) return { skippedReason: 'task-not-found' };
        const patch = {};
        if (util.isPlainObject(action.requirements)) patch.requirements = action.requirements;
        if (Number.isFinite(action.priority)) patch.priority = action.priority;
        if (Number.isFinite(action.timeoutSec)) patch.timeoutSec = action.timeoutSec;
        try {
          this.updateTask(task, patch);
        } catch (err) {
          return { skippedReason: err && err.message ? err.message : String(err) };
        }
        return { taskId: task.id };
      }
      case 'create_task': {
        const instruction = String(action.instruction || '').trim();
        if (instruction.length < 4) return { skippedReason: '缺少可执行的任务指令' };
        const goalId = action.goalId && this.goals.has(action.goalId) ? action.goalId : null;
        // 同目标并发闸：同一长期目标下已有在途任务时不再新建，只允许 retry/resume/cancel。
        // 这是 task_4wr9z4vy / task_kwakhe4f 这类「同一件事排两次」的直接来源。
        const activeForGoal = this._activeTaskForGoal(goalId);
        if (activeForGoal) {
          return {
            skippedReason: `同目标已有在途任务 ${activeForGoal.id}（${activeForGoal.status}），请用 retry_task/resume_thread 推进`,
          };
        }
        // 去重升级：去掉空白/标点/大小写后前 60 字相同即视为同一件事（旧版只比前 40 字原样前缀，标点一变就漏）。
        const duplicate = this._findDuplicateTask(instruction, goalId);
        if (duplicate) return { skippedReason: 'duplicate' };

        // 队列健康（P2）：已有任务排队超过 queueStuckMs 时不再新建，先处理积压。
        const stuck = this._oldestStuckQueuedTask();
        if (stuck) {
          const hours = Math.max(1, Math.round((Date.now() - Date.parse(stuck.createdAt)) / 3600000));
          return {
            skippedReason: `队列积压：${stuck.id} 已排队约 ${hours}h，本轮先处理排队任务（update_task 改需求 / retry_task / cancel），不要再新建`,
          };
        }
        // 大脑常把项目名/任务名当设备标签（如「反腐AI」「验证」）：有项目时学成项目别名保留，
        // 设备做过该项目后会自动匹配；没有项目时才丢弃无人声明的标签，避免任务永远卡在 queued。
        const rawRequirements = util.isPlainObject(action.requirements) ? action.requirements : null;
        const { requirements, droppedTags, learnedTags } = this._sanitizeBrainRequirements(rawRequirements);
        if (learnedTags.length) {
          this.log(
            'info',
            `自主大脑 create_task 把标签登记为项目别名：${learnedTags.join('、')}（项目「${requirements.project}」做过之后自动匹配）`,
          );
        }
        if (droppedTags.length) {
          this.log(
            'warn',
            `自主大脑 create_task 忽略了不存在的设备标签：${droppedTags.join('、')}（没有设备声明这些标签）`,
          );
        }
        const created = this.createTask({
          instruction,
          goalId,
          priority: 5,
          // 自主大脑新建任务默认 600s：300s 对多步文件/分析任务常常不够（task_yfllwarp 复盘）。
          timeoutSec: Number.isFinite(action.timeoutSec) ? action.timeoutSec : 600,
          ...(requirements ? { requirements } : {}),
          context: { brain: true, reason: action.reason || '' },
        });
        return { taskId: created.id, goalId: created.goalId };
      }
      case 'link_task': {
        if (!action.goalId || !action.taskId) return { skippedReason: '缺少 goalId 或 taskId' };
        if (!this.goals.has(action.goalId)) return { skippedReason: 'goal-not-found' };
        if (!this.tasks.has(action.taskId)) return { skippedReason: 'task-not-found' };
        this.linkGoalTask(action.goalId, action.taskId);
        return { goalId: action.goalId, taskId: action.taskId };
      }
      case 'consult_worker': {
        const question = String(action.question || '').trim();
        if (question.length < 6) return { skippedReason: '缺少可回答的咨询问题' };
        const requirements = util.isPlainObject(action.requirements) ? action.requirements : {};
        const targetId = util.str(requirements.deviceId, 80);
        if (!targetId) return { skippedReason: 'consult_worker 需要 requirements.deviceId（指定问哪台设备）' };
        const device = this.devices.get(targetId);
        if (!device) return { skippedReason: 'device-not-found' };
        if (device.disabled) return { skippedReason: '目标设备已禁用' };
        const busy = [...this.tasks.values()].find(
          (task) => task.consult && task.consult.deviceId === targetId && !TERMINAL_TASK_STATUSES.has(task.status),
        );
        if (busy) return { skippedReason: '同一设备已有进行中的咨询', taskId: busy.id };
        const project = util.str(requirements.project, 120) || null;
        const created = this.createTask({
          // 只读咨询：明确告诉设备只回答、不改文件，避免把「问事实」变成副作用操作。
          instruction: `【只读咨询】${question}\n\n请只回答问题，不要修改任何文件或执行有副作用的操作；回答尽量简短（≤400 字），给出具体路径/结论。`,
          priority: 7,
          timeoutSec: 300,
          requirements: { deviceId: targetId, ...(project ? { project } : {}) },
          context: { brain: true, consult: true, reason: action.reason || '' },
        });
        created.consult = { question, deviceId: targetId, project };
        this.broadcast('task.updated', { task: this.taskToJson(created) });
        return { taskId: created.id, goalId: created.goalId || null };
      }
      case 'remember': {
        const note = String(action.note || '').trim();
        if (note.length < 4) return { skippedReason: '缺少要记住的内容' };
        return this._rememberBrainNote(note);
      }
      default:
        return { skippedReason: 'unknown-action' };
    }
  }

  /** 写入一条管家记忆（长期上下文）；完全相同的内容不重复记。 */
  _rememberBrainNote(text) {
    const note = util.str(text, 400).trim();
    if (note.length < 4) return { skippedReason: '缺少要记住的内容' };
    if (this.brain.notes.some((item) => item.text === note)) return { skippedReason: '这条记忆已存在' };
    this.brain.notes.push({ at: protocol.nowIso(), text: note });
    if (this.brain.notes.length > MAX_NOTES) {
      this.brain.notes.splice(0, this.brain.notes.length - MAX_NOTES);
    }
    const at = protocol.nowIso();
    this.broadcast('brain.updated', { brain: this.getBrain(), at });
    this.log('info', `管家记忆写入：${util.truncate(note, 60)}`);
    this.schedulePersist();
    return {};
  }

  /** 咨询任务结束后，把设备的回答记进大脑的「咨询记录」，下一轮提示词可见。 */
  _recordBrainConsultation(task, status) {
    const consult = util.isPlainObject(task.consult) ? task.consult : null;
    if (!consult || !consult.question) return;
    const output = util.isPlainObject(task.output) ? task.output : null;
    const ok = status === TASK_STATUS.COMPLETED;
    const rawAnswer = output ? output.text || output.markdown || '' : '';
    const answer = util.str(
      rawAnswer || task.error || (ok ? '（设备已完成咨询但没有返回文本）' : '（咨询任务失败）'),
      MAX_CONSULT_ANSWER,
    );
    this.brain.consultations.push({
      at: task.finishedAt || protocol.nowIso(),
      taskId: task.id,
      deviceId: task.assignedDeviceId || consult.deviceId || null,
      deviceName: task.assignedDeviceName || null,
      project: consult.project || null,
      question: consult.question,
      answer,
      ok,
    });
    if (this.brain.consultations.length > MAX_CONSULTATIONS) {
      this.brain.consultations.splice(0, this.brain.consultations.length - MAX_CONSULTATIONS);
    }
    const at = task.finishedAt || protocol.nowIso();
    this.broadcast('brain.updated', { brain: this.getBrain(), at });
    this.log(ok ? 'info' : 'warn', `大脑咨询${ok ? '已获得回答' : '失败'}：${util.truncate(consult.question, 60)}`);
    this.schedulePersist();
  }

  // ---------------------------------------------------------------- 管家心路

  /** 持久化到 state.json 的日志结构（entry/day 上限裁剪）。 */
  _journalStateForPersist() {
    const entries = this.journal.entries.slice(-MAX_ENTRIES).map((entry) => ({
      ...entry,
      refs: { ...(entry.refs || {}) },
      meta: { ...(entry.meta || {}) },
    }));
    const days = {};
    for (const key of Object.keys(this.journal.days || {}).sort().slice(-MAX_DAYS)) {
      days[key] = JSON.parse(JSON.stringify(this.journal.days[key]));
    }
    return {
      enabled: this.journal.enabled,
      summaryTime: this.journal.summaryTime,
      lastSummaryDate: this.journal.lastSummaryDate || null,
      entries,
      days,
    };
  }

  /** 心路数据（默认今天起 60 天 / 300 条）。 */
  getJournal({ entries, days, date } = {}) {
    return journalToJson(this.journal, { entries, days, date });
  }

  /** 按天倒序的汇总（不含全文条目）。 */
  listJournalDays(limit = 120) {
    const safe = util.clampInt(limit, 120, 1, MAX_DAYS);
    return Object.values(this.journal.days || {})
      .map((day) => ({
        ...day,
        entryCount: entriesForDate(this.journal, day.date).length,
        stats: Object.keys(day.stats || {}).length
          ? day.stats
          : journalStatsForDay(entriesForDate(this.journal, day.date)),
      }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .slice(0, safe);
  }

  /** 更新日志设置（enabled/summaryTime）。 */
  updateJournal(patch = {}) {
    const normalized = normalizeJournalPatch(patch, this.journal);
    if (!normalized.ok) throw badRequest(normalized.errors.join('；'));
    Object.assign(this.journal, normalized.value);
    const at = protocol.nowIso();
    this.broadcast('journal.updated', { journal: this.getJournal(), at }, { record: false });
    this.log(
      'info',
      `管家心路设置更新：enabled=${this.journal.enabled} summaryTime=${this.journal.summaryTime}`,
    );
    this.schedulePersist();
    return this.getJournal();
  }

  /** 手动追加一条心路（外部/测试/插件用）。 */
  appendJournalEntry(raw = {}) {
    return this._journalEntry(raw);
  }

  _journalEntry(raw) {
    // 关闭「自动记录」后不再写入新条目（手动触发生成当日总结仍可用）。
    if (!this.journal.enabled) return null;
    const entry = appendJournalEntry(this.journal, raw, { timeZone: systemTimeZone() });
    this.broadcast('journal.updated', {
      entry,
      dayKey: entry.date,
      at: protocol.nowIso(),
    }, { record: false });
    this.schedulePersist();
    return entry;
  }

  /** 任务结束 → 工作条目。 */
  _journalTaskFinish(task) {
    if (!task) return;
    const statusLabel = TASK_MESSAGES[task.status] || task.status;
    const output = util.isPlainObject(task.output) ? task.output : null;
    const detail = util.str((output && (output.text || output.markdown)) || task.error || '', 1500);
    const title = `${statusLabel}：${util.truncate(task.instruction, 80)}`;
    const lines = [];
    if (detail) lines.push(detail);
    if (task.assignedDeviceName) lines.push(`设备：${task.assignedDeviceName}`);
    if (task.isPlan) {
      const done = util.arr(task.childTaskIds).filter((id) => {
        const child = this.tasks.get(id);
        return child && child.status === TASK_STATUS.COMPLETED;
      }).length;
      lines.push(`计划：${done}/${util.arr(task.childTaskIds).length} 个子任务完成`);
    }
    this._journalEntry({
      kind: 'work',
      title,
      text: lines.join('\n\n'),
      refs: {
        taskId: task.id,
        goalId: task.goalId || (task.context && task.context.goalId) || undefined,
      },
      meta: {
        taskStatus: task.status,
        isPlan: Boolean(task.isPlan),
        device: task.assignedDeviceName || null,
      },
    });
  }

  /** 自主大脑决策 → 思考条目。 */
  _journalBrainDecision(decision) {
    if (!decision) return;
    // 低信息量的「无需动作」思考不写日志：大脑定时思考，全记下来会淹没工作条目。
    // 注意 'none' 动作也属于「无动作」，不能算作有动作。
    const hasActions = util.arr(decision.actions).some(
      (action) => action && action.action && action.action !== 'none',
    );
    const summary = util.str(decision.summary, 500);
    const assessment = util.isPlainObject(decision.assessment) ? decision.assessment : null;
    // 连续失败只在第一次写日志，避免模型故障时心路被重复刷屏。
    if (decision.error && util.clampInt(Number(this.brain.consecutiveFailures), 0, 0, 6) > 1) return;
    const lowValue =
      !hasActions &&
      !decision.ownerAsk &&
      !decision.error &&
      (!summary || /^(无需|暂不|无动作|保持观察)|没有需要|不需要/.test(summary));
    if (lowValue) return;
    const title = decision.error
      ? `思考失败：${util.truncate(decision.error, 100)}`
      : `思考：${util.truncate(decision.summary || '无结论', 100)}`;
    const lines = [];
    if (decision.summary) lines.push(decision.summary);
    if (assessment) {
      const labels = [
        ['goals', '目标'],
        ['progress', '进度'],
        ['betterWay', '更好的方式'],
        ['improvement', '要改进'],
        ['myMove', '我来推进'],
      ];
      for (const [key, label] of labels) {
        const text = util.str(assessment[key], 400);
        if (text) lines.push(`- ${label}：${text}`);
      }
    }
    if (decision.ownerAsk && decision.ownerAsk.text) {
      lines.push(`- 需要主人：${decision.ownerAsk.text}`);
    }
    for (const action of util.arr(decision.actions)) {
      const flag = action.executed
        ? '已执行'
        : action.skippedReason
          ? `跳过：${action.skippedReason}`
          : '未执行';
      const target = action.taskId ? ` ${action.taskId}` : action.goalId ? ` ${action.goalId}` : '';
      const reason = action.reason ? ` — ${action.reason}` : '';
      const failure = action.error ? `（失败：${action.error}）` : '';
      lines.push(`- ${action.action}${target}${reason}${failure} [${flag}]`);
    }
    this._journalEntry({
      kind: 'thought',
      title,
      text: lines.join('\n'),
      refs: { decisionId: decision.id },
      meta: {
        trigger: decision.trigger,
        mode: decision.mode,
        durationMs: decision.durationMs,
        error: decision.error || null,
        ownerAsk: decision.ownerAsk ? decision.ownerAsk.text : null,
      },
    });
  }

  /** 目标跟进结束 → 目标视角的工作条目。 */
  _journalGoalCheck(goal, task, summary) {
    if (!goal || !task) return;
    this._journalEntry({
      kind: 'work',
      title: `目标「${util.truncate(goalDisplayName(goal), 40)}」跟进：${TASK_MESSAGES[task.status] || task.status}`,
      text: util.truncate(summary || '', 1500),
      refs: { goalId: goal.id, taskId: task.id },
      meta: { goalStatus: goal.status, taskStatus: task.status },
    });
  }

  /** 计划卡点 → 里程碑条目。 */
  _journalMilestone(parent, blocker) {
    if (!parent || !blocker) return;
    this._journalEntry({
      kind: 'milestone',
      title: `计划卡点：${util.truncate(parent.instruction, 60)}`,
      text: blocker.text || '',
      refs: {
        taskId: parent.id,
        goalId: parent.goalId || (parent.context && parent.context.goalId) || undefined,
      },
      meta: { percent: parent.progress ? parent.progress.percent : null },
    });
  }

  /** 每天到点生成当日总结；失败只记 lastError，不影响周期任务。 */
  runJournalCycle() {
    if (this._closed || !this.journal.enabled) return Promise.resolve(null);
    if (this._journalThinking) return this._journalThinking;
    const today = journalDateKey();
    if (this.journal.lastSummaryDate === today) return Promise.resolve(null);
    if (journalTimeKey() < (this.journal.summaryTime || DEFAULT_SUMMARY_TIME)) {
      return Promise.resolve(null);
    }
    return this.generateJournalSummary({ date: today }).catch((err) => {
      this.log('warn', `管家心路总结失败：${err && err.message ? err.message : err}`);
      return null;
    });
  }

  /**
   * 生成某天的总结（模型不可用时退化为确定性总结，永远不抛错）。
   * @param {{date?: string, force?: boolean}} [options]
   */
  async generateJournalSummary({ date, force = false } = {}) {
    if (this._closed) return null;
    const targetDate = validDateKey(date) ? date : journalDateKey();
    const existing = this.journal.days[targetDate];
    if (existing && !force) return { day: existing, error: existing.error || null };
    if (this._journalThinking) {
      const pending = await this._journalThinking;
      if (pending && existing && !force) return pending;
    }
    const pending = this._generateJournalSummaryOnce(targetDate).finally(() => {
      if (this._journalThinking === pending) this._journalThinking = null;
    });
    this._journalThinking = pending;
    return pending;
  }

  async _generateJournalSummaryOnce(targetDate) {
    const entries = entriesForDate(this.journal, targetDate);
    const stats = journalStatsForDay(entries);
    const goals = [...this.goals.values()].map((goal) => goalToJson(goal)).slice(0, 20);
    const tasks = [...this.tasks.values()]
      .filter((task) => {
        const at = Date.parse(task.finishedAt || task.updatedAt || task.createdAt || '');
        return Number.isFinite(at) && journalDateKey(at) === targetDate;
      })
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .slice(0, 40)
      .map((task) => ({
        id: task.id,
        instruction: util.truncate(task.instruction, 200),
        status: task.status,
        goalId: task.goalId || null,
      }));
    let summary = '';
    let highlights = [];
    let verdict = '';
    let error = null;
    let model = null;
    try {
      const config = journalModelConfig();
      model = config.model;
      const think = this._getJournalThinker();
      const prompt = buildDailySummaryPrompt({
        date: targetDate,
        entries,
        stats,
        goals,
        tasks,
        timeZone: systemTimeZone(),
      });
      const reply = await think(prompt);
      const parsed = parseDailySummary(reply);
      summary = parsed.summary;
      highlights = parsed.highlights;
      verdict = parsed.verdict;
      if (!summary) throw new Error('模型没有返回总结内容');
    } catch (err) {
      error = err && err.message ? err.message : String(err);
      summary = fallbackDailySummary({ date: targetDate, entries, stats });
      this.log('warn', `管家心路总结降级为本地汇总：${error}`);
    }
    const day = {
      date: targetDate,
      summary,
      highlights,
      verdict,
      stats,
      generatedAt: protocol.nowIso(),
      model,
      entryCount: entries.length,
      error,
    };
    this.journal.days[targetDate] = day;
    this.journal.lastSummaryDate = targetDate;
    this._journalEntry({
      kind: 'daily',
      at: day.generatedAt,
      title: `每日总结：${targetDate}`,
      text: summary,
      refs: {},
      meta: { stats, error, model },
    });
    this.broadcast(
      'journal.updated',
      { day, dayKey: targetDate, at: day.generatedAt },
      { record: false },
    );
    this.log(
      'info',
      `管家心路总结：${targetDate}（${entries.length} 条${error ? '，本地汇总' : '，模型生成'}）`,
    );
    this.schedulePersist();
    return { day, error };
  }

  _getJournalThinker() {
    if (this._journalThinkInjected) return this.journalThink;
    // 每日总结与大模型配置同源（BRAIN_*/AGNES_* 环境变量），暂不支持单独指定模型。
    const model = null;
    if (!this._journalThinker || this._journalThinkerModel !== model) {
      this._journalThinker = createJournalThinker({ model });
      this._journalThinkerModel = model;
    }
    return this._journalThinker;
  }

  /** 历史数据首次升级：用当天任务与大脑决策回填心路（只做一次）。 */
  _seedJournalFromHistory() {
    if (this.journal.entries.length > 0) return;
    const today = journalDateKey();
    const seeded = [];
    for (const task of this.tasks.values()) {
      const at = Date.parse(task.finishedAt || task.updatedAt || '');
      if (!Number.isFinite(at) || journalDateKey(at) !== today) continue;
      if (!TERMINAL_TASK_STATUSES.has(task.status)) continue;
      seeded.push({
        at: new Date(at).toISOString(),
        kind: 'work',
        title: `${TASK_MESSAGES[task.status] || task.status}：${util.truncate(task.instruction, 80)}`,
        text: util.truncate(
          (util.isPlainObject(task.output) &&
            (task.output.text || task.output.markdown)) ||
            task.error ||
            '',
          1200,
        ),
        refs: {
          taskId: task.id,
          goalId: task.goalId || (task.context && task.context.goalId) || undefined,
        },
        meta: { taskStatus: task.status, seeded: true },
      });
    }
    for (const decision of this.brain.decisions.slice(-10)) {
      const at = Date.parse(decision.at);
      if (!Number.isFinite(at) || journalDateKey(at) !== today) continue;
      seeded.push({
        at: new Date(at).toISOString(),
        kind: 'thought',
        title: decision.error
          ? `思考失败：${util.truncate(decision.error, 100)}`
          : `思考：${util.truncate(decision.summary || '无结论', 100)}`,
        text: util.str(decision.summary || '', 1500),
        refs: { decisionId: decision.id },
        meta: { seeded: true, trigger: decision.trigger },
      });
    }
    seeded.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    for (const entry of seeded) {
      appendJournalEntry(this.journal, entry, { timeZone: systemTimeZone() });
    }
    if (seeded.length) {
      this.journal.days[today] = this.journal.days[today] || {
        date: today,
        summary: '',
        highlights: [],
        stats: {},
        generatedAt: null,
        model: null,
        entryCount: seeded.length,
        error: null,
      };
      this.log('info', `管家心路首次回填：${seeded.length} 条（${today}）`);
    }
  }

  // ---------------------------------------------------------------- 头脑风暴

  _brainstormStateForPersist() {
    const sessions = [...this.brainstorm.sessions]
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, BRAINSTORM_MAX_SESSIONS)
      .map((session) => ({
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        autonomy: session.autonomy === true,
        messages: session.messages.slice(-BRAINSTORM_MAX_MESSAGES).map((message) => ({ ...message })),
      }));
    const activeId = sessions.some((session) => session.id === this.brainstorm.activeId)
      ? this.brainstorm.activeId
      : null;
    return { activeId, sessions };
  }

  getBrainstorm({ messages = 100, sessionId = null } = {}) {
    return brainstormToJson(this.brainstorm, {
      messages: util.clampInt(messages, 100, 1, BRAINSTORM_MAX_MESSAGES),
      sessionId: util.str(sessionId, 80) || null,
    });
  }

  listBrainstormSessions() {
    return this.getBrainstorm().sessions;
  }

  _findBrainstormSession(sessionId) {
    return findBrainstormSession(this.brainstorm, sessionId);
  }

  /** 会话排序 / 置顶 / 淘汰，保持 activeId 指向最近会话。 */
  _touchBrainstorm(session) {
    if (!session) return;
    this.brainstorm.activeId = session.id;
    this.brainstorm.sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    if (this.brainstorm.sessions.length > BRAINSTORM_MAX_SESSIONS) {
      this.brainstorm.sessions = this.brainstorm.sessions.slice(0, BRAINSTORM_MAX_SESSIONS);
    }
  }

  _broadcastBrainstorm(session, extra = {}) {
    this.broadcast(
      'brainstorm.updated',
      {
        session: session ? brainstormSessionSummary(session) : null,
        activeId: this.brainstorm.activeId,
        ...extra,
      },
      { record: false },
    );
  }

  createBrainstormSession() {
    const session = newBrainstormSession();
    this.brainstorm.sessions.unshift(session);
    this._touchBrainstorm(session);
    this._broadcastBrainstorm(session);
    this.log('info', `头脑风暴新会话：${session.id}`);
    this.schedulePersist();
    return session;
  }

  deleteBrainstormSession(sessionId) {
    const id = util.str(sessionId, 80);
    const index = this.brainstorm.sessions.findIndex((session) => session.id === id);
    if (index < 0) throw notFound('对话不存在');
    const removed = this.brainstorm.sessions.splice(index, 1)[0];
    if (this.brainstorm.activeId === id) {
      this.brainstorm.activeId = this.brainstorm.sessions[0] ? this.brainstorm.sessions[0].id : null;
    }
    this._broadcastBrainstorm(null, { removedId: id });
    this.log('info', `头脑风暴会话删除：${id}`);
    this.schedulePersist();
    return removed;
  }

  _brainstormModelLabel(config) {
    try {
      const resolved = config && config.model ? config : brainstormModelConfig();
      return util.str(resolved.model, 80) || null;
    } catch {
      return null;
    }
  }

  _getBrainstormThinker(config) {
    if (this._brainstormThinkInjected) return this.brainstormThink;
    const model = config && config.model ? config.model : null;
    const baseUrl = config && config.baseUrl ? config.baseUrl : null;
    const apiKey = config && config.apiKey ? config.apiKey : null;
    const timeoutMs = config && config.timeoutMs ? config.timeoutMs : undefined;
    return createBrainstormThinker({ model, baseUrl, apiKey, timeoutMs });
  }

  /** 头脑风暴上下文：长期目标、活跃/失败任务、最近心路、待确认。 */
  _brainstormContext() {
    const goals = [...this.goals.values()]
      .filter((goal) => goal.status === 'active' || goal.status === 'paused')
      .slice(0, 10)
      .map((goal) => ({
        title: util.str(goal.nickname, 120) || goal.title,
        status: goal.status,
        lastSummary: goal.lastSummary || '',
      }));
    const activeTasks = [...this.tasks.values()]
      .filter((task) => ACTIVE_TASK_STATUSES.has(task.status) || task.status === TASK_STATUS.QUEUED)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, 12);
    const recentFailures = [...this.tasks.values()]
      .filter((task) => task.status === TASK_STATUS.FAILED || task.status === TASK_STATUS.TIMEOUT)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, 4);
    const tasks = [...activeTasks, ...recentFailures].map((task) => ({
      instruction: task.instruction,
      status: task.status,
      error: task.error || null,
    }));
    const journal = Object.values(this.journal.days || {})
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .slice(0, 3)
      .map((day) => ({ date: day.date, summary: day.summary || day.verdict || '' }));
    const approvals = this.listApprovals().map((item) => ({
      goalTitle: item.goalTitle,
      reason: item.approval && item.approval.reason,
    }));
    return { now: protocol.nowIso(), goals, tasks, journal, approvals };
  }

  /**
   * 读取本轮头脑风暴附件：请求里显式给的附件 + 消息正文里提到的本机路径。
   * 失败项不抛错，转为提示词里的说明（模型会如实告诉主人）。
   */
  _collectBrainstormFiles(message, requested) {
    const cwd = process.cwd();
    const items = [];
    const knownPaths = new Set();
    for (const item of Array.isArray(requested) ? requested : []) {
      if (item && typeof item.path === 'string' && item.path.trim()) {
        const resolved = path.resolve(cwd, item.path.trim());
        if (!knownPaths.has(resolved)) {
          knownPaths.add(resolved);
          items.push({ path: resolved });
        }
        continue;
      }
      items.push(item);
    }
    for (const detected of extractFilePaths(message, { cwd })) {
      const resolved = path.resolve(cwd, detected);
      if (knownPaths.has(resolved)) continue;
      knownPaths.add(resolved);
      items.push({ path: resolved });
    }
    return readBrainstormAttachments(items, { cwd });
  }

  /**
   * 与大脑对话：追加 user 消息 → 模型回答 → 追加 assistant 消息。
   * 模型失败不抛给调用方，assistant 消息带 error 字段。
   */
  async chatBrainstorm({ sessionId, message, attachments } = {}) {
    const normalized = normalizeBrainstormChatRequest({ sessionId, message, attachments });
    if (!normalized.ok) throw badRequest(normalized.errors.join('；'));
    const input = normalized.value;
    const files = this._collectBrainstormFiles(input.message, input.attachments);
    // 本轮是否在「读文件」：显式附件、已读取到的文件、读取失败、或消息里提到文件路径。
    // 平时用默认模型（Agnes）分析；涉及文件时切到 DeepSeek，读内容并给结果。
    const fileMode = (Array.isArray(input.attachments) && input.attachments.length > 0)
      || files.attachments.length > 0
      || files.errors.length > 0
      || extractFilePaths(input.message, { cwd: process.cwd(), requireExists: false }).length > 0;
    const modelConfig = selectBrainstormModel({ fileMode });
    let session = this._findBrainstormSession(input.sessionId);
    if (!session) session = this.createBrainstormSession();
    // 主人在消息里明确授权「你直接建/开任务」→ 本会话开启直接执行（之后的回复可以建任务）。
    // 兼容历史会话：之前说过授权但当时还没这个能力，回溯扫一遍已保存的用户消息。
    if (!session.autonomy) {
      const grantedBefore = session.messages.some(
        (item) => item.role === 'user' && detectAutonomyGrant(item.text),
      );
      if (detectAutonomyGrant(input.message) || grantedBefore) {
        session.autonomy = true;
        this.log('info', `头脑风暴：${session.id} 主人授权直接建任务`);
      }
    }
    appendBrainstormMessage(session, {
      role: 'user',
      text: input.message,
      attachments: files.attachments.map(brainstormAttachmentMeta),
    });
    this._touchBrainstorm(session);
    const history = session.messages.slice(0, -1).slice(-12);
    const { system, user } = buildBrainstormPrompt({
      history,
      userMessage: input.message,
      context: this._brainstormContext(),
      attachments: files.attachments,
      attachmentErrors: files.errors,
      autonomy: session.autonomy === true,
    });
    const modelLabel = this._brainstormModelLabel(modelConfig);
    let reply = null;
    let error = null;
    let actions = [];
    try {
      const thinker = this._getBrainstormThinker(modelConfig);
      const answer = await thinker({ system, user });
      const raw = util.str(answer, BRAINSTORM_MAX_TEXT);
      if (!raw) throw new Error('大脑返回了空回复');
      // 剥离末尾 ```actions 代码块：已授权时真正建任务，未授权时只丢弃（不给主人看 JSON）。
      const parsed = splitBrainstormActionBlock(raw);
      const visible = parsed.text || raw;
      if (session.autonomy && parsed.actions.length) {
        actions = this._runBrainstormActions(session, parsed.actions);
      }
      const notice = this._brainstormActionNotice(actions);
      const finalText = notice ? `${visible}\n\n---\n${notice}` : visible;
      reply = finalText;
      appendBrainstormMessage(session, { role: 'assistant', text: finalText, model: modelLabel, actions });
    } catch (err) {
      error = err && err.message ? err.message : String(err);
      appendBrainstormMessage(session, {
        role: 'assistant',
        text: `（大脑暂时无法回答：${util.truncate(error, 300)}）`,
        error,
      });
      this.log('warn', `头脑风暴失败：${error}`);
    }
    this._touchBrainstorm(session);
    this._broadcastBrainstorm(session);
    this.schedulePersist();
    if (!error) {
      this.log(
        'info',
        `头脑风暴：${session.id} 第 ${session.messages.length} 条（模型：${modelLabel || 'unknown'}${fileMode ? '，文件模式' : ''}）`,
      );
    }
    return {
      session: this.getBrainstorm({ sessionId: session.id }).session,
      reply,
      error,
      model: modelLabel,
      fileMode,
      actions,
      attachments: files.attachments.map(brainstormAttachmentMeta),
      attachmentErrors: files.errors,
    };
  }

  /**
   * 执行头脑风暴回复里的 actions 块：目前只支持 create_task。
   * 只有主人授权过（session.autonomy）才会被调用；单条失败只记录不抛，避免影响对话。
   * @returns {Array<{action:string, taskId?:string, goalId?:string, instruction?:string, duplicate?:boolean, error?:string}>}
   */
  _runBrainstormActions(session, actions) {
    const records = [];
    const mainDeviceId = util.str(this.settings.mainDeviceId, 80);
    for (const action of Array.isArray(actions) ? actions : []) {
      const instruction = util.str(action.instruction, 8000).trim();
      const preview = util.truncate(instruction, 120);
      try {
        if (!instruction) throw new Error('缺少任务指令');
        // 与自主大脑同一去重策略：排队中/执行中任务的前 40 字相同就不重复建。
        const prefix = instruction.slice(0, 40);
        const duplicate = [...this.tasks.values()].find(
          (task) =>
            !TERMINAL_TASK_STATUSES.has(task.status) && util.str(task.instruction, 40).startsWith(prefix),
        );
        if (duplicate) {
          records.push({ action: 'create_task', taskId: duplicate.id, instruction: preview, duplicate: true });
          continue;
        }
        // 路由兜底：模型没指定设备时用主设备，避免任务永远卡在 queued。
        const requirements = {};
        if (action.deviceId) requirements.deviceId = action.deviceId;
        else if (mainDeviceId && this.devices.has(mainDeviceId)) requirements.deviceId = mainDeviceId;
        if (action.project) requirements.project = action.project;
        const sanitized = Object.keys(requirements).length
          ? this._sanitizeBrainRequirements(requirements).requirements
          : null;
        const goalId = action.goalId && this.goals.has(action.goalId) ? action.goalId : null;
        const task = this.createTask({
          instruction,
          goalId,
          priority: 6,
          timeoutSec: Number.isFinite(action.timeoutSec) ? action.timeoutSec : 600,
          ...(sanitized ? { requirements: sanitized } : {}),
          context: { brainstorm: true, sessionId: session.id, action: 'create_task', reason: action.reason || '' },
        });
        records.push({ action: 'create_task', taskId: task.id, goalId: task.goalId || undefined, instruction: preview });
        this.log('info', `头脑风暴直接建任务：${task.id}（会话 ${session.id}）`);
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        records.push({ action: 'create_task', instruction: preview, error: util.truncate(message, 300) });
        this.log('warn', `头脑风暴直接建任务失败：${message}`);
      }
    }
    return records;
  }

  /** 把本轮直接执行结果渲染成回复末尾的说明（让主人看到到底建了什么）。 */
  _brainstormActionNotice(records) {
    const list = Array.isArray(records) ? records : [];
    if (!list.length) return '';
    const lines = list.map((record) => {
      const label = util.truncate(record.instruction || '', 60);
      if (record.error) return `建任务失败（${util.truncate(record.error, 80)}）：${label}`;
      if (record.duplicate) return `已存在同类任务 ${record.taskId}，未重复创建：${label}`;
      const goal = record.goalId ? `（目标 ${record.goalId}）` : '';
      return `已创建任务 ${record.taskId}${goal}：${label}`;
    });
    return `本轮已直接执行：\n${lines.map((line) => `- ${line}`).join('\n')}`;
  }

  /** 把大脑的一条回复转成任务；带 goalId 时自动登记到长期目标。 */
  brainstormMessageToTask({ sessionId, messageId, goalId } = {}) {
    const session = this._findBrainstormSession(sessionId);
    if (!session) throw notFound('对话不存在');
    const id = util.str(messageId, 80);
    const message = session.messages.find((item) => item.id === id);
    if (!message) throw notFound('消息不存在');
    if (message.role !== 'assistant') throw badRequest('只能把大脑的回复转成任务');
    const goal = goalId ? this._requireGoal(util.str(goalId, 80)) : null;
    const instruction = util.str(message.text, BRAINSTORM_MAX_TEXT);
    if (!instruction) throw badRequest('消息内容为空');
    // 路由兜底：没指定设备时固定到主设备，避免手工转出来的任务永远卡在 queued。
    const mainDeviceId = util.str(this.settings.mainDeviceId, 80);
    const requirements =
      mainDeviceId && this.devices.has(mainDeviceId) ? { deviceId: mainDeviceId } : undefined;
    const task = this.createTask({
      instruction,
      priority: 6,
      goalId: goal ? goal.id : null,
      ...(requirements ? { requirements } : {}),
      context: { brainstorm: true, sessionId: session.id, messageId: message.id },
    });
    this.log(
      'info',
      `头脑风暴转任务：${task.id}（会话 ${session.id}${goal ? `，目标 ${goal.id}` : ''}）`,
    );
    return { task, session: this.getBrainstorm({ sessionId: session.id }).session };
  }

  // ---------------------------------------------------------------- 事件 / 日志

  _recordEvent(type, data) {
    if (type === 'ping') return;
    const entry = { id: protocol.randomId('evt'), at: protocol.nowIso(), type, data };
    const task = data && data.task;
    const device = data && data.device;
    if (task && task.id) entry.taskId = task.id;
    if (device && device.id) entry.deviceId = device.id;
    if (data && data.deviceId && !entry.deviceId) entry.deviceId = data.deviceId;
    if (data && data.taskId && !entry.taskId) entry.taskId = data.taskId;
    if (data && typeof data.message === 'string' && data.message) entry.message = data.message;
    this.events.push(entry);
    if (this.events.length > this.eventLimit) this.events.splice(0, this.events.length - this.eventLimit);
  }

  broadcast(type, data, options = {}) {
    if (options.record !== false) this._recordEvent(type, data);
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of [...this.sseClients]) {
      try {
        if (client.res.writableEnded || client.res.destroyed) {
          this.sseClients.delete(client);
          continue;
        }
        client.res.write(frame);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  log(level, message) {
    const at = protocol.nowIso();
    if (!this.silent) {
      const line = `[hub] ${at} ${level.toUpperCase()} ${message}`;
      if (level === 'error') console.error(line);
      else console.log(line);
    }
    this.broadcast('log', { level, message, at });
  }

  _pushTaskEvent(task, type, message) {
    task.events.push({ at: protocol.nowIso(), type, message });
    if (task.events.length > this.taskEventLimit) {
      task.events.splice(0, task.events.length - this.taskEventLimit);
    }
    this._scheduleTaskRecord(task.id);
  }

  // ------------------------------------------------- 任务执行记录（Markdown backtrace）

  /**
   * 合并短时间内的多次变更，延迟写单个任务的 md（避免进度事件刷盘）。
   * @param {string} taskId
   * @param {number} [delayMs]
   */
  _scheduleTaskRecord(taskId, delayMs = 400) {
    if (!this.recordEnabled || !taskId) return;
    const existing = this._recordTimers.get(taskId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this._recordTimers.delete(taskId);
      this._writeTaskRecord(taskId);
    }, Math.max(0, delayMs));
    if (timer.unref) timer.unref();
    this._recordTimers.set(taskId, timer);
  }

  _writeTaskRecord(taskId) {
    if (!this.recordEnabled) return;
    const task = this.tasks.get(taskId);
    if (!task) return;
    try {
      writeTaskRecord(this.recordDir, task, {
        allTasks: [...this.tasks.values()],
        hubEvents: this.events,
      });
      this._scheduleRecordIndex();
    } catch (err) {
      if (!this._recordWarned) {
        this._recordWarned = true;
        this.log('warn', `任务执行记录写入失败（${this.recordDir}）：${err && err.message ? err.message : err}`);
      }
    }
  }

  _scheduleRecordIndex(delayMs = 800) {
    if (!this.recordEnabled) return;
    if (this._recordIndexTimer) clearTimeout(this._recordIndexTimer);
    const timer = setTimeout(() => {
      this._recordIndexTimer = null;
      this._writeRecordIndex();
    }, Math.max(0, delayMs));
    if (timer.unref) timer.unref();
    this._recordIndexTimer = timer;
  }

  _writeRecordIndex() {
    if (!this.recordEnabled) return;
    try {
      writeTaskIndex(this.recordDir, [...this.tasks.values()]);
    } catch (err) {
      if (!this._recordWarned) {
        this._recordWarned = true;
        this.log('warn', `任务记录索引写入失败（${this.recordDir}）：${err && err.message ? err.message : err}`);
      }
    }
  }

  /** 立即落盘所有待写记录（close / 自重启前调用）。 */
  flushTaskRecords() {
    if (!this.recordEnabled) return;
    for (const [taskId, timer] of this._recordTimers) {
      clearTimeout(timer);
      this._recordTimers.delete(taskId);
      this._writeTaskRecord(taskId);
    }
    if (this._recordIndexTimer) {
      clearTimeout(this._recordIndexTimer);
      this._recordIndexTimer = null;
    }
    this._writeRecordIndex();
  }

  attachSse(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    const client = { res };
    this.sseClients.add(client);
    this._writeSseFrame(client, 'snapshot', this.snapshot(50));
    const cleanup = () => {
      this.sseClients.delete(client);
      try {
        if (!res.writableEnded) res.end();
      } catch {
        /* 忽略 */
      }
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
    req.on('close', cleanup);
    return client;
  }

  _writeSseFrame(client, type, data) {
    try {
      if (client.res.writableEnded || client.res.destroyed) return false;
      client.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      return false;
    }
  }

  _pingClients() {
    const data = { hubTime: protocol.nowIso() };
    for (const client of [...this.sseClients]) {
      if (!this._writeSseFrame(client, 'ping', data)) this.sseClients.delete(client);
    }
  }

  // ---------------------------------------------------------------- 设备

  _requireDevice(id) {
    const device = this.devices.get(id);
    if (!device) throw notFound('设备不存在');
    return device;
  }

  getDevice(id) {
    return this.devices.get(id) || null;
  }

  isAdminToken(token) {
    return util.safeEqual(token, this.adminToken);
  }

  isValidJoinCode(code) {
    return util.safeEqual(code, this.joinCode);
  }

  verifyDeviceToken(device, token) {
    return !!device && util.safeEqual(token, device.deviceToken);
  }

  _applyManifest(device, manifest) {
    // name 是设备自报的机器名，随 manifest 刷新；nickname 是用户在 Hub 侧设置的用途标签，不在这里改动。
    device.name = manifest.name;
    device.platform = manifest.platform;
    device.kind = manifest.kind;
    device.agentVersion = manifest.agentVersion;
    device.endpoint = manifest.endpoint;
    device.tags = [...manifest.tags];
    device.capabilities = {
      models: manifest.models,
      profiles: manifest.profiles,
      gateways: manifest.gateways,
      skills: manifest.skills,
      resources: manifest.resources,
      limits: manifest.limits,
    };
    device.load.max = manifest.limits.maxConcurrentTasks;
    if (device.load.running > device.load.max) device.load.running = device.load.max;
  }

  /** 新设备注册（需要加入码）。 */
  registerDevice(manifestInput) {
    const { manifest, errors } = protocol.normalizeManifest(manifestInput);
    if (errors.length) throw badRequest(errors.join('；'));

    const now = protocol.nowIso();
    const maxConcurrentTasks = manifest.limits.maxConcurrentTasks;
    const device = {
      id: protocol.randomId('dev'),
      deviceToken: util.generateToken('dtok'),
      name: manifest.name,
      nickname: '',
      platform: manifest.platform,
      kind: manifest.kind,
      agentVersion: manifest.agentVersion,
      endpoint: manifest.endpoint,
      tags: [...manifest.tags],
      capabilities: {
        models: manifest.models,
        profiles: manifest.profiles,
        gateways: manifest.gateways,
        skills: manifest.skills,
        resources: manifest.resources,
        limits: manifest.limits,
      },
      disabled: false,
      online: true,
      status: 'idle',
      registeredAt: now,
      lastSeenAt: now,
      load: { running: 0, max: maxConcurrentTasks },
      reportedRunning: 0,
      metrics: {},
      commands: [],
      waiters: [],
    };
    this.devices.set(device.id, device);
    this.broadcast('device.updated', { device: this.deviceToJson(device) });
    this.log('info', `设备注册：${deviceDisplayName(device)}（${device.id}，${device.platform}/${device.kind}）`);
    this.retryQueuedTasks('device registered');
    this.schedulePersist();
    return device;
  }

  /** 已注册设备通过 /manifest 或 register 更新能力。 */
  updateDeviceManifest(device, manifestInput) {
    const { manifest, errors } = protocol.normalizeManifest(manifestInput);
    if (errors.length) throw badRequest(errors.join('；'));
    this._applyManifest(device, manifest);
    const wasOffline = this.touch(device);
    // touch() 在离线→在线时已广播 device.updated，避免重复
    if (!wasOffline) this.broadcast('device.updated', { device: this.deviceToJson(device) });
    this.log('info', `设备能力更新：${deviceDisplayName(device)}（${device.id}）`);
    this.retryQueuedTasks('device manifest updated');
    this.schedulePersist();
    return device;
  }

  /** 心跳/命令轮询都会刷新存活时间；离线→在线时广播并重试排队任务。 */
  touch(device) {
    device.lastSeenAt = protocol.nowIso();
    const wasOffline = !device.online;
    device.online = true;
    if (device.status === 'offline') device.status = 'idle';
    if (wasOffline) {
      this.broadcast('device.online', {
        deviceId: device.id,
        name: deviceDisplayName(device),
        at: device.lastSeenAt,
      });
      this.broadcast('device.updated', { device: this.deviceToJson(device) });
      this.log('info', `设备上线：${deviceDisplayName(device)}（${device.id}）`);
      this.retryQueuedTasks('device online');
    }
    return wasOffline;
  }

  handleHeartbeat(device, body) {
    const input = util.isPlainObject(body) ? body : {};
    this.touch(device);
    if (typeof input.status === 'string' && DEVICE_STATUSES.has(input.status) && input.status !== 'offline') {
      device.status = input.status;
    }
    if (util.isPlainObject(input.metrics)) {
      device.metrics = {
        cpuPct: Number.isFinite(input.metrics.cpuPct)
          ? util.clampNumber(input.metrics.cpuPct, 0, 0, 100)
          : device.metrics.cpuPct,
        memPct: Number.isFinite(input.metrics.memPct)
          ? util.clampNumber(input.metrics.memPct, 0, 0, 100)
          : device.metrics.memPct,
        uptimeSec: Number.isFinite(input.metrics.uptimeSec)
          ? Math.max(0, Math.trunc(input.metrics.uptimeSec))
          : device.metrics.uptimeSec,
      };
    }
    if (util.isPlainObject(input.load)) {
      // load.running 由任务生命周期维护；心跳上报只作为参考，且不得超过 limits
      device.reportedRunning = util.clampInt(
        input.load.running,
        device.reportedRunning || 0,
        0,
        this._maxConcurrent(device),
      );
    }
    // 设备当前持有（执行中/已 ack 排队中）的任务 id，用于判定「设备忙碌时不重派」。
    // 老版本设备不发送 taskIds，这里按空数组处理，避免残留上一次的值把设备长期判为忙碌。
    device.runningTaskIds = Array.isArray(input.taskIds)
      ? input.taskIds
          .filter((id) => typeof id === 'string' && id.trim())
          .map((id) => id.trim())
          .slice(0, 50)
      : [];
    this.broadcast('device.updated', { device: this.deviceToJson(device) }, { record: false });
    this.schedulePersist();
    const commands = this.takeCommands(device, 20);
    return { commands };
  }

  takeCommands(device, limit) {
    if (!device.commands.length) return [];
    return device.commands.splice(0, Math.max(1, limit));
  }

  enqueueCommand(device, command) {
    device.commands.push(command);
    if (device.commands.length > this.maxCommandsPerDevice) {
      device.commands.splice(0, device.commands.length - this.maxCommandsPerDevice);
    }
    this._notifyWaiters(device);
  }

  _notifyWaiters(device) {
    while (device.commands.length && device.waiters.length) {
      const waiter = device.waiters[0];
      const commands = this.takeCommands(device, waiter.limit || 5);
      waiter.settle(commands);
    }
  }

  /** 命令长轮询：无命令时挂起 waitMs（上限 30s）。 */
  addCommandWaiter(device, { waitMs = 25000, limit = 5, req = null } = {}) {
    const safeWait = util.clampInt(waitMs, 25000, 0, LIMITS.LONG_POLL_MAX_MS);
    const safeLimit = util.clampInt(limit, 5, 1, 50);
    const immediate = this.takeCommands(device, safeLimit);
    if (immediate.length) return Promise.resolve(immediate);
    if (safeWait <= 0) return Promise.resolve([]);
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const waiter = {
        limit: safeLimit,
        settle: (commands) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (req) req.removeListener('close', onClose);
          const idx = device.waiters.indexOf(waiter);
          if (idx >= 0) device.waiters.splice(idx, 1);
          resolve(commands);
        },
      };
      const onClose = () => waiter.settle([]);
      timer = setTimeout(() => waiter.settle([]), safeWait);
      if (timer.unref) timer.unref();
      if (req) req.once('close', onClose);
      device.waiters.push(waiter);
    });
  }

  markDeviceOffline(device, reason = 'device offline') {
    if (!device.online) return;
    device.online = false;
    device.status = 'offline';
    device.reportedRunning = 0;
    this.broadcast('device.offline', {
      deviceId: device.id,
      name: deviceDisplayName(device),
      at: protocol.nowIso(),
    });
    this.broadcast('device.updated', { device: this.deviceToJson(device) });
    this.log('info', `设备离线：${deviceDisplayName(device)}（${device.id}，${reason}）`);
    this.handleDeviceLost(device, reason);
    this.schedulePersist();
  }

  sweepOffline() {
    const now = Date.now();
    for (const device of [...this.devices.values()]) {
      if (!device.online) continue;
      const lastSeen = device.lastSeenAt ? Date.parse(device.lastSeenAt) : 0;
      if (!Number.isFinite(lastSeen)) continue;
      if (now - lastSeen > this.ttlMs) this.markDeviceOffline(device, 'heartbeat timeout');
    }
    // 顺带清理「排队太久、根本没设备能接」的幽灵任务。
    this._expireStaleQueuedTasks(now);
  }

  /**
   * 排队寿命到期：queued 超过 queuedTtlMs 仍没派发出去的任务主动失败，并写明最后排队原因。
   * 计划子任务在等前置依赖时不算「没设备可派」，保留给计划依赖闸处理。
   * @returns {number} 本次终止的任务数
   */
  _expireStaleQueuedTasks(now = Date.now()) {
    if (!this.queuedTtlMs) return 0;
    let expired = 0;
    for (const task of [...this.tasks.values()]) {
      if (task.status !== TASK_STATUS.QUEUED) continue;
      const createdAt = task.createdAt ? Date.parse(task.createdAt) : NaN;
      if (!Number.isFinite(createdAt) || now - createdAt < this.queuedTtlMs) continue;
      const gate = this._planDependencyGate(task);
      if (gate && !gate.missingOnly) continue;
      const hours = Math.max(1, Math.round(this.queuedTtlMs / 3600000));
      const lastReason = task.route && task.route.reason ? `，最后排队原因：${task.route.reason}` : '';
      this._finishTask(task, TASK_STATUS.FAILED, {
        error: `排队超时（${hours}h 内没有可用设备）${lastReason}`,
        eventMessage: `排队超时（超过 ${hours}h 没有可用设备），已终止`,
      });
      expired += 1;
    }
    return expired;
  }

  removeDevice(device, reason = 'device removed') {
    for (const waiter of device.waiters.splice(0)) {
      try {
        waiter.settle([]);
      } catch {
        /* 忽略 */
      }
    }
    device.commands.length = 0;
    this.devices.delete(device.id);
    this.handleDeviceLost(device, reason);
    this.broadcast('device.offline', {
      deviceId: device.id,
      name: deviceDisplayName(device),
      at: protocol.nowIso(),
    });
    this.log('info', `设备移除：${deviceDisplayName(device)}（${device.id}，${reason}）`);
    this.schedulePersist();
  }

  patchDevice(device, body) {
    const input = util.isPlainObject(body) ? body : {};
    let changed = false;
    if (typeof input.nickname === 'string') {
      const nickname = input.nickname.trim();
      if (nickname.length > MAX_DEVICE_NICKNAME_LENGTH) {
        throw badRequest(`nickname 最多 ${MAX_DEVICE_NICKNAME_LENGTH} 字符`);
      }
      device.nickname = nickname;
      changed = true;
    }
    if (typeof input.name === 'string') {
      const name = util.str(input.name, LIMITS.MAX_NAME_LENGTH);
      if (!name) throw badRequest('name 必须为 1-64 字符');
      device.name = name;
      changed = true;
    }
    if (Array.isArray(input.tags)) {
      device.tags = [...new Set(util.arr(input.tags).map((t) => util.str(t, 40)).filter(Boolean))];
      changed = true;
    }
    if (typeof input.disabled === 'boolean') {
      device.disabled = input.disabled;
      changed = true;
    }
    if (changed) {
      this.broadcast('device.updated', { device: this.deviceToJson(device) });
      if (device.disabled) this.handleDeviceLost(device, 'device disabled');
      this.retryQueuedTasks('device patched');
      this.schedulePersist();
    }
    return device;
  }

  // ---------------------------------------------------------------- 任务

  _requireTask(id) {
    const task = this.tasks.get(id);
    if (!task) throw notFound('任务不存在');
    return task;
  }

  getTask(id) {
    return this.tasks.get(id) || null;
  }

  listTasks({ status, deviceId, includeArchived = false, includeTrashed = false, limit } = {}) {
    this.reconcilePlans();
    const safeLimit = util.clampInt(limit, 100, 1, 500);
    let tasks = [...this.tasks.values()];
    if (!includeArchived) tasks = tasks.filter((task) => !task.archived);
    if (!includeTrashed) tasks = tasks.filter((task) => !task.trashedAt);
    if (typeof status === 'string' && status) tasks = tasks.filter((task) => task.status === status);
    if (typeof deviceId === 'string' && deviceId) {
      tasks = tasks.filter((task) => task.assignedDeviceId === deviceId);
    }
    tasks.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return tasks.slice(0, safeLimit).map((task) => this.taskToJson(task));
  }

  // ---------------------------------------------------------------- 路由提示（A 方案）

  /** 找到「本机」设备：显式 localDeviceId > tags 含「本机」> 名称含主机名。 */
  _localDevice() {
    if (this.localDeviceId) {
      const configured = this.devices.get(this.localDeviceId);
      if (configured && !configured.disabled) return configured;
    }
    for (const device of this.devices.values()) {
      if (device.disabled) continue;
      if ((device.tags || []).includes('本机')) return device;
    }
    const host = String(os.hostname() || '').toLowerCase();
    if (host) {
      for (const device of this.devices.values()) {
        if (device.disabled) continue;
        if (device.name && device.name.toLowerCase().includes(host)) return device;
      }
    }
    return null;
  }

  /**
   * 派发主设备（「母机」）：
   * 1. settings.mainDeviceId 显式指定；
   * 2. 未指定时用 Hub 所在的本机设备（tags 含「本机」或名称匹配主机名）。
   * 主设备是项目/会话所在的工作机；没有项目亲和时优先把任务留在它上面。
   */
  _mainDevice() {
    const configuredId = util.str(this.settings.mainDeviceId, 120);
    if (configuredId) {
      const configured = this.devices.get(configuredId);
      if (configured && !configured.disabled) return configured;
    }
    return this._localDevice();
  }

  _taskProject(task) {
    const req = task && task.requirements;
    return util.str(req && req.project, 120) || null;
  }

  _projectAffinityDevice(project) {
    if (!project) return null;
    const deviceId = this.projectAffinity.get(project);
    if (!deviceId) return null;
    const device = this.devices.get(deviceId);
    if (!device) return null;
    return device;
  }

  /** 同一线程（跟进/计划子任务）里最近一次实际执行过的设备；已完成的任务优先。 */
  _threadAffinityTask(task) {
    if (!task || !task.threadId) return null;
    const threadKey = task.threadId || task.id;
    let best = null;
    let bestCompleted = -1;
    let bestStamp = -1;
    for (const candidate of this.tasks.values()) {
      if (candidate.id === task.id || !candidate.assignedDeviceId) continue;
      if ((candidate.threadId || candidate.id) !== threadKey) continue;
      const completed = candidate.status === TASK_STATUS.COMPLETED ? 1 : 0;
      const stamp = Date.parse(candidate.finishedAt || candidate.updatedAt || candidate.createdAt) || 0;
      if (completed > bestCompleted || (completed === bestCompleted && stamp > bestStamp)) {
        best = candidate;
        bestCompleted = completed;
        bestStamp = stamp;
      }
    }
    return best;
  }

  /**
   * 计算任务的首选设备（软亲和）。优先级：
   * 显式 requirements.deviceId（routeTask 硬过滤）> 任务自带 affinity > 同线程上次执行设备 >
   * 项目亲和（上次成功设备）> 主设备（母机）。
   * @returns {{deviceId:string, reason:string, kind:string}|null}
   */
  _preferredDeviceFor(task) {
    const affinity = task && task.affinity;
    if (affinity && affinity.deviceId) {
      const device = this.devices.get(affinity.deviceId);
      if (device && !device.disabled) {
        return {
          deviceId: device.id,
          reason: `亲和锁定：${affinity.reason || '沿用上次执行的主机'}`,
          kind: 'assigned',
        };
      }
    }
    const thread = this._threadAffinityTask(task);
    if (thread) {
      const device = this.devices.get(thread.assignedDeviceId);
      if (device && !device.disabled) {
        return {
          deviceId: device.id,
          reason: `线程亲和：同一线程上次在「${deviceDisplayName(device)}」执行`,
          kind: 'thread',
        };
      }
    }
    const project = this._taskProject(task);
    const projectDevice = this._projectAffinityDevice(project);
    if (projectDevice && !projectDevice.disabled) {
      return {
        deviceId: projectDevice.id,
        reason: `项目亲和：「${project}」上次成功在「${deviceDisplayName(projectDevice)}」`,
        kind: 'project',
      };
    }
    const mainDevice = this._mainDevice();
    if (mainDevice) {
      return {
        deviceId: mainDevice.id,
        reason: `主设备（母机）优先：${deviceDisplayName(mainDevice)}`,
        kind: 'main',
      };
    }
    return null;
  }

  /**
   * 判断首选设备现在能不能接：
   * - 能接 → 锁定派发；
   * - 离线/并发已满 → 排队等待（亲和优先于「换一台机器」）；
   * - 已被删除/禁用/缺少能力 → 回退普通评分路由。
   */
  _affinityDecision(task, preference, occupancy) {
    if (!preference || !preference.deviceId) return { kind: 'none' };
    const device = this.devices.get(preference.deviceId);
    if (!device) return { kind: 'fallback', note: '亲和主机已不存在' };
    if (device.disabled) return { kind: 'fallback', note: `亲和主机「${deviceDisplayName(device)}」已禁用` };
    // 计划子任务（并行组）不因为“线程上一位执行者”忙/离线而卡住整个计划：
    // 软亲和只用于首选排序，拿不到槽位就交给自动路由，保证并行子任务能铺开。
    if (preference.kind === 'thread' && task.parentTaskId) {
      if (!device.online) {
        return { kind: 'fallback', note: `线程亲和主机「${deviceDisplayName(device)}」离线，子任务改走自动路由` };
      }
      if ((occupancy.get(device.id) || 0) >= this._maxConcurrent(device)) {
        return { kind: 'fallback', note: `线程亲和主机「${deviceDisplayName(device)}」并发已满，子任务改走自动路由` };
      }
    }
    if (!device.online) return { kind: 'wait', note: `亲和主机「${deviceDisplayName(device)}」离线，等待上线` };
    if ((occupancy.get(device.id) || 0) >= this._maxConcurrent(device)) {
      return { kind: 'wait', note: `亲和主机「${deviceDisplayName(device)}」并发已满，等待空槽` };
    }
    const matched = protocol.matchRequirements(this._capabilitiesForMatch(device), task.requirements || {});
    if (!matched.ok) {
      return { kind: 'fallback', note: `亲和主机缺少 ${matched.missing.join(', ')}` };
    }
    return { kind: 'lock', device };
  }

  /**
   * 只读预检：指令里提到的本地文件若存在，返回「固定到本机」建议；结果按指令缓存。
   * @returns {null|{deviceId:string, deviceName:string, reason:string, matches:Array}}
   */
  _preflightAdvice(instruction) {
    if (!this.preflightEnabled) return null;
    const key = String(instruction || '');
    if (this._preflightCache.has(key)) return this._preflightCache.get(key);
    const device = this._localDevice();
    let advice = null;
    if (device) {
      const result = preflight.preflightInstruction(key, {
        roots: this.preflightRoots || undefined,
        maxDepth: this.preflightMaxDepth,
        timeoutMs: this.preflightTimeoutMs,
        maxMatches: this.preflightMaxMatches,
      });
      if (result.hit) {
        advice = {
          deviceId: device.id,
          deviceName: deviceDisplayName(device),
          reason: `本地文件预检：${result.reason}`,
          matches: result.matches.slice(0, this.preflightMaxMatches),
        };
      }
    }
    if (this._preflightCache.size >= 100) this._preflightCache.clear();
    this._preflightCache.set(key, advice);
    return advice;
  }

  /** 校验/规范化路由提示（预检 pin 与规划指派），防止脏数据进入状态与任务记录。 */
  normalizeRoutingAdvice(raw) {
    if (!util.isPlainObject(raw)) return null;
    const take = (value) => {
      if (!util.isPlainObject(value)) return null;
      const deviceId = util.str(value.deviceId, 80);
      if (!deviceId) return null;
      const matches = util
        .arr(value.matches)
        .filter(util.isPlainObject)
        .slice(0, 10)
        .map((item) => ({
          ref: util.str(item.ref, 260) || '',
          path: util.str(item.path, 500) || '',
        }));
      return {
        deviceId,
        deviceName: util.str(value.deviceName, LIMITS.MAX_NAME_LENGTH) || '',
        reason: util.str(value.reason, 500) || '',
        matches,
      };
    };
    const out = {};
    const pre = take(raw.preflight);
    if (pre) out.preflight = pre;
    const planner = take(raw.planner);
    if (planner) out.planner = planner;
    return Object.keys(out).length ? out : null;
  }

  _routingAdviceText(advice) {
    if (!advice) return '';
    const parts = [];
    if (advice.preflight && advice.preflight.reason) parts.push(advice.preflight.reason);
    if (advice.planner && advice.planner.reason) parts.push(advice.planner.reason);
    return parts.join('；');
  }

  _withAdvice(adviceText, reason) {
    return adviceText ? `${adviceText}；${reason}` : reason;
  }

  /** 设备能力清单：交给 Agnes 规划器做指派决策，只暴露路由需要的信息。 */
  deviceInventory() {
    const ids = (value) =>
      util
        .arr(value)
        .map((item) => (typeof item === 'string' ? item : item && item.id))
        .filter((id) => typeof id === 'string' && id)
        .slice(0, 30);
    return [...this.devices.values()]
      .filter((device) => !device.disabled)
      .map((device) => ({
        id: device.id,
        name: device.name,
        nickname: device.nickname || '',
        platform: device.platform,
        kind: device.kind,
        online: Boolean(device.online),
        local: (device.tags || []).includes('本机'),
        tags: [...(device.tags || [])].slice(0, 20),
        skills: ids(device.capabilities && device.capabilities.skills),
        models: ids(device.capabilities && device.capabilities.models),
        // 让规划器知道每台工作机同时能跑几个任务（手机 Mika 为 1，需要排队）。
        maxConcurrentTasks: this._maxConcurrent(device),
      }));
  }

  createTask(input, internal = {}) {
    const { ok, errors, value } = protocol.normalizeTaskRequest(input);
    if (!ok) throw badRequest(errors.join('；'));
    // 任务同时带项目与标签时，把标签登记为该项目的别名：设备成功做过该项目后自动获得这些标签。
    if (value.requirements.project && value.requirements.tags.length) {
      this._learnProjectTags(value.requirements.project, value.requirements.tags);
    }
    const now = protocol.nowIso();
    const taskId = protocol.randomId('task');
    const task = {
      id: taskId,
      instruction: value.instruction,
      requirements: value.requirements,
      priority: value.priority,
      status: TASK_STATUS.QUEUED,
      assignedDeviceId: null,
      assignedDeviceName: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      attempts: 0,
      maxAttempts: value.maxAttempts,
      timeoutSec: value.timeoutSec,
      output: null,
      error: null,
      autoRetry: input.autoRetry !== false,
      progress: null,
      parentTaskId: input.parentTaskId ? String(input.parentTaskId) : null,
      childTaskIds: [],
      threadId: typeof input.threadId === 'string' && input.threadId ? input.threadId : taskId,
      replyToTaskId: typeof input.replyToTaskId === 'string' && input.replyToTaskId ? input.replyToTaskId : null,
      threadStep: Number.isFinite(Number(input.threadStep)) ? Math.max(1, Math.trunc(Number(input.threadStep))) : 1,
      context: util.isPlainObject(input.context) ? input.context : null,
      goalId: typeof input.goalId === 'string' && input.goalId ? input.goalId : null,
      attachments: Array.isArray(input.attachments) ? input.attachments : [],
      isPlan: false,
      // 拆分计划的子任务元数据（普通任务保持 null/空）。
      planStep: null,
      planGroup: null,
      planDependsOn: [],
      planDependsOnTaskIds: [],
      plan: null,
      archived: false,
      archivedAt: null,
      trashedAt: null,
      route: { reason: '等待路由', candidates: [], excluded: [] },
      // 派发亲和：首次实际派发后写 {deviceId, reason, at}，重试沿用同一台主机。
      affinity: null,
      // 大脑咨询任务：{question, deviceId, project}；完成后回答写入 brain.consultations。
      consult: null,
      events: [{ at: now, type: 'created', message: '任务已创建' }],
      _avoidDeviceIds: [],
    };
    // 本地文件预检（A）：指令提到的本机文件存在时，固定到「本机」设备执行。
    // internal.routingAdvice 只由 Hub 内部（拆分/跟进）传入，外部请求无法伪造。
    let routingAdvice = this.normalizeRoutingAdvice(internal.routingAdvice);
    if (!routingAdvice && !task.requirements.deviceId) {
      const advice = this._preflightAdvice(task.instruction);
      if (advice) {
        routingAdvice = { preflight: advice };
        task.requirements = { ...task.requirements, deviceId: advice.deviceId };
      }
    }
    task.routingAdvice = routingAdvice;
    if (routingAdvice && routingAdvice.preflight && routingAdvice.preflight.reason) {
      task.events.push({ at: protocol.nowIso(), type: 'preflight', message: routingAdvice.preflight.reason });
    }
    // 规划子任务兜底：太短的 timeoutSec（如 60/90/180s）会让长任务必然超时。
    const planFloor = this._planSubtaskTimeoutFloor(task);
    if (planFloor) task.timeoutSec = Math.max(task.timeoutSec, planFloor);
    this.tasks.set(task.id, task);
    this.broadcast('task.created', { task: this.taskToJson(task) });
    this.log('info', `任务创建：${task.id}「${util.truncate(task.instruction, 40)}」`);
    this._scheduleTaskRecord(task.id, 0);
    // 创建时就带 goalId 的任务自动登记到目标（目标页可见、大脑可观察）。
    if (task.goalId) this._registerGoalTask(task.goalId, task);
    // 规划子任务由 createPlanTask 写完依赖元数据后再派发，避免依赖未就绪就上路。
    if (internal.deferRoute !== true) this.routeTask(task);
    this.schedulePersist();
    return task;
  }

  createFollowUp(source, input = {}) {
    if (!source) throw notFound('源任务不存在');
    if (!TERMINAL_TASK_STATUSES.has(source.status)) {
      throw conflict('只能对已完成/失败/超时/已取消的任务继续');
    }
    const normalized = protocol.normalizeTaskRequest(input);
    if (!normalized.ok) throw badRequest(normalized.errors.join('；'));
    const value = normalized.value;
    const threadTasks = [...this.tasks.values()]
      .filter((task) => (task.threadId || task.id) === (source.threadId || source.id))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const previousOutput = source.output
      ? (source.output.text || source.output.markdown || '')
      : '';
    const context = {
      sourceTaskId: source.id,
      threadId: source.threadId || source.id,
      step: threadTasks.length + 1,
      previousInstruction: source.instruction,
      previousOutput: String(previousOutput).slice(0, 8000),
      previousError: source.error || null,
      previousStatus: source.status,
      previousArtifacts: source.output && Array.isArray(source.output.artifacts)
        ? source.output.artifacts.slice(0, 10)
        : [],
      previousAttachments: (source.attachments || []).map((file) => file.name),
      historySummary: threadTasks
        .slice(0, 10)
        .map((task) => `${task.threadStep || 1}. [${task.status}] ${util.truncate(task.instruction, 120)}`)
        .join('\n'),
    };
    const mergedRequirements = {
      ...source.requirements,
      skills: value.requirements.skills.length ? value.requirements.skills : source.requirements.skills,
      tags: value.requirements.tags.length ? value.requirements.tags : source.requirements.tags,
    };
    if (value.requirements.model) mergedRequirements.model = value.requirements.model;
    if (value.requirements.profile) mergedRequirements.profile = value.requirements.profile;
    if (value.requirements.gateway) mergedRequirements.gateway = value.requirements.gateway;
    if (value.requirements.deviceId) mergedRequirements.deviceId = value.requirements.deviceId;
    return this.createTask(
      {
        instruction: value.instruction,
        requirements: mergedRequirements,
        priority: input.priority !== undefined ? value.priority : source.priority,
        timeoutSec: input.timeoutSec !== undefined ? value.timeoutSec : source.timeoutSec,
        maxAttempts: input.maxAttempts !== undefined ? value.maxAttempts : source.maxAttempts,
        threadId: source.threadId || source.id,
        replyToTaskId: source.id,
        threadStep: context.step,
        // 「继续此任务」不应脱离长期目标：跟进任务继承源任务的目标归属。
        goalId: source.goalId || null,
        context,
        attachments: Array.isArray(input.attachments) ? input.attachments : [],
      },
      {
        // 用户没有在跟进里显式改设备时，继承源任务的预检/指派依据（已 pin 的 deviceId 也一并继承）。
        routingAdvice: value.requirements.deviceId ? null : source.routingAdvice,
      },
    );
  }

  shouldAutoSplit(input) {
    if (!util.isPlainObject(input)) return false;
    if (input.split === false) return false;
    if (input.split === true) return true;
    const instruction = typeof input.instruction === 'string' ? input.instruction : '';
    const timeoutSec = Number(input.timeoutSec) || 0;
    return instruction.length >= this.splitThresholdChars || timeoutSec >= this.splitTimeoutSec;
  }

  /**
   * 长任务先用 Agnes AI 拆成子任务，再让每个子任务独立路由。
   * 规划失败时退化为普通任务，避免因为规划服务不可用而丢任务。
   */
  async createPlanTask(input) {
    const normalized = protocol.normalizeTaskRequest(input);
    if (!normalized.ok) throw badRequest(normalized.errors.join('；'));
    const value = normalized.value;
    const planGoalId = util.str(input.goalId, 80) || null;
    // 路由提示优先级：用户显式 deviceId > Agnes 指派 > 本地文件预检 pin。
    const userDeviceId = value.requirements.deviceId || null;
    let routingAdvice = this.normalizeRoutingAdvice(input.routingAdvice);
    let pinnedDeviceId = userDeviceId;
    if (!routingAdvice && !pinnedDeviceId) {
      const advice = this._preflightAdvice(value.instruction);
      if (advice) {
        routingAdvice = { preflight: advice };
        pinnedDeviceId = advice.deviceId;
      }
    }
    const planRequirements = pinnedDeviceId
      ? { ...value.requirements, deviceId: pinnedDeviceId }
      : { ...value.requirements };

    let plan;
    try {
      plan = await this.planner({
        instruction: value.instruction,
        requirements: planRequirements,
        timeoutSec: value.timeoutSec,
        devices: this.deviceInventory(),
      });
    } catch (err) {
      this.log('warn', `Agnes 长任务拆分失败，按普通任务执行：${err && err.message ? err.message : err}`);
      return this.createTask({ ...input, requirements: planRequirements }, { routingAdvice });
    }
    if (!plan || !Array.isArray(plan.subtasks) || plan.subtasks.length < 2) {
      this.log('warn', 'Agnes 没有返回有效子任务，按普通任务执行');
      return this.createTask({ ...input, requirements: planRequirements }, { routingAdvice });
    }
    const now = protocol.nowIso();
    const parentThreadId = protocol.randomId('thread');
    // 执行计划元数据：strategy/groups/blockerPolicy 由 planner 归一化后写入，随任务持久化。
    const execution = plan.execution && typeof plan.execution === 'object'
      ? plan.execution
      : { strategy: 'mixed', groups: [], blockerPolicy: 'stop-and-ask' };
    const executionLabel = planExecutionLabel(execution);
    const planMeta = {
      strategy: ['parallel', 'sequential', 'mixed'].includes(execution.strategy) ? execution.strategy : 'mixed',
      blockerPolicy: execution.blockerPolicy === 'continue' ? 'continue' : 'stop-and-ask',
      groups: util
        .arr(execution.groups)
        .filter((group) => util.isPlainObject(group))
        .slice(0, 6)
        .map((group) => ({
          name: util.str(group.name, 40) || '并行组',
          mode: group.mode === 'sequential' ? 'sequential' : 'parallel',
          subtaskIndexes: util
            .arr(group.subtaskIndexes)
            .map((n) => Math.trunc(Number(n)))
            .filter((n) => Number.isInteger(n) && n >= 0)
            .slice(0, 12),
        })),
    };
    const parent = {
      id: protocol.randomId('task'),
      instruction: value.instruction,
      requirements: planRequirements,
      priority: value.priority,
      status: TASK_STATUS.RUNNING,
      assignedDeviceId: null,
      assignedDeviceName: 'Agnes 规划器',
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      finishedAt: null,
      attempts: 0,
      maxAttempts: value.maxAttempts,
      timeoutSec: value.timeoutSec,
      output: null,
      error: null,
      progress: { message: `Agnes 已拆分为 ${plan.subtasks.length} 个子任务（${executionLabel}）`, percent: 0, logs: [], at: now },
      parentTaskId: null,
      childTaskIds: [],
      threadId: parentThreadId,
      replyToTaskId: null,
      threadStep: 1,
      context: null,
      goalId: planGoalId,
      attachments: Array.isArray(input.attachments) ? input.attachments : [],
      isPlan: true,
      plan: planMeta,
      archived: false,
      archivedAt: null,
      trashedAt: null,
      route: {
        reason: `Agnes 长任务拆分：${plan.title || '长任务'}`,
        candidates: [],
        excluded: [],
      },
      routingAdvice,
      events: [
        { at: now, type: 'created', message: '长任务已创建' },
        { at: now, type: 'plan', message: `Agnes 拆分为 ${plan.subtasks.length} 个子任务（${executionLabel}）` },
      ],
      _avoidDeviceIds: [],
    };
    if (routingAdvice && routingAdvice.preflight && routingAdvice.preflight.reason) {
      parent.events.push({ at: now, type: 'preflight', message: routingAdvice.preflight.reason });
    }
    this.tasks.set(parent.id, parent);
    this.broadcast('task.created', { task: this.taskToJson(parent) });
    if (planGoalId) this._registerGoalTask(planGoalId, parent);
    this.log('info', `Agnes 拆分任务：${parent.id} → ${plan.subtasks.length} 个子任务`);
    // 子任务超时不超过父任务预算；过短的值由 createTask 里的 _planSubtaskTimeoutFloor 兜底。
    const planTimeoutSec = Math.max(LIMITS.MIN_TASK_TIMEOUT_SEC, value.timeoutSec);
    const allowedTags = new Set();
    for (const device of this.devices.values()) {
      if (device.disabled) continue;
      for (const tag of device.tags || []) allowedTags.add(tag);
    }
    const plannerDeviceIds = new Set(
      [...this.devices.values()].filter((device) => !device.disabled).map((device) => device.id),
    );
    for (let planIndex = 0; planIndex < plan.subtasks.length; planIndex += 1) {
      const subtask = plan.subtasks[planIndex];
      // dependsOn 只允许指向更靠前的子任务（planner 已归一化，这里再兜底一次）。
      const dependsOn = util
        .arr(subtask.dependsOn)
        .map((n) => Math.trunc(Number(n)))
        .filter((n) => Number.isInteger(n) && n >= 0 && n < planIndex)
        .filter((n, i, arr) => arr.indexOf(n) === i)
        .slice(0, 10)
        .sort((a, b) => a - b);
      const subtaskInstruction = String(subtask.instruction || '');
      const plannerDeviceId = util.str(subtask.deviceId, 80);
      const plannerTags = util
        .arr(subtask.tags)
        .map((tag) => util.str(tag, 40))
        .filter((tag) => tag && allowedTags.has(tag))
        .slice(0, 5);
      const childRequirements = { ...planRequirements };
      const childAdvice = {};
      // 子任务指令自身提到本机文件时，文件存在性证据优先于规划器的设备猜测。
      const childPreflight = userDeviceId ? null : this._preflightAdvice(subtaskInstruction);
      const inheritedPreflight = routingAdvice && routingAdvice.preflight;
      if (childPreflight) {
        childRequirements.deviceId = childPreflight.deviceId;
        childAdvice.preflight = childPreflight;
      } else if (inheritedPreflight) {
        childAdvice.preflight = inheritedPreflight;
      }
      if (plannerDeviceId && !plannerDeviceIds.has(plannerDeviceId)) {
        this.log('warn', `Agnes 指派的设备不存在或已禁用，已忽略：${plannerDeviceId}`);
      } else if (plannerDeviceId && !userDeviceId) {
        if (childPreflight) {
          if (plannerDeviceId !== childPreflight.deviceId) {
            this.log(
              'warn',
              `Agnes 指派的设备与本地文件预检冲突，按预检固定到 ${childPreflight.deviceId}：${plannerDeviceId}`,
            );
          }
        } else {
          const plannerDevice = this.devices.get(plannerDeviceId);
          // 规划器指派不能覆盖用户的其他要求（model/skills/tags 等）。
          const matched = protocol.matchRequirements(
            this._capabilitiesForMatch(plannerDevice),
            { ...planRequirements, deviceId: null },
          );
          if (!matched.ok) {
            this.log(
              'warn',
              `Agnes 指派的设备不满足用户要求（缺少 ${matched.missing.join(', ')}），已忽略：${plannerDeviceId}`,
            );
          } else {
            childRequirements.deviceId = plannerDeviceId;
            childAdvice.planner = {
              deviceId: plannerDeviceId,
              deviceName: deviceDisplayName(plannerDevice),
              reason: `Agnes 指派：${util.truncate(subtaskInstruction, 60)}`,
            };
          }
        }
      }
      if (plannerTags.length && !childRequirements.deviceId && !childRequirements.tags.length) {
        childRequirements.tags = [...new Set(plannerTags)];
      }
      const child = this.createTask(
        {
          instruction: subtask.instruction,
          requirements: childRequirements,
          priority: parent.priority,
          timeoutSec: Math.min(planTimeoutSec, subtask.timeoutSec),
          maxAttempts: parent.maxAttempts,
          parentTaskId: parent.id,
          threadId: parent.threadId,
          threadStep: 1,
          // 计划子任务必须带主任务上下文：设备端据此还原「这句话是在做什么」，
          // 避免只看到「GUI 项目 / 这里」这类指代就误解方向。
          context: {
            parentTaskId: parent.id,
            parentInstruction: util.truncate(String(parent.instruction || ''), 4000),
            planStep: planIndex + 1,
            planTotal: plan.subtasks.length,
            planTitle: util.str(plan.title, 120) || null,
            ...(planGoalId ? { goalId: planGoalId } : {}),
          },
          attachments: parent.attachments || [],
        },
        // 先不派发：写完依赖元数据再决定是否可以上路。
        { routingAdvice: Object.keys(childAdvice).length ? childAdvice : null, deferRoute: true },
      );
      child.planStep = planIndex + 1;
      child.planGroup = util.str(subtask.parallelGroup, 60) || null;
      child.planDependsOn = dependsOn;
      child.planDependsOnTaskIds = dependsOn
        .map((index) => parent.childTaskIds[index])
        .filter((id) => typeof id === 'string' && id);
      parent.childTaskIds.push(child.id);
      // 依赖已就绪的立即派发；未就绪的由 routeTask 保持 queued 并写明「等待前置子任务」。
      this.routeTask(child);
    }
    parent.updatedAt = protocol.nowIso();
    this.broadcast('task.updated', { task: this.taskToJson(parent) });
    this._scheduleTaskRecord(parent.id, 0);
    this.schedulePersist();
    return parent;
  }

  /**
   * 计算计划卡点：前置子任务已失败/超时/取消，且仍有依赖它的子任务在排队。
   * 卡点会写进父任务进度，等待用户确认（重试失败子任务或取消计划）后才继续。
   * @returns {{text:string, blockedTaskIds:string[]}|null}
   */
  _planBlocker(parent) {
    if (!parent || !parent.isPlan) return null;
    const children = (parent.childTaskIds || []).map((id) => this.tasks.get(id)).filter(Boolean);
    const finished = children.filter((task) => TERMINAL_TASK_STATUSES.has(task.status));
    if (!finished.length || finished.length === children.length) return null;
    const failed = finished.filter((task) => task.status !== TASK_STATUS.COMPLETED);
    if (!failed.length) return null;
    const failedIds = failed.map((task) => task.id);
    const waiting = children.filter(
      (task) =>
        task.status === TASK_STATUS.QUEUED &&
        Array.isArray(task.planDependsOnTaskIds) &&
        task.planDependsOnTaskIds.some((id) => failedIds.includes(id)),
    );
    if (!waiting.length) return null;
    const describe = (task) =>
      task ? `第 ${task.planStep || '?'} 步「${util.truncate(task.instruction, 24)}」` : '前置子任务';
    return {
      text: `卡点：${failed.map(describe).join('、')} 未完成，后续 ${waiting.length} 个子任务已暂停，等待确认（重试失败子任务或取消计划）`,
      blockedTaskIds: failedIds,
    };
  }

  _reconcileParent(parent) {
    if (!parent || !parent.isPlan) return;
    if (parent.status === TASK_STATUS.CANCELLED) return;
    const children = parent.childTaskIds.map((id) => this.tasks.get(id)).filter(Boolean);
    if (!children.length) return;
    const finished = children.filter((task) => TERMINAL_TASK_STATUSES.has(task.status));
    const failed = finished.filter((task) => task.status !== TASK_STATUS.COMPLETED);
    const waiting = children.filter((task) => task.status === TASK_STATUS.WAITING);
    const blocker = this._planBlocker(parent);
    const allDone = finished.length === children.length;
    const at = protocol.nowIso();
    if (allDone) {
      const nextStatus = failed.length ? TASK_STATUS.FAILED : TASK_STATUS.COMPLETED;
      const nextError = failed.length ? `${failed.length} 个子任务失败` : null;
      if (parent.status === nextStatus && (parent.error || null) === nextError && parent.progress && parent.progress.percent === 100) {
        return;
      }
      parent.updatedAt = at;
      parent.status = nextStatus;
      parent.finishedAt = at;
      parent.progress = { message: '全部子任务结束', percent: 100, logs: [], at };
      parent.output = {
        text: `Agnes 拆分的 ${children.length} 个子任务已结束：完成 ${children.length - failed.length} 个，失败 ${failed.length} 个。`,
      };
      parent.error = nextError;
      parent.events.push({ at, type: parent.status, message: parent.output.text });
      this.broadcast(parent.status === TASK_STATUS.COMPLETED ? 'task.completed' : 'task.failed', {
        task: this.taskToJson(parent),
      });
      // 计划父任务本身也可能是长期目标的关联任务：结束时同样回写目标（检查历史/建议/runningTaskId）。
      this._goalTaskFinished(parent);
      // 管家心路：未关联目标的计划完成时也记一条工作日志（关联目标时由目标检查条目覆盖）。
      if (!parent.goalId) this._journalTaskFinish(parent);
      this._scheduleTaskRecord(parent.id);
      this.schedulePersist();
      return;
    }
    const percent = children.length ? Math.round((finished.length / children.length) * 100) : 0;
    let message = `子任务 ${finished.length}/${children.length} 已完成`;
    if (waiting.length) {
      message += `；等待回答：${waiting.map((task) => `第 ${task.planStep || '?'} 步`).join('、')}`;
    }
    if (blocker) message += `；${blocker.text}`;
    if (
      parent.progress &&
      parent.progress.percent === percent &&
      parent.progress.message === message &&
      Boolean(parent.progress.blocked) === Boolean(blocker)
    ) {
      return;
    }
    parent.updatedAt = at;
    parent.progress = {
      message,
      percent,
      logs: [],
      waiting: waiting.length > 0,
      blocked: Boolean(blocker),
      at,
    };
    if (blocker) {
      const alreadyLogged = parent.events.some((event) => event.type === 'blocked' && event.message === blocker.text);
      if (!alreadyLogged) {
        parent.events.push({ at, type: 'blocked', message: blocker.text });
        this._journalMilestone(parent, blocker);
      }
    }
    this.broadcast('task.updated', { task: this.taskToJson(parent) });
    this._scheduleTaskRecord(parent.id);
    this.schedulePersist();
  }

  /** 子任务状态变化后推进计划：依赖已满足的排队子任务重新进入路由。 */
  _advancePlan(parent) {
    if (!parent || !parent.isPlan) return;
    if (parent.status !== TASK_STATUS.RUNNING) return;
    for (const id of parent.childTaskIds || []) {
      const child = this.tasks.get(id);
      if (child && child.status === TASK_STATUS.QUEUED) this.routeTask(child);
    }
  }

  reconcilePlans() {
    for (const task of this.tasks.values()) {
      if (task.isPlan) this._reconcileParent(task);
    }
  }

  _updateParentTask(child) {
    if (!child || !child.parentTaskId) return;
    const parent = this.tasks.get(child.parentTaskId);
    if (!parent || !parent.isPlan) return;
    this._advancePlan(parent);
    this._reconcileParent(parent);
  }

  archiveTask(task, archived = true) {
    const threadTasks = [...this.tasks.values()].filter(
      (item) => (item.threadId || item.id) === (task.threadId || task.id),
    );
    const targets = [...new Set([task, ...threadTasks, ...(task.childTaskIds || []).map((id) => this.tasks.get(id)).filter(Boolean)])];
    const at = protocol.nowIso();
    for (const item of targets) {
      item.archived = archived;
      item.archivedAt = archived ? at : null;
      item.updatedAt = at;
      this.broadcast('task.updated', { task: this.taskToJson(item) });
    }
    this.schedulePersist();
    return task;
  }

  deleteTask(task) {
    const threadTasks = [...this.tasks.values()].filter(
      (item) => (item.threadId || item.id) === (task.threadId || task.id),
    );
    const ids = [...new Set([
      task.id,
      ...threadTasks.map((item) => item.id),
      ...(task.childTaskIds || []),
    ])];
    for (const id of ids) {
      const item = this.tasks.get(id);
      if (!item) continue;
      this._clearTaskTimers(id);
      this.tasks.delete(id);
      this.broadcast('task.deleted', { taskId: id });
    }
    this.schedulePersist();
    return task;
  }

  // ---------------------------------------------------------------- 回收站

  /** 回收站的目标集合：任务本身 + 同线程任务 + 计划子任务。 */
  _trashTargets(task) {
    const threadTasks = [...this.tasks.values()].filter(
      (item) => (item.threadId || item.id) === (task.threadId || task.id),
    );
    const children = (task.childTaskIds || [])
      .map((id) => this.tasks.get(id))
      .filter(Boolean);
    return [...new Set([task, ...threadTasks, ...children])];
  }

  /**
   * 把已结束的任务移入回收站（不删除数据，仅从常规列表/统计/大脑快照中隐藏）。
   * @param {object} task
   * @returns {object} 入参任务
   */
  trashTask(task) {
    if (!TERMINAL_TASK_STATUSES.has(task.status)) {
      throw badRequest('只能回收已结束的任务');
    }
    if (task.trashedAt) return task;
    const targets = this._trashTargets(task).filter((item) => TERMINAL_TASK_STATUSES.has(item.status));
    const at = protocol.nowIso();
    for (const item of targets) {
      item.trashedAt = at;
      // 回收站与归档互斥，避免出现「已归档 + 回收站」双重状态。
      item.archived = false;
      item.archivedAt = null;
      item.updatedAt = at;
      this._pushTaskEvent(item, 'trashed', '任务移入回收站');
      this.broadcast('task.updated', { task: this.taskToJson(item) });
    }
    const skipped = this._trashTargets(task).length - targets.length;
    this.log('info', `任务移入回收站：${task.id}${skipped > 0 ? `（跳过 ${skipped} 个未结束任务）` : ''}`);
    this.schedulePersist();
    return task;
  }

  /**
   * 从回收站恢复任务（同线程与计划子任务一起恢复）。
   * @param {object} task
   * @returns {object} 入参任务
   */
  restoreTask(task) {
    if (!task.trashedAt) throw badRequest('任务不在回收站中');
    const targets = this._trashTargets(task).filter((item) => item.trashedAt);
    const at = protocol.nowIso();
    for (const item of targets) {
      item.trashedAt = null;
      item.updatedAt = at;
      this._pushTaskEvent(item, 'restored', '任务已恢复');
      this.broadcast('task.updated', { task: this.taskToJson(item) });
    }
    this.log('info', `任务已从回收站恢复：${task.id}`);
    this.schedulePersist();
    return task;
  }

  /**
   * 彻底删除回收站中的任务（含同线程任务与计划子任务），并清理目标引用与执行记录文件。
   * @param {object} task
   * @returns {{taskId:string, deleted:string[]}}
   */
  purgeTask(task) {
    if (!task.trashedAt) throw badRequest('只能彻底删除回收站中的任务');
    const ids = [...new Set(
      this._trashTargets(task).filter((item) => item.trashedAt).map((item) => item.id),
    )];
    for (const id of ids) {
      const item = this.tasks.get(id);
      if (!item) continue;
      this._pushTaskEvent(item, 'purged', '任务已彻底删除');
      const recordFile = this._taskRecordFile(item);
      if (recordFile) {
        try {
          fs.unlinkSync(recordFile);
        } catch {
          // 记录文件可能尚未写入或已被删除，忽略即可。
        }
      }
      const recordTimer = this._recordTimers && this._recordTimers.get(id);
      if (recordTimer) {
        clearTimeout(recordTimer);
        this._recordTimers.delete(id);
      }
      this._clearTaskTimers(id);
      this.tasks.delete(id);
      this._detachTaskFromGoals(id);
      this.broadcast('task.deleted', { taskId: id });
    }
    this.log('info', `任务已彻底删除：${task.id}${ids.length > 1 ? `（共 ${ids.length} 个）` : ''}`);
    if (this.recordEnabled) this._scheduleRecordIndex(200);
    this.schedulePersist();
    return { taskId: task.id, deleted: ids };
  }

  /** 任务执行记录文件路径（与 task-record.js 的写入口径一致：<recordDir>/<YYYY-MM-DD>/<taskId>.md）。 */
  _taskRecordFile(task) {
    if (!this.recordEnabled || !task || !task.createdAt) return null;
    // 与 task-record.js 的 dayOf 保持一致：按 createdAt 的 UTC 日期分目录
    // （以前用本地时区分日，跨过本地午夜后删除/查询会指向另一个目录）。
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(task.createdAt));
    if (!match) return null;
    const day = `${match[1]}-${match[2]}-${match[3]}`;
    return path.resolve(String(this.recordDir || '.'), day, `${task.id}.md`);
  }

  /** 删除任务后，清理长期目标里的任务引用。 */
  _detachTaskFromGoals(taskId) {
    let touched = false;
    for (const goal of this.goals.values()) {
      const hasRef = Array.isArray(goal.taskIds) && goal.taskIds.includes(taskId);
      if (!hasRef) continue;
      goal.taskIds = goal.taskIds.filter((id) => id !== taskId);
      if (goal.runningTaskId === taskId) goal.runningTaskId = null;
      if (goal.lastTaskId === taskId) goal.lastTaskId = null;
      goal.updatedAt = protocol.nowIso();
      touched = true;
      this.broadcast('goal.updated', { goal: goalToJson(goal) });
    }
    if (touched) this.schedulePersist();
  }

  _capabilitiesForMatch(device) {
    // 设备标签 = manifest 声明的标签 + 按项目/任务历史自动推导的标签（不写回设备 manifest）。
    const tags = [...new Set([...util.arr(device.tags), ...this._autoTagsForDevice(device.id)])];
    return { ...device.capabilities, tags };
  }

  /**
   * 自动标签：设备成功执行过哪些项目，就自动带上这些项目名与项目别名标签。
   * 这样大脑写的项目标签（如「反腐AI」）在对应主机做过该项目后就能匹配，不需要人工维护设备标签。
   * @param {string} deviceId
   * @returns {string[]} manifest 里还没有的自动标签
   */
  _autoTagsForDevice(deviceId) {
    const device = this.devices.get(deviceId);
    const manifest = new Set(util.arr(device && device.tags).map((tag) => util.str(tag, 40)).filter(Boolean));
    const tags = new Set();
    const addProject = (project) => {
      const key = util.str(project, 120);
      if (!key) return;
      const label = util.str(key, 40);
      if (label && !manifest.has(label)) tags.add(label);
      for (const alias of util.arr(this.projectTags.get(key))) {
        const value = util.str(alias, 40);
        if (value && !manifest.has(value)) tags.add(value);
      }
    };
    for (const [project, id] of this.projectAffinity) {
      if (id === deviceId) addProject(project);
    }
    for (const task of this.tasks.values()) {
      if (task.status !== TASK_STATUS.COMPLETED || task.assignedDeviceId !== deviceId) continue;
      const project = this._taskProject(task);
      if (project) addProject(project);
    }
    return [...tags].slice(-40);
  }

  /**
   * 学习项目别名标签：项目任务要求里出现过的标签（例如大脑自造的项目标签）记成该项目的别名，
   * 后续设备做过该项目就自动获得这些标签，避免任务因「缺少 tag」永久排队。
   * @param {string} project
   * @param {string[]} tags
   */
  _learnProjectTags(project, tags) {
    const key = util.str(project, 120);
    if (!key) return;
    const previous = util.arr(this.projectTags.get(key));
    const merged = [...previous];
    for (const raw of util.arr(tags)) {
      const tag = util.str(raw, 40);
      if (tag && !merged.includes(tag)) merged.push(tag);
    }
    if (merged.length === previous.length) return;
    this.projectTags.set(key, merged.slice(-20));
    // 与项目亲和一样只保留最近 200 个项目，避免长期运行无限增长。
    while (this.projectTags.size > 200) {
      const oldest = this.projectTags.keys().next().value;
      if (!oldest || oldest === key) break;
      this.projectTags.delete(oldest);
    }
  }

  /** 所有设备当前可匹配的标签（manifest 标签 + 自动标签 + 项目别名）。 */
  _knownDeviceTags() {
    const known = new Set();
    for (const device of this.devices.values()) {
      for (const tag of util.arr(this._capabilitiesForMatch(device).tags)) {
        const value = util.str(tag, 40);
        if (value) known.add(value);
      }
    }
    for (const tags of this.projectTags.values()) {
      for (const tag of util.arr(tags)) {
        const value = util.str(tag, 40);
        if (value) known.add(value);
      }
    }
    return known;
  }

  /**
   * 匹配设备需求：显式 requirements.deviceId 钉住的设备如果只缺标签（标签可能是描述性/项目别名），
   * 不因这些标签阻塞派发；缺 model/skills/profile/gateway 等硬能力仍然排除。
   * @returns {{ok:boolean, matched:string[], missing:string[], effective:object}}
   */
  _matchDeviceRequirements(device, requirements) {
    const matched = protocol.matchRequirements(this._capabilitiesForMatch(device), requirements);
    if (matched.ok) return { ...matched, effective: requirements };
    const pinned = requirements && requirements.deviceId === device.id;
    if (!pinned) return { ...matched, effective: requirements };
    const hardMissing = matched.missing.filter((item) => !String(item).startsWith('tag:'));
    if (hardMissing.length) return { ...matched, effective: requirements };
    return {
      ok: true,
      matched: matched.matched,
      missing: [],
      effective: { ...requirements, tags: [] },
    };
  }

  /**
   * 自主大脑可能把项目名/任务名当成设备标签写进 requirements.tags（例如「反腐AI」「验证」）。
   * 有项目时把这些标签学成项目别名并保留（设备做过该项目后自动匹配）；没有项目时只保留真实存在的设备标签，
   * 避免任务永远排队。
   * @returns {{requirements: object|null, droppedTags: string[], learnedTags: string[]}}
   */
  _sanitizeBrainRequirements(requirements) {
    if (!util.isPlainObject(requirements)) return { requirements: null, droppedTags: [], learnedTags: [] };
    const tags = util.arr(requirements.tags).map((tag) => util.str(tag, 40)).filter(Boolean);
    if (!tags.length) return { requirements, droppedTags: [], learnedTags: [] };
    const known = this._knownDeviceTags();
    const project = util.str(requirements.project, 120) || null;
    const kept = [];
    const dropped = [];
    const learned = [];
    for (const tag of tags) {
      if (known.has(tag)) kept.push(tag);
      else if (project) {
        kept.push(tag);
        learned.push(tag);
      } else dropped.push(tag);
    }
    if (project && learned.length) this._learnProjectTags(project, learned);
    if (!dropped.length) return { requirements, droppedTags: [], learnedTags: learned };
    const next = { ...requirements };
    if (kept.length) next.tags = kept;
    else delete next.tags;
    return { requirements: next, droppedTags: dropped, learnedTags: learned };
  }

  /**
   * 派发前软化标签门槛：任务要求里的标签如果在所有设备上都不存在（模型自造的项目名/任务名），
   * 不再把所有设备硬性排除，而是降级为 hint 提示；真实存在的标签仍然按标签匹配。
   * @param {object} task
   * @returns {object} 本次派发使用的 requirements
   */
  _softenRoutingRequirements(task) {
    const requirements = task.requirements;
    const tags = util.arr(requirements && requirements.tags).map((tag) => util.str(tag, 40)).filter(Boolean);
    if (!tags.length) return requirements;
    const known = this._knownDeviceTags();
    const kept = tags.filter((tag) => known.has(tag));
    if (kept.length === tags.length) return requirements;
    const dropped = tags.filter((tag) => !known.has(tag));
    const hint = [...new Set([...util.arr(requirements.hint), ...dropped])].slice(0, 8);
    const next = { ...requirements, hint, tags: kept };
    task.requirements = next;
    task.updatedAt = protocol.nowIso();
    this._pushTaskEvent(task, 'warning', `标签 ${dropped.join('、')} 没有设备支持，已降级为提示（不阻塞派发）`);
    this.log('warn', `${task.id} 标签 ${dropped.join('、')} 无设备支持，已降级为提示`);
    this.broadcast('task.updated', { task: this.taskToJson(task) });
    this.schedulePersist();
    return next;
  }

  _maxConcurrent(device) {
    return Math.max(1, device.capabilities.limits.maxConcurrentTasks || 1);
  }

  /**
   * 拆分计划的依赖闸门：前置子任务未全部完成时不派发。
   * - 前置还在执行：等待依赖就绪（不算卡点）；
   * - 前置已失败/超时/取消：卡点，等待用户确认（重试或取消该子任务）。
   * @returns {{reason:string, blocked:boolean}|null} 返回 null 表示依赖已满足，可以正常路由
   */
  _planDependencyGate(task) {
    const ids = Array.isArray(task && task.planDependsOnTaskIds) ? task.planDependsOnTaskIds : [];
    if (!ids.length) return null;
    const missing = ids.filter((id) => !this.tasks.get(id));
    const deps = ids.map((id) => this.tasks.get(id)).filter(Boolean);
    const pending = deps.filter((dep) => dep.status !== TASK_STATUS.COMPLETED);
    if (!pending.length && !missing.length) return null;
    const describe = (dep) => {
      const step = dep.planStep ? `第 ${dep.planStep} 步` : '前置子任务';
      return `${step}「${util.truncate(dep.instruction, 24)}」`;
    };
    const failed = pending.filter((dep) => TERMINAL_TASK_STATUSES.has(dep.status));
    if (failed.length) {
      const failedText = failed
        .map((dep) => {
          const label =
            dep.status === TASK_STATUS.FAILED
              ? '失败'
              : dep.status === TASK_STATUS.TIMEOUT
                ? '超时'
                : '已取消';
          return `${describe(dep)}（${label}）`;
        })
        .join('、');
      return {
        reason: `卡点：${failedText}，等待确认（重试该子任务或取消本计划）`,
        blocked: true,
      };
    }
    if (pending.length) return { reason: `等待前置子任务：${pending.map(describe).join('、')}`, blocked: false };
    if (missing.length) {
      // 依赖的子任务已被清理/删除：继续等待只会永久卡住（用户看不到可操作对象）。
      // 记录一次提示后视为依赖满足，任务照常路由，由执行结果决定下一步。
      return {
        reason: `前置子任务已不存在（${missing.length} 个），已忽略缺失依赖并继续`,
        blocked: false,
        missingOnly: true,
      };
    }
    return null;
  }

  /** 为 queued 任务计算候选并派发；无匹配保持 queued 并记录原因。 */
  routeTask(task) {
    if (task.status !== TASK_STATUS.QUEUED) return task;
    // 绝对派发预算：即使 attempts 被重启/自重启路径改写，也不允许无限派发。
    if (task.attempts >= task.maxAttempts) {
      this._finishTask(task, TASK_STATUS.FAILED, {
        error: `dispatch budget exhausted (${task.attempts}/${task.maxAttempts})`,
        eventMessage: '派发次数已达上限',
      });
      return task;
    }
    // 拆分计划：依赖未满足的子任务先排队，不能提前派发。
    const dependencyGate = this._planDependencyGate(task);
    if (dependencyGate && !dependencyGate.missingOnly) {
      const sameReason = Boolean(task.route) && task.route.reason === dependencyGate.reason;
      task.status = TASK_STATUS.QUEUED;
      task.assignedDeviceId = null;
      task.assignedDeviceName = null;
      task.updatedAt = protocol.nowIso();
      task.route = { reason: dependencyGate.reason, candidates: [], excluded: [] };
      if (!sameReason) {
        this._pushTaskEvent(task, 'queued', dependencyGate.reason);
        this.broadcast('task.updated', { task: this.taskToJson(task) });
        this.schedulePersist();
      }
      return task;
    }
    if (dependencyGate && dependencyGate.missingOnly && !task._planMissingDepsNoted) {
      // 前置子任务已被清理：只提示一次并继续派发，避免任务永久卡在排队。
      task._planMissingDepsNoted = true;
      task.updatedAt = protocol.nowIso();
      this._pushTaskEvent(task, 'warning', dependencyGate.reason);
      this.log('warn', `${task.id} ${dependencyGate.reason}`);
      this.broadcast('task.updated', { task: this.taskToJson(task) });
      this.schedulePersist();
    }
    // 同目标串行（P4）：同一长期目标下自主大脑的顶层任务一次只跑一个。
    const goalBlocker = this._goalActiveBlocker(task);
    if (goalBlocker) {
      const reason = `同目标串行：${goalBlocker.id} 正在执行（per-goal 并发 1），排队等待`;
      const sameReason = Boolean(task.route) && task.route.reason === reason;
      task.status = TASK_STATUS.QUEUED;
      task.assignedDeviceId = null;
      task.assignedDeviceName = null;
      task.updatedAt = protocol.nowIso();
      task.route = {
        reason,
        candidates: [],
        excluded: [{ deviceId: goalBlocker.assignedDeviceId || null, reason: 'goal-busy' }],
      };
      if (!sameReason) {
        this._pushTaskEvent(task, 'queued', reason);
        this.broadcast('task.updated', { task: this.taskToJson(task) });
        this.schedulePersist();
      }
      return task;
    }
    const requirements = this._softenRoutingRequirements(task);
    const candidates = [];
    const excluded = [];
    // 设备占用 = 已分配但还没结束的任务数（assigned/running/waiting）。
    // 只看 load.running 会把“已分配但尚未 ack”的任务漏算，导致单并发设备（如 Mika 手机）被同时塞进多个任务。
    const occupancy = new Map();
    for (const current of this.tasks.values()) {
      if (!current.assignedDeviceId || !ACTIVE_TASK_STATUSES.has(current.status)) continue;
      occupancy.set(current.assignedDeviceId, (occupancy.get(current.assignedDeviceId) || 0) + 1);
    }

    for (const device of this.devices.values()) {
      let reason = null;
      // 显式钉住的设备只缺描述性标签时不阻塞派发，评分也按去掉标签的需求计算。
      let effectiveRequirements = requirements;
      if (device.disabled) {
        reason = 'disabled';
      } else if (!device.online) {
        reason = 'offline';
      } else if ((occupancy.get(device.id) || 0) >= this._maxConcurrent(device)) {
        reason = `at capacity (${occupancy.get(device.id) || 0}/${this._maxConcurrent(device)})`;
      } else if (requirements.deviceId && requirements.deviceId !== device.id) {
        reason = 'deviceId mismatch';
      } else {
        const matched = this._matchDeviceRequirements(device, requirements);
        if (!matched.ok) reason = `missing ${matched.missing.join(', ')}`;
        else effectiveRequirements = matched.effective;
      }
      if (reason) {
        excluded.push({ deviceId: device.id, reason });
        continue;
      }
      const scored = protocol.scoreDevice(
        {
          id: device.id,
          capabilities: this._capabilitiesForMatch(device),
          // 评分同样用真实占用，避免把任务继续压给“已分配未 ack”的设备。
          load: { running: occupancy.get(device.id) || 0, max: device.load.max },
          lastSeenAt: device.lastSeenAt,
        },
        effectiveRequirements,
      );
      if (scored.score < 0) {
        excluded.push({ deviceId: device.id, reason: `missing ${scored.missing.join(', ')}` });
        continue;
      }
      candidates.push({
        deviceId: device.id,
        score: scored.score,
        matched: scored.matched,
        lastSeenAt: device.lastSeenAt || '',
      });
    }

    candidates.sort(
      (a, b) =>
        b.score - a.score || String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)),
    );

    const avoid = new Set(task._avoidDeviceIds || []);
    const usable = avoid.size ? candidates.filter((c) => !avoid.has(c.deviceId)) : candidates;
    let pickedCandidate = usable[0] || candidates[0];
    // 亲和派发：优先回到项目/线程/母机所在的设备，避免让没有项目上下文的主机接走任务。
    // requirements.deviceId 是显式硬锁，优先级最高，此时不再做软亲和判断。
    const affinityPreference = requirements.deviceId ? null : this._preferredDeviceFor(task);
    const affinityDecision = this._affinityDecision(task, affinityPreference, occupancy);
    let affinityNote = '';
    if (affinityDecision.kind === 'lock') {
      const affinityDevice = affinityDecision.device;
      const scored = protocol.scoreDevice(
        {
          id: affinityDevice.id,
          capabilities: this._capabilitiesForMatch(affinityDevice),
          load: { running: occupancy.get(affinityDevice.id) || 0, max: affinityDevice.load.max },
          lastSeenAt: affinityDevice.lastSeenAt,
        },
        requirements,
      );
      pickedCandidate = {
        deviceId: affinityDevice.id,
        score: Math.max(scored.score, 0),
        matched: scored.matched,
        lastSeenAt: affinityDevice.lastSeenAt || '',
      };
      affinityNote = affinityPreference.reason;
      // 亲和锁定的设备即使之前失败过也优先继续用（同项目上下文比“换一台”更重要）。
      task._avoidDeviceIds = [];
    } else if (affinityDecision.kind === 'wait') {
      // 首选主机离线/并发已满：排队等它，不把任务交给没有上下文的其它主机。
      const reason = this._withAdvice(this._routingAdviceText(task.routingAdvice), `亲和等待：${affinityDecision.note}`);
      const sameReason = Boolean(task.route) && task.route.reason === reason;
      task.status = TASK_STATUS.QUEUED;
      task.assignedDeviceId = null;
      task.assignedDeviceName = null;
      task.updatedAt = protocol.nowIso();
      task.route = { reason, candidates: [], excluded: excluded.slice(0, 10) };
      if (!sameReason) {
        this._pushTaskEvent(task, 'queued', `亲和等待：${affinityDecision.note}`);
        this.broadcast('task.updated', { task: this.taskToJson(task) });
        this.schedulePersist();
      }
      return task;
    } else if (affinityDecision.kind === 'fallback') {
      affinityNote = `（${affinityDecision.note}，回退普通路由）`;
    }

    if (!pickedCandidate) {
      task.status = TASK_STATUS.QUEUED;
      task.assignedDeviceId = null;
      task.assignedDeviceName = null;
      task.updatedAt = protocol.nowIso();
      const firstReason = excluded.length ? excluded[0].reason : 'no devices registered';
      task.route = {
        reason: this._withAdvice(
          this._routingAdviceText(task.routingAdvice),
          `no matching device (${excluded.length} excluded): ${firstReason}`,
        ),
        candidates: [],
        excluded: excluded.slice(0, 10),
      };
      this._pushTaskEvent(task, 'queued', `暂无匹配设备：${firstReason}`);
      this.broadcast('task.updated', { task: this.taskToJson(task) });
      return task;
    }

    if (!avoid.has(pickedCandidate.deviceId)) task._avoidDeviceIds = [];

    const device = this.devices.get(pickedCandidate.deviceId);
    if (!device) return task;

    const now = protocol.nowIso();
    task.attempts += 1;
    task.status = TASK_STATUS.ASSIGNED;
    task.assignedDeviceId = device.id;
    task.assignedDeviceName = deviceDisplayName(device);
    task.updatedAt = now;
    task.error = null;
    // 第一次派发即固定亲和设备：后续失败重试/重投继续交给同一台主机，保留项目上下文。
    if (!task.affinity) {
      task.affinity = {
        deviceId: device.id,
        reason: affinityNote || `首次派发到 ${deviceDisplayName(device)}`,
        at: now,
      };
    }
    task.route = {
      reason: this._withAdvice(
        this._routingAdviceText(task.routingAdvice),
        affinityNote
          ? `${affinityNote}; picked ${device.id} (score ${pickedCandidate.score})`
          : `matched ${candidates.length} candidate${candidates.length === 1 ? '' : 's'}; picked ${device.id} (score ${pickedCandidate.score})`,
      ),
      candidates: candidates.slice(0, 5).map((c) => ({
        deviceId: c.deviceId,
        score: c.score,
        matched: c.matched,
      })),
      excluded: excluded.slice(0, 10),
    };
    this._pushTaskEvent(
      task,
      'assigned',
      `派发到 ${deviceDisplayName(device)}（第 ${task.attempts}/${task.maxAttempts} 次尝试）`,
    );
    this.enqueueCommand(device, this._runCommandForAttempt(task, device, task.attempts));
    this._setTaskTimer(task.id, 'ack', () => {
      this._handleAckTimeout(task, device.id, task.attempts);
    }, this.ackTimeoutMs);
    this._refreshTaskTimeout(task);
    this.broadcast('task.updated', { task: this.taskToJson(task) });
    this.log('info', `任务派发：${task.id} → ${deviceDisplayName(device)}（score ${pickedCandidate.score}）`);
    this.schedulePersist();
    return task;
  }

  /**
   * 设备上线 / 能力变化 / 空槽释放后补派排队任务（优先级高者先）。
   * @param {string} reason 触发原因（用于持久化调度）
   * @param {number|null} budget 本次最多派发几条；null=按 redispatchBudget 与空闲槽位自动计算
   * @returns {number} 实际派发出去的任务数
   */
  retryQueuedTasks(reason = '', budget = null) {
    const now = Date.now();
    const queued = [...this.tasks.values()]
      .filter((task) => task.status === TASK_STATUS.QUEUED)
      .sort(
        (a, b) =>
          this._effectivePriority(b, now) - this._effectivePriority(a, now)
          || String(a.createdAt).localeCompare(String(b.createdAt)),
      );
    if (!queued.length) return 0;
    const limit =
      budget === null
        ? this.redispatchBudget
          ? Math.min(this.redispatchBudget, this._freeDeviceSlots())
          : queued.length
        : Math.max(0, Math.trunc(budget));
    if (limit <= 0) {
      if (reason) this.schedulePersist();
      return 0;
    }
    let dispatched = 0;
    for (const task of queued) {
      if (dispatched >= limit) break;
      this.routeTask(task);
      if (this._isDispatchedTask(task)) dispatched += 1;
    }
    if (reason) this.schedulePersist();
    return dispatched;
  }

  /** routeTask 之后该任务是否真的离开 queued 上到设备。 */
  _isDispatchedTask(task) {
    if (!task || !task.assignedDeviceId) return false;
    return task.status !== TASK_STATUS.QUEUED && !TERMINAL_TASK_STATUSES.has(task.status);
  }

  /** 有效优先级：排队每小时 +1（最多 +3），避免低优先级任务长期挨饿（P4 优先级老化）。 */
  _effectivePriority(task, now = Date.now()) {
    const base = Number.isFinite(task && task.priority) ? task.priority : 0;
    const createdAt = Date.parse(task && task.createdAt);
    if (!Number.isFinite(createdAt)) return base;
    const hours = Math.min(3, Math.floor(Math.max(0, now - createdAt) / 3600000));
    return base + hours;
  }

  /** 在线且未禁用设备的剩余并发槽位总和。 */
  _freeDeviceSlots() {
    let free = 0;
    for (const device of this.devices.values()) {
      if (!device.online || device.disabled) continue;
      const running = device.load ? device.load.running : 0;
      free += Math.max(0, this._maxConcurrent(device) - running);
    }
    return free;
  }

  /** 去重归一化：小写、去掉空白/标点/符号，取前 N 个字符。 */
  _normalizeForDedupe(instruction, length = 60) {
    return String(instruction || '')
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, '')
      .slice(0, length);
  }

  /** 字符二元组集合（用于同目标任务的相似度判定）。 */
  _dedupeGrams(instruction) {
    const text = this._normalizeForDedupe(instruction, 200);
    const grams = new Set();
    for (let i = 0; i < text.length - 1; i += 1) grams.add(text.slice(i, i + 2));
    return grams;
  }

  /** 字符 bigram Jaccard 相似度（0~1）。 */
  _instructionSimilarity(a, b) {
    const left = this._dedupeGrams(a);
    const right = this._dedupeGrams(b);
    if (!left.size || !right.size) return 0;
    let shared = 0;
    for (const gram of left) if (right.has(gram)) shared += 1;
    return shared / (left.size + right.size - shared);
  }

  /** 找到与指令近似重复的在途任务：去标点后前 60 字包含，或同目标 bigram Jaccard ≥ 0.6。 */
  _findDuplicateTask(instruction, goalId = null) {
    const normalized = this._normalizeForDedupe(instruction);
    if (!normalized) return null;
    for (const task of this.tasks.values()) {
      if (TERMINAL_TASK_STATUSES.has(task.status)) continue;
      const other = this._normalizeForDedupe(task.instruction);
      if (other && (other.startsWith(normalized) || normalized.startsWith(other))) return task;
      if (goalId && task.goalId === goalId && this._instructionSimilarity(instruction, task.instruction) >= 0.6) {
        return task;
      }
    }
    return null;
  }

  /** 目标下是否有在途任务（queued/assigned/running/waiting）：同目标并发闸用。 */
  _activeTaskForGoal(goalId) {
    if (!goalId) return null;
    for (const task of this.tasks.values()) {
      if (task.goalId !== goalId || TERMINAL_TASK_STATUSES.has(task.status)) continue;
      return task;
    }
    return null;
  }

  /**
   * 同目标串行闸（P4）：只约束自主大脑创建的同目标顶层任务，一次只跑一个；
   * 计划子任务由父计划自己调度，用户手工任务不拦。返回正在执行的那条任务。
   */
  _goalActiveBlocker(task) {
    if (!task || !task.goalId || task.parentTaskId) return null;
    if (!task.context || task.context.brain !== true) return null;
    for (const other of this.tasks.values()) {
      if (other.id === task.id) continue;
      if (other.goalId !== task.goalId || other.parentTaskId) continue;
      if (!ACTIVE_TASK_STATUSES.has(other.status)) continue;
      return other;
    }
    return null;
  }

  /** 最早超过 queueStuckMs 仍在排队的任务（队列健康闸用）。 */
  _oldestStuckQueuedTask(now = Date.now()) {
    if (!this.queueStuckMs) return null;
    let oldest = null;
    for (const task of this.tasks.values()) {
      if (task.status !== TASK_STATUS.QUEUED) continue;
      const createdAt = Date.parse(task.createdAt);
      if (!Number.isFinite(createdAt) || now - createdAt < this.queueStuckMs) continue;
      if (!oldest || createdAt < Date.parse(oldest.createdAt)) oldest = task;
    }
    return oldest;
  }

  /**
   * 修改未结束任务的执行需求（控制台「一键改需求」与自主大脑 update_task 共用）。
   * 排队中的任务改完立即重新路由，避免缺能力/缺设备导致永久排队。
   */
  updateTask(taskOrId, patch = {}) {
    const task = typeof taskOrId === 'string' ? this._requireTask(taskOrId) : taskOrId;
    if (!task || !this.tasks.has(task.id)) throw notFound('任务不存在');
    if (TERMINAL_TASK_STATUSES.has(task.status)) throw badRequest('只能修改未结束任务的需求');
    const body = util.isPlainObject(patch) ? patch : {};
    const changes = [];
    if (Number.isFinite(body.priority)) {
      const priority = util.clampInt(body.priority, task.priority, 0, 9);
      if (priority !== task.priority) {
        task.priority = priority;
        changes.push(`优先级 ${priority}`);
      }
    }
    if (Number.isFinite(body.timeoutSec)) {
      const timeoutSec = util.clampInt(
        body.timeoutSec,
        task.timeoutSec,
        protocol.LIMITS.MIN_TASK_TIMEOUT_SEC,
        protocol.LIMITS.MAX_TASK_TIMEOUT_SEC,
      );
      if (timeoutSec !== task.timeoutSec) {
        task.timeoutSec = timeoutSec;
        changes.push(`超时 ${timeoutSec}s`);
      }
    }
    if (util.isPlainObject(body.requirements)) {
      task.requirements = protocol.normalizeRequirements({ ...task.requirements, ...body.requirements });
      const req = task.requirements;
      const parts = [];
      if (req.deviceId) parts.push(`设备 ${req.deviceId}`);
      if (req.skills.length) parts.push(`技能 ${req.skills.join('/')}`);
      if (req.project) parts.push(`项目 ${req.project}`);
      if (req.tags.length) parts.push(`标签 ${req.tags.join('/')}`);
      changes.push(`需求 ${parts.join('，') || '已清空'}`);
    }
    if (!changes.length) return task;
    task.updatedAt = protocol.nowIso();
    this._pushTaskEvent(task, 'progress', `需求已修改：${changes.join('；')}`);
    this.log('info', `${task.id} 需求已修改：${changes.join('；')}`);
    this.broadcast('task.updated', { task: this.taskToJson(task) });
    this.schedulePersist();
    if (task.status === TASK_STATUS.QUEUED) this.routeTask(task);
    return task;
  }

  _buildRunCommand(task, device) {
    // 计划子任务必须把「主任务是谁 / 整体目标 / 这是第几步」带到设备端，
    // 否则子任务里的“这里/该项目”没有任何上下文可指代，执行方向会跑偏。
    const parent = task.parentTaskId ? this.tasks.get(task.parentTaskId) : null;
    const planSiblings = parent
      ? (parent.childTaskIds || [])
          .map((childId) => this.tasks.get(childId))
          .filter(Boolean)
          .slice(0, 12)
          .map((child) => ({
            id: child.id,
            step: Number.isFinite(child.planStep) ? child.planStep : null,
            status: child.status,
            instruction: util.truncate(String(child.instruction || ''), 240),
          }))
      : [];
    const context = {
      deviceName: deviceDisplayName(device),
      requestedAt: protocol.nowIso(),
      taskId: task.id,
      threadId: task.threadId || null,
      ...(task.context || {}),
    };
    if (parent) {
      context.parentTaskId = parent.id;
      context.parentInstruction = util.truncate(String(parent.instruction || ''), 4000);
      if (!Number.isFinite(context.planStep)) {
        context.planStep = Number.isFinite(task.planStep) ? task.planStep : null;
      }
      if (!Number.isFinite(context.planTotal)) {
        context.planTotal = (parent.childTaskIds || []).length || null;
      }
      context.planTitle = context.planTitle || util.str(parent.plan && parent.plan.title, 120) || null;
      if (planSiblings.length) context.planSiblings = planSiblings;
    } else if (task.parentTaskId) {
      context.parentTaskId = task.parentTaskId;
    }
    return {
      id: protocol.randomId('cmd'),
      type: 'run_task',
      taskId: task.id,
      createdAt: protocol.nowIso(),
      payload: {
        instruction: task.instruction,
        requirements: { ...task.requirements },
        priority: task.priority,
        timeoutSec: task.timeoutSec,
        threadId: task.threadId,
        // 结果归因：设备回传同一个 attempt，Hub 才分得清「上一次尝试的迟到结果」和本次尝试。
        attempt: task.attempts,
        replyToTaskId: task.replyToTaskId || null,
        threadStep: task.threadStep || 1,
        parentTaskId: task.parentTaskId || null,
        context,
        attachments: (task.attachments || []).map((file) => ({ ...file })),
      },
    };
  }

  /**
   * 同一 attempt 的重复派发必须复用同一个 command id，设备端才能按 command.id 幂等去重。
   * 只有进入新 attempt（attempts 递增）时才生成新的 command。
   */
  _runCommandForAttempt(task, device, attempt) {
    const cached = task._dispatch;
    if (cached && cached.attempt === attempt && cached.deviceId === device.id && cached.command) {
      return cached.command;
    }
    const command = this._buildRunCommand(task, device);
    task._dispatch = { attempt, deviceId: device.id, command };
    return command;
  }

  /** 设备在线且确实还有任务在跑/排队（不能只看 ack 是否到达）。 */
  _deviceBusy(device) {
    if (!device || !device.online) return false;
    const reported = Number.isFinite(device.reportedRunning) ? device.reportedRunning : 0;
    const taskIds = Array.isArray(device.runningTaskIds) ? device.runningTaskIds : [];
    return device.status === 'busy' || reported > 0 || taskIds.length > 0;
  }

  /**
   * ack 超时：
   * - 设备离线/不存在 → 按协议重新调度（保留原有语义）。
   * - 设备在线但忙碌（任务还在排队） → 不重派，重投同一个 command（同一 id），指数退避等待；
   *   首次推送“设备忙碌”事件，避免用户看到“无意义的 ack timeout 重派”。
   * - 设备空闲却没 ack → 视为派发失败，按预算重排。
   */
  _handleAckTimeout(task, deviceId, attempt) {
    if (!task || task.status !== TASK_STATUS.ASSIGNED) return;
    if (task.assignedDeviceId !== deviceId || task.attempts !== attempt) return;
    const device = this.devices.get(deviceId);
    if (!device || !device.online) {
      this._dispatchFailure(task, device || null, 'ack timeout');
      return;
    }
    if (this._deviceBusy(device) || task.progress) {
      task._ackWaits = (task._ackWaits || 0) + 1;
      task._ackWaitMs = (task._ackWaitMs || 0) + this.ackTimeoutMs;
      if (task._ackWaitMs <= this.ackWaitMaxMs) {
        if (task._ackWaits === 1) {
          this._pushTaskEvent(task, 'queued', '设备忙碌，等待空槽后执行（已确认派发，不重复调度）');
          this.broadcast('task.updated', { task: this.taskToJson(task) });
        }
        this.enqueueCommand(device, this._runCommandForAttempt(task, device, attempt));
        this._setTaskTimer(
          task.id,
          'ack',
          () => this._handleAckTimeout(task, deviceId, attempt),
          Math.min(this.ackTimeoutMs * 2 ** Math.min(task._ackWaits, 5), 5 * 60 * 1000),
        );
        this.schedulePersist();
        return;
      }
    }
    this._dispatchFailure(task, device, 'ack timeout');
  }

  _buildCancelCommand(task, reason) {
    return {
      id: protocol.randomId('cmd'),
      type: 'cancel_task',
      taskId: task.id,
      createdAt: protocol.nowIso(),
      payload: { taskId: task.id, reason },
    };
  }

  _removeTaskCommand(device, taskId) {
    if (!device) return;
    device.commands = device.commands.filter((cmd) => !(cmd && cmd.taskId === taskId));
  }

  _timeoutMsFor(task) {
    return this.timeoutOverrideMs != null ? this.timeoutOverrideMs : Math.max(1000, task.timeoutSec * 1000);
  }

  /**
   * 规划子任务的最小超时：300s，但不超过父任务的超时预算；非规划子任务返回 0。
   * 规划器（Agnes）常把网页检索类子任务给到 60~180s，会导致必然超时。
   */
  _planSubtaskTimeoutFloor(task) {
    if (!task || !task.parentTaskId) return 0;
    const parent = this.tasks.get(task.parentTaskId);
    const parentBudget =
      parent && Number.isFinite(Number(parent.timeoutSec))
        ? Math.max(LIMITS.MIN_TASK_TIMEOUT_SEC, Number(parent.timeoutSec))
        : LIMITS.MAX_TASK_TIMEOUT_SEC;
    return Math.min(300, parentBudget);
  }

  /**
   * 重置任务运行计时器（超时窗口从“最后一次设备活动”开始算）。
   * 设备在执行期间会周期性发 progress keepalive，只要设备还活着就会续期；
   * 真正卡死/失联的任务仍会在 timeoutSec 的静默窗口后超时，不会被无限续命。
   */
  _refreshTaskTimeout(task) {
    if (!task || !ACTIVE_TASK_STATUSES.has(task.status)) return;
    // 即使设备一直发 keepalive，任务也不能无限延长：到达总运行上限后按运行超时处理
    // （_timeoutTask 会在 maxAttempts 内自动重试），避免设备侧 15 分钟硬上限与 Hub 计时器脱节。
    const startedAt = task.startedAt ? Date.parse(task.startedAt) : NaN;
    const maxRunMs = Math.min(60 * 60 * 1000, Math.max(30 * 60 * 1000, this._timeoutMsFor(task) * 6));
    if (Number.isFinite(startedAt) && Date.now() - startedAt > maxRunMs) {
      this._timeoutTask(task);
      return;
    }
    this._setTaskTimer(
      task.id,
      'timeout',
      () => {
        if (!ACTIVE_TASK_STATUSES.has(task.status)) return;
        this._timeoutTask(task);
      },
      this._timeoutMsFor(task),
    );
  }

  _setTaskTimer(taskId, name, fn, ms) {
    let entry = this._timers.get(taskId);
    if (!entry) {
      entry = {};
      this._timers.set(taskId, entry);
    }
    if (entry[name]) clearTimeout(entry[name]);
    const timer = setTimeout(fn, Math.max(1, ms));
    if (timer.unref) timer.unref();
    entry[name] = timer;
  }

  _clearTaskTimers(taskId) {
    const entry = this._timers.get(taskId);
    if (!entry) return;
    if (entry.ack) clearTimeout(entry.ack);
    if (entry.timeout) clearTimeout(entry.timeout);
    this._timers.delete(taskId);
  }

  _adjustLoad(deviceId, delta) {
    const device = deviceId ? this.devices.get(deviceId) : null;
    if (!device) return;
    const max = this._maxConcurrent(device);
    device.load.running = util.clampInt(device.load.running + delta, 0, 0, max);
  }

  /** 派发失败（ack 超时/设备离线）：maxAttempts 内重排，否则 failed。 */
  _dispatchFailure(task, device, reason) {
    if (task.status !== TASK_STATUS.ASSIGNED && task.status !== TASK_STATUS.RUNNING && task.status !== TASK_STATUS.WAITING) return;
    const wasActive = task.status === TASK_STATUS.RUNNING || task.status === TASK_STATUS.WAITING;
    this._clearTaskTimers(task.id);
    this._removeTaskCommand(device, task.id);

    if (task.attempts < task.maxAttempts) {
      if (wasActive) this._adjustLoad(device.id, -1);
      const avoid = new Set(task._avoidDeviceIds || []);
      avoid.add(device.id);
      task._avoidDeviceIds = [...avoid];
      // 派发失败（ack 超时/设备掉线）说明任务根本没跑起来，此时不应继续死守原主机，
      // 交给下一轮路由按 avoid + 项目亲和重新挑一台；任务内容层面的失败才保留亲和。
      task.affinity = null;
      task.status = TASK_STATUS.QUEUED;
      task.assignedDeviceId = null;
      task.assignedDeviceName = null;
      task.updatedAt = protocol.nowIso();
      this._pushTaskEvent(
        task,
        'retry',
        `${reason}，重新调度（${task.attempts}/${task.maxAttempts}）`,
      );
      this.broadcast('task.updated', { task: this.taskToJson(task) });
      this.log('warn', `任务重派：${task.id}（${reason}）`);
      this.routeTask(task);
      this.schedulePersist();
      return;
    }

    this._finishTask(task, TASK_STATUS.FAILED, {
      error: `dispatch failed: ${reason}`,
      eventMessage: `${reason}，已达最大尝试次数`,
    });
  }

  handleDeviceLost(device, reason) {
    const affected = [...this.tasks.values()].filter(
      (task) => task.assignedDeviceId === device.id && ACTIVE_TASK_STATUSES.has(task.status),
    );
    for (const task of affected) this._dispatchFailure(task, device, reason);
  }

  /**
   * 设备上报“卡死/超时”类失败（stalled、无进度、本机 CLI 硬上限）时自动重排一次。
   * 这类失败不是任务内容错误，而是执行环境卡住；直接 failed 会让人等满 15 分钟后再手动重试。
   * 保留 task.affinity（同项目上下文仍在原主机），与派发失败清 affinity 的语义不同。
   */
  _retryStalledTask(task, device, reason) {
    if (![TASK_STATUS.ASSIGNED, TASK_STATUS.RUNNING, TASK_STATUS.WAITING].includes(task.status)) return false;
    this._clearTaskTimers(task.id);
    if (device) {
      this._removeTaskCommand(device, task.id);
      this._adjustLoad(device.id, -1);
    }
    task.status = TASK_STATUS.QUEUED;
    task.assignedDeviceId = null;
    task.assignedDeviceName = null;
    task.startedAt = null;
    task.finishedAt = null;
    task.output = null;
    task.error = null;
    task.progress = null;
    task.updatedAt = protocol.nowIso();
    task.route = { reason: '执行卡死，自动重试', candidates: [], excluded: [] };
    this._pushTaskEvent(
      task,
      'retry',
      `执行卡死（${util.str(reason, 120)}），自动重试（${task.attempts}/${task.maxAttempts}）`,
    );
    this.broadcast('task.updated', { task: this.taskToJson(task) });
    this.log('warn', `任务执行卡死自动重试：${task.id}（${task.attempts}/${task.maxAttempts}）：${util.str(reason, 160)}`);
    this.schedulePersist();
    this.routeTask(task);
    return true;
  }

  _timeoutTask(task) {
    if (!ACTIVE_TASK_STATUSES.has(task.status)) return;
    const device = task.assignedDeviceId ? this.devices.get(task.assignedDeviceId) : null;
    if (device) this._removeTaskCommand(device, task.id);

    // 运行超时先自动重试：如果设备还在但任务卡住了（或旧数据超时过短），
    // 在 maxAttempts 预算内重新排队，不需要人工点「重试」。终态仍保留 timeout 供排查。
    const canAutoRetry =
      this.autoRetryOnTimeout && task.autoRetry !== false && task.attempts < task.maxAttempts;
    if (canAutoRetry) {
      const wasActive = task.status === TASK_STATUS.RUNNING || task.status === TASK_STATUS.WAITING;
      if (wasActive) this._adjustLoad(device ? device.id : null, -1);
      if (device) this.enqueueCommand(device, this._buildCancelCommand(task, 'timeout'));
      this._clearTaskTimers(task.id);
      task.status = TASK_STATUS.QUEUED;
      task.assignedDeviceId = null;
      task.assignedDeviceName = null;
      task.startedAt = null;
      task.finishedAt = null;
      task.output = null;
      task.error = null;
      task.progress = null;
      task.updatedAt = protocol.nowIso();
      task.route = { reason: '任务超时，自动重试', candidates: [], excluded: [] };
      this._pushTaskEvent(
        task,
        'retry',
        `运行超时（${task.timeoutSec}s），自动重试（${task.attempts}/${task.maxAttempts}）`,
      );
      this.broadcast('task.updated', { task: this.taskToJson(task) });
      this.log('warn', `任务超时自动重试：${task.id}（${task.attempts}/${task.maxAttempts}）`);
      this.schedulePersist();
      this.routeTask(task);
      return;
    }

    this._finishTask(task, TASK_STATUS.TIMEOUT, {
      output: null,
      error: `任务执行超时（${task.timeoutSec}s）`,
      eventMessage: `${task.timeoutSec}s 内未完成`,
    });
    if (device) this.enqueueCommand(device, this._buildCancelCommand(task, 'timeout'));
  }

  _finishTask(task, status, { output, error, eventMessage } = {}) {
    const wasActive = task.status === TASK_STATUS.RUNNING || task.status === TASK_STATUS.WAITING;
    this._clearTaskTimers(task.id);
    task._dispatch = null;
    task._ackWaits = 0;
    task._ackWaitMs = 0;
    task.status = status;
    task.finishedAt = protocol.nowIso();
    task.updatedAt = task.finishedAt;
    if (output !== undefined) task.output = output;
    if (error !== undefined) task.error = error;
    if (wasActive) this._adjustLoad(task.assignedDeviceId, -1);
    if (status === TASK_STATUS.COMPLETED) {
      task.progress = { message: '任务完成', percent: 100, logs: [], at: task.finishedAt };
      // 项目亲和：记住该项目最近一次成功执行的设备（母机/对应主机），下次同项目任务优先回去。
      const project = this._taskProject(task);
      if (project && task.assignedDeviceId) {
        this.projectAffinity.delete(project);
        this.projectAffinity.set(project, task.assignedDeviceId);
        // 防止长期运行无限增长：只保留最近 200 个项目。
        while (this.projectAffinity.size > 200) {
          const oldest = this.projectAffinity.keys().next().value;
          if (!oldest || oldest === project) break;
          this.projectAffinity.delete(oldest);
        }
      }
    }
    // 咨询任务结束（无论成败）都把结果记进大脑的「咨询记录」。
    if (task.consult) this._recordBrainConsultation(task, status);
    this._pushTaskEvent(task, status, eventMessage || TASK_MESSAGES[status] || status);
    const eventName =
      status === TASK_STATUS.COMPLETED
        ? 'task.completed'
        : status === TASK_STATUS.CANCELLED
          ? 'task.updated'
          : 'task.failed';
    this.broadcast(eventName, { task: this.taskToJson(task) });
    this.log(
      status === TASK_STATUS.COMPLETED ? 'info' : 'warn',
      `${TASK_MESSAGES[status] || `状态 ${status}`}：${task.id}`,
    );
    this._updateParentTask(task);
    // 长期目标的跟进任务结束后，把结果回写到目标（进度/建议/下次跟进）。
    this._goalTaskFinished(task);
    // 管家心路：任务终态记一条工作日志（完成/失败/超时/取消）。
    this._journalTaskFinish(task);
    // 每日总结任务结束后，记录结论供前端展示。
    if (task.context && task.context.nightlyReview) this._nightlyReviewFinished(task);
    this.schedulePersist();
    // 任务结束腾出了设备槽位：立刻消化排队任务，否则因并发已满而重排队的任务可能一直滞留。
    if (wasActive) this.retryQueuedTasks('device slot free');
    return task;
  }

  handleAck(device, taskId) {
    const task = this._requireTask(taskId);
    if (task.assignedDeviceId !== device.id) throw conflict('任务未分配给该设备');
    if (task.status === TASK_STATUS.ASSIGNED) {
      this._clearTaskTimers(task.id);
      task.status = TASK_STATUS.RUNNING;
      task.startedAt = task.startedAt || protocol.nowIso();
      task.updatedAt = protocol.nowIso();
      task._ackWaits = 0;
      task._ackWaitMs = 0;
      this._adjustLoad(device.id, 1);
      this._refreshTaskTimeout(task);
      this._pushTaskEvent(task, 'ack', '设备已确认任务');
      this.broadcast('task.updated', { task: this.taskToJson(task) });
      this.schedulePersist();
    } else if (task.status === TASK_STATUS.RUNNING) {
      // 幂等：重复 ack 直接返回
    } else if (TERMINAL_TASK_STATUSES.has(task.status)) {
      // 幂等：设备迟到的 ack 不改变终态
    } else {
      throw conflict(`任务状态 ${task.status} 不可确认`);
    }
    return task;
  }

  answerTask(task, text) {
    if (!task) throw notFound('任务不存在');
    if (task.status !== TASK_STATUS.WAITING) throw conflict('任务当前不在等待回答');
    const value = util.str(text, 4000);
    if (!value) throw badRequest('回答内容不能为空');
    const device = this.devices.get(task.assignedDeviceId);
    if (!device) throw conflict('任务执行设备已不存在');
    if (!device.online) throw conflict('设备当前离线，无法发送回答');
    this.enqueueCommand(device, {
      id: protocol.randomId('cmd'),
      type: 'answer_task',
      taskId: task.id,
      createdAt: protocol.nowIso(),
      payload: { taskId: task.id, text: value },
    });
    task.updatedAt = protocol.nowIso();
    this._pushTaskEvent(task, 'progress', '回答已发送，等待设备继续执行');
    this.broadcast('task.updated', { task: this.taskToJson(task) });
    // 父计划进度里的「等待回答」状态同步刷新。
    if (task.parentTaskId) this._updateParentTask(task);
    this.schedulePersist();
    return task;
  }

  attachExternalResult(task, input = {}) {
    if (!task) throw notFound('任务不存在');
    const text = util.str(input.text, 200000);
    if (!text) throw badRequest('外部结果不能为空');
    const failed = input.status === 'failed';
    this._finishTask(task, failed ? TASK_STATUS.FAILED : TASK_STATUS.COMPLETED, {
      output: {
        text,
        data: util.isPlainObject(input.data) ? input.data : undefined,
      },
      error: failed ? util.str(input.error, 4000) || '外部任务失败' : null,
      eventMessage: '已同步 Mika 最终结果',
    });
    return task;
  }

  handleProgress(device, taskId, body) {
    const task = this._requireTask(taskId);
    if (task.assignedDeviceId !== device.id) throw conflict('任务未分配给该设备');
    if (!ACTIVE_TASK_STATUSES.has(task.status)) throw conflict(`任务状态 ${task.status} 不接受进度`);
    const input = util.isPlainObject(body) ? body : {};
    if (input.keepalive === true) {
      // 设备仍在执行：只续期超时计时器，不写进度/事件，避免刷屏和频繁持久化。
      task.updatedAt = protocol.nowIso();
      this._refreshTaskTimeout(task);
      return task;
    }
    const message = util.str(input.message, 500);
    const waiting = input.waiting === true;
    if (waiting) task.status = TASK_STATUS.WAITING;
    else if (task.status === TASK_STATUS.WAITING) task.status = TASK_STATUS.RUNNING;
    task.progress = {
      message,
      percent: Number.isFinite(input.percent) ? util.clampInt(input.percent, 0, 0, 100) : null,
      logs: util
        .arr(input.logs)
        .slice(-20)
        .map((line) => util.str(line, 300))
        .filter(Boolean),
      waiting,
      question: waiting ? util.str(input.question, 4000) : '',
      mikaTaskId: util.str(input.mikaTaskId, 120),
      at: protocol.nowIso(),
    };
    task.updatedAt = task.progress.at;
    this._pushTaskEvent(task, 'progress', message || (waiting ? '等待回答' : `进度 ${task.progress.percent == null ? '' : `${task.progress.percent}%`}`.trim()));
    this.broadcast('task.updated', { task: this.taskToJson(task) });
    // 子任务进入/退出等待回答时，刷新父计划进度（等待回答 / 卡点）。
    if (task.parentTaskId) this._updateParentTask(task);
    this.schedulePersist();
    return task;
  }

  handleResult(device, taskId, body) {
    const task = this._requireTask(taskId);
    // 结果收敛：同一任务只接受一次终态结果。旧 attempt / 重复上报返回 200 + ignored，
    // 而不是 409 —— 设备端把 409 当作“无需处理”，Hub 却可能继续重派，形成死循环。
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      this.log('info', `忽略迟到结果：${task.id}（任务已 ${task.status}）`);
      return { task, ignored: true, reason: `任务已 ${task.status}` };
    }
    if (task.assignedDeviceId !== device.id) {
      this.log(
        'warn',
        `忽略旧尝试结果：${task.id}（来自 ${device.id}，当前 ${task.assignedDeviceId || '未分配'}）`,
      );
      return { task, ignored: true, reason: '旧尝试的结果，任务已被重新派发' };
    }
    const input = util.isPlainObject(body) ? body : {};
    // attempt 归因：自动重试会给同一台设备重新派发同一任务，旧 attempt 的超时/取消结果
    // 如果只按 taskId+deviceId 校验，会被误当成新 attempt 的结果（P0 复盘 task_yfllwarp）。
    if (Number.isFinite(input.attempt) && input.attempt !== task.attempts) {
      this.log(
        'warn',
        `忽略跨尝试结果：${task.id}（结果 attempt=${input.attempt}，当前 attempt=${task.attempts}）`,
      );
      return {
        task,
        ignored: true,
        reason: `旧尝试的结果（attempt ${input.attempt}/${task.attempts}）`,
      };
    }
    if (!ACTIVE_TASK_STATUSES.has(task.status)) {
      return { task, ignored: true, reason: `任务状态 ${task.status} 不接受结果` };
    }
    const ok = input.ok !== false;
    const output = normalizeOutput(input.output);
    if (ok) {
      this._finishTask(task, TASK_STATUS.COMPLETED, { output, error: null, eventMessage: '任务完成' });
    } else {
      const message = util.str(input.error, 1000) || '设备执行失败';
      const stalled = /stalled|无进度|执行超时|timeout|超时/i.test(message);
      const canRetry =
        stalled && this.autoRetryOnTimeout && task.autoRetry !== false && task.attempts < task.maxAttempts;
      if (canRetry && this._retryStalledTask(task, device, message)) {
        return { task, ignored: false, retried: true };
      }
      this._finishTask(task, TASK_STATUS.FAILED, {
        output,
        error: message,
        eventMessage: message,
      });
    }
    return { task, ignored: false };
  }

  cancelTask(task, internal = {}) {
    if (task.isPlan) {
      for (const childId of task.childTaskIds || []) {
        const child = this.tasks.get(childId);
        if (child && [TASK_STATUS.QUEUED, TASK_STATUS.ASSIGNED, TASK_STATUS.RUNNING, TASK_STATUS.WAITING].includes(child.status)) {
          try {
            this.cancelTask(child);
          } catch {
            /* 子任务可能已结束 */
          }
        }
      }
      this._finishTask(task, TASK_STATUS.CANCELLED, { error: null, eventMessage: '长任务已取消' });
      return task;
    }
    if (![TASK_STATUS.QUEUED, TASK_STATUS.ASSIGNED, TASK_STATUS.RUNNING, TASK_STATUS.WAITING].includes(task.status)) {
      throw conflict(`任务状态 ${task.status} 不可取消`);
    }
    // 拆分计划：取消某个子任务时，级联取消依赖它、尚未执行的后续子任务，避免计划卡在死依赖上。
    if (!internal.skipDependents && task.parentTaskId) {
      const siblings = (this.tasks.get(task.parentTaskId)?.childTaskIds || [])
        .map((id) => this.tasks.get(id))
        .filter(Boolean);
      for (const sibling of siblings) {
        if (sibling.status !== TASK_STATUS.QUEUED) continue;
        if (!Array.isArray(sibling.planDependsOnTaskIds) || !sibling.planDependsOnTaskIds.includes(task.id)) continue;
        try {
          this.cancelTask(sibling, { skipDependents: false });
        } catch {
          /* 依赖子任务可能已被其他路径取消 */
        }
      }
    }
    const device = task.assignedDeviceId ? this.devices.get(task.assignedDeviceId) : null;
    if (device) {
      this._removeTaskCommand(device, task.id);
      if (ACTIVE_TASK_STATUSES.has(task.status)) {
        this.enqueueCommand(device, this._buildCancelCommand(task, 'cancelled'));
      }
    }
    this._finishTask(task, TASK_STATUS.CANCELLED, { error: null, eventMessage: '任务已取消' });
    return task;
  }

  retryTask(task) {
    if (![TASK_STATUS.FAILED, TASK_STATUS.TIMEOUT, TASK_STATUS.CANCELLED].includes(task.status)) {
      throw conflict(`任务状态 ${task.status} 不可重试`);
    }
    this._clearTaskTimers(task.id);
    task.status = TASK_STATUS.QUEUED;
    task.attempts = 0;
    task.assignedDeviceId = null;
    task.assignedDeviceName = null;
    task.startedAt = null;
    task.finishedAt = null;
    task.output = null;
    task.error = null;
    task.progress = null;
    task.route = { reason: '等待重新路由', candidates: [], excluded: [] };
    task._avoidDeviceIds = [];
    // 重试旧规划子任务时同样兜底，否则 60/90/180s 的旧值会立刻再次超时。
    const planFloor = this._planSubtaskTimeoutFloor(task);
    if (planFloor) task.timeoutSec = Math.max(task.timeoutSec, planFloor);
    task.updatedAt = protocol.nowIso();
    this._pushTaskEvent(task, 'retried', '任务重新提交');
    this.broadcast('task.updated', { task: this.taskToJson(task) });
    this.log('info', `任务重试：${task.id}`);
    this.routeTask(task);
    // 重试成功后推进计划：原本因失败依赖而暂停的后续子任务重新进入路由。
    if (task.parentTaskId) this._updateParentTask(task);
    this.schedulePersist();
    return task;
  }

  /**
   * 整套系统自重启（Hub + 在线设备代理）。
   *
   * 流程：给在线设备下发 restart_agent → 广播 system.restarting →
   * 等待 restartDelayMs（覆盖设备心跳周期）后调用 restartHandler 重启 Hub 进程。
   * 设备在收到 restart_agent 后会自己拉起新进程；Hub 由 server.js 注入的 handler 重启。
   *
   * @param {string} [reason] 重启原因，仅用于日志/事件
   * @returns {{restarting:boolean, alreadyRequested:boolean, devices:number, delayMs:number}}
   */
  requestRestart(reason = 'manual') {
    if (this._restarting) {
      return { restarting: true, alreadyRequested: true, devices: 0, delayMs: this.restartDelayMs };
    }
    if (!this.restartHandler) {
      throw conflict('当前 Hub 未启用自重启（未配置 restartHandler）');
    }
    this._restarting = true;
    const at = protocol.nowIso();
    let devices = 0;
    for (const device of this.devices.values()) {
      if (!device.online) continue;
      devices += 1;
      this.enqueueCommand(device, {
        id: protocol.randomId('cmd'),
        type: 'restart_agent',
        createdAt: at,
        payload: { reason },
      });
    }
    this.broadcast('system.restarting', { reason, devices, delayMs: this.restartDelayMs, at });
    this.log('warn', `系统自重启（${reason}）：已通知 ${devices} 台在线设备，${this.restartDelayMs}ms 后重启 Hub`);
    this.schedulePersist();
    const timer = setTimeout(() => {
      Promise.resolve()
        .then(() => this.restartHandler(reason))
        .catch((err) => {
          this._restarting = false;
          this.log('error', `自重启失败：${err && err.message ? err.message : err}`);
        });
    }, this.restartDelayMs);
    if (timer.unref) timer.unref();
    return { restarting: true, alreadyRequested: false, devices, delayMs: this.restartDelayMs };
  }

  // ---------------------------------------------------------------- 持久化

  schedulePersist() {
    this.store.schedule();
  }

  async flushState() {
    await this.store.flush();
  }
}

async function createHub(options = {}) {
  const hub = new Hub(options);
  await hub.init();
  return hub;
}

async function startHub(options = {}) {
  const hub = await createHub(options);
  await hub.listen();
  return hub;
}

module.exports = {
  Hub,
  createHub,
  startHub,
  normalizeOutput,
  TERMINAL_TASK_STATUSES,
  ACTIVE_TASK_STATUSES,
};



