'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ignore = require('ignore');

// Built-in skip directories. Trailing slash so `ignore` treats them as dirs.
// Case-insensitive: the `ignore` library defaults ignoreCase=true, so
// 'archived/' also matches 'Archived/', 'ARCHIVED/', etc.
const BUILTIN_SKIP_DIRS = [
  'node_modules/', '.git/', '.next/', 'dist/', 'build/', '.cache/',
  'coverage/', '.nyc_output/', '__pycache__/', '.venv/', 'vendor/',
  'archived/',
];

// Built-in secret-file patterns. Match anywhere in the tree.
const BUILTIN_SECRET_PATTERNS = [
  '*.env', '*.key', '*.pem', '*.p12', '*.pfx', 'id_rsa*', '*.crt', '*.csr',
];

const BUILTIN_PATTERNS = [...BUILTIN_SKIP_DIRS, ...BUILTIN_SECRET_PATTERNS];

// Read a gitignore-style file and return its lines (filter blanks/comments).
// Returns [] if the file does not exist or cannot be read.
function readIgnoreFile(absPath) {
  try {
    return fs.readFileSync(absPath, 'utf8')
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.length > 0 && !l.startsWith('#'));
  } catch {
    return [];
  }
}

// Walk projectRoot recursively to find every .gitignore file, skipping common
// vendor/build dirs so we don't traverse node_modules. Returns a list of
// { dir, lines } where dir is relative to projectRoot ('' for root).
function findNestedGitignores(projectRoot) {
  const results = [];
  const SKIP_TRAVERSAL = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache', '.venv', 'vendor', '__pycache__']);

  function walk(absDir, relDir) {
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.isFile() && e.name === '.gitignore') {
        results.push({ dir: relDir, lines: readIgnoreFile(path.join(absDir, '.gitignore')) });
      }
    }
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_TRAVERSAL.has(e.name)) {
        const next = relDir ? `${relDir}/${e.name}` : e.name;
        walk(path.join(absDir, e.name), next);
      }
    }
  }
  walk(projectRoot, '');
  return results;
}

// Convert a single gitignore pattern from a nested .gitignore into a pattern
// anchored at the project root. Handles negation (!), absolute-anchored (/foo),
// and trailing slashes.
function reanchorPattern(pattern, dirRel) {
  if (!dirRel) return pattern; // root .gitignore — no rewrite
  const negated = pattern.startsWith('!');
  const body = negated ? pattern.slice(1) : pattern;
  // Anchored to nested-file dir: drop leading slash, prefix with dirRel
  // Otherwise gitignore semantics let it match anywhere under dirRel — emulate
  // with a `dirRel/**/<body>` form when body has no slash, or `dirRel/<body>` when it does.
  let rewritten;
  if (body.startsWith('/')) {
    rewritten = `${dirRel}${body}`; // /foo at sub/.gitignore → sub/foo
  } else if (body.includes('/')) {
    rewritten = `${dirRel}/${body}`;
  } else {
    // Pattern like "foo" in sub/.gitignore matches sub/**/foo
    rewritten = `${dirRel}/**/${body}`;
  }
  return negated ? `!${rewritten}` : rewritten;
}

// Resolve all sources, return policy object (per spec L186-L213).
function loadPolicy(projectRoot, config) {
  const cfg = (config && config.exclusion) || {};
  const respectGitignore = !!cfg.respect_gitignore;
  const respectGreymatterignore = cfg.respect_greymatterignore !== false; // default true
  const extraPatterns = Array.isArray(cfg.extra_patterns) ? cfg.extra_patterns : [];

  const patterns = [];
  for (const p of BUILTIN_PATTERNS) patterns.push({ pattern: p, source: 'builtin' });

  if (respectGitignore) {
    for (const { dir, lines } of findNestedGitignores(projectRoot)) {
      for (const line of lines) {
        patterns.push({ pattern: reanchorPattern(line, dir), source: 'gitignore' });
      }
    }
  }

  if (respectGreymatterignore) {
    const lines = readIgnoreFile(path.join(projectRoot, '.greymatterignore'));
    for (const line of lines) patterns.push({ pattern: line, source: 'greymatterignore' });
  }

  for (const p of extraPatterns) patterns.push({ pattern: p, source: 'config' });

  // Build the engine in priority order. `ignore` evaluates rules in the order
  // they were added; later rules override earlier ones, which gives us the
  // built-ins → gitignore → greymatterignore → config precedence with
  // negation working across boundaries.
  const ignoreEngine = ignore();
  for (const { pattern } of patterns) ignoreEngine.add(pattern);

  const hash = canonicalHash({ patterns, respectGitignore, respectGreymatterignore });

  return {
    projectRoot,
    patterns,
    respectGitignore,
    respectGreymatterignore,
    ignoreEngine,
    hash,
  };
}

