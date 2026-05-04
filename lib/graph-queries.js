'use strict';

const fs = require('fs');
const path = require('path');
const { AmbiguousIdentifierError } = require('./mcp/errors');

// Escapes LIKE wildcards in user-supplied search terms
function escapeLike(str) {
  return str.replace(/[%_]/g, c => '\\' + c);
}

// Extract a named function/class/const body from source text.
// Uses the same heuristic as query.js --body.
function _extractBody(content, name) {
  const lines = content.split('\n');
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declRe = new RegExp([
    `function\\s+${escaped}\\b`,
    `(?:const|let|var)\\s+${escaped}\\s*=`,
    `^\\s*class\\s+${escaped}\\b`,
    `^\\s*(?:async\\s+|static\\s+|get\\s+|set\\s+)*${escaped}\\s*\\([^)]*\\)\\s*\\{`,
    `^\\s*${escaped}\\s*:\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*=>)`,
    `^\\s*(?:module\\.)?exports\\.${escaped}\\s*=`,
  ].join('|'));
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (declRe.test(lines[i])) { start = i; break; }
  }
  if (start === -1) return null;
  let depth = 0, end = lines.length - 1;
  for (let i = start; i < lines.length; i++) {
    depth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
    if (i > start && depth <= 0) { end = i; break; }
  }
  return lines.slice(start, end + 1).join('\n');
}

class GraphQueries {
  constructor(graphDb) {
    this.graphDb = graphDb;
    this.db = graphDb.db;
  }

  // Returns [{file, nodes: [{name, type, line}]}] for all files in a project
  getProjectMap(project) {
    const rows = this.db.prepare(`
      SELECT file, name, type, line
      FROM nodes
      WHERE project = ?
      ORDER BY file, line
    `).all(project);

    const fileMap = new Map();
    for (const row of rows) {
      if (!fileMap.has(row.file)) fileMap.set(row.file, []);
      fileMap.get(row.file).push({ name: row.name, type: row.type, line: row.line });
    }

    return Array.from(fileMap.entries()).map(([file, nodes]) => ({ file, nodes }));
  }

  // Finds nodes by name. Optional project filter. Exact match first, then prefix.
  findNodes(name, project = null) {
    const params = project ? [name, project] : [name];
    const projectClause = project ? 'AND project = ?' : '';

    const exact = this.db.prepare(`
      SELECT id, project, file, name, type, line, metadata_json FROM nodes WHERE name = ? ${projectClause} ORDER BY project, file, line
    `).all(...params);

    if (exact.length > 0) return exact;

    const prefixParams = project ? [`${escapeLike(name)}%`, project] : [`${escapeLike(name)}%`];
    return this.db.prepare(`
      SELECT id, project, file, name, type, line, metadata_json FROM nodes WHERE name LIKE ? ESCAPE '\\' ${projectClause} ORDER BY project, file, line
    `).all(...prefixParams);
  }

  // Returns all nodes in a specific file
  getFileNodes(project, file) {
    return this.db.prepare(`
      SELECT id, name, type, line, metadata_json FROM nodes WHERE project = ? AND file = ? ORDER BY line
    `).all(project, file);
  }

  // BFS following inbound structural edges. Returns dependent files (depth limit 3).
  getBlastRadius(project, file) {
    const visited = new Set([file]);
    const result = [];
    let frontier = [file];

    const getInboundSources = this.db.prepare(`
      SELECT DISTINCT e.source_file as file, e.source_project as project
      FROM edges e
      JOIN nodes n ON e.target_id = n.id
      JOIN edge_types et ON e.type = et.name
      WHERE n.project = ? AND n.file = ? AND et.follows_for_blast_radius = 1
    `);

    for (let depth = 0; depth < 3; depth++) {
      const nextFrontier = [];
      for (const f of frontier) {
        const sources = getInboundSources.all(project, f);
        for (const src of sources) {
          if (!visited.has(src.file)) {
            visited.add(src.file);
            result.push(src);
            nextFrontier.push(src.file);
          }
        }
      }
      frontier = nextFrontier;
      if (frontier.length === 0) break;
    }

    return result;
  }

