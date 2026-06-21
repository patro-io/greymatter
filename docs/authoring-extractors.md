# Authoring an extractor

Extractors are how greymatter learns new languages. Each one owns a set of file extensions, parses those files, and returns a list of graph nodes, edges, and the edge types it introduces. Drop a module into `extractors/`, export the contract below, and the registry auto-discovers it on next scan — no core changes needed.

This guide covers the contract, the node/edge shapes, and the optional `testPairs` block that opts your language into the test-map alert feature.

---

## The minimum contract

Every extractor exports these three things:

```js
module.exports = {
  extensions: ['.ext'],                         // array of file extensions this extractor owns
  extract(content, filePath, project) { ... },  // parse a single file
  testPairs: { ... },                           // optional — see below
};
```

`ExtractorRegistry` (in `lib/extractor-registry.js`) scans the `extractors/` directory on construction and registers every module that exports `extensions: string[]` and a `extract` function. A module missing either is silently skipped — so a half-finished file in that directory won't break scans.

### `extract(content, filePath, project)`

Called once per file. Synchronous. Returns:

```js
{
  nodes: [ ... ],         // things this file defines
  edges: [ ... ],         // relationships from/to things in this file
  edge_types: [ ... ],    // metadata about every edge type this extractor can emit
}
```

All three are plain arrays. Empty arrays are fine.

**Node shape** — each entry is a graph node:

```js
{
  project: 'my-project',            // pass through from the argument
  file: 'path/to/file.ext',         // pass through from the argument
  name: 'identifier',               // the thing being defined (function name, class name, etc.)
  type: 'function',                 // one of: 'module', 'function', 'method', 'class',
                                    //        'interface', 'type_alias', 'enum', 'route',
                                    //        'component', 'prop', 'slot', 'doc_section',
                                    //        'command', 'skill', ...or a new type you coin
  line: 42,                         // 1-indexed line number where it's defined
  metadata_json: '{"scope":"Foo"}', // optional: arbitrary extra context, stringified JSON
}
```

Add a module-level node for the file itself (`type: 'module'` or `'component'`, `line: 1`) so other extractors' edges can target it.

**Edge shape** — each entry is a directed relationship:

```js
{
  type: 'imports',                  // edge type name (must appear in edge_types below)
  category: 'structural',           // 'structural' | 'data_flow' | 'documentary' | 'informational'
  source: 'myFunction',             // the node or identifier this edge originates from
  target: './other-file.js',        // the node or identifier this edge points at
  sourceProject: 'my-project',      // pass through
  sourceFile: 'path/to/file.ext',   // pass through
}
```

The graph-DB layer uses `source` and `target` as free-form strings — targets can be unresolved paths, external module names, or identifiers your extractor can't follow yet. Resolution happens at query time.

**`edge_types` shape** — every edge type you emit must be declared here with its follow semantics. The graph uses these to decide what to traverse for blast-radius queries and what signals staleness:

```js
{
  name: 'imports',                     // matches the `type` field on your edges
  category: 'structural',              // same vocabulary as the edge category
  followsForBlastRadius: true,         // true = include when tracing "what depends on this?"
  impliesStaleness: false,             // true = a change to the target may stale the source
  description: 'ES/CJS module import', // one-liner shown in schema queries
}
```

See `lib/edge-types.js` for the canonical registry and `extractors/javascript.js:20` for a live example.

### What the registry does with your return value

- Nodes: upserted into the `nodes` table, keyed on `(project, file, name, type)`.
- Edges: inserted into the `edges` table. Duplicates are deduped by `(type, source, target, sourceFile)`.
- `edge_types`: merged into the `edge_types` catalog so blast-radius and flow queries know how to traverse.

A scan processes one file at a time, so your extractor doesn't need to track global state across files. Keep everything local to the `extract` call.

---

## Opting into test-map alerts

The test-map alert feature (`scripts/test-alerts.js` / `/test-map`) cross-references recent source changes against their paired test files and flags drift. Pairing logic lives in each extractor — add a `testPairs` block and your language participates. Omit it and the feature skips your files entirely (graceful non-participation).

**Shipped status:**

