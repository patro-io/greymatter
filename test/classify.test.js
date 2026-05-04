'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { GraphDB } = require('../lib/graph-db');
const { scanProject } = require('../scripts/scan');

const scriptPath = path.join(__dirname, '..', 'scripts', 'classify.js');

function runCli(args, opts = {}) {
  try {
    const out = execFileSync('node', [scriptPath, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
    return { code: 0, stdout: out, stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

describe('classify.js CLI', () => {
  let workspace, dbPath, db;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-classify-'));
    dbPath = path.join(workspace, 'graph.db');
    db = new GraphDB(dbPath);

    // Build a minimal project on disk + in graph.db so classify has something to scan
    const projectDir = path.join(workspace, 'demo');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'a.js'),
      "function doThing() {\n  fetch('/api/x');\n}\nmodule.exports = { doThing };\n"
    );
    fs.writeFileSync(path.join(projectDir, 'b.js'),
      "function other() {\n  console.log('hi');\n}\nmodule.exports = { other };\n"
    );
    scanProject(projectDir, 'demo', db, {});
    db.close();
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('exits 1 with "Failed to read config" when the config file is unreadable as JSON', () => {
    // classify.js picks up the first non-"--" arg as the config file path.
    // Pointing it at graph.db (valid file, invalid JSON) triggers the parse-error branch.
    const { code, stderr } = runCli(['--db', dbPath, '--workspace', workspace, dbPath]);
    assert.equal(code, 1);
    assert.match(stderr, /Failed to read config/);
  });

  it('--inline classifies matches across the known project', () => {
    const { code, stdout } = runCli([
      '--inline', 'fetch=fetch', 'log=console\\.log',
      '--db', dbPath, '--workspace', workspace, '--no-snippets',
    ]);
    assert.equal(code, 0);
    assert.match(stdout, /Inline classification/);
    assert.match(stdout, /fetch/);
    assert.match(stdout, /log/);
    assert.match(stdout, /1 files scanned across 1 projects|2 files scanned across 1 projects/);
  });

  it('--inline rejects a malformed variant', () => {
    const { code, stderr } = runCli([
      '--inline', 'missing_equals',
      '--db', dbPath, '--workspace', workspace,
    ]);
    assert.equal(code, 1);
    assert.match(stderr, /Inline variant must be label=pattern/);
  });

  it('--inline rejects when no variants are passed', () => {
    const { code, stderr } = runCli([
      '--inline',
      '--db', dbPath, '--workspace', workspace,
    ]);
    assert.equal(code, 1);
    assert.match(stderr, /No variants provided/);
  });

  it('rejects an invalid regex with a clear error', () => {
    const { code, stderr } = runCli([
      '--inline', 'bad=[unclosed',
      '--db', dbPath, '--workspace', workspace,
    ]);
    assert.equal(code, 1);
    assert.match(stderr, /Invalid regex for "bad"/);
  });

  it('exits 1 when the graph.db has no projects', () => {
    const emptyDbPath = path.join(workspace, 'empty.db');
    const emptyDb = new GraphDB(emptyDbPath);
    emptyDb.close();
    const { code, stderr } = runCli([
      '--inline', 'x=foo',
      '--db', emptyDbPath, '--workspace', workspace,
    ]);
    assert.equal(code, 1);
    assert.match(stderr, /No projects found/);
  });

  it('--project filter that matches no project exits 1', () => {
    const { code, stderr } = runCli([
      '--inline', 'x=foo',
      '--db', dbPath, '--workspace', workspace,
      '--project', 'nonexistent',
    ]);
    assert.equal(code, 1);
    assert.match(stderr, /No project matching/);
  });
});
