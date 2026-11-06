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
  };
  const ACTIVE_STATUS = new Set(['queued', 'assigned', 'running']);
  const RETRYABLE_STATUS = new Set(['failed', 'timeout', 'cancelled']);

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
    device: '设备',
  };
  const TABS = new Set(['status', 'tasks', 'command', 'settings']);

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
        else if (key === 'text') node.textContent = String(value);
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
        else if (key === 'html') node.innerHTML = value; // 仅用于本文件内受信任的常量图标
        else if (key === 'attrs') {
          for (const [attrName, attrValue] of Object.entries(value || {})) {
            if (attrValue === null || attrValue === undefined || attrValue === false) continue;
            node.setAttribute(attrName, attrValue === true ? '' : String(attrValue));
          }
        } else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
        else if (key === 'value') node.setAttribute('value', String(value));
        else if (key === 'tabIndex') node.setAttribute('tabindex', String(value));
        else node.setAttribute(key, value === true ? '' : String(value));
      }
    }
    appendChildren(node, children);
    return node;
  }

  function appendChildren(node, children) {
    for (const child of children.flat(6)) {
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
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
  const state = {
    baseUrl: '',
    token: '',
    connected: false,
    health: null,
    server: null,
    devices: new Map(),
    tasks: [],
    stats: null,
    activity: [],
    history: [],
    taskFilter: 'all',
    selectedSkills: new Set(),
    routeTask: null,
    expandedEvents: new Set(),
    expandedOutput: new Set(),
    tab: 'status',
    autoOpenDone: false,
    sendBusy: false,
    drawer: { open: false, kind: null, id: null, returnFocus: null },
    sse: { es: null, status: 'idle', attempts: 0, retryTimer: 0, disabled: false, lastEventAt: 0 },
    poll: { timer: 0, inFlight: false },
    snapshotTimer: 0,
    relTimer: 0,
    sigs: { stats: '', devices: '', tasks: '', composer: '', activity: '', settings: '' },
  };
  const taskNotifyState = new Map();

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
      $('#loading-text').textContent = text || '正在连接中枢…';
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
      $('#modal-title').textContent = title;
      $('#modal-message').textContent = message;
      ok.textContent = okText;
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
    $('.btn-label', btn).textContent = busy ? '连接中…' : '测试并连接';
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
    if (text) text.textContent = SSE_TEXT[status] || status;
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
      'task.created', 'task.updated', 'task.completed', 'task.failed',
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
    if (name.startsWith('task.')) return onTaskEvent(name, payload.task);
    if (name === 'log') return onLogEvent(payload);
    if (name === 'ping') return;
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
    if (Array.isArray(data.events)) state.activity = data.events.slice();
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
    const map = { queued: 'tasksQueued', assigned: 'tasksAssigned', running: 'tasksRunning', completed: 'tasksCompleted', failed: 'tasksFailed' };
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
    syncTaskNotifications();
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
        toast(`${device.name || deviceId} ${online ? '已上线' : '已离线'}`, online ? 'success' : 'warn');
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
  function deviceName(id) {
    const device = state.devices.get(id);
    return (device && device.name) || id || '未知设备';
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
    const counts = { queued: 0, assigned: 0, running: 0, completed: 0, failed: 0 };
    for (const task of state.tasks) {
      if (counts[task.status] !== undefined) counts[task.status] += 1;
    }
    return {
      devicesTotal: state.devices.size,
      devicesOnline: Array.from(state.devices.values()).filter((d) => d.online).length,
      tasksQueued: counts.queued,
      tasksAssigned: counts.assigned,
      tasksRunning: counts.running,
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
      if (/^\s*```/.test(line)) {
        const buf = [];
        i += 1;
        while (i < lines.length && !/^\s*```/.test(lines[i])) {
          buf.push(lines[i]);
          i += 1;
        }
        i += 1;
        const pre = el('pre');
        pre.appendChild(el('code', { text: buf.join('\n') }));
        root.appendChild(pre);
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
    if (node) node.textContent = value;
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
    setText('#head-running', String(view.running + view.assigned));
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
        label: '运行任务',
        icon: 'activity',
        value: String(view.running),
        sub: `已分配 ${view.assigned} · 排队 ${view.queued}`,
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
        el('div', { className: 'stat-top' },
          el('span', { className: 'stat-label', text: card.label }),
          el('span', { className: 'stat-icon' }, icon(card.icon)),
        ),
        el('div', { className: 'stat-value' }, card.value, card.suffix ? el('small', { text: card.suffix }) : null),
        el('div', { className: 'stat-sub', text: card.sub }),
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
        if (iso) node.textContent = (node.dataset.relPrefix || '') + fmtRel(iso, now);
      });
      $$('[data-live-duration]').forEach((node) => {
        const start = parseIso(node.dataset.liveDuration);
        if (start !== null) node.textContent = fmtDuration(now - start);
      });
    }, 15000);
  }

  /* ==================================================================
   * 设备卡片
   * ================================================================== */
  function chipGroup(items, { max = 3, kind = 'model', labelOf, titleOf }) {
    const group = el('div', { className: 'chip-group' });
    if (!items.length) {
      group.appendChild(el('span', { className: 'cap-empty', text: '—' }));
      return group;
    }
    items.slice(0, max).forEach((item) => {
      const text = labelOf(item);
      group.appendChild(el('span', { className: 'chip', dataset: { kind }, text, title: titleOf ? titleOf(item) : text }));
    });
    if (items.length > max) {
      const rest = items.slice(max);
      group.appendChild(el('span', {
        className: 'chip chip-more',
        text: `+${rest.length}`,
        title: rest.map((x) => labelOf(x)).join('、'),
      }));
    }
    return group;
  }

  function capRow(label, group) {
    return el('div', { className: 'cap-row' },
      el('span', { className: 'cap-label', text: label }),
      group,
    );
  }

  function deviceCard(device) {
    const load = loadOf(device);
    const status = deviceStatusOf(device);
    const models = modelsOf(device);
    const skills = skillsOf(device);
    const profiles = profilesOf(device);
    const gateways = gatewaysOf(device);
    const tags = tagsOf(device);
    const active = activeTasksOfDevice(device.id);

    const card = el('article', {
      className: 'device-card' + (device.online ? '' : ' is-offline') + (device.disabled ? ' is-disabled' : ''),
      dataset: { deviceId: device.id },
      role: 'button',
      tabIndex: 0,
      attrs: { 'aria-label': `查看设备 ${device.name || device.id} 的详情` },
    });

    const top = el('div', { className: 'device-top' },
      el('i', {
        className: 'status-dot',
        dataset: {
          tone: !device.online ? 'offline' : device.status === 'busy' ? 'busy' : device.status === 'degraded' ? 'degraded' : 'online',
        },
      }),
      el('h3', { className: 'device-name', text: device.name || device.id, title: device.name || device.id }),
      el('span', { className: 'device-state', dataset: { state: status }, text: DEVICE_STATUS[status] || status }),
    );
    card.appendChild(top);

    const meta = el('div', { className: 'device-meta' },
      el('span', { className: 'meta-strong', text: PLATFORM_LABEL[device.platform] || device.platform || '未知平台' }),
      el('span', { className: 'meta-sep', text: '·' }),
      el('span', { text: KIND_LABEL[device.kind] || device.kind || '设备' }),
    );
    if (device.agentVersion) {
      meta.appendChild(el('span', { className: 'meta-sep', text: '·' }));
      meta.appendChild(el('span', { text: `v${device.agentVersion}` }));
    }
    tags.slice(0, 2).forEach((tag) => meta.appendChild(el('span', { className: 'tag', text: `#${tag}` })));
    card.appendChild(meta);

    const loadBar = el('div', { className: 'bar', dataset: { tone: 'load', level: load.ratio >= 0.75 ? 'high' : 'low' } },
      el('span', { style: { width: `${Math.round(load.ratio * 100)}%` } }),
    );
    card.appendChild(el('div', { className: 'load-row' },
      el('span', { className: 'load-label', text: '负载' }),
      loadBar,
      el('span', { className: 'load-val', text: `${load.running} / ${load.max}` }),
    ));

    const caps = el('div', { className: 'caps' },
      capRow('模型', chipGroup(models, {
        max: 2,
        kind: 'model',
        labelOf: (m) => m.id,
        titleOf: (m) => [m.id, m.provider, m.contextWindow ? `${Math.round(m.contextWindow / 1000)}K 上下文` : '', arr(m.strengths).join('/')].filter(Boolean).join(' · '),
      })),
      capRow('技能', chipGroup(skills, {
        max: 3,
        kind: 'skill',
        labelOf: (s) => s.name || s.id,
        titleOf: (s) => `${s.id}${s.version ? ' · v' + s.version : ''}`,
      })),
      capRow('配置', chipGroup(profiles, { max: 1, kind: 'profile', labelOf: (p) => p.name || p.id, titleOf: (p) => p.id })),
      capRow('网关', chipGroup(gateways, { max: 1, kind: 'gateway', labelOf: (g) => g.id, titleOf: (g) => `${g.id}${g.baseUrl ? ' · ' + g.baseUrl : ''}` })),
    );
    card.appendChild(caps);

    const footLeft = el('span', { className: 'heartbeat' },
      icon('clock'),
      relNode(device.lastSeenAt, '心跳 '),
    );
    if (active.length) footLeft.appendChild(el('span', { text: ` · ${active.length} 个任务` }));
    const removeBtn = el('button', { type: 'button', className: 'link-btn device-remove', text: '移除' });
    removeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteDevice(device.id);
    });
    card.appendChild(el('div', { className: 'device-foot' },
      footLeft,
      removeBtn,
      el('span', { className: 'open-hint' }, '详情', icon('chevron')),
    ));

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
    const rank = (d) => (d.online ? (d.status === 'busy' ? 1 : d.status === 'degraded' ? 2 : 0) : 3);
    const diff = rank(a) - rank(b);
    if (diff !== 0) return diff;
    return (parseIso(b.lastSeenAt) || 0) - (parseIso(a.lastSeenAt) || 0);
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
      d.id, d.name, d.online, d.status, d.disabled, d.load, d.lastSeenAt,
      d.metrics, d.tags, d.capabilities, activeTasksOfDevice(d.id).length,
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
      devices: agg.devices.map((d) => [d.id, d.name, d.status]),
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
        text: `${device.name || device.id} · ${DEVICE_STATUS[device.status] || '在线'}`,
      }));
    }
    if (Array.from(deviceSelect.options).some((o) => o.value === prevDevice)) setSelectValue(deviceSelect, prevDevice);

    const availableSkillIds = new Set(agg.skills.map((s) => s.id));
    for (const id of Array.from(state.selectedSkills)) {
      if (!availableSkillIds.has(id)) state.selectedSkills.delete(id);
    }

    const wrap = $('#skill-chips');
    wrap.replaceChildren();
    if (!agg.skills.length) {
      wrap.appendChild(el('span', { className: 'chip-empty', text: '当前在线设备未申报技能，可发送不带技能要求的指令。' }));
    } else {
      for (const skill of agg.skills) {
        const selected = state.selectedSkills.has(skill.id);
        const chip = el('button', {
          type: 'button',
          className: 'chip',
          dataset: { kind: 'skill', skillId: skill.id },
          attrs: { 'aria-pressed': selected ? 'true' : 'false', title: `${skill.id} · ${skill.count} 台在线设备可用` },
          text: skill.name,
        });
        chip.addEventListener('click', () => {
          if (state.selectedSkills.has(skill.id)) state.selectedSkills.delete(skill.id);
          else state.selectedSkills.add(skill.id);
          chip.setAttribute('aria-pressed', state.selectedSkills.has(skill.id) ? 'true' : 'false');
          updateComposerTarget();
          state.sigs.composer = '';
        });
        wrap.appendChild(chip);
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
      node.appendChild(document.createTextNode('指定设备：'));
      node.appendChild(el('b', { text: device ? device.name : deviceId }));
      if (device && !device.online) node.appendChild(document.createTextNode('（当前离线，任务将排队）'));
      return;
    }
    const matched = agg.devices.filter((d) => localMatch(d, { model, skills, deviceId: '' }));
    if (!state.connected) {
      node.textContent = '等待连接 Hub…';
      return;
    }
    if (!agg.devices.length) {
      node.textContent = '暂无在线设备，发送后将排队等待上线';
      return;
    }
    node.appendChild(document.createTextNode(model || skills.length ? '匹配要求的在线设备：' : '自动路由：'));
    node.appendChild(el('b', { text: `${matched.length} / ${agg.devices.length} 台` }));
    if (!matched.length) node.appendChild(document.createTextNode(' · 将排队等待设备'));
  }

  function setSendBusy(busy) {
    state.sendBusy = busy;
    const btn = $('#send-btn');
    btn.disabled = busy;
    const label = $('span', btn);
    if (label) label.textContent = busy ? '发送中…' : '发送指令';
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
    const skills = Array.from(state.selectedSkills);
    if (model) requirements.model = model;
    if (skills.length) requirements.skills = skills;
    if (deviceId) requirements.deviceId = deviceId;

    const payload = {
      instruction,
      requirements,
      priority: num(Number($('#priority').value), 5),
      timeoutSec: num(Number($('#timeout').value), 300),
      maxAttempts: 2,
    };
    setSendBusy(true);
    try {
      const res = await api('/api/tasks', { method: 'POST', body: payload, timeout: 20000 });
      const task = res && res.task;
      if (!task) throw new Error('Hub 未返回任务信息');
      upsertTask(task);
      state.sigs.stats = '';
      state.sigs.tasks = '';
      renderStats();
      renderTasks();
      setRouteResult(task);
      textarea.value = '';
      updateComposerTarget();
      const assigned = !!task.assignedDeviceId;
      toast(assigned ? `已分配给 ${task.assignedDeviceName || deviceName(task.assignedDeviceId)}` : '已排队，等待设备上线', assigned ? 'success' : 'warn');
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
  function filteredTasks() {
    const filter = state.taskFilter;
    const inFilter = (task) => {
      const status = normStatus(task.status);
      if (filter === 'archived') return Boolean(task.archived);
      if (task.archived) return false;
      if (filter === 'all') return true;
      if (filter === 'active') return ACTIVE_STATUS.has(status);
      if (filter === 'completed') return status === 'completed';
      if (filter === 'failed') return status === 'failed' || status === 'timeout' || status === 'cancelled';
      return true;
    };
    const visible = state.tasks.filter(inFilter);
    if (filter === 'archived') {
      return visible.filter((task) => !task.parentTaskId || !state.tasks.some((parent) => parent.id === task.parentTaskId && parent.archived));
    }
    return visible.filter((task) => !task.parentTaskId || !state.tasks.some((parent) => parent.id === task.parentTaskId));
  }

  function renderFilterCounts() {
    const activeTasks = state.tasks.filter((task) => !task.archived);
    const counts = {
      all: activeTasks.length,
      active: activeTasks.filter((t) => ACTIVE_STATUS.has(normStatus(t.status))).length,
      completed: activeTasks.filter((t) => normStatus(t.status) === 'completed').length,
      failed: activeTasks.filter((t) => ['failed', 'timeout', 'cancelled'].includes(normStatus(t.status))).length,
      archived: state.tasks.filter((t) => t.archived).length,
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

  function subtaskRow(child) {
    const status = normStatus(child.status);
    const row = el('button', {
      type: 'button', className: 'subtask-row', dataset: { action: 'open-child', taskId: child.id },
      attrs: { 'aria-label': `子任务 ${TASK_STATUS[status].label}：${shorten(child.instruction, 36)}` },
    },
      statusBadge(status),
      el('span', { className: 'subtask-title', text: shorten(child.instruction, 70) }),
      el('span', { className: 'subtask-meta', text: child.assignedDeviceName || (ACTIVE_STATUS.has(status) ? '等待设备' : '') }),
    );
    return row;
  }

  function subtaskList(parent) {
    const children = childTasksOf(parent);
    if (!children.length) return null;
    const done = children.filter((item) => ['completed', 'failed', 'timeout', 'cancelled'].includes(normStatus(item.status))).length;
    const wrap = el('div', { className: 'subtask-wrap' },
      el('div', { className: 'subtask-head' },
        icon('queue'),
        el('span', { text: `Agnes 拆分的子任务 ${done}/${children.length}` }),
      ),
      el('div', { className: 'subtask-list' }, ...children.map(subtaskRow)),
    );
    return wrap;
  }

  function taskCard(task) {
    const status = normStatus(task.status);
    const card = el('article', {
      className: 'task-card' + (state.expandedOutput.has(task.id) ? ' output-open' : '') + (task.archived ? ' is-archived' : ''),
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
    if (task.isPlan) {
      const children = subtaskList(task);
      if (children) card.appendChild(children);
    }

    const progress = activeProgress(task, status);
    if (progress) card.appendChild(progress);

    const output = outputOf(task);
    if (output) {
      const body = renderMarkdown(output.markdown || output.text || '');
      const outWrap = el('div', { className: 'task-output' }, body);
      card.appendChild(outWrap);
      const longOutput = (output.markdown || output.text || '').length > 260;
      if (longOutput) {
        card.appendChild(el('button', {
          type: 'button',
          className: 'link-btn',
          dataset: { action: 'toggle-output' },
          text: state.expandedOutput.has(task.id) ? '收起输出' : '展开输出',
        }));
      }
    }

    if (task.error) {
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
    if (ACTIVE_STATUS.has(status)) {
      actions.appendChild(el('button', { type: 'button', className: 'link-btn', dataset: { action: 'cancel' } },
        icon('x'), el('span', { text: '取消' })));
    }
    if (RETRYABLE_STATUS.has(status)) {
      actions.appendChild(el('button', { type: 'button', className: 'link-btn', dataset: { action: 'retry' } },
        icon('refresh'), el('span', { text: '重试' })));
    }
    actions.appendChild(el('button', { type: 'button', className: 'link-btn', dataset: { action: 'copy-instruction' } },
      icon('copy'), el('span', { text: '复制指令' })));
    actions.appendChild(el('button', { type: 'button', className: 'link-btn', dataset: { action: 'edit-instruction' } },
      icon('edit'), el('span', { text: '编辑重发' })));
    actions.appendChild(el('button', { type: 'button', className: 'link-btn', dataset: { action: task.archived ? 'unarchive' : 'archive' } },
      el('span', { text: task.archived ? '取消归档' : '归档' })));
    actions.appendChild(el('button', { type: 'button', className: 'link-btn', dataset: { action: 'delete' } },
      el('span', { text: '删除' })));
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
    const bar = el('div', { className: 'bar', dataset: { tone: status === 'assigned' ? 'queued' : 'load' } },
      percent === null
        ? el('span', { className: 'is-indeterminate', style: { width: '35%' } })
        : el('span', { style: { width: `${Math.max(2, percent)}%` } }),
    );
    const label = percent === null ? (status === 'assigned' ? '等待设备接受…' : '处理中…') : `${Math.round(percent)}%`;
    return el('div', { className: 'task-progress' },
      bar,
      el('span', { className: 'task-progress-text', text: label, title: progress && progress.message ? progress.message : '' }),
    );
  }

  function renderTasks() {
    const list = $('#task-list');
    const tasks = filteredTasks();
    const sig = JSON.stringify({
      filter: state.taskFilter,
      expandedEvents: Array.from(state.expandedEvents),
      expandedOutput: Array.from(state.expandedOutput),
      tasks,
    });
    if (sig === state.sigs.tasks && list.childElementCount) {
      renderFilterCounts();
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
      };
      const msg = messages[state.taskFilter] || messages.all;
      list.appendChild(emptyState({ iconName: msg.icon, title: msg.title, desc: msg.desc }));
    } else {
      for (const task of tasks) list.appendChild(taskCard(task));
    }
    setText('#tasks-sub', `${state.tasks.length} 个任务 · 进行中 ${state.tasks.filter((t) => ACTIVE_STATUS.has(normStatus(t.status))).length}`);
    renderFilterCounts();
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
        } else if (data.device && data.device.name) {
          message = `${type === 'device.online' ? '设备上线' : type === 'device.offline' ? '设备离线' : '设备更新'}：${data.device.name}`;
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

  function maskToken(token) {
    if (!token) return '未保存';
    if (token.length <= 8) return '••••••••';
    return `${token.slice(0, 4)}••••${token.slice(-4)}`;
  }

  function copyText(text, successMessage) {
    const done = () => toast(successMessage || '已复制', 'success');
    const fail = () => toast('复制失败，请手动选择文本', 'error');
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
        status.textContent = describe(info);
      } catch (e) {
        status.textContent = '无法读取通知设置';
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
      } else if (action === 'logout') {
        logout();
      }
    });
    return wrap;
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
      if (node) sub.appendChild(node instanceof Node ? node : document.createTextNode(String(node)));
    }
    $('#drawer-body').replaceChildren(body || '');
    const foot = $('#drawer-foot');
    if (footerNodes && footerNodes.length) {
      foot.replaceChildren(...footerNodes);
      foot.hidden = false;
    } else {
      foot.replaceChildren();
      foot.hidden = true;
    }
    $('#drawer-root').hidden = false;
    document.body.classList.add('no-scroll');
    const drawer = $('#drawer');
    requestAnimationFrame(() => drawer.focus({ preventScroll: true }));
  }

  function hideDrawer() {
    if (!state.drawer.open) return;
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

  function refreshOpenDrawer() {
    if (!state.drawer.open) return;
    if (state.drawer.kind === 'device') refreshDeviceDrawer(state.drawer.id);
    else if (state.drawer.kind === 'task') refreshTaskDrawer(state.drawer.id);
  }

  /* ==================================================================
   * 设备详情抽屉
   * ================================================================== */
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
      metricBox('状态', DEVICE_STATUS[status] || status, `最近心跳 ${fmtRel(device.lastSeenAt)}`),
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

  function metricBox(label, value, sub, percent) {
    const box = el('div', { className: 'metric-box' },
      el('div', { className: 'metric-label', text: label }),
      el('div', { className: 'metric-value', text: String(value) }),
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

  function renderDeviceDrawer(device, preserveScroll) {
    const scroll = preserveScroll ? $('#drawer-body').scrollTop : 0;
    setText('#drawer-title', device.name || device.id);
    const sub = $('#drawer-sub');
    sub.replaceChildren(
      el('i', {
        className: 'status-dot',
        dataset: { tone: device.online ? (device.status === 'busy' ? 'busy' : 'online') : 'offline' },
      }),
      el('span', { text: DEVICE_STATUS[deviceStatusOf(device)] || deviceStatusOf(device) }),
      el('span', { text: '·' }),
      el('span', { text: `${PLATFORM_LABEL[device.platform] || device.platform || '未知平台'} · ${KIND_LABEL[device.kind] || device.kind || '设备'}` }),
    );
    $('#drawer-body').replaceChildren(buildDeviceBody(device));
    $('#drawer-body').scrollTop = scroll;
    const foot = $('#drawer-foot');
    foot.replaceChildren(...deviceFooterNodes(device));
    foot.hidden = false;
  }

  function openDeviceDrawer(id) {
    const device = state.devices.get(id);
    if (!device) {
      toast('设备不存在或已被移除', 'warn');
      return;
    }
    openDrawer({
      kind: 'device',
      id,
      title: device.name || device.id,
      subNodes: [],
      body: null,
      footerNodes: [],
    });
    renderDeviceDrawer(device, false);
  }

  function refreshDeviceDrawer(id) {
    if (!state.drawer.open || state.drawer.kind !== 'device' || state.drawer.id !== id) return;
    const device = state.devices.get(id);
    if (!device) {
      hideDrawer();
      return;
    }
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
      message: `将从 Hub 移除「${device.name || device.id}」。如果设备仍在线，它会在下次心跳时重新注册。`,
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

    const instructionSection = el('section', { className: 'detail-section' },
      el('div', { className: 'detail-section-head' }, el('h3', { text: '指令' })),
      el('p', { className: 'detail-quote', text: task.instruction || '（无指令内容）' }),
    );
    const reqChips = el('div', { className: 'requirements-row' });
    if (requirements.model) reqChips.appendChild(el('span', { className: 'chip', dataset: { kind: 'model' }, text: `模型 ${requirements.model}` }));
    arr(requirements.skills).forEach((skill) => reqChips.appendChild(el('span', { className: 'chip', dataset: { kind: 'skill' }, text: `技能 ${skill}` })));
    if (requirements.profile) reqChips.appendChild(el('span', { className: 'chip', dataset: { kind: 'profile' }, text: `配置 ${requirements.profile}` }));
    if (requirements.gateway) reqChips.appendChild(el('span', { className: 'chip', dataset: { kind: 'gateway' }, text: `网关 ${requirements.gateway}` }));
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
      const outSection = el('section', { className: 'detail-section' },
        el('div', { className: 'detail-section-head' }, el('h3', { text: '输出' })),
        el('div', { className: 'detail-quote output-quote' }, renderMarkdown(output.markdown || output.text || '')),
      );
      body.appendChild(outSection);
    }
    if (task.error) {
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
      el('button', {
        type: 'button', className: 'btn btn-ghost btn-sm',
        onclick: () => { hideDrawer(); editTaskInstruction(task.id); },
      }, icon('edit'), '编辑重发'),
    ];
    if (ACTIVE_STATUS.has(status)) {
      nodes.push(el('button', { type: 'button', className: 'btn btn-danger btn-sm', onclick: () => cancelTask(task.id) }, icon('x'), '取消任务'));
    }
    if (RETRYABLE_STATUS.has(status)) {
      nodes.push(el('button', { type: 'button', className: 'btn btn-primary btn-sm', onclick: () => retryTask(task.id) }, icon('refresh'), '重新排队'));
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
    foot.replaceChildren(...taskFooterNodes(task));
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

  function editTaskInstruction(id) {
    const task = state.tasks.find((item) => item.id === id);
    if (!task) return;
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

  function setTab(tab, { scroll = true } = {}) {
    const next = TABS.has(tab) ? tab : 'status';
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
    if (kind === 'device' && state.devices.has(id)) {
      state.autoOpenDone = true;
      openDeviceDrawer(id);
    } else if (kind === 'task' && state.tasks.some((t) => t.id === id)) {
      state.autoOpenDone = true;
      openTaskDrawer(id);
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
        else if (action === 'archive') archiveTask(id, true);
        else if (action === 'unarchive') archiveTask(id, false);
        else if (action === 'delete') deleteTask(id);
        else if (action === 'copy-instruction') {
          const task = state.tasks.find((item) => item.id === id);
          if (task) copyText(task.instruction || '', '指令已复制');
        } else if (action === 'edit-instruction') editTaskInstruction(id);
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

    /* 指令表单 */
    $('#task-form').addEventListener('submit', sendTask);
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

    /* 手机 Tab */
    $$('.mobile-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        setTab(btn.dataset.tab);
        try {
          history.replaceState(null, '', '#' + btn.dataset.tab);
        } catch {
          /* ignore */
        }
      });
    });
    window.addEventListener('hashchange', () => setTab(currentTabFromHash(), { scroll: false }));
    MOBILE_MQ.addEventListener('change', () => setTab(state.tab, { scroll: false }));

    /* 键盘 */
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.drawer.open) {
        hideDrawer();
        return;
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
