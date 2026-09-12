'use strict';

const fs = require('fs');
const path = require('path');
const { loadPolicy, isExcluded } = require('./exclusion');

// Deprecated: directory exclusion now handled by isExcluded via policy engine
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.cache',
  'coverage', '.nyc_output', '__pycache__', '.venv', 'vendor',
]);

// File extensions recognized as text (searchable) files
const TEXT_EXTENSIONS = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.svelte', '.astro', '.vue',
  '.html', '.htm', '.css', '.scss', '.less', '.mdx',
  '.json', '.md', '.txt', '.yml', '.yaml', '.toml',
  '.sql', '.sh', '.bash', '.zsh',
  '.py', '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp',
  '.env', '.example', '.conf', '.cfg',
  '.xml', '.svg', '.ejs', '.hbs', '.pug',
]);

// Default config for callers that don't pass an explicit policy: BUILTIN patterns only.
const _DEFAULT_POLICY_CONFIG = {
  exclusion: { respect_gitignore: false, extra_patterns: [], respect_greymatterignore: false },
};

// Recursively collects text files from a directory. When opts.policy is provided,
// consults isExcluded at every node; otherwise builds a default policy from
// BUILTIN patterns so *.env and skip-dirs are still excluded.
function collectFiles(dirPath, opts = {}) {
  let { policy } = opts;
  if (!policy) {
    policy = loadPolicy(dirPath, _DEFAULT_POLICY_CONFIG);
  }

  const results = [];

  function walk(current) {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch (err) {
      process.stderr.write(`greymatter: collectFiles: ${err.message}\n`);
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;

      if (entry.isDirectory()) {
        if (!isExcluded(path.join(current, entry.name), policy)) {
          walk(path.join(current, entry.name));
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (
          (TEXT_EXTENSIONS.has(ext) || (ext === '' && entry.name !== 'LICENSE')) &&
          !isExcluded(path.join(current, entry.name), policy)
        ) {
          results.push(path.join(current, entry.name));
        }
      }
    }
  }

  walk(dirPath);
  return results;
}

module.exports = { SKIP_DIRS, TEXT_EXTENSIONS, collectFiles };
