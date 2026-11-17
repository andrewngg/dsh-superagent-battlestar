'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BRAIN_MODES,
  BRAIN_ACTIONS,
  BRAIN_ASSESSMENT_KEYS,
  DEFAULT_BRAIN,
  MAX_DECISIONS,
  MAX_ACTIONS_PER_DECISION,
  MIN_AUTO_CONFIDENCE,
  MIN_INTERVAL_SEC,
  MAX_INTERVAL_SEC,
  MAX_IDLE_SEC,
  BrainError,
  normalizeBrainPatch,
  normalizeActions,
  normalizeAssessment,
  normalizeOwnerAsk,
  normalizeOwnerReply,
  MAX_OWNER_ASK_OPTIONS,
  MAX_OWNER_OPTION_LABEL,
  MAX_OWNER_OPTION_DETAIL,
  restoreBrain,
  computeNextThinkAt,
  effectiveIntervalSec,
  brainToJson,
  recordBrainDecision,
  buildBrainPrompt,
  parseBrainReply,
  brainModelConfig,
  brainConfigured,
  brainMaxCompletionTokens,
  createBrainThinker,
  DEFAULT_MAX_COMPLETION_TOKENS,
} = require('../lib/brain.js');

const MODEL_ENV_KEYS = [
  'BRAIN_API_KEY',
  'AGNES_API_KEY',
  'BUTLER_AGNES_API_KEY',
  'BRAIN_BASE_URL',
  'AGNES_BASE_URL',
  'BRAIN_MODEL',
  'AGNES_MODEL',
  'BRAIN_TIMEOUT_MS',
  'BRAIN_MAX_TOKENS',
  'DEEPSEEK_API_KEY',
  'BRAINSTORM_API_KEY',
  'BRAINSTORM_BASE_URL',
  'BRAINSTORM_MODEL',
];

/**
 * 在隔离的模型环境变量下执行：进入时清空相关变量，退出时原样恢复。
 * 测试机器上可能真的配置了 BRAIN_API_KEY，不能让单测依赖宿主机环境。
 */