  // Returns all edges flowing in and out of a file's nodes
  getFileFlow(project, file) {
    const outbound = this.db.prepare(`
      SELECT id, source_id, target_id, type, category, source_project, source_file, data_json, sequence FROM edges WHERE source_project = ? AND source_file = ?
    `).all(project, file);

    const inbound = this.db.prepare(`
      SELECT e.id, e.source_id, e.target_id, e.type, e.category, e.source_project, e.source_file, e.data_json, e.sequence FROM edges e
      JOIN nodes n ON e.target_id = n.id
      WHERE n.project = ? AND n.file = ?
    `).all(project, file);

    return { inbound, outbound };
  }

  // Find a node by name, get all edges where it is source or target
  traceIdentifier(name, project = null) {
    const params = project ? [name, project] : [name];
    const projectClause = project ? 'AND project = ?' : '';

    const node = this.db.prepare(`
      SELECT id, project, file, name, type, line, metadata_json FROM nodes WHERE name = ? ${projectClause} LIMIT 1
    `).get(...params);

    if (!node) return { node: null, edges: [] };

    const outEdges = this.db.prepare(`SELECT id, source_id, target_id, type, category, source_project, source_file, data_json, sequence FROM edges WHERE source_id = ?`).all(node.id);
    const inEdges = this.db.prepare(`SELECT id, source_id, target_id, type, category, source_project, source_file, data_json, sequence FROM edges WHERE target_id = ?`).all(node.id);

    return { node, edges: [...outEdges, ...inEdges] };
  }

  // Returns node definitions ordered by line number
  getStructure(project, file) {
    return this.db.prepare(`
      SELECT name, type, line, metadata_json FROM nodes
      WHERE project = ? AND file = ?
      ORDER BY COALESCE(line, 0)
    `).all(project, file);
  }

  // Returns nodes of db-related types (tables, columns, indexes)
  getSchema(project) {
    const projectClause = project ? 'WHERE project = ? AND type IN (\'table\', \'column\', \'index\')' : 'WHERE type IN (\'table\', \'column\', \'index\')';
    const params = project ? [project] : [];
    return this.db.prepare(`SELECT id, project, file, name, type, line, metadata_json FROM nodes ${projectClause} ORDER BY file, line`).all(...params);
  }

  // Returns distinct project names
  listProjects() {
    const rows = this.db.prepare(`SELECT DISTINCT project FROM nodes ORDER BY project`).all();
    return rows.map(r => r.project);
  }

  // Returns [{name, root_path}] — root_path may be null for projects scanned
  // before the root_path column existed. LEFT JOIN so nodes-only projects
  // still appear.
  listProjectsWithRoots() {
    const rows = this.db.prepare(`
      SELECT DISTINCT n.project AS name, s.root_path AS root_path
      FROM nodes n
      LEFT JOIN project_scan_state s ON s.project = n.project
      ORDER BY n.project
    `).all();
    return rows;
  }

  // Returns annotations for a node
  getNodeAnnotations(nodeId) {
    return this.db.prepare(`
      SELECT id, node_id, content, author, created_at FROM annotations WHERE node_id = ? ORDER BY created_at
    `).all(nodeId);
  }

