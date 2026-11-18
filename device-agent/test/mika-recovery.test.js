'use strict';

/**
 * 手机自愈（Mika 无障碍 + 手机助手）的单元测试。
 *
 * 这里不碰真机：用一个内存里的「假手机」实现 adb 的行为——
 * 探测命令按段返回、写安全设置按 ColorOS 默认拒绝、usb-start.sh 三态、
 * 无障碍设置页用一个极小的 UI 状态机（列表 → 详情 → 确认弹窗）+ uiautomator XML，
 * 让 repairByUi 走完整条「点开 → 关掉 → 再打开」的路径。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const recovery = require('../lib/mika-recovery.js');

const PKG = 'com.wangzan101.mika';
const COMPONENT = 'com.wangzan101.mika/com.wangzan101.mika.a11y.MikaAccessibilityService';
const SWITCH_BOUNDS = '[900,325][1008,391]';
const ROW_BOUNDS = '[72,1585][948,1780]';

function syncState(state) {
  const listed = recovery.listContains(state.list, COMPONENT);
  const crashed = Boolean(state.crashed);
  const enabled = state.enabled === '1';
  state.bound = listed && enabled && !crashed;
  if (!listed) state.crashed = false;
  state.switchChecked = listed && enabled;
}

function dumpsys(state) {
  const bound = state.bound ? 'Service[label=Mika, feedbackType[FEEDBACK_GENERIC], capabilities=161]' : '';
  const enabled = state.list ? `{{${recovery.expandComponent(state.list)}}}` : '{}';
  const crashed = state.crashed ? `{{${recovery.expandComponent(COMPONENT)}}}` : '{}';
  return [
    'User state[',
    '  mCurrentUserId: 0',
    `  Bound services:{${bound}}`,
    `  Enabled services:${enabled}`,
    '  Binding services:{}',
    `  Crashed services:${crashed}`,
    ']',
  ].join('\n');
}

function probeText(state) {
  return [
    '__enabled__',
    state.enabled,
    '__list__',
    state.list ? state.list : 'null',
    '__wifi__',
    state.adbWifi,
    '__boot__',
    String(state.boot),
    '__app__',
    state.appPid ? String(state.appPid) : '',
    '__helper__',
    state.helperPid ? String(state.helperPid) : '',
    '__script__',
    state.usbScript ? 'usb-yes' : 'usb-no',
    state.connectScript ? 'connect-yes' : 'connect-no',
    '__dump__',
    dumpsys(state),
  ].join('\n');
}

function uiListXml() {
  return (
    '<?xml version=\'1.0\' encoding=\'UTF-8\' standalone=\'yes\' ?><hierarchy rotation="0">' +
    `<node index="0" text="" class="android.widget.FrameLayout" package="com.android.settings" clickable="false" bounds="[0,0][1080,2400]">` +
    `<node index="1" text="Mika" class="android.widget.TextView" package="com.android.settings" clickable="true" bounds="${ROW_BOUNDS}" />` +
    '</node></hierarchy>'
  );
}

function uiDetailXml(state) {
  return (
    '<?xml version=\'1.0\' encoding=\'UTF-8\' standalone=\'yes\' ?><hierarchy rotation="0">' +
    '<node index="0" text="" class="android.widget.FrameLayout" package="com.android.settings" clickable="false" bounds="[0,0][1080,2400]">' +
    '<node index="1" text="Mika" class="android.widget.TextView" package="com.android.settings" bounds="[72,240][560,300]" />' +
    `<node index="2" text="开启" class="android.widget.Switch" package="com.android.settings" checkable="true" checked="${state.switchChecked}" clickable="true" bounds="${SWITCH_BOUNDS}" />` +
    '</node></hierarchy>'
  );
}

function uiDialogXml() {
  return (
    '<?xml version=\'1.0\' encoding=\'UTF-8\' standalone=\'yes\' ?><hierarchy rotation="0">' +
    '<node index="0" text="" class="android.widget.FrameLayout" package="com.android.settings" clickable="false" bounds="[0,0][1080,2400]">' +
    '<node index="1" text="要停用“Mika”吗？" class="android.widget.TextView" package="com.android.settings" bounds="[60,900][1020,1000]" />' +
    '<node index="2" text="取消" class="android.widget.Button" package="com.android.settings" clickable="true" bounds="[60,1222][539,1390]" />' +
    '<node index="3" text="停止" class="android.widget.Button" package="com.android.settings" clickable="true" bounds="[541,1222][1020,1390]" />' +
    '</node></hierarchy>'
  );
}

/** 假手机：状态 + adb 命令解释器（注入给 createMikaRecovery 的 run）。 */
function fakePhone(initial = {}) {
  const state = {
    enabled: '1',
    list: COMPONENT,
    crashed: false,
    bound: true,
    adbWifi: '0',
    boot: 175,
    appPid: 18269,
    helperPid: 5298,
    usbScript: true,
    connectScript: true,
    writeSettings: 'denied',
    screen: 'list',
    switchChecked: true,
    ...initial,
  };
  syncState(state);
  const commands = [];

  const inside = (bounds, x, y) => {
    const box = recovery.parseBounds(bounds);
    return Boolean(box) && x >= box.x1 && x <= box.x2 && y >= box.y1 && y <= box.y2;
  };

  const tap = (x, y) => {
    if (state.screen === 'list' && inside(ROW_BOUNDS, x, y)) {
      state.screen = 'detail';
      return;
    }
    if (state.screen === 'dialog') {
      if (inside('[60,1222][539,1390]', x, y)) {
        state.screen = 'detail';
        return;
      }
      if (inside('[541,1222][1020,1390]', x, y)) {
        state.switchChecked = false;
        state.enabled = '0';
        state.list = '';
        state.crashed = false;
        syncState(state);
        state.screen = 'detail';
        return;
      }
    }
    if (state.screen === 'detail' && inside(SWITCH_BOUNDS, x, y)) {
      if (state.switchChecked) {
        state.screen = 'dialog';
        return;
      }
      state.switchChecked = true;
      state.enabled = '1';
      state.list = COMPONENT;
      state.crashed = false;
      syncState(state);
    }
  };

  const writeSettingsResponse = (apply) => {
    if (state.writeSettings !== 'allowed') {
      return {
        code: 0,
        stdout: 'java.lang.SecurityException: Permission denial: writing to settings requires:android.permission.WRITE_SECURE_SETTINGS\n__exit=1',
        stderr: '',
      };
    }
    apply();
    return { code: 0, stdout: '__exit=0', stderr: '' };
  };

  async function run(exe, args) {
    const command = String(args[args.length - 1] || '');
    commands.push(command);

    if (command.includes('__enabled__')) {
      return { code: 0, stdout: probeText(state), stderr: '' };
    }
    if (/^input keyevent|^wm dismiss-keyguard/.test(command)) {
      state.awake = true;
      return { code: 0, stdout: '', stderr: '' };
    }
    if (command.includes('mWakefulness=')) {
      return { code: 0, stdout: '  mWakefulness=Awake', stderr: '' };
    }
    if (command === 'cmd deviceidle whitelist') {
      return { code: 0, stdout: 'system,com.android.shell', stderr: '' };
    }
    if (command.startsWith('cmd deviceidle whitelist +')) {
      return { code: 0, stdout: `Added: ${command.slice('cmd deviceidle whitelist +'.length)}`, stderr: '' };
    }
    if (command.startsWith('pm grant ')) {
      return {
        code: 0,
        stdout: 'java.lang.SecurityException: grantRuntimePermission: Neither user 2000 nor current process has android.permission.GRANT_RUNTIME_PERMISSIONS.\n__exit=1',
        stderr: '',
      };
    }
    if (command.startsWith('settings put secure enabled_accessibility_services ')) {
      const match = /enabled_accessibility_services '(.*)' 2>&1/.exec(command);
      const list = match ? match[1] : '';
      return writeSettingsResponse(() => {
        state.list = list;
        state.crashed = false;
        syncState(state);
      });
    }
    if (command.startsWith('settings put secure accessibility_enabled ')) {
      const value = command.split(' ')[4];
      return writeSettingsResponse(() => {
        state.enabled = value;
        syncState(state);
      });
    }
    if (command.includes('uiautomator dump')) {
      const xml = state.screen === 'list' ? uiListXml() : state.screen === 'dialog' ? uiDialogXml() : uiDetailXml(state);
      return { code: 0, stdout: xml, stderr: '' };
    }
    if (command.startsWith('input tap ')) {
      const [, , x, y] = command.split(' ');
      tap(Number(x), Number(y));
      return { code: 0, stdout: '', stderr: '' };
    }
    if (command.startsWith('input swipe ')) {
      return { code: 0, stdout: '', stderr: '' };
    }
    if (command.startsWith('am start -a android.settings.ACCESSIBILITY_SETTINGS')) {
      state.screen = 'list';
      return { code: 0, stdout: 'Starting: Intent { act=android.settings.ACCESSIBILITY_SETTINGS }', stderr: '' };
    }
    if (command.startsWith('am start -n ')) {
      state.appPid = state.appPid || 18269;
      return { code: 0, stdout: 'Starting: Intent', stderr: '' };
    }
    if (command.startsWith('am force-stop ')) {
      state.appPid = 0;
      return { code: 0, stdout: '', stderr: '' };
    }
    if (command.startsWith('monkey ')) {
      state.appPid = state.appPid || 18269;
      return { code: 0, stdout: 'Events injected: 1', stderr: '' };
    }
    if (command.includes('cmd package resolve-activity')) {
      return { code: 0, stdout: `${PKG}/.ui.MainActivity`, stderr: '' };
    }
    if (command.includes('usb-start.sh')) {
      if (!state.usbScript) {
        return { code: 0, stdout: "sh: /sdcard/Android/data/com.wangzan101.mika/files/usb-start.sh: No such file or directory\n__exit=1", stderr: '' };
      }
      if (state.helperPid) {
        return { code: 0, stdout: 'Mika helper already running. Nothing to do.\n__exit=0', stderr: '' };
      }
      state.helperPid = 4526;
      return {
        code: 0,
        stdout:
          'Mika helper starting... Open Mika to confirm phone control is ready.\nOn most phones it keeps running after you unplug the cable.\n__exit=0',
        stderr: '',
      };
    }
    return { code: 0, stdout: '', stderr: '' };
  }

  return { state, commands, run };
}

