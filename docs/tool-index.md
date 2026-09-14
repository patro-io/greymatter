# greymatter — Code + Documentation Knowledge Graph

<!-- region:mcp -->
## greymatter — MCP mode

The greymatter MCP server is active. Use the structured tools your client exposes:

- `get_status` — server health, project list, label coverage at a glance.
- `get_project_overview(project)` — recent sessions + file map for a project.
- `get_node_bundle(project, file, name, line?)` — node body + labels + 1-hop edges in one call.
- `walk_flow(project, file, name, max_depth?)` — path skeleton from a starting node.
- `query_blast_radius(project, file)` — file-level dependencies.
- `find_identifier(name, project?)` — locate a symbol.
- `get_label_coverage(project, file?, name?)` — labeling density at project / file / neighborhood scope.
- `grep_project(project, pattern, options?)` — project-scoped text search.

### Recipes

- **Orient in a new project:** `get_project_overview` + `get_status`. Use `/orient_project` if your client supports prompts.
- **Safe to delete?** `query_blast_radius` for code consumers, then `grep_project` with the file basename for textual contracts. Use `/safe_to_delete` if available.
- **Understand a flow:** `walk_flow` for the skeleton, then `get_node_bundle` on the steps that matter. Use `/understand_flow` if available.

The CLI surface is still installed and functional; this region intentionally omits flag vocabulary because the MCP tool catalog already carries it.
<!-- endregion -->

<!-- region:cli-mcp-paralleled -->
## Graph Navigation (~150 tokens)

    node $PLUGIN_ROOT/scripts/query.js <command>

Flags below have direct MCP parallels — prefer the MCP tool when MCP mode is active.

| Command | What it does | MCP parallel |
|---------|-------------|--------------|
| `--reorient [project]` | **Check first (alongside `--map`)** — recent sessions, decision terms, and files touched per project. No arg: list all projects with session context. | `get_project_overview` (richer) |
| `--map <project> [path]` | **Check first** — project directory map showing what each file does | `get_project_overview` |
| `--find <identifier>` | Code identifiers across all projects with line numbers | `find_identifier` |
| `--body <file> <name> --project <p>` | Extract a named function/definition body — saves a Read call | `get_node_bundle` |
| `--blast-radius <file> --project <p>` | What imports it, what it imports | `query_blast_radius` |
| `--labels <file> [--all] [--project <p>]` | List heuristic labels for nodes in the file, by line, term, category, and descriptors. `--all` includes stale labels (marked `[stale]`). | `get_label_coverage` |
| `--list-projects` | Browse all known projects and their recorded root paths. | `get_status` |

**Token-saving rule:** When the user asks you to work on a project you haven't touched
this session, run `--reorient <project>` for recent activity (sessions, decisions, files
touched) and `--map <project>` for current structure. Only read individual files after
those two orientation moves tell you which ones matter.

## Content Search — Grep (~variable tokens)

    node $PLUGIN_ROOT/scripts/grep.js <pattern> [options]

| Option | What it does |
|--------|-------------|
| `--context N` / `-C N` | Lines of context around each match (default: 3) |
| `--project <name>` | Filter to one project (substring match) |
| `--max-per-file N` | Cap matches shown per file (default: 20) |

Project-aware grep returning matches with surrounding context in one call. MCP parallel: `grep_project`.

## What Answers What — MCP-paralleled

| Question | Tool |
|----------|------|
| "What was recently done in <project>?" / "Where did we leave off on <project>?" | `--reorient <project>` |
| "What's in this project?" / "What does each file do?" | `--map <project>` |
| "What calls this function?" | `--find <identifier>` |
| "What depends on this?" | `--blast-radius <file>` |
| "Show me this function's code" | `--body <file> <name>` |
| "Where is this string/pattern used?" | `grep.js <pattern>` |

## Combined Recipes — MCP-paralleled

| Scenario | Sequence |
|----------|----------|
| "Can I safely wipe or rename this file?" | `--blast-radius <file>` (code consumers) THEN `grep.js <filename>` (textual contracts in commands/, README, plans). Missing the second step misses silent tripwires. |
| "Orient in a project you haven't touched this session" | `--reorient <project>` (recent sessions + decisions) + `--map <project>` (current structure). The pair gives both the *why* of recent work and the *what* of current state in ~300 tokens. Read individual files only after those two. |
<!-- endregion -->

<!-- region:cli-only -->
## Graph Navigation — CLI-only flags

    node $PLUGIN_ROOT/scripts/query.js <command>

