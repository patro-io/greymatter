'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { MemoryDB } = require('../lib/memory-db');
const { MemoryQueries } = require('../lib/memory-queries');

function tmpDbPath() {
  return path.join(__dirname, `test-search-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe('conversation search', () => {
  let db, queries, dbPath;

  beforeEach(() => {
    dbPath = tmpDbPath();
    db = new MemoryDB(dbPath);
    queries = new MemoryQueries(db);
    // Seed test data: two sessions with searchable content
    db.insertSession('s1', '2026-04-10T10:00:00', ['projectA']);
    const w1 = db.insertWindow('s1', 0, { scope: 'projectA', summary: 'worked on auth' });
    db.insertSearchTerms(w1, ['auth', 'login', 'session', 'cookie'], ['secureCookieOptions', 'bcrypt']);
    db.insertDecisions(w1, [{ summary: 'Use bcrypt with 12 rounds', terms: 'bcrypt,auth', status: 'active' }]);

    db.insertSession('s2', '2026-04-11T14:00:00', ['projectB']);
    const w2 = db.insertWindow('s2', 0, { scope: 'projectB', summary: 'database migration' });
    db.insertSearchTerms(w2, ['database', 'migration', 'schema'], ['ALTER', 'sqlite']);
    db.insertDecisions(w2, [{ summary: 'Add index on company_id', terms: 'index,schema', status: 'active' }]);

    // Recall is indexed across every project at once, so the only thing tying a window
    // to a project is the absolute paths it touched. sessions.projects_json exists but
    // is empty for every real session on record (903/903 measured 2026-09-14), which is
    // why the filter reads window_files instead.
    db.insertWindowFiles(w1, [{ filePath: '/home/github/projectA/src/auth.ts' }]);
    db.insertWindowFiles(w2, [{ filePath: '/home/github/projectB/db/schema.sql' }]);
    // Deliberate trap: a sibling whose root is a string prefix of projectB's. An
    // unanchored LIKE would let this leak into a projectB-filtered search.
    db.insertSession('s3', '2026-04-12T09:00:00', ['projectB-cms']);
    const w3 = db.insertWindow('s3', 0, { scope: 'projectB-cms', summary: 'cms database work' });
    db.insertSearchTerms(w3, ['database', 'migration', 'cms'], ['ALTER']);
    db.insertWindowFiles(w3, [{ filePath: '/home/github/projectB-cms/db/schema.sql' }]);
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
  });

  // Regression, 2026-09-14. Recall had no project filter at all, so a generic term from
  // a sprint slug ("gate", "plugin") routinely surfaced decisions from a different repo —
  // 13 such digests in one devstack orientation. The priming step then read as project
  // context while describing someone else's work.
  it('filters to windows that touched the given project', () => {
    const all = queries.searchConversations([['database']]);
    assert.ok(all.length >= 2, 'sanity: unfiltered search sees both projectB and projectB-cms');

    const results = queries.searchConversations([['database']], null,
      { pathPrefixes: ['/home/github/projectB'] });
    assert.equal(results.length, 1, 'only the projectB window survives the filter');
    assert.equal(results[0].session_id, 's2');
  });

  it('does not leak a sibling project sharing a path prefix', () => {
    const results = queries.searchConversations([['database']], null,
      { pathPrefixes: ['/home/github/projectB'] });
    const ids = results.map(r => r.session_id);
    assert.ok(!ids.includes('s3'),
      'projectB-cms must not match a projectB filter — the LIKE has to be anchored with a slash');
  });

  it('no pathPrefixes means no filtering', () => {
    const withEmpty = queries.searchConversations([['database']], null, { pathPrefixes: [] });
    const without = queries.searchConversations([['database']]);
    assert.equal(withEmpty.length, without.length, 'an empty filter must not hide anything');
  });

  it('searches by single term', () => {
    const results = queries.searchConversations([['auth']]);
    assert.ok(results.length >= 1);
    assert.equal(results[0].session_id, 's1');
  });

  it('OR terms within a cluster broaden results', () => {
    const results = queries.searchConversations([['auth', 'database']]);
    assert.ok(results.length >= 2);
  });

  it('multiple clusters narrow results (AND)', () => {
    const results = queries.searchConversations([['auth'], ['bcrypt']]);
    assert.ok(results.length >= 1);
    assert.ok(results.every(r => r.session_id === 's1'));
  });

  it('results include decision digests', () => {
    const results = queries.searchConversations([['auth']]);
    assert.ok(results[0].decisions);
    assert.ok(results[0].decisions.length >= 1);
  });

  it('limit caps results', () => {
    const results = queries.searchConversations([['auth', 'database']], 1);
    assert.equal(results.length, 1);
  });
});