async function withModelEnv(values, fn) {
  const saved = new Map();
  for (const key of MODEL_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    for (const [key, value] of Object.entries(values || {})) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('默认大脑状态与常量符合设计约定', () => {
  assert.deepEqual(BRAIN_MODES, ['auto', 'suggest']);
  assert.deepEqual(BRAIN_ACTIONS, [
    'retry_task',
    'resume_thread',
    'create_task',
    'link_task',
    'consult_worker',
    'remember',
    'none',
  ]);
  assert.equal(MIN_AUTO_CONFIDENCE, 0.6);
  assert.equal(MAX_DECISIONS, 30);
  assert.equal(MAX_ACTIONS_PER_DECISION, 3);
  assert.equal(MIN_INTERVAL_SEC, 60);
  assert.equal(MAX_INTERVAL_SEC, 3600);
  assert.equal(MAX_IDLE_SEC, 1800);
  assert.deepEqual(BRAIN_ASSESSMENT_KEYS, [
    'goals',
    'progress',
    'betterWay',
    'improvement',
    'myMove',
    'ownerAsk',
  ]);
  assert.deepEqual(
    { ...DEFAULT_BRAIN },
    {
      enabled: true,
      mode: 'auto',
      intervalSec: 180,
      maxActions: 2,
      model: null,
      adaptive: true,
      idleStreak: 0,
      effectiveIntervalSec: 180,
      nextThinkAt: null,
      skippedCycles: 0,
      consecutiveFailures: 0,
      lastThinkAt: null,
      lastError: null,
      lastSummary: '',
      lastAssessment: null,
      ownerAsk: null,
      ownerReply: null,
      consultations: [],
      notes: [],
      decisions: [],
    },
  );
  assert.equal(Object.isFrozen(DEFAULT_BRAIN), true);
});

test('normalizeBrainPatch：合法补丁归一化（整数化 / trim / 空模型）', () => {
  const ok = normalizeBrainPatch({
    enabled: false,
    mode: 'suggest',
    intervalSec: '90.9',
    maxActions: 3,
    model: '  agnes-2.5-flash  ',
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, {
    enabled: false,
    mode: 'suggest',
    intervalSec: 90,
    maxActions: 3,
    model: 'agnes-2.5-flash',
  });

  assert.deepEqual(normalizeBrainPatch({ model: null }).value, { model: null });
  assert.deepEqual(normalizeBrainPatch({ model: '   ' }).value, { model: null });
  // 未提供任何可识别字段：保持幂等空补丁。
  assert.deepEqual(normalizeBrainPatch({}).value, {});
  assert.deepEqual(normalizeBrainPatch(null).value, {});
});

test('normalizeBrainPatch：非法字段一次性汇总错误', () => {
  const bad = normalizeBrainPatch({
    enabled: 'yes',
    mode: 'fast',
    intervalSec: 10,
    maxActions: 9,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 4);
  assert.match(bad.errors[0], /enabled 必须是布尔值/);
  assert.match(bad.errors[1], /mode 必须是 auto \/ suggest/);
  assert.match(bad.errors[2], /思考间隔必须在 60~3600 秒之间/);
  assert.match(bad.errors[3], /每轮最多动作数必须在 1~3 之间/);

  assert.match(normalizeBrainPatch({ intervalSec: 4000 }).errors[0], /60~3600/);
  assert.match(normalizeBrainPatch({ intervalSec: 'abc' }).errors[0], /60~3600/);
  assert.match(normalizeBrainPatch({ maxActions: 0 }).errors[0], /1~3/);
  assert.match(normalizeBrainPatch({ maxActions: 4 }).errors[0], /1~3/);
});

test('normalizeActions：过滤非法动作、截断字段、置信度回退', () => {
  const actions = normalizeActions([
    { action: 'retry_task', taskId: 'task_1', confidence: 1.5, reason: '  失败重试  ' },
    { action: 'delete_all' },
    null,
    'retry_task',
    { action: 'none', confidence: 'high' },
    { action: 'link_task', goalId: 'goal_1', taskId: 'task_2', confidence: -1 },
    { action: 'create_task', instruction: 'x'.repeat(3000) },
    { action: 'resume_thread', taskId: 'task_3' },
  ]);
  assert.equal(actions.length, MAX_ACTIONS_PER_DECISION);
  assert.deepEqual(actions[0], {
    action: 'retry_task',
    taskId: 'task_1',
    goalId: null,
    instruction: '',
    reason: '失败重试',
    question: '',
    note: '',
    confidence: 1,
    timeoutSec: null,
    requirements: null,
  });
  assert.equal(actions[1].action, 'none');
  assert.equal(actions[1].confidence, 0.6); // 非数字回退默认 0.6
  assert.equal(actions[2].action, 'link_task');
  assert.equal(actions[2].confidence, 0); // 负数 clamp 到 0

  const truncated = normalizeActions([{ action: 'create_task', instruction: `  ${'a'.repeat(2500)}  ` }]);
  assert.equal(truncated[0].instruction.length, 2000);

  // create_task 可带超时与路由要求；非法值回退 null，不再发号施令。
  const planned = normalizeActions([
    {
      action: 'create_task',
      instruction: '整理自由职业工作区',
      timeoutSec: 900,
      requirements: { deviceId: 'dev_pzh31fkv', project: 'freelance' },
    },
    { action: 'create_task', instruction: 'x', timeoutSec: 'soon', requirements: 'nope' },
  ]);
  assert.equal(planned[0].timeoutSec, 900);
  assert.equal(planned[0].requirements.deviceId, 'dev_pzh31fkv');
  assert.equal(planned[0].requirements.project, 'freelance');
  assert.equal(planned[1].timeoutSec, null);
  assert.equal(planned[1].requirements, null);

  assert.deepEqual(normalizeActions('retry_task'), []);
  assert.deepEqual(normalizeActions(undefined), []);
});

test('restoreBrain：容错恢复默认结构（非法值回退 + 决策裁剪）', () => {
  const empty = restoreBrain(null);
  assert.deepEqual(empty, {
    enabled: true,
    mode: 'auto',
    intervalSec: 180,
    maxActions: 2,
    model: null,
    adaptive: true,
    idleStreak: 0,
    effectiveIntervalSec: 180,
    nextThinkAt: null,
    skippedCycles: 0,
    consecutiveFailures: 0,
    lastThinkAt: null,
    lastError: null,
    lastSummary: '',
    lastAssessment: null,
    ownerAsk: null,
    ownerReply: null,
    consultations: [],
    notes: [],
    decisions: [],
  });

  const restored = restoreBrain({
    enabled: 'yes',
    mode: 'turbo',
    intervalSec: 5,
    maxActions: 99,
    model: 42,
    lastThinkAt: '2026-11-16T00:00:00.000Z',
    lastError: ' 模型超时 ',
    lastSummary: '正在重试',
    thinking: true,
    decisions: [
      null,
      'brain_x',
      { id: 'brain_1', at: '2026-11-15T00:00:00.000Z', summary: '旧决策', actions: [] },
      { foo: 1 },
    ],
  });
  assert.equal(restored.enabled, true);
  assert.equal(restored.mode, 'auto');
  assert.equal(restored.intervalSec, MIN_INTERVAL_SEC);
  assert.equal(restored.maxActions, 3);
  assert.equal(restored.model, null); // 数字不是合法模型名
  assert.equal(restored.lastThinkAt, '2026-11-16T00:00:00.000Z');
  assert.equal(restored.lastError, '模型超时');
  assert.equal(restored.decisions.length, 1);
  assert.equal(restored.decisions[0].id, 'brain_1');
  assert.equal(restored.decisions[0].mode, 'auto');

  // 超过 30 条只保留最近 30 条，且不恢复 thinking 运行态。
  const many = Array.from({ length: 40 }, (_, index) => ({
    id: `brain_${index}`,
    at: '2026-11-16T00:00:00.000Z',
    summary: `决策 ${index}`,
  }));
  const capped = restoreBrain({ decisions: many });
  assert.equal(capped.decisions.length, MAX_DECISIONS);
  assert.equal(capped.decisions[0].id, 'brain_10');
  assert.equal(capped.decisions[29].id, 'brain_39');
  assert.equal('thinking' in capped, false);
});

test('computeNextThinkAt：禁用为 null、按 lastThinkAt+间隔、无记录立即到期、显式 nextThinkAt 优先', () => {
  const brain = {
    ...restoreBrain(null),
    lastThinkAt: '2026-01-01T00:00:00.000Z',
    intervalSec: 60,
    effectiveIntervalSec: 60,
  };
  assert.equal(computeNextThinkAt(brain), '2026-01-01T00:01:00.000Z');
  assert.equal(computeNextThinkAt(brain, { enabled: false }), null);
  assert.equal(
    computeNextThinkAt({ ...brain, enabled: false }),
    null,
  );

  // 自适应节律排好的显式 nextThinkAt 优先于 lastThinkAt+间隔。
  const scheduled = {
    ...brain,
    lastThinkAt: '2026-01-01T00:00:00.000Z',
    effectiveIntervalSec: 900,
    nextThinkAt: '2026-01-01T00:15:00.000Z',
  };
  assert.equal(computeNextThinkAt(scheduled), '2026-01-01T00:15:00.000Z');
  // 自适应时实际间隔取 effectiveIntervalSec。
  assert.equal(effectiveIntervalSec({ ...brain, effectiveIntervalSec: 720 }), 720);
  assert.equal(effectiveIntervalSec({ ...brain, adaptive: false, effectiveIntervalSec: 720 }), 60);
  assert.equal(effectiveIntervalSec({ ...brain, effectiveIntervalSec: 9000 }), MAX_IDLE_SEC);

  const fresh = { ...restoreBrain(null), lastThinkAt: null };
  const nowMs = Date.parse('2026-11-16T06:00:00.000Z');
  assert.equal(computeNextThinkAt(fresh, { nowMs }), '2026-11-16T06:00:00.000Z');
  // lastThinkAt 损坏时同样立即到期
  assert.equal(
    computeNextThinkAt({ ...fresh, lastThinkAt: 'not-a-date' }, { nowMs }),
    '2026-11-16T06:00:00.000Z',
  );
});

test('brainToJson：nextThinkAt / decisions 裁剪 / configured', async () => {
  await withModelEnv({}, () => {
    const brain = restoreBrain(null);
    const json0 = brainToJson(brain);
    assert.equal(json0.configured, false);
    // 未排期时 nextThinkAt 由 now 即时算出，两次调用可能差 1ms；只校验格式与合理窗口。
    assert.match(json0.nextThinkAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(Math.abs(Date.parse(json0.nextThinkAt) - Date.now()) <= 2000);

    for (let index = 0; index < 40; index += 1) {
      recordBrainDecision(brain, { id: `brain_${index}`, at: '2026-01-01T00:00:00.000Z', summary: `s${index}`, actions: [] });
    }
    assert.equal(brain.decisions.length, 30); // recordBrainDecision 自身也封顶
    const json = brainToJson(brain, { decisions: 5 });
    assert.equal(json.decisions.length, 5);
    assert.equal(json.decisions[4].id, 'brain_39');
    assert.equal(brainToJson(brain, { decisions: 1000 }).decisions.length, 30);
    assert.equal(brainToJson(brain).decisions.length, 10); // 默认最近 10 条
    // 注意：decisions=0/负数/NaN 时实现里 Math.trunc(...)||0 得到 0，
    // 而 slice(-0) 等价于 slice(0) 会返回全部决策（已知边界问题，已报告 Lead），
    // 因此这里不把 0 当成契约行为断言。
    // decisions 是深拷贝，外部修改不影响内部状态
    json.decisions[4].summary = 'hacked';
    assert.equal(brain.decisions[29].summary, 's39');
  });
});

test('recordBrainDecision：写入并裁剪到 30 条上限', () => {
  const brain = restoreBrain(null);
  for (let index = 0; index < 35; index += 1) {
    recordBrainDecision(brain, { id: `brain_${index}`, summary: `决策 ${index}` });
  }
  assert.equal(brain.decisions.length, MAX_DECISIONS);
  assert.equal(brain.decisions[0].id, 'brain_5');
  assert.equal(brain.decisions[29].id, 'brain_34');

  assert.equal(recordBrainDecision(null, { id: 'x' }), null);
  assert.equal(recordBrainDecision({}, { id: 'x' }), null);
  assert.equal(recordBrainDecision(brain, null), null);
});

test('parseBrainReply：纯 JSON、```json 围栏、前后解释文字', () => {
  const plain = parseBrainReply('{"summary":"重试失败任务","actions":[]}');
  assert.equal(plain.summary, '重试失败任务');
  assert.deepEqual(plain.actions, []);

  const fenced = parseBrainReply(
    '好的，以下是决策：\n```json\n{"summary":"关联任务","actions":[{"action":"link_task","goalId":"goal_1","taskId":"task_1","confidence":0.9}]}\n```',
  );
  assert.equal(fenced.summary, '关联任务');
  assert.equal(fenced.actions.length, 1);
  assert.equal(fenced.actions[0].action, 'link_task');
  assert.equal(fenced.actions[0].goalId, 'goal_1');

  const explained = parseBrainReply(
    '我认为应该重试：{"summary":"重试","actions":[{"action":"retry_task","taskId":"task_9","reason":"次数还有","confidence":"0.8"}]} 完毕。',
  );
  assert.equal(explained.summary, '重试');
  assert.equal(explained.actions[0].confidence, 0.8);
});

test('parseBrainReply：空/非法 JSON 抛 BrainError，空动作可接受', () => {
  assert.throws(() => parseBrainReply(''), BrainError);
  assert.throws(() => parseBrainReply('   '), /大脑返回为空/);
  assert.throws(() => parseBrainReply('模型正在思考，暂时没有结论'), /大脑返回不是合法 JSON/);
  assert.throws(() => parseBrainReply('{bad json'), /大脑返回不是合法 JSON/);
  assert.throws(() => parseBrainReply('"just a string"'), /大脑返回不是合法 JSON/);
  assert.throws(() => parseBrainReply('{"summary":"","actions":[]}'), /大脑没有给出任何结论或动作/);

  // 契约：有 summary 时 actions 为空数组可接受（只观察不动作）。
  assert.deepEqual(parseBrainReply('{"summary":"一切正常","actions":[]}'), {
    summary: '一切正常',
    actions: [],
    assessment: null,
    ownerAsk: null,
  });
  // summary 缺失但动作合法时也可接受。
  const onlyActions = parseBrainReply('{"actions":[{"action":"none"}]}');
  assert.equal(onlyActions.summary, '');
  assert.equal(onlyActions.actions.length, 1);

  try {
    parseBrainReply('nope');
  } catch (err) {
    assert.equal(err.statusCode, 502);
  }
});

test('parseBrainReply：尾随逗号、未闭合围栏、截断修复与带输出开头的错误', () => {
  assert.equal(parseBrainReply('{"summary":"尾逗号","actions":[],}').summary, '尾逗号');
  assert.equal(parseBrainReply('```json\n{"summary":"未闭合围栏","actions":[]}').summary, '未闭合围栏');

  // 字符串里的花括号不能影响配平截取；后面的无关片段也不能被并进来。
  const bracesInString = parseBrainReply('先看：{"summary":"含 { 和 } 的摘要","actions":[]} 后面别管{"x":1}');
  assert.equal(bracesInString.summary, '含 { 和 } 的摘要');

  // 输出上限截断：最后一个字段没写完，丢弃它并补全剩余括号。
  const truncated = parseBrainReply('{"summary":"截断修复","actions":[{"action":"none","reason":"写到一半被截');
  assert.equal(truncated.summary, '截断修复');
  assert.equal(truncated.actions.length, 1);
  assert.equal(truncated.actions[0].action, 'none');

  // 完全无法修复时，错误里带模型输出开头，方便在控制台看出是截断还是跑题。
  assert.throws(
    () => parseBrainReply('这里根本没有 JSON 对象'),
    (err) => {
      assert.equal(err.statusCode, 502);
      assert.match(err.message, /大脑返回不是合法 JSON（开头：这里根本没有 JSON 对象）/);
      return true;
    },
  );
});

test('brainMaxCompletionTokens：默认 4000、可配且 clamp 到 1000–8000', () => {
  assert.equal(brainMaxCompletionTokens(undefined), DEFAULT_MAX_COMPLETION_TOKENS);
  assert.equal(brainMaxCompletionTokens('2500'), 2500);
  assert.equal(brainMaxCompletionTokens('abc'), DEFAULT_MAX_COMPLETION_TOKENS);
  assert.equal(brainMaxCompletionTokens(500), 1000);
  assert.equal(brainMaxCompletionTokens(99999), 8000);
});

test('buildBrainPrompt：包含目标/指导/失败任务/设备与既有约定文案', () => {
  const snapshot = {
    now: '2026-11-16T06:00:00.000Z',
    stats: {
      devicesOnline: 1,
      devicesTotal: 2,
      tasksQueued: 1,
      tasksRunning: 0,
      tasksWaiting: 1,
      tasksCompleted: 3,
      tasksFailed: 1,
    },
    goals: [
      {
        id: 'goal_1',
        title: '求职',
        nickname: '求职目标',
        status: 'active',
        schedule: { type: 'interval', minutes: 180 },
        nextCheckAt: '2026-11-16T09:00:00.000Z',
        lastCheckStatus: 'failed',
        lastSummary: '投递卡住',
        guidance: [
          { text: '优先投广州的岗位', createdAt: '2026-11-15T00:00:00.000Z' },
          '旧的纯字符串指导',
        ],
        taskIds: ['task_9'],
        runningTaskId: 'task_9',
        pendingApproval: null,
        linkedStats: { total: 2, completed: 1, running: 1, waiting: 0, failed: 0, planTotal: 3, planCompleted: 1 },
      },
    ],
    tasks: [
      {
        id: 'task_9',
        status: 'failed',
        instruction: '投递简历',
        goalId: 'goal_1',
        attempts: 1,
        maxAttempts: 2,
        error: '网络错误',
        progress: { message: '第 3 步失败', percent: 60, waiting: false },
        lastEvent: { at: '2026-11-16T05:00:00.000Z', type: 'failed', message: '任务失败' },
        childTaskIds: [],
      },
    ],
    approvals: [],
    devices: [
      { id: 'dev_1', name: '主机', kind: 'windows', online: true, tags: ['gpu'], load: { running: 1, max: 2 } },
    ],
  };

  const prompt = buildBrainPrompt(snapshot);
  assert.equal(typeof prompt.system, 'string');
  assert.equal(typeof prompt.user, 'string');
  assert.match(prompt.system, /BattleStar（对战星）的自主管家大脑/);
  assert.match(prompt.system, /retry_task\|resume_thread\|create_task\|link_task\|consult_worker\|remember\|none/);
  assert.match(prompt.system, /同一轮最多 2 个动作/);
  assert.match(prompt.system, /置信度低于 0.6/);

  const user = prompt.user;
  assert.match(user, /当前时间：2026-11-16T06:00:00\.000Z/);
  assert.match(user, /Hub 概览：设备 1\/2 在线/);
  assert.match(user, /## 长期目标（1 个）/);
  assert.match(user, /求职目标（goal_1）/);
  assert.match(user, /每 180 分钟/);
  assert.match(user, /关联任务 2（完成 1，进行中 1，失败 0，计划 1\/3）/);
  assert.match(user, /上次跟进：failed｜投递卡住/);
  assert.match(user, /正在执行的任务：task_9/);
  // {text,createdAt} 结构与旧纯字符串指导都要能渲染
  assert.match(user, /用户指导（2026-11-15T00:00:00\.000Z）：优先投广州的岗位/);
  assert.match(user, /用户指导：旧的纯字符串指导/);
  assert.match(user, /## 任务（1 条：进行中 \/ 排队 \/ 失败 \/ 等待回答 \+ 最近完成）/);
  assert.match(user, /task_9｜failed｜投递简历/);
  assert.match(user, /｜目标 goal_1/);
  assert.match(user, /｜尝试 1\/2/);
  assert.match(user, /错误：网络错误/);
  assert.match(user, /最近事件：任务失败/);
  assert.match(user, /## 设备（1 台）/);
  assert.match(user, /主机｜windows｜在线｜负载 1\/2｜标签 gpu/);

  // 空快照不崩溃，并给出空态占位。
  const empty = buildBrainPrompt({});
  assert.match(empty.user, /## 长期目标（0 个）/);
  assert.match(empty.user, /## 任务（0 条/);
  assert.match(empty.user, /## 设备（0 台）/);
  const blank = buildBrainPrompt();
  assert.equal(typeof blank.user, 'string');
});

test('buildBrainPrompt：路径核查、项目/设备上下文与历史提问，明确禁止拿文件路径问主人', () => {
  const snapshot = {
    now: '2026-11-17T04:00:00.000Z',
    tasks: [
      {
        id: 'task_a',
        status: 'failed',
        instruction: '给 applier.py 加 --auto-submit，用 resume.pdf 投递',
        project: 'job_search',
        assignedDeviceId: 'dev_mother',
        assignedDeviceName: '母机',
        attempts: 2,
        maxAttempts: 2,
        error: '找不到 C:\\Users\\Hub\\Desktop\\jobstreet_candidates.json',
        progress: null,
        lastEvent: null,
      },
    ],
    decisions: [
      {
        at: '2026-11-17T03:36:00.000Z',
        summary: '路径缺失，需要主人处理',
        ownerAsk: 'applier.py 的具体路径在哪里？',
        actions: [],
      },
    ],
    pathAudit: [
      { ref: 'resume.pdf', status: 'candidates', paths: ['C:\\repo\\worker-workspace\\job_search\\resume.pdf'] },
      { ref: 'C:\\Users\\Hub\\Desktop\\jobstreet_candidates.json', status: 'missing', paths: [] },
    ],
    host: { user: 'tester', platform: 'win32' },
  };
  const prompt = buildBrainPrompt(snapshot);
  // 系统提示：ownerAsk 只用于决策/授权/偏好，文件路径等机器可查事实禁止问主人。
  assert.match(prompt.system, /ownerAsk 禁止询问机器可查的事实/);
  assert.match(prompt.system, /文件\/目录\/脚本\/简历的路径/);
  assert.match(prompt.system, /有候选路径就把候选路径写进自包含的 create_task/);
  assert.match(prompt.system, /同一问题若已在「最近决策」/);
  // 任务行补上项目与设备 id，便于判断上下文在哪台设备。
  assert.match(prompt.user, /task_a｜failed｜.*applier\.py.*｜项目 job_search｜设备 母机｜设备id dev_mother/);
  // 路径核查段：Hub 主机实测存在性、候选文件与设备侧提醒。
  assert.match(prompt.user, /## 路径核查（在 tester@win32 上实测；其它设备上的路径可能不同）/);
  assert.match(
    prompt.user,
    /resume\.pdf → Hub 主机上该路径不存在，但找到同名文件：C:\\repo\\worker-workspace\\job_search\\resume\.pdf/,
  );
  assert.match(prompt.user, /jobstreet_candidates\.json → Hub 主机上不存在（可能属于其它设备）/);
  assert.match(prompt.user, /设备侧文件请用 create_task 让对应设备自查，不要据此向主人提问/);
  // 历史提问进入决策记忆，提示不要重复问。
  assert.match(prompt.user, /当轮提问：applier\.py 的具体路径在哪里？（已问过，除非有全新信息不要重复问）/);
});

test('咨询 worker 与管家记忆：动作字段、持久化恢复与提示词三段', () => {
  // normalizeActions：consult_worker 用 question、remember 用 note；保留 requirements 硬锁。
  const actions = normalizeActions([
    {
      action: 'consult_worker',
      question: '  列出 job_search 的绝对目录  ',
      requirements: { deviceId: 'dev_1', project: 'job_search' },
      confidence: 0.9,
    },
    { action: 'remember', note: 'job_search 的 applier.py 固定在 scripts/applier.py' },
  ]);
  assert.equal(actions[0].question, '列出 job_search 的绝对目录');
  assert.equal(actions[0].requirements.deviceId, 'dev_1');
  assert.equal(actions[0].requirements.project, 'job_search');
  assert.equal(actions[1].note, 'job_search 的 applier.py 固定在 scripts/applier.py');

  // 持久化：恢复时丢弃非法条目、裁剪上限，brainToJson 同步带出。
  const brain = restoreBrain({
    consultations: [
      { question: 'Q1', answer: 'A1', deviceId: 'dev_1', ok: true },
      null,
      { foo: 1 },
      { question: 'Q2', answer: 'A2', ok: false },
    ],
    notes: [{ text: '记忆一' }, { text: '' }, null, { text: '记忆二' }],
  });
  assert.equal(brain.consultations.length, 2);
  assert.equal(brain.consultations[0].question, 'Q1');
  assert.equal(brain.consultations[0].ok, true);
  assert.equal(brain.consultations[1].ok, false);
  assert.deepEqual(brain.notes.map((item) => item.text), ['记忆一', '记忆二']);
  const json = brainToJson(brain);
  assert.equal(json.consultations.length, 2);
  assert.equal(json.notes.length, 2);

  // 提示词：系统规则 + 项目↔主机、咨询记录（含失败标记）、管家记忆三段。
  const prompt = buildBrainPrompt({
    now: '2026-11-17T05:00:00.000Z',
    tasks: [],
    devices: [],
    decisions: [],
    projectHosts: [
      { project: 'job_search', deviceId: 'dev_1', deviceName: '求职工作机', source: 'affinity' },
    ],
    consultations: [
      {
        at: '2026-11-17T04:00:00.000Z',
        deviceId: 'dev_1',
        deviceName: '求职工作机',
        project: 'job_search',
        question: 'applier.py 的绝对路径？',
        answer: '在 C:\\work\\job_search\\scripts\\applier.py',
        ok: true,
      },
      {
        at: '2026-11-17T04:10:00.000Z',
        deviceId: 'dev_2',
        deviceName: '备用机',
        project: 'job_search',
        question: '环境版本？',
        answer: '没有返回',
        ok: false,
      },
    ],
    notes: [
      { at: '2026-11-17T04:20:00.000Z', text: 'job_search 的 applier.py 固定在 scripts/applier.py' },
    ],
  });
  assert.match(prompt.system, /consult_worker 向指定设备提一个只读问题/);
  assert.match(prompt.system, /remember 把长期有用的上下文写入「管家记忆」/);
  assert.match(prompt.system, /缺少只有某台设备知道的事实/);
  const user = prompt.user;
  assert.match(user, /## 项目 ↔ 主机（1 个；缺少项目上下文时优先向这里的设备 consult_worker）/);
  assert.match(user, /1\. job_search → 求职工作机（dev_1）/);
  assert.match(user, /## 咨询记录（worker 已回答；同一问题不要重复咨询）/);
  assert.match(user, /1\. 问 求职工作机：applier\.py 的绝对路径？/);
  assert.match(user, /回答：在 C:\\work\\job_search\\scripts\\applier\.py/);
  assert.match(user, /2\. 问 备用机：环境版本？（未成功）/);
  assert.match(user, /## 管家记忆（长期上下文，按需使用，不要重复记录）/);
  assert.match(user, /1\. job_search 的 applier\.py 固定在 scripts\/applier\.py/);
});

test('brainModelConfig：默认值与环境变量优先级/覆盖', async () => {
  await withModelEnv({}, () => {
    const config = brainModelConfig();
    assert.deepEqual(config, {
      apiKey: '',
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      model: 'agnes-2.5-flash',
      timeoutMs: 60000,
    });
    assert.equal(brainConfigured(), false);
  });

  await withModelEnv(
    {
      AGNES_API_KEY: ' agnes-key ',
      AGNES_MODEL: 'agnes-env-model',
      AGNES_BASE_URL: 'https://env.example/v1///',
    },
    () => {
      const envConfig = brainModelConfig();
      assert.equal(envConfig.apiKey, 'agnes-key');
      assert.equal(envConfig.model, 'agnes-env-model');
      assert.equal(envConfig.baseUrl, 'https://env.example/v1'); // 去掉尾部斜杠
      assert.equal(envConfig.timeoutMs, 60000); // 未显式覆盖时的默认超时
      assert.equal(brainConfigured(), true);
    },
  );

  // BRAIN_* 优先于 AGNES_*；显式覆盖优先于环境变量。
  await withModelEnv(
    {
      BRAIN_API_KEY: 'brain-key',
      AGNES_API_KEY: 'agnes-key',
      BRAIN_BASE_URL: 'https://brain.example/v1',
      BRAIN_MODEL: 'brain-model',
    },
    () => {
      const envConfig = brainModelConfig();
      assert.equal(envConfig.apiKey, 'brain-key');
      assert.equal(envConfig.model, 'brain-model');
      assert.equal(envConfig.baseUrl, 'https://brain.example/v1');

      const overridden = brainModelConfig({
        model: 'override-model',
        baseUrl: 'https://override.example/v1/',
        timeoutMs: 999999,
      });
      assert.equal(overridden.model, 'override-model');
      assert.equal(overridden.baseUrl, 'https://override.example/v1');
      assert.equal(overridden.timeoutMs, 300000); // 高于上限 clamp 到 300000
      assert.equal(brainModelConfig({ timeoutMs: 1000 }).timeoutMs, 5000); // 低于下限 clamp
      // 已知边界问题（已报告 Lead）：BRAIN_TIMEOUT_MS 来自环境变量是字符串，
      // clampInt 只接受 number，因此环境变量覆盖当前不生效（落回 60000）。
    },
  );

  // BUTLER_AGNES_API_KEY 作为最后兜底。
  await withModelEnv({ BUTLER_AGNES_API_KEY: 'butler-key' }, () => {
    assert.equal(brainModelConfig().apiKey, 'butler-key');
  });
});

test('createBrainThinker：未配置 key 抛错，配置后按约定 POST chat/completions', async () => {
  await withModelEnv({}, async () => {
    const thinker = createBrainThinker();
    await assert.rejects(() => thinker({ system: 's', user: 'u' }), /未配置自主大脑模型（BRAIN_API_KEY \/ AGNES_API_KEY \/ DEEPSEEK_API_KEY）/);
  });

  await withModelEnv({ BRAIN_API_KEY: 'test-key', BRAIN_MODEL: 'unit-model' }, async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: '{"summary":"ok","actions":[]}' } }] }),
      };
    };
    const thinker = createBrainThinker({ fetchImpl });
    const reply = await thinker({ system: '系统提示', user: '用户输入' });
    assert.equal(reply, '{"summary":"ok","actions":[]}');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://apihub.agnes-ai.com/v1/chat/completions');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer test-key');
    assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.model, 'unit-model');
    assert.deepEqual(body.messages, [
      { role: 'system', content: '系统提示' },
      { role: 'user', content: '用户输入' },
    ]);
    assert.equal(body.temperature, 0.2);
    assert.equal(body.max_tokens, DEFAULT_MAX_COMPLETION_TOKENS);
    assert.equal(body.stream, false);
    assert.equal(body.response_format, undefined); // Agnes（默认网关）不接受 JSON 模式

    // HTTP 非 2xx -> BrainError（含状态码与截断响应体）
    const failing = createBrainThinker({
      fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'service unavailable' }),
    });
    await assert.rejects(() => failing({ system: 's', user: 'u' }), /大脑模型调用失败（HTTP 503）：service unavailable/);

    // 响应体不是 JSON -> BrainError
    const badBody = createBrainThinker({
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'not-json' }),
    });
    await assert.rejects(() => badBody({ system: 's', user: 'u' }), /大脑模型返回不是合法 JSON（响应体）/);

    // 缺少 content -> BrainError
    const emptyContent = createBrainThinker({
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [] }) }),
    });
    await assert.rejects(() => emptyContent({ system: 's', user: 'u' }), /大脑模型没有返回内容/);
  });
});

