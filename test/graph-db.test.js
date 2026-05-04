'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { GraphDB, SCHEMA_VERSION } = require('../lib/graph-db');

function tmpDbPath() {
  return path.join(__dirname, `test-graph-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe('GraphDB', () => {
  let db, dbPath;

  beforeEach(() => {
    dbPath = tmpDbPath();
    db = new GraphDB(dbPath);
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
  });

  it('creates all tables and indexes', () => {
    const tables = db.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(r => r.name);
    assert.ok(tables.includes('nodes'));
    assert.ok(tables.includes('edges'));
    assert.ok(tables.includes('edge_types'));
    assert.ok(tables.includes('file_hashes'));
    assert.ok(tables.includes('annotations'));
  });

  it('upsertNode inserts and returns id', () => {
    const id = db.upsertNode({
      project: 'myproject', file: 'lib/foo.js',
      name: 'doStuff', type: 'function', line: 10, metadata: { async: true }
    });
    assert.ok(id > 0);
    const row = db.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
    assert.equal(row.name, 'doStuff');
    assert.equal(row.type, 'function');
    assert.equal(row.line, 10);
    assert.deepEqual(JSON.parse(row.metadata_json), { async: true });
  });

  it('upsertNode updates on duplicate (project, file, name, type, line)', () => {
    const id1 = db.upsertNode({
      project: 'p', file: 'f.js', name: 'fn', type: 'function', line: 5,
      metadata: { v: 1 }
    });
    const id2 = db.upsertNode({
      project: 'p', file: 'f.js', name: 'fn', type: 'function', line: 5,
      metadata: { v: 2 }
    });
    assert.equal(id1, id2);
    const row = db.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id1);
    assert.deepEqual(JSON.parse(row.metadata_json), { v: 2 });
  });

  it('insertEdge creates an edge between nodes', () => {
    const src = db.upsertNode({ project: 'p', file: 'a.js', name: 'a', type: 'function', line: 1 });
    const tgt = db.upsertNode({ project: 'p', file: 'b.js', name: 'b', type: 'module', line: 1 });
    const edgeId = db.insertEdge({
      sourceId: src, targetId: tgt,
      type: 'imports', category: 'structural',
      sourceProject: 'p', sourceFile: 'a.js'
    });
    assert.ok(edgeId > 0);
  });

  it('registerEdgeType inserts new types', () => {
    db.registerEdgeType({
      name: 'imports', category: 'structural',
      followsForBlastRadius: true, impliesStaleness: false,
      description: 'ES/CJS module import'
    });
    const row = db.db.prepare('SELECT * FROM edge_types WHERE name = ?').get('imports');
    assert.equal(row.category, 'structural');
    assert.equal(row.follows_for_blast_radius, 1);
  });

  it('registerEdgeType is idempotent for existing names', () => {
    db.registerEdgeType({ name: 'imports', category: 'structural' });
    db.registerEdgeType({ name: 'imports', category: 'structural' });
    const count = db.db.prepare('SELECT COUNT(*) as c FROM edge_types WHERE name = ?').get('imports').c;
    assert.equal(count, 1);
  });

  it('setFileHash inserts and updates', () => {
    db.setFileHash('p', 'lib/foo.js', 'abc123');
    let row = db.db.prepare('SELECT hash FROM file_hashes WHERE project = ? AND file = ?').get('p', 'lib/foo.js');
    assert.equal(row.hash, 'abc123');
    db.setFileHash('p', 'lib/foo.js', 'def456');
    row = db.db.prepare('SELECT hash FROM file_hashes WHERE project = ? AND file = ?').get('p', 'lib/foo.js');
    assert.equal(row.hash, 'def456');
  });

  it('deleteFileNodes removes nodes and cascading edges', () => {
    const src = db.upsertNode({ project: 'p', file: 'a.js', name: 'a', type: 'function', line: 1 });
    const tgt = db.upsertNode({ project: 'p', file: 'b.js', name: 'b', type: 'module', line: 1 });
    db.insertEdge({ sourceId: src, targetId: tgt, type: 'imports', category: 'structural', sourceProject: 'p', sourceFile: 'a.js' });
    db.deleteFileNodes('p', 'a.js');
    const nodes = db.db.prepare('SELECT * FROM nodes WHERE project = ? AND file = ?').all('p', 'a.js');
    assert.equal(nodes.length, 0);
    const edges = db.db.prepare('SELECT * FROM edges WHERE source_id = ?').all(src);
    assert.equal(edges.length, 0);
  });

  it('addAnnotation creates annotation; cascade-deletes with node', () => {
    const nodeId = db.upsertNode({ project: 'p', file: 'a.js', name: 'fn', type: 'function', line: 1 });
    const annId = db.addAnnotation(nodeId, 'This handles auth');
    assert.ok(annId > 0);
    db.deleteFileNodes('p', 'a.js');
    const anns = db.db.prepare('SELECT * FROM annotations WHERE id = ?').all(annId);
    assert.equal(anns.length, 0);
  });

  it('setProjectRoot / getProjectRoot round-trip', () => {
    assert.equal(db.getProjectRoot('drip'), null);
    db.setProjectRoot('drip', '/home/user/code/drip');
    assert.equal(db.getProjectRoot('drip'), '/home/user/code/drip');
    db.setProjectRoot('drip', '/home/user/projects/drip');
    assert.equal(db.getProjectRoot('drip'), '/home/user/projects/drip');
  });

  it('setProjectRoot preserves last_scan_sha from upsertScanState', () => {
    db.upsertScanState('p', 'abc123', 'audit');
    db.setProjectRoot('p', '/tmp/p');
    const state = db.getScanState('p');
    assert.equal(state.last_scan_sha, 'abc123');
    assert.equal(state.last_scan_mode, 'audit');
    assert.equal(state.root_path, '/tmp/p');
  });

  it('upsertScanState preserves root_path from setProjectRoot', () => {
    db.setProjectRoot('p', '/tmp/p');
    db.upsertScanState('p', 'sha1', 'incremental');
    assert.equal(db.getProjectRoot('p'), '/tmp/p');
  });

  it('nodes table has body_hash column (TEXT, nullable)', () => {
    const cols = db.db.prepare('PRAGMA table_info(nodes)').all();
    const col = cols.find(c => c.name === 'body_hash');
    assert.ok(col, 'body_hash column missing from nodes');
    assert.equal(col.type, 'TEXT');
    assert.equal(col.notnull, 0);
  });

  it('code_labels table exists with all 14 columns', () => {
    const cols = db.db.prepare('PRAGMA table_info(code_labels)').all();
    const names = cols.map(c => c.name);
    const expected = ['id', 'node_id', 'detector_id', 'term', 'category',
      'descriptors_json', 'role_summary', 'confidence', 'source', 'model_id',
      'body_hash_at_label', 'is_stale', 'created_at', 'updated_at'];
    for (const col of expected) {
      assert.ok(names.includes(col), `Missing column: ${col}`);
    }
    assert.equal(names.length, 14);
  });

  it('code_labels has the five required indexes', () => {
    const indexes = db.db.prepare('PRAGMA index_list(code_labels)').all();
    const names = indexes.map(i => i.name);
    for (const idx of ['idx_code_labels_node', 'idx_code_labels_node_source',
        'idx_code_labels_stale', 'idx_code_labels_category', 'idx_code_labels_unique']) {
      assert.ok(names.includes(idx), `Missing index: ${idx}`);
    }
  });

  it('code_labels CHECK constraint rejects invalid source values', () => {
    const nodeId = db.upsertNode({ project: 'p', file: 'chk.js', name: 'fn', type: 'function', line: 1 });
    assert.throws(
      () => db.db.prepare(
        'INSERT INTO code_labels (node_id, detector_id, term, category, confidence, source) VALUES (?,?,?,?,?,?)'
      ).run(nodeId, 'x', 'y', 'middleware', 0.9, 'external'),
      /constraint/i
    );
  });

  it('code_labels FK cascade: deleting a node removes its labels', () => {
    const nodeId = db.upsertNode({ project: 'p', file: 'casc.js', name: 'fn', type: 'function', line: 1 });
    db.db.prepare(
      'INSERT INTO code_labels (node_id, detector_id, term, category, confidence, source) VALUES (?,?,?,?,?,?)'
    ).run(nodeId, 'test.det', 'middleware', 'middleware', 0.9, 'heuristic');
    const before = db.db.prepare('SELECT COUNT(*) as c FROM code_labels WHERE node_id = ?').get(nodeId).c;
    assert.equal(before, 1);
    db.deleteFileNodes('p', 'casc.js');
    const after = db.db.prepare('SELECT COUNT(*) as c FROM code_labels WHERE node_id = ?').get(nodeId).c;
    assert.equal(after, 0);
  });

  it('meta table exists with key (PRIMARY KEY) and value TEXT columns', () => {
    const cols = db.db.prepare('PRAGMA table_info(meta)').all();
    const byName = Object.fromEntries(cols.map(c => [c.name, c]));
    assert.ok(byName.key, 'meta.key column missing');
    assert.ok(byName.value, 'meta.value column missing');
    assert.equal(byName.key.pk, 1, 'meta.key should be PRIMARY KEY');
  });

  it('meta table contains schema_version row matching SCHEMA_VERSION constant', () => {
    const row = db.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
    assert.ok(row, 'schema_version row missing from meta');
    assert.equal(row.value, SCHEMA_VERSION);
  });

  it('meta table rejects duplicate key via PRIMARY KEY constraint', () => {
    assert.throws(
      () => db.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', 'x'),
      /unique|primary key/i
    );
  });

  it('getMeta returns value for existing key and null for missing key', () => {
    assert.equal(db.getMeta('schema_version'), SCHEMA_VERSION);
    assert.equal(db.getMeta('nonexistent_key'), null);
  });

  it('migrates pre-existing DB without root_path column via ALTER TABLE', () => {
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}

    const Database = require('better-sqlite3');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE project_scan_state (
        project TEXT PRIMARY KEY,
        last_scan_sha TEXT,
        last_scan_at DATETIME,
        last_scan_mode TEXT CHECK(last_scan_mode IN ('incremental', 'audit'))
      );
      INSERT INTO project_scan_state (project, last_scan_sha, last_scan_at, last_scan_mode)
      VALUES ('legacy', 'sha0', CURRENT_TIMESTAMP, 'audit');
    `);
    raw.close();

    db = new GraphDB(dbPath);
    assert.equal(db.getProjectRoot('legacy'), null, 'legacy row has null root_path after migration');
    const state = db.getScanState('legacy');
    assert.equal(state.last_scan_sha, 'sha0', 'pre-existing state preserved through migration');
    db.setProjectRoot('legacy', '/tmp/legacy');
    assert.equal(db.getProjectRoot('legacy'), '/tmp/legacy');
  });
});

