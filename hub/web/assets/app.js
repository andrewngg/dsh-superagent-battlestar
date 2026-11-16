'use strict';

/**
 * BattleStar · Web / 手机控制台
 * 零依赖、无构建，原生 JS。所有用户数据一律通过 textContent / DOM 节点渲染，避免 XSS。
 * 接口契约见 docs/PROTOCOL.md（v1）。
 */
(() => {
  /* ==================================================================
   * 常量与工具
   * ================================================================== */
  const PROTOCOL_VERSION = 1;
  const LS_BASE = 'sb.hub.base';
  const LS_TOKEN = 'sb.hub.token';
  const MOBILE_MQ = window.matchMedia('(max-width: 600px)');

  const TASK_STATUS = {
    queued: { label: '排队中', tone: 'queued' },
    assigned: { label: '已分配', tone: 'assigned' },
    running: { label: '运行中', tone: 'running' },
    completed: { label: '已完成', tone: 'completed' },
    failed: { label: '失败', tone: 'failed' },
    cancelled: { label: '已取消', tone: 'cancelled' },
    timeout: { label: '超时', tone: 'timeout' },
    waiting: { label: '等待回答', tone: 'waiting' },
  };
  const ACTIVE_STATUS = new Set(['queued', 'assigned', 'running', 'waiting']);
  const RETRYABLE_STATUS = new Set(['failed', 'timeout', 'cancelled']);
  /** 只有终态任务可以回收进垃圾桶。 */
  const TRASHABLE_STATUS = new Set(['completed', 'failed', 'timeout', 'cancelled']);

  const GOAL_STATUS = {
    active: { label: '进行中', tone: 'active' },
    paused: { label: '已暂停', tone: 'paused' },
    stopped: { label: '已停止', tone: 'stopped' },
    completed: { label: '已完成', tone: 'completed' },
  };
  const GOAL_CHECK_STATUS = {
    running: '检查中',
    completed: '检查成功',
    failed: '检查失败',
    timeout: '检查超时',
    cancelled: '检查已取消',
  };
  /** 自主大脑：模式 / 触发方式 / 白名单动作的展示文案。 */
  const BRAIN_MODE_LABEL = { auto: '自动执行', suggest: '只给建议' };
  const BRAIN_TRIGGER_LABEL = { manual: '手动', schedule: '定时' };
  const BRAIN_ACTION_LABEL = {
    retry_task: '重试任务',
    resume_thread: '继续任务',
    create_task: '新建任务',
    link_task: '关联任务',
    none: '无动作',
  };
  /** 自主大脑六步思考：assessment 字段 → 展示文案（顺序即思考协议顺序）。 */
  const BRAIN_STEPS = [
    { key: 'goals', i18n: 'brain.stepGoals' },
    { key: 'progress', i18n: 'brain.stepProgress' },
    { key: 'betterWay', i18n: 'brain.stepBetterWay' },
    { key: 'improvement', i18n: 'brain.stepImprovement' },
    { key: 'myMove', i18n: 'brain.stepMyMove' },
    { key: 'ownerAsk', i18n: 'brain.stepOwnerAsk' },
  ];
  /** 卡片只展示最关键的三步，其余步骤放在大脑抽屉里。 */
  const BRAIN_CARD_STEPS = ['goals', 'progress', 'myMove'];
  /** 管家心路：条目种类与筛选器。 */
  const JOURNAL_KIND_META = {
    thought: { i18n: 'journal.kindThought', tone: 'thought', iconName: 'spark' },
    work: { i18n: 'journal.kindWork', tone: 'work', iconName: 'check' },
    milestone: { i18n: 'journal.kindMilestone', tone: 'milestone', iconName: 'flag' },
    daily: { i18n: 'journal.kindDaily', tone: 'daily', iconName: 'activity' },
  };
  const JOURNAL_FILTERS = [
    { id: 'all', i18n: 'journal.filterAll' },
    { id: 'thought', i18n: 'journal.filterThought' },
    { id: 'work', i18n: 'journal.filterWork' },
    { id: 'milestone', i18n: 'journal.filterMilestone' },
    { id: 'daily', i18n: 'journal.filterDaily' },
  ];
  /** 头脑风暴：空态时给用户的建议问题（i18n 键）。 */
  const BRAINSTORM_SUGGESTIONS = ['brainstorm.suggest1', 'brainstorm.suggest2', 'brainstorm.suggest3'];

  const DEVICE_STATUS = { idle: '空闲', busy: '忙碌', degraded: '降级', offline: '离线', disabled: '已禁用' };
  const PLATFORM_LABEL = { windows: 'Windows', macos: 'macOS', linux: 'Linux', android: 'Android', other: '其他' };
  const KIND_LABEL = { dsh: 'DSH 智能体', ollama: 'Ollama', 'openai-gateway': '模型网关', custom: '自定义' };
  const SSE_TEXT = {
    idle: '未连接',
    connecting: '连接中…',
    open: '实时已连接',
    reconnecting: '重连中…',
    polling: '轮询 5s',
    closed: '已断开',
  };
  const EVENT_LABEL = {
    created: '创建',
    queued: '排队',
    routed: '路由',
    assigned: '分配',
    ack: '接受',
    progress: '进度',
    completed: '完成',
    failed: '失败',
    timeout: '超时',
    cancelled: '取消',
    cancel: '取消',
    retry: '重试',
    retried: '重新提交',
    requeued: '重新排队',
    blocked: '卡点',
    device: '设备',
  };
  /** Agnes 执行计划里的策略/并行组文案。 */
  const PLAN_STRATEGY_LABEL = { parallel: '并行执行', sequential: '按顺序执行', mixed: '并行 + 顺序依赖' };
  const planStrategyLabel = (plan) => (plan && PLAN_STRATEGY_LABEL[plan.strategy]) || '';
  const TABS = new Set(['status', 'tasks', 'command', 'goals', 'journal', 'brainstorm', 'mind', 'reminders', 'developer', 'settings']);
  /** 心智（Soul / Skill）字段上限缺省值；服务端 limits 优先。 */
  const MIND_FIELD_LIMITS = { soul: 6000, skill: 12000 };

  /* 多语言：ButlerI18n 由 assets/i18n.js 提供（默认中文时不做任何处理） */
  const I18N = window.ButlerI18n || null;
  const tr = (key, vars) => (I18N ? I18N.t(key, vars) : key);
  const currentLang = () => (I18N ? I18N.getLang() : 'zh-CN');
  const trStatus = (status) => {
    const key = `status.${status}`;
    const text = tr(key);
    return text === key ? status || '—' : text;
  };
  const applyLanguageFromServer = (serverLang) => {
    if (!I18N) return;
    const next = I18N.effectiveLang(serverLang);
    if (next !== I18N.getLang()) I18N.setLang(next, { persist: false });
  };

  /* 同步翻译（英文模式下渲染时立即翻译，避免先出现中文再被异步改英文的闪烁） */
  const tx = (value) => {
    const text = String(value == null ? '' : value);
    if (!I18N) return text;
    const translated = I18N.translateLegacy(text);
    return translated === null ? text : translated;
  };
  const TX_ATTRS = new Set(['title', 'placeholder', 'aria-label', 'alt']);
  function attrText(name, value) {
    if (value === true) return '';
    const text = String(value);
    return TX_ATTRS.has(name) ? tx(text) : text;
  }

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const arr = (v) => (Array.isArray(v) ? v : []);
  const num = (v, dflt = 0) => (Number.isFinite(v) ? v : dflt);
  const str = (v) => (typeof v === 'string' ? v : '');

  const nf = new Intl.NumberFormat('zh-CN');
  const fmtNum = (n) => (Number.isFinite(n) ? nf.format(n) : '–');

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === 'className' || key === 'class') node.className = value;
        else if (key === 'text') node.textContent = tx(value);
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
        else if (key === 'html') node.innerHTML = value; // 仅用于本文件内受信任的常量图标
        else if (key === 'attrs') {
          for (const [attrName, attrValue] of Object.entries(value || {})) {
            if (attrValue === null || attrValue === undefined || attrValue === false) continue;
            node.setAttribute(attrName, attrText(attrName, attrValue));
          }
        } else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
        else if (key === 'value') node.setAttribute('value', String(value));
        else if (key === 'tabIndex') node.setAttribute('tabindex', String(value));
        else node.setAttribute(key, attrText(key, value));
      }
    }
    appendChildren(node, children);
    return node;
  }

  function appendChildren(node, children) {
    for (const child of children.flat(6)) {
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(child instanceof Node ? child : document.createTextNode(tx(String(child))));
    }
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  }

  const parseIso = (iso) => {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) ? t : null;
  };
  const pad2 = (n) => String(n).padStart(2, '0');

  function fmtRel(iso, now = Date.now()) {
    const t = parseIso(iso);
    if (t === null) return '—';
    const d = Math.max(0, now - t);
    if (d < 10000) return '刚刚';
    if (d < 60000) return `${Math.floor(d / 1000)} 秒前`;
    if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`;
    if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`;
    if (d < 604800000) return `${Math.floor(d / 86400000)} 天前`;
    return fmtDate(iso);
  }

  /** 未来时间（下次跟进）：即将跟进 / x 分钟后 / x 小时后 / x 天后。 */
  function fmtRelFuture(iso, now = Date.now()) {
    const t = parseIso(iso);
    if (t === null) return '—';
    const d = t - now;
    if (d <= 0) return '即将跟进';
    if (d < 60000) return '不到 1 分钟后';
    if (d < 3600000) return `${Math.floor(d / 60000)} 分钟后`;
    if (d < 86400000) return `${Math.floor(d / 3600000)} 小时后`;
    if (d < 604800000) return `${Math.floor(d / 86400000)} 天后`;
    return fmtDateTime(iso);
  }

  function fmtDate(iso) {
    const t = parseIso(iso);
    if (t === null) return '—';
    const d = new Date(t);
    return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  }

  function fmtDateTime(iso) {
    const t = parseIso(iso);
    if (t === null) return '—';
    const d = new Date(t);
    return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function fmtTime(iso) {
    const t = parseIso(iso);
    if (t === null) return '--:--:--';
    const d = new Date(t);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  function fmtDuration(ms) {
    const v = Math.max(0, Number(ms) || 0);
    if (v < 1000) return `${Math.round(v)} 毫秒`;
    if (v < 60000) return `${(v / 1000).toFixed(v < 10000 ? 1 : 0)} 秒`;
    if (v < 3600000) {
      const m = Math.floor(v / 60000);
      const s = Math.round((v % 60000) / 1000);
      return s ? `${m} 分 ${s} 秒` : `${m} 分钟`;
    }
    const h = Math.floor(v / 3600000);
    const m = Math.round((v % 3600000) / 60000);
    return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
  }

  function fmtClock(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    if (s < 60) return `${s} 秒`;
    if (s < 3600) return `${Math.floor(s / 60)} 分钟`;
    if (s < 86400) return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
    return `${Math.floor(s / 86400)} 天 ${Math.floor((s % 86400) / 3600)} 小时`;
  }

  function shorten(text, max = 46) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  function normStatus(status) {
    return TASK_STATUS[status] ? status : 'queued';
  }

  const isMobile = () => MOBILE_MQ.matches;

  /* ==================================================================
   * 状态
   * ================================================================== */
  /**
   * 设备昵称的“未提交草稿”：抽屉会被快照轮询/设备事件反复重建，
   * 没有它的话输入内容会被服务端数据覆盖（表现为输入框不断闪空）。
   * 声明放在模块顶部，避免早期异步回调里访问到 TDZ。
   */
  let deviceNicknameDraft = null;
  let taskRecoveryBusy = false;
  /** 上一次渲染设备抽屉时设备数据的指纹：没变化就不重建，避免无谓闪动。 */
  let deviceDrawerSig = '';

  const state = {
    baseUrl: '',
    token: '',
    connected: false,
    health: null,
    server: null,
    settings: null,
    devices: new Map(),
    tasks: [],
    stats: null,
    activity: [],
    history: [],
    goals: [],
    goalsLoaded: false,
    goalsLoading: false,
    goalsError: '',
    goalsSupported: false,
    goalsHubTime: '',
    brain: null,
    brainBusy: false,
    brainError: '',
    brainDecisions: [],
    goalDetail: null,
    journal: null,
    journalBusy: false,
    journalError: '',
    journalFilter: 'all',
    journalDays: 60,
    journalDirty: false,
    brainstorm: null,
    brainstormBusy: false,
    brainstormSending: false,
    brainstormError: '',
    brainstormSessions: [],
    brainstormSession: null,
    mind: null,
    mindLoaded: false,
    mindBusy: false,
    mindDirty: false,
    mindError: '',
    mindServerUpdated: false,
    reminders: [],
    remindersLoaded: false,
    remindersLoading: false,
    remindersError: '',
    remindersSupported: false,
    remindersHubTime: '',
    remindersBridge: { available: false, ok: false, scheduled: 0, permissionGranted: null, exact: null, error: '' },
    nightlyReview: null,
    nightlyReviewLoaded: false,
    nightlyReviewBusy: false,
    taskFilter: 'active', // 默认筛选「进行中」
    tasksCollapsed: true,
    selectedSkills: new Set(),
    pendingAttachments: [],
    followUpTaskId: null,
    routeTask: null,
    expandedEvents: new Set(),
    expandedOutput: new Set(),
    rawOutputs: new Set(),
    rawInstructions: new Set(),
    tab: 'status',
    autoOpenDone: false,
    sendBusy: false,
    drawer: { open: false, kind: null, id: null, returnFocus: null },
    sse: { es: null, status: 'idle', attempts: 0, retryTimer: 0, disabled: false, lastEventAt: 0 },
    poll: { timer: 0, inFlight: false },
    snapshotTimer: 0,
    relTimer: 0,
    sigs: { stats: '', devices: '', tasks: '', composer: '', activity: '', settings: '', goals: '', reminders: '' },
    records: { items: [], total: 0, recordDir: '', q: '', status: '', loading: false, error: '', detail: null },
  };
  const taskNotifyState = new Map();
  const goalBusy = new Set();
  /** 目标关联任务刷新防抖定时器（SSE 事件很密）。 */
  let goalDetailTimer = 0;
  /** 心路 SSE 刷新防抖定时器。 */
  let journalReloadTimer = 0;
  /** 头脑风暴 SSE 刷新防抖定时器 / 加载序号（用于丢弃过期响应）。 */
  let brainstormRefreshTimer = 0;
  let brainstormLoadSeq = 0;
  const reminderBusy = new Set();
  /** 上次同步给 APK 的提醒指纹：内容没变就不重复调用桥，避免反复重排闹钟。 */
  let reminderSyncSig = '';
  const devState = { busy: false, jobId: '', timer: 0, pollFailures: 0, messages: [] };

  /* ==================================================================
   * 会话与 API
   * ================================================================== */
  function readSession() {
    let base = '';
    let token = '';
    try {
      base = localStorage.getItem(LS_BASE) || '';
      token = localStorage.getItem(LS_TOKEN) || '';
    } catch {
      /* 隐私模式可能禁用 localStorage */
    }
    return { base, token };
  }

  function saveSession(base, token) {
    try {
      localStorage.setItem(LS_BASE, base || '');
      localStorage.setItem(LS_TOKEN, token || '');
    } catch {
      /* ignore */
    }
  }

  function clearSession() {
    try {
      localStorage.removeItem(LS_BASE);
      localStorage.removeItem(LS_TOKEN);
    } catch {
      /* ignore */
    }
  }

  function urlParam(name) {
    try {
      return new URLSearchParams(window.location.search).get(name);
    } catch {
      return null;
    }
  }

  function scrubUrlToken() {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has('token')) {
        url.searchParams.delete('token');
        history.replaceState(null, '', url.pathname + (url.search || '') + url.hash);
      }
    } catch {
      /* ignore */
    }
  }

  function normalizeBase(input) {
    let s = String(input || '').trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) {
      if (!/^[a-z0-9.\-]+(:\d+)?(\/|$)/i.test(s)) throw new Error('Hub 地址需以 http:// 或 https:// 开头');
      s = 'http://' + s;
    }
    let parsed;
    try {
      parsed = new URL(s);
    } catch {
      throw new Error('Hub 地址格式不正确');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('仅支持 http / https 地址');
    return parsed.origin + parsed.pathname.replace(/\/+$/, '');
  }

  class ApiError extends Error {
    constructor(status, code, message) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  async function api(path, opts = {}) {
    const {
      method = 'GET',
      body,
      token = state.token,
      timeout = 15000,
      base = state.baseUrl,
    } = opts;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers['X-Butler-Token'] = token;
    let res;
    try {
      res = await fetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'same-origin',
      });
    } catch (err) {
      const aborted = err && err.name === 'AbortError';
      throw new ApiError(0, 'network', aborted ? '请求超时，请检查 Hub 地址与网络' : '无法连接 Hub，请检查地址与网络');
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text().catch(() => '');
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!res.ok) {
      const code = data && data.error ? data.error.code : '';
      let message = (data && data.error && data.error.message) || `请求失败（HTTP ${res.status}）`;
      if (res.status === 401) message = '管理员令牌无效或已过期，请重新输入';
      if (res.status === 403) message = message || '没有权限执行该操作';
      throw new ApiError(res.status, code, message);
    }
    return data;
  }

  /* ==================================================================
   * Toast / 加载 / 确认框
   * ================================================================== */
  function toast(message, type = 'info', ttl = 4200) {
    const root = $('#toast-root');
    const iconName = type === 'success' ? 'check' : type === 'error' ? 'alert' : type === 'warn' ? 'clock' : 'spark';
    const node = el('div', { className: 'toast', dataset: { type } },
      icon(iconName),
      el('div', { className: 'toast-msg', text: String(message) }),
    );
    root.appendChild(node);
    const remove = () => {
      node.classList.add('is-leaving');
      setTimeout(() => node.remove(), 240);
    };
    setTimeout(remove, ttl);
  }

  function setLoading(show, text) {
    const view = $('#loading-view');
    if (show) {
      $('#loading-text').textContent = tx(text || '正在连接中枢…');
      view.hidden = false;
    } else {
      view.hidden = true;
    }
  }

  function confirmDialog({ title, message, okText = '确认', danger = true }) {
    return new Promise((resolve) => {
      const root = $('#modal-root');
      const ok = $('#modal-ok');
      const cancel = $('#modal-cancel');
      const backdrop = $('.modal-backdrop', root);
      $('#modal-title').textContent = tx(title || '确认操作');
      $('#modal-message').textContent = tx(message);
      ok.textContent = tx(okText);
      ok.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');

      const cleanup = (result) => {
        root.hidden = true;
        ok.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onCancel);
        backdrop.removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onKey, true);
        resolve(result);
      };
      const onOk = () => cleanup(true);
      const onCancel = () => cleanup(false);
      const onKey = (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          cleanup(false);
        }
      };
      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', onCancel);
      backdrop.addEventListener('click', onCancel);
      document.addEventListener('keydown', onKey, true);
      root.hidden = false;
      ok.focus();
    });
  }

  /* ==================================================================
   * 连接 / 断开
   * ================================================================== */
  function setConnectError(message) {
    const box = $('#connect-error');
    if (!message) {
      box.hidden = true;
      box.textContent = '';
      return;
    }
    box.textContent = message;
    box.hidden = false;
  }

  function setConnectBusy(busy) {
    const btn = $('#connect-btn');
    btn.disabled = busy;
    $('.spinner', btn).hidden = !busy;
    $('.btn-label', btn).textContent = tx(busy ? '连接中…' : '测试并连接');
  }

  function showConnectView(message) {
    $('#app-view').hidden = true;
    $('#connect-view').hidden = false;
    document.body.classList.remove('no-scroll');
    if (message) setConnectError(message);
    setConnectBusy(false);
    setSseStatus('idle');
  }

  function showAppView() {
    $('#connect-view').hidden = true;
    $('#app-view').hidden = false;
    $('#section-settings').hidden = false;
    setConnectError('');
    setConnectBusy(false);
  }

  async function connect(base, token) {
    const trimmed = String(token || '').trim();
    if (!trimmed) throw new Error('请输入管理员令牌');
    if (!base) {
      // 同源：留空 base 即当前 origin
      const health = await api('/api/health', { token: trimmed, base: '' });
      const snapshot = await api('/api/snapshot?limit=50', { token: trimmed, base: '' });
      commitSession('', trimmed, health, snapshot);
      return;
    }
    const health = await api('/api/health', { base, token: trimmed });
    const snapshot = await api('/api/snapshot?limit=50', { base, token: trimmed });
    commitSession(base, trimmed, health, snapshot);
  }

  function commitSession(base, token, health, snapshot) {
    stopSse();
    stopPolling();
    clearTimeout(state.snapshotTimer);
    state.baseUrl = base;
    state.token = token;
    state.connected = true;
    state.health = health && typeof health === 'object' ? health : null;
    state.sse.disabled = false;
    state.sse.attempts = 0;
    saveSession(base, token);
    applySnapshot(snapshot);
    showAppView();
    startSse();
    setTab(currentTabFromHash(), { scroll: false });
    scrubUrlToken();
    scheduleRelativeRefresh();
    setTimeout(() => maybeAutoOpen(), 60);
    toast('已连接到 BattleStar', 'success');
  }

  async function handleAuthLost(message) {
    stopSse();
    stopPolling();
    state.connected = false;
    state.devices = new Map();
    state.tasks = [];
    state.stats = null;
    state.routeTask = null;
    state.goals = [];
    state.goalsLoaded = false;
    state.goalsLoading = false;
    state.goalsError = '';
    state.goalsSupported = false;
    goalBusy.clear();
    state.sigs.goals = '';
    state.brain = null;
    state.brainBusy = false;
    state.brainError = '';
    state.brainDecisions = [];
    state.goalDetail = null;
    clearTimeout(goalDetailTimer);
    goalDetailTimer = 0;
    state.journal = null;
    state.journalBusy = false;
    state.journalError = '';
    state.journalDirty = false;
    clearTimeout(journalReloadTimer);
    journalReloadTimer = 0;
    state.brainstorm = null;
    state.brainstormBusy = false;
    state.brainstormSending = false;
    state.brainstormError = '';
    state.brainstormSessions = [];
    state.brainstormSession = null;
    clearTimeout(brainstormRefreshTimer);
    brainstormRefreshTimer = 0;
    brainstormLoadSeq += 1;
    state.mind = null;
    state.mindLoaded = false;
    state.mindBusy = false;
    state.mindDirty = false;
    state.mindError = '';
    state.mindServerUpdated = false;
    state.reminders = [];
    state.remindersLoaded = false;
    state.remindersLoading = false;
    state.remindersError = '';
    state.remindersSupported = false;
    state.remindersHubTime = '';
    state.remindersBridge = { available: false, ok: false, scheduled: 0, permissionGranted: null, exact: null, error: '' };
    reminderBusy.clear();
    reminderSyncSig = '';
    state.sigs.reminders = '';
    hideDrawer();
    showConnectView(message || '管理员令牌已失效，请重新连接');
    $('#admin-token').focus();
  }

  async function logout() {
    const ok = await confirmDialog({
      title: '退出并清除令牌？',
      message: '将从本机 localStorage 删除管理员令牌与 Hub 地址，需要重新输入才能连接。',
      okText: '退出',
    });
    if (!ok) return;
    stopSse();
    stopPolling();
    clearTimeout(state.snapshotTimer);
    clearSession();
    state.connected = false;
    state.token = '';
    state.baseUrl = '';
    state.health = null;
    state.server = null;
    state.devices = new Map();
    state.tasks = [];
    state.stats = null;
    state.activity = [];
    state.routeTask = null;
    state.goals = [];
    state.goalsLoaded = false;
    state.goalsLoading = false;
    state.goalsError = '';
    state.goalsSupported = false;
    goalBusy.clear();
    state.sigs.goals = '';
    state.brain = null;
    state.brainBusy = false;
    state.brainError = '';
    state.brainDecisions = [];
    state.goalDetail = null;
    clearTimeout(goalDetailTimer);
    goalDetailTimer = 0;
    state.journal = null;
    state.journalBusy = false;
    state.journalError = '';
    state.journalDirty = false;
    clearTimeout(journalReloadTimer);
    journalReloadTimer = 0;
    state.brainstorm = null;
    state.brainstormBusy = false;
    state.brainstormSending = false;
    state.brainstormError = '';
    state.brainstormSessions = [];
    state.brainstormSession = null;
    clearTimeout(brainstormRefreshTimer);
    brainstormRefreshTimer = 0;
    brainstormLoadSeq += 1;
    state.mind = null;
    state.mindLoaded = false;
    state.mindBusy = false;
    state.mindDirty = false;
    state.mindError = '';
    state.mindServerUpdated = false;
    state.reminders = [];
    state.remindersLoaded = false;
    state.remindersLoading = false;
    state.remindersError = '';
    state.remindersSupported = false;
    state.remindersHubTime = '';
    state.remindersBridge = { available: false, ok: false, scheduled: 0, permissionGranted: null, exact: null, error: '' };
    reminderBusy.clear();
    reminderSyncSig = '';
    state.sigs.reminders = '';
    state.autoOpenDone = false;
    hideDrawer();
    scrubUrlToken();
    $('#hub-url').value = '';
    $('#admin-token').value = '';
    setSseStatus('idle');
    showConnectView();
    toast('已退出并清除本机令牌', 'success');
  }

  /* ==================================================================
   * 实时：SSE + 轮询兜底
   * ================================================================== */
  function setSseStatus(status) {
    if (state.sse.status !== status) state.sse.status = status;
    const pill = $('#sse-pill');
    if (!pill) return;
    pill.dataset.state = status;
    const text = $('#sse-text');
    if (text) text.textContent = tx(SSE_TEXT[status] || status);
    refreshSettings();
  }

  function startSse() {
    if (!state.connected) return;
    closeSse();
    clearTimeout(state.sse.retryTimer);
    setSseStatus(state.sse.attempts > 0 ? 'reconnecting' : 'connecting');
    if (typeof EventSource === 'undefined' || state.sse.disabled) {
      setSseStatus('polling');
      startPolling();
      return;
    }
    const url = `${state.baseUrl}/api/events?token=${encodeURIComponent(state.token)}`;
    let es;
    try {
      es = new EventSource(url);
    } catch {
      state.sse.disabled = true;
      setSseStatus('polling');
      startPolling();
      return;
    }
    state.sse.es = es;

    es.addEventListener('open', () => {
      state.sse.attempts = 0;
      state.sse.lastEventAt = Date.now();
      stopPolling();
      setSseStatus('open');
    });

    es.addEventListener('error', () => {
      handleSseError();
    });

    es.addEventListener('snapshot', (event) => {
      state.sse.lastEventAt = Date.now();
      handleSnapshotPayload(event.data);
    });

    const named = [
      'device.updated', 'device.online', 'device.offline',
      'task.created', 'task.updated', 'task.completed', 'task.failed', 'task.deleted',
      'goal.created', 'goal.updated', 'goal.deleted', 'goal.approval',
      'nightly.review.updated', 'brain.updated', 'journal.updated', 'brainstorm.updated', 'mind.updated',
      'log', 'ping',
    ];
    for (const name of named) {
      es.addEventListener(name, (event) => {
        state.sse.lastEventAt = Date.now();
        handleEvent(name, event.data);
      });
    }
    // 兼容未命名 message 事件
    es.onmessage = (event) => {
      state.sse.lastEventAt = Date.now();
      handleSnapshotPayload(event.data);
    };
  }

  function closeSse() {
    if (state.sse.es) {
      try {
        state.sse.es.close();
      } catch {
        /* ignore */
      }
      state.sse.es = null;
    }
  }

  function stopSse() {
    closeSse();
    clearTimeout(state.sse.retryTimer);
    state.sse.retryTimer = 0;
    state.sse.attempts = 0;
  }

  function handleSseError() {
    closeSse();
    if (!state.connected) return;
    const attempt = state.sse.attempts++;
    const delay = Math.min(1000 * Math.pow(1.8, attempt), 20000) + Math.floor(Math.random() * 300);
    startPolling();
    setSseStatus(attempt >= 2 ? 'polling' : 'reconnecting');
    clearTimeout(state.sse.retryTimer);
    state.sse.retryTimer = setTimeout(() => {
      if (state.connected) startSse();
    }, delay);
  }

  function startPolling() {
    if (state.poll.timer) return;
    state.poll.timer = setInterval(pollSnapshot, 5000);
    pollSnapshot();
  }

  function stopPolling() {
    clearInterval(state.poll.timer);
    state.poll.timer = 0;
  }

  async function pollSnapshot() {
    if (!state.connected || state.poll.inFlight) return;
    state.poll.inFlight = true;
    try {
      const snapshot = await api('/api/snapshot?limit=50', { timeout: 10000 });
      applySnapshot(snapshot);
    } catch (err) {
      if (err.status === 401) handleAuthLost(err.message);
    } finally {
      state.poll.inFlight = false;
    }
  }

  function scheduleSnapshot(delay = 350) {
    clearTimeout(state.snapshotTimer);
    state.snapshotTimer = setTimeout(async () => {
      if (!state.connected) return;
      try {
        const snapshot = await api('/api/snapshot?limit=50', { timeout: 10000 });
        applySnapshot(snapshot);
      } catch (err) {
        if (err.status === 401) handleAuthLost(err.message);
      }
    }, delay);
  }

  function handleSnapshotPayload(raw) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (data && data.devices && data.tasks) applySnapshot(data);
  }

  function handleEvent(name, raw) {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    if (!payload) return;
    if (name === 'device.updated') return onDeviceUpdated(payload.device);
    if (name === 'device.online' || name === 'device.offline') return onDevicePresence(name, payload);
    if (name === 'task.deleted') return onTaskDeleted(payload);
    if (name.startsWith('task.')) return onTaskEvent(name, payload.task);
    if (name.startsWith('goal.')) return onGoalEvent(name, payload);
    if (name.startsWith('reminder.')) return onReminderEvent(name, payload);
    if (name === 'nightly.review.updated') return onNightlyReviewUpdated(payload.review);
    if (name === 'brain.updated') return onBrainUpdated(payload);
    if (name === 'journal.updated') return onJournalUpdated(payload);
    if (name === 'brainstorm.updated') return onBrainstormUpdated(payload);
    if (name === 'mind.updated') return onMindUpdated(payload);
    if (name === 'settings.updated') return onSettingsUpdated(payload);
    if (name === 'log') return onLogEvent(payload);
    if (name === 'ping') return;
  }

  function onNightlyReviewUpdated(review) {
    if (!review || typeof review !== 'object') return;
    state.nightlyReview = review;
    state.nightlyReviewLoaded = true;
    renderNightlyReview();
  }

  function onSettingsUpdated(payload) {
    const settings = payload && payload.settings && typeof payload.settings === 'object' ? payload.settings : null;
    if (!settings) return;
    state.settings = settings;
    applyLanguageFromServer(settings.language);
    refreshSettings();
  }

  /* ==================================================================
   * 快照应用与增量
   * ================================================================== */
  function applySnapshot(data) {
    if (!data || typeof data !== 'object') return;
    const devices = arr(data.devices).filter((d) => d && d.id);
    state.devices = new Map(devices.map((d) => [d.id, d]));
    const tasks = arr(data.tasks).slice();
    tasks.sort((a, b) => (parseIso(b.createdAt) || 0) - (parseIso(a.createdAt) || 0));
    state.tasks = tasks;
    if (data.stats && typeof data.stats === 'object') state.stats = data.stats;
    if (data.server && typeof data.server === 'object') state.server = data.server;
    if (data.settings && typeof data.settings === 'object') {
      state.settings = data.settings;
      applyLanguageFromServer(data.settings.language);
    }
    if (Array.isArray(data.events)) state.activity = data.events.slice();
    if (Array.isArray(data.goals)) {
      state.goals = data.goals.filter((goal) => goal && goal.id);
      state.goalsLoaded = true;
      state.goalsSupported = true;
      state.goalsError = '';
      state.sigs.goals = '';
    }
    if (data.brain && typeof data.brain === 'object') state.brain = data.brain;
    if (Array.isArray(data.reminders)) {
      state.reminders = data.reminders.filter((item) => item && item.id);
      sortReminders();
      state.remindersLoaded = true;
      state.remindersSupported = true;
      state.remindersError = '';
      state.sigs.reminders = '';
    }
    if (data.nightlyReview && typeof data.nightlyReview === 'object') {
      state.nightlyReview = data.nightlyReview;
      state.nightlyReviewLoaded = true;
    }
    if (!state.health || !state.health.version) {
      state.health = {
        ...(state.health || {}),
        version: (state.server && state.server.version) || (state.health && state.health.version) || '—',
        protocol: (state.health && state.health.protocol) || PROTOCOL_VERSION,
      };
    }
    renderAll();
    maybeAutoOpen();
    if (state.drawer.open) refreshOpenDrawer();
    syncTaskNotifications();
    ensureGoalsLoaded();
    ensureRemindersLoaded();
    if (state.remindersLoaded) syncRemindersToApk();
  }

  /** 把任务进度/完成事件桥接给 Android APK（浏览器中不存在 ButlerBridge，自动忽略）。 */
  function syncTaskNotifications() {
    let bridge = null;
    try {
      bridge = window.ButlerBridge;
    } catch (e) {
      bridge = null;
    }
    if (!bridge || typeof bridge.taskProgress !== 'function' || typeof bridge.taskFinished !== 'function') {
      taskNotifyState.clear();
      return;
    }
    const terminal = new Set(['completed', 'failed', 'timeout', 'cancelled']);
    for (const task of state.tasks.slice(0, 40)) {
      if (!task || !task.id) continue;
      const status = normStatus(task.status);
      const progress = taskProgressOf(task) || {};
      const percent = Number.isFinite(progress.percent) ? Math.round(Math.max(0, Math.min(100, progress.percent))) : -1;
      const message = progress.message || '';
      const payload = {
        id: task.id,
        status,
        instruction: task.instruction || '',
        percent,
        message,
        device: deviceName(task.assignedDeviceId),
      };
      const prev = taskNotifyState.get(task.id);
      try {
        if (ACTIVE_STATUS.has(status)) {
          const changed = !prev || prev.status !== status || prev.percent !== percent || prev.message !== message;
          if (changed) bridge.taskProgress(JSON.stringify(payload));
          taskNotifyState.set(task.id, { status, percent, message });
        } else if (terminal.has(status)) {
          if (prev && !prev.finished) {
            bridge.taskFinished(JSON.stringify({ ...payload, message: task.error || message || '' }));
          }
          taskNotifyState.set(task.id, { status, finished: true, percent, message });
        }
      } catch (e) {
        // 通知失败不能影响主界面
      }
    }
    if (taskNotifyState.size > 100) {
      const keep = new Set(state.tasks.slice(0, 100).map((t) => t.id));
      for (const id of taskNotifyState.keys()) if (!keep.has(id)) taskNotifyState.delete(id);
    }
  }

  function upsertTask(task) {
    if (!task || !task.id) return null;
    const idx = state.tasks.findIndex((t) => t.id === task.id);
    let prev = null;
    if (idx >= 0) {
      prev = state.tasks[idx];
      state.tasks[idx] = { ...prev, ...task };
    } else {
      state.tasks.unshift(task);
      state.tasks.sort((a, b) => (parseIso(b.createdAt) || 0) - (parseIso(a.createdAt) || 0));
    }
    return { task: state.tasks.find((t) => t.id === task.id), prev };
  }

  function bumpStat(key, delta) {
    if (!state.stats || typeof state.stats !== 'object') return;
    if (!Number.isFinite(state.stats[key])) return;
    state.stats[key] = Math.max(0, state.stats[key] + delta);
  }

  function adjustStats(prevStatus, nextStatus) {
    const map = { queued: 'tasksQueued', assigned: 'tasksAssigned', running: 'tasksRunning', waiting: 'tasksWaiting', completed: 'tasksCompleted', failed: 'tasksFailed' };
    if (prevStatus && map[prevStatus]) bumpStat(map[prevStatus], -1);
    if (nextStatus && map[nextStatus]) bumpStat(map[nextStatus], 1);
  }

  function onTaskEvent(name, task) {
    if (!task || !task.id) return;
    const upserted = upsertTask(task);
    if (!upserted) return;
    const { task: current, prev } = upserted;
    const prevStatus = prev ? prev.status : null;
    if (name === 'task.created') {
      adjustStats(null, current.status);
      toast(`任务已创建：${shorten(current.instruction, 24)}`, 'success');
    } else if (prevStatus !== current.status) {
      adjustStats(prevStatus, current.status);
      if (current.status === 'completed') toast(`任务已完成：${shorten(current.instruction, 24)}`, 'success');
      else if (current.status === 'failed') toast(`任务失败：${shorten(current.error || current.instruction, 30)}`, 'error');
      else if (current.status === 'timeout') toast(`任务超时：${shorten(current.instruction, 24)}`, 'warn');
    }
    renderAll();
    if (state.drawer.open && state.drawer.kind === 'task' && state.drawer.id === current.id) refreshOpenDrawer();
    if (isGoalDrawerOpen()) scheduleGoalDetailRefresh(state.drawer.id);
    syncTaskNotifications();
  }

  /** 任务被彻底删除（回收站 purge / 普通删除）：从本地列表移除并刷新。 */
  function onTaskDeleted(payload) {
    const deletedTask = payload && payload.task && payload.task.id ? payload.task : null;
    const id = String(
      (payload && (payload.taskId || (deletedTask && deletedTask.id))) || '',
    );
    if (!id) return;
    const known = deletedTask || state.tasks.find((task) => task.id === id);
    const threadId = known && known.threadId ? String(known.threadId) : '';
    const before = state.tasks.length;
    state.tasks = state.tasks.filter((task) => (
      task.id !== id
      && task.parentTaskId !== id
      && !(threadId && String(task.threadId || '') === threadId)
    ));
    if (state.tasks.length === before) return;
    state.sigs.stats = '';
    state.sigs.tasks = '';
    if (state.drawer.open && state.drawer.kind === 'task'
      && !state.tasks.some((task) => task.id === state.drawer.id)) {
      hideDrawer();
    }
    renderAll();
    if (isGoalDrawerOpen()) scheduleGoalDetailRefresh(state.drawer.id);
  }

  function onDeviceUpdated(device) {
    if (!device || !device.id) return;
    state.devices.set(device.id, { ...(state.devices.get(device.id) || {}), ...device });
    renderAll();
    if (state.drawer.open && state.drawer.kind === 'device' && state.drawer.id === device.id) refreshOpenDrawer();
  }

  function onDevicePresence(name, payload) {
    const deviceId = payload.deviceId;
    if (!deviceId) return;
    const online = name === 'device.online';
    const device = state.devices.get(deviceId);
    if (device) {
      const was = !!device.online;
      device.online = online;
      if (!online) device.status = 'offline';
      else if (device.status === 'offline') device.status = 'idle';
      if (was !== online) {
        bumpStat('devicesOnline', online ? 1 : -1);
        toast(`${deviceDisplayName(device) || deviceId} ${online ? '已上线' : '已离线'}`, online ? 'success' : 'warn');
      }
      renderAll();
      if (state.drawer.open && state.drawer.kind === 'device' && state.drawer.id === deviceId) refreshOpenDrawer();
    } else {
      scheduleSnapshot(200);
    }
  }

  function onLogEvent(payload) {
    state.activity.unshift({
      at: payload.at || new Date().toISOString(),
      type: 'log',
      level: payload.level || 'info',
      message: payload.message || '',
    });
    state.activity = state.activity.slice(0, 60);
    renderActivity();
    refreshSettings();
  }

  /* ==================================================================
   * 视图模型
   * ================================================================== */
  function capsOf(device) {
    const caps = device && device.capabilities;
    if (caps && typeof caps === 'object') return caps;
    return {
      models: device && device.models,
      profiles: device && device.profiles,
      gateways: device && device.gateways,
      skills: device && device.skills,
      resources: device && device.resources,
      limits: device && device.limits,
    };
  }

  function modelsOf(device) {
    return arr(capsOf(device).models).filter((m) => m && m.id && m.available !== false);
  }
  function skillsOf(device) {
    return arr(capsOf(device).skills).filter((s) => s && s.id);
  }
  function profilesOf(device) {
    return arr(capsOf(device).profiles).filter((p) => p && p.id);
  }
  function gatewaysOf(device) {
    return arr(capsOf(device).gateways).filter((g) => g && g.id);
  }
  function tagsOf(device) {
    const direct = arr(device && device.tags);
    return direct.length ? direct : arr(capsOf(device).tags);
  }
  function loadOf(device) {
    const load = device && device.load;
    const caps = capsOf(device);
    const max = Math.max(1, num(load && load.max, num(caps.limits && caps.limits.maxConcurrentTasks, 1)));
    const running = Math.max(0, num(load && load.running, 0));
    return { running, max, ratio: Math.min(1, running / max) };
  }
  function deviceStatusOf(device) {
    if (!device.online) return 'offline';
    if (device.disabled) return 'disabled';
    return DEVICE_STATUS[device.status] ? device.status : 'idle';
  }
  function deviceDisplayName(device) {
    if (!device) return '';
    return device.nickname || device.name || device.id || '未知设备';
  }
  function deviceName(id) {
    const device = state.devices.get(id);
    if (device) return deviceDisplayName(device);
    return id || '未知设备';
  }
  function taskProgressOf(task) {
    if (Number.isFinite(task.progress)) return { percent: Math.max(0, Math.min(100, task.progress)) };
    if (task.progress && Number.isFinite(task.progress.percent)) {
      return { percent: Math.max(0, Math.min(100, task.progress.percent)), message: str(task.progress.message) };
    }
    const events = arr(task.events);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i];
      if (e && Number.isFinite(e.percent)) return { percent: Math.max(0, Math.min(100, e.percent)), message: str(e.message) };
    }
    return null;
  }
  function outputOf(task) {
    const out = task && task.output;
    if (!out) return null;
    if (typeof out === 'string') return { markdown: out };
    const text = str(out.text);
    const markdown = str(out.markdown);
    if (!text && !markdown) return null;
    return { text, markdown };
  }
  function computeStats() {
    const counts = { queued: 0, assigned: 0, running: 0, waiting: 0, completed: 0, failed: 0 };
    for (const task of state.tasks) {
      if (counts[task.status] !== undefined) counts[task.status] += 1;
    }
    return {
      devicesTotal: state.devices.size,
      devicesOnline: Array.from(state.devices.values()).filter((d) => d.online).length,
      tasksQueued: counts.queued,
      tasksAssigned: counts.assigned,
      tasksRunning: counts.running,
      tasksWaiting: counts.waiting,
      tasksCompleted: counts.completed,
      tasksFailed: counts.failed,
    };
  }
  function statsView() {
    const fallback = computeStats();
    const stats = state.stats && typeof state.stats === 'object' ? state.stats : {};
    const pick = (key) => (Number.isFinite(stats[key]) ? stats[key] : fallback[key]);
    return {
      total: pick('devicesTotal'),
      online: pick('devicesOnline'),
      queued: pick('tasksQueued'),
      assigned: pick('tasksAssigned'),
      running: pick('tasksRunning'),
      waiting: pick('tasksWaiting'),
      completed: pick('tasksCompleted'),
      failed: pick('tasksFailed'),
    };
  }
  function activeTasksOfDevice(id) {
    return state.tasks.filter((t) => t.assignedDeviceId === id && ACTIVE_STATUS.has(normStatus(t.status)));
  }

  /* ==================================================================
   * Markdown（安全：构造 DOM，不使用 innerHTML）
   * ================================================================== */
  function appendInline(parent, text) {
    const source = String(text || '');
    const re = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|\[[^\]]+\]\([^)\s]+\))/g;
    let last = 0;
    let match;
    while ((match = re.exec(source)) !== null) {
      if (match.index > last) parent.appendChild(document.createTextNode(source.slice(last, match.index)));
      const token = match[0];
      if (token.startsWith('`')) {
        parent.appendChild(el('code', { text: token.slice(1, -1) }));
      } else if (token.startsWith('**') || token.startsWith('__')) {
        parent.appendChild(el('strong', { text: token.slice(2, -2) }));
      } else if (token.startsWith('[')) {
        const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
        if (link && /^https?:\/\//i.test(link[2])) {
          parent.appendChild(el('a', { href: link[2], target: '_blank', rel: 'noopener noreferrer', text: link[1] }));
        } else if (link) {
          parent.appendChild(document.createTextNode(link[1]));
        } else {
          parent.appendChild(document.createTextNode(token));
        }
      } else {
        parent.appendChild(el('em', { text: token.slice(1, -1) }));
      }
      last = match.index + token.length;
    }
    if (last < source.length) parent.appendChild(document.createTextNode(source.slice(last)));
  }

  /* ---------- Markdown 表格（GFM）：解析 + 渲染 ---------- */

  /** 拆分表格行：支持 `\|` 转义与首尾竖线。 */
  function splitTableRow(row) {
    const cells = [];
    let cur = '';
    for (let index = 0; index < row.length; index += 1) {
      const ch = row[index];
      if (ch === '\\' && row[index + 1] === '|') {
        cur += '|';
        index += 1;
      } else if (ch === '|') {
        cells.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    cells.push(cur);
    if (cells.length && !cells[0].trim()) cells.shift();
    if (cells.length && !cells[cells.length - 1].trim()) cells.pop();
    return cells.map((cell) => cell.trim());
  }

  /** 解析分隔行 `---` / `:--` / `--:` / `:-:`，返回对齐方式数组；非分隔行返回 null。 */
  function tableAligns(row) {
    const cells = splitTableRow(row);
    if (!cells.length) return null;
    const aligns = [];
    for (const cell of cells) {
      const found = /^(:?)-{1,}(:?)$/.exec(cell);
      if (!found) return null;
      if (found[1] && found[2]) aligns.push('center');
      else if (found[2]) aligns.push('right');
      else aligns.push('left');
    }
    return aligns;
  }

  function tableAlignClass(align) {
    return align === 'center' ? 'ta-center' : align === 'right' ? 'ta-right' : 'ta-left';
  }

  /** 尝试从 lines[start] 解析一个 Markdown 表格；失败返回 null。 */
  function parseTableAt(lines, start) {
    const first = lines[start];
    if (!first || !/^\s*\|/.test(first)) return null;
    const head = splitTableRow(first);
    if (!head.length) return null;
    if (start + 1 >= lines.length) return null;
    const aligns = tableAligns(lines[start + 1]);
    if (!aligns || aligns.length !== head.length) return null;
    let index = start + 2;
    const rows = [];
    while (index < lines.length && /^\s*\|/.test(lines[index])) {
      const cells = splitTableRow(lines[index]);
      if (!cells.length) break;
      rows.push(cells);
      index += 1;
    }
    return { head, aligns, rows, next: index };
  }

  function buildTableNode(table) {
    const wrap = el('div', { className: 'md-table-wrap' });
    const node = el('table', { className: 'md-table' });
    const thead = el('thead');
    const headRow = el('tr');
    table.head.forEach((cell, index) => {
      const th = el('th', { className: tableAlignClass(table.aligns[index]), attrs: { scope: 'col' } });
      appendInline(th, cell);
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    const tbody = el('tbody');
    for (const row of table.rows) {
      const tr = el('tr');
      table.head.forEach((label, index) => {
        const td = el('td', { className: tableAlignClass(table.aligns[index]), dataset: { label: label || '' } });
        appendInline(td, row[index] || '');
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    node.appendChild(thead);
    node.appendChild(tbody);
    wrap.appendChild(node);
    return wrap;
  }

  /** 输出是否像“结构化 Markdown”（决定任务卡片/详情默认用渲染视图还是原文）。 */
  function looksLikeMarkdown(text) {
    const source = String(text || '');
    if (!source.trim()) return false;
    return /(^|\n)\s{0,3}#{1,6}\s+\S/.test(source)
      || /(^|\n)\s{0,3}(?:```|~~~)/.test(source)
      || /(^|\n)[ \t]*\|.*\|[ \t]*(?:\n|$)/.test(source)
      || /(^|\n)\s{0,3}[-*+]\s+\S/.test(source)
      || /(^|\n)\s{0,3}\d+[.)]\s+\S/.test(source)
      || /(^|\n)\s{0,3}>\s?/.test(source);
  }

  function renderMarkdown(markdown) {
    const root = el('div', { className: 'markdown' });
    const lines = String(markdown == null ? '' : markdown).replace(/\r\n?/g, '\n').split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*$/.test(line)) {
        i += 1;
        continue;
      }
      const fenceStart = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fenceStart) {
        const marker = fenceStart[1][0];
        const minLen = fenceStart[1].length;
        const closeRe = new RegExp('^\\s*' + (marker === '`' ? '`' : '~') + '{' + minLen + ',}\\s*$');
        const buf = [];
        i += 1;
        while (i < lines.length && !closeRe.test(lines[i])) {
          buf.push(lines[i]);
          i += 1;
        }
        i += 1;
        const pre = el('pre');
        pre.appendChild(el('code', { text: buf.join('\n') }));
        root.appendChild(pre);
        continue;
      }
      const table = parseTableAt(lines, i);
      if (table) {
        root.appendChild(buildTableNode(table));
        i = table.next;
        continue;
      }
      const heading = /^(#{1,4})\s+(.*)$/.exec(line);
      if (heading) {
        const node = el('h' + heading[1].length);
        appendInline(node, heading[2]);
        root.appendChild(node);
        i += 1;
        continue;
      }
      if (/^\s*>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, ''));
          i += 1;
        }
        const quote = el('blockquote');
        appendInline(quote, buf.join(' '));
        root.appendChild(quote);
        continue;
      }
      if (/^\s*[-*+]\s+/.test(line)) {
        const ul = el('ul');
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          const li = el('li');
          appendInline(li, lines[i].replace(/^\s*[-*+]\s+/, ''));
          ul.appendChild(li);
          i += 1;
        }
        root.appendChild(ul);
        continue;
      }
      if (/^\s*\d+[.)]\s+/.test(line)) {
        const ol = el('ol');
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
          const li = el('li');
          appendInline(li, lines[i].replace(/^\s*\d+[.)]\s+/, ''));
          ol.appendChild(li);
          i += 1;
        }
        root.appendChild(ol);
        continue;
      }
      const p = el('p');
      appendInline(p, line);
      root.appendChild(p);
      i += 1;
    }
    return root;
  }

  /* ==================================================================
   * 顶部 / 统计 / 相对时间
   * ================================================================== */
  function relNode(iso, prefix = '') {
    return el('span', {
      dataset: { rel: iso || '', relPrefix: prefix || '' },
      text: prefix + fmtRel(iso),
    });
  }

  function setText(sel, value) {
    const node = $(sel);
    if (node) node.textContent = tx(value);
  }

  function statusBadge(status) {
    const normalized = normStatus(status);
    const info = TASK_STATUS[normalized];
    return el('span', { className: 'status-badge', dataset: { status: normalized }, text: info.label });
  }

  function renderStats() {
    const view = statsView();
    const sig = JSON.stringify(view);
    setText('#head-online', String(view.online));
    setText('#head-total', `/${view.total}`);
    setText('#head-running', String(view.running + view.assigned + view.waiting));
    setText('#head-queued', String(view.queued));
    if (sig === state.sigs.stats) return;
    state.sigs.stats = sig;

    const cards = [
      {
        tone: 'online',
        label: '在线设备',
        icon: 'devices',
        value: String(view.online),
        suffix: `/${view.total}`,
        sub: `共 ${view.total} 台注册`,
      },
      {
        tone: 'running',
        label: '运行 / 等待',
        icon: 'activity',
        value: String(view.running + view.waiting),
        sub: `已分配 ${view.assigned} · 排队 ${view.queued}${view.waiting ? ` · 等待 ${view.waiting}` : ''}`,
      },
      {
        tone: 'queued',
        label: '排队任务',
        icon: 'queue',
        value: String(view.queued),
        sub: view.queued ? '等待在线设备接单' : '暂无排队',
      },
      {
        tone: 'completed',
        label: '已完成',
        icon: 'check',
        value: String(view.completed),
        sub: '本次累计完成',
      },
      {
        tone: 'failed',
        label: '失败 / 超时',
        icon: 'alert',
        value: String(view.failed),
        sub: '可在任务列表重试',
      },
    ];

    const grid = $('#stats-grid');
    grid.replaceChildren();
    for (const card of cards) {
      const node = el('div', { className: 'stat-card', dataset: { tone: card.tone } },
        el('span', { className: 'stat-icon' }, icon(card.icon)),
        el('span', { className: 'stat-label', text: card.label }),
        el('div', { className: 'stat-value' }, card.value, card.suffix ? el('small', { text: card.suffix }) : null),
        el('span', { className: 'stat-sub', text: card.sub, title: card.sub }),
      );
      grid.appendChild(node);
    }

    const activeCount = view.queued + view.assigned + view.running;
    let badge = $('.mobile-tab[data-tab="tasks"] .tab-badge');
    if (activeCount > 0) {
      if (!badge) {
        badge = el('span', { className: 'tab-badge' });
        const tab = $('.mobile-tab[data-tab="tasks"]');
        if (tab) tab.appendChild(badge);
      }
      badge.textContent = String(activeCount);
    } else if (badge) {
      badge.remove();
    }
  }

  function scheduleRelativeRefresh() {
    if (state.relTimer) return;
    state.relTimer = setInterval(() => {
      const now = Date.now();
      $$('[data-rel]').forEach((node) => {
        const iso = node.dataset.rel;
        if (iso) node.textContent = tx((node.dataset.relPrefix || '') + fmtRel(iso, now));
      });
      $$('[data-live-duration]').forEach((node) => {
        const start = parseIso(node.dataset.liveDuration);
        if (start !== null) node.textContent = tx(fmtDuration(now - start));
      });
      $$('[data-rel-future]').forEach((node) => {
        const iso = node.dataset.relFuture;
        if (iso) node.textContent = tx(fmtRelFuture(iso, now));
      });
      if (state.brain && state.tab === 'goals') renderBrainCard();
    }, 15000);
  }

  /* ==================================================================
   * 设备卡片
   * ================================================================== */
  function deviceIconName(device) {
    return String(device.platform || '').toLowerCase() === 'android' ? 'phone' : 'computer';
  }

  function deviceCard(device) {
    const load = loadOf(device);
    const status = deviceStatusOf(device);
    const active = activeTasksOfDevice(device.id).length;
    const platform = PLATFORM_LABEL[device.platform] || device.platform || '未知平台';
    const stateLabel = DEVICE_STATUS[status] || status;
    const displayName = deviceDisplayName(device);

    const card = el('article', {
      className: 'device-card' + (device.online ? '' : ' is-offline') + (device.disabled ? ' is-disabled' : ''),
      dataset: { deviceId: device.id, platform: deviceIconName(device) },
      role: 'button',
      tabIndex: 0,
      attrs: { 'aria-label': `查看设备 ${displayName} 的详情` },
    });

    card.appendChild(el('span', { className: 'device-icon' }, icon(deviceIconName(device))));
    card.appendChild(el('div', { className: 'device-main' },
      el('div', { className: 'device-line' },
        el('i', {
          className: 'status-dot',
          dataset: {
            tone: !device.online ? 'offline' : device.status === 'busy' ? 'busy' : device.status === 'degraded' ? 'degraded' : 'online',
          },
        }),
        el('h3', { className: 'device-name', text: displayName, title: displayName }),
      ),
      el('div', { className: 'device-sub' },
        el('span', { text: platform }),
        ' · ',
        el('span', { className: 'device-state', dataset: { status }, text: stateLabel }),
        ' · ',
        active ? el('span', { text: `${active} 个任务` }) : el('span', { text: '负载' }),
        active ? null : ` ${load.running}/${load.max}`,
      ),
    ));
    card.appendChild(el('span', { className: 'device-chevron' }, icon('chevron')));

    card.addEventListener('click', () => openDeviceDrawer(device.id));
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openDeviceDrawer(device.id);
      }
    });
    return card;
  }

  function sortDevices(a, b) {
    const ta = parseIso(a.registeredAt);
    const tb = parseIso(b.registeredAt);
    if (ta !== null && tb !== null && ta !== tb) return ta - tb;
    if (ta === null && tb !== null) return 1;
    if (tb === null && ta !== null) return -1;
    return String(deviceDisplayName(a)).localeCompare(String(deviceDisplayName(b)));
  }

  function emptyState({ iconName = 'devices', title, desc }) {
    return el('div', { className: 'empty-state', style: { gridColumn: '1 / -1' } },
      el('div', { className: 'empty-icon' }, icon(iconName)),
      el('p', { className: 'empty-title', text: title }),
      desc ? el('p', { className: 'empty-desc', text: desc }) : null,
    );
  }

  function renderDevices() {
    const grid = $('#device-grid');
    const list = Array.from(state.devices.values()).sort(sortDevices);
    const sig = JSON.stringify(list.map((d) => [
      d.id, d.name, d.nickname, d.platform, d.kind, d.online, d.status, d.disabled, d.load,
      d.registeredAt, activeTasksOfDevice(d.id).length,
    ]));
    if (sig === state.sigs.devices && grid.childElementCount) return;
    state.sigs.devices = sig;

    grid.replaceChildren();
    if (!list.length) {
      grid.appendChild(emptyState({
        iconName: 'devices',
        title: '还没有设备接入',
        desc: '在设备上启动 device-agent 并填写加入码，设备会自动出现在这里。',
      }));
    } else {
      for (const device of list) grid.appendChild(deviceCard(device));
    }
    const online = list.filter((d) => d.online).length;
    setText('#devices-sub', `${online} 台在线 · 共 ${list.length} 台注册`);
  }

  /* ==================================================================
   * 指令区
   * ================================================================== */
  function aggregateCapabilities() {
    const models = new Map();
    const skills = new Map();
    const devices = [];
    for (const device of state.devices.values()) {
      if (!device.online || device.disabled) continue;
      devices.push(device);
      for (const model of modelsOf(device)) {
        if (!models.has(model.id)) models.set(model.id, { id: model.id, provider: model.provider || '', count: 0 });
        models.get(model.id).count += 1;
      }
      for (const skill of skillsOf(device)) {
        if (!skills.has(skill.id)) skills.set(skill.id, { id: skill.id, name: skill.name || skill.id, count: 0 });
        skills.get(skill.id).count += 1;
      }
    }
    return {
      devices,
      models: Array.from(models.values()).sort((a, b) => a.id.localeCompare(b.id)),
      skills: Array.from(skills.values()).sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
    };
  }

  function setSelectValue(select, value) {
    try {
      select.value = value;
    } catch {
      /* 某些环境（如无浏览器 DOM 实现）没有 value setter，回退到 option.selected */
    }
    if (select.value !== value) {
      for (const option of Array.from(select.options)) option.selected = option.value === value;
    }
  }

  function renderComposerOptions() {
    const agg = aggregateCapabilities();
    const sig = JSON.stringify({
      devices: agg.devices.map((d) => [d.id, d.name, d.nickname, d.status]),
      models: agg.models.map((m) => m.id),
      skills: agg.skills.map((s) => s.id),
      selected: Array.from(state.selectedSkills),
    });
    if (sig === state.sigs.composer) {
      updateComposerTarget();
      return;
    }
    state.sigs.composer = sig;

    const modelSelect = $('#req-model');
    const prevModel = modelSelect.value;
    modelSelect.replaceChildren(el('option', { value: '', text: '不限模型' }));
    for (const model of agg.models) {
      modelSelect.appendChild(el('option', {
        value: model.id,
        text: `${model.id}${model.count > 1 ? ` · ${model.count} 台` : ''}`,
      }));
    }
    if (Array.from(modelSelect.options).some((o) => o.value === prevModel)) setSelectValue(modelSelect, prevModel);
    const deviceSelect = $('#target-device');
    const prevDevice = deviceSelect.value;
    deviceSelect.replaceChildren(el('option', { value: '', text: '自动路由（全部在线）' }));
    for (const device of agg.devices) {
      deviceSelect.appendChild(el('option', {
        value: device.id,
        text: `${deviceDisplayName(device)} · ${DEVICE_STATUS[device.status] || '在线'}`,
      }));
    }
    if (Array.from(deviceSelect.options).some((o) => o.value === prevDevice)) setSelectValue(deviceSelect, prevDevice);

    const availableSkillIds = new Set(agg.skills.map((s) => s.id));
    for (const id of Array.from(state.selectedSkills)) {
      if (!availableSkillIds.has(id)) state.selectedSkills.delete(id);
    }

    const skillSelect = $('#skill-select');
    if (skillSelect) {
      const selected = Array.from(state.selectedSkills).filter((id) => availableSkillIds.has(id));
      const jq = window.jQuery;
      const $select = jq && jq.fn && jq.fn.select2 ? jq(skillSelect) : null;
      if ($select && $select.hasClass('select2-hidden-accessible')) $select.select2('destroy');
      skillSelect.replaceChildren(...agg.skills.map((skill) => el('option', {
        value: skill.id,
        text: `${skill.name || skill.id}${skill.count > 1 ? ` · ${skill.count} 台` : ''}`,
      })));
      skillSelect.disabled = agg.skills.length === 0;
      if (!skillSelect.dataset.bound) {
        skillSelect.addEventListener('change', () => {
          state.selectedSkills = new Set(Array.from(skillSelect.selectedOptions).map((option) => option.value));
          state.sigs.composer = '';
          updateComposerTarget();
        });
        skillSelect.dataset.bound = '1';
      }
      if ($select) {
        $select.select2({
          width: '100%',
          placeholder: tx('选择技能（可多选）'),
          allowClear: true,
          closeOnSelect: false,
          language: { noResults: () => tx('没有可用技能') },
        });
        $select.val(selected).trigger('change.select2');
      } else {
        for (const option of Array.from(skillSelect.options)) option.selected = selected.includes(option.value);
      }
    }
    setText('#skills-hint', agg.skills.length ? `可多选 · ${agg.skills.length} 项可用` : '暂无可选技能');
    updateComposerTarget();
  }

  function localMatch(device, requirements) {
    if (requirements.deviceId && device.id !== requirements.deviceId) return false;
    if (requirements.model) {
      const ok = modelsOf(device).some((m) => m.id === requirements.model);
      if (!ok) return false;
    }
    if (requirements.skills && requirements.skills.length) {
      const have = new Set(skillsOf(device).map((s) => s.id));
      if (!requirements.skills.every((s) => have.has(s))) return false;
    }
    const load = loadOf(device);
    if (load.running >= load.max) return false;
    return true;
  }

  function updateComposerTarget() {
    const node = $('#composer-target');
    if (!node) return;
    const model = $('#req-model').value;
    const deviceId = $('#target-device').value;
    const skills = Array.from(state.selectedSkills);
    const agg = aggregateCapabilities();
    node.replaceChildren();
    if (deviceId) {
      const device = state.devices.get(deviceId);
      node.appendChild(document.createTextNode(tx('指定设备：')));
      node.appendChild(el('b', { text: device ? deviceDisplayName(device) : deviceId }));
      if (device && !device.online) node.appendChild(document.createTextNode(tx('（当前离线，任务将排队）')));
      return;
    }
    const matched = agg.devices.filter((d) => localMatch(d, { model, skills, deviceId: '' }));
    if (!state.connected) {
      node.textContent = tx('等待连接 Hub…');
      return;
    }
    if (!agg.devices.length) {
      node.textContent = tx('暂无在线设备，发送后将排队等待上线');
      return;
    }
    node.appendChild(document.createTextNode(tx(model || skills.length ? '匹配要求的在线设备：' : '自动路由：')));
    node.appendChild(el('b', { text: `${matched.length} / ${agg.devices.length} 台` }));
    if (!matched.length) node.appendChild(document.createTextNode(tx(' · 将排队等待设备')));
  }

  function setSendBusy(busy) {
    state.sendBusy = busy;
    const btn = $('#send-btn');
    btn.disabled = busy;
    const label = $('span', btn);
    if (label) label.textContent = tx(busy ? '发送中…' : '发送指令');
  }

  function localizeRouteReason(reason) {
    const s = str(reason).trim();
    if (!s) return '不满足要求';
    if (s === 'disabled') return '设备已禁用';
    if (s === 'offline') return '设备离线';
    const capacity = /^at capacity \((\d+)\/(\d+)\)$/.exec(s);
    if (capacity) return `并发已满（${capacity[1]}/${capacity[2]}）`;
    const missing = /^missing (.+)$/.exec(s);
    if (missing) return `缺少 ${missing[1]}`;
    return s;
  }

  function localizeRouteSummary(reason) {
    const s = str(reason).trim();
    if (!s) return '';
    const matched = /^matched (\d+)[^;]*;\s*picked (\S+) \(score (\d+)\)/.exec(s);
    if (matched) {
      return `在 ${matched[1]} 台候选设备中选中 ${deviceName(matched[2])}（${matched[3]} 分）`;
    }
    const noMatch = /^no (?:matching|available) device[^:]*:?\s*(.*)$/.exec(s);
    if (noMatch) {
      return noMatch[1] ? `无匹配设备：${localizeRouteReason(noMatch[1])}` : '无匹配设备';
    }
    return s;
  }

  function setRouteResult(task) {
    const box = $('#route-result');
    if (!box) return;
    state.routeTask = task || null;
    if (!task) {
      box.hidden = true;
      box.replaceChildren();
      return;
    }
    const assignedId = task.assignedDeviceId;
    const queued = !assignedId;
    box.hidden = false;
    box.dataset.kind = queued ? 'queued' : 'ok';
    box.replaceChildren();

    const head = el('div', { className: 'route-head' },
      icon(queued ? 'clock' : 'check'),
      el('span', {
        text: queued
          ? '已排队，等待设备上线'
          : `已路由到 ${task.assignedDeviceName || deviceName(assignedId)}`,
      }),
    );
    box.appendChild(head);

    const route = task.route || {};
    if (route.reason) box.appendChild(el('p', { className: 'route-reason', text: localizeRouteSummary(route.reason), title: route.reason }));
    if (queued && !route.reason) {
      box.appendChild(el('p', { className: 'route-reason', text: '当前没有满足要求的在线设备，任务已进入队列；设备上线或能力变化后会自动重新路由。' }));
    }

    const candidates = arr(route.candidates);
    if (candidates.length) {
      box.appendChild(el('div', { className: 'route-rule' }));
      const maxScore = Math.max(...candidates.map((c) => num(c.score, 0)), 1);
      const list = el('ul', { className: 'route-list' });
      for (const candidate of candidates.slice(0, 5)) {
        const score = num(candidate.score, 0);
        const item = el('li', { className: 'route-item' },
          el('span', { className: 'rname', text: candidate.deviceName || deviceName(candidate.deviceId), title: candidate.deviceId || '' }),
          el('span', { className: 'rscore', text: `${Math.round(score)} 分` }),
          el('span', { className: 'rbar' }, el('span', { style: { width: `${Math.max(3, Math.min(100, (score / Math.max(maxScore, 118)) * 100))}%` } })),
        );
        const matched = arr(candidate.matched);
        if (matched.length) item.title = `匹配：${matched.join('、')}`;
        list.appendChild(item);
      }
      box.appendChild(list);
    }

    const excluded = arr(route.excluded);
    if (excluded.length) {
      box.appendChild(el('div', { className: 'route-rule' }));
      const list = el('ul', { className: 'route-list' });
      for (const item of excluded.slice(0, 10)) {
        list.appendChild(el('li', { className: 'route-item is-excluded' },
          el('span', { className: 'rname', text: item.deviceName || deviceName(item.deviceId), title: item.deviceId || '' }),
          el('span', { className: 'rreason', text: localizeRouteReason(item.reason), title: item.reason || '' }),
        ));
      }
      box.appendChild(list);
    }
    if (queued) {
      box.appendChild(el('p', { className: 'route-known', text: '提示：设备恢复在线后，Hub 会自动重新路由该任务。' }));
    }
  }

  async function sendTask(event) {
    if (event) event.preventDefault();
    if (state.sendBusy || !state.connected) return;
    const textarea = $('#instruction');
    const instruction = textarea.value.trim();
    if (!instruction) {
      toast('请先输入指令内容', 'warn');
      textarea.focus();
      return;
    }
    const requirements = {};
    const model = $('#req-model').value;
    const deviceId = $('#target-device').value;
    const projectInput = $('#req-project');
    const project = projectInput ? projectInput.value.trim() : '';
    const skills = Array.from(state.selectedSkills);
    if (model) requirements.model = model;
    if (skills.length) requirements.skills = skills;
    if (deviceId) requirements.deviceId = deviceId;
    if (project) requirements.project = project;

    const payload = {
      instruction,
      requirements,
      priority: num(Number($('#priority').value), 5),
      timeoutSec: num(Number($('#timeout').value), 300),
      maxAttempts: 2,
    };
    const attachments = attachmentPayload();
    if (attachments.length) payload.attachments = attachments;
    setSendBusy(true);
    try {
      const endpoint = state.followUpTaskId
        ? `/api/tasks/${encodeURIComponent(state.followUpTaskId)}/follow-up`
        : '/api/tasks';
      const res = await api(endpoint, { method: 'POST', body: payload, timeout: 20000 });
      const task = res && res.task;
      if (!task) throw new Error('Hub 未返回任务信息');
      const wasFollowUp = Boolean(state.followUpTaskId);
      upsertTask(task);
      state.sigs.stats = '';
      state.sigs.tasks = '';
      renderStats();
      renderTasks();
      setRouteResult(task);
      textarea.value = '';
      if (projectInput) projectInput.value = '';
      cancelFollowUp();
      clearPendingAttachments();
      updateComposerTarget();
      const assigned = !!task.assignedDeviceId;
      const prefix = wasFollowUp ? '已创建下一步任务' : '';
      toast(`${prefix}${prefix ? '，' : ''}${assigned ? `已分配给 ${task.assignedDeviceName || deviceName(task.assignedDeviceId)}` : '已排队，等待设备上线'}`, assigned ? 'success' : 'warn');
      const routeBox = $('#route-result');
      if (routeBox) routeBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      scheduleSnapshot(400);
      renderStats();
    } catch (err) {
      if (err.status === 401) return handleAuthLost(err.message);
      toast(err.message || '发送失败', 'error');
    } finally {
      setSendBusy(false);
    }
  }

  /* ==================================================================
   * 任务列表
   * ================================================================== */
  /** 回收站任务：snapshot 里保留，但常规筛选、统计与筛选计数都排除。 */
  function isTrashed(task) {
    return Boolean(task && (task.trashed || task.trashedAt));
  }

  function isRootTask(task) {
    return Boolean(task) && !task.parentTaskId && !task.replyToTaskId;
  }

  /** 垃圾桶里的根任务（计数与列表都是根任务，线程/子任务随根任务一起回收）。 */
  function trashRoots() {
    return state.tasks.filter((task) => isRootTask(task) && isTrashed(task));
  }

  function filteredTasks() {
    const filter = state.taskFilter;
    const roots = state.tasks.filter((task) => !task.parentTaskId && !task.replyToTaskId);
    const groupOf = (root) => state.tasks.filter(
      (task) => (task.threadId || task.id) === (root.threadId || root.id),
    );
    return roots.filter((root) => {
      const group = groupOf(root);
      if (filter === 'trash') return group.some((task) => isTrashed(task));
      const live = group.filter((task) => !isTrashed(task));
      if (filter === 'archived') return live.some((task) => task.archived);
      if (filter === 'all') return live.length > 0;
      if (filter === 'active') return live.some((task) => ACTIVE_STATUS.has(normStatus(task.status)));
      if (filter === 'completed') return live.some((task) => normStatus(task.status) === 'completed');
      if (filter === 'failed') return live.some((task) => ['failed', 'timeout', 'cancelled'].includes(normStatus(task.status)));
      return true;
    });
  }

  function renderFilterCounts() {
    const activeTasks = state.tasks.filter((task) => !isTrashed(task) && !task.archived);
    const counts = {
      all: activeTasks.length,
      active: activeTasks.filter((t) => ACTIVE_STATUS.has(normStatus(t.status))).length,
      completed: activeTasks.filter((t) => normStatus(t.status) === 'completed').length,
      failed: activeTasks.filter((t) => ['failed', 'timeout', 'cancelled'].includes(normStatus(t.status))).length,
      trash: trashRoots().length,
      archived: state.tasks.filter((t) => !isTrashed(t) && t.archived).length,
    };
    $$('#task-filters .filter-chip').forEach((btn) => {
      const key = btn.dataset.filter;
      let count = $('.count', btn);
      if (!count) {
        count = el('span', { className: 'count' });
        btn.appendChild(count);
      }
      count.textContent = String(counts[key] || 0);
      btn.classList.toggle('is-active', key === state.taskFilter);
    });
  }

  function durationView(task) {
    if (Number.isFinite(task.durationMs)) return { text: fmtDuration(task.durationMs) };
    const start = parseIso(task.startedAt || task.createdAt);
    const end = parseIso(task.finishedAt);
    if (start !== null && end !== null) return { text: fmtDuration(Math.max(0, end - start)) };
    if (start !== null && ['running', 'assigned'].includes(normStatus(task.status))) {
      return {
        text: fmtDuration(Date.now() - start),
        live: new Date(start).toISOString(),
      };
    }
    return null;
  }

  function timeline(events) {
    const wrap = el('div', { className: 'timeline' });
    const sorted = arr(events)
      .filter((e) => e && typeof e === 'object')
      .slice()
      .sort((a, b) => (parseIso(a.at) || 0) - (parseIso(b.at) || 0));
    if (!sorted.length) {
      wrap.appendChild(el('div', { className: 'detail-empty', text: '暂无事件记录' }));
      return wrap;
    }
    for (const event of sorted) {
      const type = str(event.type) || 'created';
      const item = el('div', { className: 'timeline-item', dataset: { type: EVENT_LABEL[type] ? type : 'created' } });
      item.appendChild(el('span', { className: 'timeline-dot' }));
      const body = el('div', { className: 'timeline-body' });
      body.appendChild(el('div', { className: 'timeline-msg', text: event.message || EVENT_LABEL[type] || type }));
      const meta = el('div', { className: 'timeline-meta' },
        el('span', { text: fmtTime(event.at) }),
        el('span', { text: EVENT_LABEL[type] || type }),
      );
      if (Number.isFinite(event.percent)) meta.appendChild(el('span', { className: 'pct', text: `${Math.round(event.percent)}%` }));
      body.appendChild(meta);
      item.appendChild(body);
      wrap.appendChild(item);
    }
    return wrap;
  }

  function childTasksOf(task) {
    const ids = Array.isArray(task.childTaskIds) ? task.childTaskIds : [];
    return ids.map((id) => state.tasks.find((item) => item.id === id)).filter(Boolean);
  }

  function threadTasksOf(task) {
    const threadId = task.threadId || task.id;
    return state.tasks
      .filter((item) => (item.threadId || item.id) === threadId && item.id !== task.id && item.replyToTaskId)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  function threadList(task) {
    const steps = threadTasksOf(task);
    if (!steps.length) return null;
    return el('div', { className: 'thread-wrap' },
      el('div', { className: 'thread-head' }, icon('activity'), el('span', { text: `任务线程 · ${steps.length + 1} 步` })),
      el('div', { className: 'subtask-list' }, ...steps.map(subtaskRow)),
    );
  }

  /** 子任务在第几步、属于哪个并行组、依赖哪些步骤（Agnes 执行计划）。 */
  function subtaskPlanBits(child) {
    const bits = [];
    if (Number.isFinite(child.planStep) && child.planStep > 0) bits.push(`第 ${child.planStep} 步`);
    if (child.planGroup) bits.push(String(child.planGroup));
    const deps = arr(child.planDependsOn);
    if (deps.length) bits.push(`依赖第 ${deps.map((i) => i + 1).join('、')} 步`);
    return bits;
  }

  /** 计划元信息按片段渲染成独立文本节点，英文模式下每段都能被翻译。 */
  function planMetaNode(child, className) {
    const bits = subtaskPlanBits(child);
    if (!bits.length) return null;
    return el('span', { className },
      ...bits.flatMap((text, i) => (i
        ? [el('span', { text: ' · ' }), el('span', { text })]
        : [el('span', { text })])));
  }

  function subtaskRow(child) {
    const status = normStatus(child.status);
    const planBits = subtaskPlanBits(child);
    // 依赖还没完成的子任务会停在排队里，提示“等待前置步骤”比“等待设备”更准确。
    const waitingDeps = status === 'queued' && arr(child.planDependsOnTaskIds).length > 0;
    const deviceText = child.assignedDeviceName || (waitingDeps ? '等待前置步骤' : ACTIVE_STATUS.has(status) ? '等待设备' : '');
    const routeReason = child.route && child.route.reason ? String(child.route.reason) : '';
    const row = el('button', {
      type: 'button', className: 'subtask-row', dataset: { action: 'open-child', taskId: child.id },
      attrs: {
        'aria-label': `子任务${planBits.length ? `（${planBits.join(' · ')}）` : ''} ${TASK_STATUS[status].label}：${shorten(child.instruction, 36)}`,
        title: routeReason,
      },
    },
      statusBadge(status),
      el('span', { className: 'subtask-title', text: shorten(child.instruction, 70) }),
      planMetaNode(child, 'subtask-plan'),
      el('span', { className: 'subtask-meta', text: deviceText }),
    );
    return row;
  }

  function subtaskList(parent) {
    const children = childTasksOf(parent);
    if (!children.length) return null;
    const done = children.filter((item) => ['completed', 'failed', 'timeout', 'cancelled'].includes(normStatus(item.status))).length;
    const strategy = planStrategyLabel(parent.plan);
    const blocked = Boolean(parent.progress && parent.progress.blocked);
    const wrap = el('div', { className: 'subtask-wrap' },
      el('div', { className: 'subtask-head' },
        icon('queue'),
        el('span', { text: `Agnes 拆分的子任务 ${done}/${children.length}` }),
        strategy
          ? el('span', { className: 'subtask-strategy' },
            el('span', { text: '（' }),
            el('span', { text: strategy }),
            el('span', { text: '）' }))
          : null,
        blocked ? el('span', { className: 'strip-bad', text: '卡点' }) : null,
      ),
      el('div', { className: 'subtask-list' }, ...children.map(subtaskRow)),
    );
    return wrap;
  }

  function childRecoveryStats(children) {
    const finished = children.filter((item) => ['completed', 'failed', 'timeout', 'cancelled'].includes(normStatus(item.status)));
    const failed = finished.filter((item) => normStatus(item.status) !== 'completed');
    return { finished, failed, done: finished.length - failed.length };
  }

  /** 可重试/可继续的失败子任务（不含已归档/回收站中的）。 */
  function retryableChildrenOf(task) {
    if (!task || !task.isPlan) return [];
    return childTasksOf(task)
      .filter((item) => !item.archived && !isTrashed(item))
      .filter((item) => RETRYABLE_STATUS.has(normStatus(item.status)));
  }

  /**
   * 卡片收起时（手机端默认）仍保持可见的「恢复条」：
   * 子任务进度 + 失败子任务重试 + 本任务重试/继续，避免收起后找不到恢复入口。
   */
  function taskRecoveryStrip(task, status) {
    if (task.archived || isTrashed(task)) return null;
    const children = task.isPlan ? childTasksOf(task).filter((item) => !item.archived && !isTrashed(item)) : [];
    const stats = childRecoveryStats(children);
    const canRetry = RETRYABLE_STATUS.has(status);
    const canContinue = !ACTIVE_STATUS.has(status);
    if (!children.length && !canRetry && !canContinue) return null;
    const wrap = el('div', { className: 'task-strip' });
    if (children.length) {
      wrap.appendChild(el('button', {
        type: 'button',
        className: 'strip-btn strip-btn-main',
        dataset: { action: 'open' },
        attrs: { 'aria-label': '查看子任务' },
      },
        icon('queue'),
        el('span', { text: `子任务 ${stats.done}/${children.length}` }),
        stats.failed.length ? el('span', { className: 'strip-bad', text: `${stats.failed.length} 失败` }) : null,
        task.progress && task.progress.blocked ? el('span', { className: 'strip-bad', text: '卡点' }) : null,
      ));
    }
    const actions = el('div', { className: 'strip-actions' });
    if (stats.failed.length) {
      actions.appendChild(el('button', {
        type: 'button', className: 'strip-btn is-warn', dataset: { action: 'retry-failed-children' },
      }, icon('refresh'), el('span', { text: '重试失败子任务' })));
    }
    if (canRetry) {
      actions.appendChild(el('button', {
        type: 'button', className: 'strip-btn', dataset: { action: 'retry' },
      }, icon('refresh'), el('span', { text: '重试' })));
    }
    if (canContinue) {
      actions.appendChild(el('button', {
        type: 'button', className: 'strip-btn is-primary', dataset: { action: 'follow-up' },
      }, icon('send'), el('span', { text: '继续任务' })));
    }
    if (actions.childElementCount) wrap.appendChild(actions);
    return wrap.childElementCount ? wrap : null;
  }

  /** 任务详情里的子任务行：可打开详情、单条重试、从该子任务继续。 */
  function childTaskDetailRow(child, parentId) {
    const status = normStatus(child.status);
    const duration = durationView(child);
    const row = el('div', { className: 'subtask-detail', dataset: { status } });
    row.appendChild(el('div', { className: 'subtask-detail-top' },
      statusBadge(status),
      el('button', {
        type: 'button', className: 'subtask-detail-title',
        attrs: { 'aria-label': '打开子任务详情' },
        onclick: () => openTaskDrawer(child.id),
      }, el('span', { text: shorten(child.instruction || '（无指令内容）', 140) })),
    ));
    const meta = el('div', { className: 'subtask-detail-meta' });
    const planMeta = planMetaNode(child, '');
    if (planMeta) meta.appendChild(planMeta);
    if (child.assignedDeviceName) meta.appendChild(el('span', { text: child.assignedDeviceName }));
    if (duration) meta.appendChild(el('span', { text: duration.text }));
    if (child.error && status !== 'completed') {
      meta.appendChild(el('span', { className: 'is-error', text: shorten(child.error, 70), title: child.error }));
    }
    if (meta.childElementCount) row.appendChild(meta);
    const actions = el('div', { className: 'subtask-detail-actions' },
      el('button', { type: 'button', className: 'strip-btn', onclick: () => openTaskDrawer(child.id) },
        el('span', { text: '详情' })));
    if (RETRYABLE_STATUS.has(status)) {
      actions.appendChild(el('button', {
        type: 'button', className: 'strip-btn is-warn',
        onclick: async () => {
          await retryTask(child.id);
          refreshTaskDrawer(parentId);
        },
      }, icon('refresh'), el('span', { text: '重试' })));
    } else if (!ACTIVE_STATUS.has(status)) {
      actions.appendChild(el('button', {
        type: 'button', className: 'strip-btn is-primary',
        onclick: () => { hideDrawer(); startFollowUp(child.id); },
      }, icon('send'), el('span', { text: '从此步继续' })));
    }
    row.appendChild(actions);
    return row;
  }

  /** 详情抽屉中的「子任务」区块（含一键重试失败子任务）。 */
  function childTasksSection(parent) {
    const children = childTasksOf(parent);
    if (!children.length) return null;
    const stats = childRecoveryStats(children);
    const retryableCount = children.filter((item) => !item.archived && !isTrashed(item) && RETRYABLE_STATUS.has(normStatus(item.status))).length;
    return el('section', { className: 'detail-section' },
      el('div', { className: 'detail-section-head' },
        el('h3', { text: '子任务' }),
        el('span', { className: 'count', text: `${stats.done}/${children.length} 完成${stats.failed.length ? ` · ${stats.failed.length} 失败` : ''}` }),
        retryableCount
          ? el('button', {
            type: 'button', className: 'strip-btn is-warn', onclick: () => retryFailedChildren(parent.id),
          }, icon('refresh'), el('span', { text: '重试失败子任务' }))
          : null,
      ),
      el('div', { className: 'subtask-detail-list' }, ...children.map((item) => childTaskDetailRow(item, parent.id))),
    );
  }

  /** 详情抽屉中的「任务线程」区块（继续任务的后续步骤）。 */
  function threadStepsSection(task) {
    const steps = threadTasksOf(task);
    if (!steps.length) return null;
    const baseStep = Number.isFinite(task.threadStep) ? task.threadStep : 1;
    return el('section', { className: 'detail-section' },
      el('div', { className: 'detail-section-head' },
        el('h3', { text: '任务线程' }),
        el('span', { className: 'count', text: `${steps.length} 个后续步骤` }),
      ),
      el('div', { className: 'subtask-detail-list' }, ...steps.map((step, index) => {
        const status = normStatus(step.status);
        const stepNo = Number.isFinite(step.threadStep) ? step.threadStep : baseStep + index + 1;
        const actions = el('div', { className: 'subtask-detail-actions' },
          el('button', { type: 'button', className: 'strip-btn', onclick: () => openTaskDrawer(step.id) },
            el('span', { text: '详情' })));
        if (!ACTIVE_STATUS.has(status)) {
          actions.appendChild(el('button', {
            type: 'button', className: 'strip-btn is-primary',
            onclick: () => { hideDrawer(); startFollowUp(step.id); },
          }, icon('send'), el('span', { text: '从此步继续' })));
        }
        return el('div', { className: 'subtask-detail', dataset: { status } },
          el('div', { className: 'subtask-detail-top' },
            statusBadge(status),
            el('span', { className: 'subtask-detail-step', text: `第 ${stepNo} 步` }),
            el('button', {
              type: 'button', className: 'subtask-detail-title',
              attrs: { 'aria-label': '打开该步骤详情' },
              onclick: () => openTaskDrawer(step.id),
            }, el('span', { text: shorten(step.instruction || '（无指令内容）', 140) })),
          ),
          actions);
      })),
    );
  }

  function taskCard(task) {
    const status = normStatus(task.status);
    const card = el('article', {
      className: 'task-card' + (state.expandedOutput.has(task.id) ? ' output-open' : '') + (state.tasksCollapsed ? ' is-collapsed' : '') + (task.archived ? ' is-archived' : '') + (isTrashed(task) ? ' is-trashed' : ''),
      dataset: { id: task.id, status },
      role: 'button',
      tabIndex: 0,
      attrs: { 'aria-label': `任务${TASK_STATUS[status].label}：${shorten(task.instruction, 40)}` },
    });

    const duration = durationView(task);
    const top = el('div', { className: 'task-top' },
      statusBadge(status),
      task.assignedDeviceId || task.assignedDeviceName
        ? el('span', { className: 'task-device', title: '执行设备' }, icon('devices'), el('span', { text: task.assignedDeviceName || deviceName(task.assignedDeviceId) }))
        : el('span', { className: 'task-device' }, icon('queue'), el('span', { text: '等待设备' })),
      el('span', { className: 'task-top-spacer' }),
      relNode(task.createdAt),
      duration
        ? el('span', {
          className: 'task-duration',
          dataset: duration.live ? { liveDuration: duration.live } : undefined,
          text: duration.text,
        })
        : null,
    );
    card.appendChild(top);
    card.appendChild(el('p', { className: 'task-instruction', text: task.instruction || '（无指令内容）' }));
    card.appendChild(el('div', { className: 'task-collapsed-meta', text: `创建于 ${fmtDateTime(task.createdAt)}` }));
    // 收起状态下仍保留恢复入口（手机端默认收起，避免看不到子任务 / 无法继续）。
    if (state.tasksCollapsed) {
      const strip = taskRecoveryStrip(task, status);
      if (strip) card.appendChild(strip);
    }
    const waitingQuestion = status === 'waiting' && task.progress && task.progress.question ? String(task.progress.question) : '';
    if (waitingQuestion) {
      card.appendChild(el('div', { className: 'task-question' },
        el('strong', { text: 'Mika 需要你的回答' }),
        el('div', { className: 'task-question-text', text: waitingQuestion }),
      ));
    }
    const taskAttachments = Array.isArray(task.attachments) ? task.attachments : [];
    if (taskAttachments.length) {
      card.appendChild(el('div', { className: 'task-attachments' },
        ...taskAttachments.map((file) => el('span', { className: 'task-attachment', title: file.name },
          icon('link'),
          el('span', { className: 'name', text: file.name }),
        )),
      ));
    }
    if (task.isPlan) {
      const children = subtaskList(task);
      if (children) card.appendChild(children);
    }
    const thread = threadList(task);
    if (thread) card.appendChild(thread);

    const progress = activeProgress(task, status);
    if (progress) card.appendChild(progress);

    const output = outputOf(task);
    if (output) {
      const rawOutput = output.markdown || output.text || '';
      const structured = looksLikeMarkdown(rawOutput);
      const showRaw = !structured || state.rawOutputs.has(task.id);
      const outWrap = el('div', { className: 'task-output' });
      outWrap.appendChild(showRaw
        ? el('pre', { className: 'task-output-raw', text: rawOutput })
        : renderMarkdown(rawOutput));
      card.appendChild(outWrap);
      const outputActions = [el('button', {
        type: 'button',
        className: 'link-btn',
        onclick: (event) => {
          event.stopPropagation();
          copyText(rawOutput, 'Markdown 已复制');
        },
      }, icon('copy'), el('span', { text: '复制 Markdown' }))];
      if (structured) {
        outputActions.push(el('button', {
          type: 'button',
          className: 'link-btn',
          dataset: { action: 'toggle-output-mode' },
          onclick: (event) => {
            event.stopPropagation();
            if (state.rawOutputs.has(task.id)) state.rawOutputs.delete(task.id);
            else state.rawOutputs.add(task.id);
            state.sigs.tasks = '';
            renderTasks();
          },
        }, el('span', { text: showRaw ? '渲染' : '原文' })));
      }
      card.appendChild(el('div', { className: 'task-output-actions' }, ...outputActions));
      if (rawOutput.length > 260) {
        card.appendChild(el('button', {
          type: 'button',
          className: 'link-btn',
          dataset: { action: 'toggle-output' },
          text: state.expandedOutput.has(task.id) ? '收起全文' : '查看全文',
        }));
      }
    }

    if (task.error && status !== 'completed') {
      card.appendChild(el('div', { className: 'task-error' }, icon('alert'), el('span', { text: task.error })));
    }

    const events = arr(task.events);
    const actions = el('div', { className: 'task-actions' });
    if (events.length) {
      actions.appendChild(el('button', {
        type: 'button',
        className: 'link-btn',
        dataset: { action: 'toggle-events' },
        attrs: { 'aria-expanded': state.expandedEvents.has(task.id) ? 'true' : 'false' },
      }, icon('activity'), el('span', { text: state.expandedEvents.has(task.id) ? '收起事件' : `事件 ${events.length}` })));
    }
    actions.appendChild(el('button', { type: 'button', className: 'link-btn', dataset: { action: 'open' } },
      icon('chevron'), el('span', { text: '任务详情' })));
    actions.appendChild(el('span', { className: 'spacer' }));
    if (isTrashed(task)) {
      actions.appendChild(el('button', { type: 'button', className: 'link-btn', dataset: { action: 'restore' } },
        icon('refresh'), el('span', { text: tr('action.restore') })));
      actions.appendChild(el('button', { type: 'button', className: 'link-btn is-danger', dataset: { action: 'purge' } },
        icon('trash'), el('span', { text: tr('action.purge') })));
    } else {
      if (ACTIVE_STATUS.has(status)) {
        actions.appendChild(el('button', { type: 'button', className: 'link-btn', dataset: { action: 'cancel' } },
          icon('x'), el('span', { text: '取消' })));
      }
      if (RETRYABLE_STATUS.has(status)) {
        actions.appendChild(el('button', { type: 'button', className: 'link-btn', dataset: { action: 'complete' } },
          icon('check'), el('span', { text: '标记成功' })));
        actions.appendChild(el('button', { type: 'button', className: 'link-btn', dataset: { action: 'retry' } },
          icon('refresh'), el('span', { text: '重试' })));
      }
      if (!ACTIVE_STATUS.has(status)) {
        actions.appendChild(el('button', { type: 'button', className: 'link-btn', dataset: { action: 'follow-up' } },
          icon('send'), el('span', { text: '继续此任务' })));
      }
      if (status === 'waiting') {
        actions.appendChild(el('button', { type: 'button', className: 'link-btn', dataset: { action: 'answer' } },
          icon('send'), el('span', { text: '回答 Mika' })));
      }
      actions.appendChild(el('button', { type: 'button', className: 'link-btn', dataset: { action: 'copy-instruction' } },
        icon('copy'), el('span', { text: '复制指令' })));
      actions.appendChild(el('button', { type: 'button', className: 'link-btn', dataset: { action: 'edit-instruction' } },
        icon('edit'), el('span', { text: '编辑重发' })));
      if (TRASHABLE_STATUS.has(status)) {
        actions.appendChild(el('button', { type: 'button', className: 'link-btn', dataset: { action: 'trash' } },
          icon('trash'), el('span', { text: tr('action.trash') })));
      }
      actions.appendChild(el('button', { type: 'button', className: 'link-btn', dataset: { action: task.archived ? 'unarchive' : 'archive' } },
        el('span', { text: task.archived ? '取消归档' : '归档' })));
      actions.appendChild(el('button', { type: 'button', className: 'link-btn', dataset: { action: 'delete' } },
        el('span', { text: '删除' })));
    }
    actions.appendChild(el('span', { className: 'task-id', text: task.id }));
    card.appendChild(actions);

    if (state.expandedEvents.has(task.id) && events.length) {
      const wrap = el('div', { className: 'task-events' }, timeline(events));
      card.appendChild(wrap);
    }
    return card;
  }

  function activeProgress(task, status) {
    if (status === 'queued') {
      return el('div', { className: 'task-progress' },
        el('div', { className: 'bar', dataset: { tone: 'queued' } }, el('span', { style: { width: '8%' } })),
        el('span', { className: 'task-progress-text', text: '等待设备上线' }),
      );
    }
    if (!['assigned', 'running'].includes(status)) return null;
    const progress = taskProgressOf(task);
    const percent = progress ? progress.percent : null;
    const message = progress && progress.message ? String(progress.message) : '';
    const bar = el('div', { className: 'bar', dataset: { tone: status === 'assigned' ? 'queued' : 'load' } },
      percent === null
        ? el('span', { className: 'is-indeterminate', style: { width: '35%' } })
        : el('span', { style: { width: `${Math.max(2, percent)}%` } }),
    );
    const percentText = percent === null ? '' : ` · ${Math.round(percent)}%`;
    const label = message
      ? `${shorten(message, 42)}${percentText}`
      : percent === null
        ? (status === 'assigned' ? '等待设备接受…' : '处理中…')
        : `${Math.round(percent)}%`;
    return el('div', { className: 'task-progress', title: message || '' },
      bar,
      el('span', { className: 'task-progress-text', text: label }),
    );
  }

  /** 任务列表上方的「可恢复失败任务」提示，避免手机端停在「进行中」时找不到失败任务。 */
  function renderRecoveryHint() {
    const host = $('#task-recovery-hint');
    if (!host) return;
    const failedRoots = state.tasks.filter(
      (item) => isRootTask(item) && !isTrashed(item) && !item.archived && RETRYABLE_STATUS.has(normStatus(item.status)),
    );
    const inFailedView = state.taskFilter === 'failed';
    const hidden = !failedRoots.length || state.taskFilter === 'archived' || state.taskFilter === 'trash';
    host.hidden = hidden;
    if (hidden) {
      host.replaceChildren();
      return;
    }
    if (inFailedView) {
      const trashAll = el('button', { type: 'button', className: 'btn btn-ghost btn-sm trash-bulk-btn' },
        icon('trash'), el('span', { text: tr('trash.bulkTrash') }));
      trashAll.addEventListener('click', () => void trashAllFailedTasks());
      host.replaceChildren(
        icon('alert'),
        el('span', { className: 'recovery-hint-text', text: `${failedRoots.length} 个失败任务` }),
        trashAll,
      );
      return;
    }
    const jump = el('button', { type: 'button', className: 'btn btn-ghost btn-sm' },
      icon('alert'), el('span', { text: '查看失败任务' }));
    jump.addEventListener('click', () => {
      state.taskFilter = 'failed';
      state.sigs.tasks = '';
      renderTasks();
    });
    host.replaceChildren(
      icon('alert'),
      el('span', { className: 'recovery-hint-text', text: `${failedRoots.length} 个失败任务可重试或继续` }),
      jump,
    );
  }

  function renderTasks() {
    const list = $('#task-list');
    const tasks = filteredTasks();
    const sig = JSON.stringify({
      filter: state.taskFilter,
      collapsed: state.tasksCollapsed,
      expandedEvents: Array.from(state.expandedEvents),
      expandedOutput: Array.from(state.expandedOutput),
      tasks,
    });
    if (sig === state.sigs.tasks && list.childElementCount) {
      renderFilterCounts();
      renderRecoveryHint();
      return;
    }
    state.sigs.tasks = sig;

    list.replaceChildren();
    if (!tasks.length) {
      const messages = {
        all: { icon: 'tasks', title: '还没有任务', desc: '在右侧（手机端「指令」页）输入指令并发送，任务会实时出现在这里。' },
        active: { icon: 'activity', title: '没有进行中的任务', desc: '当前没有排队、已分配或运行中的任务。' },
        completed: { icon: 'check', title: '还没有已完成的任务', desc: '设备执行完任务后会显示在这里。' },
        failed: { icon: 'alert', title: '没有失败的任务', desc: '一切正常。' },
        archived: { icon: 'tasks', title: '没有已归档的任务', desc: '任务卡片上的「归档」会把它移到这里。' },
        trash: { icon: 'trash', title: tr('trash.empty'), desc: tr('trash.emptyDesc') },
      };
      const msg = messages[state.taskFilter] || messages.all;
      list.appendChild(emptyState({ iconName: msg.icon, title: msg.title, desc: msg.desc }));
    } else {
      for (const task of tasks) list.appendChild(taskCard(task));
    }
    const liveTasks = state.tasks.filter((task) => !isTrashed(task));
    setText('#tasks-sub', `${liveTasks.length} 个任务 · 进行中 ${liveTasks.filter((t) => ACTIVE_STATUS.has(normStatus(t.status))).length}`);
    renderFilterCounts();
    renderRecoveryHint();
  }

  /* ==================================================================
   * 长期目标
   * ================================================================== */
  function goalById(id) {
    return state.goals.find((goal) => goal && goal.id === id) || null;
  }

  function goalPlanText(schedule) {
    const value = schedule && typeof schedule === 'object' ? schedule : {};
    if (value.type === 'interval') {
      const minutes = Math.max(1, Math.round(num(value.minutes, 60)));
      if (minutes % 60 === 0) return `每 ${minutes / 60} 小时`;
      return `每 ${minutes} 分钟`;
    }
    if (value.type === 'daily') {
      const time = /^\d{2}:\d{2}$/.test(str(value.time)) ? str(value.time) : '09:00';
      return `每天 ${time}`;
    }
    return '未设置计划';
  }

  function goalStatusBadge(goal) {
    const status = goal && GOAL_STATUS[goal.status] ? goal.status : 'active';
    return el('span', { className: 'status-badge', dataset: { status }, text: GOAL_STATUS[status].label });
  }

  /** 用户数据（标题/描述/建议/错误）不参与界面翻译。 */
  function goalRawText(tag, className, text) {
    const node = el(tag, { className, attrs: { 'data-i18n-skip': '' } });
    node.textContent = text == null ? '' : String(text);
    return node;
  }

  function goalCheckState(goal) {
    const status = str(goal.lastCheckStatus);
    if (!status) return null;
    return el('span', { className: 'goal-check-state', dataset: { status } },
      icon(status === 'failed' || status === 'timeout' ? 'alert' : 'check'),
      el('span', { text: GOAL_CHECK_STATUS[status] || status }),
    );
  }

  function goalPendingAction(action, label, iconName) {
    return el('button', {
      type: 'button',
      className: `goal-compact-btn is-${action}`,
      dataset: { action },
    }, icon(iconName), el('span', { text: label }));
  }

  /**
   * 目标卡片默认收起：只显示昵称（无昵称回退标题）、达成状态、最近进度和下次执行细节。
   * 其它信息都在点击卡片后打开的详情抽屉里。
   */
  function goalCard(goal) {
    const status = goal.status || 'active';
    const nickname = str(goal.nickname);
    const displayName = nickname || str(goal.title) || '未命名目标';
    const achieved = status === 'completed';
    const card = el('article', {
      className: 'goal-card goal-card-compact',
      dataset: { id: goal.id, status },
      attrs: { role: 'button', tabindex: '0', 'aria-label': displayName },
    });

    card.appendChild(el('div', { className: 'goal-compact-head' },
      goalRawText('h3', 'goal-title', displayName),
      el('span', { className: 'goal-achieved', dataset: { achieved: achieved ? 'yes' : 'no' } },
        icon(achieved ? 'check' : 'clock'),
        el('span', { text: achieved ? '已达成' : '未达成' })),
    ));

    const progressText = str(goal.lastSummary) ? shorten(goal.lastSummary, 160) : '还没有进度记录';
    card.appendChild(el('p', { className: 'goal-compact-line' },
      el('span', { className: 'goal-compact-label', text: '最近进度' }),
      goalRawText('span', 'goal-compact-text', progressText),
    ));

    const linkedStats = goal.linkedStats && typeof goal.linkedStats === 'object' ? goal.linkedStats : null;
    if (linkedStats && num(linkedStats.total) > 0) {
      const parts = [`关联任务 ${num(linkedStats.total)}`];
      if (num(linkedStats.planTotal) > 0) parts.push(`计划 ${num(linkedStats.planCompleted)}/${num(linkedStats.planTotal)}`);
      parts.push(`${num(linkedStats.running)} 进行中`);
      card.appendChild(el('p', { className: 'goal-compact-line goal-linked-line' },
        el('span', { className: 'goal-compact-text', text: parts.join(' · ') }),
      ));
    }

    let nextText;
    if (goal.pendingApproval) {
      nextText = `${str(goal.pendingApproval.reason) || '到点跟进'} · 等你同意后才执行`;
    } else if (status === 'active' && goal.nextCheckAt) {
      nextText = `${fmtRelFuture(goal.nextCheckAt)}（${goalPlanText(goal.schedule)}）· 到点先征求你的同意`;
    } else if (status === 'paused') {
      nextText = goal.pausedUntil
        ? `已暂停至 ${fmtDateTime(goal.pausedUntil)} · 到点自动恢复`
        : '已暂停 · 等你手动恢复';
    } else if (status === 'stopped') {
      nextText = '已停止 · 不再自动执行';
    } else if (status === 'completed') {
      nextText = '已达成 · 不再自动执行';
    } else {
      nextText = '未设置计划';
    }
    const nextRow = el('p', {
      className: `goal-compact-line goal-compact-next${goal.pendingApproval ? ' is-pending' : ''}`,
    },
    el('span', { className: 'goal-compact-label', text: '下次执行' }),
    goalRawText('span', 'goal-compact-text', nextText),
    );
    if (goal.pendingApproval) {
      nextRow.appendChild(el('span', { className: 'goal-compact-actions' },
        goalPendingAction('approve', '同意', 'check'),
        goalPendingAction('skip', '跳过这次', 'refresh'),
        goalPendingAction('reject', '否决', 'x'),
      ));
    }
    card.appendChild(nextRow);
    return card;
  }

  function updateGoalsSub(goals) {
    const active = goals.filter((goal) => goal && goal.status === 'active').length;
    setText('#goals-sub', `${active} 个进行中 · 共 ${goals.length} 个目标`);
  }

  function renderGoals() {
    const list = $('#goal-list');
    if (!list) return;
    const goals = state.goals;
    const sig = JSON.stringify({
      goals,
      loaded: state.goalsLoaded,
      loading: state.goalsLoading,
      error: state.goalsError,
      busy: Array.from(goalBusy),
    });
    if (sig === state.sigs.goals && list.childElementCount) {
      updateGoalsSub(goals);
      return;
    }
    state.sigs.goals = sig;

    const newBtn = $('#goal-new');
    if (newBtn) {
      newBtn.disabled = Boolean(state.goalsError && !state.goalsSupported);
      newBtn.title = state.goalsError || '';
    }

    list.replaceChildren();
    if (!goals.length && (state.goalsLoading || !state.goalsLoaded)) {
      list.appendChild(el('p', { className: 'goal-checks-empty', text: '正在载入目标…' }));
      setText('#goals-sub', '正在载入目标…');
      return;
    }
    if (state.goalsError && !goals.length) {
      list.appendChild(emptyState({
        iconName: 'target',
        title: '目标载入失败',
        desc: state.goalsError,
      }));
      const retry = el('button', { type: 'button', className: 'btn btn-ghost btn-sm', dataset: { action: 'reload-goals' } },
        icon('refresh'), el('span', { text: '重试' }));
      list.appendChild(el('div', { style: { textAlign: 'center', padding: '2px 0 8px' } }, retry));
      setText('#goals-sub', '目标载入失败');
      return;
    }
    if (!goals.length) {
      list.appendChild(emptyState({
        iconName: 'target',
        title: '还没有长期目标',
        desc: '创建一个目标，Hub 会按计划定时自动检查进度并给出建议。',
      }));
      setText('#goals-sub', 'Hub 会按计划定时创建任务检查进度并给出建议。');
      return;
    }
    for (const goal of goals) list.appendChild(goalCard(goal));
    updateGoalsSub(goals);
  }

  function nightlyStatusLabel(review) {
    const labels = {
      queued: '排队中',
      assigned: '已派发',
      running: '生成中',
      waiting: '等待输入',
      completed: '已完成',
      failed: '失败',
      timeout: '超时',
      cancelled: '已取消',
    };
    const status = str(review && review.status);
    if (status) return labels[status] || status;
    return review && review.enabled ? `每晚 ${review.time}` : '未启用';
  }

  function renderNightlyReview() {
    const box = $('#nightly-review');
    if (!box) return;
    const review = state.nightlyReview;
    if (!review) {
      box.hidden = true;
      box.replaceChildren();
      return;
    }
    const status = str(review.status);
    const head = el('div', { className: 'nightly-head' },
      el('div', { className: 'nightly-title' },
        icon('spark'),
        el('strong', { text: '每日总结' }),
        el('span', { className: 'nightly-date', text: review.date || '—' }),
      ),
      el('div', { className: 'nightly-actions' },
        el('span', {
          className: 'nightly-status',
          dataset: { status: status || 'idle' },
          text: nightlyStatusLabel(review),
        }),
        el('button', {
          type: 'button',
          className: 'btn btn-ghost btn-sm',
          attrs: { title: '立即创建一次每日总结任务' },
          onclick: () => void runNightlyReview(),
        }, icon('refresh'), el('span', { text: state.nightlyReviewBusy ? '生成中…' : '立即生成' })),
      ),
    );
    const body = el('div', { className: 'nightly-body' });
    if (str(review.summary)) {
      const article = el('article', { className: 'record-markdown nightly-markdown' });
      article.innerHTML = renderMarkdownHtml(review.summary);
      body.appendChild(article);
    } else if (status === 'queued' || status === 'assigned' || status === 'running' || status === 'waiting') {
      body.appendChild(el('p', { className: 'nightly-empty', text: '正在生成今晚的总结，完成后会显示全文…' }));
    } else {
      body.appendChild(el('p', {
        className: 'nightly-empty',
        text: `今晚还没有总结。默认每晚 ${str(review.time) || '22:00'} 自动生成，也可以点「立即生成」。`,
      }));
    }
    box.hidden = false;
    box.replaceChildren(head, body);
  }

  async function runNightlyReview() {
    if (state.nightlyReviewBusy) return;
    const ok = await confirmDialog({
      title: '立即生成每日总结',
      message: '将创建一个「每日总结」任务，由工作机复盘长期目标与今天的任务/子任务进度，并规划明天的工作方向。',
      okText: '生成',
      danger: false,
    });
    if (!ok) return;
    state.nightlyReviewBusy = true;
    renderNightlyReview();
    try {
      const res = await api('/api/nightly-review/run', { method: 'POST', timeout: 20000 });
      if (res && res.review) onNightlyReviewUpdated(res.review);
      if (res && res.task) {
        upsertTask(res.task);
        renderTasks();
        toast('每日总结任务已创建，完成后会显示全文', 'success');
      } else {
        toast('每日总结任务已在执行中，请稍候', 'warn');
      }
    } catch (err) {
      if (err.status === 401) {
        handleAuthLost(err.message);
        return;
      }
      toast(err.message || '生成每日总结失败', 'error');
    } finally {
      state.nightlyReviewBusy = false;
      renderNightlyReview();
    }
  }

  function ensureGoalsLoaded() {
    if (!state.connected || state.goalsLoaded || state.goalsLoading) return;
    void loadGoals();
  }

  async function loadGoals({ silent = false } = {}) {
    if (!state.connected || state.goalsLoading) return;
    state.goalsLoading = true;
    if (!silent) state.goalsError = '';
    state.sigs.goals = '';
    renderGoals();
    try {
      const res = await api('/api/goals', { timeout: 12000 });
      state.goals = arr(res && res.goals).filter((goal) => goal && goal.id);
      state.goalsHubTime = str(res && res.hubTime);
      state.goalsSupported = true;
      state.goalsError = '';
      state.goalsLoaded = true;
    } catch (err) {
      if (err.status === 401) {
        handleAuthLost(err.message);
        return;
      }
      state.goalsError = err.status === 404
        ? '当前 Hub 暂不支持长期目标，请更新后端后再试。'
        : (err.message || '目标载入失败');
      state.goalsLoaded = true;
    } finally {
      state.goalsLoading = false;
      state.sigs.goals = '';
      renderGoals();
    }
  }

  function upsertGoal(goal) {
    if (!goal || !goal.id) return;
    const idx = state.goals.findIndex((item) => item && item.id === goal.id);
    if (idx >= 0) state.goals[idx] = goal;
    else state.goals.unshift(goal);
    state.sigs.goals = '';
  }

  function removeGoal(goalId) {
    const before = state.goals.length;
    state.goals = state.goals.filter((goal) => !goal || goal.id !== goalId);
    if (state.goals.length !== before) state.sigs.goals = '';
  }

  function onGoalEvent(name, payload) {
    if (name === 'goal.deleted') {
      const goalId = str(payload && payload.goalId);
      if (!goalId) return;
      removeGoal(goalId);
      if (state.drawer.open && state.drawer.kind === 'goal' && state.drawer.id === goalId) hideDrawer();
      if (state.goalDetail && state.goalDetail.goalId === goalId) state.goalDetail = null;
      renderGoals();
      return;
    }
    const goal = payload && payload.goal && typeof payload.goal === 'object' ? payload.goal : null;
    if (!goal || !goal.id) return;
    const isNew = name === 'goal.created';
    upsertGoal(goal);
    if (isNew) toast(`目标已创建：${goal.title || ''}`, 'success');
    renderGoals();
    if (isGoalDrawerOpen(goal.id)) {
      renderGoalDrawer({ preserveScroll: true });
      scheduleGoalDetailRefresh(goal.id);
    }
  }

  /** 提醒的 SSE 增量：其他标签页 / APK 触发变更时保持列表与抽屉一致。 */
  function onReminderEvent(name, payload) {
    if (name === 'reminder.deleted') {
      const reminderId = str(payload && payload.reminderId);
      if (!reminderId) return;
      removeReminder(reminderId);
      if (state.drawer.open && state.drawer.kind === 'reminder-form' && state.drawer.id === reminderId) hideDrawer();
      state.sigs.reminders = '';
      renderReminders();
      syncRemindersToApk();
      return;
    }
    const reminder = payload && payload.reminder && typeof payload.reminder === 'object' ? payload.reminder : null;
    if (!reminder || !reminder.id) return;
    upsertReminder(reminder);
    state.sigs.reminders = '';
    renderReminders();
    syncRemindersToApk();
  }

  function openGoalRecord(taskId) {
    const id = str(taskId);
    if (!id) return;
    openRecordsDrawer();
    void openRecordDetail(id);
  }

  async function goalCheckNow(goalId) {
    const goal = goalById(goalId);
    if (!goal) return;
    if (goalBusy.has(goalId)) return;
    if (goal.runningTaskId) {
      toast('已有跟进任务正在执行，请稍候', 'warn');
      return;
    }
    if (goal.status !== 'active' && goal.status !== 'paused') {
      toast('目标已停止，无法立即跟进', 'warn');
      return;
    }
    goalBusy.add(goalId);
    state.sigs.goals = '';
    renderGoals();
    try {
      const res = await api(`/api/goals/${encodeURIComponent(goalId)}/check`, { method: 'POST', timeout: 15000 });
      if (res && res.goal) upsertGoal(res.goal);
      if (res && res.task) {
        upsertTask(res.task);
        renderTasks();
      }
      toast('已创建跟进任务，请稍候查看建议', 'success');
    } catch (err) {
      if (err.status === 401) {
        handleAuthLost(err.message);
        return;
      }
      if (err.status === 409) toast('已有跟进任务正在执行，请稍候', 'warn');
      else toast(err.message || '立即跟进失败', 'error');
    } finally {
      goalBusy.delete(goalId);
      state.sigs.goals = '';
      renderGoals();
      if (state.drawer.open && state.drawer.kind === 'goal' && state.drawer.id === goalId) {
        renderGoalDrawer({ preserveScroll: true });
      }
    }
  }

  function pendingApprovalNode(goal, { compact = false } = {}) {
    const approval = goal.pendingApproval;
    if (!approval) return null;
    const node = el('div', { className: compact ? 'goal-pending' : 'goal-pending goal-pending-block' },
      el('div', { className: 'goal-pending-text' },
        icon('alert'),
        el('span', { text: `待确认：${approval.reason || '目标跟进提案'}` }),
      ),
      el('div', { className: 'goal-pending-actions' },
        el('button', {
          type: 'button',
          className: 'btn btn-primary btn-sm',
          attrs: { title: '同意后立即创建跟进任务' },
          onclick: (event) => {
            event.preventDefault();
            event.stopPropagation();
            void goalApprove(goal.id);
          },
        }, icon('check'), el('span', { text: '同意' })),
        el('button', {
          type: 'button',
          className: 'btn btn-ghost btn-sm',
          attrs: { title: '否决后目标暂停，等你下一步指令' },
          onclick: (event) => {
            event.preventDefault();
            event.stopPropagation();
            void goalReject(goal.id);
          },
        }, icon('x'), el('span', { text: '否决' })),
      ),
    );
    if (!compact && str(approval.instruction)) {
      node.appendChild(goalRawText('div', 'goal-pending-instruction', approval.instruction));
    }
    return node;
  }

  async function goalApproval(goalId, action) {
    const goal = goalById(goalId);
    if (!goal || goalBusy.has(goalId)) return;
    if (!goal.pendingApproval) {
      toast('该目标没有待确认的跟进', 'warn');
      return;
    }
    if (action === 'reject') {
      const ok = await confirmDialog({
        title: '否决这次跟进',
        message: `否决后「${goal.title || ''}」会暂停，等你下一步指令再继续。`,
        okText: '否决并暂缓',
      });
      if (!ok) return;
    }
    goalBusy.add(goalId);
    state.sigs.goals = '';
    renderGoals();
    try {
      const res = await api(`/api/goals/${encodeURIComponent(goalId)}/${action}`, {
        method: 'POST',
        timeout: 15000,
      });
      if (res && res.goal) upsertGoal(res.goal);
      if (res && res.task) {
        upsertTask(res.task);
        renderTasks();
      }
      toast(
        action === 'approve' ? '已同意，跟进任务已创建' : '已否决，目标已暂缓，等你下一步指令',
        'success',
      );
    } catch (err) {
      if (err.status === 401) {
        handleAuthLost(err.message);
        return;
      }
      if (err.status === 409) toast('该目标没有待确认的跟进', 'warn');
      else toast(err.message || (action === 'approve' ? '同意失败' : '否决失败'), 'error');
    } finally {
      goalBusy.delete(goalId);
      state.sigs.goals = '';
      renderGoals();
      if (state.drawer.open && state.drawer.kind === 'goal' && state.drawer.id === goalId) {
        renderGoalDrawer({ preserveScroll: true });
      }
    }
  }

  function goalApprove(goalId) {
    return goalApproval(goalId, 'approve');
  }

  function goalReject(goalId) {
    return goalApproval(goalId, 'reject');
  }

  async function goalSetStatus(goalId, status, options = {}) {
    const goal = goalById(goalId);
    if (!goal || goalBusy.has(goalId)) return;
    if (status === 'stopped') {
      const ok = await confirmDialog({
        title: '停止目标',
        message: `停止后将不再自动检查「${goal.title || ''}」。`,
        okText: '停止',
      });
      if (!ok) return;
    }
    goalBusy.add(goalId);
    state.sigs.goals = '';
    renderGoals();
    try {
      const body = { status };
      if (status === 'paused' && options.pausedUntil !== undefined) body.pausedUntil = options.pausedUntil;
      const res = await api(`/api/goals/${encodeURIComponent(goalId)}`, {
        method: 'PATCH',
        body,
        timeout: 12000,
      });
      if (res && res.goal) upsertGoal(res.goal);
      const doneText = status === 'active'
        ? '目标已恢复自动跟进'
        : status === 'paused'
          ? (options.pausedUntil ? '目标已暂停（到点自动恢复）' : '目标已暂停')
          : status === 'completed'
            ? '目标已标记为达成'
            : '目标已停止';
      toast(doneText, 'success');
    } catch (err) {
      if (err.status === 401) {
        handleAuthLost(err.message);
        return;
      }
      toast(err.message || '操作失败', 'error');
    } finally {
      goalBusy.delete(goalId);
      state.sigs.goals = '';
      renderGoals();
      if (state.drawer.open && state.drawer.kind === 'goal' && state.drawer.id === goalId) {
        renderGoalDrawer({ preserveScroll: true });
      }
    }
  }

  /** 跳过下一次自动跟进（保持进行中）：到点不生成待确认提案。 */
  async function goalSkipNext(goalId) {
    const goal = goalById(goalId);
    if (!goal || goalBusy.has(goalId)) return;
    if (goal.status !== 'active') {
      toast('只有进行中的目标可以跳过下一次', 'warn');
      return;
    }
    goalBusy.add(goalId);
    state.sigs.goals = '';
    renderGoals();
    try {
      const res = await api(`/api/goals/${encodeURIComponent(goalId)}/skip`, {
        method: 'POST',
        body: {},
        timeout: 12000,
      });
      if (res && res.goal) upsertGoal(res.goal);
      toast('已跳过下一次自动跟进', 'success');
    } catch (err) {
      if (err.status === 401) {
        handleAuthLost(err.message);
        return;
      }
      toast(err.message || '跳过失败', 'error');
    } finally {
      goalBusy.delete(goalId);
      state.sigs.goals = '';
      renderGoals();
      if (state.drawer.open && state.drawer.kind === 'goal' && state.drawer.id === goalId) {
        renderGoalDrawer({ preserveScroll: true });
      }
    }
  }

  /** 追加一条「新的指导指令」：会加入之后的自动跟进任务。 */
  async function addGoalGuidance(goalId, text) {
    const goal = goalById(goalId);
    if (!goal) return false;
    if (goalBusy.has(goalId)) return false;
    goalBusy.add(goalId);
    try {
      const res = await api(`/api/goals/${encodeURIComponent(goalId)}/guidance`, {
        method: 'POST',
        body: { text },
        timeout: 12000,
      });
      if (res && res.goal) upsertGoal(res.goal);
      else await loadGoals({ silent: true });
      toast('指导指令已添加，将在下次自动跟进时生效', 'success');
      return true;
    } catch (err) {
      if (err.status === 401) {
        handleAuthLost(err.message);
        return false;
      }
      toast(err.message || '添加指导指令失败', 'error');
      return false;
    } finally {
      goalBusy.delete(goalId);
      state.sigs.goals = '';
      renderGoals();
      if (state.drawer.open && state.drawer.kind === 'goal' && state.drawer.id === goalId) {
        renderGoalDrawer({ preserveScroll: true });
      }
    }
  }

  /** datetime-local 输入框取值（本地时间，格式 YYYY-MM-DDTHH:mm）。 */
  function localDatetimeInputValue(ms) {
    const date = new Date(ms);
    const offset = date.getTimezoneOffset() * 60000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 16);
  }

  /** 「暂停止」抽屉：跳过下一次 / 暂停 1 天 / 暂停到指定时间 / 一直暂停。 */
  function openGoalPauseDrawer(goalId) {
    const goal = goalById(goalId);
    if (!goal) return;
    const paused = goal.status === 'paused';
    const modeSelect = el('select', { attrs: { 'aria-label': '暂停止方式' } });
    const modes = paused
      ? [
        ['day', '暂停 1 天（自动恢复）'],
        ['until', '暂停到指定时间（自动恢复）'],
        ['manual', '一直暂停（手动恢复）'],
      ]
      : [
        ['skip', '跳过下一次（保持进行中）'],
        ['day', '暂停 1 天（自动恢复）'],
        ['until', '暂停到指定时间（自动恢复）'],
        ['manual', '一直暂停（手动恢复）'],
      ];
    for (const [value, label] of modes) {
      modeSelect.appendChild(el('option', { value, text: label }));
    }
    if (paused && goal.pausedUntil) modeSelect.value = 'until';
    const untilInput = el('input', {
      type: 'datetime-local',
      value: localDatetimeInputValue(
        goal.pausedUntil ? Date.parse(goal.pausedUntil) : Date.now() + 24 * 3600 * 1000,
      ),
    });
    const untilRow = el('div', { className: 'field' },
      el('label', { text: '暂停结束时间' }),
      untilInput,
      el('span', { className: 'field-hint', text: '到点后自动恢复，并按计划重新排下一次跟进' }),
    );
    const syncRows = () => {
      untilRow.hidden = modeSelect.value !== 'until';
    };
    modeSelect.addEventListener('change', syncRows);
    syncRows();

    const body = el('div', { className: 'goal-pause' },
      el('div', { className: 'field' }, el('label', { text: '暂停止方式' }), modeSelect),
      untilRow,
      el('p', { className: 'goal-form-hint', text: '暂停期间不会自动创建跟进任务；「立即跟进」仍可手动执行。' }),
    );

    const confirmBtn = el('button', { type: 'button', className: 'btn btn-primary btn-sm' },
      icon('clock'), el('span', { text: paused ? '保存暂停设置' : '确认暂停' }));
    let busy = false;
    confirmBtn.addEventListener('click', async () => {
      if (busy) return;
      const mode = modeSelect.value;
      if (mode === 'until') {
        const ms = Date.parse(untilInput.value);
        if (!Number.isFinite(ms)) {
          toast('请选择暂停结束时间', 'warn');
          return;
        }
        if (ms <= Date.now()) {
          toast('暂停结束时间必须晚于当前时间', 'warn');
          return;
        }
        busy = true;
        hideDrawer();
        await goalSetStatus(goalId, 'paused', { pausedUntil: new Date(ms).toISOString() });
        return;
      }
      busy = true;
      hideDrawer();
      if (mode === 'skip') await goalSkipNext(goalId);
      else if (mode === 'day') {
        await goalSetStatus(goalId, 'paused', { pausedUntil: new Date(Date.now() + 24 * 3600 * 1000).toISOString() });
      } else if (mode === 'manual') {
        // 显式传 null：把「暂停到指定时间」改成一直暂停（未传时 Hub 会保留原 pausedUntil）。
        await goalSetStatus(goalId, 'paused', { pausedUntil: null });
      }
    });

    openDrawer({
      kind: 'goal-pause',
      id: goal.id,
      title: paused ? '修改暂停设置' : '暂停止目标',
      subNodes: [el('span', { text: '「暂停止」只影响自动跟进，不会删除目标。' })],
      body,
      footerNodes: [
        el('button', { type: 'button', className: 'btn btn-ghost btn-sm', text: '取消', onclick: hideDrawer }),
        el('span', { className: 'spacer' }),
        confirmBtn,
      ],
    });
  }

  async function goalDelete(goalId) {
    const goal = goalById(goalId);
    if (!goal || goalBusy.has(goalId)) return;
    const ok = await confirmDialog({
      title: '删除目标',
      message: '删除后无法恢复，已有的检查历史也会一并删除。',
      okText: '删除',
    });
    if (!ok) return;
    goalBusy.add(goalId);
    state.sigs.goals = '';
    renderGoals();
    try {
      await api(`/api/goals/${encodeURIComponent(goalId)}`, { method: 'DELETE', timeout: 12000 });
      removeGoal(goalId);
      if (state.drawer.open && state.drawer.kind === 'goal' && state.drawer.id === goalId) hideDrawer();
      toast('目标已删除', 'success');
    } catch (err) {
      if (err.status === 401) {
        handleAuthLost(err.message);
        return;
      }
      if (err.status === 404) removeGoal(goalId);
      else toast(err.message || '删除失败', 'error');
    } finally {
      goalBusy.delete(goalId);
      state.sigs.goals = '';
      renderGoals();
    }
  }

  function openGoalFormDrawer(goalId) {
    const goal = goalId ? goalById(goalId) : null;
    const schedule = goal && goal.schedule && typeof goal.schedule === 'object' ? goal.schedule : {};
    const scheduleType = schedule.type === 'interval' ? 'interval' : 'daily';

    const form = el('form', { className: 'goal-form', attrs: { novalidate: 'novalidate' } });

    const nicknameInput = el('input', {
      type: 'text',
      attrs: { maxlength: '40', placeholder: '例如：自由职业、求职、学日语（可选）', 'aria-label': '目标昵称' },
    });
    nicknameInput.value = goal ? str(goal.nickname) : '';

    const titleInput = el('input', {
      type: 'text',
      attrs: { maxlength: '120', placeholder: '例如：三个月内学会日语 N3', 'aria-label': '目标标题' },
    });
    titleInput.value = goal ? str(goal.title) : '';

    const descInput = el('textarea', {
      attrs: { rows: '4', placeholder: '描述目标背景与衡量标准，越详细越好', 'aria-label': '描述（可选）' },
    });
    descInput.value = goal ? str(goal.description) : '';

    const typeSelect = el('select', { attrs: { 'aria-label': '检查计划' } });
    for (const [value, label] of [['daily', '每天'], ['interval', '每 N 小时']]) {
      const option = el('option', { value, text: label });
      if (value === scheduleType) option.selected = true;
      typeSelect.appendChild(option);
    }
    typeSelect.value = scheduleType;

    const timeInput = el('input', { type: 'time', attrs: { 'aria-label': '执行时间' } });
    timeInput.value = /^\d{2}:\d{2}$/.test(str(schedule.time)) ? str(schedule.time) : '09:00';

    const intervalInput = el('input', {
      type: 'number',
      attrs: { min: '1', max: '720', step: '1', inputmode: 'numeric', 'aria-label': '间隔小时数' },
    });
    const intervalHours = schedule.type === 'interval' ? Math.max(1, Math.round(num(schedule.minutes, 180) / 60)) : 3;
    intervalInput.value = String(intervalHours);

    const dailyRow = el('div', { className: 'field-row goal-schedule-row' },
      el('div', { className: 'field' },
        el('label', { text: '执行时间' }),
        timeInput,
        el('span', { className: 'field-hint', text: '按 Hub 本机时间每天执行' }),
      ),
    );
    const intervalRow = el('div', { className: 'field-row goal-schedule-row' },
      el('div', { className: 'field' },
        el('label', { text: '间隔小时数' }),
        intervalInput,
        el('span', { className: 'field-hint', text: '最小 1 小时' }),
      ),
    );
    const syncScheduleRows = () => {
      const interval = typeSelect.value === 'interval';
      dailyRow.hidden = interval;
      intervalRow.hidden = !interval;
    };
    typeSelect.addEventListener('change', syncScheduleRows);
    syncScheduleRows();

    const nicknameHint = el('span', { className: 'field-hint', text: '列表和提醒里优先用这个称呼；留空则显示标题' });
    form.append(
      el('div', { className: 'field' }, el('label', { text: '昵称（可选）' }), nicknameInput, nicknameHint),
      el('div', { className: 'field' }, el('label', { text: '目标标题' }), titleInput),
      el('div', { className: 'field' }, el('label', { text: '描述（可选）' }), descInput),
      el('div', { className: 'field' }, el('label', { text: '检查计划' }), typeSelect),
      dailyRow,
      intervalRow,
      el('p', { className: 'goal-form-hint', text: 'Hub 会按计划定时创建任务检查进度并给出建议。' }),
    );

    const saveBtn = el('button', { type: 'button', className: 'btn btn-primary btn-sm' }, icon('check'), el('span', { text: '保存' }));
    let saving = false;

    const save = async () => {
      if (saving) return;
      const title = titleInput.value.trim();
      if (!title) {
        toast('目标标题不能为空', 'warn');
        titleInput.focus();
        return;
      }
      let scheduleBody;
      if (typeSelect.value === 'interval') {
        const hours = Math.max(1, Math.min(720, Math.round(Number(intervalInput.value) || 1)));
        intervalInput.value = String(hours);
        scheduleBody = { type: 'interval', minutes: hours * 60 };
      } else {
        const time = /^\d{2}:\d{2}$/.test(timeInput.value) ? timeInput.value : '09:00';
        scheduleBody = { type: 'daily', time };
      }
      saving = true;
      saveBtn.disabled = true;
      try {
        const body = {
          title,
          nickname: nicknameInput.value.trim(),
          description: descInput.value.trim(),
          schedule: scheduleBody,
        };
        const res = goal
          ? await api(`/api/goals/${encodeURIComponent(goal.id)}`, { method: 'PATCH', body, timeout: 15000 })
          : await api('/api/goals', { method: 'POST', body, timeout: 15000 });
        if (res && res.goal) upsertGoal(res.goal);
        state.sigs.goals = '';
        renderGoals();
        toast(goal ? '目标已保存' : '目标已创建', 'success');
        hideDrawer();
      } catch (err) {
        if (err.status === 401) {
          handleAuthLost(err.message);
          return;
        }
        toast(err.message || (goal ? '保存目标失败' : '创建目标失败'), 'error');
      } finally {
        saving = false;
        saveBtn.disabled = false;
      }
    };
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void save();
    });
    saveBtn.addEventListener('click', () => void save());

    openDrawer({
      kind: 'goal-form',
      id: goal ? goal.id : null,
      title: goal ? '编辑目标' : '新建目标',
      subNodes: [el('span', { text: 'Hub 会按计划定时创建任务检查进度并给出建议。' })],
      body: form,
      footerNodes: [
        el('button', { type: 'button', className: 'btn btn-ghost btn-sm', text: '取消', onclick: hideDrawer }),
        el('span', { className: 'spacer' }),
        saveBtn,
      ],
    });
    setTimeout(() => titleInput.focus(), 80);
  }

  function openGoalDrawer(goalId) {
    const goal = goalById(goalId);
    if (!goal) {
      if (state.goalsLoaded) toast('目标不存在或已删除', 'warn');
      else void loadGoals();
      return;
    }
    if (!state.goalDetail || state.goalDetail.goalId !== goal.id) {
      state.goalDetail = { goalId: goal.id, goal, tasks: null, linkedStats: null, loading: true, error: '' };
    }
    openDrawer({
      kind: 'goal',
      id: goal.id,
      title: '目标详情',
      subNodes: [],
      body: el('div'),
      footerNodes: [el('button', { type: 'button', className: 'btn btn-ghost btn-sm', text: '关闭', onclick: hideDrawer })],
    });
    renderGoalDrawer();
    void refreshGoalDetail(goal.id);
  }

  function renderGoalDrawer({ preserveScroll = false } = {}) {
    if (!state.drawer.open || state.drawer.kind !== 'goal') return;
    const goal = goalById(state.drawer.id);
    if (!goal) {
      hideDrawer();
      return;
    }
    const bodyNode = $('#drawer-body');
    const scroll = preserveScroll && bodyNode ? bodyNode.scrollTop : 0;
    const status = goal.status || 'active';
    const running = Boolean(goal.runningTaskId) || goalBusy.has(goal.id);

    const wrap = el('div');

    const actions = el('div', { className: 'detail-actions' });
    const addAction = (label, handler, kind = 'ghost') => {
      const btn = el('button', { type: 'button', className: `btn btn-${kind} btn-sm` });
      btn.appendChild(document.createTextNode(tx(label)));
      btn.addEventListener('click', handler);
      actions.appendChild(btn);
      return btn;
    };
    if (status === 'active' || status === 'paused') {
      const check = addAction(running ? '跟进中…' : '立即跟进', () => void goalCheckNow(goal.id), 'primary');
      check.prepend(icon('send'));
      check.disabled = running;
    }
    if (goal.pendingApproval) {
      const approveBtn = addAction('同意跟进', () => void goalApprove(goal.id), 'primary');
      approveBtn.prepend(icon('check'));
      const rejectBtn = addAction('否决并暂缓', () => void goalReject(goal.id), 'ghost');
      rejectBtn.prepend(icon('x'));
    }
    if (status === 'active') {
      const pauseBtn = addAction('暂停止', () => openGoalPauseDrawer(goal.id));
      pauseBtn.prepend(icon('clock'));
    } else if (status === 'paused') {
      addAction('修改暂停设置', () => openGoalPauseDrawer(goal.id));
      addAction('恢复自动跟进', () => void goalSetStatus(goal.id, 'active'));
    } else if (status === 'stopped') {
      addAction('恢复自动跟进', () => void goalSetStatus(goal.id, 'active'));
    }
    if (status === 'active' || status === 'paused') {
      addAction('标记已达成', () => void goalSetStatus(goal.id, 'completed'));
      addAction('停止', () => void goalSetStatus(goal.id, 'stopped'));
    }
    if (status === 'completed') addAction('重新激活', () => void goalSetStatus(goal.id, 'active'));
    addAction('编辑', () => openGoalFormDrawer(goal.id));
    addAction('删除', () => void goalDelete(goal.id), 'danger');
    wrap.appendChild(actions);

    if (goal.pendingApproval) {
      const pending = pendingApprovalNode(goal);
      if (pending) wrap.appendChild(pending);
    }

    const info = el('section', { className: 'detail-section' },
      el('div', { className: 'detail-section-head' }, el('h3', { text: '基础信息' })),
    );
    const grid = el('div', { className: 'kv-grid' },
      kv('昵称', str(goal.nickname) || '—'),
      kv('状态', GOAL_STATUS[status] ? GOAL_STATUS[status].label : status),
      kv('计划', goalPlanText(goal.schedule)),
      kv('下次跟进', goal.nextCheckAt ? fmtDateTime(goal.nextCheckAt) : '—'),
      kv('上次检查', goal.lastCheckAt ? fmtDateTime(goal.lastCheckAt) : '—'),
      kv('检查结果', goal.lastCheckStatus ? (GOAL_CHECK_STATUS[goal.lastCheckStatus] || goal.lastCheckStatus) : '—'),
      kv('创建时间', goal.createdAt ? fmtDateTime(goal.createdAt) : '—'),
      kv('最近更新', goal.updatedAt ? fmtDateTime(goal.updatedAt) : '—'),
    );
    if (goal.status === 'stopped' && goal.stoppedAt) grid.appendChild(kv('停止时间', fmtDateTime(goal.stoppedAt)));
    if (goal.pausedUntil) grid.appendChild(kv('自动恢复时间', fmtDateTime(goal.pausedUntil)));
    grid.appendChild(kvCopy('目标 ID', goal.id, '目标 ID 已复制'));
    info.appendChild(grid);
    wrap.appendChild(info);

    wrap.appendChild(goalLinkedSection(goal));

    if (str(goal.description)) {
      wrap.appendChild(el('section', { className: 'detail-section' },
        el('div', { className: 'detail-section-head' }, el('h3', { text: '描述' })),
        goalRawText('p', 'goal-detail-desc', goal.description),
      ));
    }

    const guidanceEntries = arr(goal.guidance)
      .filter((entry) => str(entry && entry.text))
      .slice()
      .sort((a, b) => (parseIso(b.createdAt) || 0) - (parseIso(a.createdAt) || 0));
    const guidanceSection = el('section', { className: 'detail-section' },
      el('div', { className: 'detail-section-head' }, el('h3', { text: '指导指令' })),
    );
    if (guidanceEntries.length) {
      const guidanceList = el('div', { className: 'goal-guidance-list' });
      for (const entry of guidanceEntries.slice(0, 8)) {
        guidanceList.appendChild(el('article', { className: 'goal-guidance' },
          el('div', { className: 'goal-guidance-head' },
            el('span', { className: 'goal-guidance-time', text: entry.createdAt ? fmtDateTime(entry.createdAt) : '—' }),
          ),
          goalRawText('p', 'goal-guidance-text', entry.text),
        ));
      }
      guidanceSection.appendChild(guidanceList);
    } else {
      guidanceSection.appendChild(el('p', {
        className: 'goal-checks-empty',
        text: '还没有指导指令。写下新的方向后，会加入之后的自动跟进。',
      }));
    }
    const guidanceInput = el('textarea', {
      className: 'goal-guidance-input',
      attrs: { rows: '3', placeholder: '例如：优先处理 A 项目；输出时多给具体行动；暂缓 B 项目。' },
    });
    const guidanceBtn = el('button', {
      type: 'button',
      className: 'btn btn-primary btn-sm goal-guidance-submit',
      text: '添加指令',
    });
    guidanceBtn.addEventListener('click', async () => {
      const text = guidanceInput.value.trim();
      if (!text) {
        toast('请先输入指导指令', 'warn');
        guidanceInput.focus();
        return;
      }
      if (guidanceBtn.disabled) return;
      guidanceBtn.disabled = true;
      guidanceBtn.textContent = tx('添加中…');
      try {
        const added = await addGoalGuidance(goal.id, text);
        if (added) guidanceInput.value = '';
      } finally {
        guidanceBtn.disabled = false;
        guidanceBtn.textContent = tx('添加指令');
      }
    });
    guidanceSection.appendChild(el('div', { className: 'goal-guidance-form' },
      guidanceInput,
      el('div', { className: 'goal-guidance-form-foot' },
        el('span', { className: 'goal-guidance-hint', text: '指导指令会附加到之后的每一次自动跟进。' }),
        guidanceBtn,
      ),
    ));
    wrap.appendChild(guidanceSection);

    const suggestion = el('section', { className: 'detail-section' },
      el('div', { className: 'detail-section-head' },
        el('h3', { text: '最近建议' }),
        goalCheckState(goal),
      ),
    );
    if (str(goal.lastSummary)) {
      const article = el('article', { className: 'record-markdown goal-markdown' });
      article.innerHTML = renderMarkdownHtml(goal.lastSummary);
      article.addEventListener('click', (event) => {
        const link = event.target.closest('[data-record-id]');
        if (!link) return;
        event.preventDefault();
        openGoalRecord(link.dataset.recordId);
      });
      suggestion.appendChild(article);
    } else {
      suggestion.appendChild(el('p', { className: 'goal-checks-empty', text: '还没有检查记录，点击「立即跟进」查看建议。' }));
    }
    wrap.appendChild(suggestion);

    const history = el('section', { className: 'detail-section' },
      el('div', { className: 'detail-section-head' }, el('h3', { text: '检查历史' })),
    );
    const checks = arr(goal.checks).slice().sort((a, b) => (parseIso(b && b.at) || 0) - (parseIso(a && a.at) || 0));
    if (!checks.length) {
      history.appendChild(el('p', { className: 'goal-checks-empty', text: '暂无检查记录' }));
    } else {
      const listEl = el('div', { className: 'goal-checks' });
      for (const check of checks) {
        const checkStatus = str(check.status);
        const taskId = str(check.taskId);
        const item = el('button', {
          type: 'button',
          className: 'goal-check',
          attrs: { title: taskId ? '点击查看执行记录' : '' },
          dataset: { taskId },
        });
        const top = el('div', { className: 'goal-check-top' },
          el('span', { className: 'goal-check-state', dataset: { status: checkStatus } },
            icon(checkStatus === 'failed' || checkStatus === 'timeout' ? 'alert' : 'check'),
            el('span', { text: GOAL_CHECK_STATUS[checkStatus] || checkStatus || '—' }),
          ),
          el('span', { className: 'goal-check-time', text: fmtDateTime(check.at) }),
        );
        if (taskId) top.appendChild(el('span', { className: 'goal-check-task', text: taskId }));
        item.appendChild(top);
        if (str(check.summary)) item.appendChild(goalRawText('div', 'goal-check-summary', shorten(check.summary, 160)));
        if (str(check.error)) item.appendChild(goalRawText('div', 'goal-check-error', shorten(check.error, 120)));
        if (!taskId) item.disabled = true;
        item.addEventListener('click', () => {
          if (taskId) openGoalRecord(taskId);
        });
        listEl.appendChild(item);
      }
      history.appendChild(listEl);
    }
    wrap.appendChild(history);

    updateDrawerContent({
      title: '目标详情',
      subNodes: [
        goalStatusBadge(goal),
        el('span', { className: 'goal-plan' }, icon('clock'), el('span', { text: goalPlanText(goal.schedule) })),
        el('span', { className: 'mono', text: goal.id }),
      ],
      body: wrap,
      footerNodes: [
        el('button', { type: 'button', className: 'btn btn-ghost btn-sm', text: '关闭', onclick: hideDrawer }),
        el('span', { className: 'spacer' }),
        el('button', {
          type: 'button', className: 'btn btn-ghost btn-sm',
          onclick: () => copyText(goal.id, '目标 ID 已复制'),
        }, icon('copy'), '复制目标 ID'),
      ],
    });
    if (preserveScroll && bodyNode) bodyNode.scrollTop = scroll;
  }

  /* ==================================================================
   * 目标 ↔ 任务关联
   * ================================================================== */
  function goalDisplayName(goal) {
    if (!goal || typeof goal !== 'object') return '';
    return str(goal.nickname) || str(goal.title) || '未命名目标';
  }

  /** 是否打开了目标详情抽屉（传 goalId 时限定某个目标）。 */
  function isGoalDrawerOpen(goalId) {
    if (!state.drawer.open || state.drawer.kind !== 'goal') return false;
    return goalId ? state.drawer.id === goalId : true;
  }

  function goalDetailFor(goalId) {
    return state.goalDetail && state.goalDetail.goalId === goalId ? state.goalDetail : null;
  }

  /** 拉取单个目标详情（含关联任务），结果缓存到 state.goalDetail。 */
  async function refreshGoalDetail(goalId) {
    const id = str(goalId);
    if (!id || !state.connected) return;
    if (!state.goalDetail || state.goalDetail.goalId !== id) {
      state.goalDetail = { goalId: id, goal: goalById(id), tasks: null, linkedStats: null, loading: true, error: '' };
    } else {
      state.goalDetail.loading = true;
      state.goalDetail.error = '';
    }
    if (isGoalDrawerOpen(id)) renderGoalDrawer({ preserveScroll: true });
    try {
      const res = await api(`/api/goals/${encodeURIComponent(id)}`, { timeout: 12000 });
      if (!state.goalDetail || state.goalDetail.goalId !== id) return;
      const goal = res && res.goal && typeof res.goal === 'object' ? res.goal : goalById(id);
      const tasks = arr(res && res.tasks).filter((task) => task && task.id);
      const linkedStats = res && res.linkedStats && typeof res.linkedStats === 'object'
        ? res.linkedStats
        : (goal && goal.linkedStats) || null;
      state.goalDetail = { goalId: id, goal, tasks, linkedStats, loading: false, error: '' };
      if (goal && goal.id) {
        const idx = state.goals.findIndex((item) => item && item.id === goal.id);
        if (idx >= 0) state.goals[idx] = { ...state.goals[idx], ...goal };
        state.sigs.goals = '';
      }
    } catch (err) {
      if (err.status === 401) return handleAuthLost(err.message);
      if (!state.goalDetail || state.goalDetail.goalId !== id) return;
      state.goalDetail.loading = false;
      state.goalDetail.error = err.status === 404 ? '目标不存在或已删除' : (err.message || '关联任务载入失败');
    } finally {
      if (state.goalDetail && state.goalDetail.goalId === id) {
        renderGoals();
        if (isGoalDrawerOpen(id)) renderGoalDrawer({ preserveScroll: true });
      }
    }
  }

  /** SSE 触发刷新：任务事件常成批到达，做 400ms 防抖。 */
  function scheduleGoalDetailRefresh(goalId) {
    if (!goalId) return;
    clearTimeout(goalDetailTimer);
    goalDetailTimer = setTimeout(() => {
      goalDetailTimer = 0;
      const openId = isGoalDrawerOpen() ? state.drawer.id : goalId;
      if (openId) void refreshGoalDetail(openId);
    }, 400);
  }

  function openLinkedTask(task) {
    if (!task || !str(task.id)) return;
    if (!state.tasks.some((item) => item && item.id === task.id)) upsertTask(task);
    openTaskDrawer(task.id);
  }

  async function linkGoalTask(goalId, taskId) {
    const gid = str(goalId);
    const tid = str(taskId);
    if (!gid || !tid) return false;
    try {
      const res = await api(`/api/goals/${encodeURIComponent(gid)}/link`, {
        method: 'POST', body: { taskId: tid }, timeout: 12000,
      });
      if (res && res.goal) upsertGoal(res.goal);
      if (res && res.task) upsertTask(res.task);
      else {
        const local = state.tasks.find((item) => item && item.id === tid);
        if (local) local.goalId = gid;
      }
      if (state.goalDetail && state.goalDetail.goalId === gid) state.goalDetail = null;
      state.sigs.goals = '';
      renderGoals();
      toast('任务已关联到目标', 'success');
      void refreshGoalDetail(gid);
      if (state.drawer.open && state.drawer.kind === 'task' && state.drawer.id === tid) refreshOpenDrawer();
      return true;
    } catch (err) {
      if (err.status === 401) {
        handleAuthLost(err.message);
        return false;
      }
      toast(err.message || '关联任务失败', 'error');
      return false;
    }
  }

  async function unlinkGoalTask(goalId, taskId) {
    const gid = str(goalId);
    const tid = str(taskId);
    if (!gid || !tid || goalBusy.has(gid)) return;
    goalBusy.add(gid);
    try {
      const res = await api(`/api/goals/${encodeURIComponent(gid)}/unlink`, {
        method: 'POST', body: { taskId: tid }, timeout: 12000,
      });
      if (res && res.goal) upsertGoal(res.goal);
      if (res && res.task) upsertTask(res.task);
      else {
        const local = state.tasks.find((item) => item && item.id === tid);
        if (local && local.goalId === gid) local.goalId = '';
      }
      if (state.goalDetail && state.goalDetail.goalId === gid) {
        state.goalDetail.tasks = arr(state.goalDetail.tasks).filter((item) => item && item.id !== tid);
      }
      toast('已取消关联', 'success');
    } catch (err) {
      if (err.status === 401) return handleAuthLost(err.message);
      toast(err.message || '取消关联失败', 'error');
    } finally {
      goalBusy.delete(gid);
      state.sigs.goals = '';
      renderGoals();
      if (isGoalDrawerOpen(gid)) renderGoalDrawer({ preserveScroll: true });
      if (state.drawer.open && state.drawer.kind === 'task' && state.drawer.id === tid) refreshOpenDrawer();
      if (isGoalDrawerOpen(gid) || goalDetailFor(gid)) void refreshGoalDetail(gid);
    }
  }

  function linkedTaskRow(goalId, task) {
    const status = normStatus(task.status);
    const instruction = str(task.instruction) || '（无指令内容）';
    const row = el('article', { className: 'linked-task-row', dataset: { id: task.id } });
    row.appendChild(el('div', { className: 'link-row-head' },
      statusBadge(status),
      el('span', { className: 'linked-task-text', text: shorten(instruction, 100), title: instruction }),
    ));
    const meta = el('div', { className: 'linked-task-meta' });
    if (task.isPlan && task.childProgress && typeof task.childProgress === 'object') {
      const child = task.childProgress;
      const total = Math.max(0, num(child.total));
      const completed = Math.max(0, num(child.completed));
      const parts = [`子任务 ${completed}/${total}`];
      if (num(child.failed) > 0) parts.push(`失败 ${num(child.failed)}`);
      if (num(child.running) > 0) parts.push(`进行中 ${num(child.running)}`);
      meta.appendChild(el('span', { className: 'linked-task-plan', text: parts.join(' · ') }));
    }
    const progressMessage = task.progress && str(task.progress.message) ? str(task.progress.message) : '';
    if (progressMessage) {
      meta.appendChild(el('span', { className: 'linked-task-progress', text: shorten(progressMessage, 60), title: progressMessage }));
    } else if (str(task.assignedDeviceName)) {
      meta.appendChild(el('span', { className: 'linked-task-device', text: task.assignedDeviceName }));
    } else if (str(task.planTitle)) {
      meta.appendChild(el('span', { className: 'linked-task-device', text: task.planTitle }));
    }
    if (meta.childElementCount) row.appendChild(meta);
    row.appendChild(el('div', { className: 'link-row-actions' },
      el('button', { type: 'button', className: 'link-btn', onclick: () => openLinkedTask(task) }, el('span', { text: '打开' })),
      el('button', { type: 'button', className: 'link-btn', onclick: () => void unlinkGoalTask(goalId, task.id) }, el('span', { text: '取消关联' })),
    ));
    return row;
  }

  /** 目标详情里的「关联任务」区块：先展示缓存，SSE 到达后刷新。 */
  function goalLinkedSection(goal) {
    const detail = goalDetailFor(goal.id);
    const section = el('section', { className: 'detail-section' },
      el('div', { className: 'detail-section-head' },
        el('h3', { text: '关联任务' }),
        el('div', { className: 'detail-head-actions' },
          el('button', { type: 'button', className: 'link-btn', onclick: () => openGoalTaskPicker(goal.id) },
            icon('link'), el('span', { text: '关联任务' })),
        ),
      ),
    );
    if (!detail || (detail.loading && !detail.tasks)) {
      section.appendChild(el('p', { className: 'goal-checks-empty', text: '正在载入关联任务…' }));
      return section;
    }
    if (detail.error && !arr(detail.tasks).length) {
      section.appendChild(el('div', { className: 'goal-checks-empty linked-error' },
        el('span', { text: detail.error }),
        el('button', { type: 'button', className: 'link-btn', onclick: () => void refreshGoalDetail(goal.id) }, el('span', { text: '重试' })),
      ));
      return section;
    }
    const tasks = arr(detail.tasks);
    const stats = detail.linkedStats
      || (goal.linkedStats && typeof goal.linkedStats === 'object' ? goal.linkedStats : null);
    if (stats && num(stats.total) > 0) {
      const bits = [`共 ${num(stats.total)} 个`];
      const active = num(stats.running) + num(stats.waiting);
      if (active > 0) bits.push(`进行中 ${active}`);
      if (num(stats.completed) > 0) bits.push(`已完成 ${num(stats.completed)}`);
      if (num(stats.failed) > 0) bits.push(`失败 ${num(stats.failed)}`);
      if (num(stats.planTotal) > 0) bits.push(`计划 ${num(stats.planCompleted)}/${num(stats.planTotal)}`);
      section.appendChild(el('p', { className: 'linked-summary', text: bits.join(' · ') }));
    }
    if (!tasks.length) {
      section.appendChild(el('p', {
        className: 'goal-checks-empty',
        text: '还没有关联任务。把正在进行的任务关联进来，目标页就能看到它的进度。',
      }));
      return section;
    }
    const list = el('div', { className: 'linked-task-list' });
    for (const task of tasks.slice(0, 40)) list.appendChild(linkedTaskRow(goal.id, task));
    section.appendChild(list);
    if (detail.loading) section.appendChild(el('p', { className: 'goal-checks-empty', text: '正在刷新关联任务…' }));
    return section;
  }

  function openGoalTaskPicker(goalId) {
    const goal = goalById(goalId);
    if (!goal) return;
    const candidates = state.tasks
      .filter((task) => task && task.id && !task.archived && !task.parentTaskId
        && (!task.goalId || task.goalId !== goal.id))
      .sort((a, b) => (parseIso(b.createdAt) || 0) - (parseIso(a.createdAt) || 0))
      .slice(0, 50);
    const body = el('div', { className: 'link-picker' },
      el('p', { className: 'goal-form-hint', text: '选择要关联到此目标的任务。已经关联其它目标的任务会被移动过来。' }),
    );
    if (!candidates.length) {
      body.appendChild(el('p', { className: 'goal-checks-empty', text: '没有可关联的任务。先在「任务」页创建一个吧。' }));
    } else {
      const list = el('div', { className: 'link-picker-list' });
      for (const task of candidates) list.appendChild(taskPickRow(goal.id, task));
      body.appendChild(list);
    }
    openDrawer({
      kind: 'goal-link-task',
      id: goal.id,
      title: '关联任务',
      subNodes: [el('span', { className: 'goal-plan' }, icon('target'), el('span', { text: goalDisplayName(goal) }))],
      body,
      footerNodes: [el('button', { type: 'button', className: 'btn btn-ghost btn-sm', text: '关闭', onclick: hideDrawer })],
    });
  }

  function taskPickRow(goalId, task) {
    const row = el('button', { type: 'button', className: 'link-row link-row-button', dataset: { id: task.id } },
      el('span', { className: 'link-row-main' },
        el('span', { className: 'link-row-title', text: shorten(str(task.instruction) || '（无指令内容）', 90) }),
        el('span', { className: 'link-row-meta-line' },
          statusBadge(normStatus(task.status)),
          el('span', { className: 'link-row-time', text: fmtDateTime(task.createdAt) }),
          task.goalId ? el('span', { className: 'link-row-note', text: '已关联其它目标' }) : null,
        ),
      ),
      el('span', { className: 'link-row-action' }, icon('link'), el('span', { text: '关联' })),
    );
    let busy = false;
    row.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      row.disabled = true;
      const linked = await linkGoalTask(goalId, task.id);
      busy = false;
      if (linked) {
        hideDrawer();
        openGoalDrawer(goalId);
      } else {
        row.disabled = false;
      }
    });
    return row;
  }

  function openTaskGoalPicker(taskId) {
    const task = state.tasks.find((item) => item && item.id === taskId);
    if (!task) {
      toast('任务不存在或已被清理', 'warn');
      return;
    }
    const goals = state.goals
      .filter((goal) => goal && goal.id && goal.id !== task.goalId)
      .sort((a, b) => (parseIso(b.updatedAt) || 0) - (parseIso(a.updatedAt) || 0));
    const body = el('div', { className: 'link-picker' },
      el('p', { className: 'goal-form-hint' },
        el('span', { text: '把任务关联到哪个目标？' }),
        el('span', { className: 'link-picker-task', text: shorten(str(task.instruction) || '（无指令内容）', 60) }),
      ),
    );
    if (!goals.length) {
      body.appendChild(el('p', {
        className: 'goal-checks-empty',
        text: task.goalId ? '没有其它可关联的目标。' : '还没有长期目标。先在「目标」页创建一个。',
      }));
    } else {
      const list = el('div', { className: 'link-picker-list' });
      for (const goal of goals) list.appendChild(goalPickRow(task.id, goal));
      body.appendChild(list);
    }
    openDrawer({
      kind: 'task-link-goal',
      id: task.id,
      title: '关联到目标',
      subNodes: [el('span', { className: 'mono', text: task.id })],
      body,
      footerNodes: [el('button', { type: 'button', className: 'btn btn-ghost btn-sm', text: '关闭', onclick: hideDrawer })],
    });
  }

  function goalPickRow(taskId, goal) {
    const row = el('button', { type: 'button', className: 'link-row link-row-button', dataset: { id: goal.id } },
      el('span', { className: 'link-row-main' },
        el('span', { className: 'link-row-title', text: goalDisplayName(goal) }),
        el('span', { className: 'link-row-meta-line' },
          goalStatusBadge(goal),
          el('span', { className: 'link-row-time', text: goalPlanText(goal.schedule) }),
        ),
      ),
      el('span', { className: 'link-row-action' }, icon('link'), el('span', { text: '关联' })),
    );
    let busy = false;
    row.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      row.disabled = true;
      const linked = await linkGoalTask(goal.id, taskId);
      busy = false;
      if (linked) {
        hideDrawer();
        if (state.tasks.some((item) => item && item.id === taskId)) openTaskDrawer(taskId);
      } else {
        row.disabled = false;
      }
    });
    return row;
  }

  async function unlinkTaskGoal(task) {
    if (!task || !task.id) return;
    const goalId = str(task.goalId);
    if (!goalId) return;
    await unlinkGoalTask(goalId, task.id);
  }

  /** 任务详情里的「关联目标」区块。 */
  function taskGoalSectionNode(task) {
    const goalId = str(task.goalId);
    const goal = goalId ? goalById(goalId) : null;
    const section = el('section', { className: 'detail-section' },
      el('div', { className: 'detail-section-head' },
        el('h3', { text: '关联目标' }),
        el('div', { className: 'detail-head-actions' },
          el('button', { type: 'button', className: 'link-btn', onclick: () => openTaskGoalPicker(task.id) },
            icon('link'), el('span', { text: '关联到目标' })),
        ),
      ),
    );
    if (!goalId) {
      section.appendChild(el('p', {
        className: 'goal-checks-empty',
        text: '还没有关联目标。关联后能在目标页看到这个任务的进度。',
      }));
      return section;
    }
    const displayName = goal ? goalDisplayName(goal) : goalId;
    section.appendChild(el('div', { className: 'link-row goal-link-row' },
      el('span', { className: 'link-row-main' },
        el('span', { className: 'link-row-title', text: displayName, title: displayName }),
        el('span', { className: 'link-row-meta-line' },
          goal ? goalStatusBadge(goal) : null,
          el('span', { className: 'mono', text: goalId }),
        ),
      ),
      el('span', { className: 'link-row-actions' },
        el('button', { type: 'button', className: 'link-btn', onclick: () => openGoalDrawer(goalId) },
          icon('target'), el('span', { text: '打开目标' })),
        el('button', { type: 'button', className: 'link-btn', onclick: () => copyText(goalId, '目标 ID 已复制') },
          icon('copy'), el('span', { text: '复制目标 ID' })),
      ),
    ));
    return section;
  }

  /* ==================================================================
   * 自主大脑：状态卡 + 设置/历史抽屉
   * ================================================================== */
  function brainChipView(brain) {
    if (!brain || !brain.enabled) return { text: '已暂停', tone: 'paused' };
    if (brain.mode === 'suggest') return { text: '建议', tone: 'suggest' };
    return { text: '自动', tone: 'auto' };
  }

  function brainNextIso(brain) {
    if (!brain || !brain.enabled) return '';
    if (brain.nextThinkAt) return brain.nextThinkAt;
    if (!brain.lastThinkAt) return '';
    const last = parseIso(brain.lastThinkAt);
    if (last === null) return '';
    return new Date(last + Math.max(60, num(brain.intervalSec, 180)) * 1000).toISOString();
  }

  /** 兼容两种来源：大脑对象用 lastAssessment，决策记录用 assessment。 */
  function brainAssessmentOf(source) {
    if (!source || typeof source !== 'object') return null;
    if (source.assessment && typeof source.assessment === 'object') return source.assessment;
    if (source.lastAssessment && typeof source.lastAssessment === 'object') return source.lastAssessment;
    return null;
  }

  function brainStepText(assessment, key) {
    return assessment && typeof assessment[key] === 'string' ? assessment[key].trim() : '';
  }

  /** 渲染六步思考（compact 时只取卡片三步并截断长文本）。 */
  function brainAssessmentNode(assessment, { compact = false } = {}) {
    if (!assessment || typeof assessment !== 'object') return null;
    const steps = compact ? BRAIN_STEPS.filter((step) => BRAIN_CARD_STEPS.includes(step.key)) : BRAIN_STEPS;
    const wrap = el('div', { className: `brain-assessment${compact ? ' is-compact' : ''}` });
    let hasAny = false;
    for (const step of steps) {
      const value = brainStepText(assessment, step.key);
      if (!value) continue;
      hasAny = true;
      const textNode = goalRawText('p', 'brain-step-text', compact ? shorten(value, 160) : value);
      textNode.title = value;
      wrap.appendChild(el('div', { className: 'brain-step' },
        el('span', { className: 'brain-step-label', text: tr(step.i18n) }),
        textNode,
      ));
    }
    return hasAny ? wrap : null;
  }

  /** 节律行文案：基准 → 实际 · 空闲 · 跳过 · 下次。 */
  function brainRhythmText(brain) {
    const base = Math.max(0, Math.round(num(brain && brain.intervalSec, 180)));
    const effectiveRaw = Number(brain && brain.effectiveIntervalSec);
    const effective = Math.max(0, Math.round(Number.isFinite(effectiveRaw) ? effectiveRaw : base));
    const idle = Math.max(0, Math.round(num(brain && brain.idleStreak, 0)));
    const skipped = Math.max(0, Math.round(num(brain && brain.skippedCycles, 0)));
    const nextIso = brainNextIso(brain);
    let nextText;
    if (!brain || !brain.enabled) nextText = tr('brain.paused');
    else if (nextIso) nextText = fmtRelFuture(nextIso);
    else nextText = tr('brain.waiting');
    return tr('brain.rhythm', {
      base: `${base}s`,
      effective: `${effective}s`,
      idle,
      skipped,
      next: nextText,
    });
  }

  function renderBrainCard() {
    const card = $('#brain-card');
    if (!card) return;
    const brain = state.brain;
    if (!brain || typeof brain !== 'object') {
      card.hidden = true;
      return;
    }
    const scrollY = window.scrollY;
    card.hidden = false;
    const chipView = brainChipView(brain);
    const chip = $('#brain-chip');
    if (chip) {
      chip.textContent = tx(chipView.text);
      chip.dataset.tone = chipView.tone;
    }
    const summary = $('#brain-summary');
    if (summary) {
      const text = str(brain.lastSummary);
      summary.textContent = tx(text || '还没有思考记录');
      summary.title = text || '';
      summary.classList.toggle('is-empty', !text);
    }
    const last = $('#brain-last');
    if (last) {
      last.textContent = tx(brain.lastThinkAt ? fmtRel(brain.lastThinkAt) : '—');
      last.title = brain.lastThinkAt ? fmtDateTime(brain.lastThinkAt) : '';
    }
    const next = $('#brain-next');
    if (next) {
      const nextIso = brainNextIso(brain);
      next.textContent = tx(nextIso ? fmtRelFuture(nextIso) : (brain.enabled ? '等待安排' : '已暂停'));
      next.title = nextIso ? fmtDateTime(nextIso) : '';
    }
    const think = $('#brain-think');
    if (think) {
      const busy = Boolean(state.brainBusy) || Boolean(brain.thinking);
      think.disabled = busy;
      const label = $('#brain-think-label');
      if (label) label.textContent = tx(busy ? '思考中…' : '立即思考');
    }
    const toggleLabel = $('#brain-toggle-label');
    if (toggleLabel) toggleLabel.textContent = tx(brain.enabled ? '暂停' : '启用');
    const errorNode = $('#brain-error');
    if (errorNode) {
      const text = str(state.brainError) || str(brain.lastError);
      errorNode.hidden = !text;
      errorNode.textContent = text ? shorten(text, 80) : '';
      errorNode.title = text || '';
    }
    // 需要主人参与的事项：横幅 + 「知道了」确认（PATCH ownerAskAck）
    const ask = brain.ownerAsk && typeof brain.ownerAsk === 'object' ? brain.ownerAsk : null;
    const askText = ask ? str(ask.text) : '';
    const askBox = $('#brain-owner-ask');
    if (askBox) {
      askBox.hidden = !askText;
      const askLabel = $('#brain-owner-ask-label');
      if (askLabel) askLabel.textContent = tr('brain.ownerAskLabel');
      const askTextNode = $('#brain-owner-ask-text');
      if (askTextNode) {
        askTextNode.textContent = askText;
        askTextNode.title = askText;
      }
      const ackBtn = $('#brain-owner-ack');
      if (ackBtn) {
        ackBtn.textContent = tr('brain.ownerAskAck');
        ackBtn.disabled = Boolean(state.brainBusy);
      }
    }
    // 六步思考摘要：卡片上展示 目标 / 进度 / 我来推进 三步
    const assessBox = $('#brain-assessment');
    if (assessBox) {
      assessBox.replaceChildren();
      const assessmentNode = brainAssessmentNode(brainAssessmentOf(brain), { compact: true });
      assessBox.hidden = !assessmentNode;
      if (assessmentNode) assessBox.appendChild(assessmentNode);
    }
    // 自适应节律行
    const rhythmNode = $('#brain-rhythm');
    if (rhythmNode) {
      rhythmNode.hidden = false;
      rhythmNode.textContent = brainRhythmText(brain);
      rhythmNode.title = tr('brain.rhythmHint');
    }
    if (window.scrollY !== scrollY) window.scrollTo({ top: scrollY, behavior: 'auto' });
  }

  /** 拉取大脑状态与决策历史（设计文档约定的统一入口）。 */
  async function refreshBrain() {
    if (!state.connected) return;
    try {
      const res = await api('/api/brain', { timeout: 12000 });
      if (res && res.brain && typeof res.brain === 'object') state.brain = res.brain;
      if (res && Array.isArray(res.decisions)) state.brainDecisions = res.decisions.slice(0, 20);
      if (state.brain) state.brainError = '';
    } catch (err) {
      if (err.status === 401) return handleAuthLost(err.message);
      // 旧版 Hub 没有大脑接口：静默忽略，卡片保持隐藏
      if (err.status === 404) state.brain = null;
    } finally {
      renderBrainCard();
    }
  }

  function onBrainUpdated(payload) {
    const brain = payload && payload.brain && typeof payload.brain === 'object' ? payload.brain : payload;
    if (!brain || typeof brain !== 'object') return;
    state.brain = brain;
    if (Array.isArray(brain.decisions)) state.brainDecisions = brain.decisions.slice(0, 20);
    state.brainError = '';
    if (state.tab === 'goals') renderBrainCard();
    if (state.drawer.open && state.drawer.kind === 'brain' && !state.brainBusy) {
      void loadBrainDrawer({ preserveScroll: true });
    }
  }

  async function runBrainThink() {
    if (state.brainBusy) return;
    state.brainBusy = true;
    state.brainError = '';
    renderBrainCard();
    try {
      const res = await api('/api/brain/think', { method: 'POST', timeout: 120000 });
      if (res && res.brain && typeof res.brain === 'object') state.brain = res.brain;
      if (res && res.decision) {
        const decision = res.decision;
        state.brainDecisions = [decision, ...arr(state.brainDecisions).filter((item) => item && item.id !== decision.id)].slice(0, 20);
        const summaryText = str(decision.summary);
        toast(summaryText ? `大脑：${shorten(summaryText, 70)}` : '大脑已完成一次思考', 'success', 5200);
      } else {
        const message = str(res && res.error) || '大脑没有返回决策';
        state.brainError = message;
        toast(message, 'warn', 5200);
      }
    } catch (err) {
      if (err.status === 401) return handleAuthLost(err.message);
      const message = err && err.message ? err.message : '立即思考失败';
      state.brainError = message;
      toast(message, 'error', 5200);
    } finally {
      state.brainBusy = false;
      renderBrainCard();
      if (state.drawer.open && state.drawer.kind === 'brain') void loadBrainDrawer({ preserveScroll: true });
    }
  }

  async function toggleBrain() {
    const brain = state.brain;
    if (!brain || state.brainBusy) return;
    const next = !brain.enabled;
    try {
      const res = await api('/api/brain', { method: 'PATCH', body: { enabled: next }, timeout: 12000 });
      if (res && res.brain && typeof res.brain === 'object') state.brain = res.brain;
      state.brainError = '';
      toast(next ? '自主大脑已启用' : '自主大脑已暂停', 'success');
    } catch (err) {
      if (err.status === 401) return handleAuthLost(err.message);
      toast(err.message || '操作失败', 'error');
    } finally {
      renderBrainCard();
      if (state.drawer.open && state.drawer.kind === 'brain') void loadBrainDrawer({ preserveScroll: true });
    }
  }

  /** 确认「需要主人」提醒：PATCH ownerAskAck 后刷新卡片与抽屉。 */
  async function ackBrainOwnerAsk() {
    if (state.brainBusy) return;
    state.brainBusy = true;
    renderBrainCard();
    try {
      const res = await api('/api/brain', { method: 'PATCH', body: { ownerAskAck: true }, timeout: 15000 });
      if (res && res.brain && typeof res.brain === 'object') state.brain = res.brain;
      state.brainError = '';
      toast(tr('brain.ownerAskCleared'), 'success');
    } catch (err) {
      if (err.status === 401) return handleAuthLost(err.message);
      toast(str(err && err.message) || tr('brain.ownerAskFailed'), 'error');
    } finally {
      state.brainBusy = false;
      renderBrainCard();
      if (state.drawer.open && state.drawer.kind === 'brain') void loadBrainDrawer({ preserveScroll: true });
    }
  }

  function openBrainDrawer() {
    openDrawer({
      kind: 'brain',
      id: 'brain',
      title: '自主大脑',
      subNodes: [el('span', { text: '后台定时分析目标与任务，按设置给出建议或执行白名单动作。' })],
      body: el('p', { className: 'goal-checks-empty', text: '正在载入大脑设置…' }),
      footerNodes: [el('button', { type: 'button', className: 'btn btn-ghost btn-sm', text: '关闭', onclick: hideDrawer })],
    });
    void loadBrainDrawer();
  }

  async function loadBrainDrawer({ preserveScroll = false } = {}) {
    if (!state.drawer.open || state.drawer.kind !== 'brain') return;
    const bodyNode = $('#drawer-body');
    const scroll = preserveScroll && bodyNode ? bodyNode.scrollTop : 0;
    try {
      const res = await api('/api/brain', { timeout: 15000 });
      if (res && res.brain && typeof res.brain === 'object') state.brain = res.brain;
      if (res && Array.isArray(res.decisions)) state.brainDecisions = res.decisions.slice(0, 20);
      state.brainError = '';
    } catch (err) {
      if (err.status === 401) return handleAuthLost(err.message);
      state.brainError = err.message || '大脑状态载入失败';
    }
    if (!state.drawer.open || state.drawer.kind !== 'brain') return;
    renderBrainDrawerBody();
    const nextBody = $('#drawer-body');
    if (nextBody) nextBody.scrollTop = scroll;
    renderBrainCard();
  }

  function brainErrorBox(message, label) {
    const text = str(message);
    if (!text) return null;
    return el('div', { className: 'task-error brain-error-box' },
      icon('alert'),
      el('span', { className: 'brain-error-label', text: label }),
      goalRawText('span', 'brain-error-text', text),
    );
  }

  function brainActionNode(action) {
    if (!action || typeof action !== 'object') return null;
    const executed = action.executed === true;
    const skipped = str(action.skippedReason);
    const failed = str(action.error);
    let stateText;
    if (executed) stateText = '已执行';
    else if (skipped) stateText = `跳过：${shorten(skipped, 46)}`;
    else if (failed) stateText = `失败：${shorten(failed, 46)}`;
    else stateText = '未执行';
    const refText = str(action.taskId)
      ? `任务 ${shorten(action.taskId, 12)}`
      : (str(action.goalId) ? `目标 ${shorten(action.goalId, 12)}` : '');
    let confidenceText = '';
    if (Number.isFinite(action.confidence)) {
      const value = action.confidence <= 1 ? action.confidence * 100 : action.confidence;
      confidenceText = `置信度 ${Math.round(value)}%`;
    }
    const row = el('div', { className: 'brain-action-row' },
      el('span', { className: 'brain-action-name', text: BRAIN_ACTION_LABEL[action.action] || str(action.action) || '无动作' }),
      refText ? el('span', { className: 'brain-action-ref', text: refText }) : null,
      el('span', {
        className: 'brain-action-state',
        dataset: { state: executed ? 'executed' : (skipped || failed ? 'skipped' : 'pending') },
        text: stateText,
      }),
      confidenceText ? el('span', { className: 'brain-action-confidence', text: confidenceText }) : null,
    );
    if (str(action.reason)) row.title = action.reason;
    return row;
  }

  function brainDecisionNode(decision) {
    const item = el('article', { className: 'brain-decision' });
    item.appendChild(el('div', { className: 'brain-decision-head' },
      el('span', { className: 'brain-decision-time', text: str(decision.at) ? fmtDateTime(decision.at) : '—' }),
      el('span', { className: 'brain-decision-tag', text: BRAIN_TRIGGER_LABEL[decision.trigger] || str(decision.trigger) || '—' }),
      el('span', { className: 'brain-decision-tag', text: BRAIN_MODE_LABEL[decision.mode] || str(decision.mode) || '—' }),
      Number.isFinite(decision.durationMs) ? el('span', { className: 'brain-decision-duration', text: fmtDuration(decision.durationMs) }) : null,
    ));
    if (str(decision.summary)) item.appendChild(goalRawText('p', 'brain-decision-summary', decision.summary));
    if (str(decision.error)) item.appendChild(goalRawText('p', 'brain-decision-error', decision.error));
    const assessmentNode = brainAssessmentNode(brainAssessmentOf(decision), { compact: true });
    if (assessmentNode) {
      item.appendChild(el('div', { className: 'brain-decision-assessment' },
        el('span', { className: 'brain-decision-assessment-label', text: tr('brain.decisionAssessment') }),
        assessmentNode,
      ));
    }
    const decisionAsk = decision.ownerAsk && typeof decision.ownerAsk === 'object' ? decision.ownerAsk : null;
    if (decisionAsk && str(decisionAsk.text)) {
      item.appendChild(el('div', { className: 'brain-decision-owner-ask' },
        icon('bell'),
        goalRawText('span', '', str(decisionAsk.text)),
      ));
    }
    const actions = arr(decision.actions);
    if (actions.length) {
      const list = el('div', { className: 'brain-decision-actions' });
      for (const action of actions) {
        const row = brainActionNode(action);
        if (row) list.appendChild(row);
      }
      item.appendChild(list);
    }
    return item;
  }

  function renderBrainDrawerBody() {
    const brain = state.brain;
    if (!brain) {
      const body = el('div', { className: 'link-picker' },
        brainErrorBox(state.brainError || '当前 Hub 暂不支持自主大脑，请更新后端后再试。', '无法载入'),
        el('p', {
          className: 'goal-form-hint',
          text: '自主大脑依赖 Hub 后端的 /api/brain 接口（BRAIN_API_KEY / AGNES_API_KEY 配置模型后可用）。',
        }),
      );
      updateDrawerContent({
        title: '自主大脑',
        subNodes: [el('span', { text: '大脑状态载入失败。' })],
        body,
        footerNodes: [el('button', { type: 'button', className: 'btn btn-ghost btn-sm', text: '关闭', onclick: hideDrawer })],
      });
      return;
    }
    const body = el('div');
    const chipView = brainChipView(brain);

    body.appendChild(el('div', { className: 'brain-drawer-status' },
      el('span', { className: 'brain-chip', dataset: { tone: chipView.tone }, text: chipView.text }),
      el('span', {
        className: 'brain-drawer-model',
        text: brain.configured ? `模型 ${str(brain.model) || '默认'}` : '未配置模型（需要 BRAIN_API_KEY / AGNES_API_KEY）',
      }),
    ));
    const errorBox = brainErrorBox(str(brain.lastError) || state.brainError, '上次错误');
    if (errorBox) body.appendChild(errorBox);

    // 六步思考（完整六行）
    const assessment = brainAssessmentOf(brain);
    const assessmentSection = el('section', { className: 'detail-section' },
      el('div', { className: 'detail-section-head' },
        el('h3', { text: tr('brain.assessmentTitle') }),
        el('span', { className: 'count', text: brain.lastThinkAt ? fmtDateTime(brain.lastThinkAt) : '' }),
      ),
    );
    const fullAssessment = brainAssessmentNode(assessment);
    assessmentSection.appendChild(fullAssessment || el('p', { className: 'goal-checks-empty', text: tr('brain.assessmentEmpty') }));
    body.appendChild(assessmentSection);

    // 需要主人参与
    const drawerAsk = brain.ownerAsk && typeof brain.ownerAsk === 'object' ? brain.ownerAsk : null;
    if (drawerAsk && str(drawerAsk.text)) {
      const askAckBtn = el('button', { type: 'button', className: 'btn btn-ghost btn-sm', text: tr('brain.ownerAskAck') });
      askAckBtn.addEventListener('click', () => {
        askAckBtn.disabled = true;
        void ackBrainOwnerAsk();
      });
      body.appendChild(el('section', { className: 'detail-section' },
        el('div', { className: 'detail-section-head' }, el('h3', { text: tr('brain.ownerAskTitle') })),
        el('div', { className: 'brain-owner-ask is-drawer' },
          el('span', { className: 'brain-owner-ask-icon' }, icon('bell')),
          el('div', { className: 'brain-owner-ask-main' },
            el('strong', { text: tr('brain.ownerAskLabel') }),
            goalRawText('p', 'brain-owner-ask-text', drawerAsk.text),
            str(drawerAsk.goalId)
              ? el('span', { className: 'brain-owner-ask-goal', text: tr('brain.ownerAskGoal', { id: shorten(str(drawerAsk.goalId), 16) }) })
              : null,
          ),
          askAckBtn,
        ),
      ));
    }

    const form = el('form', { className: 'brain-form', attrs: { novalidate: 'novalidate' } });
    const modeSelect = el('select', { attrs: { 'aria-label': '执行模式' } },
      el('option', { value: 'auto', text: '自动执行' }),
      el('option', { value: 'suggest', text: '只给建议' }),
    );
    modeSelect.value = brain.mode === 'suggest' ? 'suggest' : 'auto';
    const intervalMinutes = Math.max(1, Math.min(60, Math.round(num(brain.intervalSec, 180) / 60)));
    const intervalInput = el('input', {
      type: 'number', value: String(intervalMinutes),
      attrs: { min: '1', max: '60', step: '1', inputmode: 'numeric', 'aria-label': '思考间隔（分钟）' },
    });
    const actionsValue = Math.max(1, Math.min(3, Math.round(num(brain.maxActions, 2))));
    const maxActionsInput = el('input', {
      type: 'number', value: String(actionsValue),
      attrs: { min: '1', max: '3', step: '1', inputmode: 'numeric', 'aria-label': '每次最多动作数' },
    });
    form.appendChild(el('div', { className: 'field' },
      el('label', { text: '执行模式' }),
      modeSelect,
      el('span', { className: 'field-hint', text: '自动执行会真的改动任务；只给建议只记录决策，不动任何任务。' }),
    ));
    form.appendChild(el('div', { className: 'field-row brain-form-row' },
      el('div', { className: 'field' },
        el('label', { text: '思考间隔（分钟）' }),
        intervalInput,
        el('span', { className: 'field-hint', text: '范围 1–60 分钟（后端限制 60–3600 秒）。' }),
      ),
      el('div', { className: 'field' },
        el('label', { text: '每次最多动作数' }),
        maxActionsInput,
        el('span', { className: 'field-hint', text: '取值范围 1–3。' }),
      ),
    ));
    const adaptiveInput = el('input', { type: 'checkbox' });
    adaptiveInput.checked = brain.adaptive !== false;
    form.appendChild(el('div', { className: 'field' },
      el('label', { className: 'brain-adaptive-toggle' }, adaptiveInput, el('span', { text: tr('brain.adaptiveLabel') })),
      el('span', { className: 'field-hint', text: tr('brain.adaptiveHint') }),
    ));
    const saveBtn = el('button', { type: 'button', className: 'btn btn-primary btn-sm' }, icon('check'), el('span', { text: '保存设置' }));
    saveBtn.addEventListener('click', async () => {
      if (saveBtn.disabled) return;
      const minutes = Math.max(1, Math.min(60, Math.round(Number(intervalInput.value) || intervalMinutes)));
      const actions = Math.max(1, Math.min(3, Math.round(Number(maxActionsInput.value) || actionsValue)));
      intervalInput.value = String(minutes);
      maxActionsInput.value = String(actions);
      saveBtn.disabled = true;
      const label = saveBtn.querySelector('span');
      if (label) label.textContent = tx('保存中…');
      try {
        const res = await api('/api/brain', {
          method: 'PATCH',
          body: { mode: modeSelect.value, intervalSec: minutes * 60, maxActions: actions, adaptive: Boolean(adaptiveInput.checked) },
          timeout: 15000,
        });
        if (res && res.brain && typeof res.brain === 'object') state.brain = res.brain;
        state.brainError = '';
        toast('大脑设置已保存', 'success');
        await loadBrainDrawer({ preserveScroll: true });
      } catch (err) {
        if (err.status === 401) return handleAuthLost(err.message);
        state.brainError = err.message || '保存设置失败';
        toast(state.brainError, 'error');
        if (state.drawer.open && state.drawer.kind === 'brain') renderBrainDrawerBody();
      } finally {
        saveBtn.disabled = false;
        if (label) label.textContent = tx('保存设置');
      }
    });
    body.appendChild(el('section', { className: 'detail-section' },
      el('div', { className: 'detail-section-head' },
        el('h3', { text: '大脑设置' }),
        el('span', { className: 'count', text: tr(!brain.enabled ? 'brain.paused' : (brain.adaptive === false ? 'brain.adaptiveOff' : 'brain.adaptiveOn')) }),
      ),
      el('p', { className: 'brain-rhythm is-drawer', text: brainRhythmText(brain) }),
      el('p', { className: 'goal-form-hint', text: tr('brain.rhythmHint') }),
      form,
      el('div', { className: 'brain-form-actions' }, saveBtn),
    ));

    if (str(brain.lastSummary)) {
      body.appendChild(el('section', { className: 'detail-section' },
        el('div', { className: 'detail-section-head' },
          el('h3', { text: '最近思考摘要' }),
          el('span', { className: 'count', text: brain.lastThinkAt ? fmtDateTime(brain.lastThinkAt) : '' }),
        ),
        goalRawText('p', 'brain-last-summary', brain.lastSummary),
      ));
    }

    const decisions = arr(state.brainDecisions).slice(0, 20);
    const history = el('section', { className: 'detail-section' },
      el('div', { className: 'detail-section-head' },
        el('h3', { text: '思考记录' }),
        el('span', { className: 'count', text: `${decisions.length} 条` }),
      ),
    );
    if (!decisions.length) {
      history.appendChild(el('p', { className: 'goal-checks-empty', text: '还没有思考记录。点「立即思考」让大脑分析一次。' }));
    } else {
      const list = el('div', { className: 'brain-decisions' });
      for (const decision of decisions) list.appendChild(brainDecisionNode(decision));
      history.appendChild(list);
    }
    body.appendChild(history);

    const thinkBtn = el('button', {
      type: 'button', className: 'btn btn-primary btn-sm', text: '立即思考',
    });
    thinkBtn.prepend(icon('spark'));
    const busy = Boolean(state.brainBusy) || Boolean(brain.thinking);
    thinkBtn.disabled = busy;
    if (busy) {
      const label = thinkBtn.querySelector('span');
      if (label) label.textContent = tx('思考中…');
    }
    thinkBtn.addEventListener('click', async () => {
      if (thinkBtn.disabled) return;
      thinkBtn.disabled = true;
      const label = thinkBtn.querySelector('span');
      if (label) label.textContent = tx('思考中…');
      await runBrainThink();
    });

    updateDrawerContent({
      title: '自主大脑',
      subNodes: [el('span', { text: '后台定时分析目标与任务，按设置给出建议或执行白名单动作。' })],
      body,
      footerNodes: [
        el('button', { type: 'button', className: 'btn btn-ghost btn-sm', text: '关闭', onclick: hideDrawer }),
        el('span', { className: 'spacer' }),
        thinkBtn,
      ],
    });
  }

  /* ==================================================================
   * 管家心路（思考、动作与每日实质推进）
   * ================================================================== */

  function journalTz() {
    const journal = state.journal || {};
    return str(journal.timeZone) || 'Asia/Kuala_Lumpur';
  }

  function journalDateInTz(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: journalTz(),
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(date);
    } catch {
      return date.toISOString().slice(0, 10);
    }
  }

  function journalToday() {
    const journal = state.journal || {};
    return str(journal.today) || journalDateInTz(Date.now());
  }

  function journalDateKey(entry) {
    if (!entry) return '';
    return str(entry.date) || journalDateInTz(entry.at);
  }

  function journalTimeLabel(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '--:--';
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: journalTz(),
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(date);
    } catch {
      return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    }
  }

  function journalDayLabel(dateStr) {
    if (!dateStr) return '';
    if (dateStr === journalToday()) return tr('journal.today');
    const date = new Date(`${dateStr}T12:00:00`);
    if (Number.isNaN(date.getTime())) return dateStr;
    let label = fmtDate(date.toISOString());
    try {
      const week = new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(date);
      if (week) label += ` ${week}`;
    } catch {
      /* 时区数据缺失时只显示日期 */
    }
    return label;
  }

  function journalGroups() {
    const journal = state.journal || {};
    const days = Array.isArray(journal.days) ? journal.days : [];
    const entries = Array.isArray(journal.entries) ? journal.entries : [];
    const byDate = new Map();
    for (const day of days) {
      if (day && day.date) byDate.set(str(day.date), { day, entries: [] });
    }
    for (const entry of entries) {
      if (!entry) continue;
      const key = journalDateKey(entry);
      if (!key) continue;
      let group = byDate.get(key);
      if (!group) {
        group = { day: null, entries: [] };
        byDate.set(key, group);
      }
      group.entries.push(entry);
    }
    const keys = Array.from(byDate.keys()).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    for (const key of keys) {
      const group = byDate.get(key);
      group.entries.sort((a, b) => {
        const ta = Date.parse(a.at) || 0;
        const tb = Date.parse(b.at) || 0;
        return tb - ta;
      });
    }
    return keys.map((key) => ({ key, ...byDate.get(key) }));
  }

  function journalVisibleGroups() {
    const filter = JOURNAL_FILTERS.some((item) => item.id === state.journalFilter) ? state.journalFilter : 'all';
    const today = journalToday();
    const groups = journalGroups();
    return groups
      .map((group) => {
        const day = group.day;
        if (filter === 'all') return group;
        if (filter === 'daily') {
          if (!(day && day.summary) && group.key !== today) return null;
          return { ...group, entries: group.entries.filter((entry) => str(entry.kind) === 'daily') };
        }
        const entries = group.entries.filter((entry) => str(entry.kind) === filter);
        if (!entries.length && !(day && day.summary)) return null;
        return { ...group, entries };
      })
      .filter(Boolean);
  }

  function ensureJournalLoaded() {
    if (!state.connected) return;
    if (state.journalBusy) return;
    if (state.journal && !state.journalDirty) {
      renderJournal();
      return;
    }
    void loadJournal({ silent: Boolean(state.journal) });
  }

  async function loadJournal({ silent = false } = {}) {
    if (state.journalBusy) return;
    if (!state.connected) {
      renderJournal();
      return;
    }
    state.journalBusy = true;
    renderJournal();
    try {
      const params = `days=${encodeURIComponent(state.journalDays || 60)}&entries=300`;
      const res = await api(`/api/journal?${params}`, { timeout: 15000 });
      const journal = res && res.journal && typeof res.journal === 'object' ? res.journal : {};
      let entries = res && Array.isArray(res.entries) ? res.entries : null;
      if (!entries) entries = Array.isArray(journal.entries) ? journal.entries : [];
      state.journal = {
        ...journal,
        days: Array.isArray(journal.days) ? journal.days : [],
        entries,
      };
      state.journalError = '';
      state.journalDirty = false;
    } catch (err) {
      if (err && err.status === 401) {
        handleAuthLost(err.message);
        return;
      }
      if (err && err.status === 404) {
        state.journalError = tr('journal.unsupported');
      } else if (!silent || !state.journal) {
        state.journalError = `${tr('journal.loadFailed')}：${str(err && err.message) || '未知错误'}`;
      }
    } finally {
      state.journalBusy = false;
      renderJournal();
    }
  }

  function scheduleJournalReload() {
    clearTimeout(journalReloadTimer);
    journalReloadTimer = setTimeout(() => {
      journalReloadTimer = 0;
      void loadJournal({ silent: Boolean(state.journal) });
    }, 500);
  }

  function onJournalUpdated(payload) {
    // Hub 在设置变化/追加条目时可能带上整份 journal 快照，能直接用时就不必再拉接口。
    if (payload && payload.journal && typeof payload.journal === 'object'
      && Array.isArray(payload.journal.entries) && Array.isArray(payload.journal.days)) {
      state.journal = {
        ...(state.journal || {}),
        ...payload.journal,
        days: payload.journal.days,
        entries: payload.journal.entries,
      };
      state.journalError = '';
      state.journalDirty = false;
      if (state.tab === 'journal') renderJournal();
      return;
    }
    state.journalDirty = true;
    if (state.tab === 'journal') scheduleJournalReload();
  }

  function journalRefChip(kind, id) {
    const text = shorten(id, 16);
    const keys = { task: 'journal.refTask', goal: 'journal.refGoal', decision: 'journal.refDecision' };
    const label = tr(keys[kind] || keys.decision, { id: text });
    if (kind === 'task') {
      return el('button', {
        type: 'button',
        className: 'journal-ref',
        attrs: { title: id },
        text: label,
        onclick: () => openTaskDrawer(id),
      });
    }
    if (kind === 'goal') {
      return el('button', {
        type: 'button',
        className: 'journal-ref',
        attrs: { title: id },
        text: label,
        onclick: () => openGoalDrawer(id),
      });
    }
    return el('span', { className: 'journal-ref is-static', attrs: { title: id }, text: label });
  }

  function journalEntryNode(entry) {
    const kind = JOURNAL_KIND_META[entry.kind] ? entry.kind : 'thought';
    const meta = JOURNAL_KIND_META[kind];
    const node = el('article', { className: 'journal-entry', dataset: { kind } });
    const head = el('div', { className: 'journal-entry-head' });
    const kindNode = el('span', { className: `journal-kind is-${meta.tone}` });
    kindNode.appendChild(icon(meta.iconName));
    kindNode.appendChild(el('span', { text: tr(meta.i18n) }));
    head.appendChild(kindNode);
    head.appendChild(el('span', { className: 'journal-entry-time', text: journalTimeLabel(entry.at) }));
    const refs = entry.refs && typeof entry.refs === 'object' ? entry.refs : {};
    if (str(refs.taskId)) head.appendChild(journalRefChip('task', str(refs.taskId)));
    if (str(refs.goalId)) head.appendChild(journalRefChip('goal', str(refs.goalId)));
    if (str(refs.decisionId)) head.appendChild(journalRefChip('decision', str(refs.decisionId)));
    node.appendChild(head);
    if (str(entry.title)) node.appendChild(goalRawText('h4', 'journal-entry-title', str(entry.title)));
    const text = str(entry.text);
    if (text) {
      const bodyNode = goalRawText('div', 'journal-entry-text', '');
      bodyNode.innerHTML = renderMarkdownHtml(text);
      node.appendChild(bodyNode);
    }
    return node;
  }

  function journalSummaryCard(day) {
    const card = el('article', { className: 'journal-summary-card' });
    const head = el('div', { className: 'journal-summary-head' });
    head.appendChild(el('h4', { className: 'journal-summary-title', text: tr('journal.summaryTitle') }));
    const meta = el('div', { className: 'journal-summary-meta' });
    if (str(day.generatedAt)) meta.appendChild(el('span', { text: tr('journal.generatedAt', { time: journalTimeLabel(day.generatedAt) }) }));
    if (str(day.model)) meta.appendChild(el('span', { text: tr('journal.model', { model: day.model }) }));
    if (num(day.entryCount, 0) > 0) meta.appendChild(el('span', { text: tr('journal.dayCount', { n: day.entryCount }) }));
    if (meta.childElementCount) head.appendChild(meta);
    if (str(day.date)) {
      head.appendChild(el('button', {
        type: 'button',
        className: 'btn btn-ghost btn-sm',
        text: tr('journal.regenerate'),
        dataset: { journalDaySummary: str(day.date) },
        onclick: () => void generateJournalSummary(str(day.date)),
      }));
    }
    card.appendChild(head);
    if (str(day.error)) card.appendChild(el('p', { className: 'journal-summary-error', text: str(day.error) }));
    const highlights = Array.isArray(day.highlights) ? day.highlights.filter(Boolean) : [];
    if (highlights.length) {
      const chips = el('div', { className: 'journal-highlights' });
      for (const item of highlights) {
        const text = typeof item === 'string' ? item : str(item && item.text);
        if (!text) continue;
        chips.appendChild(el('span', { className: 'journal-highlight', text }));
      }
      if (chips.childElementCount) card.appendChild(chips);
    }
    const stats = day.stats && typeof day.stats === 'object' ? day.stats : null;
    if (stats) {
      const pieces = [];
      if (num(stats.thought, 0) > 0) pieces.push(tr('journal.statsThought', { n: stats.thought }));
      if (num(stats.work, 0) > 0) pieces.push(tr('journal.statsWork', { n: stats.work }));
      if (num(stats.milestone, 0) > 0) pieces.push(tr('journal.statsMilestone', { n: stats.milestone }));
      pieces.push(tr('journal.statsTotal', { n: num(stats.total, 0) }));
      if (num(stats.completedTasks, 0) > 0) pieces.push(tr('journal.statsCompleted', { n: stats.completedTasks }));
      if (num(stats.failedTasks, 0) > 0) pieces.push(tr('journal.statsFailed', { n: stats.failedTasks }));
      card.appendChild(el('p', { className: 'journal-stats', text: pieces.join(' · ') }));
    }
    if (str(day.summary)) {
      const md = el('div', { className: 'journal-summary-md' });
      md.innerHTML = renderMarkdownHtml(str(day.summary));
      card.appendChild(md);
    }
    return card;
  }

  function journalSummaryMissing(dateStr) {
    const box = el('div', { className: 'journal-summary-missing' });
    box.appendChild(el('span', { text: tr('journal.noSummary') }));
    box.appendChild(el('button', {
      type: 'button',
      className: 'btn btn-ghost btn-sm',
      text: tr('journal.generate'),
      dataset: { journalDaySummary: dateStr },
      onclick: () => void generateJournalSummary(dateStr),
    }));
    return box;
  }

  function journalDayNode(group) {
    const day = group.day;
    const dateStr = str(day && day.date) || group.key;
    const node = el('section', { className: 'journal-day' });
    const count = group.entries.length || num(day && day.entryCount, 0) || 0;
    node.appendChild(el('div', { className: 'journal-day-head' },
      el('h3', { className: 'journal-day-date', text: journalDayLabel(dateStr) }),
      el('span', { className: 'journal-day-count', text: tr('journal.dayCount', { n: count }) }),
    ));
    const filter = state.journalFilter || 'all';
    if (day && str(day.summary)) {
      node.appendChild(journalSummaryCard(day));
    } else if (day && (filter === 'all' || filter === 'daily')) {
      node.appendChild(journalSummaryMissing(dateStr));
    } else if (filter === 'daily') {
      node.appendChild(journalSummaryMissing(dateStr));
    }
    if (group.entries.length) {
      const list = el('div', { className: 'journal-entries' });
      for (const entry of group.entries) list.appendChild(journalEntryNode(entry));
      node.appendChild(list);
    }
    return node;
  }

  function journalErrorState() {
    const box = el('div', { className: 'journal-load-error' });
    box.appendChild(el('p', { text: state.journalError || tr('journal.loadFailed') }));
    box.appendChild(el('button', {
      type: 'button',
      className: 'btn btn-ghost btn-sm',
      text: tr('journal.retry'),
      onclick: () => {
        state.journalError = '';
        void loadJournal({ silent: false });
      },
    }));
    return box;
  }

  function renderJournalControls() {
    const box = $('#journal-controls');
    if (!box) return;
    const lang = currentLang();
    if (box.dataset.lang !== lang || !box.childElementCount) {
      box.dataset.lang = lang;
      box.replaceChildren();
      const filters = el('div', { className: 'journal-filters' });
      for (const item of JOURNAL_FILTERS) {
        filters.appendChild(el('button', {
          type: 'button',
          className: 'journal-filter',
          text: tr(item.i18n),
          dataset: { journalFilter: item.id },
        }));
      }
      box.appendChild(filters);
      const journal = state.journal || {};
      const settings = el('div', { className: 'journal-settings', attrs: { title: tr('journal.settingsHint') } });
      const toggle = el('label', { className: 'journal-toggle' });
      const checkbox = el('input', { type: 'checkbox', attrs: { id: 'journal-enabled' } });
      checkbox.checked = Boolean(journal.enabled);
      toggle.appendChild(checkbox);
      toggle.appendChild(el('span', { text: tr('journal.autoRecord') }));
      settings.appendChild(toggle);
      const timeWrap = el('label', { className: 'journal-time' });
      timeWrap.appendChild(el('span', { text: tr('journal.summaryTime') }));
      const timeInput = el('input', { type: 'time', attrs: { id: 'journal-time' } });
      timeInput.value = str(journal.summaryTime) || '23:30';
      timeWrap.appendChild(timeInput);
      settings.appendChild(timeWrap);
      settings.appendChild(el('button', {
        type: 'button',
        className: 'btn btn-ghost btn-sm',
        attrs: { id: 'journal-save' },
        text: tr('journal.save'),
      }));
      box.appendChild(settings);
      box.appendChild(el('p', { className: 'journal-counts', attrs: { id: 'journal-counts' } }));
    }
    const filter = state.journalFilter || 'all';
    box.querySelectorAll('[data-journal-filter]').forEach((btn) => {
      const active = btn.dataset.journalFilter === filter;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    const journal = state.journal || {};
    const enabledBox = $('#journal-enabled');
    if (enabledBox) enabledBox.checked = Boolean(journal.enabled);
    const timeInput = $('#journal-time');
    if (timeInput && document.activeElement !== timeInput) timeInput.value = str(journal.summaryTime) || '23:30';
    const saveBtn = $('#journal-save');
    if (saveBtn) {
      saveBtn.disabled = Boolean(state.journalBusy);
      saveBtn.textContent = tr(state.journalBusy ? 'journal.saving' : 'journal.save');
    }
    const counts = $('#journal-counts');
    if (counts) {
      counts.textContent = state.journal
        ? tr('journal.sub', {
          entries: (state.journal.entries || []).length,
          days: (state.journal.days || []).length,
        })
        : '';
    }
  }

  function renderJournal() {
    const body = $('#journal-body');
    if (!body) return;
    renderJournalControls();
    const errBox = $('#journal-error');
    if (errBox) {
      errBox.textContent = state.journalError || '';
      errBox.hidden = !state.journalError;
    }
    const nowBtn = $('#journal-summary-now');
    if (nowBtn) {
      nowBtn.disabled = Boolean(state.journalBusy);
      const label = nowBtn.querySelector('span');
      if (label) label.textContent = tr(state.journalBusy ? 'journal.generating' : 'journal.generateToday');
    }
    const scrollTop = body.scrollTop;
    body.replaceChildren();
    if (!state.journal) {
      if (state.journalError) {
        body.appendChild(journalErrorState());
      } else {
        body.appendChild(el('p', { className: 'journal-loading', text: tr('journal.loading') }));
      }
      body.scrollTop = scrollTop;
      return;
    }
    const groups = journalVisibleGroups();
    if (!groups.length) {
      body.appendChild(emptyState({
        iconName: 'activity',
        title: tr('journal.emptyTitle'),
        desc: tr('journal.emptyDesc'),
      }));
    } else {
      for (const group of groups) body.appendChild(journalDayNode(group));
      if (state.journalBusy) body.appendChild(el('p', { className: 'journal-loading', text: tr('journal.loading') }));
    }
    body.scrollTop = scrollTop;
  }

  async function generateJournalSummary(date) {
    if (state.journalBusy) return;
    state.journalBusy = true;
    renderJournal();
    try {
      const payload = { force: true };
      if (str(date)) payload.date = str(date);
      const res = await api('/api/journal/summary', { method: 'POST', body: payload, timeout: 120000 });
      const day = res && res.day;
      const error = str(res && res.error) || str(day && day.error);
      if (error) toast(tr('journal.summaryFailed', { message: error }), 'error');
      else toast(tr('journal.summaryDone'), 'success');
    } catch (err) {
      if (err && err.status === 401) {
        handleAuthLost(err.message);
        return;
      }
      if (err && err.status === 404) state.journalError = tr('journal.unsupported');
      toast(tr('journal.summaryFailed', { message: str(err && err.message) || '未知错误' }), 'error');
    } finally {
      state.journalBusy = false;
      void loadJournal({ silent: true });
    }
  }

  async function saveJournalSettings() {
    if (state.journalBusy) return;
    const enabledBox = $('#journal-enabled');
    const timeInput = $('#journal-time');
    const time = timeInput ? str(timeInput.value).trim() : '';
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      toast(tr('journal.invalidTime'), 'error');
      return;
    }
    state.journalBusy = true;
    renderJournal();
    try {
      await api('/api/journal', {
        method: 'PATCH',
        body: { enabled: Boolean(enabledBox && enabledBox.checked), summaryTime: time },
        timeout: 15000,
      });
      toast(tr('journal.settingsSaved'), 'success');
    } catch (err) {
      if (err && err.status === 401) {
        handleAuthLost(err.message);
        return;
      }
      if (err && err.status === 404) state.journalError = tr('journal.unsupported');
      toast(str(err && err.message) || tr('journal.loadFailed'), 'error');
    } finally {
      state.journalBusy = false;
      void loadJournal({ silent: true });
    }
  }

  /* ==================================================================
   * 头脑风暴（对话大脑）
   * ================================================================== */
  function brainstormTextOf(message) {
    return message && typeof message.text === 'string' ? message.text : '';
  }

  function brainstormCurrentId() {
    if (state.brainstormSession && state.brainstormSession.id) return state.brainstormSession.id;
    if (state.brainstorm && state.brainstorm.activeId) return state.brainstorm.activeId;
    return '';
  }

  function brainstormSessionSummaryFrom(session) {
    const messages = arr(session && session.messages);
    const last = messages.length ? messages[messages.length - 1] : null;
    const firstUser = messages.find((item) => item && item.role === 'user') || null;
    return {
      id: str(session && session.id),
      title: str(session && session.title)
        || (firstUser ? shorten(brainstormTextOf(firstUser), 40) : tr('brainstorm.sessionTitleFallback')),
      createdAt: session && session.createdAt,
      updatedAt: str(session && session.updatedAt) || (last ? str(last.at) : ''),
      messageCount: messages.length,
      lastMessageAt: last ? str(last.at) : '',
      preview: last ? shorten(brainstormTextOf(last), 60) : '',
    };
  }

  function brainstormUpsertSummary(summary) {
    if (!summary || !summary.id) return;
    const exists = state.brainstormSessions.some((item) => item && item.id === summary.id);
    state.brainstormSessions = exists
      ? state.brainstormSessions.map((item) => (item.id === summary.id ? { ...item, ...summary } : item))
      : [summary, ...state.brainstormSessions];
  }

  function ensureBrainstormLoaded() {
    if (!state.connected) return;
    if (state.brainstorm && state.brainstorm.supported === false) {
      renderBrainstorm();
      return;
    }
    if (!state.brainstorm && !state.brainstormBusy) {
      void loadBrainstorm();
      return;
    }
    renderBrainstorm();
  }

  async function loadBrainstorm({ sessionId = '', silent = false } = {}) {
    if (!state.connected) return;
    const seq = ++brainstormLoadSeq;
    if (!silent) {
      state.brainstormBusy = true;
      renderBrainstorm();
    }
    const targetId = str(sessionId) || brainstormCurrentId();
    try {
      const query = `messages=200${targetId ? `&session=${encodeURIComponent(targetId)}` : ''}`;
      const res = await api(`/api/brainstorm?${query}`, { timeout: 20000 });
      if (seq !== brainstormLoadSeq) return;
      const data = res && res.brainstorm && typeof res.brainstorm === 'object' ? res.brainstorm : {};
      state.brainstormSessions = arr(data.sessions);
      state.brainstormSession = res && res.session ? res.session : null;
      state.brainstorm = {
        activeId: str(data.activeId) || str(state.brainstormSession && state.brainstormSession.id) || targetId || '',
        supported: true,
      };
      if (state.brainstormSession) {
        state.brainstorm.activeId = state.brainstormSession.id;
        brainstormUpsertSummary(brainstormSessionSummaryFrom(state.brainstormSession));
      }
      state.brainstormError = '';
      state.brainstormBusy = false;
    } catch (err) {
      if (seq !== brainstormLoadSeq) return;
      state.brainstormBusy = false;
      if (err && err.status === 401) {
        handleAuthLost(err.message);
        return;
      }
      if (!silent) {
        if (err && err.status === 404) {
          state.brainstorm = { activeId: '', supported: false };
          state.brainstormError = tr('brainstorm.unsupported');
        } else {
          state.brainstormError = str(err && err.message) || tr('brainstorm.loadFailed');
        }
      }
    }
    renderBrainstorm(!silent);
  }

  function scheduleBrainstormRefresh() {
    clearTimeout(brainstormRefreshTimer);
    brainstormRefreshTimer = setTimeout(() => {
      brainstormRefreshTimer = 0;
      if (state.tab === 'brainstorm' && state.connected) void loadBrainstorm({ silent: true });
    }, 500);
  }

  function onBrainstormUpdated(payload) {
    const session = payload && payload.session && typeof payload.session === 'object' ? payload.session : null;
    if (!session || !session.id) {
      scheduleBrainstormRefresh();
      return;
    }
    // 发送请求自己会带回同一会话的最新状态，避免和 SSE 交叉覆盖
    if (state.brainstormSending) return;
    const summary = brainstormSessionSummaryFrom(session);
    const isCurrent = Boolean(state.brainstormSession && state.brainstormSession.id === session.id);
    if (isCurrent) {
      state.brainstormSession = session;
      state.brainstorm = { ...(state.brainstorm || {}), activeId: session.id, supported: true };
    } else if (!state.brainstorm) {
      state.brainstorm = { activeId: session.id, supported: true };
    }
    brainstormUpsertSummary(summary);
    if (state.tab === 'brainstorm') renderBrainstorm();
  }

  function selectBrainstormSession(id) {
    const sid = str(id);
    if (!sid) return;
    if (state.brainstormSession && state.brainstormSession.id === sid) return;
    state.brainstormSending = false;
    state.brainstormSession = null;
    state.brainstormBusy = true;
    renderBrainstorm();
    void loadBrainstorm({ sessionId: sid });
  }

  async function newBrainstormSession() {
    if (state.brainstormBusy || !state.connected) return;
    state.brainstormBusy = true;
    state.brainstormError = '';
    renderBrainstorm();
    try {
      const res = await api('/api/brainstorm/sessions', { method: 'POST', body: {}, timeout: 20000 });
      const sessions = arr(res && res.brainstorm && res.brainstorm.sessions);
      if (sessions.length) state.brainstormSessions = sessions;
      if (res && res.session) {
        state.brainstormSession = res.session;
        state.brainstorm = { activeId: res.session.id, supported: true };
        brainstormUpsertSummary(brainstormSessionSummaryFrom(res.session));
      }
      state.brainstormError = '';
    } catch (err) {
      if (err && err.status === 401) {
        handleAuthLost(err.message);
        return;
      }
      state.brainstormError = str(err && err.message) || tr('brainstorm.newFailed');
      toast(state.brainstormError, 'error');
    } finally {
      state.brainstormBusy = false;
      renderBrainstorm(true);
      const input = $('#brainstorm-input');
      if (input) input.focus();
    }
  }

  async function deleteBrainstormSession(id) {
    const sid = str(id);
    if (!sid) return;
    const ok = await confirmDialog({
      title: tr('brainstorm.delete'),
      message: tr('brainstorm.deleteConfirm'),
      okText: tr('brainstorm.delete'),
    });
    if (!ok) return;
    try {
      const res = await api(`/api/brainstorm/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE', timeout: 15000 });
      const data = res && res.brainstorm && typeof res.brainstorm === 'object' ? res.brainstorm : {};
      state.brainstormSessions = arr(data.sessions);
      state.brainstorm = { activeId: str(data.activeId), supported: true };
      if (state.brainstormSession && state.brainstormSession.id === sid) state.brainstormSession = null;
      toast(tr('brainstorm.deleted'), 'success');
      const activeId = str(data.activeId) || str(state.brainstormSessions[0] && state.brainstormSessions[0].id);
      if (activeId) await loadBrainstorm({ sessionId: activeId });
      else renderBrainstorm();
    } catch (err) {
      if (err && err.status === 401) {
        handleAuthLost(err.message);
        return;
      }
      if (err && err.status === 404) {
        void loadBrainstorm({ silent: true });
        return;
      }
      toast(str(err && err.message) || tr('brainstorm.deleteFailed'), 'error');
    }
  }

  async function sendBrainstorm() {
    if (state.brainstormSending || !state.connected) return;
    const input = $('#brainstorm-input');
    if (!input) return;
    const message = str(input.value).trim();
    if (!message) return;
    const sessionId = brainstormCurrentId();
    const now = new Date().toISOString();
    const previous = state.brainstormSession;
    const optimisticMessages = previous && sessionId
      ? arr(previous.messages).concat([{ id: `local_${Date.now()}`, role: 'user', at: now, text: message }])
      : [{ id: `local_${Date.now()}`, role: 'user', at: now, text: message }];
    state.brainstormSession = previous && sessionId
      ? { ...previous, messages: optimisticMessages }
      : { id: '', title: tr('brainstorm.sessionTitleFallback'), createdAt: now, updatedAt: now, messages: optimisticMessages };
    state.brainstormSending = true;
    state.brainstormError = '';
    input.value = '';
    renderBrainstorm(true);
    try {
      const body = sessionId ? { sessionId, message } : { message };
      const res = await api('/api/brainstorm/chat', { method: 'POST', body, timeout: 130000 });
      if (res && res.session) {
        state.brainstormSession = res.session;
        state.brainstorm = { activeId: res.session.id, supported: true };
        brainstormUpsertSummary(brainstormSessionSummaryFrom(res.session));
      }
      if (!res || !res.session) state.brainstormSession = previous;
    } catch (err) {
      state.brainstormSession = previous;
      if (err && err.status === 401) {
        handleAuthLost(err.message);
        return;
      }
      state.brainstormError = err && err.status === 404
        ? tr('brainstorm.unsupported')
        : (str(err && err.message) || tr('brainstorm.sendFailed'));
      toast(state.brainstormError, 'error');
      if (!input.value) input.value = message;
    } finally {
      state.brainstormSending = false;
      renderBrainstorm(true);
      if (input) input.focus();
    }
  }

  async function brainstormToTask(sessionId, messageId, goalId) {
    const sid = str(sessionId);
    const mid = str(messageId);
    if (!sid || !mid) return;
    try {
      const body = { sessionId: sid, messageId: mid };
      if (str(goalId)) body.goalId = str(goalId);
      const res = await api('/api/brainstorm/to-task', { method: 'POST', body, timeout: 30000 });
      if (res && res.session) {
        if (state.brainstormSession && state.brainstormSession.id === res.session.id) {
          state.brainstormSession = res.session;
        }
        brainstormUpsertSummary(brainstormSessionSummaryFrom(res.session));
      }
      toast(tr('brainstorm.toTaskCreated'), 'success');
      if (res && res.task && res.task.id) {
        upsertTask(res.task);
        openTaskDrawer(res.task.id);
      }
    } catch (err) {
      if (err && err.status === 401) {
        handleAuthLost(err.message);
        return;
      }
      toast(tr('brainstorm.toTaskFailed', { message: str(err && err.message) || 'unknown' }), 'error');
    }
  }

  function openBrainstormGoalPicker(sessionId, messageId) {
    const sid = str(sessionId);
    const mid = str(messageId);
    if (!sid || !mid) return;
    if (!state.goalsLoaded) ensureGoalsLoaded();
    const goals = arr(state.goals).filter((goal) => goal && goal.id && goal.status !== 'completed');
    const list = el('div', { className: 'link-picker-list' });
    const addRow = (title, note, goalId) => {
      const row = el('button', {
        type: 'button',
        className: 'link-row link-row-button',
        onClick: () => {
          hideDrawer();
          void brainstormToTask(sid, mid, goalId);
        },
      },
        el('div', { className: 'link-row-main' },
          el('span', { className: 'link-row-title' }, title),
          el('span', { className: 'link-row-note' }, note)));
      list.appendChild(row);
    };
    addRow(tr('brainstorm.noGoal'), tr('brainstorm.noGoalHint'), '');
    goals.forEach((goal) => {
      const row = el('button', {
        type: 'button',
        className: 'link-row link-row-button',
        onClick: () => {
          hideDrawer();
          void brainstormToTask(sid, mid, goal.id);
        },
      },
        el('div', { className: 'link-row-main' },
          el('span', { className: 'link-row-title' }, goalDisplayName(goal)),
          el('div', { className: 'link-row-meta-line' },
            goalStatusBadge(goal),
            el('span', { className: 'link-row-time' }, goalPlanText(goal.schedule)))));
      list.appendChild(row);
    });
    openDrawer({
      kind: 'brainstorm-goal',
      id: 'brainstorm-goal',
      title: tr('brainstorm.selectGoal'),
      body: el('div', { className: 'link-picker' },
        el('p', { className: 'link-picker-task' }, tr('brainstorm.selectGoalHint')),
        list),
      footerNodes: [el('button', { type: 'button', className: 'btn btn-ghost', onClick: hideDrawer }, tr('common.close'))],
    });
  }

  function brainstormSessionRow(session, activeId) {
    const id = str(session && session.id);
    const title = str(session && session.title) || tr('brainstorm.sessionTitleFallback');
    const main = el('button', {
      type: 'button',
      className: 'brainstorm-session-main',
      dataset: { brainstormSession: id },
      attrs: { 'aria-current': id === activeId ? 'true' : 'false' },
    });
    main.appendChild(goalRawText('span', 'brainstorm-session-title', title));
    if (str(session && session.preview)) {
      main.appendChild(goalRawText('span', 'brainstorm-session-preview', str(session.preview)));
    }
    main.appendChild(el('span', { className: 'brainstorm-session-meta' },
      el('span', {}, fmtRel(str(session && (session.updatedAt || session.lastMessageAt)))),
      el('span', {}, tr('brainstorm.messagesCount', { n: num(session && session.messageCount) }))));
    const del = el('button', {
      type: 'button',
      className: 'icon-btn brainstorm-session-del',
      dataset: { brainstormDelete: id },
      attrs: { 'aria-label': tr('brainstorm.delete'), title: tr('brainstorm.delete') },
    }, icon('trash'));
    return el('div', { className: `brainstorm-session${id === activeId ? ' is-active' : ''}` }, main, del);
  }

  function brainstormEmptyNode() {
    const wrap = el('div', { className: 'brainstorm-empty' });
    wrap.appendChild(el('div', { className: 'brainstorm-empty-icon' }, icon('spark')));
    wrap.appendChild(el('h3', { className: 'brainstorm-empty-title' }, tr('brainstorm.emptyTitle')));
    wrap.appendChild(el('p', { className: 'brainstorm-empty-desc' }, tr('brainstorm.emptyDesc')));
    const suggestions = el('div', { className: 'brainstorm-suggestions' });
    BRAINSTORM_SUGGESTIONS.forEach((key) => {
      suggestions.appendChild(el('button', {
        type: 'button',
        className: 'brainstorm-suggest-btn',
        dataset: { brainstormSuggest: key },
      }, tr(key)));
    });
    wrap.appendChild(suggestions);
    return wrap;
  }

  function brainstormTypingNode() {
    return el('div', { className: 'brainstorm-msg brainstorm-msg-bot brainstorm-typing' },
      el('div', { className: 'brainstorm-msg-head' },
        el('span', { className: 'brainstorm-avatar' }, icon('spark')),
        el('span', { className: 'brainstorm-msg-name' }, tr('brainstorm.brain'))),
      el('p', { className: 'brainstorm-typing-text' }, tr('brainstorm.thinking')));
  }

  function brainstormMessageNode(sessionId, message) {
    const role = str(message && message.role) === 'user' ? 'user' : 'assistant';
    if (role === 'user') {
      return el('div', { className: 'brainstorm-msg brainstorm-msg-user' },
        el('div', { className: 'brainstorm-bubble' },
          goalRawText('div', 'brainstorm-bubble-text', brainstormTextOf(message))));
    }
    const text = brainstormTextOf(message);
    const messageId = str(message && message.id);
    const actions = el('div', { className: 'brainstorm-msg-actions' },
      el('button', {
        type: 'button',
        className: 'link-btn',
        dataset: { action: 'brainstorm-copy', brainstormMessage: messageId },
      }, icon('copy'), el('span', {}, tr('brainstorm.copy'))),
      el('button', {
        type: 'button',
        className: 'link-btn',
        dataset: { action: 'brainstorm-to-task', brainstormMessage: messageId },
      }, icon('tasks'), el('span', {}, tr('brainstorm.toTask'))),
      el('button', {
        type: 'button',
        className: 'link-btn',
        dataset: { action: 'brainstorm-link-goal', brainstormMessage: messageId },
      }, icon('target'), el('span', {}, tr('brainstorm.linkGoal'))));
    const card = el('article', { className: 'brainstorm-msg brainstorm-msg-bot' },
      el('div', { className: 'brainstorm-msg-head' },
        el('span', { className: 'brainstorm-avatar' }, icon('spark')),
        el('span', { className: 'brainstorm-msg-name' }, tr('brainstorm.brain')),
        message && message.model
          ? el('span', { className: 'brainstorm-msg-model' }, tr('brainstorm.model', { model: str(message.model) }))
          : null,
        el('span', { className: 'brainstorm-msg-time' }, relNode(str(message && message.at)))));
    if (text) card.appendChild(el('div', { className: 'brainstorm-md', html: renderMarkdownHtml(text) }));
    if (message && message.error) {
      card.appendChild(el('div', { className: 'task-error brainstorm-msg-error' },
        icon('alert'),
        el('span', {}, tr('brainstorm.assistantError', { message: str(message.error) }))));
    }
    card.appendChild(actions);
    return card;
  }

  function renderBrainstormErrorBox() {
    const box = $('#brainstorm-error');
    if (!box) return;
    box.replaceChildren();
    if (!state.brainstormError) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    box.appendChild(icon('alert'));
    box.appendChild(el('span', { className: 'brainstorm-error-text' }, state.brainstormError));
    box.appendChild(el('button', {
      type: 'button',
      className: 'link-btn',
      dataset: { brainstormRetry: '' },
    }, tr('brainstorm.retry')));
  }

  function renderBrainstorm(forceScroll = false) {
    if (!$('#section-brainstorm')) return;
    renderBrainstormErrorBox();
    const sessionsBox = $('#brainstorm-sessions');
    const messagesBox = $('#brainstorm-messages');
    const input = $('#brainstorm-input');
    const sendBtn = $('#brainstorm-send');
    const wasAtBottom = messagesBox
      ? messagesBox.scrollHeight - messagesBox.scrollTop - messagesBox.clientHeight < 140
      : true;
    if (input) {
      input.placeholder = tr('brainstorm.placeholder');
      input.disabled = state.brainstormSending;
    }
    if (sendBtn) {
      sendBtn.disabled = state.brainstormSending || !state.connected;
      const label = sendBtn.querySelector('span');
      if (label) label.textContent = state.brainstormSending ? tr('brainstorm.sending') : tr('brainstorm.send');
    }
    const reloadBtn = $('#brainstorm-reload');
    if (reloadBtn) reloadBtn.disabled = state.brainstormBusy;
    if (sessionsBox) {
      sessionsBox.replaceChildren();
      if (!state.brainstormSessions.length) {
        sessionsBox.appendChild(el('p', { className: 'brainstorm-side-empty' }, tr('brainstorm.noSessions')));
      } else {
        const activeId = brainstormCurrentId();
        state.brainstormSessions.forEach((session) => {
          sessionsBox.appendChild(brainstormSessionRow(session, activeId));
        });
      }
    }
    if (messagesBox) {
      messagesBox.replaceChildren();
      if (!state.brainstorm && state.brainstormBusy) {
        messagesBox.appendChild(el('p', { className: 'brainstorm-loading' }, tr('brainstorm.loading')));
      } else if (state.brainstormError) {
        // 错误由顶部提示条展示，消息区保持上下文
      } else if (!state.brainstormSession || !arr(state.brainstormSession.messages).length) {
        messagesBox.appendChild(brainstormEmptyNode());
      } else {
        arr(state.brainstormSession.messages).forEach((message) => {
          messagesBox.appendChild(brainstormMessageNode(state.brainstormSession.id, message));
        });
      }
      if (state.brainstormSending) messagesBox.appendChild(brainstormTypingNode());
      if (forceScroll || wasAtBottom || state.brainstormSending) {
        messagesBox.scrollTop = messagesBox.scrollHeight;
      }
    }
  }

  /* ==================================================================
   * 心智（Soul / Skill）：编辑大脑每轮思考时随快照交给 Agnes 的提示段
   * ================================================================== */
  function mindLimits() {
    const limits = state.mind && state.mind.limits && typeof state.mind.limits === 'object' ? state.mind.limits : {};
    const pick = (value, fallback) => {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
    };
    return {
      soul: pick(limits.soul, MIND_FIELD_LIMITS.soul),
      skill: pick(limits.skill, MIND_FIELD_LIMITS.skill),
    };
  }

  function mindDefaults() {
    const defaults = state.mind && state.mind.defaults && typeof state.mind.defaults === 'object' ? state.mind.defaults : {};
    return { soul: str(defaults.soul), skill: str(defaults.skill) };
  }

  function mindFieldEl(field) {
    if (field === 'soul') return $('#mind-soul');
    if (field === 'skill') return $('#mind-skill');
    return null;
  }

  function mindText(field) {
    const fieldEl = mindFieldEl(field);
    return fieldEl ? fieldEl.value : '';
  }

  function mindTrimmed(field) {
    return mindText(field).trim();
  }

  function mindIsDirtyNow() {
    const mind = state.mind;
    if (!mind) return false;
    return mindTrimmed('soul') !== str(mind.soul).trim() || mindTrimmed('skill') !== str(mind.skill).trim();
  }

  function renderMind() {
    const section = $('#section-mind');
    if (!section) return;
    const limits = mindLimits();
    const defaults = mindDefaults();
    const mind = state.mind;
    const loaded = state.mindLoaded && !!mind;
    const editable = loaded && !state.mindBusy;
    ['soul', 'skill'].forEach((field) => {
      const fieldEl = mindFieldEl(field);
      if (!fieldEl) return;
      // 有未保存修改时不覆盖用户输入；否则跟随服务端内容
      if (!state.mindDirty && loaded && document.activeElement !== fieldEl) {
        const nextValue = field === 'soul' ? str(mind.soul) : str(mind.skill);
        if (fieldEl.value !== nextValue) fieldEl.value = nextValue;
      }
      if (!fieldEl.value && !loaded) fieldEl.placeholder = tr('mind.loading');
      fieldEl.disabled = !editable && !state.mindDirty;
      const value = fieldEl.value;
      const countEl = field === 'soul' ? $('#mind-soul-count') : $('#mind-skill-count');
      if (countEl) {
        countEl.textContent = tr('mind.charCount', { n: value.length, max: limits[field] });
        countEl.classList.toggle('is-over', value.length > limits[field]);
      }
      const badgeEl = field === 'soul' ? $('#mind-soul-badge') : $('#mind-skill-badge');
      if (badgeEl) {
        const isDefault = !!defaults[field] && value.trim() === defaults[field].trim();
        badgeEl.textContent = tr(isDefault ? 'mind.badgeDefault' : 'mind.badgeCustom');
        badgeEl.classList.toggle('is-custom', !isDefault);
      }
    });
    const dirtyEl = $('#mind-dirty');
    if (dirtyEl) dirtyEl.hidden = !state.mindDirty;
    const updatedEl = $('#mind-updated');
    if (updatedEl) {
      updatedEl.textContent = mind && mind.updatedAt
        ? tr('mind.updatedAt', { time: fmtDateTime(mind.updatedAt) })
        : tr('mind.neverUpdated');
    }
    const errorEl = $('#mind-error');
    if (errorEl) {
      const message = state.mindError || (state.mindServerUpdated ? tr('mind.serverUpdated') : '');
      errorEl.textContent = message;
      errorEl.hidden = !message;
    }
    const saveLabel = $('#mind-save-label');
    if (saveLabel) saveLabel.textContent = state.mindBusy ? tr('mind.saving') : tr('mind.save');
    const saveBtn = $('#mind-save');
    if (saveBtn) saveBtn.disabled = state.mindBusy || !state.mindDirty;
    const soulReset = $('#mind-soul-reset');
    if (soulReset) soulReset.disabled = state.mindBusy || !loaded;
    const skillReset = $('#mind-skill-reset');
    if (skillReset) skillReset.disabled = state.mindBusy || !loaded;
    const resetAll = $('#mind-reset-all');
    if (resetAll) resetAll.disabled = state.mindBusy || !loaded;
    const previewText = $('#mind-preview-text');
    if (previewText) {
      const combined = loaded ? `${str(mind.soul).trim()}\n\n${str(mind.skill).trim()}`.trim() : '';
      previewText.textContent = combined ? combined.slice(0, 600) : tr('mind.previewEmpty');
      previewText.classList.toggle('is-empty', !combined);
    }
    const previewSummary = $('#mind-preview summary');
    if (previewSummary) previewSummary.textContent = tr('mind.previewTitle');
  }

  async function loadMind({ silent = false } = {}) {
    if (!state.connected) return;
    try {
      const res = await api('/api/mind', { timeout: 12000 });
      if (res && res.mind && typeof res.mind === 'object') state.mind = res.mind;
      state.mindLoaded = true;
      state.mindError = '';
      state.mindServerUpdated = false;
    } catch (err) {
      if (err && err.status === 401) return handleAuthLost(err.message);
      state.mindError = err && err.status === 404 ? tr('mind.unsupported') : str(err && err.message) || tr('mind.loadFailed');
      if (!silent) toast(state.mindError, 'error');
    } finally {
      renderMind();
    }
  }

  function ensureMindLoaded() {
    if (!state.connected || state.mindLoaded || state.mindBusy) return;
    void loadMind();
  }

  function onMindUpdated(payload) {
    const mind = payload && payload.mind && typeof payload.mind === 'object' ? payload.mind : null;
    if (!mind) return;
    state.mind = mind;
    state.mindLoaded = true;
    if (!state.mindDirty) {
      state.mindError = '';
      state.mindServerUpdated = false;
      renderMind();
      return;
    }
    // 用户正在编辑：只提示服务端已更新，不覆盖未保存内容
    state.mindServerUpdated = true;
    renderMind();
  }

  function updateMindDirty() {
    state.mindDirty = mindIsDirtyNow();
    if (!state.mindDirty) state.mindServerUpdated = false;
    renderMind();
  }

  function mindValidationError() {
    const limits = mindLimits();
    const soul = mindTrimmed('soul');
    const skill = mindTrimmed('skill');
    if (!soul) return tr('mind.emptySoul');
    if (!skill) return tr('mind.emptySkill');
    if (soul.length > limits.soul) return tr('mind.tooLong', { field: tr('mind.soulTitle'), max: limits.soul });
    if (skill.length > limits.skill) return tr('mind.tooLong', { field: tr('mind.skillTitle'), max: limits.skill });
    return '';
  }

  async function saveMind() {
    if (state.mindBusy) return;
    const validation = mindValidationError();
    if (validation) {
      state.mindError = validation;
      renderMind();
      toast(validation, 'warn');
      return;
    }
    state.mindBusy = true;
    state.mindError = '';
    renderMind();
    try {
      const res = await api('/api/mind', {
        method: 'PATCH',
        body: { soul: mindTrimmed('soul'), skill: mindTrimmed('skill') },
        timeout: 20000,
      });
      if (res && res.mind && typeof res.mind === 'object') state.mind = res.mind;
      state.mindLoaded = true;
      state.mindDirty = false;
      state.mindServerUpdated = false;
      toast(tr('mind.saved'), 'success');
    } catch (err) {
      if (err && err.status === 401) return handleAuthLost(err.message);
      state.mindError = tr('mind.saveFailed', { message: str(err && err.message) || tr('mind.loadFailed') });
      toast(state.mindError, 'error');
    } finally {
      state.mindBusy = false;
      renderMind();
    }
  }

  async function resetMind({ field = '' } = {}) {
    if (state.mindBusy) return;
    if (!field) {
      const ok = await confirmDialog({
        title: tr('mind.resetAll'),
        message: tr('mind.resetAllConfirm'),
        okText: tr('mind.resetAll'),
      });
      if (!ok) return;
    }
    const body = field === 'soul'
      ? { resetSoul: true }
      : field === 'skill'
        ? { resetSkill: true }
        : { resetSoul: true, resetSkill: true };
    state.mindBusy = true;
    state.mindError = '';
    renderMind();
    try {
      const res = await api('/api/mind', { method: 'PATCH', body, timeout: 20000 });
      if (res && res.mind && typeof res.mind === 'object') state.mind = res.mind;
      state.mindLoaded = true;
      state.mindDirty = false;
      state.mindServerUpdated = false;
      toast(tr('mind.resetDone'), 'success');
    } catch (err) {
      if (err && err.status === 401) return handleAuthLost(err.message);
      state.mindError = tr('mind.resetFailed', { message: str(err && err.message) || tr('mind.loadFailed') });
      toast(state.mindError, 'error');
    } finally {
      state.mindBusy = false;
      renderMind();
    }
  }

  /* ==================================================================
   * 提醒（浏览器内只做管理，通知由手机 APK 的原生 AlarmManager 发出）
   * ================================================================== */
  const REMINDER_REPEATS = ['none', 'daily', 'weekly'];
  const REMINDER_NOTIFY_STYLES = ['gentle', 'alarm'];

  function reminderById(id) {
    return state.reminders.find((item) => item && item.id === id) || null;
  }

  function reminderDueIso(dueAt) {
    const t = Number(dueAt);
    return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : '';
  }

  /** 到期时间统一按本机时区展示。 */
  function reminderDueText(dueAt) {
    return fmtDateTime(reminderDueIso(dueAt));
  }

  function reminderRepeatLabel(repeat) {
    if (repeat === 'daily') return tr('reminders.repeatDaily');
    if (repeat === 'weekly') return tr('reminders.repeatWeekly');
    return tr('reminders.repeatNone');
  }

  /** 通知方式：旧数据没有该字段（或值非法）时一律回落为温柔通知。 */
  function reminderNotifyStyleOf(reminder) {
    const value = reminder && reminder.notifyStyle;
    return REMINDER_NOTIFY_STYLES.includes(value) ? value : 'gentle';
  }

  function reminderNotifyLabel(style) {
    return style === 'alarm' ? tr('reminders.notifyAlarm') : tr('reminders.notifyGentle');
  }

  function reminderNotifyBadge(style) {
    return style === 'alarm' ? tr('reminders.badgeAlarm') : tr('reminders.badgeGentle');
  }

  /** 启用状态 / 是否已过期 / 是否已提醒过。 */
  function reminderStatusOf(reminder) {
    const due = Number(reminder.dueAt);
    const hasDue = Number.isFinite(due) && due > 0;
    const repeat = REMINDER_REPEATS.includes(reminder.repeat) ? reminder.repeat : 'none';
    const fired = Boolean(reminder.lastFiredAt) && num(reminder.fireCount) > 0;
    // 一次性提醒触发后后端会自动停用，所以「已提醒」要优先于「已停用」判断
    if (repeat === 'none' && fired) return { tone: 'fired', label: tr('reminders.statusFired') };
    if (reminder.enabled === false) return { tone: 'disabled', label: tr('reminders.statusDisabled') };
    if (hasDue && due <= Date.now()) return { tone: 'overdue', label: tr('reminders.statusOverdue') };
    return { tone: 'pending', label: '' };
  }

  function sortReminders() {
    state.reminders.sort((a, b) => (num(a && a.dueAt) || 0) - (num(b && b.dueAt) || 0));
  }

  function reminderCard(reminder) {
    const status = reminderStatusOf(reminder);
    const busy = reminderBusy.has(reminder.id);
    const title = str(reminder.title) || tr('reminders.untitled');
    const card = el('article', {
      className: 'reminder-card',
      dataset: { id: reminder.id, status: status.tone },
      attrs: {
        role: 'button',
        tabindex: '0',
        'aria-label': tr('reminders.cardAria', { title }),
      },
    });

    const head = el('div', { className: 'reminder-card-head' },
      el('h3', { className: 'reminder-title', text: title, attrs: { 'data-i18n-skip': '1' } }),
      status.label
        ? el('span', { className: 'reminder-status', dataset: { tone: status.tone }, text: status.label })
        : null,
    );
    card.appendChild(head);

    if (str(reminder.note)) {
      card.appendChild(el('p', {
        className: 'reminder-note',
        text: str(reminder.note),
        attrs: { 'data-i18n-skip': '1' },
      }));
    }

    const notifyStyle = reminderNotifyStyleOf(reminder);
    const meta = el('div', { className: 'reminder-meta' },
      el('span', { className: 'reminder-due' }, icon('clock'), el('span', { text: reminderDueText(reminder.dueAt) })),
      el('span', { className: 'reminder-repeat' }, el('span', { text: reminderRepeatLabel(reminder.repeat) })),
      el('span', { className: 'reminder-style', dataset: { style: notifyStyle } },
        icon(notifyStyle === 'alarm' ? 'alert' : 'bell'),
        el('span', { text: reminderNotifyBadge(notifyStyle) }),
      ),
    );
    if (reminder.lastFiredAt) {
      meta.appendChild(el('span', { className: 'reminder-fired' },
        el('span', { className: 'reminder-meta-label', text: tr('reminders.lastFiredLabel') }),
        el('span', { text: fmtRel(reminder.lastFiredAt) }),
      ));
    }
    card.appendChild(meta);

    const actions = el('div', { className: 'reminder-actions' },
      el('button', {
        type: 'button',
        className: 'link-btn',
        dataset: { action: 'edit' },
        attrs: { 'aria-label': tr('reminders.editAria', { title }) },
        disabled: busy,
      }, icon('edit'), el('span', { text: tr('reminders.edit') })),
      el('button', {
        type: 'button',
        className: 'link-btn',
        dataset: { action: 'toggle' },
        attrs: { 'aria-label': tr('reminders.toggleAria', { title }) },
        disabled: busy,
      }, icon('power'), el('span', { text: reminder.enabled === false ? tr('reminders.enable') : tr('reminders.disable') })),
      el('button', {
        type: 'button',
        className: 'link-btn',
        dataset: { action: 'delete' },
        attrs: { 'aria-label': tr('reminders.deleteAria', { title }) },
        disabled: busy,
      }, icon('trash'), el('span', { text: tr('reminders.delete') })),
    );
    card.appendChild(actions);
    return card;
  }

  function updateRemindersSub() {
    const total = state.reminders.length;
    const active = state.reminders.filter((item) => item && item.enabled !== false).length;
    if (total) setText('#reminders-sub', tr('reminders.sub', { active, total }));
    else if (!state.remindersLoaded || state.remindersLoading) setText('#reminders-sub', tr('reminders.loading'));
    else setText('#reminders-sub', tr('reminders.subEmpty'));
  }

  function reminderBridge() {
    let bridge = null;
    try {
      bridge = window.ButlerBridge;
    } catch (e) {
      bridge = null;
    }
    if (!bridge || typeof bridge.syncReminders !== 'function') return null;
    return bridge;
  }

  function readReminderBridgeStatus() {
    const bridge = reminderBridge();
    if (!bridge || typeof bridge.getReminderStatus !== 'function') return null;
    try {
      const res = JSON.parse(bridge.getReminderStatus());
      if (!res || typeof res !== 'object') return null;
      return {
        ok: res.ok !== false,
        scheduled: num(res.scheduled),
        permissionGranted: res.permissionGranted === undefined ? null : Boolean(res.permissionGranted),
        exact: res.exact === undefined ? null : Boolean(res.exact),
      };
    } catch {
      return null;
    }
  }

  /** 把提醒清单同步给手机 APK；浏览器里没有桥，安全跳过。 */
  function syncRemindersToApk() {
    const bridge = reminderBridge();
    if (!bridge) {
      state.remindersBridge = { available: false, ok: false, scheduled: 0, permissionGranted: null, exact: null, error: '' };
      reminderSyncSig = '';
      renderReminderHint();
      return;
    }
    const payload = {
      reminders: state.reminders.map((item) => ({
        id: item.id,
        title: str(item.title),
        note: str(item.note),
        dueAt: num(item.dueAt),
        repeat: REMINDER_REPEATS.includes(item.repeat) ? item.repeat : 'none',
        enabled: item.enabled !== false,
        notifyStyle: reminderNotifyStyleOf(item),
      })),
    };
    const serialized = JSON.stringify(payload);
    if (serialized === reminderSyncSig) {
      renderReminderHint();
      return;
    }
    let result = null;
    let error = '';
    try {
      const raw = bridge.syncReminders(serialized);
      result = raw ? JSON.parse(raw) : null;
    } catch (err) {
      error = err && err.message ? err.message : String(err);
    }
    const status = readReminderBridgeStatus();
    state.remindersBridge = {
      available: true,
      ok: !error && !!result && result.ok !== false,
      scheduled: num(result && result.scheduled, status ? status.scheduled : 0),
      permissionGranted: result && result.permissionGranted !== undefined
        ? Boolean(result.permissionGranted)
        : (status ? status.permissionGranted : null),
      exact: result && result.exact !== undefined ? Boolean(result.exact) : (status ? status.exact : null),
      error,
    };
    reminderSyncSig = error ? '' : serialized;
    renderReminderHint();
  }

  function renderReminderHint() {
    const hint = $('#reminder-hint');
    if (!hint) return;
    const info = state.remindersBridge;
    const lines = [];
    if (!info.available) {
      lines.push({ tone: 'info', iconName: 'bell', text: tr('reminders.hintBrowser') });
    } else {
      lines.push({ tone: 'info', iconName: 'bell', text: tr('reminders.hintApk') });
      if (info.permissionGranted === false) {
        lines.push({ tone: 'warn', iconName: 'alert', text: tr('reminders.hintPermission') });
      }
      if (info.error) lines.push({ tone: 'warn', iconName: 'alert', text: tr('reminders.hintSyncFailed', { message: info.error }) });
    }
    if (state.remindersError) lines.push({ tone: 'warn', iconName: 'alert', text: state.remindersError });
    hint.replaceChildren();
    for (const line of lines) {
      hint.appendChild(el('p', { className: 'reminder-hint-line', dataset: { tone: line.tone } },
        icon(line.iconName),
        el('span', { text: line.text }),
      ));
    }
    hint.hidden = lines.length === 0;
  }

  function renderReminders() {
    const list = $('#reminder-list');
    if (!list) return;
    setText('#reminders-title', tr('reminders.title'));
    setText('#reminder-new-label', tr('reminders.new'));
    const newBtn = $('#reminder-new');
    if (newBtn) {
      const blocked = Boolean(state.remindersError && !state.remindersSupported);
      newBtn.disabled = blocked;
      newBtn.title = blocked ? state.remindersError : '';
    }
    const sig = JSON.stringify({
      reminders: state.reminders,
      loaded: state.remindersLoaded,
      loading: state.remindersLoading,
      error: state.remindersError,
      busy: Array.from(reminderBusy),
      bridge: state.remindersBridge,
      lang: currentLang(),
    });
    if (sig === state.sigs.reminders && list.childElementCount) {
      updateRemindersSub();
      return;
    }
    state.sigs.reminders = sig;
    list.replaceChildren();
    if (!state.reminders.length) {
      if (state.remindersLoading || (!state.remindersLoaded && state.connected)) {
        list.appendChild(el('p', { className: 'reminder-loading', text: tr('reminders.loading') }));
      } else if (state.remindersError) {
        list.appendChild(emptyState({
          iconName: 'bell',
          title: tr('reminders.loadFailed'),
          desc: state.remindersError,
        }));
        list.appendChild(el('div', { className: 'reminder-empty-actions' },
          el('button', {
            type: 'button',
            className: 'btn btn-ghost btn-sm',
            dataset: { action: 'reload-reminders' },
          }, icon('refresh'), el('span', { text: tr('reminders.retry') })),
        ));
      } else {
        list.appendChild(emptyState({
          iconName: 'bell',
          title: tr('reminders.emptyTitle'),
          desc: tr('reminders.emptyDesc'),
        }));
      }
      updateRemindersSub();
      renderReminderHint();
      return;
    }
    for (const reminder of state.reminders) list.appendChild(reminderCard(reminder));
    updateRemindersSub();
    renderReminderHint();
  }

  function upsertReminder(reminder) {
    if (!reminder || !reminder.id) return;
    const index = state.reminders.findIndex((item) => item && item.id === reminder.id);
    if (index >= 0) state.reminders[index] = reminder;
    else state.reminders.push(reminder);
    sortReminders();
    state.remindersLoaded = true;
    state.sigs.reminders = '';
  }

  function removeReminder(id) {
    state.reminders = state.reminders.filter((item) => item && item.id !== id);
    state.remindersLoaded = true;
    state.sigs.reminders = '';
  }

  function ensureRemindersLoaded() {
    if (!state.connected || state.remindersLoaded || state.remindersLoading) return;
    void loadReminders();
  }

  async function loadReminders({ silent = false } = {}) {
    if (!state.connected || state.remindersLoading) return;
    state.remindersLoading = true;
    if (!silent) state.remindersError = '';
    state.sigs.reminders = '';
    renderReminders();
    try {
      const res = await api('/api/reminders', { timeout: 12000 });
      state.reminders = arr(res.reminders).filter((item) => item && item.id);
      sortReminders();
      state.remindersHubTime = str(res.hubTime);
      state.remindersSupported = true;
      state.remindersError = '';
      state.remindersLoaded = true;
      syncRemindersToApk();
    } catch (err) {
      if (err.status === 401) {
        handleAuthLost(err.message);
        return;
      }
      state.remindersSupported = err.status === 404 ? false : state.remindersSupported;
      state.remindersError = err.status === 404
        ? tr('reminders.unsupported')
        : (err.message || tr('reminders.loadFailed'));
      state.remindersLoaded = true;
    } finally {
      state.remindersLoading = false;
      state.sigs.reminders = '';
      renderReminders();
    }
  }

  /** datetime-local 需要本地时间字符串（yyyy-MM-ddTHH:mm）。 */
  function reminderLocalInput(dueAt) {
    const t = Number(dueAt);
    const d = new Date(Number.isFinite(t) && t > 0 ? t : Date.now());
    if (!Number.isFinite(d.getTime())) return '';
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function openReminderFormDrawer(reminderId) {
    const reminder = reminderId ? reminderById(reminderId) : null;
    if (reminderId && !reminder) {
      toast(tr('reminders.notFound'), 'warn');
      return;
    }

    const form = el('form', { className: 'reminder-form', attrs: { novalidate: 'novalidate' } });

    const titleInput = el('input', {
      type: 'text',
      attrs: {
        maxlength: '80',
        placeholder: tr('reminders.fieldTitlePlaceholder'),
        'aria-label': tr('reminders.fieldTitle'),
      },
    });
    titleInput.value = reminder ? str(reminder.title) : '';

    const noteInput = el('textarea', {
      attrs: {
        rows: '3',
        maxlength: '500',
        placeholder: tr('reminders.fieldNotePlaceholder'),
        'aria-label': tr('reminders.fieldNote'),
      },
    });
    noteInput.value = reminder ? str(reminder.note) : '';

    const dueInput = el('input', {
      type: 'datetime-local',
      attrs: { 'aria-label': tr('reminders.fieldDue') },
    });
    dueInput.value = reminder
      ? reminderLocalInput(reminder.dueAt)
      : reminderLocalInput(Date.now() + 10 * 60 * 1000);

    const repeatSelect = el('select', { attrs: { 'aria-label': tr('reminders.fieldRepeat') } });
    const currentRepeat = reminder && REMINDER_REPEATS.includes(reminder.repeat) ? reminder.repeat : 'none';
    for (const repeat of REMINDER_REPEATS) {
      const option = el('option', { value: repeat, text: reminderRepeatLabel(repeat) });
      if (repeat === currentRepeat) option.selected = true;
      repeatSelect.appendChild(option);
    }

    const notifySelect = el('select', { attrs: { 'aria-label': tr('reminders.fieldNotifyStyle') } });
    const currentNotifyStyle = reminderNotifyStyleOf(reminder);
    for (const style of REMINDER_NOTIFY_STYLES) {
      const option = el('option', { value: style, text: reminderNotifyLabel(style) });
      if (style === currentNotifyStyle) option.selected = true;
      notifySelect.appendChild(option);
    }

    const enabledInput = el('input', { type: 'checkbox' });
    enabledInput.checked = reminder ? reminder.enabled !== false : true;
    const enabledRow = el('label', { className: 'reminder-toggle' },
      enabledInput,
      el('span', { className: 'reminder-toggle-text' },
        el('span', { className: 'reminder-toggle-label', text: tr('reminders.fieldEnabled') }),
        el('span', { className: 'reminder-toggle-hint', text: tr('reminders.fieldEnabledHint') }),
      ),
    );

    form.appendChild(el('div', { className: 'field' },
      el('label', { text: tr('reminders.fieldTitle') }),
      titleInput,
      el('span', { className: 'field-hint', text: tr('reminders.fieldTitleHint') }),
    ));
    form.appendChild(el('div', { className: 'field' },
      el('label', { text: tr('reminders.fieldNote') }),
      noteInput,
    ));
    form.appendChild(el('div', { className: 'field-row' },
      el('div', { className: 'field' },
        el('label', { text: tr('reminders.fieldDue') }),
        dueInput,
        el('span', { className: 'field-hint', text: tr('reminders.fieldDueHint') }),
      ),
      el('div', { className: 'field' },
        el('label', { text: tr('reminders.fieldRepeat') }),
        repeatSelect,
      ),
    ));
    form.appendChild(el('div', { className: 'field' },
      el('label', { text: tr('reminders.fieldNotifyStyle') }),
      notifySelect,
      el('span', { className: 'field-hint', text: tr('reminders.notifyStyleHint') }),
    ));
    form.appendChild(el('div', { className: 'field reminder-enabled-field' }, enabledRow));
    form.appendChild(el('p', { className: 'reminder-form-hint', text: tr('reminders.formHint') }));

    const saveBtn = el('button', { type: 'button', className: 'btn btn-primary btn-sm' },
      icon('check'),
      el('span', { text: reminder ? tr('reminders.save') : tr('reminders.create') }),
    );

    let saving = false;
    const save = async () => {
      if (saving) return;
      const title = titleInput.value.trim();
      const note = noteInput.value.trim();
      if (!title) {
        toast(tr('reminders.fieldTitleRequired'), 'warn');
        titleInput.focus();
        return;
      }
      if (title.length > 80) {
        toast(tr('reminders.fieldTitleTooLong'), 'warn');
        titleInput.focus();
        return;
      }
      if (note.length > 500) {
        toast(tr('reminders.fieldNoteTooLong'), 'warn');
        noteInput.focus();
        return;
      }
      const dueMs = dueInput.value ? new Date(dueInput.value).getTime() : NaN;
      if (!Number.isFinite(dueMs)) {
        toast(tr('reminders.fieldDueRequired'), 'warn');
        dueInput.focus();
        return;
      }
      const body = {
        title,
        note,
        dueAt: dueMs,
        repeat: REMINDER_REPEATS.includes(repeatSelect.value) ? repeatSelect.value : 'none',
        notifyStyle: REMINDER_NOTIFY_STYLES.includes(notifySelect.value) ? notifySelect.value : 'gentle',
        enabled: enabledInput.checked,
      };
      saving = true;
      saveBtn.disabled = true;
      try {
        const res = reminder
          ? await api(`/api/reminders/${encodeURIComponent(reminder.id)}`, { method: 'PATCH', body, timeout: 15000 })
          : await api('/api/reminders', { method: 'POST', body, timeout: 15000 });
        const saved = res && res.reminder && res.reminder.id ? res.reminder : null;
        if (saved) upsertReminder(saved);
        else if (reminder) upsertReminder({ ...reminder, ...body });
        state.remindersHubTime = str(res && res.hubTime) || state.remindersHubTime;
        state.remindersLoaded = true;
        state.remindersSupported = true;
        state.remindersError = '';
        state.sigs.reminders = '';
        renderReminders();
        syncRemindersToApk();
        toast(reminder ? tr('reminders.saved') : tr('reminders.created'), 'success');
        hideDrawer();
      } catch (err) {
        if (err.status === 401) {
          handleAuthLost(err.message);
          return;
        }
        toast(err.message || tr('reminders.saveFailed'), 'error');
      } finally {
        saving = false;
        saveBtn.disabled = false;
      }
    };

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void save();
    });
    saveBtn.addEventListener('click', () => void save());

    openDrawer({
      kind: 'reminder-form',
      id: reminder ? reminder.id : null,
      title: reminder ? tr('reminders.formEditTitle') : tr('reminders.formNewTitle'),
      subNodes: [el('span', { text: reminder ? tr('reminders.formSubEdit') : tr('reminders.formSubNew') })],
      body: form,
      footerNodes: [
        el('button', { type: 'button', className: 'btn btn-ghost btn-sm', text: tr('common.cancel'), onclick: hideDrawer }),
        el('span', { className: 'spacer' }),
        saveBtn,
      ],
    });
    setTimeout(() => titleInput.focus(), 80);
  }

  async function reminderToggleEnabled(id) {
    const reminder = reminderById(id);
    if (!reminder || reminderBusy.has(id)) return;
    const next = reminder.enabled === false;
    reminderBusy.add(id);
    state.sigs.reminders = '';
    renderReminders();
    try {
      const res = await api(`/api/reminders/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { enabled: next },
        timeout: 12000,
      });
      if (res && res.reminder && res.reminder.id) upsertReminder(res.reminder);
      else upsertReminder({ ...reminder, enabled: next });
      state.remindersHubTime = str(res && res.hubTime) || state.remindersHubTime;
      state.sigs.reminders = '';
      renderReminders();
      syncRemindersToApk();
      toast(next ? tr('reminders.enabledToast') : tr('reminders.disabledToast'), 'success');
    } catch (err) {
      if (err.status === 401) return handleAuthLost(err.message);
      if (err.status === 404) {
        removeReminder(id);
        toast(tr('reminders.notFound'), 'warn');
      } else {
        toast(err.message || tr('reminders.toggleFailed'), 'error');
      }
    } finally {
      reminderBusy.delete(id);
      state.sigs.reminders = '';
      renderReminders();
    }
  }

  async function reminderDelete(id) {
    const reminder = reminderById(id);
    if (!reminder || reminderBusy.has(id)) return;
    const ok = await confirmDialog({
      title: tr('reminders.deleteTitle'),
      message: tr('reminders.deleteMessage'),
      okText: tr('reminders.deleteOk'),
    });
    if (!ok) return;
    reminderBusy.add(id);
    state.sigs.reminders = '';
    renderReminders();
    try {
      await api(`/api/reminders/${encodeURIComponent(id)}`, { method: 'DELETE', timeout: 12000 });
      removeReminder(id);
      if (state.drawer.open && state.drawer.kind === 'reminder-form' && state.drawer.id === id) hideDrawer();
      state.sigs.reminders = '';
      renderReminders();
      syncRemindersToApk();
      toast(tr('reminders.deleted'), 'success');
    } catch (err) {
      if (err.status === 401) return handleAuthLost(err.message);
      if (err.status === 404) {
        removeReminder(id);
        if (state.drawer.open && state.drawer.kind === 'reminder-form' && state.drawer.id === id) hideDrawer();
        renderReminders();
        syncRemindersToApk();
      } else {
        toast(err.message || tr('reminders.deleteFailed'), 'error');
      }
    } finally {
      reminderBusy.delete(id);
      state.sigs.reminders = '';
      renderReminders();
    }
  }

  /* ==================================================================
   * 实时动态
   * ================================================================== */
  function activityEntries() {
    const entries = [];
    for (const event of state.activity) {
      if (!event || typeof event !== 'object') continue;
      const type = str(event.type) || 'log';
      const data = event.data && typeof event.data === 'object' ? event.data : null;
      let message = str(event.message);
      if (!message && data) {
        if (data.task && data.task.instruction) {
          const label = { 'task.created': '新任务', 'task.completed': '任务完成', 'task.failed': '任务失败', 'task.updated': '任务更新' }[type] || '任务';
          message = `${label}：${shorten(data.task.instruction, 26)}`;
        } else if (data.device && (data.device.nickname || data.device.name)) {
          message = `${type === 'device.online' ? '设备上线' : type === 'device.offline' ? '设备离线' : '设备更新'}：${data.device.nickname || data.device.name}`;
        } else if (data.name) {
          message = `${type === 'device.offline' ? '设备离线' : '设备上线'}：${data.name}`;
        } else if (data.message) {
          message = data.message;
        }
      }
      if (!message) {
        const bare = type.replace(/^task\./, '').replace(/^device\./, '');
        message = EVENT_LABEL[bare] || type;
      }
      const level = str(event.level) || (data && str(data.level))
        || (type === 'task.failed' || type === 'device.offline' ? 'warn'
          : type === 'task.completed' || type === 'device.online' || type === 'task.created' ? 'ok'
            : 'info');
      entries.push({ at: event.at || event.hubTime || '', message, type, level });
    }
    return entries
      .sort((a, b) => (parseIso(b.at) || 0) - (parseIso(a.at) || 0))
      .slice(0, 10);
  }

  function renderActivity() {
    const list = $('#activity-list');
    if (!list) return;
    const entries = activityEntries();
    const sig = JSON.stringify(entries);
    if (sig === state.sigs.activity && list.childElementCount) return;
    state.sigs.activity = sig;
    list.replaceChildren();
    if (!entries.length) {
      list.appendChild(el('li', { className: 'activity-item' },
        el('span', { className: 'activity-dot' }),
        el('span', { className: 'activity-msg', text: '暂无实时动态' }),
      ));
      setText('#activity-sub', '等待事件…');
      return;
    }
    for (const entry of entries) {
      list.appendChild(el('li', { className: 'activity-item', dataset: { level: entry.level } },
        el('span', { className: 'activity-dot' }),
        el('span', { className: 'activity-msg', text: entry.message || entry.type }),
        el('span', { className: 'activity-time', text: fmtTime(entry.at) }),
      ));
    }
    setText('#activity-sub', `最近 ${entries.length} 条`);
  }

  /* ==================================================================
   * 设置
   * ================================================================== */
  function kv(label, value, mono = false) {
    return el('div', { className: 'kv' },
      el('span', { className: 'kv-label', text: label }),
      el('span', { className: 'kv-value' + (mono ? ' mono' : ''), text: value == null ? '—' : String(value), title: value == null ? '' : String(value) }),
    );
  }

  /** 带复制按钮的键值行，用于目标 / 任务 ID 等需要复制的标识。 */
  function kvCopy(label, value, successMessage) {
    const text = value == null ? '' : String(value);
    const copyBtn = el('button', {
      type: 'button',
      className: 'link-btn kv-copy',
      title: '复制',
      attrs: { 'aria-label': `复制${label}` },
      onclick: () => copyText(text, successMessage || `${label} 已复制`),
    }, icon('copy'));
    return el('div', { className: 'kv kv-copy-row' },
      el('span', { className: 'kv-label', text: label }),
      el('span', { className: 'kv-value mono', text: text || '—', title: text }),
      copyBtn,
    );
  }

  function maskToken(token) {
    if (!token) return '未保存';
    if (token.length <= 8) return '••••••••';
    return `${token.slice(0, 4)}••••${token.slice(-4)}`;
  }

  const ATTACHMENT_LIMITS = { count: 3, bytes: 2 * 1024 * 1024, total: 4 * 1024 * 1024 };

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10240 ? 1 : 0)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }

  function renderPendingAttachments() {
    const list = $('#attachment-list');
    if (!list) return;
    list.replaceChildren();
    list.hidden = state.pendingAttachments.length === 0;
    state.pendingAttachments.forEach((file, index) => {
      const chip = el('span', { className: 'attachment-chip' },
        icon('link'),
        el('span', { className: 'name', text: file.name, title: file.name }),
        el('span', { className: 'size', text: formatBytes(file.size) }),
        el('button', {
          type: 'button', text: '×', title: '移除附件',
          onclick: () => {
            state.pendingAttachments.splice(index, 1);
            renderPendingAttachments();
          },
        }),
      );
      list.appendChild(chip);
    });
    const hint = $('#attach-hint');
    if (hint) {
      const total = state.pendingAttachments.reduce((sum, file) => sum + file.size, 0);
      hint.textContent = tx(state.pendingAttachments.length
        ? `${state.pendingAttachments.length}/${ATTACHMENT_LIMITS.count} 个 · ${formatBytes(total)}`
        : '小文件 ≤2MB，最多 3 个');
    }
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error(`读取 ${file.name} 失败`));
      reader.readAsDataURL(file);
    });
  }

  async function addPendingFiles(fileList) {
    const files = Array.from(fileList || []);
    const current = state.pendingAttachments.reduce((sum, file) => sum + file.size, 0);
    let total = current;
    for (const file of files) {
      if (state.pendingAttachments.length >= ATTACHMENT_LIMITS.count) {
        toast(`最多附加 ${ATTACHMENT_LIMITS.count} 个文件`, 'warn');
        break;
      }
      if (file.size > ATTACHMENT_LIMITS.bytes) {
        toast(`${file.name} 超过 2MB`, 'warn');
        continue;
      }
      if (total + file.size > ATTACHMENT_LIMITS.total) {
        toast('附件总大小超过 4MB', 'warn');
        break;
      }
      try {
        const data = await fileToDataUrl(file);
        state.pendingAttachments.push({ name: file.name, type: file.type || 'application/octet-stream', size: file.size, data });
        total += file.size;
      } catch (err) {
        toast(err.message || '读取附件失败', 'error');
      }
    }
    renderPendingAttachments();
  }

  function clearPendingAttachments() {
    state.pendingAttachments = [];
    renderPendingAttachments();
    const input = $('#file-input');
    if (input) input.value = '';
  }

  function attachmentPayload() {
    return state.pendingAttachments.map((file) => ({
      name: file.name,
      type: file.type,
      size: file.size,
      data: file.data,
    }));
  }

  function copyText(text, successMessage) {
    const done = () => toast(successMessage || '已复制', 'success');
    const fail = () => toast('复制失败，请手动选择文本', 'error');
    if (window.ButlerBridge && typeof window.ButlerBridge.copyText === 'function') {
      try {
        window.ButlerBridge.copyText(String(text || ''));
        done();
        return;
      } catch {
        /* 回退到浏览器剪贴板 */
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallback());
    } else {
      fallback();
    }
    function fallback() {
      try {
        const area = el('textarea', { style: { position: 'fixed', opacity: '0', top: '-1000px' } });
        area.value = text;
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        if (ok) done();
        else fail();
      } catch {
        fail();
      }
    }
  }

  function diagnostics() {
    const view = statsView();
    return [
      'BattleStar 控制台诊断',
      `Hub: ${state.baseUrl || window.location.origin}`,
      `连接: ${state.connected ? '已连接' : '未连接'}`,
      `实时通道: ${SSE_TEXT[state.sse.status] || state.sse.status}`,
      `设备: ${view.online}/${view.total} 在线`,
      `任务: 运行 ${view.running} · 排队 ${view.queued} · 完成 ${view.completed} · 失败 ${view.failed}`,
      `协议: v${(state.health && state.health.protocol) || PROTOCOL_VERSION}`,
      `时间: ${new Date().toISOString()}`,
    ].join('\n');
  }

  function buildSettings() {
    const wrap = el('div', { className: 'settings-body' });
    const health = state.health || {};
    const server = state.server || {};

    const connection = el('section', { className: 'settings-section' },
      el('h3', { text: '连接' }),
    );
    connection.appendChild(el('div', { className: 'kv-grid' },
      kv('Hub 地址', state.baseUrl || window.location.origin, true),
      kv('连接状态', state.connected ? '已连接' : '未连接'),
      kv('实时通道', SSE_TEXT[state.sse.status] || state.sse.status),
      kv('服务器版本', health.version || server.version || '—'),
      kv('协议版本', `v${health.protocol || PROTOCOL_VERSION}`),
      kv('运行时长', Number.isFinite(health.uptimeSec) ? fmtClock(health.uptimeSec)
        : Number.isFinite(server.uptimeSec) ? fmtClock(server.uptimeSec) : '—'),
    ));
    connection.appendChild(el('div', { className: 'settings-actions' },
      el('button', { type: 'button', className: 'btn btn-ghost btn-sm', dataset: { action: 'reconnect' } }, icon('refresh'), '重新连接'),
      el('button', { type: 'button', className: 'btn btn-ghost btn-sm', dataset: { action: 'refresh' } }, icon('activity'), '刷新数据'),
      el('button', { type: 'button', className: 'btn btn-ghost btn-sm', dataset: { action: 'diagnostics' } }, icon('copy'), '复制诊断信息'),
    ));
    connection.appendChild(el('p', { className: 'settings-note', text: 'SSE 断开时会自动重连（指数退避），期间降级为每 5 秒轮询 /api/snapshot。' }));
    wrap.appendChild(connection);

    const session = el('section', { className: 'settings-section' },
      el('h3', { text: '会话与令牌' }),
    );
    session.appendChild(el('div', { className: 'kv-grid' },
      kv('管理员令牌', maskToken(state.token), true),
      kv('存储位置', 'localStorage', true),
    ));
    session.appendChild(el('div', { className: 'settings-actions' },
      el('a', { className: 'btn btn-ghost btn-sm', href: (state.baseUrl || '') + '/m', target: '_blank', rel: 'noopener' }, '打开手机版 /m'),
      el('button', { type: 'button', className: 'btn btn-danger btn-sm', dataset: { action: 'logout' } }, icon('power'), '退出并清除令牌'),
    ));
    session.appendChild(el('p', { className: 'settings-note', text: '令牌仅保存在本机浏览器；清除后需重新输入 Hub 启动日志中的 adminToken。' }));
    wrap.appendChild(session);

    // APK 专用：常驻通知开关（浏览器中没有 ButlerBridge，自动隐藏）
    let appBridge = null;
    try {
      appBridge = window.ButlerBridge;
    } catch (e) {
      appBridge = null;
    }
    if (appBridge && typeof appBridge.getNotificationSettings === 'function'
        && typeof appBridge.setPersistentNotification === 'function') {
      const notifySection = el('section', { className: 'settings-section' },
        el('h3', { text: '手机通知（APK）' }),
      );
      const toggle = el('input', { type: 'checkbox', id: 'persistent-notify-toggle' });
      const label = el('label', { className: 'settings-note', style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' } },
        toggle, ' 启用常驻通知栏');
      const status = el('p', { className: 'settings-note', text: '任务进行中显示进度条；没有任务时显示在线 / 待命主机数量。' });
      notifySection.appendChild(label);
      notifySection.appendChild(status);
      wrap.appendChild(notifySection);

      const describe = (info) => {
        if (!info || !info.ok) return '无法读取通知设置';
        if (!info.enabled) return '未开启。开启后通知栏会常驻显示管家状态。';
        return info.permissionGranted
          ? '已开启：通知栏会常驻显示任务进度或在线/待命统计。'
          : '已开启，但通知权限未授予；请在系统设置中允许「BattleStar」通知。';
      };
      try {
        const info = JSON.parse(appBridge.getNotificationSettings());
        toggle.checked = !!info.enabled;
        status.textContent = tx(describe(info));
      } catch (e) {
        status.textContent = tx('无法读取通知设置');
      }
      toggle.addEventListener('change', () => {
        try {
          const result = JSON.parse(appBridge.setPersistentNotification(toggle.checked));
          if (!result || !result.ok) {
            toggle.checked = !toggle.checked;
            toast((result && result.message) || '设置失败', 'error');
            return;
          }
          toggle.checked = !!result.enabled;
          status.textContent = describe(result);
          toast(result.enabled ? '常驻通知已开启' : '常驻通知已关闭', 'success');
        } catch (e) {
          toggle.checked = !toggle.checked;
          toast('设置常驻通知失败', 'error');
        }
      });
    }

    const languageSection = el('section', { className: 'settings-section' },
      el('h3', { text: tr('settings.languageSection') }),
      el('p', { className: 'settings-note', text: tr('settings.languageHint') }),
      el('div', { className: 'settings-actions' }, buildLanguageSelect()),
    );
    wrap.appendChild(languageSection);

    const maintenance = el('section', { className: 'settings-section' },
      el('h3', { text: '系统维护' }),
      el('p', { className: 'settings-note', text: '重启会先通知所有在线设备代理自我重启，随后 Hub 自动重启；运行中的任务会自动重新排队（不占用重试次数）。' }),
      el('div', { className: 'settings-actions' },
        el('button', { type: 'button', className: 'btn btn-ghost btn-sm', dataset: { action: 'open-records' } }, icon('clock'), tr('settings.openRecords')),
        el('button', { type: 'button', className: 'btn btn-danger btn-sm', dataset: { action: 'restart-system' } }, icon('power'), '重启整套系统'),
      ),
      el('p', { className: 'settings-note', text: tr('settings.recordsHint') }),
      el('p', { className: 'settings-note', text: '等价接口：POST /api/system/restart（管理员令牌）。' }),
    );
    wrap.appendChild(maintenance);

    const about = el('section', { className: 'settings-section' },
      el('h3', { text: '关于' }),
      el('p', { className: 'settings-note', text: 'BattleStar 控制台 · 零依赖静态前端，同源加载 Hub 资源。设备能力、任务路由与事件流遵循协议 v1。' }),
      el('p', { className: 'settings-note', text: '手机端：底部 Tab 切换「状态 / 任务 / 指令 / 设置」，桌面端可通过右上角设置按钮打开本面板。' }),
    );
    wrap.appendChild(about);

    wrap.addEventListener('click', async (event) => {
      const btn = event.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'reconnect') {
        btn.disabled = true;
        try {
          const snapshot = await api('/api/snapshot?limit=50');
          applySnapshot(snapshot);
          startSse();
          toast('已重新连接实时通道', 'success');
        } catch (err) {
          if (err.status === 401) handleAuthLost(err.message);
          else toast(err.message || '重新连接失败', 'error');
        } finally {
          btn.disabled = false;
        }
      } else if (action === 'refresh') {
        refreshNow(true);
      } else if (action === 'diagnostics') {
        copyText(diagnostics(), '诊断信息已复制');
      } else if (action === 'open-records') {
        openRecordsDrawer();
      } else if (action === 'restart-system') {
        const ok = await confirmDialog({
          title: '重启整套系统',
          message: '将通知所有在线设备代理自我重启，随后 Hub 自动重启；运行中的任务会自动重新排队。确定继续？',
          okText: '立即重启',
        });
        if (!ok) return;
        btn.disabled = true;
        try {
          const res = await api('/api/system/restart', { method: 'POST', body: { reason: 'console' } });
          const devices = res && Number.isFinite(res.devices) ? res.devices : 0;
          const delaySec = Math.round(((res && res.delayMs) || 12000) / 1000);
          toast(`已通知 ${devices} 台设备，Hub 约 ${delaySec} 秒后重启…`, 'success', 6000);
          setTimeout(() => { try { refreshNow(true); } catch (e) { /* 忽略 */ } }, 3000);
          setTimeout(() => { try { startSse(); refreshNow(true); } catch (e) { /* 忽略 */ } }, 16000);
        } catch (err) {
          if (err.status === 401) handleAuthLost(err.message);
          else toast(err.message || '重启失败', 'error');
          btn.disabled = false;
        }
      } else if (action === 'logout') {
        logout();
      }
    });
    wrap.addEventListener('change', (event) => {
      const select = event.target.closest('#system-language');
      if (!select || !I18N) return;
      void changeLanguage(select.value);
    });
    return wrap;
  }

  function buildLanguageSelect() {
    const select = el('select', {
      id: 'system-language',
      className: 'settings-select',
      attrs: { 'aria-label': tr('settings.languageLabel') },
    });
    const languages = I18N && typeof I18N.getLanguages === 'function'
      ? I18N.getLanguages()
      : [{ id: 'zh-CN', label: '简体中文' }, { id: 'en', label: 'English' }];
    const active = currentLang();
    for (const language of languages) {
      const option = el('option', { value: language.id, text: language.label });
      if (language.id === active) option.selected = true;
      select.appendChild(option);
    }
    return select;
  }

  async function changeLanguage(language) {
    if (!I18N) return;
    const target = I18N.normalizeLang(language);
    try {
      const res = await api('/api/settings', { method: 'PATCH', body: { language: target } });
      if (res && res.settings) state.settings = res.settings;
      I18N.setLang(target, { persist: true });
      toast(tr('settings.languageSaved'), 'success');
      renderAll();
      if (state.drawer.open && state.drawer.kind === 'records') renderRecordsDrawer();
    } catch (err) {
      if (err.status === 401) handleAuthLost(err.message);
      else toast(err.message || tr('settings.languageFailed'), 'error');
      refreshSettings();
    }
  }

  function refreshSettings() {
    const wrap = $('#settings-inline-body');
    if (wrap && state.connected && !$('#app-view').hidden) {
      const settingsTabActive = !isMobile() || state.tab === 'settings';
      if (settingsTabActive) wrap.replaceChildren(buildSettings());
    }
    if (state.drawer.open && state.drawer.kind === 'settings') {
      const body = $('#drawer-body');
      if (body) {
        const scroll = body.scrollTop;
        body.replaceChildren(buildSettings());
        body.scrollTop = scroll;
      }
    }
  }

  function openSettingsDrawer() {
    openDrawer({
      kind: 'settings',
      id: null,
      title: '设置',
      subNodes: [el('span', { text: '连接、令牌与本机信息' })],
      body: buildSettings(),
      footerNodes: [
        el('button', { type: 'button', className: 'btn btn-ghost btn-sm', onclick: hideDrawer, text: '关闭' }),
        el('span', { className: 'spacer' }),
        el('button', { type: 'button', className: 'btn btn-danger btn-sm', onclick: logout }, icon('power'), '退出并清除令牌'),
      ],
    });
  }

  /* ==================================================================
   * 抽屉框架
   * ================================================================== */
  let drawerViewportBound = false;

  /** 手机浏览器地址栏/工具栏会压缩可视区域，用 visualViewport 校正抽屉高度，避免底部操作栏被裁掉。 */
  function syncDrawerViewport() {
    const root = $('#drawer-root');
    if (!root || root.hidden) return;
    if (!isMobile() || !window.visualViewport) {
      root.style.height = '';
      return;
    }
    root.style.height = `${Math.round(window.visualViewport.height)}px`;
  }

  function bindDrawerViewport() {
    if (drawerViewportBound) return;
    drawerViewportBound = true;
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', syncDrawerViewport);
      window.visualViewport.addEventListener('scroll', syncDrawerViewport);
    }
    window.addEventListener('orientationchange', syncDrawerViewport);
  }

  function unbindDrawerViewport() {
    if (!drawerViewportBound) return;
    drawerViewportBound = false;
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', syncDrawerViewport);
      window.visualViewport.removeEventListener('scroll', syncDrawerViewport);
    }
    window.removeEventListener('orientationchange', syncDrawerViewport);
    const root = $('#drawer-root');
    if (root) root.style.height = '';
  }

  /**
   * 分组抽屉底部操作栏：`spacer` 之前的按钮（通常是「关闭」）留在左侧，
   * 之后的按钮收进可换行的右侧操作组，避免按钮过多（如失败任务详情）时整行超出
   * 抽屉宽度、被 `.drawer { overflow: hidden }` 从右边缘裁切。
   */
  function groupDrawerFooterNodes(nodes) {
    const list = (nodes || []).filter(Boolean);
    const spacerIndex = list.findIndex((node) => node && node.nodeType === 1 && node.classList && node.classList.contains('spacer'));
    if (spacerIndex < 0) return list;
    const left = list.slice(0, spacerIndex);
    const right = list.slice(spacerIndex + 1);
    if (!right.length) return left;
    return [...left, el('div', { className: 'drawer-foot-actions' }, ...right)];
  }

  function openDrawer({ kind, id, title, subNodes, body, footerNodes }) {
    state.drawer = {
      open: true,
      kind,
      id,
      returnFocus: document.activeElement,
    };
    setText('#drawer-title', title || '详情');
    const sub = $('#drawer-sub');
    sub.replaceChildren();
    for (const node of (subNodes || [])) {
      if (node) sub.appendChild(node instanceof Node ? node : document.createTextNode(tx(String(node))));
    }
    $('#drawer-body').replaceChildren(body || '');
    const foot = $('#drawer-foot');
    if (footerNodes && footerNodes.length) {
      foot.replaceChildren(...groupDrawerFooterNodes(footerNodes));
      foot.hidden = false;
    } else {
      foot.replaceChildren();
      foot.hidden = true;
    }
    $('#drawer-root').hidden = false;
    document.body.classList.add('no-scroll');
    bindDrawerViewport();
    syncDrawerViewport();
    const drawer = $('#drawer');
    requestAnimationFrame(() => drawer.focus({ preventScroll: true }));
  }

  function hideDrawer() {
    if (!state.drawer.open) return;
    deviceNicknameDraft = null;
    clearTimeout(goalDetailTimer);
    goalDetailTimer = 0;
    unbindDrawerViewport();
    $('#drawer-root').hidden = true;
    document.body.classList.remove('no-scroll');
    const returnFocus = state.drawer.returnFocus;
    state.drawer = { open: false, kind: null, id: null, returnFocus: null };
    if (returnFocus && typeof returnFocus.focus === 'function' && returnFocus.isConnected) {
      try {
        returnFocus.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
    }
  }

  /** 仅替换抽屉内容（不重置 returnFocus，用于抽屉内部翻页/刷新）。 */
  function updateDrawerContent({ title, subNodes, body, footerNodes }) {
    setText('#drawer-title', title || tr('common.details'));
    const sub = $('#drawer-sub');
    sub.replaceChildren();
    for (const node of (subNodes || [])) {
      if (node) sub.appendChild(node instanceof Node ? node : document.createTextNode(tx(String(node))));
    }
    $('#drawer-body').replaceChildren(body || '');
    const foot = $('#drawer-foot');
    if (footerNodes && footerNodes.length) {
      foot.replaceChildren(...groupDrawerFooterNodes(footerNodes));
      foot.hidden = false;
    } else {
      foot.replaceChildren();
      foot.hidden = true;
    }
  }

  function refreshOpenDrawer() {
    if (!state.drawer.open) return;
    if (state.drawer.kind === 'device') refreshDeviceDrawer(state.drawer.id);
    else if (state.drawer.kind === 'task') refreshTaskDrawer(state.drawer.id);
    else if (state.drawer.kind === 'goal') renderGoalDrawer({ preserveScroll: true });
  }

  /* ==================================================================
   * 执行记录（Markdown backtrace）
   * ================================================================== */
  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function mdInline(raw) {
    let text = escapeHtml(raw);
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, href) => {
      const found = /^(?:.+\/)?(task_[A-Za-z0-9]+)\.md$/.exec(href);
      if (!found) return match;
      return `<a href="#" class="record-link" data-record-id="${escapeHtml(found[1])}">${label}</a>`;
    });
    return text;
  }

  /** 字符串版 Markdown → HTML（仅用于 innerHTML 场景：记录抽屉 / 每晚总结 / 目标总结）；任务输出请用 DOM 版 renderMarkdown。 */
  function renderMarkdownHtml(markdown) {
    const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
    const html = [];
    let paragraph = [];
    let inCode = false;
    let fenceMarker = '';
    let fenceLength = 0;
    let codeLines = [];
    let i = 0;
    const flushParagraph = () => {
      if (!paragraph.length) return;
      html.push(`<p>${mdInline(paragraph.join(' '))}</p>`);
      paragraph = [];
    };
    while (i < lines.length) {
      const line = lines[i];
      const fenceMatch = /^(`{3,}|~{3,})/.exec(line);
      if (inCode) {
        const closes =
          fenceMatch &&
          fenceMatch[1][0] === fenceMarker &&
          fenceMatch[1].length >= fenceLength &&
          /^(`{3,}|~{3,})\s*$/.test(line);
        if (closes) {
          html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
          inCode = false;
          fenceMarker = '';
          fenceLength = 0;
          codeLines = [];
          i += 1;
          continue;
        }
        codeLines.push(line);
        i += 1;
        continue;
      }
      if (fenceMatch) {
        flushParagraph();
        inCode = true;
        fenceMarker = fenceMatch[1][0];
        fenceLength = fenceMatch[1].length;
        codeLines = [];
        i += 1;
        continue;
      }
      if (!line.trim()) {
        flushParagraph();
        i += 1;
        continue;
      }
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        flushParagraph();
        const level = Math.min(6, heading[1].length);
        html.push(`<h${level}>${mdInline(heading[2])}</h${level}>`);
        i += 1;
        continue;
      }
      if (/^---+$/.test(line.trim())) {
        flushParagraph();
        html.push('<hr>');
        i += 1;
        continue;
      }
      if (/^>\s?/.test(line)) {
        flushParagraph();
        const quote = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          quote.push(lines[i].replace(/^>\s?/, ''));
          i += 1;
        }
        html.push(`<blockquote>${mdInline(quote.join(' '))}</blockquote>`);
        continue;
      }
      const table = parseTableAt(lines, i);
      if (table) {
        flushParagraph();
        const head = table.head
          .map((cell, index) => `<th class="${tableAlignClass(table.aligns[index])}" scope="col">${mdInline(cell)}</th>`)
          .join('');
        const body = table.rows
          .map((row) => `<tr>${table.head
            .map((label, index) => `<td class="${tableAlignClass(table.aligns[index])}" data-label="${escapeHtml(label)}">${mdInline(row[index] || '')}</td>`)
            .join('')}</tr>`)
          .join('');
        html.push(`<div class="md-table-wrap"><table class="md-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);
        i = table.next;
        continue;
      }
      if (/^- /.test(line)) {
        flushParagraph();
        const items = [];
        while (i < lines.length && /^- /.test(lines[i])) {
          items.push(`<li>${mdInline(lines[i].slice(2))}</li>`);
          i += 1;
        }
        html.push(`<ul>${items.join('')}</ul>`);
        continue;
      }
      if (/^\d+\. /.test(line)) {
        flushParagraph();
        const items = [];
        while (i < lines.length && /^\d+\. /.test(lines[i])) {
          items.push(`<li>${mdInline(lines[i].replace(/^\d+\.\s+/, ''))}</li>`);
          i += 1;
        }
        html.push(`<ol>${items.join('')}</ol>`);
        continue;
      }
      paragraph.push(line);
      i += 1;
    }
    flushParagraph();
    if (inCode) html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
    return html.join('\n');
  }

  function openRecordsDrawer() {
    state.records.detail = null;
    openDrawer({
      kind: 'records',
      id: null,
      title: tr('records.title'),
      subNodes: [el('span', { text: tr('records.subtitle') })],
      body: el('p', { className: 'record-empty', text: tr('records.loading') }),
      footerNodes: [el('button', { type: 'button', className: 'btn btn-ghost btn-sm', text: tr('common.close'), onclick: hideDrawer })],
    });
    void loadRecords();
  }

  function renderRecordsDrawer() {
    if (!state.drawer.open || state.drawer.kind !== 'records') return;
    if (state.records.detail) {
      renderRecordDetailView();
      return;
    }
    const wrap = el('div', { className: 'records-wrap' });
    const toolbar = el('div', { className: 'records-toolbar' });
    const search = el('input', {
      type: 'search',
      className: 'records-search',
      attrs: { placeholder: tr('records.searchPlaceholder'), 'aria-label': tr('records.searchPlaceholder') },
    });
    search.value = state.records.q;
    let searchTimer = 0;
    search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.records.q = search.value.trim();
        void loadRecords();
      }, 320);
    });
    const statusSelect = el('select', { className: 'records-status', attrs: { 'aria-label': tr('records.filterAll') } });
    const options = [
      ['', tr('records.filterAll')],
      ['queued', tr('status.queued')],
      ['assigned', tr('status.assigned')],
      ['running', tr('status.running')],
      ['waiting', tr('status.waiting')],
      ['completed', tr('status.completed')],
      ['failed', tr('status.failed')],
      ['timeout', tr('status.timeout')],
      ['cancelled', tr('status.cancelled')],
    ];
    for (const [value, label] of options) {
      const option = el('option', { value, text: label });
      if (value === state.records.status) option.selected = true;
      statusSelect.appendChild(option);
    }
    statusSelect.addEventListener('change', () => {
      state.records.status = statusSelect.value;
      void loadRecords();
    });
    const refreshBtn = el('button', { type: 'button', className: 'btn btn-ghost btn-sm' }, icon('refresh'), tr('common.refresh'));
    refreshBtn.addEventListener('click', () => void loadRecords());
    const count = el('span', { className: 'records-count', id: 'records-count', text: tr('records.count', { n: state.records.total }) });
    toolbar.append(search, statusSelect, refreshBtn, count);
    wrap.appendChild(toolbar);
    const list = el('div', { className: 'records-list', id: 'records-list' });
    wrap.appendChild(list);
    renderRecordsListInto(list);
    updateDrawerContent({
      title: tr('records.title'),
      subNodes: [el('span', { text: tr('records.subtitle') })],
      body: wrap,
      footerNodes: [el('button', { type: 'button', className: 'btn btn-ghost btn-sm', text: tr('common.close'), onclick: hideDrawer })],
    });
  }

  function renderRecordsListInto(container) {
    if (!container) return;
    container.replaceChildren();
    if (state.records.loading) {
      container.appendChild(el('p', { className: 'record-empty', text: tr('records.loading') }));
      return;
    }
    if (state.records.error) {
      container.appendChild(el('p', { className: 'record-empty record-error', text: state.records.error }));
      return;
    }
    if (!state.records.items.length) {
      container.appendChild(el('p', { className: 'record-empty', text: tr('records.empty') }));
      return;
    }
    for (const item of state.records.items) {
      const card = el('button', { type: 'button', className: 'record-item', dataset: { taskId: item.taskId } });
      card.appendChild(
        el('div', { className: 'record-item-top' },
          statusBadge(item.status),
          el('span', { className: 'record-item-id mono', text: item.taskId }),
          el('span', { className: 'record-item-time', text: fmtDateTime(item.createdAt) }),
        ),
      );
      card.appendChild(el('div', { className: 'record-item-summary', text: shorten(item.summary, 90) }));
      const meta = [`${tr('records.duration')} ${fmtDuration(item.durationMs)}`];
      if (item.device) meta.push(item.device);
      meta.push(item.hasFile ? formatBytes(item.size) : tr('records.noFile'));
      card.appendChild(el('div', { className: 'record-item-meta', text: meta.join(' · ') }));
      if (item.error) card.appendChild(el('div', { className: 'record-item-error', text: shorten(item.error, 100) }));
      card.addEventListener('click', () => void openRecordDetail(item.taskId));
      container.appendChild(card);
    }
  }

  async function loadRecords() {
    if (!state.connected) return;
    state.records.loading = true;
    state.records.error = '';
    const list = $('#records-list');
    if (list) renderRecordsListInto(list);
    else renderRecordsDrawer();
    try {
      const params = new URLSearchParams();
      params.set('limit', '100');
      if (state.records.q) params.set('q', state.records.q);
      if (state.records.status) params.set('status', state.records.status);
      const res = await api(`/api/records?${params.toString()}`, { timeout: 20000 });
      state.records.items = arr(res && res.records);
      state.records.total = num(res && res.total, state.records.items.length);
      state.records.recordDir = str(res && res.recordDir);
    } catch (err) {
      if (err.status === 401) {
        handleAuthLost(err.message);
        return;
      }
      state.records.error = err.message || tr('records.loadFailed');
    } finally {
      state.records.loading = false;
      if (state.drawer.open && state.drawer.kind === 'records' && !state.records.detail) {
        const box = $('#records-list');
        if (box) {
          renderRecordsListInto(box);
          setText('#records-count', tr('records.count', { n: state.records.total }));
        } else {
          renderRecordsDrawer();
        }
      }
    }
  }

  async function openRecordDetail(taskId) {
    state.records.detail = { taskId, loading: true, error: '', record: null };
    renderRecordsDrawer();
    try {
      const res = await api(`/api/records/${encodeURIComponent(taskId)}`, { timeout: 20000 });
      state.records.detail = { taskId, loading: false, error: '', record: res && res.record ? res.record : null };
      if (!state.records.detail.record) state.records.detail.error = tr('records.missing');
    } catch (err) {
      if (err.status === 401) {
        handleAuthLost(err.message);
        return;
      }
      state.records.detail = { taskId, loading: false, error: err.message || tr('records.missing'), record: null };
    }
    if (state.drawer.open && state.drawer.kind === 'records') renderRecordsDrawer();
  }

  function renderRecordDetailView() {
    const detail = state.records.detail;
    if (!detail) return;
    const backBtn = el('button', { type: 'button', className: 'btn btn-ghost btn-sm' }, tr('records.back'));
    backBtn.addEventListener('click', () => {
      state.records.detail = null;
      renderRecordsDrawer();
    });
    if (detail.loading) {
      updateDrawerContent({
        title: detail.taskId,
        subNodes: [el('span', { text: tr('records.loading') })],
        body: el('p', { className: 'record-empty', text: tr('records.loading') }),
        footerNodes: [backBtn, el('button', { type: 'button', className: 'btn btn-ghost btn-sm', text: tr('common.close'), onclick: hideDrawer })],
      });
      return;
    }
    const record = detail.record;
    if (!record) {
      updateDrawerContent({
        title: detail.taskId,
        subNodes: [el('span', { text: tr('records.error') })],
        body: el('p', { className: 'record-empty record-error', text: detail.error || tr('records.missing') }),
        footerNodes: [backBtn, el('button', { type: 'button', className: 'btn btn-ghost btn-sm', text: tr('common.close'), onclick: hideDrawer })],
      });
      return;
    }
    const meta = el('div', { className: 'record-meta kv-grid' },
      kv(tr('records.task'), record.taskId, true),
      kv(tr('records.size'), formatBytes(record.size)),
      kv(tr('records.updatedAt'), fmtDateTime(record.updatedAt)),
      kv(tr('records.file'), record.file || '—', true),
    );
    const article = el('article', { className: 'record-markdown' });
    article.innerHTML = renderMarkdownHtml(record.markdown);
    article.addEventListener('click', (event) => {
      const link = event.target.closest('[data-record-id]');
      if (!link) return;
      event.preventDefault();
      void openRecordDetail(link.dataset.recordId);
    });
    const body = el('div', { className: 'records-wrap' }, meta, article);
    const copyBtn = el('button', { type: 'button', className: 'btn btn-ghost btn-sm' }, icon('copy'), tr('records.copy'));
    copyBtn.addEventListener('click', () => copyText(record.markdown, tr('records.copied')));
    const copyIdBtn = el('button', { type: 'button', className: 'btn btn-ghost btn-sm' }, icon('copy'), '复制任务 ID');
    copyIdBtn.addEventListener('click', () => copyText(record.taskId, '任务 ID 已复制'));
    const downloadBtn = el('button', { type: 'button', className: 'btn btn-ghost btn-sm' });
    downloadBtn.append(icon('send'), document.createTextNode(tr('records.download')));
    downloadBtn.addEventListener('click', () => {
      try {
        const blob = new Blob([record.markdown], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = el('a', { href: url, download: `${record.taskId}.md` });
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
        toast(tr('records.downloaded'), 'success');
      } catch (err) {
        toast(err.message || tr('records.loadFailed'), 'error');
      }
    });
    updateDrawerContent({
      title: record.taskId,
      subNodes: [el('span', { text: tr('records.subtitle') })],
      body,
      footerNodes: [
        backBtn,
        copyIdBtn,
        copyBtn,
        downloadBtn,
        el('span', { className: 'spacer' }),
        el('button', { type: 'button', className: 'btn btn-ghost btn-sm', text: tr('common.close'), onclick: hideDrawer }),
      ],
    });
  }

  /* ==================================================================
   * 设备详情抽屉
   * ================================================================== */
  /**
   * 设备昵称的“未提交草稿”（声明在模块顶部）：抽屉会被快照轮询/设备事件反复重建，
   * 没有它的话输入内容会被服务端数据覆盖（表现为输入框不断闪空）。
   */

  function buildDeviceBody(device) {
    const caps = capsOf(device);
    const load = loadOf(device);
    const metrics = (device.metrics && typeof device.metrics === 'object') ? device.metrics : {};
    const models = arr(caps.models);
    const skills = arr(caps.skills);
    const profiles = arr(caps.profiles);
    const gateways = arr(caps.gateways);
    const resources = (caps.resources && typeof caps.resources === 'object') ? caps.resources : {};
    const limits = (caps.limits && typeof caps.limits === 'object') ? caps.limits : {};
    const status = deviceStatusOf(device);
    const body = el('div');

    /* 昵称：用户自定义的用途标签，保存在 Hub 侧，不会被设备重报的机器名覆盖 */
    const nicknameSection = el('section', { className: 'detail-section' },
      el('div', { className: 'detail-section-head' },
        el('h3', { text: '设备昵称' }),
        el('span', { className: 'muted', style: { fontSize: '10.5px' }, text: '只保存在本机 Hub，用来标注用途' }),
      ),
    );
    const nicknameInput = el('input', {
      type: 'text',
      className: 'nickname-input',
      attrs: { 'aria-label': '设备昵称', maxlength: '40', placeholder: '例如：书房工作站（写代码）' },
    });
    const draft = deviceNicknameDraft && deviceNicknameDraft.deviceId === device.id ? deviceNicknameDraft.value : null;
    nicknameInput.value = draft != null ? draft : (device.nickname || '');
    nicknameInput.addEventListener('input', () => {
      deviceNicknameDraft = { deviceId: device.id, value: nicknameInput.value };
    });
    nicknameInput.addEventListener('blur', () => {
      /* 草稿和已保存值一样时清掉，让抽屉恢复正常自动刷新 */
      if (deviceNicknameDraft && deviceNicknameDraft.deviceId === device.id
        && String(deviceNicknameDraft.value || '').trim() === String(device.nickname || '')) {
        deviceNicknameDraft = null;
      }
    });
    const saveNickname = () => { void saveDeviceNickname(device.id, nicknameInput.value); };
    nicknameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        saveNickname();
      }
    });
    nicknameSection.appendChild(el('div', { className: 'nickname-row' },
      nicknameInput,
      el('button', { type: 'button', className: 'btn btn-primary btn-sm', text: '保存昵称', onclick: saveNickname }),
      el('button', {
        type: 'button',
        className: 'btn btn-ghost btn-sm',
        text: '清除昵称',
        onclick: () => {
          nicknameInput.value = '';
          deviceNicknameDraft = { deviceId: device.id, value: '' };
          saveNickname();
        },
      }),
    ));
    /* 旧版 Hub 的 deviceToJson 里没有 nickname 字段：直接提示并给一键重启入口 */
    if (typeof device.nickname !== 'string') {
      nicknameSection.appendChild(el('div', { className: 'nickname-hint nickname-warn' },
        el('span', { text: '当前 Hub 还没加载昵称功能，重启后即可保存' }),
        el('button', { type: 'button', className: 'btn btn-ghost btn-sm', text: '重启 Hub', onclick: restartHubForNickname }),
      ));
    }
    body.appendChild(nicknameSection);

    /* 运行状态 */
    const statusSection = el('section', { className: 'detail-section' },
      el('div', { className: 'detail-section-head' }, el('h3', { text: '运行状态' })),
    );
    statusSection.appendChild(el('div', { className: 'detail-load' },
      el('span', { className: 'detail-load-label', text: '任务负载' }),
      el('div', { className: 'bar', dataset: { tone: 'load', level: load.ratio >= 0.75 ? 'high' : 'low' } },
        el('span', { style: { width: `${Math.round(load.ratio * 100)}%` } }),
      ),
      el('span', { className: 'detail-load-val', text: `${load.running} / ${load.max}` }),
    ));
    const metricsGrid = el('div', { className: 'detail-metrics' },
      metricBox('状态', DEVICE_STATUS[status] || status, `最近心跳 ${fmtRel(device.lastSeenAt)}`, undefined, status),
      metricBox('CPU', Number.isFinite(metrics.cpuPct) ? `${Math.round(metrics.cpuPct)}%` : '—',
        Number.isFinite(metrics.cpuPct) ? null : '未上报', Number.isFinite(metrics.cpuPct) ? Math.min(100, metrics.cpuPct) : null),
      metricBox('内存', Number.isFinite(metrics.memPct) ? `${Math.round(metrics.memPct)}%` : '—',
        Number.isFinite(metrics.uptimeSec) ? `已运行 ${fmtClock(metrics.uptimeSec)}` : '未上报',
        Number.isFinite(metrics.memPct) ? Math.min(100, metrics.memPct) : null),
    );
    statusSection.appendChild(metricsGrid);
    body.appendChild(statusSection);

    /* 能力清单 */
    const capSection = el('section', { className: 'detail-section' },
      el('div', { className: 'detail-section-head' }, el('h3', { text: '能力清单' })),
    );
    capSection.appendChild(capGroup('模型', models.length, models, (model) => {
      const available = model.available !== false;
      const sub = [
        model.provider ? `provider: ${model.provider}` : '',
        model.contextWindow ? `上下文 ${fmtNum(model.contextWindow)}` : '',
        arr(model.strengths).length ? `擅长 ${arr(model.strengths).join(' / ')}` : '',
      ].filter(Boolean).join(' · ');
      return capItem(
        el('span', { className: 'mono', text: model.id }),
        sub || '未提供更多信息',
        el('span', { className: 'cap-badge ' + (available ? 'is-ok' : 'is-off'), text: available ? '可用' : '不可用' }),
      );
    }, '未申报模型，只能接收不限模型的任务。'));

    capSection.appendChild(capGroup('技能', skills.length, skills, (skill) => capItem(
      el('span', { text: skill.name || skill.id }),
      `${skill.id}${skill.version ? ' · v' + skill.version : ''}`,
      null,
    ), '未申报技能。'));

    capSection.appendChild(capGroup('配置 Profile', profiles.length, profiles, (profile) => capItem(
      el('span', { text: profile.name || profile.id }),
      [profile.id, arr(profile.plugins).length ? `${arr(profile.plugins).length} 个插件` : ''].filter(Boolean).join(' · '),
      null,
    ), '未申报 DSH profile。'));

    capSection.appendChild(capGroup('模型网关', gateways.length, gateways, (gateway) => capItem(
      el('span', { className: 'mono', text: gateway.id }),
      [gateway.kind, gateway.baseUrl, arr(gateway.models).length ? `模型 ${arr(gateway.models).join(' / ')}` : ''].filter(Boolean).join(' · ') || '未提供更多信息',
      null,
    ), '未配置模型网关。'));
    body.appendChild(capSection);

    /* 资源 */
    const resSection = el('section', { className: 'detail-section' },
      el('div', { className: 'detail-section-head' }, el('h3', { text: '资源与限制' })),
      el('div', { className: 'detail-kv-grid' },
        kv('CPU 核心', Number.isFinite(resources.cpuCores) ? `${resources.cpuCores} 核` : '—'),
        kv('内存', Number.isFinite(resources.memoryGB) ? `${resources.memoryGB} GB` : '—'),
        kv('GPU', resources.gpu || '—'),
        kv('操作系统', resources.os || '—'),
        kv('最大并发', Number.isFinite(limits.maxConcurrentTasks) ? limits.maxConcurrentTasks : load.max),
        kv('代理版本', device.agentVersion || '—'),
      ),
    );
    body.appendChild(resSection);

    /* 最近任务 */
    const recent = state.tasks
      .filter((task) => task.assignedDeviceId === device.id)
      .sort((a, b) => (parseIso(b.createdAt) || 0) - (parseIso(a.createdAt) || 0))
      .slice(0, 5);
    const taskSection = el('section', { className: 'detail-section' },
      el('div', { className: 'detail-section-head' }, el('h3', { text: '最近任务' })),
    );
    if (!recent.length) {
      taskSection.appendChild(el('div', { className: 'detail-empty', text: '这台设备还没有执行过任务。' }));
    } else {
      const list = el('div', { className: 'mini-task-list' });
      for (const task of recent) {
        list.appendChild(el('button', { type: 'button', className: 'mini-task', dataset: { taskId: task.id }, onclick: () => openTaskDrawer(task.id) },
          statusBadge(task.status),
          el('span', { className: 'mini-task-text', text: shorten(task.instruction, 40) }),
          relNode(task.createdAt),
        ));
      }
      taskSection.appendChild(list);
    }
    body.appendChild(taskSection);

    /* 连接信息 */
    const infoSection = el('section', { className: 'detail-section' },
      el('div', { className: 'detail-section-head' }, el('h3', { text: '连接信息' })),
      el('div', { className: 'detail-kv-grid' },
        kv('设备 ID', device.id, true),
        /* 设置了用途昵称就只显示昵称，机器名只对没起昵称的设备展示 */
        device.nickname ? null : kv('机器名', device.name || '—', true),
        kv('端点', device.endpoint || '—', true),
        kv('平台', `${device.platform || '—'} / ${device.kind || '—'}`),
        kv('注册时间', fmtDateTime(device.registeredAt)),
        kv('最后心跳', fmtDateTime(device.lastSeenAt)),
        kv('标签', tagsOf(device).join('、') || '—'),
      ),
    );
    body.appendChild(infoSection);

    if (device.disabled) {
      body.prepend(el('div', { className: 'detail-empty', text: '该设备已被禁用：不会参与任务路由，但保留注册信息。' }));
    }
    return body;
  }

  function metricBox(label, value, sub, percent, status) {
    const box = el('div', { className: 'metric-box' },
      el('div', { className: 'metric-label', text: label }),
      el('div', { className: 'metric-value', dataset: status ? { status } : undefined, text: String(value) }),
    );
    if (sub) box.appendChild(el('div', { className: 'metric-label', text: sub, style: { marginTop: '2px' } }));
    if (Number.isFinite(percent)) {
      box.appendChild(el('div', { className: 'bar metric-bar', dataset: { tone: 'load', level: percent >= 75 ? 'high' : 'low' } },
        el('span', { style: { width: `${percent}%` } }),
      ));
    }
    return box;
  }

  function capGroup(title, count, items, renderer, emptyText) {
    const group = el('div', { className: 'detail-section' });
    group.appendChild(el('div', { className: 'cap-group-title' },
      el('span', { text: title }),
      el('span', { className: 'count', text: `(${count})` }),
    ));
    if (!items.length) {
      group.appendChild(el('div', { className: 'detail-empty', text: emptyText }));
      return group;
    }
    const block = el('div', { className: 'cap-block' });
    for (const item of items) block.appendChild(renderer(item));
    group.appendChild(block);
    return group;
  }

  function capItem(titleNode, sub, sideNode) {
    return el('div', { className: 'cap-item' },
      el('div', { className: 'cap-item-main' },
        el('div', { className: 'cap-item-title' }, titleNode),
        el('div', { className: 'cap-item-sub', text: sub || '' }),
      ),
      el('div', { className: 'cap-item-side' }, sideNode || null),
    );
  }

  function deviceFooterNodes(device) {
    return [
      el('span', { className: 'muted', style: { fontSize: '10.5px' }, text: device.id }),
      el('span', { className: 'spacer' }),
      el('button', { type: 'button', className: 'btn btn-ghost btn-sm', onclick: () => refreshDevice(device.id) }, icon('refresh'), '刷新'),
      el('button', {
        type: 'button',
        className: 'btn btn-ghost btn-sm',
        onclick: () => toggleDeviceDisabled(device.id),
      }, icon('power'), device.disabled ? '启用设备' : '禁用设备'),
      el('button', { type: 'button', className: 'btn btn-danger btn-sm', onclick: () => deleteDevice(device.id) }, icon('trash'), '删除'),
    ];
  }

  function deviceNicknameInputFocused() {
    const input = document.querySelector('#drawer-body .nickname-input');
    return !!(input && document.activeElement === input);
  }

  /** 有没保存的昵称改动（含“已输入但焦点已移到保存按钮”的情况）时，先别重建抽屉。 */
  function deviceNicknameBusy(id) {
    if (deviceNicknameInputFocused()) return true;
    const draft = deviceNicknameDraft;
    if (!draft || draft.deviceId !== id) return false;
    const device = state.devices.get(id);
    return String(draft.value || '').trim() !== String((device && device.nickname) || '');
  }

  function renderDeviceDrawer(device, preserveScroll) {
    const bodyEl = $('#drawer-body');
    const scroll = preserveScroll ? bodyEl.scrollTop : 0;
    const prevInput = bodyEl.querySelector('.nickname-input');
    const hadFocus = !!(prevInput && document.activeElement === prevInput);
    const selStart = hadFocus ? prevInput.selectionStart : null;
    const selEnd = hadFocus ? prevInput.selectionEnd : null;
    setText('#drawer-title', deviceDisplayName(device));
    const sub = $('#drawer-sub');
    const drawerStatus = deviceStatusOf(device);
    sub.replaceChildren(
      el('i', {
        className: 'status-dot',
        dataset: { tone: device.online ? (device.status === 'busy' ? 'busy' : 'online') : 'offline' },
      }),
      el('span', { className: 'device-state', dataset: { status: drawerStatus }, text: DEVICE_STATUS[drawerStatus] || drawerStatus }),
      el('span', { text: '·' }),
      el('span', { text: `${PLATFORM_LABEL[device.platform] || device.platform || '未知平台'} · ${KIND_LABEL[device.kind] || device.kind || '设备'}` }),
    );
    bodyEl.replaceChildren(buildDeviceBody(device));
    deviceDrawerSig = JSON.stringify(device);
    bodyEl.scrollTop = scroll;
    const nextInput = bodyEl.querySelector('.nickname-input');
    if (nextInput && hadFocus && !deviceNicknameDraft) {
      /* 只是被动刷新：把焦点和光标还给用户，别打断输入 */
      try {
        nextInput.focus({ preventScroll: true });
        if (selStart != null && selEnd != null) nextInput.setSelectionRange(selStart, selEnd);
      } catch {
        /* ignore */
      }
    }
    const foot = $('#drawer-foot');
    foot.replaceChildren(...groupDrawerFooterNodes(deviceFooterNodes(device)));
    foot.hidden = false;
  }

  function openDeviceDrawer(id) {
    const device = state.devices.get(id);
    if (!device) {
      toast('设备不存在或已被移除', 'warn');
      return;
    }
    deviceNicknameDraft = null;
    openDrawer({
      kind: 'device',
      id,
      title: deviceDisplayName(device),
      subNodes: [],
      body: null,
      footerNodes: [],
    });
    renderDeviceDrawer(device, false);
  }

  function refreshDeviceDrawer(id, force) {
    if (!state.drawer.open || state.drawer.kind !== 'device' || state.drawer.id !== id) return;
    /* 用户正在输入或还有未保存的昵称时不要重建抽屉：重建会打断输入法组合（中文昵称）并让输入框闪空 */
    if (!force && deviceNicknameBusy(id)) return;
    const device = state.devices.get(id);
    if (!device) {
      hideDrawer();
      return;
    }
    if (!force && deviceDrawerSig === JSON.stringify(device)) return;
    renderDeviceDrawer(device, true);
  }

  async function refreshDevice(id) {
    try {
      const res = await api(`/api/devices/${encodeURIComponent(id)}`, { timeout: 8000 });
      if (res && res.device) state.devices.set(id, res.device);
      state.sigs.devices = '';
      renderDevices();
      refreshDeviceDrawer(id);
      toast('设备信息已刷新', 'success');
    } catch (err) {
      if (err.status === 401) return handleAuthLost(err.message);
      toast(err.message || '刷新失败', 'error');
    }
  }

  /** 让旧版 Hub 加载昵称相关后端代码（/api/system/restart 会 re-exec 进程）。 */
  async function restartHubForNickname() {
    const ok = await confirmDialog({
      title: '重启 Hub 以启用设备昵称',
      message: '昵称功能需要 Hub 重启后才会生效；重启期间运行中的任务会自动重新排队。确定现在重启？',
      okText: '重启 Hub',
    });
    if (!ok) return;
    try {
      await api('/api/system/restart', { method: 'POST', body: { reason: 'console:device-nickname' }, timeout: 10000 });
      const warn = document.querySelector('#drawer-body .nickname-warn');
      if (warn) warn.remove();
      toast('Hub 正在重启，约 15 秒后自动重连…', 'success', 6000);
      setTimeout(() => { try { refreshNow(true); } catch { /* ignore */ } }, 16000);
      setTimeout(() => { try { startSse(); refreshNow(true); } catch { /* ignore */ } }, 18000);
    } catch (err) {
      if (err.status === 401) return handleAuthLost(err.message);
      toast(err.message || '重启失败', 'error');
    }
  }

  async function saveDeviceNickname(id, nickname) {
    const device = state.devices.get(id);
    if (!device) return;
    const next = String(nickname == null ? '' : nickname).trim();
    if (next.length > 40) {
      toast('设备昵称最多 40 个字符', 'warn');
      return;
    }
    if (next === (device.nickname || '')) {
      toast(next ? '昵称没有变化' : '昵称已是空', 'warn');
      return;
    }
    try {
      const res = await api(`/api/devices/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { nickname: next },
        timeout: 10000,
      });
      const updated = (res && res.device) || null;
      if (!updated || typeof updated.nickname !== 'string') {
        /* 旧版 Hub 不认识 nickname，会 200 返回原设备：不要谎报成功 */
        toast('昵称未保存：Hub 需要重启后才能保存昵称', 'warn', 6000);
        return;
      }
      if (updated.nickname !== next) {
        toast('昵称没有保存成功，请重启 Hub 后重试', 'warn', 6000);
        return;
      }
      state.devices.set(id, { ...device, ...updated });
      state.sigs.devices = '';
      state.sigs.composer = '';
      deviceNicknameDraft = null;
      renderAll();
      refreshDeviceDrawer(id, true);
      toast(next ? '设备昵称已保存' : '设备昵称已清除', 'success');
    } catch (err) {
      if (err.status === 401) return handleAuthLost(err.message);
      toast(err.message || '昵称保存失败', 'error');
    }
  }

  async function toggleDeviceDisabled(id) {
    const device = state.devices.get(id);
    if (!device) return;
    const next = !device.disabled;
    try {
      const res = await api(`/api/devices/${encodeURIComponent(id)}`, { method: 'PATCH', body: { disabled: next }, timeout: 10000 });
      const updated = (res && res.device) || { ...device, disabled: next };
      state.devices.set(id, { ...device, ...updated });
      state.sigs.devices = '';
      renderAll();
      refreshDeviceDrawer(id);
      toast(next ? '设备已禁用' : '设备已启用', 'success');
    } catch (err) {
      if (err.status === 401) return handleAuthLost(err.message);
      toast(err.message || '操作失败', 'error');
    }
  }

  async function deleteDevice(id) {
    const device = state.devices.get(id);
    if (!device) return;
    const ok = await confirmDialog({
      title: '删除设备？',
      message: `将从 Hub 移除「${deviceDisplayName(device)}」。如果设备仍在线，它会在下次心跳时重新注册。`,
      okText: '删除设备',
    });
    if (!ok) return;
    try {
      await api(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE', timeout: 10000 });
      state.devices.delete(id);
      state.sigs.devices = '';
      state.sigs.composer = '';
      hideDrawer();
      renderAll();
      toast('设备已删除', 'success');
    } catch (err) {
      if (err.status === 401) return handleAuthLost(err.message);
      toast(err.message || '删除失败', 'error');
    }
  }

  /* ==================================================================
   * 任务详情抽屉
   * ================================================================== */
  function buildTaskBody(task) {
    const status = normStatus(task.status);
    const body = el('div');
    const requirements = (task.requirements && typeof task.requirements === 'object') ? task.requirements : {};

    const rawInstruction = task.instruction || '';
    const instructionText = rawInstruction || '（无指令内容）';
    const instructionStructured = Boolean(rawInstruction) && looksLikeMarkdown(rawInstruction);
    // 指令过长时默认折叠，把视觉重心留给输出结果；阈值按字符数与行数双重判断。
    const instructionLong = rawInstruction.length > 280
      || rawInstruction.split('\n').length > 6;
    const showRawInstruction = !instructionStructured || state.rawInstructions.has(task.id);
    const instructionQuote = el('div', {
      className: 'detail-quote instruction-quote'
        + (instructionStructured && !showRawInstruction ? ' is-rendered' : '')
        + (instructionLong ? ' is-collapsible is-collapsed' : ''),
    });
    const instructionRaw = el('p', { className: 'instruction-raw', text: instructionText });
    const instructionRendered = instructionStructured ? renderMarkdown(rawInstruction) : null;
    if (instructionRendered) instructionRendered.classList.add('instruction-rendered');
    instructionQuote.appendChild(showRawInstruction ? instructionRaw : instructionRendered);

    const instructionActions = el('div', { className: 'detail-head-actions' });
    if (instructionRendered) {
      const instructionModeToggle = el('button', {
        type: 'button',
        className: 'link-btn instruction-mode-toggle',
      }, el('span', { text: showRawInstruction ? '渲染' : '原文' }));
      instructionModeToggle.addEventListener('click', () => {
        const nextRaw = !state.rawInstructions.has(task.id);
        if (nextRaw) state.rawInstructions.add(task.id);
        else state.rawInstructions.delete(task.id);
        instructionQuote.replaceChildren(nextRaw ? instructionRaw : instructionRendered);
        instructionQuote.classList.toggle('is-rendered', !nextRaw);
        const label = instructionModeToggle.querySelector('span');
        if (label) label.textContent = tx(nextRaw ? '渲染' : '原文');
      });
      instructionActions.appendChild(instructionModeToggle);
    }
    if (instructionLong) {
      const instructionToggle = el('button', {
        type: 'button',
        className: 'link-btn instruction-toggle',
        attrs: { 'aria-expanded': 'false' },
      }, icon('chevron'), el('span', { text: '展开指令' }));
      instructionToggle.addEventListener('click', () => {
        const collapsed = instructionQuote.classList.toggle('is-collapsed');
        instructionToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        instructionToggle.classList.toggle('is-open', !collapsed);
        const label = instructionToggle.querySelector('span');
        if (label) label.textContent = tx(collapsed ? '展开指令' : '收起指令');
      });
      instructionActions.appendChild(instructionToggle);
    }
    const instructionHead = el('div', { className: 'detail-section-head' },
      el('h3', { text: '指令' }));
    if (instructionActions.childElementCount) instructionHead.appendChild(instructionActions);
    const instructionSection = el('section', { className: 'detail-section' },
      instructionHead,
      instructionQuote,
    );
    const reqChips = el('div', { className: 'requirements-row' });
    if (requirements.model) reqChips.appendChild(el('span', { className: 'chip', dataset: { kind: 'model' }, text: `模型 ${requirements.model}` }));
    arr(requirements.skills).forEach((skill) => reqChips.appendChild(el('span', { className: 'chip', dataset: { kind: 'skill' }, text: `技能 ${skill}` })));
    if (requirements.profile) reqChips.appendChild(el('span', { className: 'chip', dataset: { kind: 'profile' }, text: `配置 ${requirements.profile}` }));
    if (requirements.gateway) reqChips.appendChild(el('span', { className: 'chip', dataset: { kind: 'gateway' }, text: `网关 ${requirements.gateway}` }));
    if (requirements.project) reqChips.appendChild(el('span', { className: 'chip', dataset: { kind: 'project' }, text: `项目 ${requirements.project}` }));
    arr(requirements.tags).forEach((tag) => reqChips.appendChild(el('span', { className: 'chip', text: `标签 ${tag}` })));
    if (requirements.deviceId) reqChips.appendChild(el('span', { className: 'chip', text: `设备 ${deviceName(requirements.deviceId)}` }));
    if (!reqChips.childElementCount) reqChips.appendChild(el('span', { className: 'chip chip-more', text: '无特殊要求' }));
    instructionSection.appendChild(reqChips);
    body.appendChild(instructionSection);

    const metaSection = el('section', { className: 'detail-section' },
      el('div', { className: 'detail-section-head' }, el('h3', { text: '任务信息' })),
      el('div', { className: 'detail-kv-grid' },
        kv('状态', TASK_STATUS[status].label),
        kv('执行设备', task.assignedDeviceName || (task.assignedDeviceId ? deviceName(task.assignedDeviceId) : '等待分配')),
        kv('优先级', String(num(task.priority, 5))),
        kv('超时', Number.isFinite(task.timeoutSec) ? `${task.timeoutSec} 秒` : '—'),
        kv('尝试次数', `${num(task.attempts, 0)} / ${num(task.maxAttempts, 1)}`),
        kv('耗时', (() => {
          const duration = durationView(task);
          return duration ? duration.text : '—';
        })()),
        kv('创建时间', fmtDateTime(task.createdAt)),
        kv('开始时间', task.startedAt ? fmtDateTime(task.startedAt) : '—'),
        kv('结束时间', task.finishedAt ? fmtDateTime(task.finishedAt) : '—'),
        kv('任务 ID', task.id, true),
      ),
    );
    body.appendChild(metaSection);
    body.appendChild(taskGoalSectionNode(task));

    const subtasksSectionNode = childTasksSection(task);
    if (subtasksSectionNode) body.appendChild(subtasksSectionNode);
    const threadSectionNode = threadStepsSection(task);
    if (threadSectionNode) body.appendChild(threadSectionNode);

    const route = task.route || {};
    const routeSection = el('section', { className: 'detail-section' },
      el('div', { className: 'detail-section-head' }, el('h3', { text: '路由结果' })),
    );
    const routeBlock = el('div', { className: 'route-block' });
    if (route.reason) routeBlock.appendChild(el('p', { className: 'route-reason', text: localizeRouteSummary(route.reason), title: route.reason }));
    const candidates = arr(route.candidates);
    if (candidates.length) {
      const maxScore = Math.max(...candidates.map((c) => num(c.score, 0)), 118);
      const list = el('ul', { className: 'route-list' });
      for (const candidate of candidates.slice(0, 5)) {
        const score = num(candidate.score, 0);
        const item = el('li', { className: 'route-item' },
          el('span', { className: 'rname', text: candidate.deviceName || deviceName(candidate.deviceId) }),
          el('span', { className: 'rscore', text: `${Math.round(score)} 分` }),
          el('span', { className: 'rbar' }, el('span', { style: { width: `${Math.max(3, Math.min(100, (score / maxScore) * 100))}%` } })),
        );
        const matched = arr(candidate.matched);
        if (matched.length) item.title = `匹配：${matched.join('、')}`;
        list.appendChild(item);
      }
      routeBlock.appendChild(list);
    }
    const excluded = arr(route.excluded);
    if (excluded.length) {
      const list = el('ul', { className: 'route-list' });
      for (const item of excluded.slice(0, 10)) {
        list.appendChild(el('li', { className: 'route-item is-excluded' },
          el('span', { className: 'rname', text: item.deviceName || deviceName(item.deviceId) }),
          el('span', { className: 'rreason', text: localizeRouteReason(item.reason), title: item.reason || '' }),
        ));
      }
      routeBlock.appendChild(list);
    }
    if (!route.reason && !candidates.length && !excluded.length) {
      routeBlock.appendChild(el('div', { className: 'detail-empty', text: '暂无路由信息。' }));
    }
    routeSection.appendChild(routeBlock);
    body.appendChild(routeSection);

    const output = outputOf(task);
    if (output) {
      const rawOutput = output.markdown || output.text || '';
      const structured = looksLikeMarkdown(rawOutput);
      const showRaw = !structured || state.rawOutputs.has(task.id);
      const rawNode = el('pre', { className: 'detail-output-raw', text: rawOutput });
      const renderedNode = structured ? renderMarkdown(rawOutput) : null;
      if (renderedNode) renderedNode.classList.add('detail-output-rendered');
      const outputBody = el('div', { className: 'detail-output' }, showRaw ? rawNode : renderedNode);
      const headActions = el('div', { className: 'detail-head-actions' },
        el('button', { type: 'button', className: 'link-btn', onclick: () => copyText(rawOutput, 'Markdown 已复制') },
          icon('copy'), el('span', { text: '复制 Markdown' })),
      );
      if (structured && renderedNode) {
        const toggleBtn = el('button', { type: 'button', className: 'link-btn' },
          el('span', { text: showRaw ? '渲染' : '原文' }));
        toggleBtn.addEventListener('click', () => {
          const nextRaw = !outputBody.contains(rawNode);
          outputBody.replaceChildren(nextRaw ? rawNode : renderedNode);
          toggleBtn.querySelector('span').textContent = nextRaw ? '渲染' : '原文';
          if (nextRaw) state.rawOutputs.add(task.id);
          else state.rawOutputs.delete(task.id);
        });
        headActions.appendChild(toggleBtn);
      }
      const outSection = el('section', { className: 'detail-section' },
        el('div', { className: 'detail-section-head' },
          el('h3', { text: '输出' }),
          headActions,
        ),
        outputBody,
      );
      body.appendChild(outSection);
    }
    if (task.error && normStatus(task.status) !== 'completed') {
      const errSection = el('section', { className: 'detail-section' },
        el('div', { className: 'detail-section-head' }, el('h3', { text: '错误' })),
        el('div', { className: 'task-error' }, icon('alert'), el('span', { text: task.error })),
      );
      body.appendChild(errSection);
    }

    const eventSection = el('section', { className: 'detail-section' },
      el('div', { className: 'detail-section-head' },
        el('h3', { text: '事件时间线' }),
        el('span', { className: 'count', text: `${arr(task.events).length} 条` }),
      ),
      timeline(task.events),
    );
    body.appendChild(eventSection);
    return body;
  }

  function taskFooterNodes(task) {
    const status = normStatus(task.status);
    const nodes = [
      el('button', { type: 'button', className: 'btn btn-ghost btn-sm', onclick: hideDrawer, text: '关闭' }),
      el('span', { className: 'spacer' }),
      el('button', { type: 'button', className: 'btn btn-ghost btn-sm', onclick: () => copyText(task.instruction || '', '指令已复制') }, icon('copy'), '复制指令'),
      el('button', { type: 'button', className: 'btn btn-ghost btn-sm', onclick: () => copyText(task.id, '任务 ID 已复制') }, icon('copy'), '复制任务 ID'),
      el('button', {
        type: 'button', className: 'btn btn-ghost btn-sm',
        onclick: () => { hideDrawer(); editTaskInstruction(task.id); },
      }, icon('edit'), '编辑重发'),
      el('button', { type: 'button', className: 'btn btn-ghost btn-sm', onclick: () => openTaskGoalPicker(task.id) }, icon('link'), '关联到目标'),
    ];
    if (str(task.goalId)) {
      nodes.push(el('button', { type: 'button', className: 'btn btn-ghost btn-sm', onclick: () => void unlinkTaskGoal(task) }, icon('x'), '取消关联目标'));
    }
    if (ACTIVE_STATUS.has(status)) {
      nodes.push(el('button', { type: 'button', className: 'btn btn-danger btn-sm', onclick: () => cancelTask(task.id) }, icon('x'), '取消任务'));
    }
    if (status === 'waiting') {
      nodes.push(el('button', {
        type: 'button', className: 'btn btn-primary btn-sm',
        onclick: () => { hideDrawer(); answerMikaTask(task.id); },
      }, icon('send'), '回答 Mika'));
    }
    if (retryableChildrenOf(task).length) {
      nodes.push(el('button', {
        type: 'button', className: 'btn btn-primary btn-sm',
        onclick: () => retryFailedChildren(task.id),
      }, icon('refresh'), '重试失败子任务'));
    }
    if (RETRYABLE_STATUS.has(status)) {
      nodes.push(el('button', { type: 'button', className: 'btn btn-ghost btn-sm', onclick: () => completeTaskManually(task.id) }, icon('check'), '标记成功'));
      nodes.push(el('button', { type: 'button', className: 'btn btn-primary btn-sm', onclick: () => retryTask(task.id) }, icon('refresh'), '重新排队'));
    }
    if (!ACTIVE_STATUS.has(status)) {
      nodes.push(el('button', {
        type: 'button', className: 'btn btn-ghost btn-sm',
        onclick: () => { hideDrawer(); startFollowUp(task.id); },
      }, icon('send'), '继续此任务'));
    }
    if (isTrashed(task)) {
      nodes.push(el('button', {
        type: 'button', className: 'btn btn-ghost btn-sm',
        onclick: () => restoreTask(task.id),
      }, icon('refresh'), tr('action.restore')));
      nodes.push(el('button', {
        type: 'button', className: 'btn btn-danger btn-sm',
        onclick: () => purgeTask(task.id),
      }, icon('trash'), tr('action.purge')));
    } else if (TRASHABLE_STATUS.has(status)) {
      nodes.push(el('button', {
        type: 'button', className: 'btn btn-ghost btn-sm',
        onclick: () => trashTask(task.id),
      }, icon('trash'), tr('action.trash')));
    }
    return nodes;
  }

  function renderTaskDrawer(task, preserveScroll) {
    const scroll = preserveScroll ? $('#drawer-body').scrollTop : 0;
    setText('#drawer-title', '任务详情');
    const sub = $('#drawer-sub');
    sub.replaceChildren(
      statusBadge(task.status),
      el('span', { className: 'mono', text: task.id }),
      el('span', { text: '·' }),
      el('span', { text: fmtDateTime(task.createdAt) }),
    );
    $('#drawer-body').replaceChildren(buildTaskBody(task));
    $('#drawer-body').scrollTop = scroll;
    const foot = $('#drawer-foot');
    foot.replaceChildren(...groupDrawerFooterNodes(taskFooterNodes(task)));
    foot.hidden = false;
  }

  function openTaskDrawer(id) {
    const task = state.tasks.find((t) => t.id === id);
    if (!task) {
      toast('任务不存在或已被清理', 'warn');
      return;
    }
    openDrawer({
      kind: 'task',
      id,
      title: '任务详情',
      subNodes: [],
      body: null,
      footerNodes: [],
    });
    renderTaskDrawer(task, false);
  }

  function refreshTaskDrawer(id) {
    if (!state.drawer.open || state.drawer.kind !== 'task' || state.drawer.id !== id) return;
    const task = state.tasks.find((t) => t.id === id);
    if (!task) {
      hideDrawer();
      return;
    }
    renderTaskDrawer(task, true);
  }

  async function cancelTask(id) {
    try {
      const res = await api(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST', timeout: 10000 });
      if (res && res.task) {
        upsertTask(res.task);
        state.sigs.stats = '';
        state.sigs.tasks = '';
        renderAll();
        toast('取消请求已发送', 'success');
      }
    } catch (err) {
      if (err.status === 401) return handleAuthLost(err.message);
      toast(err.message || '取消失败', 'error');
    }
  }

  async function retryTask(id) {
    try {
      const res = await api(`/api/tasks/${encodeURIComponent(id)}/retry`, { method: 'POST', timeout: 10000 });
      if (res && res.task) {
        upsertTask(res.task);
        state.sigs.stats = '';
        state.sigs.tasks = '';
        renderAll();
        setRouteResult(res.task);
        toast('任务已重新排队并路由', 'success');
      }
    } catch (err) {
      if (err.status === 401) return handleAuthLost(err.message);
      toast(err.message || '重试失败', 'error');
    }
  }

  async function retryFailedChildren(parentId) {
    if (taskRecoveryBusy) return;
    const parent = state.tasks.find((item) => item.id === parentId);
    const children = retryableChildrenOf(parent);
    if (!children.length) {
      toast('没有可重试的失败子任务', 'warn');
      return;
    }
    taskRecoveryBusy = true;
    toast('正在重试失败子任务…', 'info', 2000);
    let requeued = 0;
    try {
      for (const child of children) {
        try {
          const res = await api(`/api/tasks/${encodeURIComponent(child.id)}/retry`, { method: 'POST', timeout: 10000 });
          if (res && res.task) {
            upsertTask(res.task);
            requeued += 1;
          }
        } catch (err) {
          if (err.status === 401) {
            handleAuthLost(err.message);
            return;
          }
        }
      }
      state.sigs.stats = '';
      state.sigs.tasks = '';
      renderAll();
      refreshTaskDrawer(parentId);
      toast(requeued ? `已重新排队 ${requeued} 个失败子任务` : '重试失败，请稍后再试', requeued ? 'success' : 'error');
    } finally {
      taskRecoveryBusy = false;
    }
  }

  async function archiveTask(id, archived = true) {
    try {
      const res = await api(`/api/tasks/${encodeURIComponent(id)}/${archived ? 'archive' : 'unarchive'}`, {
        method: 'POST',
        timeout: 10000,
      });
      if (res && res.task) {
        upsertTask(res.task);
        state.sigs.stats = '';
        state.sigs.tasks = '';
        await refreshNow(false);
        toast(archived ? '任务已归档' : '任务已取消归档', 'success');
      }
    } catch (err) {
      if (err.status === 401) return handleAuthLost(err.message);
      toast(err.message || '归档失败', 'error');
    }
  }

  async function deleteTask(id) {
    if (!window.confirm('确定删除这个任务吗？删除后不可恢复。')) return;
    try {
      await api(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE', timeout: 10000 });
      await refreshNow(false);
      toast('任务已删除', 'success');
    } catch (err) {
      if (err.status === 401) return handleAuthLost(err.message);
      toast(err.message || '删除失败', 'error');
    }
  }

  /* ---------------------------------------------------------------- 回收站 */

  async function trashTask(id) {
    const task = state.tasks.find((item) => item.id === id);
    if (!task) return;
    try {
      const res = await api(`/api/tasks/${encodeURIComponent(id)}/trash`, { method: 'POST', timeout: 15000 });
      if (res && res.task) upsertTask(res.task);
      state.sigs.stats = '';
      state.sigs.tasks = '';
      await refreshNow(false);
      toast(tr('trash.trashed'), 'success');
    } catch (err) {
      if (err.status === 401) return handleAuthLost(err.message);
      toast(tr('trash.trashFailed', { message: err.message || '—' }), 'error');
    }
  }

  async function restoreTask(id) {
    try {
      const res = await api(`/api/tasks/${encodeURIComponent(id)}/restore`, { method: 'POST', timeout: 15000 });
      if (res && res.task) upsertTask(res.task);
      state.sigs.stats = '';
      state.sigs.tasks = '';
      await refreshNow(false);
      toast(tr('trash.restored'), 'success');
    } catch (err) {
      if (err.status === 401) return handleAuthLost(err.message);
      toast(tr('trash.restoreFailed', { message: err.message || '—' }), 'error');
    }
  }

  async function purgeTask(id) {
    const task = state.tasks.find((item) => item.id === id);
    if (!task) return;
    const ok = await confirmDialog({
      title: tr('trash.confirmTitle'),
      message: tr('trash.confirmPurge'),
      okText: tr('action.purge'),
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await api(`/api/tasks/${encodeURIComponent(id)}/purge`, { method: 'POST', timeout: 20000 });
      const deleted = res && Array.isArray(res.deleted) ? res.deleted.map(String) : [id];
      const removed = new Set(deleted);
      state.tasks = state.tasks.filter((item) => !removed.has(item.id));
      if (state.drawer.open && state.drawer.kind === 'task' && removed.has(state.drawer.id)) hideDrawer();
      state.sigs.stats = '';
      state.sigs.tasks = '';
      await refreshNow(false);
      toast(tr('trash.purged'), 'success');
    } catch (err) {
      if (err.status === 401) return handleAuthLost(err.message);
      toast(tr('trash.purgeFailed', { message: err.message || '—' }), 'error');
    }
  }

  /** 失败筛选视图：把当前筛出的失败/超时/取消根任务逐个回收。 */
  async function trashAllFailedTasks() {
    const failedRoots = state.tasks.filter(
      (item) => isRootTask(item) && !isTrashed(item) && !item.archived && RETRYABLE_STATUS.has(normStatus(item.status)),
    );
    if (!failedRoots.length) return;
    const ok = await confirmDialog({
      title: tr('trash.bulkTitle'),
      message: tr('trash.confirmPurgeAll'),
      okText: tr('action.trash'),
      danger: false,
    });
    if (!ok) return;
    let done = 0;
    let failed = 0;
    for (const item of failedRoots) {
      try {
        await api(`/api/tasks/${encodeURIComponent(item.id)}/trash`, { method: 'POST', timeout: 15000 });
        done += 1;
      } catch (err) {
        if (err.status === 401) {
          handleAuthLost(err.message);
          return;
        }
        failed += 1;
      }
    }
    state.sigs.stats = '';
    state.sigs.tasks = '';
    await refreshNow(false);
    if (!failed) toast(tr('trash.bulkDone', { n: done }), 'success');
    else toast(tr('trash.bulkPartial', { done, failed }), done ? 'warn' : 'error');
  }

  async function completeTaskManually(id) {
    const task = state.tasks.find((item) => item.id === id);
    if (!task) return;
    const ok = await confirmDialog({
      title: '手动标记任务为成功？',
      message: `任务「${shorten(task.instruction, 60)}」将被直接标记为 completed，原 error 和失败状态会被清除。`,
      okText: '标记成功',
      danger: false,
    });
    if (!ok) return;
    try {
      const res = await api(`/api/tasks/${encodeURIComponent(id)}/external-result`, {
        method: 'POST',
        body: {
          text: '管理员在 BattleStar 手动标记为完成。',
          status: 'completed',
          data: { manual: true, previousStatus: task.status },
        },
        timeout: 15000,
      });
      if (res && res.task) upsertTask(res.task);
      await refreshNow(false);
      toast('任务已手动标记为完成', 'success');
    } catch (err) {
      if (err.status === 401) return handleAuthLost(err.message);
      toast(err.message || '手动标记失败', 'error');
    }
  }

  function editTaskInstruction(id) {    const task = state.tasks.find((item) => item.id === id);
    if (!task) return;
    cancelFollowUp();
    const requirements = task.requirements || {};
    state.selectedSkills = new Set(Array.isArray(requirements.skills) ? requirements.skills : []);
    state.sigs.composer = '';
    renderComposerOptions();
    const modelSelect = $('#req-model');
    if (modelSelect && requirements.model) setSelectValue(modelSelect, requirements.model);
    const deviceSelect = $('#target-device');
    if (deviceSelect && requirements.deviceId) setSelectValue(deviceSelect, requirements.deviceId);
    const textarea = $('#instruction');
    textarea.value = task.instruction || '';
    const timeout = $('#timeout');
    if (timeout && Number.isFinite(Number(task.timeoutSec))) timeout.value = String(task.timeoutSec);
    const priority = $('#priority');
    if (priority && Number.isFinite(Number(task.priority))) priority.value = String(task.priority);
    setTab('command');
    updateComposerTarget();
    textarea.focus();
    textarea.scrollIntoView({ block: 'center', behavior: 'smooth' });
    toast('已载入原指令，修改后点发送即可重新创建任务', 'info');
  }

  async function answerMikaTask(id) {
    const task = state.tasks.find((item) => item.id === id);
    if (!task) return;
    const question = task.progress && task.progress.question ? task.progress.question : 'Mika 需要你的回答';
    const text = window.prompt(`Mika 需要你的回答：\n\n${question}\n\n请输入回答内容：`, '');
    if (text === null) return;
    const answer = String(text).trim();
    if (!answer) {
      toast('回答内容不能为空', 'warn');
      return;
    }
    try {
      const res = await api(`/api/tasks/${encodeURIComponent(id)}/answer`, {
        method: 'POST',
        body: { text: answer },
        timeout: 15000,
      });
      if (res && res.task) upsertTask(res.task);
      state.sigs.tasks = '';
      scheduleSnapshot(300);
      toast('回答已发送，Mika 继续执行', 'success');
    } catch (err) {
      if (err.status === 401) return handleAuthLost(err.message);
      toast(err.message || '发送回答失败', 'error');
    }
  }

  function startFollowUp(id) {    const task = state.tasks.find((item) => item.id === id);
    if (!task) return;
    state.followUpTaskId = id;
    const step = Number.isFinite(task.threadStep) ? task.threadStep + 1 : 2;
    const banner = $('#followup-banner');
    setText('#followup-title', `继续任务 · 第 ${step} 步`);
    setText('#followup-desc', `基于：${shorten(task.instruction, 60)}`);
    if (banner) banner.hidden = false;
    const textarea = $('#instruction');
    textarea.value = '';
    textarea.placeholder = tx('基于上一步结果，输入下一步要做什么，或直接修正要求…');
    setTab('command');
    updateComposerTarget();
    textarea.focus();
    textarea.scrollIntoView({ block: 'center', behavior: 'smooth' });
    toast('已进入继续任务模式，请在下方输入下一步指令', 'info', 3200);
  }

  function cancelFollowUp() {
    if (!state.followUpTaskId) return;
    state.followUpTaskId = null;
    const banner = $('#followup-banner');
    if (banner) banner.hidden = true;
    const textarea = $('#instruction');
    if (textarea) textarea.placeholder = tx('例如：把本周的开销记录整理成一份 Word 报告，并附上汇总表格');
  }

  /* ==================================================================
   * 刷新 / Tab / 键盘
   * ================================================================== */
  async function refreshNow(showToast) {
    if (!state.connected) return;
    const btn = $('#refresh-btn');
    if (btn) btn.classList.add('is-spinning');
    try {
      const snapshot = await api('/api/snapshot?limit=50', { timeout: 12000 });
      applySnapshot(snapshot);
      if (state.goalsSupported) {
        state.goalsLoaded = false;
        ensureGoalsLoaded();
      }
      if (state.remindersSupported) {
        state.remindersLoaded = false;
        ensureRemindersLoaded();
      }
      if (showToast) toast('数据已刷新', 'success');
    } catch (err) {
      if (err.status === 401) handleAuthLost(err.message);
      else toast(err.message || '刷新失败', 'error');
    } finally {
      setTimeout(() => {
        if (btn) btn.classList.remove('is-spinning');
      }, 500);
    }
  }

  function currentTabFromHash() {
    const hash = (window.location.hash || '').replace('#', '').trim();
    return TABS.has(hash) ? hash : 'status';
  }

  function devRememberJob(id) {
    try {
      if (id) localStorage.setItem('sb.dev.job', id);
      else localStorage.removeItem('sb.dev.job');
    } catch {
      /* ignore */
    }
  }

  function devRememberedJob() {
    try {
      return localStorage.getItem('sb.dev.job') || '';
    } catch {
      return '';
    }
  }

  async function resumeDevJob() {
    if (devState.busy) return false;
    let job = null;
    try {
      const res = await api('/api/dsh/jobs', { timeout: 12000 });
      const jobs = res && Array.isArray(res.jobs) ? res.jobs : [];
      job = jobs.find((item) => item.status === 'running' || item.status === 'queued') || null;
      if (!job) {
        const remembered = devState.jobId || devRememberedJob();
        if (remembered) {
          for (const item of jobs) if (item.id === remembered) job = item;
        }
      }
    } catch {
      return false;
    }
    if (!job) return false;
    devState.jobId = job.id;
    devRememberJob(job.id);
    devState.busy = true;
    devState.pollFailures = 0;
    const button = $('#dev-send');
    if (button) button.disabled = true;
    setDevStatus(`恢复 DSH 任务 · ${job.status === 'running' ? '正在执行' : '等待执行'}…`);
    if (job.status === 'done' || job.status === 'failed') {
      applyDevJobResult(job);
    } else {
      pollDevJob(job.id);
    }
    return true;
  }

  function applyDevJobResult(job) {
    devState.busy = false;
    devState.pollFailures = 0;
    devRememberJob('');
    const button = $('#dev-send');
    if (button) button.disabled = false;
    if (job.status === 'failed') {
      devPush('error', job.error || 'DSH 执行失败');
      setDevStatus('失败');
      return;
    }
    devPush('assistant', job.text || 'DSH 已完成修改');
    setDevStatus('完成');
    toast('DSH 已完成修改', 'success');
  }

  function renderDevMessages() {
    const log = $('#dev-chat-log');
    if (!log) return;
    log.replaceChildren();
    if (!devState.messages.length) {
      log.appendChild(el('div', { className: 'dev-empty', text: '告诉 DSH 要改什么，例如：把任务卡片的按钮改成两列，并修复移动端溢出。' }));
      return;
    }
    for (const message of devState.messages) {
      const node = el('div', { className: `dev-msg ${message.role}` });
      if (message.role === 'assistant') {
        // DSH 的回复通常是 Markdown（标题/列表/代码块/表格），渲染后再展示，手机端更好读。
        node.appendChild(renderMarkdown(message.text));
      } else {
        node.textContent = tx(String(message.text || ''));
      }
      log.appendChild(node);
    }
    log.scrollTop = log.scrollHeight;
  }

  function devPush(role, text) {
    devState.messages.push({ role, text: String(text || '') });
    renderDevMessages();
  }

  function setDevStatus(text) {
    setText('#dev-status', text);
  }

  async function sendDevMessage(event) {
    if (event) event.preventDefault();
    if (devState.busy) return;
    const input = $('#dev-input');
    const message = input ? input.value.trim() : '';
    if (!message) {
      toast('请先输入要修改的内容', 'warn');
      return;
    }
    devState.busy = true;
    const scopeSelect = $('#dev-scope');
    const scope = scopeSelect ? scopeSelect.value : 'global';
    const scopeLabel = { global: '全局', plugin: 'DSH 插件', apk: 'APK', localhost: 'Localhost 界面' }[scope] || '全局';
    devPush('user', `[${scopeLabel}] ${message}`);
    input.value = '';
    setDevStatus(`${scopeLabel} · DSH 正在处理…`);
    const button = $('#dev-send');
    if (button) button.disabled = true;
    try {
      const res = await api('/api/dsh/chat', { method: 'POST', body: { message, scope }, timeout: 30000 });
      const job = res && res.job;
      if (!job || !job.id) throw new Error('DSH bridge 未返回任务 ID');
      devState.jobId = job.id;
      devState.pollFailures = 0;
      devRememberJob(job.id);
      if (job.status === 'done') {
        applyDevJobResult(job);
        return;
      }
      setDevStatus('DSH 正在修改代码…');
      pollDevJob(job.id);
    } catch (err) {
      if (await resumeDevJob()) return;
      devPush('error', err.message || '启动 DSH 会话失败');
      devState.busy = false;
      setDevStatus('失败');
      if (button) button.disabled = false;
    }
  }

  function pollDevJob(jobId) {
    if (devState.timer) clearTimeout(devState.timer);
    devState.timer = setTimeout(async () => {
      try {
        const res = await api(`/api/dsh/job/${encodeURIComponent(jobId)}`, { timeout: 20000 });
        devState.pollFailures = 0;
        const job = res && res.job;
        if (!job) throw new Error('DSH 任务状态丢失');
        if (job.logs && job.logs.length) setDevStatus(job.logs[job.logs.length - 1]);
        if (job.status === 'done' || job.status === 'failed') {
          applyDevJobResult(job);
          return;
        }
        setDevStatus(job.status === 'running' ? 'DSH 正在修改代码…' : 'DSH 等待执行…');
        pollDevJob(jobId);
      } catch (err) {
        devState.pollFailures += 1;
        if (err.status !== 404 && devState.pollFailures <= 20) {
          setDevStatus(`DSH 连接暂时中断，重试 ${devState.pollFailures}/20…`);
          pollDevJob(jobId);
          return;
        }
        devState.busy = false;
        devRememberJob('');
        devPush('error', err.message || '查询 DSH 任务失败');
        setDevStatus('失败');
        const button = $('#dev-send');
        if (button) button.disabled = false;
      }
    }, 1800);
  }

  async function resetDevSession() {
    if (devState.busy) return;
    try {
      await api('/api/dsh/reset', { method: 'POST', body: {}, timeout: 15000 });
      devState.messages = [];
      devState.jobId = '';
      devRememberJob('');
      renderDevMessages();
      setDevStatus('已开始新会话');
      toast('Developer Mode 新会话已开始', 'success');
    } catch (err) {
      toast(err.message || '重置失败', 'error');
    }
  }

  function setMobileNav(open) {
    const nav = $('#mobile-nav');
    const toggle = $('#nav-toggle');
    if (!nav || !toggle) return;
    const next = Boolean(open);
    if (next) updateMobileNavPosition(nav, toggle);
    nav.classList.toggle('is-open', next);
    toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
    toggle.setAttribute('aria-label', next ? tx('关闭导航') : tx('打开导航'));
    if (next) {
      window.addEventListener('scroll', onMobileNavViewportChange, { passive: true });
      window.addEventListener('resize', onMobileNavViewportChange);
    } else {
      window.removeEventListener('scroll', onMobileNavViewportChange);
      window.removeEventListener('resize', onMobileNavViewportChange);
    }
  }

  /** 让汉堡菜单锚定在按钮下方：跟随当前视口，而不是固定在页面顶部。 */
  function updateMobileNavPosition(nav = $('#mobile-nav'), toggle = $('#nav-toggle')) {
    if (!nav || !toggle) return;
    const rect = toggle.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 600;
    const top = Math.max(8, Math.min(viewportHeight - 140, rect.bottom + 8));
    nav.style.top = `${Math.round(top)}px`;
    nav.style.maxHeight = `${Math.max(160, Math.round(viewportHeight - top - 12))}px`;
  }

  function onMobileNavViewportChange() {
    const nav = $('#mobile-nav');
    if (!nav || !nav.classList.contains('is-open')) return;
    updateMobileNavPosition(nav, $('#nav-toggle'));
  }

  function setTab(tab, { scroll = true } = {}) {
    const next = TABS.has(tab) ? tab : 'status';
    // 心智页有未保存修改时先确认，避免切换 tab 丢失编辑
    if (state.tab === 'mind' && next !== 'mind' && state.mindDirty) {
      void confirmDialog({
        title: tr('mind.leaveTitle'),
        message: tr('mind.leaveMessage'),
        okText: tr('mind.leaveOk'),
        danger: false,
      }).then((ok) => {
        if (!ok) return;
        state.mindDirty = false;
        renderMind();
        setTab(next, { scroll });
      });
      return;
    }
    state.tab = next;
    $$('.mobile-tab').forEach((btn) => {
      const on = btn.dataset.tab === next;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $$('[data-tab-panel]').forEach((panel) => {
      panel.classList.toggle('is-active', panel.dataset.tabPanel === next);
    });
    if (next === 'settings') {
      const body = $('#settings-inline-body');
      if (body) body.replaceChildren(buildSettings());
    }
    if (next === 'developer') void resumeDevJob();
    if (next === 'reminders') ensureRemindersLoaded();
    if (next === 'journal') void ensureJournalLoaded();
    if (next === 'brainstorm') ensureBrainstormLoaded();
    if (next === 'mind') ensureMindLoaded();
    if (next === 'goals') {
      ensureGoalsLoaded();
      void refreshBrain();
    }
    if (isMobile() && scroll) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  function maybeAutoOpen() {
    if (state.autoOpenDone) return;
    const raw = urlParam('open');
    if (!raw) {
      state.autoOpenDone = true;
      return;
    }
    const idx = raw.indexOf(':');
    const kind = idx >= 0 ? raw.slice(0, idx) : raw;
    const id = idx >= 0 ? raw.slice(idx + 1) : '';
    if (kind === 'records') {
      state.autoOpenDone = true;
      openRecordsDrawer();
    } else if (kind === 'settings') {
      state.autoOpenDone = true;
      openSettingsDrawer();
    } else if (kind === 'device' && state.devices.has(id)) {
      state.autoOpenDone = true;
      openDeviceDrawer(id);
    } else if (kind === 'task' && state.tasks.some((t) => t.id === id)) {
      state.autoOpenDone = true;
      openTaskDrawer(id);
    } else if (kind === 'goals') {
      state.autoOpenDone = true;
      setTab('goals');
      if (id && goalById(id)) openGoalDrawer(id);
    } else if (kind === 'reminders') {
      state.autoOpenDone = true;
      setTab('reminders');
      if (!id) return;
      if (reminderById(id)) {
        openReminderFormDrawer(id);
        return;
      }
      // 提醒列表是异步载入的：等它到达后再打开对应编辑抽屉（最多等 5 秒）
      let tries = 0;
      const timer = setInterval(() => {
        tries += 1;
        if (reminderById(id)) {
          clearInterval(timer);
          openReminderFormDrawer(id);
        } else if (tries >= 20 || !state.connected) {
          clearInterval(timer);
        }
      }, 250);
    }
  }

  function bindStaticEvents() {
    /* 连接页 */
    $('#connect-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      setConnectError('');
      const rawBase = $('#hub-url').value.trim();
      const token = $('#admin-token').value.trim();
      if (!token) {
        setConnectError('请输入管理员令牌（见 Hub 启动日志）');
        $('#admin-token').focus();
        return;
      }
      let base;
      try {
        base = normalizeBase(rawBase);
      } catch (err) {
        setConnectError(err.message);
        $('#hub-url').focus();
        return;
      }
      setConnectBusy(true);
      try {
        await connect(base, token);
      } catch (err) {
        setConnectBusy(false);
        if (err.status === 401) setConnectError('管理员令牌无效，请检查后重试');
        else setConnectError(err.message || '连接失败，请检查 Hub 地址');
      }
    });

    $('#toggle-token').addEventListener('click', () => {
      const input = $('#admin-token');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      $('#toggle-token').setAttribute('aria-label', show ? '隐藏令牌' : '显示令牌');
    });

    /* 顶栏 */
    $('#refresh-btn').addEventListener('click', () => refreshNow(true));
    $('#settings-btn').addEventListener('click', openSettingsDrawer);
    $('#logout-btn').addEventListener('click', logout);

    /* 抽屉 */
    $('#drawer-close').addEventListener('click', hideDrawer);
    $('#drawer-backdrop').addEventListener('click', hideDrawer);

    /* 任务筛选 */
    $('#task-filters').addEventListener('click', (event) => {
      const btn = event.target.closest('.filter-chip');
      if (!btn) return;
      state.taskFilter = btn.dataset.filter || 'all';
      state.sigs.tasks = '';
      renderTasks();
    });

    /* 任务列表事件委托 */
    $('#task-list').addEventListener('click', (event) => {
      const card = event.target.closest('.task-card');
      if (!card) return;
      const id = card.dataset.id;
      const actionBtn = event.target.closest('[data-action]');
      if (actionBtn) {
        event.stopPropagation();
        const action = actionBtn.dataset.action;
        if (action === 'open') openTaskDrawer(id);
        else if (action === 'open-child') openTaskDrawer(actionBtn.dataset.taskId);
        else if (action === 'cancel') cancelTask(id);
        else if (action === 'retry') retryTask(id);
        else if (action === 'complete') completeTaskManually(id);
        else if (action === 'archive') archiveTask(id, true);
        else if (action === 'unarchive') archiveTask(id, false);
        else if (action === 'trash') void trashTask(id);
        else if (action === 'restore') void restoreTask(id);
        else if (action === 'purge') void purgeTask(id);
        else if (action === 'delete') deleteTask(id);
        else if (action === 'copy-instruction') {
          const task = state.tasks.find((item) => item.id === id);
          if (task) copyText(task.instruction || '', '指令已复制');
        } else if (action === 'edit-instruction') editTaskInstruction(id);
        else if (action === 'follow-up') startFollowUp(id);
        else if (action === 'retry-failed-children') retryFailedChildren(id);
        else if (action === 'answer') answerMikaTask(id);
        else if (action === 'toggle-events') {
          if (state.expandedEvents.has(id)) state.expandedEvents.delete(id);
          else state.expandedEvents.add(id);
          state.sigs.tasks = '';
          renderTasks();
        } else if (action === 'toggle-output') {
          if (state.expandedOutput.has(id)) state.expandedOutput.delete(id);
          else state.expandedOutput.add(id);
          state.sigs.tasks = '';
          renderTasks();
        }
        return;
      }
      openTaskDrawer(id);
    });
    $('#task-list').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const card = event.target.closest('.task-card');
      if (!card || event.target.closest('[data-action]')) return;
      event.preventDefault();
      openTaskDrawer(card.dataset.id);
    });

    const collapseAllBtn = $('#tasks-collapse-all');
    const expandAllBtn = $('#tasks-expand-all');
    if (collapseAllBtn) {
      collapseAllBtn.addEventListener('click', () => {
        state.tasksCollapsed = true;
        state.sigs.tasks = '';
        renderTasks();
      });
    }
    if (expandAllBtn) {
      expandAllBtn.addEventListener('click', () => {
        state.tasksCollapsed = false;
        state.sigs.tasks = '';
        renderTasks();
      });
    }

    /* 指令表单 */
    $('#task-form').addEventListener('submit', sendTask);
    const devForm = $('#dev-form');
    if (devForm) devForm.addEventListener('submit', sendDevMessage);
    const devOpen = $('#dev-open');
    if (devOpen) {
      devOpen.addEventListener('click', () => {
        setTab('developer');
        const panel = $('#section-developer');
        if (panel) panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
    }
    const devReset = $('#dev-reset');
    if (devReset) devReset.addEventListener('click', () => void resetDevSession());
    const devScope = $('#dev-scope');
    if (devScope) {
      devScope.addEventListener('change', () => {
        const label = devScope.options[devScope.selectedIndex] ? devScope.options[devScope.selectedIndex].textContent : '全局';
        setDevStatus(`改动对象：${label}`);
      });
    }
    const attachBtn = $('#attach-btn');
    const fileInput = $('#file-input');
    if (attachBtn && fileInput) {
      attachBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', () => {
        void addPendingFiles(fileInput.files);
        fileInput.value = '';
      });
    }
    const followupCancel = $('#followup-cancel');
    if (followupCancel) followupCancel.addEventListener('click', cancelFollowUp);
    $('#instruction').addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        sendTask(event);
      }
    });
    $('#instruction').addEventListener('focus', () => {
      if (!isMobile()) return;
      setTimeout(() => {
        const form = $('#task-form');
        if (form) form.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 320);
    });
    ['#req-model', '#target-device'].forEach((selector) => {
      $(selector).addEventListener('change', updateComposerTarget);
    });

    /* 长期目标 */
    const goalNew = $('#goal-new');
    if (goalNew) goalNew.addEventListener('click', () => openGoalFormDrawer());

    /* 自主大脑状态卡 */
    const brainThink = $('#brain-think');
    if (brainThink) brainThink.addEventListener('click', () => void runBrainThink());
    const brainSettings = $('#brain-settings');
    if (brainSettings) brainSettings.addEventListener('click', () => openBrainDrawer());
    const brainToggle = $('#brain-toggle');
    if (brainToggle) brainToggle.addEventListener('click', () => void toggleBrain());
    const brainOwnerAck = $('#brain-owner-ack');
    if (brainOwnerAck) brainOwnerAck.addEventListener('click', () => void ackBrainOwnerAsk());

    /* 管家心路 */
    const journalSummaryNow = $('#journal-summary-now');
    if (journalSummaryNow) journalSummaryNow.addEventListener('click', () => void generateJournalSummary());
    const journalControls = $('#journal-controls');
    if (journalControls) {
      journalControls.addEventListener('click', (event) => {
        const filterBtn = event.target.closest('[data-journal-filter]');
        if (filterBtn) {
          state.journalFilter = filterBtn.dataset.journalFilter || 'all';
          renderJournal();
          return;
        }
        const saveBtn = event.target.closest('#journal-save');
        if (saveBtn) {
          void saveJournalSettings();
          return;
        }
        const dayBtn = event.target.closest('[data-journal-day-summary]');
        if (dayBtn) void generateJournalSummary(dayBtn.dataset.journalDaySummary);
      });
      journalControls.addEventListener('change', (event) => {
        if (event.target.closest('#journal-enabled') || event.target.closest('#journal-time')) {
          void saveJournalSettings();
        }
      });
    }

    /* 头脑风暴 */
    const brainstormNew = $('#brainstorm-new');
    if (brainstormNew) brainstormNew.addEventListener('click', () => void newBrainstormSession());
    const brainstormReload = $('#brainstorm-reload');
    if (brainstormReload) brainstormReload.addEventListener('click', () => void loadBrainstorm({ silent: true }));
    const brainstormErrorBox = $('#brainstorm-error');
    if (brainstormErrorBox) {
      brainstormErrorBox.addEventListener('click', (event) => {
        if (event.target.closest('[data-brainstorm-retry]')) {
          state.brainstormError = '';
          void loadBrainstorm();
        }
      });
    }
    const brainstormForm = $('#brainstorm-form');
    if (brainstormForm) {
      brainstormForm.addEventListener('submit', (event) => {
        event.preventDefault();
        void sendBrainstorm();
      });
    }
    const brainstormInput = $('#brainstorm-input');
    if (brainstormInput) {
      brainstormInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.ctrlKey || event.metaKey) return;
        event.preventDefault();
        void sendBrainstorm();
      });
    }
    const brainstormSessions = $('#brainstorm-sessions');
    if (brainstormSessions) {
      brainstormSessions.addEventListener('click', (event) => {
        const delBtn = event.target.closest('[data-brainstorm-delete]');
        if (delBtn) {
          event.preventDefault();
          void deleteBrainstormSession(delBtn.dataset.brainstormDelete);
          return;
        }
        const sessionBtn = event.target.closest('[data-brainstorm-session]');
        if (sessionBtn) {
          event.preventDefault();
          selectBrainstormSession(sessionBtn.dataset.brainstormSession);
        }
      });
    }
    const brainstormMessages = $('#brainstorm-messages');
    if (brainstormMessages) {
      brainstormMessages.addEventListener('click', (event) => {
        const suggestion = event.target.closest('[data-brainstorm-suggest]');
        if (suggestion) {
          const input = $('#brainstorm-input');
          if (input) {
            input.value = tr(suggestion.dataset.brainstormSuggest);
            input.focus();
            void sendBrainstorm();
          }
          return;
        }
        const actionBtn = event.target.closest('[data-action]');
        if (!actionBtn) return;
        event.preventDefault();
        const action = actionBtn.dataset.action;
        const messageId = str(actionBtn.dataset.brainstormMessage);
        const sessionId = brainstormCurrentId();
        if (action === 'brainstorm-copy') {
          const message = arr(state.brainstormSession && state.brainstormSession.messages)
            .find((item) => item && item.id === messageId);
          copyText(brainstormTextOf(message), tr('brainstorm.copied'));
        } else if (action === 'brainstorm-to-task') {
          void brainstormToTask(sessionId, messageId);
        } else if (action === 'brainstorm-link-goal') {
          openBrainstormGoalPicker(sessionId, messageId);
        }
      });
    }

    /* 心智 */
    const mindEditors = $('#mind-editors');
    if (mindEditors) {
      mindEditors.addEventListener('input', () => updateMindDirty());
      mindEditors.addEventListener('click', (event) => {
        const resetBtn = event.target.closest('[data-mind-reset]');
        if (resetBtn) {
          event.preventDefault();
          void resetMind({ field: resetBtn.dataset.mindReset });
        }
      });
    }
    const mindSave = $('#mind-save');
    if (mindSave) mindSave.addEventListener('click', () => void saveMind());
    const mindResetAll = $('#mind-reset-all');
    if (mindResetAll) mindResetAll.addEventListener('click', () => void resetMind({}));
    // 心智页有未保存修改时，刷新/关闭前给出浏览器原生提示
    window.addEventListener('beforeunload', (event) => {
      if (!state.mindDirty) return undefined;
      event.preventDefault();
      event.returnValue = '';
      return '';
    });

    const goalList = $('#goal-list');
    if (goalList) {
      goalList.addEventListener('click', (event) => {
        const actionBtn = event.target.closest('[data-action]');
        if (actionBtn) {
          event.preventDefault();
          const action = actionBtn.dataset.action;
          if (action === 'reload-goals') {
            state.goalsLoaded = false;
            state.goalsError = '';
            state.sigs.goals = '';
            void loadGoals();
            return;
          }
          const card = actionBtn.closest('.goal-card');
          const goalId = card ? card.dataset.id : '';
          if (!goalId) return;
          if (action === 'check') void goalCheckNow(goalId);
          else if (action === 'approve') void goalApprove(goalId);
          else if (action === 'reject') void goalReject(goalId);
          else if (action === 'skip') void goalSkipNext(goalId);
          else if (action === 'pause') void goalSetStatus(goalId, 'paused');
          else if (action === 'resume') void goalSetStatus(goalId, 'active');
          else if (action === 'stop') void goalSetStatus(goalId, 'stopped');
          else if (action === 'delete') void goalDelete(goalId);
          else if (action === 'details') openGoalDrawer(goalId);
          return;
        }
        const card = event.target.closest('.goal-card');
        if (card) openGoalDrawer(card.dataset.id);
      });
      goalList.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const card = event.target.closest('.goal-card');
        if (!card || event.target.closest('[data-action]')) return;
        event.preventDefault();
        openGoalDrawer(card.dataset.id);
      });
    }

    /* 提醒 */
    const reminderNew = $('#reminder-new');
    if (reminderNew) reminderNew.addEventListener('click', () => openReminderFormDrawer());
    const reminderList = $('#reminder-list');
    if (reminderList) {
      reminderList.addEventListener('click', (event) => {
        const actionBtn = event.target.closest('[data-action]');
        if (actionBtn) {
          event.preventDefault();
          const action = actionBtn.dataset.action;
          if (action === 'reload-reminders') {
            state.remindersLoaded = false;
            state.remindersError = '';
            state.sigs.reminders = '';
            void loadReminders();
            return;
          }
          const actionCard = actionBtn.closest('.reminder-card');
          const reminderId = actionCard ? actionCard.dataset.id : '';
          if (!reminderId) return;
          if (action === 'edit') openReminderFormDrawer(reminderId);
          else if (action === 'toggle') void reminderToggleEnabled(reminderId);
          else if (action === 'delete') void reminderDelete(reminderId);
          return;
        }
        const card = event.target.closest('.reminder-card');
        if (card) openReminderFormDrawer(card.dataset.id);
      });
      reminderList.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const card = event.target.closest('.reminder-card');
        if (!card || event.target.closest('[data-action]')) return;
        event.preventDefault();
        openReminderFormDrawer(card.dataset.id);
      });
    }

    /* 手机 Tab / 汉堡菜单 */
    $$('.mobile-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.action === 'records') {
          setMobileNav(false);
          openRecordsDrawer();
          return;
        }
        setTab(btn.dataset.tab);
        setMobileNav(false);
        try {
          history.replaceState(null, '', '#' + btn.dataset.tab);
        } catch {
          /* ignore */
        }
      });
    });
    const navToggle = $('#nav-toggle');
    const mobileNav = $('#mobile-nav');
    if (navToggle && mobileNav) {
      navToggle.addEventListener('click', (event) => {
        event.stopPropagation();
        setMobileNav(!mobileNav.classList.contains('is-open'));
      });
      document.addEventListener('click', (event) => {
        if (!mobileNav.classList.contains('is-open')) return;
        if (mobileNav.contains(event.target) || navToggle.contains(event.target)) return;
        setMobileNav(false);
      });
    }
    window.addEventListener('hashchange', () => setTab(currentTabFromHash(), { scroll: false }));
    MOBILE_MQ.addEventListener('change', () => {
      setMobileNav(false);
      setTab(state.tab, { scroll: false });
    });

    /* 键盘 */
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.drawer.open) {
        hideDrawer();
        return;
      }
      if (event.key === 'Escape') {
        const nav = $('#mobile-nav');
        if (nav && nav.classList.contains('is-open')) {
          setMobileNav(false);
          return;
        }
      }
      const tag = (event.target && event.target.tagName) || '';
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(tag);
      if (!typing && !event.ctrlKey && !event.metaKey && !event.altKey && (event.key === 'r' || event.key === 'R')) {
        refreshNow(true);
      }
    });

    /* 网络恢复 */
    window.addEventListener('online', () => {
      if (!state.connected) return;
      startSse();
      scheduleSnapshot(100);
    });

    /* 页面可见性恢复时补一次快照 */
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.connected) scheduleSnapshot(100);
    });
  }

  /* ==================================================================
   * 总渲染
   * ================================================================== */
  function renderAll() {
    try {
      renderStats();
      renderDevices();
      renderTasks();
      renderGoals();
      renderBrainCard();
      renderMind();
      if (state.tab === 'journal') ensureJournalLoaded();
      if (state.tab === 'brainstorm') ensureBrainstormLoaded();
      renderReminders();
      renderNightlyReview();
      renderComposerOptions();
      renderActivity();
      refreshSettings();
    } catch (err) {
      // 渲染异常不能让整个界面停摆
      reportError(err);
    }
  }

  function reportError(err) {
    const message = err && err.message ? err.message : String(err);
    if (window.console && console.error) console.error('[super-butler]', err);
    const box = $('#boot-error');
    if (box) {
      box.textContent = `界面渲染异常：${message}`;
      box.hidden = false;
      setTimeout(() => {
        box.hidden = true;
      }, 8000);
    }
  }

  /* ==================================================================
   * 启动
   * ================================================================== */
  async function boot() {
    if (I18N) {
      try {
        I18N.init({ initialLang: I18N.effectiveLang() });
      } catch (err) {
        if (window.console && console.warn) console.warn('[super-butler] i18n init failed', err);
      }
    }
    bindStaticEvents();
    scheduleRelativeRefresh();

    let session = { base: '', token: '' };
    try {
      session = readSession();
    } catch {
      /* ignore */
    }
    let bootBase = session.base || '';
    try {
      const queryBase = urlParam('base') || urlParam('hub');
      if (queryBase) bootBase = normalizeBase(queryBase);
    } catch {
      /* ignore */
    }
    const queryToken = urlParam('token');
    const bootToken = (queryToken || session.token || '').trim();

    $('#hub-url').value = bootBase || '';
    $('#admin-token').value = bootToken;

    if (bootToken) {
      showConnectView();
      setConnectBusy(true);
      setLoading(true, queryToken ? '正在通过令牌连接中枢…' : '正在恢复上次连接…');
      try {
        await connect(bootBase, bootToken);
        setLoading(false);
      } catch (err) {
        setLoading(false);
        showConnectView(err.status === 401 ? '管理员令牌无效或已过期，请重新输入' : (err.message || '自动连接失败，请检查 Hub 地址'));
        $('#admin-token').focus();
      }
    } else {
      showConnectView();
      $('#admin-token').focus();
    }

    if (queryToken) setTimeout(scrubUrlToken, 1200);
  }

  window.addEventListener('error', (event) => reportError(event.error || event.message));
  window.addEventListener('unhandledrejection', (event) => reportError(event.reason));

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
