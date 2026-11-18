'use strict';

/**
 * 手机 Mika 操作失效自愈（USB ADB）。
 *
 * 症状：手机放久了 Mika 打不开 App，任务报 phone_unavailable / NO_ACCESSIBILITY，
 * 或者手机上的「设置 › 无障碍 › Mika」显示「无法运行」「此服务出现故障」。
 *
 * 真因（ColorOS / Android 12 实机验证）：
 *   - Mika 的无障碍服务崩溃后，系统把它记进 Crashed services，不再绑定（Bound services 为空）；
 *   - 有时连同无障碍总开关一起被系统关掉（`settings get secure accessibility_enabled` = 0），
 *     但 enabled_accessibility_services 里还留着组件名（短形式 `包名/.类名`）；
 *   - Mika 自己在 App 里修需要 WRITE_SECURE_SETTINGS，很多机器上没授予。
 *
 * 修复动作照搬 Mika 自身的语义（见 Mika 源码 core/.../shell/RecoveryPermissions.kt）：
 *   1. 读 `enabled_accessibility_services`，组件名先归一化（`包名/.Cls` 与 `包名/包名.Cls` 是同一组件），
 *      追加/去重时不动别的无障碍服务；
 *   2. 服务在列表里却没绑定（crashed）时，先把它从列表里摘掉、等一会儿再放回，系统才会重新绑定；
 *   3. 列表非空后把 `accessibility_enabled` 置 1；
 *   4. 电池白名单（cmd deviceidle whitelist +包名）、尽量 `pm grant ... WRITE_SECURE_SETTINGS`
 *      （让 Mika 自己以后也能修）；
 *   5. 唤醒屏幕、拉起 Mika，最后用 dumpsys 校验「总开关开 + 列表里有 + 没崩 + 已绑定」。
 *
 * adb shell 有写安全设置的权限时（多数机型的默认状态）走第 1~3 步的直接写设置；
 * 没有权限时（ColorOS 关闭「禁止权限监控 / USB 调试安全设置」就是这样，settings put 会抛
 * SecurityException: Permission denial: writing to settings requires:android.permission.WRITE_SECURE_SETTINGS）
 * 改走系统设置界面自动化：`am start -a android.settings.ACCESSIBILITY_SETTINGS` → uiautomator dump
 * → input tap 点 Mika 那一行 → 在家开关上做「关掉再打开」，语义与 Mika 的去掉再加回一致。
 * 这一步只依赖 `input`（INJECT_EVENTS），受限机型上同样可用。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_PACKAGE = 'com.wangzan101.mika';
const DEFAULT_APP_LABEL = 'Mika';
const DEFAULT_SERVICE_CLASS = 'com.wangzan101.mika.a11y.MikaAccessibilityService';
const SETTINGS_ACTIVITY_ACTION = 'android.settings.ACCESSIBILITY_SETTINGS';
const A11Y_LIST_KEY = 'enabled_accessibility_services';
const A11Y_ENABLED_KEY = 'accessibility_enabled';
const SCREENSHOT_DUMP_PATH = '/sdcard/window_dump.xml';
/** 手机助手进程名后缀：Mika 用「adb shell 跑 usb-start.sh」拉起的就是这个进程。 */
const HELPER_SUFFIX = ':helper';
/** Mika 写在手机外部文件目录里的两个脚本（由 App 自己写，见 HelperHandoff.kt）。 */
const USB_START_SCRIPT = 'usb-start.sh';
const CONNECT_SCRIPT = 'connect-computer.sh';
/** 无障碍列表「摘掉再放回」之间留给系统的间隔（Mika 内部 restartAccessibility 的 gapMs 语义）。 */
const DEFAULT_REBIND_GAP_MS = 700;
const DEFAULT_STEP_TIMEOUT_MS = 20000;

// 确认/取消按钮的文案（中文 ColorOS 实机文案见 docs/PHONE-RECOVERY.md；英文与其他 ROM 一并兼容）。
const STOP_LABELS = ['停止', '停用', '确定', 'ok', 'stop', 'turn off', 'disable'];
const CANCEL_LABELS = ['取消', 'cancel'];
const CONFIRM_LABELS = ['允许', '确定', '好的', '同意', 'allow', 'ok', 'continue', '启用'];

// ---------------------------------------------------------------------------
// 组件名与无障碍列表（与 Mika AccessibilityList 一致）
// ---------------------------------------------------------------------------

/** `包名/.Cls` → `包名/包名.Cls`；已经是全名或没有斜杠时原样返回。 */
function expandComponent(component) {
  const value = String(component || '').trim();
  if (!value.includes('/')) return value;
  const pkg = value.slice(0, value.indexOf('/'));
  const cls = value.slice(value.indexOf('/') + 1);
  return cls.startsWith('.') ? `${pkg}/${pkg}${cls}` : value;
}

/** `settings get` 的原始输出 → 组件数组（冒号分隔；`null` 视为空）。 */
function accessibilityEntries(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value || value === 'null') return [];
  return value
    .split(':')
    .map((item) => item.trim())
    .filter(Boolean);
}

function sameComponent(a, b) {
  return expandComponent(a) === expandComponent(b);
}

function listContains(raw, component) {
  return accessibilityEntries(raw).some((item) => sameComponent(item, component));
}

function listWith(raw, component) {
  const entries = accessibilityEntries(raw);
  if (entries.some((item) => sameComponent(item, component))) return entries.join(':');
  return [...entries, component].join(':');
}

