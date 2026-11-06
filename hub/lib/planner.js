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

function buildPrompt(instruction, requirements, maxSubtasks) {
  const req = requirements && typeof requirements === 'object' ? requirements : {};
  return [
    '你是 BattleStar 长任务规划器。把用户的一条长任务拆成 2-' + maxSubtasks + ' 个可独立执行的子任务。',
    '要求：',
    '1. 每个子任务必须自包含，能单独交给另一台工作机执行，不要互相等待；',
    '2. 按顺序执行时能完成原任务；子任务之间要说明依赖，但不要合并成一个大任务；',
    '3. 视频/图片生成任务要拆成明确的镜头、素材准备、生成、合成/导出步骤；',
    '4. 每个子任务给出合理的 timeoutSec（30-3600 秒）；',
    '5. 只输出严格 JSON，不要 Markdown、解释或代码块。',
    'JSON 格式：',
    '{"title":"简短标题","subtasks":[{"instruction":"完整可执行的子任务指令","timeoutSec":300}]}',
    '原任务要求（可能为空）：' + JSON.stringify(req),
    '用户原任务：',
    String(instruction || ''),
  ].join('\n');
}

/**
 * @returns {Promise<{title:string, subtasks:Array<{instruction:string, timeoutSec:number}>}>}
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
      { role: 'user', content: buildPrompt(instruction, options.requirements, cfg.maxSubtasks) },
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
    .map((item) => ({
      instruction: item.instruction.trim().slice(0, 12_000),
      timeoutSec: Math.min(3600, Math.max(30, Number.isFinite(Number(item.timeoutSec)) ? Math.round(Number(item.timeoutSec)) : 600)),
    }));
  if (subtasks.length < 2) throw new PlannerError('Agnes 只返回了少于 2 个有效子任务');
  return {
    title: typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 200) : '长任务拆分',
    subtasks,
  };
}

module.exports = { PlannerError, createPlan, plannerConfig, extractJson };