test('createBrainThinker：输出上限可配、DeepSeek JSON 模式与降级、数组 content 与 reasoning_content 回退', async () => {
  // BRAIN_MAX_TOKENS 覆盖默认输出上限。
  await withModelEnv({ BRAIN_API_KEY: 'test-key', BRAIN_MAX_TOKENS: '2500' }, async () => {
    const calls = [];
    const thinker = createBrainThinker({
      fetchImpl: async (url, options) => {
        calls.push(JSON.parse(options.body));
        return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '{"summary":"ok","actions":[]}' } }] }) };
      },
    });
    await thinker({ system: 's', user: 'u' });
    assert.equal(calls[0].max_tokens, 2500);
  });

  // DeepSeek 网关默认带 response_format:json_object；不支持时（HTTP 400）自动去掉重试。
  await withModelEnv({ DEEPSEEK_API_KEY: 'ds-key', BRAIN_MAX_TOKENS: 'bad' }, async () => {
    const calls = [];
    const thinker = createBrainThinker({
      fetchImpl: async (url, options) => {
        calls.push(JSON.parse(options.body));
        if (calls.length === 1) {
          return { ok: false, status: 400, text: async () => '{"error":{"message":"response_format is not supported"}}' };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '{"summary":"ds ok","actions":[]}' } }] }) };
      },
    });
    const reply = await thinker({ system: 's', user: 'u' });
    assert.equal(JSON.parse(reply).summary, 'ds ok');
    assert.deepEqual(calls[0].response_format, { type: 'json_object' });
    assert.equal(calls[0].max_tokens, DEFAULT_MAX_COMPLETION_TOKENS); // 非法 env 回落默认
    assert.equal(calls[1].response_format, undefined);
  });

  await withModelEnv({ BRAIN_API_KEY: 'test-key' }, async () => {
    // content 为 [{type:'text',text}] 片段数组时拼接。
    const arrayThinker = createBrainThinker({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: '{"summary":"数组"' }, { type: 'text', text: ',"actions":[]}' }] } }] }),
      }),
    });
    assert.equal(JSON.parse(await arrayThinker({ system: 's', user: 'u' })).summary, '数组');

    // content 为空时回退到 reasoning_content（推理模型常见）。
    const reasoningThinker = createBrainThinker({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: '', reasoning_content: '{"summary":"推理","actions":[]}' } }] }),
      }),
    });
    assert.equal(JSON.parse(await reasoningThinker({ system: 's', user: 'u' })).summary, '推理');
  });
});