| Command | What it does |
|---------|-------------|
| `--recent [N]` | Last N sessions globally (default 2), ordered by start time. Use when the user references conversations by count — "last session", "the session before that", "a couple sessions ago" — rather than by project. Cross-project sessions listed once with every project tagged. |
| `--structure <file> --project <p>` | Function/class/interface/type definitions with line numbers |
| `--flow <file> --project <p>` | Everything flowing in/out of a file |
| `--trace <identifier> [--project <p>]` | Follow a value — where set, who reads it, what it calls |
| `--schema [--project <p>]` | Database table structures (parsed from source `.sql` at scan time) |
| `--lookup <file> --project <p>` | Exports, routes, db refs, sensitivity |
| `--exclusions <project>` | Print the resolved exclusion policy for a project — every pattern with its source, plus sample paths excluded. See [`path-exclusion.md`](path-exclusion.md). |

## Scan

    node $PLUGIN_ROOT/scripts/scan.js [options]

| Option | What it does |
|--------|-------------|
| `--dir <path>` | Scan a specific directory |
| `--project <name>` | Name to assign to the project |
| `--force` | Re-scan even if file hash is unchanged |

Full project scan — builds graph.db from source files. Run once after install,
then the post-tool-use hook keeps graph.db current on every edit.

## Schema Scout

    node $PLUGIN_ROOT/scripts/schema-scout.js [--project <path>]

Walks a project root, finds all `.db`/`.sqlite` files, and writes markdown docs of each database's tables, columns, foreign keys, and indexes to `<project>/schemas/`. Reads **live** runtime DB state — distinct from `query.js --schema`, which reads schema nodes parsed from source `.sql` files at scan time.

## Classify

    node $PLUGIN_ROOT/scripts/classify.js --inline "label1=pattern1" "label2=pattern2" [options]
    node $PLUGIN_ROOT/scripts/classify.js <config.json> [options]

| Option | What it does |
|--------|-------------|
| `--project <name>` | Filter to one project |
| `--context N` / `-C N` | Lines of context per match (default: 1) |
| `--no-snippets` | Summary only, no code snippets |

Pattern variant audit with direction detection — categorizes every match by variant.
Use for migration audits, convention checks, routing analysis.

<!-- region:recall -->
## Conversation Recall (~150 tokens search, ~6K read)

Verbatim conversation recall — reasoning, rejected alternatives, the actual back-and-forth.

### Search

    node $PLUGIN_ROOT/scripts/search.js "term1,term2" "term3" [--limit N] [--project <name>]

Terms within quotes are comma-separated OR. Separate arguments are additive clusters.

**`--project` (0.1.9+) — use it when you are orienting in one repo.** The recall index spans every project at once, so a generic term picks up decisions from wherever they were made: "gate" or "plugin" pulled 13 digests from an unrelated repo during one devstack orientation, and a priming step reads as project context while describing someone else's work. The filter keeps only windows that touched a file under the project's recorded root (from `graph.db`), anchored on a path separator so `patro` never matches `patro-cms`. A project with no recorded root prints a note and searches everything — an empty result would read as "we never discussed this".

### Read Window — granularity ladder

    node $PLUGIN_ROOT/scripts/read-window.js <session> <seq> [--digest|--decision N|--focus L-L|--full]

Escalate only when the tier below is insufficient. Each step pays more tokens
for more fidelity — start cheap, stop as soon as you have what you need.

1. `--digest` (~200 tokens) — DB-only summary: decision list + file refs. Use
   to confirm you have the right session before reading any verbatim text.
2. `--decision N` (~500-1K tokens) — one specific decision with surrounding
   reasoning. Use when the digest points at a clear target.
3. `--focus <start>-<end>` (~6K tokens) — compact verbatim of a line range.
   Use when the decision view is too narrow or you need the back-and-forth.
4. `--full` (variable, can be large) — raw verbatim. Last resort; only when
   focused reads keep missing the piece you need.

<!-- endregion -->

<!-- region:signals -->
## Behavioral Signals

    node $PLUGIN_ROOT/scripts/signals.js --review

Review all active signals grouped by type, sorted by weight. Shows count, estimated
token cost, and flags overlapping or contradictory signals.

Signals are written via `/dopamine` and `/oxytocin` commands. The `greymatter-signals.md` rules
file at `~/.claude/rules/greymatter-signals.md` is regenerated automatically after
each write.

<!-- endregion -->

## Test-map Alerts

Opt-in stale-test-pair detector. Scans one or more projects for source files whose paired test wasn't touched in the same commit range (`stale_pair`) or never had a paired test at all (`missing_test`), and writes a per-project markdown report.

    node $PLUGIN_ROOT/scripts/test-alerts.js [--audit] [--project <name>]

| Flag | What it does |
|------|-------------|
| `--audit` | Full mtime-based sweep using `file_hashes.updated_at`. Default is incremental (git diff `last_scan_sha..HEAD`). |
| `--project <name>` | Scope to one project in `config.test_alerts.enabled_projects`. Without it, the CLI iterates every enabled project. Unknown names exit non-zero. |
| `--help` / `-h` | Print usage. |

