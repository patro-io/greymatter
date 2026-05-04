'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { GraphDB } = require('../lib/graph-db');
const { extractFiles, scanProject } = require('../scripts/scan');

function tmpDir() {
  const dir = path.join(__dirname, `t-scan-excl-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function tmpDbPath() {
  return path.join(__dirname, `t-scan-excl-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}
function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
function cleanupDb(p) {
  try { fs.unlinkSync(p); } catch {}
  try { fs.unlinkSync(p + '-wal'); } catch {}
  try { fs.unlinkSync(p + '-shm'); } catch {}
}

describe('extractFiles required-config contract', () => {
  let projectDir, dbPath, db;
  beforeEach(() => {
    projectDir = tmpDir();
    dbPath = tmpDbPath();
    db = new GraphDB(dbPath);
  });
  afterEach(() => { db.close(); cleanup(projectDir); cleanupDb(dbPath); });

  it('throws when called without a config argument', () => {
    assert.throws(
      () => extractFiles({ db, project: 'p', rootPath: projectDir }),
      /extractFiles: config is required/
    );
  });

  it('throws when called with config: null', () => {
    assert.throws(
      () => extractFiles({ db, project: 'p', rootPath: projectDir, config: null }),
      /extractFiles: config is required/
    );
  });

  it('throws when called with config: undefined explicitly', () => {
    assert.throws(
      () => extractFiles({ db, project: 'p', rootPath: projectDir, config: undefined }),
      /extractFiles: config is required/
    );
  });
});

describe('scanProject forwards config to extractFiles', () => {
  let projectDir, dbPath, db;
  beforeEach(() => {
    projectDir = tmpDir();
    dbPath = tmpDbPath();
    db = new GraphDB(dbPath);
    fs.mkdirSync(path.join(projectDir, 'archived'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'archived', 'old.js'),
      'function gone() {}\nmodule.exports = { gone };\n');
    fs.writeFileSync(path.join(projectDir, 'live.js'),
      'function here() {}\nmodule.exports = { here };\n');
  });
  afterEach(() => { db.close(); cleanup(projectDir); cleanupDb(dbPath); });

  it('respects config.exclusion.extra_patterns supplied by caller', () => {
    const config = { exclusion: { extra_patterns: ['archived/'] } };
    scanProject(projectDir, 'p', db, config);
    const archivedRows = db.db.prepare(
      "SELECT * FROM nodes WHERE project = ? AND file LIKE 'archived/%'"
    ).all('p');
    assert.equal(archivedRows.length, 0, 'archived/ paths must not enter the graph');
    const liveRows = db.db.prepare(
      "SELECT * FROM nodes WHERE project = ? AND file = 'live.js'"
    ).all('p');
    assert.ok(liveRows.length >= 1, 'live.js must still be extracted');
  });
});

const { loadPolicy: _loadPolicy } = require('../lib/exclusion');

describe('scan stamps exclusion_policy_hash', () => {
  let projectDir, dbPath, db;
  beforeEach(() => {
    projectDir = tmpDir();
    dbPath = tmpDbPath();
    db = new GraphDB(dbPath);
    fs.writeFileSync(path.join(projectDir, 'a.js'),
      'function a() {}\nmodule.exports = { a };\n');
  });
  afterEach(() => { db.close(); cleanup(projectDir); cleanupDb(dbPath); });

  it('writes exclusion_policy_hash equal to loadPolicy(rootPath, config).hash', () => {
    const config = { exclusion: { extra_patterns: ['archived/'] } };
    scanProject(projectDir, 'p', db, config);
    const policy = _loadPolicy(projectDir, config);
    const state = db.getExclusionState('p');
    assert.ok(state, 'project_scan_state row must exist after scan');
    assert.equal(state.exclusion_policy_hash, policy.hash);
  });
});

describe('scan purges when policy hash changed', () => {
  let projectDir, dbPath, db;
  beforeEach(() => {
    projectDir = tmpDir();
    dbPath = tmpDbPath();
    db = new GraphDB(dbPath);
    fs.mkdirSync(path.join(projectDir, 'archived'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'archived', 'old.js'),
      'function old() {}\nmodule.exports = { old };\n');
    fs.writeFileSync(path.join(projectDir, 'a.js'),
      'function a() {}\nmodule.exports = { a };\n');
  });
  afterEach(() => { db.close(); cleanup(projectDir); cleanupDb(dbPath); });

  it('purges newly-excluded paths and stamps the new hash', () => {
    scanProject(projectDir, 'p', db, {});
    const before = db.db.prepare(
      "SELECT COUNT(*) AS n FROM nodes WHERE project = 'p' AND file LIKE 'archived/%'"
    ).get().n;
    assert.ok(before >= 1, 'sanity: archived/old.js should have been ingested under empty config');

    const config2 = { exclusion: { extra_patterns: ['archived/'] } };
    scanProject(projectDir, 'p', db, config2);
    const after = db.db.prepare(
      "SELECT COUNT(*) AS n FROM nodes WHERE project = 'p' AND file LIKE 'archived/%'"
    ).get().n;
    assert.equal(after, 0, 'archived/ rows must be purged when policy hash changes');

    const hashesAfter = db.db.prepare(
      "SELECT COUNT(*) AS n FROM file_hashes WHERE project = 'p' AND file LIKE 'archived/%'"
    ).get().n;
    assert.equal(hashesAfter, 0, 'file_hashes for archived/ must be purged alongside nodes');

    const policy2 = _loadPolicy(projectDir, config2);
    assert.equal(db.getExclusionState('p').exclusion_policy_hash, policy2.hash);
  });
});

describe('scan re-includes previously excluded paths after policy relaxation', () => {
  let projectDir, dbPath, db;
  beforeEach(() => {
    projectDir = tmpDir();
    dbPath = tmpDbPath();
    db = new GraphDB(dbPath);
    fs.mkdirSync(path.join(projectDir, 'archived'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'archived', 'old.js'),
      'function old() {}\nmodule.exports = { old };\n');
  });
  afterEach(() => { db.close(); cleanup(projectDir); cleanupDb(dbPath); });

  it('restores nodes when extra_patterns is removed (file_hashes did not block re-extraction)', () => {
    const excluded = { exclusion: { extra_patterns: ['archived/'] } };
    scanProject(projectDir, 'p', db, excluded);
    const excludedCount = db.db.prepare(
      "SELECT COUNT(*) AS n FROM nodes WHERE project = 'p' AND file LIKE 'archived/%'"
    ).get().n;
    assert.equal(excludedCount, 0, 'sanity: archived/ excluded on first scan');

    scanProject(projectDir, 'p', db, {});
    const restored = db.db.prepare(
      "SELECT COUNT(*) AS n FROM nodes WHERE project = 'p' AND file LIKE 'archived/%'"
    ).get().n;
    assert.ok(restored >= 1,
      'archived/old.js must re-enter the graph after pattern removal — stale file_hashes would silently block this');
  });
});

describe('scan transaction rolls back on extractor failure', () => {
  let projectDir, dbPath, db;
  beforeEach(() => {
    projectDir = tmpDir();
    dbPath = tmpDbPath();
    db = new GraphDB(dbPath);
    fs.mkdirSync(path.join(projectDir, 'archived'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'archived', 'old.js'),
      'function old() {}\nmodule.exports = { old };\n');
  });
  afterEach(() => { db.close(); cleanup(projectDir); cleanupDb(dbPath); });

  it('does not stamp a new policy hash when extraction throws mid-walk', () => {
    db.upsertNode({ project: 'p', file: 'archived/old.js', name: 'old', type: 'function', line: 1 });
    db.setFileHash('p', 'archived/old.js', 'seed-hash');
    db.setExclusionState('p', 'OLD_HASH_SENTINEL');

    const badExtractorsDir = path.join(projectDir, '__bad_extractors__');
    fs.mkdirSync(badExtractorsDir, { recursive: true });
    fs.writeFileSync(
      path.join(badExtractorsDir, 'js-extractor.js'),
      `'use strict';
       module.exports = {
         extensions: ['.js'],
         extract() { throw new Error('boom'); },
       };`
    );

    const config = { exclusion: { extra_patterns: ['archived/'] } };
    assert.throws(
      () => extractFiles({ db, project: 'p', rootPath: projectDir, extractorsDir: badExtractorsDir, config }),
      /boom/
    );

    assert.equal(db.getExclusionState('p').exclusion_policy_hash, 'OLD_HASH_SENTINEL',
      'stamp must roll back');
    const stillThere = db.db.prepare(
      "SELECT COUNT(*) AS n FROM nodes WHERE project = 'p' AND file = 'archived/old.js'"
    ).get().n;
    assert.equal(stillThere, 1, 'pre-existing seeded row must survive — purge rolled back too');
  });
});

describe('AC#1 regression — production.env never enters the graph', () => {
  let projectDir, dbPath, db;
  beforeEach(() => {
    projectDir = tmpDir();
    dbPath = tmpDbPath();
    db = new GraphDB(dbPath);
    fs.writeFileSync(path.join(projectDir, 'production.env'), 'SECRET=abc\n');
    fs.writeFileSync(path.join(projectDir, 'app.js'),
      'function app() {}\nmodule.exports = { app };\n');
  });
  afterEach(() => { db.close(); cleanup(projectDir); cleanupDb(dbPath); });

  it('CLI scan with default config excludes production.env via builtin patterns', () => {
    scanProject(projectDir, 'p', db, {});
    const envRows = db.db.prepare(
      "SELECT COUNT(*) AS n FROM nodes WHERE project = 'p' AND file = 'production.env'"
    ).get().n;
    assert.equal(envRows, 0);
  });
});

module.exports = { tmpDir, tmpDbPath, cleanup, cleanupDb };