// Stable hash: sort by (source, pattern), then JSON-stringify with the
// boolean flags so toggling a flag also changes the hash.
function canonicalHash({ patterns, respectGitignore, respectGreymatterignore }) {
  const sorted = [...patterns].sort((a, b) => {
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    return a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0;
  });
  const canonical = JSON.stringify({ patterns: sorted, respectGitignore, respectGreymatterignore });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

// Path-level predicate. Resolves symlinks and treats out-of-tree targets
// (and broken symlinks) as excluded.
function isExcluded(absPath, policy) {
  // Distinguish broken symlink (fail-closed) from non-existent regular path
  // (proceed with pattern check). lstat doesn't follow the link.
  let isSymlink = false;
  try {
    isSymlink = fs.lstatSync(absPath).isSymbolicLink();
  } catch {
    // Path doesn't exist at all — fall through to pattern check on absPath.
  }

  let real = absPath;
  if (isSymlink) {
    try {
      real = fs.realpathSync(absPath);
    } catch {
      return true; // broken symlink — fail-closed
    }
  }

  const rel = path.relative(policy.projectRoot, real);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    // Outside project root → excluded.
    return true;
  }
  // `ignore` requires forward slashes regardless of platform.
  const posixRel = rel.split(path.sep).join('/');
  return policy.ignoreEngine.ignores(posixRel);
}

// Hard-delete every node/edge/label/observation rooted at any currently-
// excluded path (per spec L274-L298). Returns counts. Edges and code_labels
// cascade from nodes via FK, so we pre-count what will cascade then delete
// nodes once.
function purgeExcluded(db, project, policy) {
  const txn = db.db.transaction(() => {
    // Union nodes and file_hashes — a file may have a hash row but no nodes
    // (e.g., extension-less or extractor-empty), and leaving stale hashes
    // makes re-included files look unchanged on the next scan.
    const files = db.db.prepare(`
      SELECT file FROM nodes WHERE project = ?
      UNION
      SELECT file FROM file_hashes WHERE project = ?
    `).all(project, project);
    const counts = {
      files_purged: 0,
      nodes_purged: 0,
      edges_purged: 0,
      labels_purged: 0,
      hashes_purged: 0,
      observations_purged: 0, // node_observations table not yet shipped — always 0 today
    };
    const countLabelsStmt = db.db.prepare(`
      SELECT COUNT(*) AS n FROM code_labels
      WHERE node_id IN (SELECT id FROM nodes WHERE project = ? AND file = ?)
    `);
    const countEdgesStmt = db.db.prepare(`
      SELECT COUNT(*) AS n FROM edges
      WHERE source_id IN (SELECT id FROM nodes WHERE project = ? AND file = ?)
         OR target_id IN (SELECT id FROM nodes WHERE project = ? AND file = ?)
    `);
    const deleteNodesStmt = db.db.prepare('DELETE FROM nodes WHERE project = ? AND file = ?');
    const deleteHashStmt  = db.db.prepare('DELETE FROM file_hashes WHERE project = ? AND file = ?');

    for (const { file } of files) {
      if (!isExcluded(path.join(policy.projectRoot, file), policy)) continue;
      counts.labels_purged += countLabelsStmt.get(project, file).n;
      counts.edges_purged  += countEdgesStmt.get(project, file, project, file).n;
      counts.nodes_purged  += deleteNodesStmt.run(project, file).changes;
      counts.hashes_purged += deleteHashStmt.run(project, file).changes;
      counts.files_purged  += 1;
    }
    db.setExclusionState(project, policy.hash);
    return counts;
  });
  return txn();
}

function policyChangedSince(db, project, policy) {
  const state = db.getExclusionState(project);
  return !state || state.exclusion_policy_hash !== policy.hash;
}

module.exports = {
  loadPolicy,
  isExcluded,
  purgeExcluded,
  policyChangedSince,
  BUILTIN_PATTERNS,
};
