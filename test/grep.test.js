'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { GraphDB } = require('../lib/graph-db');
const { scanProject } = require('../scripts/scan');
const { grepProject } = require('../scripts/grep');
const { UnknownProjectError } = require('../lib/mcp/errors');

const scriptPath = path.join(__dirname, '..', 'scripts', 'grep.js');

function runCli(args, extraOpts = {}) {
  try {
    return { code: 0, stdout: execFileSync('node', [scriptPath, ...args], { encoding: 'utf8', ...extraOpts }), stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

describe('grep.js CLI', () => {
  let workspace, dbPath;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-grep-'));
    dbPath = path.join(workspace, 'graph.db');

    const projectDir = path.join(workspace, 'demo');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'a.js'),
      "const apiBase = '/api/v1';\nfunction doThing() {\n  fetch(apiBase + '/things');\n}\nmodule.exports = { doThing };\n"
    );
    fs.writeFileSync(path.join(projectDir, 'b.js'),
      "function other() {\n  console.log('hi');\n}\nmodule.exports = { other };\n"
    );

    const db = new GraphDB(dbPath);
    scanProject(projectDir, 'demo', db, {});
    db.close();
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('prints usage and exits 1 when no pattern is given', () => {
    // Run with truly no args; override HOME so DEFAULT_DB doesn't hit the user's real greymatter db.
    const fakeHome = path.join(workspace, 'fake-home');
    fs.mkdirSync(fakeHome, { recursive: true });
    const { code, stdout } = runCli([], {
      env: { ...process.env, HOME: fakeHome },
    });
    assert.equal(code, 1);
    assert.match(stdout, /Usage:/);
  });

  it('returns matches grouped by project', () => {
    const { code, stdout } = runCli([
      'apiBase', '--db', dbPath, '--workspace', workspace,
    ]);
    assert.equal(code, 0);
    assert.match(stdout, /demo \(/);
    assert.match(stdout, /a\.js/);
    assert.match(stdout, /apiBase/);
  });

  it('prints "No matches" with a clear summary when pattern has no hits', () => {
    const { code, stdout } = runCli([
      'zzzz_nothing_matches_this_zzzz',
      '--db', dbPath, '--workspace', workspace,
    ]);
    assert.equal(code, 0);
    assert.match(stdout, /No matches/);
  });

  it('--project filter narrows results', () => {
    const { code, stdout } = runCli([
      'apiBase',
      '--db', dbPath, '--workspace', workspace,
      '--project', 'demo',
    ]);
    assert.equal(code, 0);
    assert.match(stdout, /demo/);
  });

  it('--project with no match exits 1', () => {
    const { code, stderr } = runCli([
      'apiBase',
      '--db', dbPath, '--workspace', workspace,
      '--project', 'notthere',
    ]);
    assert.equal(code, 1);
    assert.match(stderr, /No project matching/);
  });

  it('reports invalid regex cleanly', () => {
    const { code, stderr } = runCli([
      '[unclosed',
      '--db', dbPath, '--workspace', workspace,
    ]);
    assert.equal(code, 1);
    assert.match(stderr, /Invalid regex/);
  });

  it('exits 1 when graph.db has no projects', () => {
    const emptyDbPath = path.join(workspace, 'empty.db');
    const empty = new GraphDB(emptyDbPath);
    empty.close();
    const { code, stderr } = runCli([
      'anything',
      '--db', emptyDbPath, '--workspace', workspace,
    ]);
    assert.equal(code, 1);
    assert.match(stderr, /No projects found/);
  });
});

// ── grepProject library ────────────────────────────────────────────────────────

describe('grepProject library', () => {
  let db, dbPath, root;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `greplib-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = new GraphDB(dbPath);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'greplib-root-'));

    fs.mkdirSync(path.join(root, 'lib'), { recursive: true });

    // File A: verifyToken at line 42
    const fileALines = Array.from({ length: 41 }, (_, i) => `// placeholder line ${i + 1}`);
    fileALines.push('function verifyToken(token) { return true; }');
    fs.writeFileSync(path.join(root, 'lib', 'fileA.js'), fileALines.join('\n'));

    // File B: verifyToken at line 7
    const fileBLines = Array.from({ length: 6 }, (_, i) => `// placeholder line ${i + 1}`);
    fileBLines.push('const result = verifyToken(token);');
    fs.writeFileSync(path.join(root, 'lib', 'fileB.js'), fileBLines.join('\n'));

    db.setProjectRoot('p1', root);
    db.setFileHash('p1', 'lib/fileA.js', 'hashA');
    db.setFileHash('p1', 'lib/fileB.js', 'hashB');
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
    try { fs.rmSync(root, { recursive: true }); } catch {}
  });

  it('returns 2 file entries for verifyToken pattern', () => {
    const results = grepProject(db, 'p1', 'verifyToken');
    assert.equal(results.length, 2);
    const files = results.map(r => r.file).sort();
    assert.ok(files.includes('lib/fileA.js'));
    assert.ok(files.includes('lib/fileB.js'));
  });

  it('each match has line, before, match, after', () => {
    const results = grepProject(db, 'p1', 'verifyToken');
    for (const entry of results) {
      assert.ok(Array.isArray(entry.matches) && entry.matches.length > 0);
      const m = entry.matches[0];
      assert.equal(typeof m.line, 'number');
      assert.ok(Array.isArray(m.before));
      assert.equal(typeof m.match, 'string');
      assert.ok(Array.isArray(m.after));
    }
  });

  it('match occurs at correct line numbers', () => {
    const results = grepProject(db, 'p1', 'verifyToken');
    const byFile = Object.fromEntries(results.map(r => [r.file, r]));
    assert.equal(byFile['lib/fileA.js'].matches[0].line, 42);
    assert.equal(byFile['lib/fileB.js'].matches[0].line, 7);
  });

  it('options.context = 0 produces empty before/after arrays', () => {
    const results = grepProject(db, 'p1', 'verifyToken', { context: 0 });
    for (const entry of results) {
      for (const m of entry.matches) {
        assert.deepEqual(m.before, []);
        assert.deepEqual(m.after, []);
      }
    }
  });

  it('options.maxPerFile truncates matches per file', () => {
    // File with 5 occurrences
    const lines = Array.from({ length: 10 }, (_, i) => `// line ${i}: verifyToken() called`);
    fs.mkdirSync(path.join(root, 'lib2'), { recursive: true });
    fs.writeFileSync(path.join(root, 'lib2', 'multi.js'), lines.join('\n'));
    db.setFileHash('p1', 'lib2/multi.js', 'hashM');

    const results = grepProject(db, 'p1', 'verifyToken', { maxPerFile: 2 });
    const multi = results.find(r => r.file === 'lib2/multi.js');
    assert.ok(multi);
    assert.ok(multi.matches.length <= 2);
  });

  it('pattern treated as regex', () => {
    const results = grepProject(db, 'p1', 'verify\\w+');
    assert.ok(results.length > 0);
    for (const entry of results) {
      for (const m of entry.matches) {
        assert.ok(/verify\w+/.test(m.match));
      }
    }
  });

  it('throws UnknownProjectError for unknown project', () => {
    assert.throws(
      () => grepProject(db, 'no_such_project', 'pattern'),
      (e) => e instanceof UnknownProjectError && e.code === 'UNKNOWN_PROJECT'
    );
  });

  it('options.policy filters excluded files from results', () => {
    const { loadPolicy } = require('../lib/exclusion');
    // extra_patterns excludes 'lib/' — only files under lib/ exist in this project
    const policy = loadPolicy(root, { exclusion: { extra_patterns: ['lib/fileA.js'] } });
    const results = grepProject(db, 'p1', 'verifyToken', { policy });
    const files = results.map(r => r.file);
    assert.ok(!files.includes('lib/fileA.js'), 'excluded file should not appear in results');
    assert.ok(files.includes('lib/fileB.js'), 'included file should still appear');
  });
});