| Extractor | `testPairs` shipped | Notes |
|-----------|---------------------|-------|
| `javascript.js` | ✅ | `// @tests` annotations, sibling/`__tests__`/`test(s)/` candidates, plus flattened-parent `test(s)/<parent>-<name>.test.<ext>`. |
| `typescript.js` | ✅ | Same conventions as JS; extends to `.ts` / `.tsx`. |
| `python.js` | ✅ | `# @tests` annotations; `test_<name>.py`, `<name>_test.py`, `tests/` mirror, src-layout aware. |
| `svelte.js` | ✅ | Cross-extension: pairs `Foo.svelte` with `Foo.test.{ts,js}` siblings, `__tests__/`, `test(s)/`, and flattened-parent `test(s)/<parent>-<name>.test.{ts,js}`. Annotations go inside `<script>` blocks (`// @tests`). |
| `astro.js` | ✅ | Cross-extension: pairs `Foo.astro` with `Foo.test.{ts,js}` siblings, `__tests__/`, `test(s)/`, and flattened-parent variants. Annotations go inside the frontmatter (`// @tests`). |
| `markdown.js` | ❌ (intentional) | Markdown has no conventional source↔test pairing. Flagging every doc as `missing_test` would be noise. |

```js
const testPairs = {
  isTestFile(relPath) { /* boolean */ },
  candidateTestPaths(sourceRelPath) { /* array of relative paths to try */ },
  parseAnnotations(content) { /* array of source paths named by `// @tests` headers */ },
};

module.exports = { extensions, extract, testPairs };
```

### `isTestFile(relPath)`

Return `true` if this path looks like a test file in your language. Used to split the changed-file set into "sources" and "tests" before pairing. Keep the pattern broad — `.test.ts`, `.spec.tsx`, anything under `test/`, `tests/`, `__tests__/`, `spec/` — but only match what your language actually produces. JS and TS use:

```js
isTestFile(relPath) {
  return /\.test\.[mc]?tsx?$|\.spec\.[mc]?tsx?$/.test(relPath)
    || /(^|\/)(test|tests|__tests__|spec)\//.test(relPath);
},
```

### `candidateTestPaths(sourceRelPath)`

Given a source file, return an ordered list of where its test file would live if the project followed a conventional layout. The reconciler tries each in order and takes the first one that exists on disk. Nothing resolves further if none exist — the source is flagged as `missing_test` (when `check_missing_tests` is enabled).

Typical conventions to cover: sibling `.test.ext`, sibling `.spec.ext`, `__tests__/` subdirectory, top-level `test/` or `tests/` mirror, and flattened-parent `test/<parent>-<name>.test.ext` (for codebases that keep a single flat test directory — e.g., `lib/foo/bar.js` → `test/foo-bar.test.js`). Guard the flattened-parent case against `path.dirname() === '.'` so a root-level source doesn't yield a malformed `.-name` candidate. See `extractors/javascript.js:270` for the JS list.

### `parseAnnotations(content)` — **read this carefully**

Optional override: test files can explicitly name their source via a header comment:

```js
// @tests src/my-module.js
```

Your `parseAnnotations(content)` scans the first 20 lines of a test file and returns the list of source paths it declares. Only scan the header; do not scan the whole file (performance and correctness — a string literal mid-file shouldn't look like an annotation).

**Comment syntax is language-specific.** JS/TS/Svelte use `// @tests <path>`; Python uses `# @tests <path>`. Anchor the annotation regex to whichever line-comment sigil your language uses. For block-comment languages (e.g., `/* ... */`), pick a convention your users will recognize and document it in the extractor's header comment.

**Gotcha — use `[ \t]+`, not `\s+` in the regex.** `\s` matches newlines. A bare `// @tests` followed by a newline will silently capture the next non-whitespace token on the following line (e.g., `module.exports`). Mis-paired findings result. Correct form:

```js
parseAnnotations(content) {
  const header = content.split('\n').slice(0, 20).join('\n');
  const matches = [...header.matchAll(/\/\/[ \t]*@tests[ \t]+(\S+)/g)];
  return matches.map(m => m[1]);
},
```

