'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projects = require('../lib/hermes-projects.js');

const sqliteOk = projects.sqliteAvailable();
const skip = sqliteOk ? false : '当前 Node 不支持 node:sqlite';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function countProjects(home) {
  const db = projects.openProjectsDb(path.join(home, projects.PROJECTS_DB));
  const row = db.prepare('SELECT COUNT(*) AS n FROM projects').get();
  db.close();
  return Number(row.n);
}

test('slugifyProjectName：ASCII 转 kebab、纯中文有稳定兜底', () => {
  assert.equal(projects.slugifyProjectName('KLSE quantum'), 'klse-quantum');
  assert.equal(projects.slugifyProjectName('ComfyUI 工作机 · Hermes 调度'), 'comfyui-hermes');
  assert.equal(projects.slugifyProjectName('  Pos  System!! '), 'pos-system');
  const cn = projects.slugifyProjectName('图像处理主机');
  assert.match(cn, /^project-[0-9a-f]{8}$/);
  assert.equal(cn, projects.slugifyProjectName('图像处理主机'));
  assert.match(projects.slugifyProjectName(''), /^project-[0-9a-f]{8}$/);
});

test('ensureProject：未配置项目时不报错，只返回原因', () => {
  const res = projects.ensureProject({ home: makeTempDir('hp-home-'), workdir: makeTempDir('hp-work-'), project: '' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, '未配置项目');
  assert.equal(res.dir, '');
});

test('ensureProject：创建项目目录与 projects.db 记录，重复调用幂等', { skip }, () => {
  const home = makeTempDir('hp-home-');
  const workdir = makeTempDir('hp-work-');
  const first = projects.ensureProject({ home, workdir, project: 'ComfyUI 工作机' });
  assert.equal(first.ok, true, first.reason || '');
  assert.equal(first.created, true);
  assert.equal(first.slug, 'comfyui');
  assert.equal(first.dir, path.join(workdir, 'projects', 'comfyui'));
  assert.ok(fs.existsSync(first.dir), '项目目录应存在');
  assert.equal(countProjects(home), 1);

  const second = projects.ensureProject({ home, workdir, project: 'ComfyUI 工作机' });
  assert.equal(second.ok, true);
  assert.equal(second.created, false);
  assert.equal(second.projectId, first.projectId);
  assert.equal(countProjects(home), 1, '重复调用不应重复建项目');

  const db = projects.openProjectsDb(path.join(home, projects.PROJECTS_DB));
  const owner = projects.projectForPath(db, path.join(workdir, 'projects', 'comfyui'));
  assert.equal(owner && owner.id, first.projectId);
  db.close();
});

test('ensureProject：已有项目按名字/大小写命中并复用其主目录', { skip }, () => {
  const home = makeTempDir('hp-home-');
  const workdir = makeTempDir('hp-work-');
  const created = projects.ensureProject({ home, workdir, project: 'KLSE Quantum' });
  assert.equal(created.ok, true);

  const reused = projects.ensureProject({ home, workdir, project: 'klse quantum' });
  assert.equal(reused.ok, true);
  assert.equal(reused.created, false);
  assert.equal(reused.projectId, created.projectId);
  assert.equal(reused.dir, created.dir);
  assert.equal(countProjects(home), 1);
});

test('ensureProject：绝对路径直接作为项目目录，再次使用复用同一项目', { skip }, () => {
  const home = makeTempDir('hp-home-');
  const workdir = makeTempDir('hp-work-');
  const target = makeTempDir('hp-target-');

  const first = projects.ensureProject({ home, workdir, project: target });
  assert.equal(first.ok, true, first.reason || '');
  assert.equal(first.created, true);
  assert.equal(first.dir, projects.normalizeDir(target));

  const second = projects.ensureProject({ home, workdir, project: target });
  assert.equal(second.ok, true);
  assert.equal(second.created, false);
  assert.equal(second.projectId, first.projectId);
  assert.equal(countProjects(home), 1);
});

test('ensureProject：目录已属于其他项目时复用 owner，避免重复项目', { skip }, () => {
  const home = makeTempDir('hp-home-');
  const workdir = makeTempDir('hp-work-');
  const base = projects.ensureProject({ home, workdir, project: 'Base Project' });
  assert.equal(base.ok, true);

  const other = projects.ensureProject({ home, workdir, project: 'Another Name', folder: base.dir });
  assert.equal(other.ok, true);
  assert.equal(other.created, false);
  assert.equal(other.projectId, base.projectId);
  assert.equal(countProjects(home), 1);
});

test('ensureProject：缺少 HERMES_HOME 时降级为目录但仍可用', { skip }, () => {
  const workdir = makeTempDir('hp-work-');
  const res = projects.ensureProject({ home: '', workdir, project: '降级项目' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, '无法确定 HERMES_HOME');
  assert.ok(res.dir);
  assert.ok(fs.existsSync(res.dir));
});