function listWithout(raw, component) {
  return accessibilityEntries(raw)
    .filter((item) => !sameComponent(item, component))
    .join(':');
}

// ---------------------------------------------------------------------------
// dumpsys / uiautomator 解析
// ---------------------------------------------------------------------------

function grabBlock(text, label) {
  const match = new RegExp(`${label}:\\{([^}]*)\\}`).exec(String(text || ''));
  return match ? match[1] : '';
}

function countServices(block) {
  const trimmed = String(block || '').trim();
  if (!trimmed) return 0;
  return (trimmed.match(/Service\[/g) || []).length;
}

/**
 * 解析 `dumpsys accessibility`：
 *   accessibility_enabled / 启用列表 / 已绑定列表 / 崩溃列表。
 * miaBound：dspsys 的 Bound services 不带组件名，只带 label；Mika 的 App 名默认是 "Mika"，
 * 单个无障碍服务在跑时也能确定是它。
 */
function parseA11yDump(dumpText, { appLabel = DEFAULT_APP_LABEL } = {}) {
  const text = String(dumpText || '');
  const boundBlock = grabBlock(text, 'Bound services');
  const enabledBlock = grabBlock(text, 'Enabled services');
  const crashedBlock = grabBlock(text, 'Crashed services');
  const bindingBlock = grabBlock(text, 'Binding services');
  const boundCount = countServices(boundBlock);
  const enabledEntries = accessibilityEntries(enabledBlock.replace(/[{}]/g, '').replace(/,/g, ':'));
  const crashedEntries = accessibilityEntries(crashedBlock.replace(/[{}]/g, '').replace(/,/g, ':'));
  const labelPattern = new RegExp(`label=${appLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  const byLabel = labelPattern.test(boundBlock);
  return {
    boundBlock,
    enabledBlock,
    crashedBlock,
    bindingBlock,
    boundCount,
    bindingCount: countServices(bindingBlock),
    enabledEntries,
    crashedEntries,
    mikaBound: byLabel || (boundCount > 0 && enabledEntries.length <= 1),
  };
}

/** dumpsys 里的组件名会展开成全名，这里统一成可比对的形式。 */
function dumpEntries(rawList) {
  return accessibilityEntries(rawList).map(expandComponent);
}

function parseBounds(text) {
  const match = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(String(text || ''));
  if (!match) return null;
  const [x1, y1, x2, y2] = match.slice(1).map(Number);
  return { x1, y1, x2, y2, cx: Math.round((x1 + x2) / 2), cy: Math.round((y1 + y2) / 2) };
}

function attr(openTag, name) {
  const match = new RegExp(`${name}="([^"]*)"`).exec(openTag);
  return match ? match[1] : '';
}

/** uiautomator dump 的 XML → 扁平节点数组（足够做「找文字、找开关、算坐标」）。 */
function parseUiDump(xml) {
  const text = String(xml || '');
  const nodes = [];
  const re = /<node\b[^>]*>/g;
  let match = re.exec(text);
  while (match) {
    const tag = match[0];
    nodes.push({
      text: attr(tag, 'text'),
      desc: attr(tag, 'content-desc'),
      resourceId: attr(tag, 'resource-id'),
      className: attr(tag, 'class'),
      packageName: attr(tag, 'package'),
      checkable: attr(tag, 'checkable') === 'true',
      checked: attr(tag, 'checked') === 'true',
      clickable: attr(tag, 'clickable') === 'true',
      enabled: attr(tag, 'enabled') !== 'false',
      scrollable: attr(tag, 'scrollable') === 'true',
      bounds: parseBounds(attr(tag, 'bounds')),
      raw: tag,
    });
    match = re.exec(text);
  }
  return nodes;
}

function nodeLabel(node) {
  return `${node.text || ''} ${node.desc || ''}`.trim();
}

function findTextNode(nodes, labels) {
  const wanted = labels.map((item) => String(item).toLowerCase());
  return (
    nodes.find((node) => {
      const label = nodeLabel(node).toLowerCase();
      return label && wanted.includes(label);
    }) || null
  );
}

function findContainsNode(nodes, patterns) {
  const list = patterns.map((item) => String(item).toLowerCase());
  return (
    nodes.find((node) => {
      const label = nodeLabel(node).toLowerCase();
      return label && list.some((item) => label.includes(item));
    }) || null
  );
}

function switches(nodes) {
  return nodes.filter((node) => node.className === 'android.widget.Switch' || node.checkable);
}

/** 详情页主开关：最靠上的那个 Switch（ColorOS 上是 [900,325] 那个）。 */
function primarySwitch(nodes) {
  const list = switches(nodes).filter((node) => node.bounds);
  if (!list.length) return null;
  return list.slice().sort((a, b) => a.bounds.y1 - b.bounds.y1)[0];
}

// ---------------------------------------------------------------------------
// 命令执行
// ---------------------------------------------------------------------------