describe('getOrphanNodeFilesForProject', () => {
  let dbPath, db;

  beforeEach(() => {
    dbPath = path.join(__dirname, `gd-orphan-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = new GraphDB(dbPath);
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
  });

  it('returns only files present in nodes but absent from file_hashes', () => {
    db.upsertNode({ project: 'p', file: 'paired.js', name: 'paired', type: 'function', line: 1 });
    db.setFileHash('p', 'paired.js', 'hash-a');
    db.setFileHash('p', 'hash-only.js', 'hash-b');
    db.upsertNode({ project: 'p', file: 'orphan.js', name: 'orphan', type: 'function', line: 1 });
    db.upsertNode({ project: 'other', file: 'other-orphan.js', name: 'x', type: 'function', line: 1 });

    const result = db.getOrphanNodeFilesForProject('p');
    assert.deepEqual(result.sort(), ['orphan.js']);
  });

  it('deduplicates when a file has multiple orphan node rows', () => {
    db.upsertNode({ project: 'p', file: 'orphan.js', name: 'a', type: 'function', line: 1 });
    db.upsertNode({ project: 'p', file: 'orphan.js', name: 'b', type: 'function', line: 5 });
    assert.deepEqual(db.getOrphanNodeFilesForProject('p'), ['orphan.js']);
  });

  it('returns [] when project has no nodes', () => {
    assert.deepEqual(db.getOrphanNodeFilesForProject('empty'), []);
  });
});