test('brainModelConfig：只配置 DEEPSEEK_API_KEY 时自动切换 DeepSeek', async () => {
  await withModelEnv({ DEEPSEEK_API_KEY: 'ds-key' }, () => {
    const config = brainModelConfig();
    assert.equal(config.apiKey, 'ds-key');
    assert.equal(config.baseUrl, 'https://api.deepseek.com');
    assert.equal(config.model, 'deepseek-chat');
  });

  await withModelEnv({ DEEPSEEK_API_KEY: 'ds-key', BRAIN_MODEL: 'deepseek-reasoner' }, () => {
    const config = brainModelConfig();
    assert.equal(config.baseUrl, 'https://api.deepseek.com');
    assert.equal(config.model, 'deepseek-reasoner');
  });

  // 显式 Agnes/BRAIN key 优先，避免误切供应商。
  await withModelEnv({ DEEPSEEK_API_KEY: 'ds-key', AGNES_API_KEY: 'agnes-key' }, () => {
    const config = brainModelConfig();
    assert.equal(config.apiKey, 'agnes-key');
    assert.equal(config.baseUrl, 'https://apihub.agnes-ai.com/v1');
  });

  // 显式 baseUrl 优先于 DeepSeek 自动推断。
  await withModelEnv({ DEEPSEEK_API_KEY: 'ds-key', BRAIN_BASE_URL: 'https://custom.example/v1' }, () => {
    const config = brainModelConfig({ model: 'custom-model' });
    assert.equal(config.baseUrl, 'https://custom.example/v1');
    assert.equal(config.model, 'custom-model');
  });
});

