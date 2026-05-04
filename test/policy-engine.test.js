const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { GraphDB } = require('../lib/graph-db');
const { GraphQueries } = require('../lib/graph-queries');
const { classifyFile, formatAlert } = require('../lib/policy-engine');

function tmpDbPath() {
  return path.join(__dirname, `test-policy-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe('PolicyEngine', () => {
  let db, queries, dbPath;
  const defaultConfig = {
    hypothalamus: {
      database_files: 'ask',
      secret_files: 'block',
      high_blast_radius: 'warn',
      config_files: 'warn',
      generated_files: 'inform',
      documented_files: 'inform',
      blast_radius_threshold: 5
    }
  };

  beforeEach(() => {
    dbPath = tmpDbPath();
    db = new GraphDB(dbPath);
    queries = new GraphQueries(db);
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
  });

  it('classifies .db files as database_files', () => {
    const result = classifyFile('data/app.db', queries, defaultConfig);
    assert.ok(result.categories.includes('database_files'));
    assert.equal(result.level, 'ask');
  });

  it('classifies .env files as secret_files', () => {
    const result = classifyFile('.env', queries, defaultConfig);
    assert.ok(result.categories.includes('secret_files'));
    assert.equal(result.level, 'block');
  });

  it('classifies high blast radius files', () => {
    // Create a file imported by 5+ others
    db.registerEdgeType({ name: 'imports', category: 'structural', followsForBlastRadius: true });
    const target = db.upsertNode({ project: 'p', file: 'lib/shared.js', name: 'shared', type: 'module', line: 1 });
    for (let i = 0; i < 6; i++) {
      const src = db.upsertNode({ project: 'p', file: `lib/user${i}.js`, name: `user${i}`, type: 'module', line: 1 });
      db.insertEdge({ sourceId: src, targetId: target, type: 'imports', category: 'structural', sourceProject: 'p', sourceFile: `lib/user${i}.js` });
    }
    const result = classifyFile('lib/shared.js', queries, defaultConfig, 'p');
    assert.ok(result.categories.includes('high_blast_radius'));
  });

  it('returns null for normal files', () => {
    const result = classifyFile('lib/boring.js', queries, defaultConfig);
    assert.equal(result, null);
  });

  it('returns highest alert level when multiple categories match', () => {
    const result = classifyFile('secrets.db.env', queries, defaultConfig);
    // Both database and secret patterns — block wins over ask
    assert.equal(result.level, 'block');
  });

  it('respects config overrides', () => {
    const customConfig = {
      hypothalamus: { ...defaultConfig.hypothalamus, database_files: 'inform' }
    };
    const result = classifyFile('data/app.db', queries, customConfig);
    assert.equal(result.level, 'inform');
  });

  // ── Chunk 8 additions: full-matrix coverage ──────────────────────────────

  // Config builder that sets every category to the same level — lets the
  // matrix tests assert "this file → this category" without worrying about
  // priority resolution across categories.
  function uniformConfig(level, threshold = 5) {
    return {
      hypothalamus: {
        database_files: level,
        secret_files: level,
        high_blast_radius: level,
        config_files: level,
        generated_files: level,
        documented_files: level,
        blast_radius_threshold: threshold,
      }
    };
  }

  function seedBlastRadius(count) {
    db.registerEdgeType({ name: 'imports', category: 'structural', followsForBlastRadius: true });
    const target = db.upsertNode({ project: 'p', file: 'lib/big.js', name: 'big', type: 'module', line: 1 });
    for (let i = 0; i < count; i++) {
      const src = db.upsertNode({ project: 'p', file: `u${i}.js`, name: `u${i}`, type: 'module', line: 1 });
      db.insertEdge({ sourceId: src, targetId: target, type: 'imports', category: 'structural', sourceProject: 'p', sourceFile: `u${i}.js` });
    }
  }

  function seedGenerator() {
    db.registerEdgeType({ name: 'writes_to', category: 'generates' });
    const gen = db.upsertNode({ project: 'p', file: 'scripts/gen.js', name: 'gen', type: 'module', line: 1 });
    const tgt = db.upsertNode({ project: 'p', file: 'out.js', name: 'out', type: 'module', line: 1 });
    db.insertEdge({ sourceId: gen, targetId: tgt, type: 'writes_to', category: 'generates', sourceProject: 'p', sourceFile: 'scripts/gen.js' });
  }

  function seedDocReference() {
    db.registerEdgeType({ name: 'describes', category: 'documentation' });
    const doc = db.upsertNode({ project: 'p', file: 'README.md', name: 'doc', type: 'section', line: 3 });
    const tgt = db.upsertNode({ project: 'p', file: 'lib/api.js', name: 'api', type: 'module', line: 1 });
    db.insertEdge({ sourceId: doc, targetId: tgt, type: 'describes', category: 'documentation', sourceProject: 'p', sourceFile: 'README.md' });
  }

  const levels = ['inform', 'warn', 'ask', 'block'];

  // Category × level matrix — 24 cases via parametrized loop.
  for (const level of levels) {
    it(`database_files at level=${level}`, () => {
      const r = classifyFile('data/app.db', queries, uniformConfig(level));
      assert.ok(r.categories.includes('database_files'));
      assert.equal(r.level, level);
    });
    it(`secret_files at level=${level}`, () => {
      const r = classifyFile('.env', queries, uniformConfig(level));
      assert.ok(r.categories.includes('secret_files'));
      assert.equal(r.level, level);
    });
    it(`config_files at level=${level}`, () => {
      const r = classifyFile('caddyfile', queries, uniformConfig(level));
      assert.ok(r.categories.includes('config_files'));
      assert.equal(r.level, level);
    });
    it(`high_blast_radius at level=${level}`, () => {
      seedBlastRadius(6);
      const r = classifyFile('lib/big.js', queries, uniformConfig(level), 'p');
      assert.ok(r.categories.includes('high_blast_radius'));
      assert.equal(r.level, level);
    });
    it(`generated_files at level=${level}`, () => {
      seedGenerator();
      const r = classifyFile('out.js', queries, uniformConfig(level), 'p');
      assert.ok(r.categories.includes('generated_files'));
      assert.equal(r.level, level);
    });
    it(`documented_files at level=${level}`, () => {
      seedDocReference();
      const r = classifyFile('lib/api.js', queries, uniformConfig(level), 'p');
      assert.ok(r.categories.includes('documented_files'));
      assert.equal(r.level, level);
    });
  }

  it('blast_radius_threshold edge: 4 importers do NOT trigger', () => {
    seedBlastRadius(4);
    const r = classifyFile('lib/big.js', queries, uniformConfig('warn', 5), 'p');
    assert.ok(!r || !r.categories.includes('high_blast_radius'));
  });

  it('blast_radius_threshold edge: 5 importers DO trigger', () => {
    seedBlastRadius(5);
    const r = classifyFile('lib/big.js', queries, uniformConfig('warn', 5), 'p');
    assert.ok(r.categories.includes('high_blast_radius'));
  });

  it('regression: excluded file paths never appear in nodes — policy-engine scope reduction (Task 3.4)', () => {
    // production.env matches *.env in BUILTIN_SECRET_PATTERNS; even if an extractor were added,
    // the scan layer's isExcluded check would prevent it from reaching nodes. This test guards
    // against that invariant breaking: if a node ever appears for production.env, the policy
    // enforcement in file-walker / scan is broken.
    const os = require('os');
    const fs = require('fs');
    const tmpDir = fs.mkdtempSync(require('path').join(os.tmpdir(), 'gm-pe-reg-'));
    try {
      fs.writeFileSync(require('path').join(tmpDir, 'production.env'), 'SECRET=1');
      fs.writeFileSync(require('path').join(tmpDir, 'app.js'), 'module.exports = {};');

      const { extractFiles } = require('../scripts/scan');
      extractFiles({ db, project: 'pe-reg', rootPath: tmpDir, config: {} });

      const rows = db.db.prepare('SELECT * FROM nodes WHERE project = ? AND file = ?').all('pe-reg', 'production.env');
      assert.equal(rows.length, 0, 'production.env must never reach nodes — policy-engine scope reduction regression');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('precedence: block > ask > warn > inform when multiple categories match', () => {
    const mixed = {
      hypothalamus: {
        database_files: 'warn',
        secret_files: 'block',
        high_blast_radius: 'inform',
        config_files: 'ask',
        generated_files: 'inform',
        documented_files: 'inform',
        blast_radius_threshold: 5,
      },
    };
    // secrets.db.env matches both secret_files (block) and database_files (warn)
    const r = classifyFile('secrets.db.env', queries, mixed);
    assert.equal(r.level, 'block');
  });
});
