'use strict';

/**
 * 本地文件预检（A 方案）。
 *
 * 从任务指令里提取可能指向本地文件的路径/文件名，只读检查它们是否存在于
 * Hub 宿主（母机）上；如果命中，说明这条任务需要在本机文件上执行，
 * 路由时可以把任务固定到「本机」设备。全程不移动/不修改任何文件。
 *
 * 纯 Node 内置模块实现；fs 可注入，便于单元测试。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FILE_EXTENSIONS = [
  'py', 'ps1', 'psm1', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'md', 'txt', 'pdf',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'tsv', 'yaml', 'yml', 'toml', 'ini',
  'cfg', 'conf', 'log', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'zip', 'rar', '7z',
  'tar', 'gz', 'apk', 'exe', 'msi', 'bat', 'cmd', 'sh', 'bash', 'html', 'htm', 'css', 'scss',
  'java', 'kt', 'go', 'rs', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php', 'lua', 'sql',
  'db', 'sqlite', 'xml', 'env', 'lock', 'pyc',
];
const EXT_SET = new Set(FILE_EXTENSIONS);

// 这些目录要么是缓存/依赖，要么体量极大，遍历时跳过以避免拖慢任务创建。
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.cache', '.npm', '.npm-cache', '.pnpm-store',
  '.venv', 'venv', 'env', '__pycache__', '.mypy_cache', '.pytest_cache', '.tox',
  'dist', 'build', 'out', 'target', '.next', '.nuxt', '.svelte-kit', 'coverage',
  '.idea', '.vscode', 'appdata', '.gradle', '.cargo', '.rustup', '.conda', '.anaconda',
  'site-packages', 'task-records', '.state', 'local settings', 'application data',
]);

const MAX_REFERENCE_LENGTH = 260;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_TIMEOUT_MS = 250;
const DEFAULT_MAX_MATCHES = 3;
const MAX_REFERENCES = 20;
const MAX_INDEX_ENTRIES = 4000;
const INDEX_TIME_BUDGET_MS = 150;

function clampInt(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(num)));
}

/** 去掉指令里路径两侧的引号、括号和尾部中文/英文标点。 */
function trimReference(raw) {
  return String(raw || '')
    .replace(/^[\s"'`([{<]+/u, '')
    .replace(/[\s,.;:!?'"`)\]}>，。；：、！？）》】”’]+$/u, '')
    .trim();
}

/** 把「路径 + 后面紧跟的中文/标点」截到最后一个像文件扩展名的位置。 */
function trimToFileEnd(value) {
  const re = /\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9])/g;
  let end = -1;
  let match;
  while ((match = re.exec(value))) end = match.index + match[0].length;
  return end > 2 ? value.slice(0, end) : value;
}

/**
 * 从任务指令中提取「可能指向本地文件」的引用。
 * @returns {Array<{raw:string, value:string, kind:'absolute'|'path'|'name'}>}
 */
function extractReferences(instruction) {
  const text = String(instruction || '');
  if (!text.trim()) return [];
  // 先剔除 URL、mailto 与邮箱，避免把网址/邮箱误认为本地文件。
  const cleaned = text
    .replace(/https?:\/\/[^\s<>"'`]+/gi, ' ')
    .replace(/\bmailto:[^\s]+/gi, ' ')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, ' ');

  const refs = new Map();
  const add = (raw, kind) => {
    let value = trimReference(raw);
    if (!value || value.length < 2) return;
    if ((kind === 'absolute' || kind === 'path') && value.length > 160) value = trimToFileEnd(value);
    if (value.length > MAX_REFERENCE_LENGTH) return;
    if (/^[A-Za-z]:$/.test(value)) return;
    const key = value.toLowerCase();
    if (refs.has(key)) return;
    refs.set(key, { raw: value, value, kind });
  };

  const absoluteRe = /(?:[A-Za-z]:[\\/]|\\\\[^\s\\/:*?"<>|]+[\\/][^\s\\/:*?"<>|]+)[^<>:"|?*\r\n\t]*/g;
  for (const match of cleaned.matchAll(absoluteRe)) add(match[0], 'absolute');

  const pathRe = /(?:\.{1,2}[\\/])?[A-Za-z0-9_$@.-]+(?:[\\/][A-Za-z0-9_$@.-]+)+(?:\.[A-Za-z0-9]{1,8})?/g;
  for (const match of cleaned.matchAll(pathRe)) {
    if (/^[A-Za-z]:/.test(match[0]) || /^\\\\/.test(match[0])) continue;
    add(match[0], 'path');
  }

  const nameRe = /(?<![\w.\\/-])([A-Za-z0-9_][A-Za-z0-9_.-]{0,80}\.[A-Za-z0-9]{1,8})(?![\w.-])/g;
  for (const match of cleaned.matchAll(nameRe)) {
    const name = match[1];
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    if (!EXT_SET.has(ext)) continue;
    add(name, 'name');
  }

  return [...refs.values()].slice(0, MAX_REFERENCES);
}

function statSafe(fsImpl, target) {
  try {
    return fsImpl.statSync(target);
  } catch {
    return null;
  }
}

/** 绝对路径：直接存在即命中；含空格/中文时按字符从长到短截断，找最长的真实文件路径。 */
function resolveAbsolute(raw, fsImpl) {
  const direct = statSafe(fsImpl, raw);
  if (direct && direct.isFile()) return raw;
  // 纯 ASCII 且不含空格时，截断也无法得到真实路径，直接返回目录结果。
  if (!/[^\x00-\x7F]/.test(raw) && !/\s/.test(raw)) {
    return direct && direct.isDirectory() ? raw : null;
  }
  const startedAt = Date.now();
  const maxCut = Math.min(raw.length, 300);
  for (let cut = maxCut; cut >= 3; cut -= 1) {
    if (Date.now() - startedAt > 80) break;
    const candidate = raw.slice(0, cut).replace(/[\\/]+$/, '');
    if (!candidate || !/[\\/]/.test(candidate)) break;
    const stat = statSafe(fsImpl, candidate);
    if (stat && stat.isFile()) return candidate;
  }
  return direct && direct.isDirectory() ? raw : null;
}

/** 相对路径：join 到每个搜索根检查；尾部带中文时逐步截断。 */
function resolveRelative(raw, roots, fsImpl) {
  for (const root of roots) {
    const resolved = path.resolve(root, raw);
    if (!isInsideRoot(root, resolved)) continue;
    const stat = statSafe(fsImpl, resolved);
    if (stat && (stat.isFile() || stat.isDirectory())) return resolved;
  }
  if (!/[^\x00-\x7F]/.test(raw) && !/\s/.test(raw)) return null;
  const startedAt = Date.now();
  const maxCut = Math.min(raw.length, 160);
  for (let cut = maxCut - 1; cut >= 3; cut -= 1) {
    if (Date.now() - startedAt > 60) break;
    const candidate = raw.slice(0, cut).replace(/[\\/]+$/, '');
    if (!candidate || !/[\\/]/.test(candidate)) break;
    for (const root of roots) {
      const resolved = path.resolve(root, candidate);
      if (!isInsideRoot(root, resolved)) continue;
      const stat = statSafe(fsImpl, resolved);
      if (stat && stat.isFile()) return resolved;
    }
  }
  return null;
}

function isInsideRoot(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return (
    resolvedTarget === resolvedRoot ||
    resolvedTarget.startsWith(resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep)
  );
}

/** 给某个根目录建「小写文件名 -> 完整路径」索引（广度优先，限深、限量、限时）。 */
function indexRoot(root, options) {
  const fsImpl = options.fs || fs;
  const maxDepth = options.maxDepth;
  const maxEntries = options.maxEntries;
  const deadline = options.deadline;
  const index = new Map();
  const start = path.resolve(root);
  const queue = [{ dir: start, depth: 0 }];
  let visited = 0;
  while (queue.length) {
    if (visited >= maxEntries || Date.now() > deadline) break;
    const current = queue.shift();
    let entries;
    try {
      entries = fsImpl.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > maxEntries || Date.now() > deadline) break;
      const full = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        const lower = entry.name.toLowerCase();
        if (!SKIP_DIRS.has(lower) && !entry.name.startsWith('.') && current.depth + 1 <= maxDepth) {
          queue.push({ dir: full, depth: current.depth + 1 });
        }
      } else if (entry.isFile()) {
        const key = entry.name.toLowerCase();
        if (!index.has(key)) index.set(key, full);
      }
    }
  }
  return index;
}

function normalizeRoots(roots, fsImpl) {
  const list = Array.isArray(roots) && roots.length ? roots : defaultRoots([], fsImpl);
  const seen = new Set();
  const out = [];
  for (const root of list) {
    if (typeof root !== 'string' || !root.trim()) continue;
    const resolved = path.resolve(root);
    if (seen.has(resolved)) continue;
    const stat = statSafe(fsImpl, resolved);
    if (!stat || !stat.isDirectory()) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

/** 默认搜索根：当前目录、仓库根、Downloads/Documents/Desktop、用户主目录（按优先级）。 */
function defaultRoots(extra = [], fsImpl = fs) {
  const home = os.homedir();
  const candidates = [
    ...extra,
    process.cwd(),
    path.resolve(__dirname, '..', '..'),
    path.join(home, 'Downloads'),
    path.join(home, 'Documents'),
    path.join(home, 'Desktop'),
    home,
  ];
  const seen = new Set();
  const roots = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    const stat = statSafe(fsImpl, resolved);
    if (!stat || !stat.isDirectory()) continue;
    seen.add(resolved);
    roots.push(resolved);
  }
  return roots;
}

/**
 * 解析引用是否在本地存在。
 * @returns {{hit:boolean, matches:Array<{ref:string, path:string, kind:string}>}}
 */
function resolveReferences(refs, options = {}) {
  const fsImpl = options.fs || fs;
  const roots = normalizeRoots(options.roots, fsImpl);
  const maxDepth = clampInt(options.maxDepth, DEFAULT_MAX_DEPTH, 1, 8);
  const timeoutMs = clampInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, 10, 10000);
  const maxMatches = clampInt(options.maxMatches, DEFAULT_MAX_MATCHES, 1, 10);
  const deadline = Date.now() + timeoutMs;
  const matches = [];
  const indexCache = new Map();
  const pendingNames = [];

  for (const ref of Array.isArray(refs) ? refs : []) {
    if (!ref || typeof ref.value !== 'string') continue;
    if (matches.length >= maxMatches || Date.now() > deadline) break;
    if (ref.kind === 'absolute') {
      const found = resolveAbsolute(ref.value, fsImpl);
      if (found) matches.push({ ref: ref.raw, path: found, kind: ref.kind });
      continue;
    }
    if (ref.kind === 'path') {
      const found = resolveRelative(ref.value, roots, fsImpl);
      if (found) matches.push({ ref: ref.raw, path: found, kind: ref.kind });
      continue;
    }
    pendingNames.push(ref);
  }

  for (const ref of pendingNames) {
    if (matches.length >= maxMatches || Date.now() > deadline) break;
    for (const root of roots) {
      if (Date.now() > deadline) break;
      let index = indexCache.get(root);
      if (!index) {
        index = indexRoot(root, {
          fs: fsImpl,
          maxDepth,
          maxEntries: MAX_INDEX_ENTRIES,
          deadline: Math.min(deadline, Date.now() + INDEX_TIME_BUDGET_MS),
        });
        indexCache.set(root, index);
      }
      const found = index.get(ref.value.toLowerCase());
      if (found) {
        matches.push({ ref: ref.raw, path: found, kind: ref.kind });
        break;
      }
    }
  }

  return { hit: matches.length > 0, matches: matches.slice(0, maxMatches) };
}

/**
 * 预检入口：提取引用 + 本地解析，返回是否命中与命中依据。
 * @returns {{hit:boolean, matches:Array<{ref:string, path:string, kind:string}>, reason:string}}
 */
function preflightInstruction(instruction, options = {}) {
  const refs = extractReferences(instruction).slice(0, MAX_REFERENCES);
  if (!refs.length) return { hit: false, matches: [], reason: '' };
  const result = resolveReferences(refs, options);
  if (!result.hit) return { hit: false, matches: [], reason: '' };
  const reason = `本地文件预检命中 ${result.matches.length} 项：${result.matches
    .map((m) => `${path.basename(m.path)}（${m.path}）`)
    .join('；')}`;
  return { hit: true, matches: result.matches, reason: reason.slice(0, 480) };
}

module.exports = {
  FILE_EXTENSIONS,
  SKIP_DIRS,
  extractReferences,
  defaultRoots,
  resolveReferences,
  preflightInstruction,
};