test('ownerAsk：问题可带 2–4 个可点选项，解析后保留稳定 id', () => {
  const plain = normalizeOwnerAsk('要不要继续？');
  assert.equal(plain.text, '要不要继续？');
  assert.equal(plain.options, null);

  const ask = normalizeOwnerAsk({
    text: '选一个方向',
    goalId: 'goal_1',
    options: ['继续现有方案', { label: '先补测试' }, '继续现有方案', '   '],
  });
  assert.equal(ask.text, '选一个方向');
  assert.equal(ask.goalId, 'goal_1');
  assert.deepEqual(ask.options.map((option) => option.id), ['o1', 'o2']);
  assert.deepEqual(ask.options.map((option) => option.label), ['继续现有方案', '先补测试']);

  // 少于两个 → 视为无选项，走「打开决策」链接。
  assert.equal(normalizeOwnerAsk({ text: '只有一个', options: ['唯一'] }).options, null);
  // 最多 4 个。
  const four = normalizeOwnerAsk({ text: '四个', options: ['a', 'b', 'c', 'd', 'e'] });
  assert.equal(four.options.length, MAX_OWNER_ASK_OPTIONS);
  // 过长标签截断。
  const longLabel = normalizeOwnerAsk({ text: '长', options: ['x'.repeat(80), 'y'] });
  assert.ok(longLabel.options[0].label.length <= MAX_OWNER_OPTION_LABEL);
});

