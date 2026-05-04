'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { GraphDB } = require('../lib/graph-db');
const { MemoryDB } = require('../lib/memory-db');
const { scanProject, discoverProjects, seedAliases } = require('../scripts/scan');

function tmpDir() {
  const dir = path.join(__dirname, `test-project-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function tmpDbPath() {
  return path.join(__dirname, `test-scan-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

describe('scanProject', () => {
  let projectDir, dbPath, db;

  beforeEach(() => {
    projectDir = tmpDir();
    dbPath = tmpDbPath();
    db = new GraphDB(dbPath);
    // Create test JS files
    fs.writeFileSync(path.join(projectDir, 'index.js'),
      "const utils = require('./lib/utils');\nfunction main() {}\nmodule.exports = { main };\n"
    );
    fs.mkdirSync(path.join(projectDir, 'lib'));
    fs.writeFileSync(path.join(projectDir, 'lib', 'utils.js'),
      "function helper() { return 42; }\nmodule.exports = { helper };\n"
    );
    // Create a node_modules dir that should be skipped
    fs.mkdirSync(path.join(projectDir, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'node_modules', 'pkg', 'index.js'), 'module.exports = {};');
  });

  afterEach(() => {
    db.close();
    cleanup(projectDir);
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
  });

  it('creates nodes and edges for JS files', () => {
    const stats = scanProject(projectDir, 'testproj', db, {});
    assert.ok(stats.filesScanned >= 2);
    const nodes = db.db.prepare('SELECT * FROM nodes WHERE project = ?').all('testproj');
    assert.ok(nodes.length >= 3); // at least main, helper, and module-level nodes
  });

  it('skips node_modules', () => {
    scanProject(projectDir, 'testproj', db, {});
    const nmNodes = db.db.prepare("SELECT * FROM nodes WHERE file LIKE 'node_modules%'").all();
    assert.equal(nmNodes.length, 0);
  });

  it('skips unchanged files on second scan', () => {
    const stats1 = scanProject(projectDir, 'testproj', db, {});
    const stats2 = scanProject(projectDir, 'testproj', db, {});
    assert.equal(stats2.filesSkipped, stats1.filesScanned);
    assert.equal(stats2.filesScanned, 0);
  });

  it('re-extracts files when content changes', () => {
    scanProject(projectDir, 'testproj', db, {});
    // Modify a file
    fs.writeFileSync(path.join(projectDir, 'lib', 'utils.js'),
      "function helper() { return 99; }\nfunction newFn() {}\nmodule.exports = { helper, newFn };\n"
    );
    const stats2 = scanProject(projectDir, 'testproj', db, {});
    assert.ok(stats2.filesScanned >= 1);
    // newFn should now be in the graph
    const newNode = db.db.prepare("SELECT * FROM nodes WHERE name = 'newFn'").get();
    assert.ok(newNode);
  });

  it('registers edge types', () => {
    scanProject(projectDir, 'testproj', db, {});
    const types = db.db.prepare('SELECT * FROM edge_types').all();
    assert.ok(types.length > 0);
  });

  it('creates edges between files that import each other', () => {
    const stats = scanProject(projectDir, 'testproj', db, {});
    assert.ok(stats.edgesCreated > 0, 'should create edges for the require() in index.js');
    const importEdges = db.db.prepare(
      "SELECT * FROM edges WHERE source_project = ? AND type = 'imports'"
    ).all('testproj');
    assert.ok(importEdges.length > 0, 'should record an imports edge');
  });
});

describe('discoverProjects', () => {
  let workspaceDir;

  beforeEach(() => {
    workspaceDir = tmpDir();
  });

  afterEach(() => {
    cleanup(workspaceDir);
  });

  it('finds directories containing a project marker', () => {
    const projA = path.join(workspaceDir, 'proj-a');
    fs.mkdirSync(projA);
    fs.writeFileSync(path.join(projA, 'package.json'), '{}');
    const projB = path.join(workspaceDir, 'proj-b');
    fs.mkdirSync(projB);
    fs.writeFileSync(path.join(projB, 'go.mod'), 'module foo');

    const found = discoverProjects(workspaceDir);
    const names = found.map(p => p.name).sort();
    assert.deepEqual(names, ['proj-a', 'proj-b']);
  });

  it('skips node_modules, .git, marked-for-deletion', () => {
    for (const skipped of ['node_modules', '.git', 'marked-for-deletion']) {
      const dir = path.join(workspaceDir, skipped);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    }
    const realProj = path.join(workspaceDir, 'real');
    fs.mkdirSync(realProj);
    fs.writeFileSync(path.join(realProj, 'package.json'), '{}');

    const found = discoverProjects(workspaceDir);
    assert.deepEqual(found.map(p => p.name), ['real']);
  });

  it('skips directories without any project marker', () => {
    fs.mkdirSync(path.join(workspaceDir, 'not-a-project'));
    const found = discoverProjects(workspaceDir);
    assert.equal(found.length, 0);
  });

  it('returns empty array when workspace is unreadable', () => {
    const found = discoverProjects(path.join(workspaceDir, 'does-not-exist'));
    assert.deepEqual(found, []);
  });
});

describe('seedAliases', () => {
  let projectDir, dbPath, db, memDbPath, memDb;

  beforeEach(() => {
    projectDir = tmpDir();
    dbPath = tmpDbPath();
    memDbPath = path.join(__dirname, `test-mem-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = new GraphDB(dbPath);
    memDb = new MemoryDB(memDbPath);

    // File with 3+ exported defs → should earn a file-stem alias
    fs.writeFileSync(path.join(projectDir, 'utils.js'),
      "function a(){}\nfunction b(){}\nfunction c(){}\nmodule.exports = { a, b, c };\n"
    );
    // Route file → earns stem alias regardless of count
    fs.writeFileSync(path.join(projectDir, 'user-routes.js'),
      "function handler() {}\nmodule.exports = { handler };\n"
    );
    // File with only 1 exported def and no routing keyword → no stem alias
    fs.writeFileSync(path.join(projectDir, 'lonely.js'),
      "function solo() {}\nmodule.exports = { solo };\n"
    );
    scanProject(projectDir, 'sp', db, {});
  });

  afterEach(() => {
    db.close();
    memDb.close();
    cleanup(projectDir);
    for (const p of [dbPath, dbPath + '-wal', dbPath + '-shm', memDbPath, memDbPath + '-wal', memDbPath + '-shm']) {
      try { fs.unlinkSync(p); } catch {}
    }
  });

  it('inserts the project-name alias', () => {
    seedAliases('sp', db, memDb);
    const row = memDb.db.prepare("SELECT * FROM aliases WHERE alias = 'sp' AND project = 'sp' AND file IS NULL").get();
    assert.ok(row, 'project-name alias should exist');
  });

  it('inserts a file-stem alias for files with 3+ exported defs', () => {
    seedAliases('sp', db, memDb);
    const row = memDb.db.prepare("SELECT * FROM aliases WHERE alias = 'utils'").get();
    assert.ok(row, 'utils stem alias should exist');
  });

  it('inserts a file-stem alias for route/middleware files regardless of count', () => {
    seedAliases('sp', db, memDb);
    const row = memDb.db.prepare("SELECT * FROM aliases WHERE alias = 'user-routes'").get();
    assert.ok(row, 'user-routes stem alias should exist');
  });

  it('skips file-stem alias for files with <3 defs and no routing keyword', () => {
    seedAliases('sp', db, memDb);
    const row = memDb.db.prepare("SELECT * FROM aliases WHERE alias = 'lonely'").get();
    assert.equal(row, undefined, 'lonely stem alias should NOT exist');
  });

  it('inserts per-function aliases prefixed with project name and lowercased', () => {
    seedAliases('sp', db, memDb);
    const row = memDb.db.prepare("SELECT * FROM aliases WHERE alias = 'sp a'").get();
    assert.ok(row, "'sp a' alias should exist for exported function 'a'");
  });

  it('is idempotent — running twice does not duplicate aliases', () => {
    seedAliases('sp', db, memDb);
    const firstCount = memDb.db.prepare('SELECT COUNT(*) AS c FROM aliases').get().c;
    seedAliases('sp', db, memDb);
    const secondCount = memDb.db.prepare('SELECT COUNT(*) AS c FROM aliases').get().c;
    assert.equal(secondCount, firstCount);
  });
});
