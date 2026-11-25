'use strict';

/**
 * 指令主机识别：判断一条任务指令是不是「电脑侧操作」。
 *
 * 背景：手机（Mika）只能执行手机 App 上的操作，不能跑 python/adb/Windows 脚本。
 * 大脑曾把「执行 python applier.py --help」「adb devices」这类诊断/准备工作派给
 * Mika 手机，导致任务必然失败。Hub 创建任务时用这里的判定兜底：电脑侧指令一律
 * 不派给手机设备，改派母机（本机）。
 */

/** 按优先级排列的电脑侧特征：[正则, 事件里展示的原因] */
const PC_ONLY_MARKERS = [
  [/[A-Za-z]:\\/, 'Windows 路径'],
  [/\badb(?:\.exe)?\b/i, 'adb 命令'],
  [/(?<![A-Za-z])python(?![A-Za-z])/i, 'python 命令'],
  [/\badb(?:\.exe)?\s+(?:devices|shell|push|pull|connect|disconnect|start-server|kill-server|install|uninstall|logcat|forward|reverse|wait-for-device|tcpip|reboot|get-state)\b/i, 'adb 命令'],
  [/\bpython(?:3(?:\.\d+)?)?\s+(?:-c\b|--version\b|-V\b|[^\s]+\.py\b)/i, 'python 命令'],
  [/\bpy\s+-3\s+/i, 'python 命令'],
  [/[^\s"'`]+\.py\b/i, '.py 脚本'],
  [/\bpowershell(?:\.exe)?\b/i, 'PowerShell'],
  [/\bcmd(?:\.exe)?\s+\/c\b/i, 'cmd 命令'],
  [/\bnode(?:\.exe)?\s+[^\s]*(?:scripts?|device-agent|hub)[\\/]/i, 'node 脚本'],
  [/\.(?:exe|ps1|bat|cmd)\b/i, '可执行脚本'],
  [/(?:在|由|用|让|到)?母机[^。；;！!\n]{0,24}?(?:执行|运行|跑|检查|处理|修复|完成)/, '母机侧操作'],
];

/**
 * 判断指令是否只能在电脑/母机上执行。
 * @param {string} instruction
 * @returns {boolean}
 */
function looksLikePcOnlyInstruction(instruction) {
  return pcOnlyReason(instruction) !== null;
}

/**
 * 返回命中的电脑侧特征（用于事件说明），未命中返回 null。
 * @param {string} instruction
 * @returns {string|null}
 */
function pcOnlyReason(instruction) {
  const text = String(instruction || '');
  if (!text.trim()) return null;
  for (const [pattern, reason] of PC_ONLY_MARKERS) {
    if (pattern.test(text)) return reason;
  }
  return null;
}

module.exports = {
  PC_ONLY_MARKERS,
  looksLikePcOnlyInstruction,
  pcOnlyReason,
};