test('ownerAsk：选项可带 detail 细节，旧的纯标签选项 detail 为空', () => {
  const ask = normalizeOwnerAsk({
    text: '求职自动化卡住了，选方向',
    options: [
      { label: 'A 重新设计自动化', detail: '新建任务重写 applier.py 自提交，预计 1–2 轮，成功恢复每日投递' },
      { label: 'B 先手动补投递', detail: '今天先手动投 20 份，自动化暂停，风险是不再自动跑' },
      'C 其他方向',
    ],
  });
  assert.equal(ask.options.length, 3);
  assert.match(ask.options[0].detail, /恢复每日投递/);
  assert.match(ask.options[1].detail, /手动投/);
  assert.equal(ask.options[2].detail, '');
  // 细节超长截断。
  const longDetail = normalizeOwnerAsk({
    text: '细节过长',
    options: [
      { label: 'x', detail: 'd'.repeat(400) },
      { label: 'y', detail: 'dd' },
    ],
  });
  assert.ok(longDetail.options[0].detail.length <= MAX_OWNER_OPTION_DETAIL);
  // 提示词要求选项必须带细节、问题要自带背景。
  const prompt = buildBrainPrompt({ now: '2026-11-17T04:00:00.000Z', tasks: [], decisions: [] });
  assert.match(prompt.system, /每个选项必须给 detail/);
  assert.match(prompt.system, /ownerAsk\.text 也要自带背景/);
});

