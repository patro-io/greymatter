'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { GraphDB } = require('../lib/graph-db');
const { scanProject } = require('../scripts/scan');

const hookPath = path.join(__dirname, '..', 'hooks', 'post-tool-use.js');

function runHook(stdin, env) {
  return spawnSync('node', [hookPath], {
    input: JSON.stringify(stdin),
    encoding: 'utf8',
    env,
  });
}

describe('post-tool-use hook', () => {
  let home, workspace, projectDir, dbPath;

  beforeEach(() => {
    // Fake $HOME so the hook's DATA_DIR resolves into our tmp
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-ptu-home-'));
    const dataDir = path.join(home, '.claude', 'greymatter');
    fs.mkdirSync(dataDir, { recursive: true });
    dbPath = path.join(dataDir, 'graph.db');

    // Workspace contains the project that the hook will probe when routing a file edit
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-ptu-ws-'));
    projectDir = path.join(workspace, 'demo');
    fs.mkdirSync(projectDir, { recursive: true });

    // Seed the project with one file and scan it into graph.db
    fs.writeFileSync(path.join(projectDir, 'a.js'),
      "function original() { return 1; }\nmodule.exports = { original };\n"
    );
    const db = new GraphDB(dbPath);
    scanProject(projectDir, 'demo', db, {});
    db.close();
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('exits 0 when stdin is not valid JSON', () => {
    const res = spawnSync('node', [hookPath], {
      input: 'not json',
      encoding: 'utf8',
      env: { ...process.env, HOME: home, CLAUDE_WORKSPACE: workspace },
    });
    assert.equal(res.status, 0);
  });

  it('exits 0 when file_path is missing', () => {
    const res = runHook({}, { ...process.env, HOME: home, CLAUDE_WORKSPACE: workspace });
    assert.equal(res.status, 0);
  });

  it('exits 0 on a relative path (rejected)', () => {
    const res = runHook({ file_path: 'relative/path.js' }, { ...process.env, HOME: home, CLAUDE_WORKSPACE: workspace });
    assert.equal(res.status, 0);
  });

  it('exits 0 on a non-extracted extension', () => {
    fs.writeFileSync(path.join(projectDir, 'image.png'), 'x');
    const res = runHook(
      { file_path: path.join(projectDir, 'image.png') },
      { ...process.env, HOME: home, CLAUDE_WORKSPACE: workspace }
    );
    assert.equal(res.status, 0);
  });

  it('re-extracts a file after edit and updates the graph incrementally', () => {
    // Edit the file — add a new function
    fs.writeFileSync(path.join(projectDir, 'a.js'),
      "function original() { return 1; }\nfunction added() { return 2; }\nmodule.exports = { original, added };\n"
    );

    const res = runHook(
      { file_path: path.join(projectDir, 'a.js') },
      { ...process.env, HOME: home, CLAUDE_WORKSPACE: workspace }
    );
    assert.equal(res.status, 0, `hook failed: ${res.stderr}`);

    // Verify the new node landed in graph.db
    const db = new GraphDB(dbPath);
    try {
      const row = db.db.prepare("SELECT name FROM nodes WHERE project = 'demo' AND name = 'added'").get();
      assert.ok(row, `expected node "added" to be re-extracted into graph (stderr: ${res.stderr})`);
    } finally {
      db.close();
    }
  });

  it('is a no-op when file content is unchanged (hash matches)', () => {
    // Stat the file first, then invoke the hook without changing content
    const beforeNodes = (() => {
      const db = new GraphDB(dbPath);
      try {
        return db.db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE project = 'demo'").get().c;
      } finally { db.close(); }
    })();

    const res = runHook(
      { file_path: path.join(projectDir, 'a.js') },
      { ...process.env, HOME: home, CLAUDE_WORKSPACE: workspace }
    );
    assert.equal(res.status, 0);

    const afterNodes = (() => {
      const db = new GraphDB(dbPath);
      try {
        return db.db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE project = 'demo'").get().c;
      } finally { db.close(); }
    })();
    assert.equal(afterNodes, beforeNodes, 'node count should be unchanged on hash match');
  });

  it('exits 0 silently when graph.db does not exist', () => {
    fs.unlinkSync(dbPath);
    const res = runHook(
      { file_path: path.join(projectDir, 'a.js') },
      { ...process.env, HOME: home, CLAUDE_WORKSPACE: workspace }
    );
    assert.equal(res.status, 0);
  });

  it('exits 0 when the file is outside any known project directory', () => {
    const stray = path.join(workspace, 'stray.js');
    fs.writeFileSync(stray, '//');
    const res = runHook(
      { file_path: stray },
      { ...process.env, HOME: home, CLAUDE_WORKSPACE: workspace }
    );
    // Should exit 0 without touching the graph
    assert.equal(res.status, 0);
  });
});
