'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { GraphDB } = require('../lib/graph-db');
const { scanProject } = require('../scripts/scan');
const { run } = require('../hooks/session-start');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gm-e2e-'));
}

function captureOutput(fn) {
  const stderrChunks = [];
  const stdoutChunks = [];
  const origStderr = process.stderr.write.bind(process.stderr);
  const origStdout = process.stdout.write.bind(process.stdout);
  process.stderr.write = (data) => { stderrChunks.push(String(data)); return true; };
  process.stdout.write = (data) => { stdoutChunks.push(String(data)); return true; };
  try {
    fn();
  } finally {
    process.stderr.write = origStderr;
    process.stdout.write = origStdout;
  }
  return { stderr: stderrChunks.join(''), stdout: stdoutChunks.join('') };
}

function writeJsFile(dir, name) {
  const base = name.replace('.js', '');
  fs.writeFileSync(
    path.join(dir, name),
    `'use strict';\nfunction ${base}() { return '${base}'; }\nmodule.exports = { ${base} };\n`
  );
}

function gitExec(args, cwd) {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
}

// ─── Task 3.3 + Acceptance Criterion 1: Deletion ─────────────────────────────

describe('reconcile-hook e2e', () => {
  test('Task 3.3 + Criterion 1 — deletion: purged rows disappear, one log line emitted', () => {
    const dataDir = makeTmpDir();
    const rulesDir = makeTmpDir();
    const projectDir = makeTmpDir();

    try {
      writeJsFile(projectDir, 'alpha.js');
      writeJsFile(projectDir, 'beta.js');
      writeJsFile(projectDir, 'gamma.js');

      const dbPath = path.join(dataDir, 'graph.db');
      const db = new GraphDB(dbPath);
      scanProject(projectDir, 'testpkg', db, {});
      db.setProjectRoot('testpkg', projectDir);
      db.close();

      // Verify beta.js was indexed before deleting it
      const dbCheck = new GraphDB(dbPath);
      const beforeHash = dbCheck.db.prepare(
        'SELECT * FROM file_hashes WHERE project = ? AND file = ?'
      ).get('testpkg', 'beta.js');
      dbCheck.close();
      assert.ok(beforeHash, 'beta.js should be in file_hashes before deletion');

      fs.unlinkSync(path.join(projectDir, 'beta.js'));

      const { stderr } = captureOutput(() => run({ dataDir, rulesDir }));

      assert.match(stderr, /\[reconcile\] testpkg: purged 1 missing file/,
        'stderr should contain purge log line');

      const db2 = new GraphDB(dbPath);
      const hashRow = db2.db.prepare(
        'SELECT * FROM file_hashes WHERE project = ? AND file = ?'
      ).get('testpkg', 'beta.js');
      const nodeRows = db2.db.prepare(
        'SELECT * FROM nodes WHERE project = ? AND file = ?'
      ).all('testpkg', 'beta.js');
      db2.close();

      assert.equal(hashRow, undefined, 'file_hashes row for beta.js should be gone');
      assert.equal(nodeRows.length, 0, 'nodes rows for beta.js should be gone');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(rulesDir, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  // ─── Acceptance Criterion 2: Modification (git-diff + mtime) ─────────────

  test('Criterion 2 — modification: git-changed + mtime-changed files both re-extracted', () => {
    const dataDir = makeTmpDir();
    const rulesDir = makeTmpDir();
    const projectDir = makeTmpDir();

    try {
      // Init git repo
      gitExec(['init', projectDir], os.tmpdir());
      gitExec(['-C', projectDir, 'config', 'user.email', 'test@test.com'], projectDir);
      gitExec(['-C', projectDir, 'config', 'user.name', 'Test'], projectDir);

      writeJsFile(projectDir, 'file1.js');
      writeJsFile(projectDir, 'file2.js');
      gitExec(['-C', projectDir, 'add', '.'], projectDir);
      gitExec(['-C', projectDir, 'commit', '-m', 'initial'], projectDir);

      const sha1 = execFileSync('git', ['-C', projectDir, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        stdio: 'pipe',
      }).trim();

      const dbPath = path.join(dataDir, 'graph.db');
      const db = new GraphDB(dbPath);
      scanProject(projectDir, 'gitpkg', db, {});
      db.setProjectRoot('gitpkg', projectDir);
      db.updateLastScanSha('gitpkg', sha1);
      // Set file2's updated_at to the past so mtime check triggers
      db.db.prepare(
        "UPDATE file_hashes SET updated_at = '2020-01-01 00:00:00.000' WHERE project = ? AND file = ?"
      ).run('gitpkg', 'file2.js');
      db.close();

      // Commit a change to file1 (git-diff source)
      fs.writeFileSync(
        path.join(projectDir, 'file1.js'),
        `'use strict';\nfunction file1Modified() { return 'modified'; }\nmodule.exports = { file1Modified };\n`
      );
      gitExec(['-C', projectDir, 'add', 'file1.js'], projectDir);
      gitExec(['-C', projectDir, 'commit', '-m', 'change file1'], projectDir);

      const { stderr } = captureOutput(() => run({ dataDir, rulesDir }));

      assert.match(stderr, /\[reconcile\] gitpkg: re-extracted 2 changed files/,
        'stderr should report re-extraction of both files');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(rulesDir, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  // ─── Acceptance Criterion 3: Clean fast-path (SEPARATE test — no purge work) ─

  // Criterion 3 MUST be a separate test from deletion/modification — those have purge
  // work and would fail the timing assertion. Two sub-scenarios:
  //   (a) no [reconcile] output via hook invocation
  //   (b) reconcileAll itself completes under 50ms — timed directly, not via hook,
  //       because the full hook also runs ingest / signals / reorientation which add
  //       latency that varies under parallel-suite load.
  test('Criterion 3 — clean fast-path: no reconcile output, reconcileAll under 50ms', () => {
    const dataDir = makeTmpDir();
    const rulesDir = makeTmpDir();
    const projectDir = makeTmpDir();

    try {
      // No git repo — git diff is skipped
      writeJsFile(projectDir, 'clean1.js');
      writeJsFile(projectDir, 'clean2.js');

      const dbPath = path.join(dataDir, 'graph.db');
      const db = new GraphDB(dbPath);
      scanProject(projectDir, 'cleanpkg', db, {});
      db.setProjectRoot('cleanpkg', projectDir);
      // Push updated_at 1 hour into the future so mtime check doesn't trigger
      db.db.prepare(
        "UPDATE file_hashes SET updated_at = strftime('%Y-%m-%d %H:%M:%f', datetime('now', '+1 hour')) WHERE project = ?"
      ).run('cleanpkg');
      db.close();

      // (a) No [reconcile] output via hook
      const { stderr } = captureOutput(() => run({ dataDir, rulesDir }));
      const reconcileLines = stderr.split('\n').filter(l => l.includes('[reconcile]'));
      assert.equal(reconcileLines.length, 0, `expected no [reconcile] output, got: ${reconcileLines.join('; ')}`);

      // (b) reconcileAll fast-path timing — open a fresh handle, time the call directly
      const { reconcileAll } = require('../lib/reconcile');
      const db2 = new GraphDB(dbPath);
      try {
        const loggedLines = [];
        const t0 = performance.now();
        reconcileAll({ db: db2, logger: (l) => loggedLines.push(l) });
        const elapsed = performance.now() - t0;
        assert.equal(loggedLines.length, 0, 'reconcileAll should produce no log lines on a clean project');
        assert.ok(elapsed < 50, `reconcileAll should complete in under 50ms on a clean project, took ${elapsed.toFixed(1)}ms`);
      } finally {
        db2.close();
      }
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(rulesDir, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  // ─── Acceptance Criterion 4: NULL root_path ──────────────────────────────

  test('Criterion 4 — NULL root_path: warning line emitted, other projects unaffected', () => {
    const dataDir = makeTmpDir();
    const rulesDir = makeTmpDir();
    const projectDir = makeTmpDir();

    try {
      // Seed a normal rooted project
      writeJsFile(projectDir, 'rooted.js');
      const dbPath = path.join(dataDir, 'graph.db');
      const db = new GraphDB(dbPath);
      scanProject(projectDir, 'rootedpkg', db, {});
      db.setProjectRoot('rootedpkg', projectDir);
      // Seed an orphan project with NULL root_path
      db.db.prepare(
        "INSERT INTO project_scan_state (project, root_path) VALUES ('orphan', NULL)"
      ).run();
      db.close();

      const { stderr } = captureOutput(() => run({ dataDir, rulesDir }));

      assert.match(
        stderr,
        /\[reconcile\] 1 project\(s\) have no root_path; run a fresh scan to register: orphan/,
        'stderr should list the orphan project'
      );
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(rulesDir, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  // ─── Acceptance Criterion 5: Error containment ───────────────────────────

  test('Criterion 5 — error containment: hook logs error and continues to step 10', () => {
    const dataDir = makeTmpDir();
    const rulesDir = makeTmpDir();

    // Ensure graph.db exists so reconcile block is entered and step 10 runs
    const dbPath = path.join(dataDir, 'graph.db');
    const db = new GraphDB(dbPath);
    db.close();

    // Resolve the absolute cache key for lib/reconcile
    const reconcilePath = require.resolve('../lib/reconcile');
    // Ensure it's loaded so the cache entry exists
    require(reconcilePath);
    const origExports = require.cache[reconcilePath].exports;

    // Override to throw
    require.cache[reconcilePath].exports = {
      reconcileAll: () => { throw new Error('forced test failure'); },
    };

    let stderr, stdout;
    try {
      ({ stderr, stdout } = captureOutput(() => run({ dataDir, rulesDir })));
    } finally {
      // Restore original exports before any assertion throws
      require.cache[reconcilePath].exports = origExports;
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(rulesDir, { recursive: true, force: true });
    }

    assert.match(stderr, /\[reconcile\] failed: forced test failure/,
      'stderr should contain the error message');
    assert.match(stdout, /Projects:/,
      'step 10 project-list output should still appear on stdout');
  });
});
