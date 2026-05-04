'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { GraphDB } = require('../lib/graph-db');
const { extractFiles } = require('../scripts/scan');
const { reconcileProject } = require('../lib/reconcile');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gm-reconcile-'));
}

function tmpDbPath() {
  return path.join(os.tmpdir(), `gm-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe('reconcileProject integration', () => {
  let tmpProject, dbPath, db;

  before(() => {
    tmpProject = tmpDir();
    dbPath = tmpDbPath();
    db = new GraphDB(dbPath);

    // Three JS files with a simple require chain: a.js → b.js → c.js
    fs.writeFileSync(path.join(tmpProject, 'a.js'), `'use strict';\nconst b = require('./b');\nfunction doA() { return b.doB(); }\nmodule.exports = { doA };\n`);
    fs.writeFileSync(path.join(tmpProject, 'b.js'), `'use strict';\nconst c = require('./c');\nfunction doB() { return c.doC(); }\nmodule.exports = { doB };\n`);
    fs.writeFileSync(path.join(tmpProject, 'c.js'), `'use strict';\nfunction doC() { return 42; }\nmodule.exports = { doC };\n`);

    // Baseline scan
    extractFiles({ db, project: 'test-proj', rootPath: tmpProject, config: {} });
    db.setProjectRoot('test-proj', tmpProject);
  });

  after(() => {
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
    try { fs.rmSync(tmpProject, { recursive: true, force: true }); } catch {}
  });

  it('purges deleted file, re-extracts changed file, skips unchanged file', () => {
    // Capture c.js updated_at from baseline
    const baselineRows = db.getFileHashRowsForProject('test-proj');
    const cBaseline = baselineRows.find(r => r.file === 'c.js');
    assert.ok(cBaseline, 'c.js should be in file_hashes after baseline scan');

    // Delete a.js from disk
    fs.unlinkSync(path.join(tmpProject, 'a.js'));

    // Modify b.js and push its mtime forward
    const newBContent = `'use strict';\nconst c = require('./c');\nfunction doB() { return c.doC() * 2; }\nmodule.exports = { doB };\n`;
    fs.writeFileSync(path.join(tmpProject, 'b.js'), newBContent);
    // Ensure mtime is strictly newer than the stored updated_at
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(path.join(tmpProject, 'b.js'), future, future);

    // Run reconcile
    const result = reconcileProject({ db, project: 'test-proj', rootPath: tmpProject });

    // a.js rows gone from all three tables
    const aNodes = db.db.prepare('SELECT * FROM nodes WHERE project = ? AND file = ?').all('test-proj', 'a.js');
    assert.equal(aNodes.length, 0, 'a.js nodes should be purged');
    const aEdges = db.db.prepare('SELECT * FROM edges WHERE source_project = ? AND source_file = ?').all('test-proj', 'a.js');
    assert.equal(aEdges.length, 0, 'a.js edges should be purged');
    const aHash = db.db.prepare('SELECT * FROM file_hashes WHERE project = ? AND file = ?').get('test-proj', 'a.js');
    assert.equal(aHash, undefined, 'a.js file_hashes row should be purged');

    // b.js re-extracted: new hash recorded, updated_at newer than baseline
    const bRow = db.db.prepare('SELECT hash, updated_at FROM file_hashes WHERE project = ? AND file = ?').get('test-proj', 'b.js');
    assert.ok(bRow, 'b.js should still have a file_hashes row');
    const bBaseline = baselineRows.find(r => r.file === 'b.js');
    assert.notEqual(bRow.hash, bBaseline.hash, 'b.js hash should have changed after re-extraction');

    // c.js updated_at unchanged — it was skipped, not re-extracted
    const cRow = db.db.prepare('SELECT updated_at FROM file_hashes WHERE project = ? AND file = ?').get('test-proj', 'c.js');
    assert.ok(cRow, 'c.js should still have a file_hashes row');
    assert.equal(cRow.updated_at, cBaseline.updated_at, 'c.js updated_at should be unchanged (skipped)');

    // Reconcile return value
    assert.equal(result.purged, 1, 'should report 1 purged file');
    assert.equal(result.reextracted, 1, 'should report 1 re-extracted file');
  });
});
