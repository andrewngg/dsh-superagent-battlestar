'use strict';

/**
 * 长任务规划器：调用 Agnes AI，把一条复杂任务拆成可独立执行的子任务。
 * 只使用 Node 内置 fetch；密钥从环境变量读取，不写入日志/状态。
 */

class PlannerError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'PlannerError';
    this.details = details;
  }
}

function plannerConfig(overrides = {}) {
  const env = overrides.env || process.env;
  return {
    apiKey: overrides.apiKey || env.AGNES_API_KEY || env.BUTLER_AGNES_API_KEY || '',
    baseUrl: (overrides.baseUrl || env.AGNES_BASE_URL || 'https://apihub.agnes-ai.com/v1').replace(/\/+$/, ''),
    model: overrides.model || env.AGNES_MODEL || 'agnes-2.5-flash',
    timeoutMs: Number.isFinite(overrides.timeoutMs) ? overrides.timeoutMs : 60_000,
    maxSubtasks: Number.isFinite(overrides.maxSubtasks) ? overrides.maxSubtasks : 6,
  };
}

function extractJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function buildPrompt(instruction, requirements, maxSubtasks, parentTimeoutSec, devices) {
  const req = requirements && typeof requirements === 'object' ? requirements : {};
  const list = Array.isArray(devices) ? devices.filter((device) => device && device.id) : [];
  const lines = [
    '你是 BattleStar 长任务规划器。把用户的一条长任务拆成 2-' + maxSubtasks + ' 个可独立执行的子任务，并为它们安排执行顺序。',
    '先判断依赖关系，再决定哪些子任务可以并行、哪些必须按顺序执行：',
    '1. 互不依赖、可以同时进行的子任务放进同一个并行组（execution.groups 里 mode=parallel，组内 subtaskIndexes 列出），它们会在不同工作机上同时执行；',
    '2. 必须先后执行的子任务用 dependsOn 指向前面的子任务序号（从 0 开始，只能指向更靠前的子任务，不能有环）；被依赖的子任务完成后，依赖它的子任务才排队执行；',
    '3. 顺序执行时遇到卡点（缺少信息、需要登录/授权、需要用户确认、失败原因不明确），子任务指令必须明确要求：停下来说明卡点位置和需要确认什么，等待用户确认后再继续，不要自行假设后跳过；Hub 会暂停所有依赖它的后续子任务；',
    '4. 工作机的并发受清单里 maxConcurrentTasks 限制（「手机 Mika」等手机工作机为 1，同一时间只能执行 1 个任务）：需要 Mika 的子任务超过 2 个时，用 dependsOn 串成队列依次执行，不要放进同一个并行组；',
    '5. 视频/图片生成任务要拆成明确的镜头、素材准备、生成、合成/导出步骤；',
    '6. 每个子任务给出合理的 timeoutSec（30-3600 秒）；',
    '7. 网页检索/多平台搜索/登录后操作类子任务要留足时间，建议 600-1800 秒，不要低于 300 秒；',
    '8. 每个子任务指令必须自包含、可单独交给一台工作机执行：写明项目/文件/目录的绝对路径或明确名称，禁止使用「这里」「上述」「刚才」「该项目」「之前的对话」等指代；必要时把用户原任务的关键背景（目标、路径、约束）复述进子任务指令，确保工作机只看子任务也能理解要做什么；',
    '9. 只输出严格 JSON，不要 Markdown、解释或代码块。',
  ];
  if (list.length) {
    lines.push('10. 如果某个子任务必须在本机（Hub 宿主）的文件/环境上执行（例如修改本机代码、读取本机文件），给该子任务 deviceId 填标记为「本机」的设备；');
    lines.push('11. tags 只能从工作机清单里的 tags 选取（用于需要特定能力的任务，如 ComfyUI/GPU、手机 Mika）；不需要时不要输出 tags；');
    lines.push('12. deviceId 必须来自工作机清单；不需要指定设备时不要输出 deviceId，由 Hub 自动路由。');
  }
  lines.push('JSON 格式：');
  lines.push('{"title":"简短标题","execution":{"strategy":"parallel|sequential|mixed","groups":[{"name":"并行组名","mode":"parallel","subtaskIndexes":[0,1]}],"blockerPolicy":"stop-and-ask"},"subtasks":[{"instruction":"完整可执行的子任务指令","timeoutSec":300,"deviceId":"可选，必须来自清单","tags":["可选，必须来自清单"],"dependsOn":[可选，前面子任务序号],"parallelGroup":"可选，并行组名"}]}');
  if (list.length) {
    lines.push('可用工作机清单（deviceId 只能取这里的值）：');
    for (const device of list.slice(0, 20)) {
      const bits = [
        `id=${device.id}`,
        device.nickname ? `用途昵称=${device.nickname}` : '',
        device.name ? `机器名=${device.name}` : '',
        device.platform ? `平台=${device.platform}` : '',
        device.online === false ? '离线' : '在线',
        device.local ? '本机（Hub 宿主）' : '',
      ].filter(Boolean);
      if (Array.isArray(device.tags) && device.tags.length) bits.push(`tags=${device.tags.join(',')}`);
      if (Number.isFinite(Number(device.maxConcurrentTasks))) {
        bits.push(`并发上限=${Math.max(1, Math.trunc(Number(device.maxConcurrentTasks)))}`);
      }
      if (Array.isArray(device.skills) && device.skills.length) bits.push(`skills=${device.skills.join(',')}`);
      if (Array.isArray(device.models) && device.models.length) bits.push(`models=${device.models.join(',')}`);
      lines.push('- ' + bits.join(' | '));
    }
  }
  lines.push('原任务要求（可能为空）：' + JSON.stringify(req));
  if (Number.isFinite(Number(parentTimeoutSec)) && Number(parentTimeoutSec) > 0) {
    lines.push(`父任务超时预算：${Math.round(Number(parentTimeoutSec))} 秒；子任务 timeoutSec 不要超过该预算。`);
  }
  lines.push('用户原任务：', String(instruction || ''));
  return lines.join('\n');
}