  // Returns { graphDb, labels, projects } — the MCP server layers `server` on top.
  getStatus() {
    const totals = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM nodes) AS total_nodes,
        (SELECT COUNT(*) FROM edges) AS total_edges,
        (SELECT COUNT(DISTINCT file) FROM nodes) AS total_files,
        (SELECT MAX(updated_at) FROM file_hashes) AS last_scan_at
    `).get();

    const labelTotal = this.db.prepare('SELECT COUNT(*) AS n FROM code_labels').get().n;
    const stale = this.db.prepare('SELECT COUNT(*) AS n FROM code_labels WHERE is_stale = 1').get().n;
    const bySourceRows = this.db.prepare(
      'SELECT source, COUNT(*) AS n FROM code_labels WHERE is_stale = 0 GROUP BY source'
    ).all();
    const by_source = { heuristic: 0, llm: 0, manual: 0 };
    for (const r of bySourceRows) by_source[r.source] = r.n;

    const projects = this.listProjectsWithRoots().map(p => {
      const counts = this.db.prepare(`
        SELECT
          (SELECT COUNT(DISTINCT file) FROM nodes WHERE project = ?) AS scanned_files,
          (SELECT COUNT(*) FROM nodes WHERE project = ?) AS node_count,
          (SELECT COUNT(*) FROM code_labels cl
             JOIN nodes n ON cl.node_id = n.id WHERE n.project = ?) AS label_count
      `).get(p.name, p.name, p.name);
      const lastScan = this.db.prepare(
        'SELECT MAX(updated_at) AS t FROM file_hashes WHERE project = ?'
      ).get(p.name).t;
      return {
        name: p.name,
        root_path: p.root_path,
        scanned_files: counts.scanned_files,
        node_count: counts.node_count,
        label_count: counts.label_count,
        last_scan_at: lastScan,
      };
    });

    return {
      graphDb: {
        path: this.graphDb.dbPath || null,
        schema_version: this.graphDb.getMeta('schema_version'),
        total_nodes: totals.total_nodes,
        total_edges: totals.total_edges,
        total_files: totals.total_files,
        last_scan_at: totals.last_scan_at,
      },
      labels: { total: labelTotal, by_source, stale_count: stale },
      projects,
    };
  }

  // Reads pre-computed session context from project_context table.
  // Populated by lib/reorientation.js buildProjectContext() during wrapup.
  _recentSessionsForProject(project, limit = 5) {
    const row = this.db.prepare('SELECT context_json FROM project_context WHERE project = ?').get(project);
    if (!row) return [];
    try {
      const entries = JSON.parse(row.context_json);
      return Array.isArray(entries) ? entries.slice(0, limit) : [];
    } catch { return []; }
  }

  // Returns { project, recent_sessions, file_map, totals } or null when project
  // is not in project_scan_state. Consolidates --reorient and --map into one call.
  getProjectOverview(project) {
    const stateRow = this.db.prepare('SELECT 1 FROM project_scan_state WHERE project = ?').get(project);
    if (!stateRow) return null;

    // purpose is reserved for a future semantic summary (LLM-authored or smarter
    // heuristic). The original type:name enumeration bloated overview output to
    // ~85% of payload — empty until a real producer is wired in.
    const file_map = this.getProjectMap(project).map(({ file }) => ({ path: file, purpose: '' }));

    const recent_sessions = this._recentSessionsForProject(project, 5);

    const totals = this.db.prepare(`
      SELECT
        (SELECT COUNT(DISTINCT file) FROM nodes WHERE project = ?) AS files,
        (SELECT COUNT(*) FROM nodes WHERE project = ?) AS nodes,
        (SELECT COUNT(DISTINCT cl.node_id) FROM code_labels cl
           JOIN nodes n ON cl.node_id = n.id
           WHERE n.project = ? AND cl.is_stale = 0) AS labeled_nodes
    `).get(project, project, project);

    return {
      project,
      recent_sessions,
      file_map,
      totals: { files: totals.files, nodes: totals.nodes, labeled_nodes: totals.labeled_nodes },
    };
  }

  // Returns node bundle with identifier, body, labels, outgoing, incoming.
  // Returns null when node not found. Throws (with AMBIGUOUS_OR_MISSING_LINE token)
  // when name is ambiguous in file and no line is given.
  getNodeBundle(project, file, name, line = null) {
    let nodeRow;
    if (line !== null) {
      nodeRow = this.db.prepare(
        'SELECT id, name, type, line FROM nodes WHERE project = ? AND file = ? AND name = ? AND line = ?'
      ).get(project, file, name, line);
    } else {
      const candidates = this.db.prepare(
        'SELECT id, name, type, line FROM nodes WHERE project = ? AND file = ? AND name = ?'
      ).all(project, file, name);
      if (candidates.length === 0) return null;
      if (candidates.length > 1) {
        throw new AmbiguousIdentifierError(`${candidates.length} nodes named "${name}" in ${file}`);
      }
      nodeRow = candidates[0];
    }
    if (!nodeRow) return null;

    const identifier = { kind: nodeRow.type, name: nodeRow.name, file, line: nodeRow.line };

    // Attempt body extraction from source file
    let body = null;
    const rootPath = this.graphDb.getProjectRoot(project);
    if (rootPath) {
      try {
        const content = fs.readFileSync(path.join(rootPath, file), 'utf8');
        body = _extractBody(content, name);
      } catch { /* file not readable */ }
    }

    // Labels: non-stale, ordered by source priority then confidence DESC (via getLabels)
    const rawLabels = this.graphDb.getLabels(nodeRow.id, { multi: true });
    const labels = rawLabels.map(l => ({
      source: l.source,
      category: l.category,
      descriptors: l.descriptors_json ? JSON.parse(l.descriptors_json) : [],
      confidence: l.confidence,
      detector_id: l.detector_id,
      summary: l.role_summary || null,
    }));

    // Outgoing edges with counterpart top label and file (for exclusion filtering)
    const outEdges = this.db.prepare(`
      SELECT e.type AS kind, n.name AS target, n.id AS target_id, n.file AS target_file
      FROM edges e JOIN nodes n ON e.target_id = n.id
      WHERE e.source_id = ?
      ORDER BY e.id ASC
    `).all(nodeRow.id);

    // Incoming edges with counterpart top label and file (for exclusion filtering)
    const inEdges = this.db.prepare(`
      SELECT e.type AS kind, n.name AS source, n.id AS source_id, n.file AS source_file
      FROM edges e JOIN nodes n ON e.source_id = n.id
      WHERE e.target_id = ?
      ORDER BY e.id ASC
    `).all(nodeRow.id);

    const resolveLabel = (nodeId) => {
      const top = this.graphDb.getLabels(nodeId, { multi: false });
      if (!top) return null;
      return {
        category: top.category,
        descriptors: top.descriptors_json ? JSON.parse(top.descriptors_json) : [],
      };
    };

    const outgoing = outEdges.map(e => ({ kind: e.kind, target: e.target, target_file: e.target_file, target_label: resolveLabel(e.target_id) }));
    const incoming = inEdges.map(e => ({ kind: e.kind, source: e.source, source_file: e.source_file, source_label: resolveLabel(e.source_id) }));

    return { identifier, body, labels, outgoing, incoming };
  }

  // BFS from named start node, capped at maxDepth. Returns { start, steps, truncated }.
  // Returns null when start node not found.
  walkFlow(project, file, name, maxDepth = 8) {
    const startNode = this.db.prepare(
      'SELECT id, name, type, line FROM nodes WHERE project = ? AND file = ? AND name = ? LIMIT 1'
    ).get(project, file, name);
    if (!startNode) return null;

    const start = { kind: startNode.type, name: startNode.name, file, line: startNode.line };
    const steps = [{ depth: 0, kind: startNode.type, name: startNode.name, file, line: startNode.line, edge_in: null }];

    const visited = new Set([startNode.id]);
    let frontier = [{ id: startNode.id, depth: 0 }];
    let truncated = false;

    const getOutEdges = this.db.prepare(`
      SELECT e.type AS edge_kind, n.id AS node_id, n.name AS node_name,
             n.type AS node_type, n.file AS node_file, n.line AS node_line
      FROM edges e JOIN nodes n ON e.target_id = n.id
      WHERE e.source_id = ?
      ORDER BY e.id ASC
    `);

    while (frontier.length > 0) {
      const nextFrontier = [];
      for (const { id, depth } of frontier) {
        const edges = getOutEdges.all(id);
        for (const edge of edges) {
          if (visited.has(edge.node_id)) continue;
          visited.add(edge.node_id);
          const nextDepth = depth + 1;
          if (nextDepth > maxDepth) { truncated = true; continue; }
          steps.push({
            depth: nextDepth,
            kind: edge.node_type,
            name: edge.node_name,
            file: edge.node_file,
            line: edge.node_line,
            edge_in: edge.edge_kind,
          });
          nextFrontier.push({ id: edge.node_id, depth: nextDepth });
        }
      }
      frontier = nextFrontier;
    }

    return { start, steps, truncated };
  }

  // Polymorphic label coverage. Scope inferred from which args are non-null:
  //   (project)           → project-wide
  //   (project, file)     → file-scoped
  //   (project, file, name) → 1-hop neighborhood (same set as getNodeBundle)
  getLabelCoverage(project, file = null, name = null) {
    if (file === null) {
      // Project scope
      const total_nodes = this.db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE project = ?').get(project).n;
      const labeled_count = this.db.prepare(`
        SELECT COUNT(DISTINCT n.id) AS n FROM nodes n
        JOIN code_labels cl ON cl.node_id = n.id AND cl.is_stale = 0
        WHERE n.project = ?
      `).get(project).n;
      const bySourceRows = this.db.prepare(`
        SELECT cl.source, COUNT(DISTINCT n.id) AS n FROM nodes n
        JOIN code_labels cl ON cl.node_id = n.id AND cl.is_stale = 0
        WHERE n.project = ? GROUP BY cl.source
      `).all(project);
      const by_source = { heuristic: 0, llm: 0, manual: 0 };
      for (const r of bySourceRows) by_source[r.source] = r.n;
      return {
        scope: 'project',
        total_nodes,
        labeled_count,
        percent_labeled: total_nodes > 0 ? Math.round(labeled_count / total_nodes * 100) / 100 : 0,
        by_source,
      };
    }

    if (name === null) {
      // File scope
      const total_nodes = this.db.prepare(
        'SELECT COUNT(*) AS n FROM nodes WHERE project = ? AND file = ?'
      ).get(project, file).n;
      const labeled_count = this.db.prepare(`
        SELECT COUNT(DISTINCT n.id) AS n FROM nodes n
        JOIN code_labels cl ON cl.node_id = n.id AND cl.is_stale = 0
        WHERE n.project = ? AND n.file = ?
      `).get(project, file).n;
      const bySourceRows = this.db.prepare(`
        SELECT cl.source, COUNT(DISTINCT n.id) AS n FROM nodes n
        JOIN code_labels cl ON cl.node_id = n.id AND cl.is_stale = 0
        WHERE n.project = ? AND n.file = ? GROUP BY cl.source
      `).all(project, file);
      const by_source = { heuristic: 0, llm: 0, manual: 0 };
      for (const r of bySourceRows) by_source[r.source] = r.n;
      return {
        scope: 'file',
        total_nodes,
        labeled_count,
        percent_labeled: total_nodes > 0 ? Math.round(labeled_count / total_nodes * 100) / 100 : 0,
        by_source,
      };
    }

    // Neighborhood scope: anchor + 1-hop incoming/outgoing counterparts.
    // Uses the same edge queries as getNodeBundle to guarantee identical neighborhood definition.
    const anchorRow = this.db.prepare(
      'SELECT id FROM nodes WHERE project = ? AND file = ? AND name = ? LIMIT 1'
    ).get(project, file, name);
    if (!anchorRow) {
      return { scope: 'neighborhood', anchor: { project, file, name }, neighborhood_size: 0, labeled_count: 0, percent_labeled: 0, by_source: { heuristic: 0, llm: 0, manual: 0 }, unlabeled_nodes: [] };
    }

    const outTargetIds = this.db.prepare(
      'SELECT n.id AS node_id, n.name, n.file FROM edges e JOIN nodes n ON e.target_id = n.id WHERE e.source_id = ? ORDER BY e.id ASC'
    ).all(anchorRow.id);
    const inSourceIds = this.db.prepare(
      'SELECT n.id AS node_id, n.name, n.file FROM edges e JOIN nodes n ON e.source_id = n.id WHERE e.target_id = ? ORDER BY e.id ASC'
    ).all(anchorRow.id);

    // Deduplicate neighborhood nodes
    const neighborMap = new Map([[anchorRow.id, { id: anchorRow.id, name, file }]]);
    for (const r of [...outTargetIds, ...inSourceIds]) {
      if (!neighborMap.has(r.node_id)) neighborMap.set(r.node_id, { id: r.node_id, name: r.name, file: r.file });
    }
    const neighborIds = [...neighborMap.values()];
    const neighborhood_size = neighborIds.length;

    const labeled = new Set();
    const by_source = { heuristic: 0, llm: 0, manual: 0 };
    for (const { id: nodeId } of neighborIds) {
      const nodeLabels = this.db.prepare(
        'SELECT DISTINCT source FROM code_labels WHERE node_id = ? AND is_stale = 0'
      ).all(nodeId);
      if (nodeLabels.length > 0) {
        labeled.add(nodeId);
        for (const l of nodeLabels) by_source[l.source] = (by_source[l.source] || 0) + 1;
      }
    }
    const labeled_count = labeled.size;
    const unlabeled_nodes = neighborIds
      .filter(n => !labeled.has(n.id))
      .map(n => ({ name: n.name, file: n.file }));

    return {
      scope: 'neighborhood',
      anchor: { project, file, name },
      neighborhood_size,
      labeled_count,
      percent_labeled: neighborhood_size > 0 ? Math.round(labeled_count / neighborhood_size * 100) / 100 : 0,
      by_source,
      unlabeled_nodes,
    };
  }
}

module.exports = { GraphQueries };