/** 从 `__name__` 分段输出里取出某一段（分段由 readState 的一次 adb 往返拼出来）。 */
function takeSection(raw, name) {
  const marker = `__${name}__`;
  const text = String(raw || '');
  const start = text.indexOf(marker);
  if (start < 0) return '';
  const rest = text.slice(start + marker.length);
  const next = /__[a-z_]+__/.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

function firstInt(text) {
  const match = /(\d+)/.exec(String(text || ''));
  return match ? Number(match[1]) : 0;
}

/**
 * 解析 `usb-start.sh` 的输出（文案由 Mika 的 HelperHandoff.usbScript() 写死）：
 *  - running：助手已经在跑（Nothing to do）；
 *  - starting：刚拉起来（starting... Open Mika to confirm）；
 *  - failed：脚本说没起来 / 不是 adb shell 身份 / 已配对下助手不在。
 */
function classifyHelperOutput(text) {
  const value = String(text || '');
  if (/did not start|is not running|Run this from a computer|does not exist/i.test(value)) return 'failed';
  if (/already running/i.test(value)) return 'running';
  if (/helper starting/i.test(value)) return 'starting';
  if (/__exit=0/.test(value)) return 'starting';
  return 'failed';
}

/**
 * 把一次 readState 的结果翻译成人能看的检查项，供 CLI / 执行器 / 日志共用。
 * 返回 [{ id, name, ok, detail, info? }]；info:true 的项只作说明，不算故障。
 */
function describeChecks(state, { appLabel = DEFAULT_APP_LABEL } = {}) {
  if (!state || !state.reachable) {
    const reason = (state && state.reason) || 'adb-unreachable';
    return [
      {
        id: reason,
        name: 'adb 连接',
        ok: false,
        detail: reason === 'adb-no-device'
          ? '没有设备：数据线插好、手机上允许 USB 调试'
          : `不可用：${(state && state.detail) || reason}`,
      },
    ];
  }
  const items = [
    { id: 'adb', name: 'adb 连接', ok: true, detail: '设备在线' },
    {
      id: 'a11y-master-off',
      name: '无障碍总开关',
      ok: state.enabled === '1',
      detail: `accessibility_enabled=${state.enabled == null ? '?' : state.enabled}`,
    },
    {
      id: 'service-not-listed',
      name: '无障碍服务在列表里',
      ok: Boolean(state.present),
      detail: state.entries && state.entries.length ? `enabled_accessibility_services=${state.entries.join(':')}` : '列表为空',
    },
    {
      id: 'service-crashed',
      name: '无障碍服务未崩溃',
      ok: !state.crashed,
      detail: state.crashed ? '系统把它记在 Crashed services（崩溃后不再自己重绑）' : 'Crashed services 里没有它',
    },
    {
      id: 'service-not-bound',
      name: '无障碍服务已绑定',
      ok: Boolean(state.bound),
      detail: state.bound ? 'Bound services 里有 Mika' : 'Bound services 为空/没有 Mika',
    },
    {
      id: 'helper-not-running',
      name: '手机助手（Mika 操作 App 的通道）',
      ok: Boolean(state.helperRunning),
      detail: state.helperRunning
        ? `运行中 pid=${state.helperPid}`
        : '没有运行：Mika 打不开手机上的 App（用 USB 跑一次 usb-start.sh 可以拉起来）',
    },
    {
      id: 'app-not-running',
      name: 'Mika App 进程',
      ok: Boolean(state.appPid),
      info: !state.appPid,
      detail: state.appPid ? `pid=${state.appPid}` : '没在运行（任务时会自动拉起）',
    },
  ];
  if (!state.adbWifi) {
    items.push({
      id: 'wireless-debugging-off',
      name: '无线调试',
      ok: true,
      info: true,
      detail: '关着（Mika 界面「设置 › 手机操作 › 无线调试已关」就是这个；USB 直连模式下不影响，能配对时再开）',
    });
  }
  void appLabel;
  return items;
}

function isAbortError(err) {
  return Boolean(err) && err.name === 'AbortError';
}

function makeAbortError(signal) {
  const err = new Error('已取消');
  err.name = 'AbortError';
  err.signal = signal;
  return err;
}

function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      return;
    }
  } catch {
    /* fall through */
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* ignore */
  }
}

/**
 * 默认的命令执行：stdio 全部走文件重定向（与 executors.js 一致，Windows 沙箱下不能 pipe 子进程）。
 * 返回 { code, stdout, stderr }；超时不抛错，code 记为 -1，由调用方判断。
 */
async function runProcess(exe, args, { timeoutMs = DEFAULT_STEP_TIMEOUT_MS, signal = null, cwd = undefined, env = undefined } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'butler-adb-'));
  const outFile = path.join(dir, 'stdout.log');
  const errFile = path.join(dir, 'stderr.log');
  const outFd = fs.openSync(outFile, 'a');
  const errFd = fs.openSync(errFile, 'a');
  let child;
  try {
    child = spawn(exe, args, {
      cwd,
      env: env || process.env,
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
    });
  } catch (err) {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    return { code: -1, stdout: '', stderr: `启动失败：${err.message}` };
  }
  try {
    const code = await new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = () => {
        killTree(child);
        finish(-2);
      };
      child.once('error', () => finish(-1));
      child.once('exit', (exitCode) => finish(exitCode == null ? -1 : exitCode));
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          killTree(child);
          finish(-1);
        }, timeoutMs);
        if (timer.unref) timer.unref();
      }
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    if (signal && signal.aborted) throw makeAbortError(signal);
    const [stdout, stderr] = await Promise.all([
      fsp.readFile(outFile, 'utf8').catch(() => ''),
      fsp.readFile(errFile, 'utf8').catch(() => ''),
    ]);
    return { code, stdout, stderr };
  } finally {
    try {
      fs.closeSync(outFd);
    } catch {
      /* ignore */
    }
    try {
      fs.closeSync(errFd);
    } catch {
      /* ignore */
    }
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function firstLines(text, count = 3) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, count)
    .join(' / ');
}