(This has bitten both JS and TS extractors during development — it's the most common footgun.)

### How pairing is used at runtime

`lib/test-alerts/pairing.js` does the heavy lifting:

1. For every test file in the changed set (and every open finding's test file), calls `parseAnnotations` and builds a `source → tests` map.
2. For every changed source file, calls `candidateTestPaths`; an annotation override wins over conventional paths.
3. If no test file is found and `check_missing_tests` is enabled, emits a `missing_test` finding.
4. If a test exists but wasn't in the same commit range as the source, emits a `stale_pair` finding.

You don't call this machinery yourself — it all runs from the shared scan driver. Your job is just to declare the pairing rules for your language.

---

## labelDetectors

Heuristic detectors let your extractor tag graph nodes with semantic labels — what role a function plays, not just what it is. Detectors run at scan time (and again on edit via the post-tool-use hook) and write to the `code_labels` table. The feature is unconditional: if your extractor exports `labelDetectors`, they run.

### Required export

Add `labelDetectors` alongside `extensions` and `extract`:

```js
module.exports = { extensions, extract, testPairs, labelDetectors };
```

A missing `labelDetectors` export is non-fatal — the registry logs "no detectors loaded" and continues. A malformed detector (missing required field, or `category` outside the controlled vocabulary) causes the registry to reject it at load time and abort the scan with a clear error.

### Detector definition shape

`labelDetectors` is an array of detector objects:

```js
const labelDetectors = [
  {
    id: 'express-middleware',   // unique within this extractor; namespaced to <extractor-id>.<id> in storage
    category: 'middleware',     // must be from the controlled vocabulary below
    defaultTerm: 'middleware',  // stored as `term` when detect() does not return a term override
    detect(node, ctx) {
      // node: { name, type, line, file, body, metadata_json }
      //   body — extracted body text (same as --body output), or null if the node has no body
      // ctx:  { project, filePath, content, ast }
      //   content — full file text
      //   ast     — parsed AST if the extractor produced one, otherwise undefined

      // Return null if no match. Return a result object on match:
      return {
        term: 'auth middleware',  // optional — overrides defaultTerm when present
        descriptors: ['express', 'auth'],  // optional soft tags
        confidence: 0.85,         // required — clamped to [0.0, 1.0]
      };
    },
  },
];
```

### Controlled vocabulary for `category`

| Category | When to use |
|---|---|
| `middleware` | Function in a request-processing chain |
| `route-handler` | Endpoint that responds to a specific path/verb |
| `data-access` | Function or call that reads/writes the database |
| `auth-step` | Credential check, token issuance, session validation |
| `validation` | Input shape or constraint enforcement |
| `transaction-boundary` | Begin/commit/rollback or transactional wrapper |
| `template` | View/render/template emission |
| `background-task` | Queue worker, scheduled job, async dispatcher |
| `ipc-boundary` | Cross-process or cross-service call site |
| `error-handler` | Catch-block dispatcher, error middleware |

New categories require a doc update and reviewer sign-off. Do not invent a category if the existing ones don't fit — that is signal the detector covers too narrow or too broad a slice.

### `detect(node, ctx)` contract

- **Synchronous** — no async, no I/O, no network calls.
- **Must not throw** — return `null` on unexpected input; the runner wraps calls in try/catch and treats throws as null returns. One bad detector must not break a scan.
- **Return `null`** if the node is not a match.
- **Return a result object** on match: `{ term?, descriptors?, confidence }`.
  - `term` (optional string) — overrides `defaultTerm` when present.
  - `descriptors` (optional string[]) — soft tags rendered in brackets, e.g. `[express, request]`.
  - `confidence` (required number) — float in `[0.0, 1.0]`. Values outside this range are clamped with a warning.

### Stored `detector_id`

The registry namespaces each detector's `id` when writing to `code_labels`:

```
<extractor-id>.<detector.id>
// e.g.  js.express-middleware
```

The inner `id` on the detector object is short and unique within the extractor. The value persisted to the database is always the namespaced form.

### Example — two detectors

```js
const labelDetectors = [
  // Trivial detector: matches by parameter count alone
  {
    id: 'three-param-fn',
    category: 'middleware',
    defaultTerm: 'middleware',
    detect(node) {
      if (!node.body) return null;
      // Crude heuristic: 3-arity functions are often middleware
      const match = node.body.match(/^[^(]*\(([^)]*)\)/);
      if (!match) return null;
      const params = match[1].split(',').filter(p => p.trim());
      if (params.length !== 3) return null;
      return { confidence: 0.6 };
    },
  },

  // Richer detector: descriptors + term override
  {
    id: 'bcrypt-verify',
    category: 'auth-step',
    defaultTerm: 'credential verification',
    detect(node) {
      if (!node.body) return null;
      if (!/bcrypt(?:js)?\.compare\(/.test(node.body)) return null;
      return {
        term: 'bcrypt comparison',
        descriptors: ['bcrypt', 'password'],
        confidence: 0.95,
      };
    },
  },
];
```

### Relationship to `testPairs`

`labelDetectors` and `testPairs` are independent extractor-export contracts. Neither references the other. Adding one does not affect the other, and omitting either is non-fatal.

---

## Auto-discovery

The registry finds extractors by listing files in `extractors/` and requiring each one. There's no registration file to edit. Rules:

- File must be in `extractors/` (top-level, not a subdirectory).
- File must export `extensions: string[]` and `extract: function`.
- File must be `.js`. Other extensions are ignored.

Failure to load (syntax error, missing export, throw at require-time) is swallowed — your extractor won't participate, but scans keep working. Run `npm test` before shipping to catch this.

---

## Testing

Every extractor gets a companion test at `test/<language>-extractor.test.js`. Cover:

1. `extensions` is the array you expect.
2. `extract` produces the right nodes for each construct your language defines (one test per construct: function, class, import, export, …).
3. Relative imports become `imports` edges; npm/builtin imports do not.
4. If you ship `testPairs`, cover:
   - `isTestFile` returns `true` for each test-naming convention and `false` for sources.
   - `candidateTestPaths` returns sibling, subdirectory, and top-level variants.
   - `parseAnnotations` captures well-formed annotations, does **not** capture across newlines for a bare `// @tests`, and respects the 20-line header limit.

Existing tests in `test/javascript-extractor.test.js` and `test/typescript-extractor.test.js` are good starting templates.

---

## Minimal skeleton

Copy this into `extractors/mylang.js` and start filling it in:

```js
'use strict';

const path = require('path');

const USED_EDGE_TYPES = [
  { name: 'imports', category: 'structural',
    followsForBlastRadius: true, impliesStaleness: false,
    description: 'MyLang module import' },
];

function extract(content, filePath, project) {
  const nodes = [];
  const edges = [];

  const moduleName = path.basename(filePath);
  nodes.push({ project, file: filePath, name: moduleName, type: 'module', line: 1 });

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];
    // …parse line, push nodes/edges…
  }

  return { nodes, edges, edge_types: USED_EDGE_TYPES };
}

// Optional: opt into test-map alerts.
const testPairs = {
  isTestFile(relPath) {
    return /\.test\.mylang$|\.spec\.mylang$/.test(relPath)
      || /(^|\/)(test|tests|__tests__|spec)\//.test(relPath);
  },
  candidateTestPaths(sourceRelPath) {
    const ext = path.extname(sourceRelPath);
    const base = sourceRelPath.slice(0, -ext.length);
    const dir = path.dirname(sourceRelPath);
    const name = path.basename(base);
    return [
      `${base}.test${ext}`,
      `${base}.spec${ext}`,
      path.join(dir, '__tests__', `${name}.test${ext}`),
      path.join('test', sourceRelPath),
      path.join('tests', sourceRelPath),
    ];
  },
  parseAnnotations(content) {
    const header = content.split('\n').slice(0, 20).join('\n');
    const matches = [...header.matchAll(/\/\/[ \t]*@tests[ \t]+(\S+)/g)];
    return matches.map(m => m[1]);
  },
};

module.exports = { extensions: ['.mylang'], extract, testPairs };
```

Drop that file into `extractors/`, add a `test/mylang-extractor.test.js`, and you're participating in the graph and the test-map alerts.

## Known gaps — extractors we want

_(none currently tracked — open a PR or note one here when found)_