function buildRecovery(phone, overrides = {}) {
  return recovery.createMikaRecovery({
    adb: 'adb-fake',
    packageName: PKG,
    rebindGapMs: 0,
    run: phone.run,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test('无障碍列表归一化：短形式与全名是同一个组件', () => {
  const short = `${PKG}/.a11y.MikaAccessibilityService`;
  assert.equal(recovery.expandComponent(short), COMPONENT);
  assert.equal(recovery.listContains(short, COMPONENT), true);
  assert.equal(recovery.listContains('', COMPONENT), false);
  assert.equal(recovery.listWith('com.other/.Svc', COMPONENT), `com.other/.Svc:${COMPONENT}`);
  assert.equal(recovery.listWithout(`com.other/.Svc:${COMPONENT}`, COMPONENT), 'com.other/.Svc');
  assert.deepEqual(recovery.accessibilityEntries('null'), []);
});

test('classifyHelperOutput 对应 usb-start.sh 的三种文案', () => {
  assert.equal(recovery.classifyHelperOutput('Mika helper starting... Open Mika to confirm phone control is ready.'), 'starting');
  assert.equal(recovery.classifyHelperOutput('Mika helper already running. Nothing to do.'), 'running');
  assert.equal(recovery.classifyHelperOutput('Mika helper did not start. Open Mika once, then run this command again.'), 'failed');
  assert.equal(recovery.classifyHelperOutput('__exit=0'), 'starting');
});

test('readState 一次 adb 往返拿全状态（无障碍 / 助手 / 脚本 / 开机计数）', async () => {
  const phone = fakePhone();
  const heal = buildRecovery(phone);
  const state = await heal.readState();
  assert.equal(state.reachable, true);
  assert.equal(state.enabled, '1');
  assert.equal(state.present, true);
  assert.equal(state.crashed, false);
  assert.equal(state.bound, true);
  assert.equal(state.helperRunning, true);
  assert.equal(state.helperPid, 5298);
  assert.equal(state.appPid, 18269);
  assert.equal(state.usbScriptPresent, true);
  assert.equal(state.connectScriptPresent, true);
  assert.equal(state.bootId, 175);
  assert.equal(state.adbWifi, false);
  const report = heal.diagnoseState(state);
  assert.equal(report.ok, true);
  assert.deepEqual(report.problems, []);
  assert.match(report.summary, /无障碍正常/);
});

test('describeChecks 把「助手没跑」和「服务崩溃」都报成故障项', async () => {
  const phone = fakePhone({ helperPid: 0, crashed: true });
  const heal = buildRecovery(phone);
  const state = await heal.readState();
  const report = heal.diagnoseState(state);
  assert.equal(report.ok, false);
  assert.ok(report.problems.includes('helper-not-running'));
  assert.ok(report.problems.includes('service-crashed'));
  const wireless = report.checks.find((item) => item.id === 'wireless-debugging-off');
  assert.ok(wireless && wireless.info, '无线调试关只作参考项，不算故障');
});

// ---------------------------------------------------------------------------
// ensure：自检 + 自愈
// ---------------------------------------------------------------------------

test('ensure：手机本来就正常时不动手机', async () => {
  const phone = fakePhone();
  const heal = buildRecovery(phone);
  const result = await heal.ensure();
  assert.equal(result.ok, true);
  assert.equal(result.repaired, false);
  assert.deepEqual(result.steps, []);
  assert.equal(phone.commands.length, 1, '健康时只做一次探测，不执行任何修复命令');
});

test('ensure：手机助手没跑 → 用 usb-start.sh 拉起来', async () => {
  const phone = fakePhone({ helperPid: 0, adbWifi: '0' });
  const heal = buildRecovery(phone);
  const names = [];
  const result = await heal.ensure({ onStep: (step) => names.push(step.name) });
  assert.equal(result.ok, true, `期望修好，实际 problems=${result.report.problems}`);
  assert.equal(result.repaired, true);
  assert.equal(phone.state.helperPid, 4526);
  assert.ok(phone.commands.some((cmd) => cmd.includes('usb-start.sh')), '应该跑过 usb-start.sh');
  assert.ok(names.includes('helper-start-1'), `步骤里应有 helper-start-1：${names.join(',')}`);
  assert.ok(names.includes('helper-verify'), `步骤里应有 helper-verify：${names.join(',')}`);
});

test('ensure：ColorOS 不让写安全设置 → 走设置界面自动化把无障碍修回来', async () => {
  const phone = fakePhone({ enabled: '0', list: '', crashed: false, bound: false, switchChecked: false });
  phone.state.writeSettings = 'denied';
  const heal = buildRecovery(phone);
  const names = [];
  const steps = [];
  const result = await heal.ensure({ onStep: (step) => {
    names.push(step.name);
    steps.push(step);
  } });
  assert.equal(result.ok, true, `期望修好，实际 problems=${result.report.problems}`);
  assert.equal(result.repaired, true);
  assert.equal(phone.state.enabled, '1');
  assert.equal(phone.state.bound, true);
  assert.ok(names.includes('ui-open-page'), `步骤里应有 ui-open-page：${names.join(',')}`);
  assert.ok(names.some((name) => name.startsWith('ui-toggle-on')), `步骤里应有 ui-toggle-on：${names.join(',')}`);
  assert.ok(steps.some((step) => step.name === 'a11y-list' && step.denied), '应该记录到写设置被系统拒绝');
});

test('ensure：adb 没有写设置权限但系统有 → 直接写设置，不走界面', async () => {
  const phone = fakePhone({ enabled: '0', list: COMPONENT, crashed: true, bound: false });
  phone.state.writeSettings = 'allowed';
  const heal = buildRecovery(phone);
  const names = [];
  const result = await heal.ensure({ onStep: (step) => names.push(step.name) });
  assert.equal(result.ok, true, `期望修好，实际 problems=${result.report.problems}`);
  assert.equal(phone.state.enabled, '1');
  assert.equal(phone.state.crashed, false);
  assert.equal(phone.state.bound, true);
  assert.ok(names.includes('a11y-remove'), `崩溃的服务应该先摘掉：${names.join(',')}`);
  assert.ok(names.includes('a11y-list'));
  assert.ok(!names.includes('ui-open-page'), '能直接写设置就不必走界面');
});

test('ensure：adb 不可用时报清楚原因，不假装修好', async () => {
  const heal = recovery.createMikaRecovery({
    adb: 'adb-fake',
    run: async () => ({ code: 1, stdout: '', stderr: 'adb: no devices/emulators found' }),
  });
  const result = await heal.ensure();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'adb-no-device');
  assert.match(result.steps[0].detail, /adb 不可用/);
});
