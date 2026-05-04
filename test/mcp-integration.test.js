'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { GraphDB } = require('../lib/graph-db');
const { scanProject } = require('../scripts/scan');

const SERVER_SCRIPT = path.join(__dirname, '..', 'scripts', 'mcp-server.js');

// Send a JSON-RPC request over stdin and read a response from stdout.
// The server uses newline-delimited JSON-RPC over stdio.
async function rpc(proc, method, params, id = 1) {
  return new Promise((resolve, reject) => {
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n';
    let buffer = '';
    const timeout = setTimeout(() => reject(new Error(`rpc timeout for ${method}`)), 5000);

    function onData(chunk) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        let parsed;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (parsed.id === id) {
          clearTimeout(timeout);
          proc.stdout.removeListener('data', onData);
          resolve(parsed);
          return;
        }
      }
      buffer = lines[lines.length - 1];
    }

    proc.stdout.on('data', onData);
    proc.stdin.write(msg);
  });
}

// Spawn the MCP server, send MCP initialization, return proc
async function spawnServer(env = {}) {
  const proc = spawn('node', [SERVER_SCRIPT], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  // Send MCP initialize handshake
  await rpc(proc, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0.0.1' },
  }, 0);
  // Send initialized notification (no id = notification)
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  return proc;
}

// ── Seeded DB setup ────────────────────────────────────────────────────────────

let tmpDir, dbPath, proc;

function seedDb() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-mcp-'));
  dbPath = path.join(tmpDir, 'graph.db');

  const projectDir = path.join(tmpDir, 'myproj');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, 'auth.js'),
    'function verifyToken(token) {\n  return token !== null;\n}\nmodule.exports = { verifyToken };\n'
  );

  const db = new GraphDB(dbPath);
  scanProject(projectDir, 'myproj', db, {});
  db.close();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MCP integration — full server', () => {
  before(async () => {
    seedDb();
    proc = await spawnServer({ GREYMATTER_GRAPH_DB: dbPath });
  });

  after(async () => {
    if (proc) { proc.stdin.end(); proc.kill(); }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('tools/list returns exactly 9 tools with documented schema', async () => {
    const res = await rpc(proc, 'tools/list', {});
    assert.ok(!res.error, `unexpected error: ${JSON.stringify(res.error)}`);
    const tools = res.result.tools;
    assert.equal(tools.length, 9);
    const names = tools.map(t => t.name).sort();
    assert.deepEqual(names, [
      'find_identifier',
      'get_label_coverage',
      'get_node',
      'get_node_bundle',
      'get_project_overview',
      'get_status',
      'grep_project',
      'query_blast_radius',
      'walk_flow',
    ]);
    for (const t of tools) {
      assert.ok(typeof t.name === 'string');
      assert.ok(typeof t.description === 'string');
      assert.ok(t.inputSchema);
    }
  });

  it('prompts/list returns exactly 3 prompts with documented parameters', async () => {
    const res = await rpc(proc, 'prompts/list', {});
    assert.ok(!res.error, `unexpected error: ${JSON.stringify(res.error)}`);
    const prompts = res.result.prompts;
    assert.equal(prompts.length, 3);
    const names = prompts.map(p => p.name).sort();
    assert.deepEqual(names, ['orient_project', 'safe_to_delete', 'understand_flow']);
    for (const p of prompts) {
      assert.ok(typeof p.description === 'string');
      assert.ok(Array.isArray(p.arguments));
    }
  });

  it('get_status returns documented payload shape with project list', async () => {
    const res = await rpc(proc, 'tools/call', { name: 'get_status', arguments: {} });
    assert.ok(!res.error, `unexpected error: ${JSON.stringify(res.error)}`);
    const data = JSON.parse(res.result.content[0].text);
    assert.ok(data.server && data.server.name === 'greymatter-mcp');
    assert.ok(data.graph_db && data.graph_db.schema_version);
    assert.ok(data.labels);
    assert.ok(Array.isArray(data.projects));
    const myproj = data.projects.find(p => p.name === 'myproj');
    assert.ok(myproj, 'myproj should be in project list');
  });

  it('get_node_bundle returns bundle shape for seeded node', async () => {
    const res = await rpc(proc, 'tools/call', {
      name: 'get_node_bundle',
      arguments: { project: 'myproj', file: 'auth.js', name: 'verifyToken' },
    });
    assert.ok(!res.error, `unexpected error: ${JSON.stringify(res.error)}`);
    const data = JSON.parse(res.result.content[0].text);
    assert.ok(data !== null);
    assert.equal(data.identifier.name, 'verifyToken');
    assert.ok(Array.isArray(data.labels));
    assert.ok(Array.isArray(data.outgoing));
    assert.ok(Array.isArray(data.incoming));
  });

  it('get_node returns null for non-existent node (not an error)', async () => {
    const res = await rpc(proc, 'tools/call', {
      name: 'get_node',
      arguments: { project: 'myproj', file: 'auth.js', name: 'doesNotExist' },
    });
    assert.ok(!res.error, `unexpected error: ${JSON.stringify(res.error)}`);
    const data = JSON.parse(res.result.content[0].text);
    assert.equal(data, null);
  });

  it('invalid tool call returns JSON-RPC error with correct code', async () => {
    const res = await rpc(proc, 'tools/call', {
      name: 'get_project_overview',
      arguments: {},   // missing required 'project'
    });
    // Should return JSON-RPC error (-32602)
    assert.ok(res.error, 'expected an error response');
    assert.equal(res.error.code, -32602);
  });

  it('calling unknown tool returns method-not-found error', async () => {
    const res = await rpc(proc, 'tools/call', { name: 'no_such_tool', arguments: {} });
    assert.ok(res.error, 'expected an error response');
  });

  it('orient_project prompt returns structured text', async () => {
    const res = await rpc(proc, 'prompts/get', {
      name: 'orient_project',
      arguments: { project: 'myproj' },
    });
    assert.ok(!res.error, `unexpected error: ${JSON.stringify(res.error)}`);
    const msg = res.result.messages[0];
    assert.equal(msg.role, 'user');
    assert.match(msg.content.text, /get_project_overview/);
    assert.match(msg.content.text, /myproj/);
  });
});

