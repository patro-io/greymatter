'use strict';

// Tests for hooks/bootstrap-deps.sh — the SessionStart hook that puts a node_modules
// tree into the plugin data dir.
//
// Regression, measured 2026-09-12. The script treated DATA/package.json as a
// "already done" marker but stamped it on a path that installed nothing into DATA:
// when it ran from a repo checkout, the checkout's own node_modules satisfied the
// shortcut, the marker got written, and DATA stayed empty. A repo checkout resolves
// through ROOT/../node_modules and never needs DATA, so nothing broke there — but the
// cache-installed MCP server resolves ONLY through DATA. Every later run then found a
// matching marker and exited 0, so the MCP server never got its dependencies and
// failed to connect permanently, while bootstrap reported success each time.
//
// npm is not invoked here: these tests drive the branch logic with a fake ROOT, so
// they are fast and offline. The rule under test is "never stamp the marker for a
// tree you did not populate".

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'hooks', 'bootstrap-deps.sh');
const PKG = JSON.stringify({ name: 'greymatter', dependencies: { 'better-sqlite3': '^12.0.0' } });

describe('bootstrap-deps.sh marker discipline', () => {
  let tmp, root, data;

  // Builds a fake plugin root. `withDeps` decides whether it ships node_modules.
  function makeRoot(name, withDeps) {
    const r = path.join(tmp, name);
    fs.mkdirSync(path.join(r, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(r, 'package.json'), PKG);
    fs.copyFileSync(SCRIPT, path.join(r, 'hooks', 'bootstrap-deps.sh'));
    if (withDeps) {
      const bs = path.join(r, 'node_modules', 'better-sqlite3');
      fs.mkdirSync(bs, { recursive: true });
      fs.writeFileSync(path.join(bs, 'package.json'), '{"name":"better-sqlite3"}');
    }
    return r;
  }

  // Runs the hook with CLAUDE_PLUGIN_DATA pointed at the test dir. npm is forced to
  // fail so the staging path cannot reach the network; the script is documented to
  // keep the existing tree and exit 0 when install fails, which is what we assert on.
  function run(rootDir) {
    const bin = path.join(tmp, 'bin');
    return execFileSync('bash', [path.join(rootDir, 'hooks', 'bootstrap-deps.sh')], {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  const dataHasTree = () => fs.existsSync(path.join(data, 'node_modules', 'better-sqlite3', 'package.json'));
  const markerWritten = () => fs.existsSync(path.join(data, 'package.json'));

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-bootstrap-'));
    data = path.join(tmp, 'data');
    root = makeRoot('checkout', true);
    // Fake npm that always fails — keeps the test offline. The script must then leave
    // the marker unwritten so a later run retries, rather than recording false success.
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nexit 1\n');
    fs.chmodSync(path.join(bin, 'npm'), 0o755);
  });

  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true }); } catch {}
  });

  it('does not stamp the marker when DATA was left empty', () => {
    run(root);
    assert.equal(dataHasTree(), false, 'sanity: fake npm fails, so no tree can appear');
    assert.equal(markerWritten(), false,
      'marker must not be written for a tree that was never populated — that is what blocked the install permanently');
  });

  it('a later run from the cache root still attempts the install', () => {
    run(root);                                   // repo checkout first
    const cache = makeRoot('cache', false);      // cache install ships no node_modules
    const out = run(cache);
    // With the bug, the run exited silently at the marker check and never reached npm.
    assert.match(out + '', /keeping existing node_modules|^$/,
      'the cache run must reach the install path instead of exiting early on a stale marker');
    assert.equal(markerWritten(), false, 'a failed install must leave the marker unwritten so the next session retries');
  });

  it('skips work when DATA already holds a usable tree', () => {
    const bs = path.join(data, 'node_modules', 'better-sqlite3');
    fs.mkdirSync(bs, { recursive: true });
    fs.writeFileSync(path.join(bs, 'package.json'), '{"name":"better-sqlite3"}');
    run(root);
    assert.equal(markerWritten(), true, 'marker is correct once DATA is genuinely populated');
    // Second pass must be a no-op: fake npm would fail, so reaching install would show.
    assert.doesNotThrow(() => run(root), 'a populated DATA means no reinstall attempt');
    assert.equal(dataHasTree(), true, 'existing tree is left intact');
  });

  it('never exits non-zero — a bootstrap failure must not block the session', () => {
    const cache = makeRoot('cache-only', false);
    assert.doesNotThrow(() => run(cache), 'hook must exit 0 even when it cannot install');
  });

  // Regression, measured 2026-09-12. Two sessions starting at once ran this hook twice
  // within the same second and both staged into the same `.staging` path — npm logs show
  // one run `exit 0` and the other `exit -39` on the identical cwd. Each run's
  // `rm -rf "$STAGE"` wiped the other's tree mid-install, so both finished with nothing
  // and DATA stayed empty. The user had reinstalled the plugin and restarted the session
  // and the MCP server was still dependency-less, because the failure is a race: it hit
  // 2 of 3 attempts before the fix, and looked like "sometimes it works".
  it('two concurrent runs still populate DATA exactly once', () => {
    // Succeeding fake npm — writes the tree the real install would produce. Keeps the
    // test offline, and slow enough that the two runs genuinely overlap.
    const bin = path.join(tmp, 'bin');
    fs.writeFileSync(path.join(bin, 'npm'), [
      '#!/bin/sh',
      'sleep 0.4',
      'mkdir -p node_modules/better-sqlite3',
      'printf \'{"name":"better-sqlite3"}\' > node_modules/better-sqlite3/package.json',
      'mkdir -p node_modules/@modelcontextprotocol/sdk',
      'printf \'{"name":"@modelcontextprotocol/sdk"}\' > node_modules/@modelcontextprotocol/sdk/package.json',
      'exit 0',
    ].join('\n'));
    fs.chmodSync(path.join(bin, 'npm'), 0o755);
    // The load check runs `node -e "require(...)"` against the staged tree; the stub
    // packages above are not loadable, so point it at a node that just succeeds.
    fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(bin, 'node'), 0o755);

    const cache = makeRoot('cache-race', false);
    const script = path.join(cache, 'hooks', 'bootstrap-deps.sh');
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, PATH: `${bin}${path.delimiter}${process.env.PATH}` };

    // The second run is launched mid-install, not simultaneously. Firing both at once
    // is a coin flip — whichever finishes last swaps in a good tree and the test passes
    // on broken code (measured: caught it only ~3 times in 5). Staggering by 0.2s while
    // the fake install takes 0.4s puts the second run's `rm -rf` squarely inside the
    // first one's window, which is the real-world case: two sessions starting seconds
    // apart. Three rounds, because timing on a loaded machine still drifts.
    for (let round = 1; round <= 3; round++) {
      fs.rmSync(data, { recursive: true, force: true });
      execFileSync('bash', ['-c',
        `bash "${script}" >/dev/null 2>&1 & sleep 0.2; bash "${script}" >/dev/null 2>&1 & wait`,
      ], { env, encoding: 'utf8' });

      assert.equal(dataHasTree(), true,
        `round ${round}: concurrent runs must not destroy each other — DATA has to end up populated`);
      const leftovers = fs.readdirSync(data).filter(n => n.startsWith('.staging') || n === '.bootstrap.lock');
      assert.deepEqual(leftovers, [],
        `round ${round}: lock and staging dirs must be cleaned up; a leaked lock stalls every later run`);
    }
  });
});