/** 归一化 dependsOn/subtaskIndexes：只保留 0..maxExclusive-1 的整数，去重、升序、限量。 */
function normalizeIndexes(raw, maxExclusive) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const n = Math.trunc(Number(item));
    if (!Number.isInteger(n) || n < 0 || n >= maxExclusive || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= 10) break;
  }
  return out.sort((a, b) => a - b);
}

/**
 * 归一化执行计划：strategy 只接受 parallel/sequential/mixed；groups 里的下标必须落在子任务范围内；
 * blockerPolicy 默认 stop-and-ask（顺序执行遇到卡点时停下等待用户确认）。
 */
function normalizeExecution(raw, subtasks) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const hasDeps = subtasks.some((item) => item.dependsOn.length > 0);
  const rawStrategy = typeof input.strategy === 'string' ? input.strategy.trim().toLowerCase() : '';
  const strategy = ['parallel', 'sequential', 'mixed'].includes(rawStrategy)
    ? rawStrategy
    : hasDeps
      ? 'sequential'
      : 'parallel';
  const groups = [];
  for (const group of Array.isArray(input.groups) ? input.groups : []) {
    if (!group || typeof group !== 'object') continue;
    const name = typeof group.name === 'string' ? group.name.trim().slice(0, 40) : '';
    const indexes = normalizeIndexes(group.subtaskIndexes, subtasks.length);
    if (!name && !indexes.length) continue;
    groups.push({
      name: name || `并行组 ${groups.length + 1}`,
      mode: group.mode === 'sequential' ? 'sequential' : 'parallel',
      subtaskIndexes: indexes,
    });
    if (groups.length >= 6) break;
  }
  return {
    strategy,
    groups,
    blockerPolicy: input.blockerPolicy === 'continue' ? 'continue' : 'stop-and-ask',
  };
}

/**
 * @returns {Promise<{title:string, execution:{strategy:string,groups:Array,blockerPolicy:string}, subtasks:Array<{instruction:string, timeoutSec:number, deviceId:string, tags:string[], dependsOn:number[], parallelGroup:string}>}>}
 */
async function createPlan(options = {}) {
  const cfg = plannerConfig(options);
  if (!cfg.apiKey) throw new PlannerError('未配置 AGNES_API_KEY，无法拆分长任务');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new PlannerError('当前 Node 不支持 fetch');
  const instruction = String(options.instruction || '').trim();
  if (!instruction) throw new PlannerError('任务指令为空');
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: '你是严格输出 JSON 的任务规划器。' },
      { role: 'user', content: buildPrompt(instruction, options.requirements, cfg.maxSubtasks, options.timeoutSec, options.devices) },
    ],
    temperature: 0.2,
    max_tokens: 3000,
    stream: false,
  };
  let res;
  try {
    res = await fetchImpl(cfg.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (err) {
    throw new PlannerError(`Agnes 规划请求失败：${err && err.message ? err.message : err}`);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new PlannerError(`Agnes 规划返回 HTTP ${res.status}${text ? `：${text.slice(0, 200)}` : ''}`);
  }
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new PlannerError('Agnes 规划响应不是 JSON');
  }
  const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message
    ? payload.choices[0].message.content
    : '';
  const parsed = extractJson(content);
  if (!parsed || !Array.isArray(parsed.subtasks)) {
    throw new PlannerError('Agnes 规划响应缺少 subtasks');
  }
  const subtasks = parsed.subtasks
    .filter((item) => item && typeof item.instruction === 'string' && item.instruction.trim())
    .slice(0, cfg.maxSubtasks)
    .map((item, index) => ({
      instruction: item.instruction.trim().slice(0, 12_000),
      timeoutSec: Math.min(3600, Math.max(30, Number.isFinite(Number(item.timeoutSec)) ? Math.round(Number(item.timeoutSec)) : 600)),
      deviceId: typeof item.deviceId === 'string' ? item.deviceId.trim().slice(0, 80) : '',
      tags: Array.isArray(item.tags)
        ? item.tags
            .filter((tag) => typeof tag === 'string' && tag.trim())
            .map((tag) => tag.trim().slice(0, 40))
            .slice(0, 5)
        : [],
      // 只允许依赖更靠前的子任务（防止自依赖/环）；非法下标直接丢弃。
      dependsOn: normalizeIndexes(item.dependsOn, index),
      parallelGroup: typeof item.parallelGroup === 'string' ? item.parallelGroup.trim().slice(0, 40) : '',
      _index: index,
    }));
  if (subtasks.length < 2) throw new PlannerError('Agnes 只返回了少于 2 个有效子任务');
  const execution = normalizeExecution(parsed.execution, subtasks);
  // 模型没给 parallelGroup 时，用 execution.groups 里的分组补全，保证并行关系可追溯。
  const groupByIndex = new Map();
  for (const group of execution.groups) {
    for (const index of group.subtaskIndexes) {
      if (!groupByIndex.has(index)) groupByIndex.set(index, group.name);
    }
  }
  for (const subtask of subtasks) {
    if (!subtask.parallelGroup) subtask.parallelGroup = groupByIndex.get(subtask._index) || '';
    delete subtask._index;
  }
  return {
    title: typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 200) : '长任务拆分',
    execution,
    subtasks,
  };
}

module.exports = { PlannerError, createPlan, plannerConfig, extractJson, buildPrompt };