// ---------------------------------------------------------------------------
// 自愈主体
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {string} [options.adb] adb 可执行文件，默认 'adb'
 * @param {string} [options.serial] 手机序列号（多设备时必须给）
 * @param {string} [options.packageName] Mika 包名
 * @param {string} [options.serviceClass] 无障碍服务类名
 * @param {string} [options.appLabel] 手机无障碍列表里显示的 App 名（默认 Mika）
 * @param {number} [options.timeoutMs] 单条 adb 命令超时
 * @param {number} [options.rebindGapMs] 摘掉再放回的间隔
 * @param {Function} [options.run] 自定义执行器（测试注入）：(exe, args, opts) => { code, stdout, stderr }
 * @param {Function} [options.log] (message, detail) => void
 */
function createMikaRecovery(options = {}) {
  const adb = String(options.adb || 'adb');
  const serial = String(options.serial || '');
  const packageName = String(options.packageName || DEFAULT_PACKAGE);
  const serviceClass = String(options.serviceClass || DEFAULT_SERVICE_CLASS);
  const appLabel = String(options.appLabel || DEFAULT_APP_LABEL);
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_STEP_TIMEOUT_MS;
  const rebindGapMs = Number(options.rebindGapMs) >= 0 ? Number(options.rebindGapMs) : DEFAULT_REBIND_GAP_MS;
  const run = typeof options.run === 'function' ? options.run : runProcess;
  const log = typeof options.log === 'function' ? options.log : () => {};

  const component = `${packageName}/${serviceClass.startsWith(`${packageName}.`) ? serviceClass.slice(packageName.length) : serviceClass}`;

  function adbArgs(cmd) {
    const args = serial ? ['-s', serial] : [];
    return [...args, ...cmd];
  }

  /** 跑一条 adb shell 命令（命令里可以有分号、重定向）。 */
  async function shell(command, { signal = null, timeout = timeoutMs } = {}) {
    const result = await run(adb, adbArgs(['shell', command]), { timeoutMs: timeout, signal });
    const text = `${result.stdout || ''}${result.stderr || ''}`.trim();
    return { code: result.code, text, stdout: result.stdout || '', stderr: result.stderr || '' };
  }

  const phoneFiles = `/sdcard/Android/data/${packageName}/files`;
  const usbScriptPath = `${phoneFiles}/${USB_START_SCRIPT}`;
  const connectScriptPath = `${phoneFiles}/${CONNECT_SCRIPT}`;
  const helperName = `${packageName}${HELPER_SUFFIX}`;

  function offlineReason(text) {
    const value = String(text || '');
    if (/no devices|device '?\w+'? not found|adb: no devices/i.test(value)) return 'adb-no-device';
    if (/device offline|unauthorized|no permissions/i.test(value)) return 'device-offline';
    if (/error: closed|connection reset/i.test(value)) return 'adb-error';
    return '';
  }

  /**
   * 一次性取回自检要用的全部信息（一次 adb 往返）：
   * 无障碍（总开关/列表/dumpsys）、无线调试开关、开机计数、
   * App 进程、手机助手进程、两个由 Mika 自己写出的脚本是否存在。
   */
  async function readState({ signal = null } = {}) {
    const probeCommand = [
      `echo __enabled__; settings get secure ${A11Y_ENABLED_KEY}`,
      `echo __list__; settings get secure ${A11Y_LIST_KEY}`,
      'echo __wifi__; settings get global adb_wifi_enabled',
      'echo __boot__; settings get global boot_count',
      `echo __app__; pidof ${packageName} 2>/dev/null`,
      `echo __helper__; pidof ${helperName} 2>/dev/null`,
      `echo __script__; test -f ${usbScriptPath} && echo usb-yes || echo usb-no; test -f ${connectScriptPath} && echo connect-yes || echo connect-no`,
      'echo __dump__; dumpsys accessibility',
    ].join('; ');
    const probe = await shell(probeCommand, { signal, timeout: Math.max(timeoutMs, 25000) });
    const raw = probe.text;
    const offline = offlineReason(raw);
    if (offline && !raw.includes('__dump__')) {
      return {
        reachable: false,
        reason: offline,
        detail: firstLines(raw),
        enabled: null,
        listRaw: '',
        present: false,
        crashed: false,
        bound: false,
        dump: '',
        adbWifi: false,
        bootId: 0,
        appPid: 0,
        helperPid: 0,
        helperRunning: false,
        usbScriptPresent: false,
        connectScriptPresent: false,
      };
    }
    const enabledSection = takeSection(raw, 'enabled');
    const enabled = /[01]/.test(enabledSection) ? /[01]/.exec(enabledSection)[0] : null;
    const listSection = takeSection(raw, 'list');
    const listRaw = listSection === 'null' ? '' : listSection.replace(/\r?\n/g, '').trim();
    const dump = takeSection(raw, 'dump') || raw;
    const parsed = parseA11yDump(dump, { appLabel });
    const present = listContains(listRaw, component) || dumpEntries(listRaw).includes(expandComponent(component));
    const crashed = parsed.crashedEntries.some((item) => sameComponent(item, component));
    const bootText = takeSection(raw, 'boot');
    const appPid = firstInt(takeSection(raw, 'app'));
    const helperPid = firstInt(takeSection(raw, 'helper'));
    const scriptText = takeSection(raw, 'script');
    return {
      reachable: true,
      reason: '',
      detail: '',
      enabled,
      listRaw,
      entries: accessibilityEntries(listRaw),
      present,
      crashed,
      bound: parsed.mikaBound,
      boundCount: parsed.boundCount,
      crashedEntries: parsed.crashedEntries,
      enabledEntries: parsed.enabledEntries,
      dump,
      raw,
      adbWifi: takeSection(raw, 'wifi') === '1',
      bootId: firstInt(bootText),
      appPid,
      helperPid,
      helperRunning: helperPid > 0,
      usbScriptPresent: /usb-yes/.test(scriptText),
      connectScriptPresent: /connect-yes/.test(scriptText),
    };
  }

  /** 综合自检：无障碍 + 手机助手（Mika 操作 App 的两条硬前提）。 */
  function diagnoseState(state) {
    const checks = describeChecks(state, { appLabel });
    const problems = checks.filter((item) => !item.ok && !item.info).map((item) => item.id);
    const a11yOk = checks.filter((item) => item.id.startsWith('a11y') || item.id.startsWith('service')).every((item) => item.ok);
    const helperOk = Boolean(state && state.helperRunning);
    return {
      ok: problems.length === 0,
      problems,
      checks,
      component,
      state,
      a11yOk,
      helperOk,
      summary: problems.length
        ? `手机控制异常：${problems.join(', ')}`
        : a11yOk && helperOk
          ? '无障碍正常（总开关开、在列表里、未崩溃、已绑定），手机助手在运行'
          : '自检未通过',
    };
  }

  async function diagnose({ signal = null } = {}) {
    const state = await readState({ signal });
    const report = diagnoseState(state);
    log(report.ok ? '无障碍自检通过' : report.summary, {
      enabled: state.enabled,
      present: state.present,
      crashed: state.crashed,
      bound: state.bound,
      entries: state.entries,
    });
    return report;
  }

  // -------------------------------------------------------------- 直接写设置

  async function writeSetting(command, { signal } = {}) {
    const result = await shell(`${command} 2>&1; echo __exit=$?`, { signal });
    const codeMatch = /__exit=(\d+)/.exec(result.text);
    const code = codeMatch ? Number(codeMatch[1]) : result.code;
    const denied = /SecurityException|Permission denial|not granted/i.test(result.text);
    return { ok: code === 0 && !denied, code, denied, text: result.text };
  }

  /**
   * 照 Mika 的做法写安全设置：列表保留其他服务、缺口时摘掉再放回、最后打开总开关。
   * 没有写权限时（ColorOS 默认）返回 { ok:false, denied:true }，由调用方走界面自动化。
   */
  async function repairBySettings({ state, signal = null } = {}) {
    const steps = [];
    const current = state || (await readState({ signal }));
    if (!current.reachable) return { ok: false, denied: false, steps, reason: current.reason || 'adb-unreachable' };

    const wantRebind = current.crashed || (current.present && !current.bound);
    if (wantRebind && current.present) {
      const removed = await writeSetting(`settings put secure ${A11Y_LIST_KEY} '${listWithout(current.listRaw, component)}'`, { signal });
      steps.push({ name: 'a11y-remove', ok: removed.ok, denied: removed.denied, detail: firstLines(removed.text, 2) });
      if (!removed.ok) return { ok: false, denied: removed.denied, steps, reason: 'remove-failed' };
      await new Promise((resolve) => setTimeout(resolve, rebindGapMs));
    }
    const list = listWith(current.listRaw, component);
    const added = await writeSetting(`settings put secure ${A11Y_LIST_KEY} '${list}'`, { signal });
    steps.push({ name: 'a11y-list', ok: added.ok, denied: added.denied, detail: firstLines(added.text, 2) });
    if (!added.ok) return { ok: false, denied: added.denied, steps, reason: 'list-write-failed' };

    const enabled = await writeSetting(`settings put secure ${A11Y_ENABLED_KEY} 1`, { signal });
    steps.push({ name: 'a11y-master', ok: enabled.ok, denied: enabled.denied, detail: firstLines(enabled.text, 2) });
    if (!enabled.ok) return { ok: false, denied: enabled.denied, steps, reason: 'master-write-failed' };
    return { ok: true, denied: false, steps, reason: '' };
  }

  // -------------------------------------------------------------- 界面自动化

  async function dumpUi({ signal = null } = {}) {
    const result = await shell(
      `rm -f ${SCREENSHOT_DUMP_PATH} 2>/dev/null; uiautomator dump ${SCREENSHOT_DUMP_PATH} >/dev/null 2>&1; cat ${SCREENSHOT_DUMP_PATH} 2>/dev/null`,
      { signal, timeout: Math.max(timeoutMs, 30000) },
    );
    const xml = result.stdout && result.stdout.includes('<hierarchy') ? result.stdout : result.text;
    const nodes = parseUiDump(xml);
    return { xml, nodes, text: result.text };
  }

  async function tap(bounds, { signal = null } = {}) {
    if (!bounds) return false;
    await shell(`input tap ${bounds.cx} ${bounds.cy}`, { signal });
    return true;
  }

  async function wait(ms, { signal = null } = {}) {
    if (signal && signal.aborted) throw makeAbortError(signal);
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** 弹窗上点确认（停用/允许都算确认），返回点到的按钮文字。 */
  async function acceptDialog(nodes, labels, { signal = null } = {}) {
    const target = findTextNode(nodes, labels) || findContainsNode(nodes, labels);
    if (!target || !target.bounds) return '';
    if (!target.clickable) {
      // ColorOS 的弹窗按钮是 Button（clickable=true）；某些 ROM 上文字和按钮是两层，
      // 这里退一步点文字本身的坐标也能命中。
    }
    await tap(target.bounds, { signal });
    return nodeLabel(target);
  }

  /**
   * 在无障碍设置页里点开 Mika 那一行；必要时向下滚动找。
   * 返回 { ok, nodes }：nodes 是点开后的详情页节点。
   */
  async function openServicePage({ signal = null } = {}) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await shell(`am start -a ${SETTINGS_ACTIVITY_ACTION}`, { signal, timeout: Math.max(timeoutMs, 20000) });
      await wait(1200 + attempt * 600, { signal });
      let dump = await dumpUi({ signal });
      let row = findTextNode(dump.nodes, [appLabel]) || findContainsNode(dump.nodes, [appLabel]);
      if (!row) {
        // 列表没显示到 Mika：从下往上滚一屏再找。
        await shell('input swipe 540 1700 540 700 300', { signal });
        await wait(700, { signal });
        dump = await dumpUi({ signal });
        row = findTextNode(dump.nodes, [appLabel]) || findContainsNode(dump.nodes, [appLabel]);
      }
      if (!row) continue;
      await tap(row.bounds, { signal });
      await wait(1300, { signal });
      const detail = await dumpUi({ signal });
      if (primarySwitch(detail.nodes) || findTextNode(detail.nodes, ['简介', 'About', 'Description'])) {
        return { ok: true, nodes: detail.nodes, xml: detail.xml };
      }
    }
    return { ok: false, nodes: [], xml: '' };
  }

  /** 点主开关；若有确认弹窗就按要求点。返回 { tapped, dialog, nodes }。 */
  async function togglePrimarySwitch({ signal = null } = {}) {
    const before = await dumpUi({ signal });
    const switchNode = primarySwitch(before.nodes);
    if (!switchNode) return { tapped: false, dialog: '', nodes: before.nodes, checked: null };
    const checked = Boolean(switchNode.checked);
    await tap(switchNode.bounds, { signal });
    await wait(900, { signal });
    const after = await dumpUi({ signal });
    let dialog = '';
    if (findTextNode(after.nodes, CANCEL_LABELS) || findTextNode(after.nodes, STOP_LABELS)) {
      const stop = await acceptDialog(after.nodes, STOP_LABELS, { signal });
      if (stop) dialog = stop;
      await wait(900, { signal });
    } else if (findTextNode(after.nodes, CONFIRM_LABELS)) {
      const ok = await acceptDialog(after.nodes, CONFIRM_LABELS, { signal });
      if (ok) dialog = ok;
      await wait(900, { signal });
    }
    return { tapped: true, dialog, checked, nodes: after.nodes };
  }

  /**
   * 走系统设置界面把 Mika 的无障碍修好（adb 不能写安全设置时用）：
   * 打开 Mika 详情页 → 若当前是「开」先关掉（清掉系统的崩溃标记）→ 再打开 → 校验绑定。
   */
  async function repairByUi({ signal = null } = {}) {
    const steps = [];
    const page = await openServicePage({ signal });
    steps.push({ name: 'ui-open-page', ok: page.ok, detail: page.ok ? '已打开 Mika 无障碍详情页' : '没找到 Mika 那一行' });
    if (!page.ok) return { ok: false, steps, reason: 'service-row-not-found' };

    let state = await readState({ signal });
    const mustRebind = state.crashed || (state.present && !state.bound);
    const mainSwitch = primarySwitch(page.nodes);
    if (mainSwitch && mainSwitch.checked) {
      const off = await togglePrimarySwitch({ signal });
      steps.push({ name: 'ui-toggle-off', ok: off.tapped, detail: off.dialog ? `确认：${off.dialog}` : '已点主开关' });
      await wait(rebindGapMs, { signal });
      state = await readState({ signal });
    }
    if (!state.crashed && !mustRebind && state.enabled === '1' && state.bound) {
      steps.push({ name: 'ui-already-ok', ok: true, detail: '界面里已是开启且已绑定' });
      return { ok: true, steps, reason: '' };
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const on = await togglePrimarySwitch({ signal });
      steps.push({ name: `ui-toggle-on-${attempt + 1}`, ok: on.tapped, detail: on.dialog ? `确认：${on.dialog}` : '已点主开关' });
      if (!on.tapped) {
        // 详情页可能被弹窗顶掉，重新进一次。
        const again = await openServicePage({ signal });
        if (!again.ok) break;
        continue;
      }
      await wait(1500 + attempt * 800, { signal });
      state = await readState({ signal });
      if (state.enabled === '1' && state.bound && !state.crashed) {
        steps.push({ name: 'ui-verify', ok: true, detail: '总开关已开、服务已绑定' });
        return { ok: true, steps, reason: '' };
      }
      if (!state.crashed && state.enabled === '0') {
        // 还是关着的：再点一次（有的 ROM 上第一次点击只关弹窗）。
        continue;
      }
    }
    steps.push({ name: 'ui-verify', ok: false, detail: '界面操作后仍不满足「开 + 已绑定」' });
    return { ok: false, steps, reason: 'ui-repair-incomplete', state };
  }

  // -------------------------------------------------------------- 唤醒 / 拉起

  async function wake({ signal = null } = {}) {
    const steps = [];
    await shell('input keyevent 224', { signal, timeout: 10000 }); // KEYCODE_WAKEUP
    await shell('wm dismiss-keyguard', { signal, timeout: 10000 });
    await wait(500, { signal });
    const power = await shell("dumpsys power | grep -m1 'mWakefulness='", { signal, timeout: 15000 });
    const awake = /mWakefulness=(Awake|Dreaming)/.test(power.text);
    steps.push({ name: 'wake', ok: true, detail: awake ? '屏幕已唤醒' : '已发送唤醒按键（手机可能仍在休眠）' });
    return { steps, awake };
  }

  async function resolveLauncherActivity({ signal = null } = {}) {
    const result = await shell(`cmd package resolve-activity --brief ${packageName}`, { signal, timeout: 15000 });
    const lines = String(result.stdout || result.text)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const last = lines[lines.length - 1] || '';
    return /^[\w.]+\/[\w.$]+$/.test(last) ? last : '';
  }

  async function launchApp({ signal = null } = {}) {
    const steps = [];
    const launched = await shell(`monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`, { signal, timeout: 20000 });
    const launchOk = !/No activities found|monkey aborted|error/i.test(`${launched.stdout}${launched.stderr}`) && launched.code === 0;
    let activity = '';
    if (!launchOk) {
      activity = await resolveLauncherActivity({ signal });
      if (activity) await shell(`am start -n ${activity}`, { signal, timeout: 20000 });
    }
    steps.push({
      name: 'launch',
      ok: launchOk || Boolean(activity),
      detail: launchOk ? `已拉起 ${packageName}` : activity ? `am start -n ${activity}` : '拉起 Mika 失败',
    });
    return { steps, ok: launchOk || Boolean(activity), activity };
  }

  /** 电池白名单 + 尽量给 Mika 授予写安全设置（让 Mika 自己以后也能修）。 */
  async function applyStandingPermissions({ signal = null } = {}) {
    const steps = [];
    const whitelist = await shell('cmd deviceidle whitelist', { signal, timeout: 15000 });
    const listed = whitelist.text.split(/[\s,]+/).includes(packageName);
    if (!listed) {
      const add = await shell(`cmd deviceidle whitelist +${packageName}`, { signal, timeout: 15000 });
      steps.push({ name: 'battery-whitelist', ok: /Added|added/.test(add.text) || add.code === 0, detail: firstLines(add.text, 1) || '已加入电池白名单' });
    } else {
      steps.push({ name: 'battery-whitelist', ok: true, detail: '已在电池白名单' });
    }
    const grant = await shell(`pm grant ${packageName} android.permission.WRITE_SECURE_SETTINGS 2>&1; echo __exit=$?`, { signal, timeout: 15000 });
    const granted = /__exit=0/.test(grant.text);
    steps.push({
      name: 'grant-secure-settings',
      ok: granted,
      detail: granted ? '已授予 Mika 写安全设置权限（Mika 可自行修复）' : `系统不允许 adb 授权：${firstLines(grant.text, 2)}`,
    });
    return { steps, granted };
  }

  /** 无障碍这一路是否已经「能用」（与手机助手分开判，两者都过才算整机就绪）。 */
  function a11yReady(state) {
    return Boolean(state && state.reachable && state.enabled === '1' && state.present && !state.crashed && state.bound);
  }

  /**
   * 拉起手机助手——Mika 官方给「电脑用数据线连着手机」场景的兜底（见 HelperHandoff.kt）：
   * App 会把带 nonce 的 usb-start.sh 写进自己的外部文件目录，电脑侧用
   * `adb shell sh …/usb-start.sh` 就能以 shell 身份把 <pkg>:helper 拉起来。
   * 脚本输出三种文案，对应 starting / already running / did not start。
   */
  async function startHelper({ signal = null, attempts = 3 } = {}) {
    const steps = [];
    let lastText = '';
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const current = await readState({ signal });
      if (current.helperRunning) {
        steps.push({ name: 'helper', ok: true, detail: `手机助手已在运行 pid=${current.helperPid}` });
        return { ok: true, steps, attempts: attempt, state: current };
      }
      // 先让 Mika 在前台：脚本由 App 自己写出，nonce 只有 24 小时有效。
      const launched = await launchApp({ signal });
      if (launched.steps.length) steps.push({ ...launched.steps[0], name: `helper-launch-${attempt}` });
      await wait(1800 + attempt * 400, { signal });

      let scriptPresent = current.usbScriptPresent;
      if (!scriptPresent) {
        // 脚本不存在：冷启动一次 App，让它自己把 usb-start.sh 写出来。
        await shell(`am force-stop ${packageName}`, { signal, timeout: 15000 });
        await wait(800, { signal });
        await launchApp({ signal });
        await wait(3000, { signal });
        scriptPresent = (await readState({ signal })).usbScriptPresent;
      }
      if (!scriptPresent) {
        steps.push({ name: `helper-script-${attempt}`, ok: false, detail: `Mika 没有写出 ${usbScriptPath}` });
        continue;
      }

      const scriptRun = await shell(`sh ${usbScriptPath} 2>&1; echo __exit=$?`, {
        signal,
        timeout: Math.max(timeoutMs, 45000),
      });
      lastText = scriptRun.text;
      const verdict = classifyHelperOutput(scriptRun.text);
      steps.push({
        name: `helper-start-${attempt}`,
        ok: verdict !== 'failed',
        detail:
          verdict === 'running'
            ? '助手已在运行'
            : verdict === 'starting'
              ? '已发出启动指令'
              : firstLines(scriptRun.text, 2) || '助手没起来',
      });
      if (verdict === 'failed') {
        // 口令过期 / 脚本旧的：强制停掉再冷启动，让 App 重写脚本后重试。
        await shell(`am force-stop ${packageName}`, { signal, timeout: 15000 });
        await wait(1000, { signal });
        await launchApp({ signal });
        await wait(3000, { signal });
        continue;
      }
      await wait(2200 + attempt * 600, { signal });
      const after = await readState({ signal });
      if (after.helperRunning) {
        steps.push({ name: 'helper-verify', ok: true, detail: `手机助手已运行 pid=${after.helperPid}` });
        return { ok: true, steps, attempts: attempt, state: after };
      }
      steps.push({ name: `helper-verify-${attempt}`, ok: false, detail: '脚本跑完了但助手进程不在（可能被系统杀掉了）' });
    }
    steps.push({
      name: 'helper',
      ok: false,
      detail: `重试 ${attempts} 次仍未拉起手机助手：${firstLines(lastText, 2) || '脚本没有输出'}`,
    });
    return { ok: false, steps, attempts };
  }

  // -------------------------------------------------------------- 对外入口

  /**
   * 自检并（必要时）修复；返回 { ok, repaired, steps, report }。
   * 修复顺序照 Mika 自己的恢复语义：唤醒 → 常驻权限 → 无障碍 → 拉起 App → 手机助手 → 复验。
   * @param {object} [opt]
   * @param {AbortSignal} [opt.signal]
   * @param {boolean} [opt.force] 即使看起来正常也走一遍修复（用于「已经空了就直接修」的场合）
   * @param {Function} [opt.onStep] (step) => void 进度回调
   */
  async function ensure({ signal = null, force = false, onStep = null } = {}) {
    const emit = (step) => {
      const list = Array.isArray(step) ? step : [step];
      for (const item of list) {
        if (!item) continue;
        log(item.detail ? `${item.name}：${item.detail}` : String(item.name), item);
        if (onStep) {
          try {
            onStep(item);
          } catch {
            /* 进度回调失败不影响修复 */
          }
        }
      }
    };
    const steps = [];
    const add = (list) => {
      const items = (Array.isArray(list) ? list : [list]).filter(Boolean);
      steps.push(...items);
      emit(items);
    };

    const before = await readState({ signal });
    const initial = diagnoseState(before);
    if (initial.ok && !force) return { ok: true, repaired: false, steps, report: initial };
    if (!before.reachable) {
      add({ name: 'adb', ok: false, detail: `adb 不可用：${before.detail || before.reason}` });
      return { ok: false, repaired: false, steps, report: initial, reason: before.reason };
    }

    add((await wake({ signal })).steps);
    add((await applyStandingPermissions({ signal })).steps);

    let a11yFixed = a11yReady(before);
    if (!a11yFixed || force) {
      const direct = await repairBySettings({ state: before, signal });
      add(direct.steps);
      let state = await readState({ signal });
      if (!a11yReady(state) && (direct.denied || force)) {
        log('adb 没有写安全设置的权限，改走系统设置界面自动化');
        add((await repairByUi({ signal })).steps);
        state = await readState({ signal });
      }
      a11yFixed = a11yReady(state);
    }

    // App + 手机助手：Mika 要操作 App 必须先有 shell 助手（USB 模式就靠 usb-start.sh 拉起来）。
    add((await launchApp({ signal })).steps);
    await wait(1500, { signal });
    const afterLaunch = await readState({ signal });
    let helperOk = Boolean(afterLaunch.helperRunning);
    if (!helperOk || force) {
      const helper = await startHelper({ signal });
      add(helper.steps);
      helperOk = Boolean(helper.ok);
    }

    await wait(800, { signal });
    const report = await diagnose({ signal });
    return { ok: report.ok, repaired: report.ok && !initial.ok, steps, report, a11yFixed, helperOk };
  }

  return {
    adb,
    serial,
    packageName,
    component,
    appLabel,
    helperName,
    usbScriptPath,
    connectScriptPath,
    shell,
    readState,
    diagnose,
    diagnoseState,
    ensure,
    repairBySettings,
    repairByUi,
    startHelper,
    a11yReady,
    wake,
    launchApp,
    applyStandingPermissions,
  };
}

module.exports = {
  DEFAULT_PACKAGE,
  DEFAULT_APP_LABEL,
  DEFAULT_SERVICE_CLASS,
  SETTINGS_ACTIVITY_ACTION,
  USB_START_SCRIPT,
  CONNECT_SCRIPT,
  HELPER_SUFFIX,
  createMikaRecovery,
  describeChecks,
  classifyHelperOutput,
  takeSection,
  expandComponent,
  accessibilityEntries,
  listContains,
  listWith,
  listWithout,
  parseA11yDump,
  parseUiDump,
  parseBounds,
  primarySwitch,
  runProcess,
};
