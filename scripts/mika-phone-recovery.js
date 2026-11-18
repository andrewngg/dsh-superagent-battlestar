#!/usr/bin/env node
'use strict';

/**
 * 手机 Mika 操作失效时的自愈命令行（走 USB ADB）。
 *
 * 用法：
 *   node scripts/mika-phone-recovery.js --check      # 只读自检（默认）
 *   node scripts/mika-phone-recovery.js --repair     # 自检 + 修复 + 校验
 *   node scripts/mika-phone-recovery.js --repair --json --serial <SERIAL>
 *
 * 退出码：0 = 健康 / 修复后验收通过；2 = 异常或修复后仍未就绪；1 = 参数错误。
 *
 * 该命令与 device-agent 派发 Mika 任务时用的是同一份实现
 * （device-agent/lib/mika-recovery.js），所以手工排查与自动自愈的行为一致。
 * 文档：docs/PHONE-RECOVERY.md
 */

const path = require('node:path');

const recoveryLib = require(path.join(__dirname, '..', 'device-agent', 'lib', 'mika-recovery.js'));

const args = process.argv.slice(2);

function has(flag) {
  return args.includes(`--${flag}`);
}

function valueOf(flag, fallback = '') {
  const index = args.indexOf(`--${flag}`);
  if (index < 0) return fallback;
  const next = args[index + 1];
  return next && !next.startsWith('--') ? next : fallback;
}

if (has('help') || has('h')) {
  process.stdout.write(
    [
      '用法：node scripts/mika-phone-recovery.js [--check|--repair] [选项]',
      '',
      '  --check                  只读自检（默认）',
      '  --repair                 自检并修复，最后再校验一遍',
      '  --force                  即使自检通过也走一遍修复（用于明确要重启无障碍/手机助手）',
      '  --adb <path>             adb 可执行文件，默认取环境变量 MIKA_ADB 或 PATH 里的 adb',
      '  --serial <serial>        手机序列号，默认取环境变量 MIKA_PHONE_SERIAL',
      '  --package <name>         Mika 包名，默认 com.wangzan101.mika',
      '  --label <text>           手机无障碍列表里的 App 名，默认 Mika',
      '  --timeout <秒>           单条 adb 命令超时，默认 20',
      '  --json                   输出 JSON 结果',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

const repair = has('repair');
const force = has('force');
const asJson = has('json');
const timeoutSec = Number(valueOf('timeout', '20'));

if (has('check') && repair) {
  process.stderr.write('参数错误：--check 与 --repair 只能指定一个。\n');
  process.exit(1);
}
if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
  process.stderr.write('参数错误：--timeout 必须是大于 0 的秒数。\n');
  process.exit(1);
}

const adb = valueOf('adb', process.env.MIKA_ADB || 'adb');
const serial = valueOf('serial', process.env.MIKA_PHONE_SERIAL || '');
const packageName = valueOf('package', recoveryLib.DEFAULT_PACKAGE);
const appLabel = valueOf('label', recoveryLib.DEFAULT_APP_LABEL);

function say(line = '') {
  if (!asJson) process.stdout.write(`${line}\n`);
}

function printChecks(state) {
  for (const item of recoveryLib.describeChecks(state, { appLabel })) {
    const ok = item.ok || Boolean(item.info);
    const detail = item.info ? `${item.detail}（参考项）` : item.detail;
    say(`${ok ? '[ OK ]' : '[FAIL]'} ${item.name}：${detail}`);
  }
}

async function main() {
  const recovery = recoveryLib.createMikaRecovery({
    adb,
    serial,
    packageName,
    appLabel,
    timeoutMs: timeoutSec * 1000,
    log: (message) => say(`    · ${message}`),
  });

  say('手机 Mika 操作自检');
  say(`    adb：${adb}`);
  say(`    设备：${serial || '（未指定，使用唯一在线设备）'}`);
  say(`    Mika 包名：${packageName}（无障碍组件 ${recovery.component}）`);
  say(`    手机助手：${recovery.helperName}`);
  say('');

  const started = await recovery.readState({ signal: null });
  printChecks(started);
  const initial = recovery.diagnoseState(started);
  say('');
  say(initial.ok ? '结论：手机控制正常（无障碍已绑定、手机助手在运行），Mika 可以操作 App。' : `结论：手机控制异常（${initial.problems.join(', ')}）。`);

  if (!repair) {
    if (asJson) process.stdout.write(`${JSON.stringify({ ok: initial.ok, mode: 'check', problems: initial.problems, state: started }, null, 2)}\n`);
    process.exit(initial.ok ? 0 : 2);
  }

  if (initial.ok && !force) {
    if (asJson) process.stdout.write(`${JSON.stringify({ ok: true, mode: 'repair', repaired: false, state: started }, null, 2)}\n`);
    process.exit(0);
  }

  say('');
  say('开始修复（唤醒屏幕 → 电池白名单/授权 → 修无障碍 → 拉起 Mika → 拉起手机助手 → 校验）');
  const result = await recovery.ensure({ force });
  say('');
  for (const step of result.steps) {
    say(`${step.ok ? '[ OK ]' : '[FAIL]'} ${step.name}：${step.detail || ''}`);
  }
  say('');
  const after = result.report.state;
  printChecks(after);
  say('');
  say(result.ok ? '结论：修复完成，无障碍已绑定、手机助手在运行，Mika 可以继续操作 App。' : `结论：修复未完成（${result.report.problems.join(', ')}）。`);
  if (asJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: result.ok,
          mode: 'repair',
          repaired: result.repaired,
          a11yFixed: result.a11yFixed,
          helperOk: result.helperOk,
          steps: result.steps,
          problems: result.report.problems,
          state: after,
        },
        null,
        2,
      )}\n`,
    );
  }
  process.exit(result.ok ? 0 : 2);
}

main().catch((err) => {
  process.stderr.write(`自愈命令异常：${err && err.stack ? err.stack : err}\n`);
  process.exit(2);
});
