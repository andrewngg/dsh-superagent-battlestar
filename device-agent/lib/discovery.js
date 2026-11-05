'use strict';

/**
 * 设备能力探测（发现）：
 *  1. DSH：扫描 ~/.dsh（可用 DSH_HOME 覆盖）下的 profiles、openai-gateway、skills、settings 模型字段；
 *  2. Ollama：GET {OLLAMA_HOST:-http://127.0.0.1:11434}/api/tags，把模型并入 models（kind=ollama）；
 *  3. config（JSON）覆盖/合并：标量显式优先、数组按 id 合并去重，可用 replaceArrays 整组替换；
 *  4. 任何探测失败都只记录 warnings，不抛错。
 *
 * 输出 { manifest, warnings }，manifest 已用 shared/protocol.js 规范化。
 */

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { requestJson, joinUrl, normalizeBaseUrl } = require('./http');
const { normalizeManifest } = require('../../shared/protocol.js');

const AGENT_VERSION = (() => {
  try {
    return require('../../package.json').version || '0.1.0';
  } catch {
    return '0.1.0';
  }
})();

const PLATFORMS = ['windows', 'macos', 'linux', 'android', 'other'];
const KINDS = ['dsh', 'ollama', 'openai-gateway', 'multi', 'custom'];
const ARRAY_KEYS = ['models', 'profiles', 'gateways', 'skills'];
const SCALAR_KEYS = ['name', 'platform', 'kind', 'agentVersion', 'endpoint'];

const PLATFORM_MAP = {
  win32: 'windows',
  darwin: 'macos',
  linux: 'linux',
  freebsd: 'linux',
  sunos: 'linux',
  aix: 'linux',
};

const STRENGTH_RULES = [
  { pattern: /reason|think|r1\b|o1\b|o3\b|math|推理|思考/i, strengths: ['reasoning', 'math'] },
  { pattern: /coder|code|编程|代码/i, strengths: ['code'] },
  { pattern: /vl\b|vision|视觉|image|多模态/i, strengths: ['vision'] },
  { pattern: /embed|向量/i, strengths: ['embedding'] },
];

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (key === undefined || key === null || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

async function safeStat(target) {
  try {
    return await fsp.stat(target);
  } catch {
    return null;
  }
}

async function listDir(dir) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries;
  } catch {
    return [];
  }
}

/** 读取 JSON 文件：不存在返回 {missing:true}，解析失败返回 {error}，不抛错。 */
async function readJsonFile(file) {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { data: null, missing: true, error: null };
    return { data: null, missing: false, error: err.message };
  }
  try {
    return { data: JSON.parse(text.replace(/^\uFEFF/, '')), missing: false, error: null };
  } catch (err) {
    return { data: null, missing: false, error: err.message };
  }
}

