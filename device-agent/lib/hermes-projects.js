'use strict';

/**
 * Hermes 项目（projects.db）桥接。
 *
 * BattleStar 通过 `hermes chat -q …` 一次性执行任务；Hermes 默认把这类有限次运行
 * 记为 source='oneshot'（在 TUI/Desktop 的会话列表里被隐藏），且不会自动创建项目，
 * 所以任务在 Hermes agent 里既看不到会话、也没有项目归属。
 *
 * 本模块负责两件事：
 *   1. 把任务解析成一个「项目目录」——绝对路径直接使用；项目名则复用
 *      $HERMES_HOME/projects.db 里已有的项目（取其主目录），没有就建一个；
 *   2. 用与 hermes_cli/projects_db.py 相同的 schema，幂等地把该项目写入
 *      projects.db（失败绝不阻塞任务执行）。
 *
 * 说明：Hermes 的项目工具是 GUI-only，CLI 里的 agent 无法建项目，因此由设备侧
 * 直接写库；写入使用 busy_timeout + 短事务，与 Hermes 桌面/网关并发时安全。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const PROJECTS_DB = 'projects.db';
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_PROJECT_NAME = 120;

// 与 hermes_cli/projects_db.py 的 SCHEMA_SQL 保持一致（CREATE IF NOT EXISTS 幂等）。
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
    id            TEXT PRIMARY KEY,
    slug          TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    description   TEXT,
    icon          TEXT,
    color         TEXT,
    board_slug    TEXT,
    primary_path  TEXT,
    created_at    INTEGER NOT NULL,
    archived      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS project_folders (
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path        TEXT NOT NULL,
    label       TEXT,
    is_primary  INTEGER NOT NULL DEFAULT 0,
    added_at    INTEGER NOT NULL,
    PRIMARY KEY (project_id, path)
);
CREATE INDEX IF NOT EXISTS idx_project_folders_path
    ON project_folders(path);
CREATE TABLE IF NOT EXISTS project_meta (
    key    TEXT PRIMARY KEY,
    value  TEXT
);
CREATE TABLE IF NOT EXISTS discovered_repos (
    root          TEXT PRIMARY KEY,
    label         TEXT,
    last_seen     INTEGER NOT NULL
);
`;

// projects 表在旧版里可能缺少这些列（Hermes 打开时会自动补，这里同样处理）。
const OPTIONAL_PROJECT_COLUMNS = ['board_slug', 'primary_path', 'icon', 'color'];

let sqliteModule;
let sqliteLoaded = false;

function loadSqlite() {
  if (sqliteLoaded) return sqliteModule;
  sqliteLoaded = true;
  try {
    // Node >= 22.5 的内置 SQLite；不引入任何第三方依赖。
    sqliteModule = require('node:sqlite');
  } catch {
    sqliteModule = null;
  }
  return sqliteModule;
}

function sqliteAvailable() {
  const mod = loadSqlite();
  return Boolean(mod && typeof mod.DatabaseSync === 'function');
}

/** 项目 slug：与 Hermes `_slugify` 一致（ASCII 小写字母/数字/连字符）。 */
function slugifyProjectName(name) {
  const raw = String(name == null ? '' : name).trim().toLowerCase();
  const s = raw.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/[-_]+$/g, '');
  if (s) return s;
  // 纯中文/符号项目名：用确定性 hash 生成合法 slug，避免中文字符触发 Hermes 的 slug 校验。
  const hash = crypto.createHash('sha1').update(raw || 'project').digest('hex').slice(0, 8);
  return `project-${hash}`;
}

function isAbsolutePath(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return false;
  if (/^[a-zA-Z]:[\\/]/.test(text)) return true; // C:\ 或 C:/
  if (/^\\\\[^\\]/.test(text)) return true; // UNC
  return path.isAbsolute(text);
}

function normalizeDir(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  const expanded = text.replace(/^~(?=$|[\\/])/, os.homedir());
  const resolved = path.resolve(expanded);
  const root = path.parse(resolved).root;
  const stripped = resolved.replace(/[\\/]+$/, '');
  return stripped || root;
}

