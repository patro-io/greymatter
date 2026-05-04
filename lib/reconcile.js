'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadConfig } = require('./config');
const { loadPolicy, isExcluded, purgeExcluded, policyChangedSince } = require('./exclusion');

function computeWorkSet({ db, project, rootPath }) {
  const rows = db.getFileHashRowsForProject(project);

  const missing = [];
  const remaining = [];
  for (const row of rows) {
    if (!fs.existsSync(path.join(rootPath, row.file))) {
      missing.push(row.file);
    } else {
      remaining.push(row);
    }
  }

  const scanState = db.getScanState(project);
  const lastScanSha = scanState && scanState.last_scan_sha;
  let gitDiffFiles = [];
  if (lastScanSha) {
    try {
      const output = execFileSync(
        'git', ['diff', `${lastScanSha}..HEAD`, '--name-only'],
        { cwd: rootPath, encoding: 'utf8' }
      );
      gitDiffFiles = output.trim().split('\n').filter(Boolean);
    } catch {
      // git failed — fall through to mtime-only
    }
  }

  const mtimeNewerFiles = [];
  for (const { file, updated_at } of remaining) {
    try {
      const diskMtime = fs.statSync(path.join(rootPath, file)).mtimeMs;
      // SQLite stores timestamps as "YYYY-MM-DD HH:MM:SS.mmm" (UTC, no timezone indicator).
      // Convert to ISO 8601 UTC before parsing; leave strings that already carry a T or Z alone.
      const storedMs = updated_at.includes('T')
        ? Date.parse(updated_at)
        : Date.parse(updated_at.replace(' ', 'T') + 'Z');
      if (diskMtime > storedMs) {
        mtimeNewerFiles.push(file);
      }
    } catch {
      // stat failed — skip
    }
  }

  // Orphan iteration: nodes-row files with no paired file_hashes row.
  // Their disk-missing variants are otherwise invisible to reconcile.
  // Present-on-disk orphans are left alone — next re-extraction of the
  // path will rewrite both nodes and file_hashes, restoring the invariant.
  const orphanFiles = db.getOrphanNodeFilesForProject(project);
  for (const file of orphanFiles) {
    if (!fs.existsSync(path.join(rootPath, file))) {
      missing.push(file);
    }
  }

  const workSet = [...new Set([...gitDiffFiles, ...mtimeNewerFiles])];
  return { missing, gitDiffFiles, mtimeNewerFiles, workSet };
}

function reconcileProject({ db, project, rootPath, runExtraction, config: inConfig }) {
  if (!rootPath) return { skipped: true, reason: 'no_root' };
  if (!fs.existsSync(rootPath)) return { skipped: true, reason: 'root_missing', rootPath };

  const config = inConfig !== undefined ? inConfig : loadConfig();
  const policy = loadPolicy(rootPath, config);
  let purgeCounts = null;

  if (policyChangedSince(db, project, policy)) {
    purgeCounts = purgeExcluded(db, project, policy);
  }

  if (!runExtraction) {
    const { extractFiles } = require('../scripts/scan');
    runExtraction = (files) => extractFiles({ db, project, rootPath, forceFiles: files, config });
  }

  const work = computeWorkSet({ db, project, rootPath });

  for (const file of work.missing) {
    db.purgeFile(project, file);
  }

  // Defense in depth: filter workSet through isExcluded before passing to extraction
  const filteredWorkSet = work.workSet.filter(f => !isExcluded(path.join(rootPath, f), policy));

  if (filteredWorkSet.length === 0) {
    return { purged: work.missing.length, reextracted: 0, skipped: true, purgeCounts };
  }

  runExtraction(filteredWorkSet);
  // Idempotent re-write keeps exclusion state fresh even when policy didn't change
  db.setExclusionState(project, policy.hash);

  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootPath, encoding: 'utf8' }).trim();
    if (head) db.updateLastScanSha(project, head);
  } catch {
    // not a git repo or HEAD unreachable — leave last_scan_sha unchanged
  }

  return { purged: work.missing.length, reextracted: filteredWorkSet.length, purgeCounts };
}

function reconcileAll({ db, runExtraction, logger }) {
  const projects = db.db.prepare('SELECT project, root_path FROM project_scan_state').all();
  const unrooted = [];
  for (const { project, root_path } of projects) {
    if (!root_path) { unrooted.push(project); continue; }
    try {
      const result = reconcileProject({ db, project, rootPath: root_path, runExtraction });
      if (result.skipped && result.reason === 'root_missing') {
        logger(`[reconcile] ${project}: root ${result.rootPath} does not exist; skipping`);
        continue;
      }
      const parts = [];
      if (result.purgeCounts && result.purgeCounts.files_purged > 0) {
        const pc = result.purgeCounts;
        parts.push(
          `exclusion policy changed; purged ${pc.files_purged} file${pc.files_purged === 1 ? '' : 's'} / ` +
          `${pc.nodes_purged} node${pc.nodes_purged === 1 ? '' : 's'} / ` +
          `${pc.edges_purged} edge${pc.edges_purged === 1 ? '' : 's'} / ` +
          `${pc.labels_purged} label${pc.labels_purged === 1 ? '' : 's'}`
        );
      }
      if (result.purged > 0) parts.push(`purged ${result.purged} missing file${result.purged === 1 ? '' : 's'}`);
      if (result.reextracted > 0) parts.push(`re-extracted ${result.reextracted} changed file${result.reextracted === 1 ? '' : 's'}`);
      if (parts.length > 0) logger(`[reconcile] ${project}: ${parts.join(', ')}`);
    } catch (err) {
      logger(`[reconcile] ${project}: failed — ${err.message}`);
    }
  }
  if (unrooted.length > 0) {
    logger(`[reconcile] ${unrooted.length} project(s) have no root_path; run a fresh scan to register: ${unrooted.join(', ')}`);
  }
}

module.exports = { computeWorkSet, reconcileProject, reconcileAll };