async function readTextFile(file) {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

function detectPlatform(env = process.env) {
  if (env.ANDROID_ROOT || env.ANDROID_DATA || env.TERMUX_VERSION) return 'android';
  return PLATFORM_MAP[process.platform] || 'other';
}

function detectResources() {
  const cpus = os.cpus() || [];
  const cores = cpus.length || null;
  const memoryGB = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10;
  const osName = `${os.type()} ${os.release()}`.trim().slice(0, 100);
  return { cpuCores: cores, memoryGB, gpu: '', os: osName };
}

// ---------------------------------------------------------------------------
// 模型启发式
// ---------------------------------------------------------------------------

function inferStrengths(modelId, extraHint = '') {
  const haystack = `${modelId} ${extraHint}`;
  for (const rule of STRENGTH_RULES) {
    if (rule.pattern.test(haystack)) return [...rule.strengths];
  }
  return ['chat', 'writing'];
}

function inferProvider(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (id.startsWith('gpt-') || /^o[134]\b/.test(id)) return 'openai';
  if (id.startsWith('claude')) return 'anthropic';
  if (id.startsWith('gemini')) return 'google';
  if (id.startsWith('deepseek')) return 'deepseek';
  if (id.startsWith('qwen') || id.startsWith('llama') || id.startsWith('mistral') || id.startsWith('gemma')) {
    return 'local';
  }
  return '';
}

function createModel(id, provider, extras = {}) {
  const modelId = String(id || '').trim();
  if (!modelId) return null;
  return {
    id: modelId,
    provider: provider || inferProvider(modelId),
    contextWindow: Number.isFinite(extras.contextWindow) ? extras.contextWindow : null,
    strengths: Array.isArray(extras.strengths) && extras.strengths.length ? extras.strengths : inferStrengths(modelId),
    available: extras.available !== false,
  };
}

/** 从 YAML/JSON 文本中启发式提取 model / provider 字段。 */
function extractModelHints(text) {
  const hints = [];
  let provider = '';
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '');
    const providerMatch = line.match(/^\s*provider:\s*["']?([\w@./:-]+)/i);
    if (providerMatch) provider = providerMatch[1];
    const modelMatch = line.match(/^\s*(?:default-)?model:\s*["']?([\w@./:-]+)/i);
    if (modelMatch) {
      const id = modelMatch[1];
      if (id && !/^(true|false|null|~)$/i.test(id)) hints.push({ id, provider: provider || '' });
    }
  }
  for (const match of String(text).matchAll(/"model"\s*:\s*"([^"]+)"/g)) {
    const id = match[1];
    if (id && !/^(true|false|null)$/i.test(id)) hints.push({ id, provider: '' });
  }
  return uniqBy(hints, (hint) => hint.id);
}

/** 从 cordis 补丁中提取插件包名（形如 @scope/pkg、dsh-xxx）。 */
function extractPluginNames(text) {
  const plugins = [];
  for (const match of String(text).matchAll(/^\s*-?\s*name:\s*["']?([^"'\s#]+)["']?/gm)) {
    const value = match[1].trim();
    if (!value) continue;
    const looksLikePackage =
      value.includes('/') || value.startsWith('@') || value.startsWith('dsh-') || value.startsWith('dsh.') || value === 'dsh';
    if (looksLikePackage) plugins.push(value);
  }
  return uniqBy(plugins, (name) => name);
}

/** 递归搜索 JSON 中的 model 字段（settings.json 等）。 */
function extractModelHintsFromJson(value, depth = 0) {
  const out = [];
  if (depth > 6 || value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) out.push(...extractModelHintsFromJson(item, depth + 1));
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string' && /^(model|defaultModel|modelId|default_model)$/i.test(key)) {
      if (child.trim()) out.push({ id: child.trim(), provider: '' });
    } else if (child && typeof child === 'object') {
      out.push(...extractModelHintsFromJson(child, depth + 1));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// skills
// ---------------------------------------------------------------------------

function parseSkillMeta(markdown) {
  const meta = {};
  if (!markdown) return meta;
  const frontMatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (frontMatter) {
    for (const line of frontMatter[1].split(/\r?\n/)) {
      const match = line.match(/^([\w-]+):\s*(.+)$/);
      if (match) meta[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  if (!meta.name) {
    const heading = markdown.match(/^#\s+(.+)$/m);
    if (heading) meta.name = heading[1].trim();
  }
  return meta;
}

async function scanSkillsDirs(dirs) {
  const skills = [];
  for (const dir of dirs) {
    const entries = await listDir(dir);
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        const skillDir = path.join(dir, entry.name);
        const pkg = await readJsonFile(path.join(skillDir, 'package.json'));
        const markdown =
          (await readTextFile(path.join(skillDir, 'SKILL.md'))) ||
          (await readTextFile(path.join(skillDir, 'skill.md'))) ||
          '';
        const meta = parseSkillMeta(markdown);
        const version = pkg.data && typeof pkg.data.version === 'string' ? pkg.data.version : '';
        skills.push({
          id: entry.name,
          name: meta.name || (pkg.data && typeof pkg.data.description === 'string' ? pkg.data.description : entry.name),
          version,
        });
      } else if (/\.md$/i.test(entry.name)) {
        const markdown = await readTextFile(path.join(dir, entry.name));
        const meta = parseSkillMeta(markdown || '');
        skills.push({ id: entry.name.replace(/\.md$/i, ''), name: meta.name || entry.name, version: '' });
      }
    }
    if (skills.length) break;
  }
  return uniqBy(skills, (skill) => skill.id);
}

// ---------------------------------------------------------------------------
// DSH 探测
// ---------------------------------------------------------------------------

async function readProfile(dir, id, warnings) {
  const plugins = [];
  let name = id;
  let models = [];

  const pkg = await readJsonFile(path.join(dir, 'package.json'));
  if (pkg.error) warnings.push(`DSH profile「${id}」package.json 解析失败：${pkg.error}`);
  if (pkg.data && typeof pkg.data === 'object') {
    if (nonEmptyString(pkg.data.name)) name = pkg.data.name;
    const bundles = pkg.data.dsh && pkg.data.dsh.profile && pkg.data.dsh.profile.bundles;
    for (const bundle of asArray(bundles)) if (nonEmptyString(bundle)) plugins.push(bundle);
    if (isPlainObject(pkg.data.dependencies)) {
      for (const depName of Object.keys(pkg.data.dependencies)) if (depName) plugins.push(depName);
    }
  }

  for (const fileName of ['cordis.patch.yml', 'cordis.patch.yaml', 'cordis.yml', 'cordis.yaml']) {
    const text = await readTextFile(path.join(dir, fileName));
    if (!text) continue;
    for (const plugin of extractPluginNames(text)) plugins.push(plugin);
    for (const hint of extractModelHints(text)) models.push(hint);
  }

  return { profile: { id, name: name === id ? id : `${name}`, plugins: uniqBy(plugins, (x) => x) }, models };
}

async function probeOpenAiGateway({ dshHome, env, warnings }) {
  const gatewayDir = path.join(dshHome, 'openai-gateway');
  const stat = await safeStat(gatewayDir);
  if (!stat || !stat.isDirectory()) return null;

  let baseUrl = env.DSH_OPENAI_GATEWAY_URL || env.OPENAI_GATEWAY_URL || '';
  let models = [];

  for (const fileName of ['config.json', 'gateway.json', 'settings.json']) {
    const cfg = await readJsonFile(path.join(gatewayDir, fileName));
    if (!cfg.data || !isPlainObject(cfg.data)) continue;
    const data = cfg.data;
    if (nonEmptyString(data.baseUrl)) baseUrl = data.baseUrl;
    else if (nonEmptyString(data.base_url)) baseUrl = data.base_url;
    else if (nonEmptyString(data.url)) baseUrl = data.url;
    else if (Number.isFinite(data.port)) baseUrl = `http://127.0.0.1:${Math.trunc(data.port)}/v1`;
    for (const item of asArray(data.models)) {
      if (nonEmptyString(item)) models.push(item);
      else if (isPlainObject(item) && nonEmptyString(item.id)) models.push(item.id);
    }
    break;
  }

  if (!baseUrl) baseUrl = 'http://127.0.0.1:8787/v1';
  baseUrl = normalizeBaseUrl(baseUrl);
  if (!/\/v\d+$/.test(baseUrl)) baseUrl = `${baseUrl}/v1`;

  try {
    const res = await requestJson(joinUrl(baseUrl, '/models'), { timeoutMs: 1500 });
    if (res.status === 200 && res.json && Array.isArray(res.json.data)) {
      for (const item of res.json.data) if (item && nonEmptyString(item.id)) models.push(item.id);
    } else if (res.status !== 200) {
      warnings.push(`openai-gateway 返回 HTTP ${res.status}，按配置文件地址申报`);
    }
  } catch (err) {
    warnings.push(`openai-gateway 探测失败（${baseUrl}）：${err.message}`);
  }

  return {
    id: 'openai-gateway',
    kind: 'openai-compatible',
    baseUrl,
    models: uniqBy(models.filter(nonEmptyString), (x) => x),
  };
}

/**
 * 扫描 DSH_HOME。返回 { found, profiles, gateways, skills, models, resources }。
 */
async function probeDsh({ dshHome, env = process.env, warnings = [], config = {} }) {
  const result = { found: false, profiles: [], gateways: [], skills: [], models: [] };
  const discoveryCfg = isPlainObject(config.discovery) ? config.discovery : {};

  const stat = await safeStat(dshHome);
  if (!stat || !stat.isDirectory()) {
    warnings.push(`未发现 DSH 目录（${dshHome}），跳过 DSH 能力探测`);
    return result;
  }
  result.found = true;

  // ---- profiles ----
  const profilesDir = path.join(dshHome, 'profiles');
  const profileEntries = await listDir(profilesDir);
  const profileModels = [];
  for (const entry of profileEntries) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    try {
      const { profile, models } = await readProfile(path.join(profilesDir, entry.name), entry.name, warnings);
      result.profiles.push(profile);
      profileModels.push(...models);
    } catch (err) {
      warnings.push(`读取 DSH profile「${entry.name}」失败：${err.message}`);
    }
  }
  if (!result.profiles.length) warnings.push(`未在 ${profilesDir} 发现可读的 DSH profile`);
  result.profiles = uniqBy(result.profiles, (profile) => profile.id);

  // ---- settings / 配置文件中的模型字段 ----
  const settingsFiles = [
    'settings.yaml',
    'settings.yml',
    'settings.json',
    'settings.yaml.imported',
    'config.json',
  ];
  for (const fileName of settingsFiles) {
    const file = path.join(dshHome, fileName);
    const text = await readTextFile(file);
    if (!text) continue;
    for (const hint of extractModelHints(text)) profileModels.push(hint);
    try {
      for (const hint of extractModelHintsFromJson(JSON.parse(text.replace(/^\uFEFF/, '')))) profileModels.push(hint);
    } catch {
      /* 不是 JSON，忽略 */
    }
  }
  result.models = uniqBy(
    profileModels.filter((hint) => hint && nonEmptyString(hint.id)).map((hint) => createModel(hint.id, hint.provider)),
    (model) => model && model.id,
  ).filter(Boolean);

  // ---- openai-gateway ----
  if (discoveryCfg.gateway !== false) {
    try {
      const gateway = await probeOpenAiGateway({ dshHome, env, warnings });
      if (gateway) result.gateways.push(gateway);
    } catch (err) {
      warnings.push(`探测 openai-gateway 失败：${err.message}`);
    }
  }

  // ---- skills ----
  if (discoveryCfg.skills !== false) {
    try {
      result.skills = await scanSkillsDirs([
        path.join(dshHome, 'skills'),
        path.join(dshHome, 'plugins', 'skills'),
      ]);
    } catch (err) {
      warnings.push(`扫描 skills 目录失败：${err.message}`);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Ollama 探测
// ---------------------------------------------------------------------------

function inferOllamaStrengths(item) {
  const details = (item && item.details) || {};
  const families = asArray(details.families).join(' ');
  const hint = `${families} ${details.family || ''}`;
  if (/vl|vision|clip/i.test(hint)) return ['vision', 'chat'];
  if (/code|coder/i.test(hint)) return ['code'];
  if (/embed/i.test(hint)) return ['embedding'];
  return ['chat', 'writing'];
}

/**
 * 探测 Ollama 模型列表。失败返回空 models + warning，不抛错。
 */
async function probeOllama({ host, warnings = [], timeoutMs = 1500 } = {}) {
  const baseUrl = normalizeBaseUrl(host || 'http://127.0.0.1:11434');
  try {
    const res = await requestJson(joinUrl(baseUrl, '/api/tags'), { timeoutMs });
    if (res.status !== 200) {
      warnings.push(`Ollama /api/tags 返回 HTTP ${res.status}，跳过 Ollama 能力探测`);
      return { models: [], baseUrl, available: false };
    }
    const list = res.json && Array.isArray(res.json.models) ? res.json.models : [];
    const models = uniqBy(
      list
        .filter((item) => item && nonEmptyString(item.name))
        .map((item) => createModel(item.name, 'ollama', { strengths: inferOllamaStrengths(item) })),
      (model) => model && model.id,
    ).filter(Boolean);
    return { models, baseUrl, available: true };
  } catch (err) {
    warnings.push(`Ollama 未连接（${baseUrl}）：${err.message}`);
    return { models: [], baseUrl, available: false };
  }
}

// ---------------------------------------------------------------------------
// 合并 config
// ---------------------------------------------------------------------------

function mergeStringArrays(primary, secondary) {
  return uniqBy([...asArray(primary), ...asArray(secondary)].filter(nonEmptyString), (item) => item);
}

/** 数组按 id 合并去重：同 id 的 config 项覆盖探测项，其余保留。 */
function mergeById(baseItems, configItems) {
  const out = [];
  const seen = new Set();
  const configById = new Map();
  for (const item of configItems) {
    if (isPlainObject(item) && nonEmptyString(item.id)) configById.set(item.id, item);
  }
  for (const item of asArray(baseItems)) {
    if (!isPlainObject(item) || !nonEmptyString(item.id)) continue;
    const override = configById.get(item.id);
    out.push(override ? { ...item, ...override } : item);
    seen.add(item.id);
  }
  for (const item of configItems) {
    if (!isPlainObject(item) || !nonEmptyString(item.id) || seen.has(item.id)) continue;
    out.push(item);
    seen.add(item.id);
  }
  return out;
}

/**
 * 把 config 合并进探测结果。
 * - 标量：config 显式字段优先；
 * - tags：并集（config 在前）；
 * - models/profiles/gateways/skills：按 id 合并去重，config 同 id 优先；
 * - config.replaceArrays=true（或数组，如 ["models"]）时整组替换；
 * - resources / limits：浅合并，config 优先。
 */
function mergeManifest(base, config, warnings = []) {
  const out = { ...base };

  for (const key of SCALAR_KEYS) {
    if (config[key] === undefined) continue;
    const value = config[key];
    if (typeof value !== 'string') {
      warnings.push(`config.${key} 必须是字符串，已忽略`);
      continue;
    }
    if (key === 'platform' && !PLATFORMS.includes(value)) {
      warnings.push(`config.platform 取值非法（${value}），可用：${PLATFORMS.join('/')}；已忽略`);
      continue;
    }
    if (key === 'kind' && !KINDS.includes(value)) {
      warnings.push(`config.kind 取值非法（${value}），可用：${KINDS.join('/')}；已忽略`);
      continue;
    }
    out[key] = value;
  }

  if (config.tags !== undefined) {
    if (!Array.isArray(config.tags)) warnings.push('config.tags 必须是字符串数组，已忽略');
    else out.tags = mergeStringArrays(config.tags, base.tags);
  }

  const replaceAll = config.replaceArrays === true || config.replace === true;
  const replaceKeys = new Set(Array.isArray(config.replaceArrays) ? config.replaceArrays.filter(nonEmptyString) : []);

  for (const key of ARRAY_KEYS) {
    if (config[key] === undefined) continue;
    if (!Array.isArray(config[key])) {
      warnings.push(`config.${key} 必须是数组，已忽略`);
      continue;
    }
    const provided = config[key].filter(isPlainObject);
    out[key] = replaceAll || replaceKeys.has(key) ? provided : mergeById(base[key], provided);
  }

  if (config.resources !== undefined) {
    if (!isPlainObject(config.resources)) warnings.push('config.resources 必须是对象，已忽略');
    else out.resources = { ...(base.resources || {}), ...config.resources };
  }

  if (config.limits !== undefined) {
    if (!isPlainObject(config.limits)) warnings.push('config.limits 必须是对象，已忽略');
    else out.limits = { ...(base.limits || {}), ...config.limits };
  }

  return out;
}

// ---------------------------------------------------------------------------
// 配置文件
// ---------------------------------------------------------------------------

/** 读取 --config 指定的 JSON 配置文件；失败抛出可读错误（CLI 会友好提示）。 */
async function loadConfig(file) {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') throw new Error(`配置文件不存在：${file}`);
    throw new Error(`读取配置文件失败（${file}）：${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new Error(`配置文件不是合法 JSON（${file}）：${err.message}`);
  }
  if (!isPlainObject(data)) throw new Error(`配置文件根节点必须是 JSON 对象（${file}）`);
  return data;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 探测能力并合并 config。
 * @param {object} [options]
 * @param {object} [options.config] 已加载的 config 对象
 * @param {object} [options.env] 环境变量（默认 process.env）
 * @param {string} [options.homeDir] 用户主目录（测试用）
 * @param {string} [options.dshHome] 覆盖 DSH_HOME
 * @param {string} [options.ollamaHost] 覆盖 OLLAMA_HOST
 * @param {number} [options.ollamaTimeoutMs]
 * @returns {Promise<{manifest:object, warnings:string[], probing:object}>}
 */
async function discover(options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const config = isPlainObject(options.config) ? options.config : {};
  const warnings = [];

  const dshHome = options.dshHome || (nonEmptyString(config.dshHome) ? config.dshHome : '') || env.DSH_HOME || path.join(homeDir, '.dsh');
  const discoveryCfg = isPlainObject(config.discovery) ? config.discovery : {};

  const manifest = {
    name: '',
    platform: options.platform || detectPlatform(env),
    kind: 'custom',
    agentVersion: AGENT_VERSION,
    tags: [],
    models: [],
    profiles: [],
    gateways: [],
    skills: [],
    resources: detectResources(),
    limits: { maxConcurrentTasks: 1 },
  };

  // ---- DSH ----
  let dshFound = false;
  if (discoveryCfg.dsh !== false) {
    const dsh = await probeDsh({ dshHome, env, warnings, config });
    dshFound = dsh.found;
    manifest.profiles = dsh.profiles;
    manifest.gateways = dsh.gateways;
    manifest.skills = dsh.skills;
    manifest.models = dsh.models;
    if (dsh.found) manifest.kind = 'dsh';
  }

  // ---- Ollama ----
  const ollamaHost = options.ollamaHost || env.OLLAMA_HOST || 'http://127.0.0.1:11434';
  let ollama = { models: [], baseUrl: normalizeBaseUrl(ollamaHost), available: false };
  if (discoveryCfg.ollama !== false) {
    ollama = await probeOllama({
      host: ollamaHost,
      warnings,
      timeoutMs: options.ollamaTimeoutMs || 1500,
    });
    if (ollama.available) {
      manifest.models = mergeById(manifest.models, ollama.models);
      if (!dshFound) manifest.kind = 'ollama';
    }
  }

  const configDeclaresCapabilities = ['models', 'profiles', 'gateways', 'skills'].some(
    (key) => Array.isArray(config[key]) && config[key].length > 0,
  );
  if (
    !dshFound &&
    !configDeclaresCapabilities &&
    manifest.models.length === 0 &&
    manifest.profiles.length === 0 &&
    manifest.gateways.length === 0 &&
    manifest.skills.length === 0
  ) {
    warnings.push('未探测到任何 AI 能力（DSH/Ollama），且 config 未显式申报；设备将使用默认执行器运行');
  }

  // ---- config 合并 ----
  const merged = mergeManifest(manifest, config, warnings);

  if (!nonEmptyString(merged.name)) {
    merged.name = `设备-${os.hostname()}`;
  }
  merged.name = String(merged.name).trim().slice(0, 64);

  const normalized = normalizeManifest(merged);
  if (normalized.errors.length) {
    throw new Error(`能力清单校验失败：${normalized.errors.join('；')}`);
  }
  for (const warn of normalized.warnings) warnings.push(warn);

  return {
    manifest: normalized.manifest,
    warnings,
    probing: {
      dshHome,
      dshFound,
      ollama: { available: ollama.available, baseUrl: ollama.baseUrl },
    },
  };
}

module.exports = {
  AGENT_VERSION,
  discover,
  loadConfig,
  detectPlatform,
  detectResources,
  mergeManifest,
  mergeById,
  probeOllama,
  probeDsh,
  parseSkillMeta,
  extractModelHints,
  extractPluginNames,
};