**Activation.** Feature is silent until `config.test_alerts.enabled_projects` lists at least one project. Project names in that list must match the strings shown by `node scripts/query.js --list-projects` (the names assigned at scan time, not filesystem paths). Once enabled, the session-start hook runs an incremental scan on every session; the CLI is for mid-session / on-demand runs after a pull. See [`config/defaults.md`](../config/defaults.md) for the full table (`check_stale_pairs`, `check_missing_tests`, `alert_output_dir`).

**Extractor-driven.** Pairing rules live in each language extractor's `testPairs` block. JS, TS, Python, and Svelte ship enabled; Markdown is intentionally opted out (no test convention for docs). User-authored extractors participate the moment they export `testPairs`. See [`authoring-extractors.md`](authoring-extractors.md) for the contract and the annotation-regex gotcha.

**Slash command.** `/test-map` runs the CLI for the current project, reads the output file, and summarizes open findings — optionally converting them to TodoWrite items.

## Spec/Plan Tools

    node $PLUGIN_ROOT/scripts/spec-check.js <command>

| Flag | What it does |
|------|-------------|
| `--dir <path>` | Scan a folder recursively for specs/plans |
| `--template spec\|plan` | Print a ready-to-fill frontmatter template |
| `--list-chunks <plan>` | List chunks in a plan with line ranges |
| `--chunk-content <plan> <n>` | Extract a chunk assignment (plan header + prior observations + chunk body) |
| `--dispatch <plan>` | Write every chunk's assignment to `<plan-dir>/chunks/` |

By default, `--chunk-content` and `--dispatch` emit just the semantic sections — plan header, prior observations, chunk body — and `--dispatch` writes nothing outside the chunks directory. Two opt-ins exist for workflows that need more:

- **Standing-rules preamble** — a workflow-rules block prepended to every chunk (don't commit, don't restart services, observations-file instructions). Enable via `spec_check.preamble: true` in `~/.claude/greymatter/config.json`, or pass `--preamble` on a single invocation. Pass `--no-preamble` to force it off when config has it on.
- **External command-log append** — `--dispatch` can append one `Read <path> and execute it.` line per chunk to an external file (clipboard-window integration, etc.). Enable via `spec_check.command_log_path: "/abs/path"` in config, or pass `--command-log <path>`. Pass `--command-log=` (empty value) to disable for one call.

## What Answers What — CLI-only

These questions don't have a single MCP-tool answer; reach for the CLI.

| Question | Tool |
|----------|------|
| "Last session?" / "a couple sessions ago?" / "the session before that?" | `--recent [N]` |
| "What does this file export?" | `--lookup <file>` |
| "What's the DB schema?" (from source) | `--schema` |
| "What's the live runtime DB schema?" | `schema-scout.js` |
| "What functions are in this file?" | `--structure <file>` |
| "How does data flow through this file?" | `--flow <file>` |
| "Where is a value set and who reads it?" | `--trace <identifier>` |
| "How much code uses pattern A vs B?" | `classify.js --inline "A=..." "B=..."` |
| "What did we decide about X?" | `search.js` + `read-window.js` |
| "Which source files drifted away from their tests?" | `test-alerts.js --project <name>` (or `/test-map`) |

## Combined Recipes — CLI-only

Real investigations combine tools. The code graph tracks imports; it does NOT
track textual contracts — slash commands shelling out by flag name, README
examples, spec references, plan docs. Those are caught by `grep.js`. Treat
them as first-class dependents. Recipes below all reach for at least one
CLI-only tool — paralleled-only recipes live in the MCP region above.

| Scenario | Sequence |
|----------|----------|
| "Where is this method actually called?" | `grep.js <methodName>` — `--trace` is thin on method call-sites; it shows definitions and file-level edges, not every call expression. Use `--trace` to locate the definition, `grep.js` to enumerate call sites. |
| "Recover a past decision" | Ladder: `search.js` → `--digest` (~200 tok) → `--decision N` (~500-1K) → `--focus L-L` (~6K) → `--full`. Escalate only when the tier below is insufficient. |
| "Audit a migration's progress" | `classify.js --inline "old=regex1" "new=regex2"` — percentage split plus direction tags ([client]/[server]/[config]/[reference]). |
| "Understand the full blast radius of a load-bearing script" | `--blast-radius` + `--flow` + `grep.js <filename>` together. The code graph shows wiring; grep reveals the markdown/command/README contracts the graph doesn't track. |

## When Standard Tools Are Shorter

- **"Does this path exist?" / "What's in this directory?"** → `ls`
- **User gave a file path** → `Read` it directly
- **Searching for a known string in 1-2 specific files** → `Grep`
<!-- endregion -->
