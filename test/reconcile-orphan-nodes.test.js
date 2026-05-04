'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { GraphDB } = require('../lib/graph-db');
const { reconcileProject, computeWorkSet } = require('../lib/reconcile');

function tmpDir() {
  const dir = path.join(__dirname, `t-orphan-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function tmpDbPath() {
  return path.join(__dirname, `t-orphan-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}
function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
function cleanupDb(p) {
  try { fs.unlinkSync(p); } catch {}
  try { fs.unlinkSync(p + '-wal'); } catch {}
  try { fs.unlinkSync(p + '-shm'); } catch {}
}

describe('reconcile orphan-node purge', () => {
  let projectDir, dbPath, db;
  beforeEach(() => {
    projectDir = tmpDir();
    dbPath = tmpDbPath();
    db = new GraphDB(dbPath);
  });
  afterEach(() => { db.close(); cleanup(projectDir); cleanupDb(dbPath); });

  it('purges an orphan node whose disk file is missing', () => {
    db.upsertNode({ project: 'p', file: 'gone.js', name: 'gone', type: 'function', line: 1 });
    assert.equal(db.getFileHash('p', 'gone.js'), null);

    const result = reconcileProject({
      db, project: 'p', rootPath: projectDir, runExtraction: () => {}, config: {},
    });

    const remaining = db.db.prepare(
      "SELECT COUNT(*) AS n FROM nodes WHERE project = 'p' AND file = 'gone.js'"
    ).get().n;
    assert.equal(remaining, 0, 'orphan node with missing file must be purged');
    assert.ok(result.purged >= 1);
  });

  it('leaves an orphan node alone when the disk file still exists', () => {
    fs.writeFileSync(path.join(projectDir, 'present.js'), 'function present() {}\n');
    db.upsertNode({ project: 'p', file: 'present.js', name: 'present', type: 'function', line: 1 });

    reconcileProject({
      db, project: 'p', rootPath: projectDir, runExtraction: () => {}, config: {},
    });

    const remaining = db.db.prepare(
      "SELECT COUNT(*) AS n FROM nodes WHERE project = 'p' AND file = 'present.js'"
    ).get().n;
    assert.equal(remaining, 1, 'orphan node with present file must survive');
  });

  it('computeWorkSet adds orphan-only missing files to the missing list', () => {
    db.upsertNode({ project: 'p', file: 'paired-gone.js', name: 'x', type: 'function', line: 1 });
    db.setFileHash('p', 'paired-gone.js', 'h1');
    db.upsertNode({ project: 'p', file: 'orphan-gone.js', name: 'y', type: 'function', line: 1 });
    fs.writeFileSync(path.join(projectDir, 'orphan-present.js'), '');
    db.upsertNode({ project: 'p', file: 'orphan-present.js', name: 'z', type: 'function', line: 1 });

    const work = computeWorkSet({ db, project: 'p', rootPath: projectDir });
    assert.ok(work.missing.includes('paired-gone.js'));
    assert.ok(work.missing.includes('orphan-gone.js'));
    assert.ok(!work.missing.includes('orphan-present.js'));
  });
});