function ensureDir(dir) {
  if (!dir) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function pathKey(value) {
  const norm = normalizeDir(value).replace(/\//g, '\\');
  return process.platform === 'win32' ? norm.toLowerCase() : norm;
}

function openProjectsDb(dbPath) {
  const mod = loadSqlite();
  if (!mod || typeof mod.DatabaseSync !== 'function') {
    throw new Error('当前 Node 不支持 node:sqlite（需要 Node >= 22.5）');
  }
  const db = new mod.DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
  } catch {
    /* 老版本 SQLite 不支持某些 pragma 时忽略 */
  }
  db.exec(SCHEMA_SQL);
  const cols = new Set(db.prepare('PRAGMA table_info(projects)').all().map((row) => row.name));
  for (const col of OPTIONAL_PROJECT_COLUMNS) {
    if (!cols.has(col)) {
      try {
        db.exec(`ALTER TABLE projects ADD COLUMN ${col} TEXT`);
      } catch {
        /* 并发下另一进程已加过该列 */
      }
    }
  }
  return db;
}

function projectColumns(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(projects)').all().map((row) => row.name));
  return cols;
}

function loadProject(db, idOrSlug) {
  const key = String(idOrSlug == null ? '' : idOrSlug).trim();
  if (!key) return null;
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(key)
    || db.prepare('SELECT * FROM projects WHERE slug = ?').get(key.toLowerCase());
  if (!row || Number(row.archived) !== 0) return null;
  const folders = db
    .prepare('SELECT path, label, is_primary, added_at FROM project_folders WHERE project_id = ? ORDER BY is_primary DESC, added_at ASC')
    .all(row.id)
    .map((f) => ({ path: f.path, label: f.label, isPrimary: Number(f.is_primary) === 1, addedAt: Number(f.added_at) }));
  return { ...row, folders };
}

function primaryDirOf(project) {
  if (!project) return '';
  if (project.primary_path) return normalizeDir(project.primary_path);
  const first = (project.folders || []).find((f) => f.isPrimary) || (project.folders || [])[0];
  return first && first.path ? normalizeDir(first.path) : '';
}

/** 返回 owning project（最长前缀匹配），与 Hermes project_for_path 行为一致。 */
function projectForPath(db, target) {
  const key = pathKey(target);
  if (!key) return null;
  const rows = db
    .prepare('SELECT pf.project_id AS pid, pf.path AS folder FROM project_folders pf JOIN projects p ON p.id = pf.project_id WHERE p.archived = 0')
    .all();
  let best = null;
  for (const row of rows) {
    const folder = pathKey(row.folder);
    if (!folder) continue;
    if (key === folder || key.startsWith(folder.endsWith('\\') ? folder : `${folder}\\`)) {
      if (!best || folder.length > best.folder.length) best = { pid: row.pid, folder };
    }
  }
  return best ? loadProject(db, best.pid) : null;
}

function findProjectByName(db, name) {
  const text = String(name == null ? '' : name).trim();
  if (!text) return null;
  const slug = slugifyProjectName(text);
  const row = db.prepare('SELECT id FROM projects WHERE slug = ? AND archived = 0').get(slug)
    || db.prepare('SELECT id FROM projects WHERE name = ? COLLATE NOCASE AND archived = 0').get(text);
  return row ? loadProject(db, row.id) : null;
}

function uniqueSlug(db, candidate) {
  let slug = candidate;
  let n = 1;
  while (db.prepare('SELECT 1 FROM projects WHERE slug = ?').get(slug)) {
    n += 1;
    slug = `${candidate.slice(0, Math.max(1, 63 - String(n).length - 1)).replace(/[-_]+$/, '')}-${n}`;
  }
  return slug;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function createProject(db, { name, slug, folder }) {
  const cols = projectColumns(db);
  const pid = `p_${crypto.randomBytes(4).toString('hex')}`;
  const finalSlug = uniqueSlug(db, slug || slugifyProjectName(name));
  const dir = normalizeDir(folder);
  const created = nowSeconds();
  db.exec('BEGIN IMMEDIATE');
  try {
    const values = [];
    const names = [];
    const push = (col, value) => {
      if (cols.has(col)) {
        names.push(col);
        values.push(value);
      }
    };
    push('id', pid);
    push('slug', finalSlug);
    push('name', name);
    push('description', null);
    push('icon', null);
    push('color', null);
    push('board_slug', null);
    push('primary_path', dir || null);
    push('created_at', created);
    push('archived', 0);
    db.prepare(`INSERT INTO projects (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...values);
    if (dir) {
      db.prepare('INSERT INTO project_folders (project_id, path, label, is_primary, added_at) VALUES (?, ?, NULL, 1, ?)')
        .run(pid, dir, created);
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }
  return { id: pid, slug: finalSlug, name, dir, created: true };
}

/**
 * 解析项目目标并保证它在 Hermes 的 projects.db 里存在。
 *
 * @param {object} input
 * @param {string} input.home    该任务实际使用的 HERMES_HOME（profile 目录）
 * @param {string} input.workdir 设备工作目录（兜底目录）
 * @param {string} input.project 任务/配置指定的项目（项目名或绝对路径）
 * @param {string} [input.folder] 项目名未命中已有项目时使用的目录（默认为 <workdir>/projects/<slug>）
 * @returns {{ok:boolean, dir:string, name:string, slug:string, projectId:string|null,
 *            created:boolean, reason:string|null}}
 */
function ensureProject(input = {}) {
  const project = String(input.project == null ? '' : input.project).trim();
  const workdir = normalizeDir(input.workdir);
  const home = normalizeDir(input.home);
  const explicitPath = isAbsolutePath(project);
  const name = (explicitPath ? path.basename(normalizeDir(project)) : project).slice(0, MAX_PROJECT_NAME) || 'project';
  const slug = slugifyProjectName(name || workdir || 'project');
  const result = { ok: false, dir: '', name, slug, projectId: null, created: false, reason: null };
  if (!project) {
    result.reason = '未配置项目';
    return result;
  }

  const fallbackDir = () => (explicitPath
    ? normalizeDir(project)
    : normalizeDir(input.folder) || (workdir ? path.join(workdir, 'projects', slug) : ''));

  if (!sqliteAvailable()) {
    result.reason = '当前 Node 不支持 node:sqlite，未写入 Hermes projects.db';
    result.dir = fallbackDir();
    if (result.dir) ensureDir(result.dir);
    return result;
  }
  if (!home) {
    result.reason = '无法确定 HERMES_HOME';
    result.dir = fallbackDir();
    if (result.dir) ensureDir(result.dir);
    return result;
  }

  const dbPath = path.join(home, PROJECTS_DB);
  let db;
  try {
    db = openProjectsDb(dbPath);
  } catch (err) {
    result.reason = `无法打开 Hermes projects.db：${err && err.message ? err.message : err}`;
    result.dir = fallbackDir();
    if (result.dir) ensureDir(result.dir);
    return result;
  }

  try {
    // 1) 绝对路径：直接作为目录，若已属于某项目则复用该项目。
    if (explicitPath) {
      const dir = normalizeDir(project);
      if (!ensureDir(dir)) {
        result.reason = `项目目录不可用：${dir}`;
        return result;
      }
      const owner = projectForPath(db, dir);
      if (owner) {
        return {
          ok: true,
          dir,
          name: owner.name,
          slug: owner.slug,
          projectId: owner.id,
          created: false,
          reason: null,
        };
      }
      const created = createProject(db, { name, slug, folder: dir });
      return { ok: true, dir, name: created.name, slug: created.slug, projectId: created.id, created: true, reason: null };
    }

    // 2) 项目名：命中已有项目 → 用它的主目录（保证会话按 cwd 归入该项目）。
    const existing = findProjectByName(db, project);
    if (existing) {
      let dir = primaryDirOf(existing);
      if (!dir) {
        dir = normalizeDir(input.folder) || (workdir ? path.join(workdir, 'projects', existing.slug) : '');
      }
      ensureDir(dir);
      return { ok: true, dir, name: existing.name, slug: existing.slug, projectId: existing.id, created: false, reason: null };
    }

    // 3) 新项目：默认目录 <workdir>/projects/<slug>（配置层可传 folder=workdir 复用工作目录）。
    const dir = normalizeDir(input.folder) || (workdir ? path.join(workdir, 'projects', slug) : '');
    if (!dir) {
      result.reason = '缺少可用的项目目录';
      return result;
    }
    if (!ensureDir(dir)) {
      result.reason = `项目目录不可用：${dir}`;
      return result;
    }
    const owner = projectForPath(db, dir);
    if (owner) {
      // 目录已属于另一个项目（例如用户提前建过）：复用 owner，避免重复项目。
      return { ok: true, dir, name: owner.name, slug: owner.slug, projectId: owner.id, created: false, reason: null };
    }
    const created = createProject(db, { name, slug, folder: dir });
    return { ok: true, dir, name: created.name, slug: created.slug, projectId: created.id, created: true, reason: null };
  } catch (err) {
    result.reason = `写入 Hermes 项目失败：${err && err.message ? err.message : err}`;
    result.dir = fallbackDir();
    if (result.dir) ensureDir(result.dir);
    return result;
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

module.exports = {
  PROJECTS_DB,
  SCHEMA_SQL,
  loadSqlite,
  sqliteAvailable,
  slugifyProjectName,
  isAbsolutePath,
  normalizeDir,
  ensureDir,
  pathKey,
  openProjectsDb,
  loadProject,
  projectForPath,
  findProjectByName,
  primaryDirOf,
  createProject,
  ensureProject,
};