test('normalizeOwnerReply：记录主人选择，缺关键字段回退 null', () => {
  const reply = normalizeOwnerReply({
    optionId: 'o2',
    label: '先补测试',
    question: '选一个方向',
    at: '2026-11-17T00:00:00.000Z',
    goalId: 'goal_1',
  });
  assert.deepEqual(reply, {
    optionId: 'o2',
    label: '先补测试',
    text: '',
    question: '选一个方向',
    at: '2026-11-17T00:00:00.000Z',
    goalId: 'goal_1',
  });
  assert.equal(normalizeOwnerReply({ label: '没有 id' }), null);
  assert.equal(normalizeOwnerReply({ optionId: 'o1' }), null);
  assert.equal(normalizeOwnerReply(null), null);
});

test('parseBrainReply：assessment.ownerAsk 为对象时保留选项', () => {
  const reply = parseBrainReply(JSON.stringify({
    summary: '需要主人拍板',
    actions: [],
    assessment: {
      goals: '目标 A',
      progress: '',
      betterWay: '',
      improvement: '',
      myMove: '',
      ownerAsk: { text: '选一个方向', options: ['继续现有方案', '先补测试'] },
    },
  }));
  assert.equal(reply.ownerAsk.text, '选一个方向');
  assert.deepEqual(reply.ownerAsk.options.map((option) => option.label), ['继续现有方案', '先补测试']);
  assert.deepEqual(reply.ownerAsk.options.map((option) => option.id), ['o1', 'o2']);

  // 字符串形式仍然兼容，且不产生选项。
  const plain = parseBrainReply(JSON.stringify({
    summary: '等你决定',
    actions: [],
    assessment: { ownerAsk: '要不要继续？' },
  }));
  assert.equal(plain.ownerAsk.text, '要不要继续？');
  assert.equal(plain.ownerAsk.options, null);
});

test('buildBrainPrompt：create_task 要求拆分跨阶段大任务并服从本机 CLI 硬上限', () => {
  const prompt = buildBrainPrompt({ now: '2026-11-17T04:00:00.000Z', tasks: [], decisions: [] });
  assert.match(prompt.system, /拆成 2–3 个 create_task/);
  assert.match(prompt.system, /本机 CLI 有硬性执行上限/);
  assert.match(prompt.system, /15 分钟内/);
});