// ── Missing DB scenario ────────────────────────────────────────────────────────

describe('MCP integration — missing graph.db', () => {
  let missingProc, missingDir, missingDbPath;

  before(async () => {
    // Use a path inside a freshly-created tmpdir so the file is guaranteed absent.
    missingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-missing-'));
    missingDbPath = path.join(missingDir, 'graph.db');
    // Do NOT create the file — the server should detect it's missing.
    missingProc = await spawnServer({ GREYMATTER_GRAPH_DB: missingDbPath });
  });

  after(() => {
    if (missingProc) { missingProc.stdin.end(); missingProc.kill(); }
    try { fs.rmSync(missingDir, { recursive: true, force: true }); } catch {}
  });

  it('get_status succeeds and reports error field when DB is missing', async () => {
    const res = await rpc(missingProc, 'tools/call', { name: 'get_status', arguments: {} });
    assert.ok(!res.error, `unexpected transport error: ${JSON.stringify(res.error)}`);
    const data = JSON.parse(res.result.content[0].text);
    assert.ok(data.server);
    assert.ok(data.graph_db.error, 'graph_db.error should be set when DB is missing');
  });

  it('read tools throw GRAPH_UNAVAILABLE when DB is missing', async () => {
    const res = await rpc(missingProc, 'tools/call', {
      name: 'get_project_overview',
      arguments: { project: 'anything' },
    });
    assert.ok(res.error, 'expected an error response');
    assert.equal(res.error.code, -32000);
    assert.ok(res.error.data?.error_code === 'GRAPH_UNAVAILABLE');
  });
});
