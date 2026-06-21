'use strict';

// @tests extractors/astro.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const extractor = require('../extractors/astro');
const { runDetectorsForNode } = require('../lib/extractor-registry');

describe('Astro Extractor', () => {
  it('has correct extension', () => {
    assert.deepEqual(extractor.extensions, ['.astro']);
  });

  it('extracts component name from filename', () => {
    const result = extractor.extract(
      "---\nconst x = 1;\n---\n<h1>Hello</h1>\n",
      'src/components/Header.astro', 'p'
    );
    const component = result.nodes.find(n => n.type === 'component');
    assert.ok(component);
    assert.equal(component.name, 'Header');
    assert.equal(component.line, 1);
  });

  it('extracts imports from frontmatter', () => {
    const result = extractor.extract(
      "---\nimport Layout from '../layouts/Layout.astro';\nimport { fetchData } from '../lib/api';\n---\n<h1>x</h1>\n",
      'src/pages/index.astro', 'p'
    );
    const imports = result.edges.filter(e => e.type === 'imports');
    assert.ok(imports.some(e => e.target === '../layouts/Layout.astro'), 'finds Layout import');
    assert.ok(imports.some(e => e.target === '../lib/api'), 'finds named import');
  });

  it('skips npm/builtin imports', () => {
    const result = extractor.extract(
      "---\nimport { z } from 'zod';\nimport Card from './Card.astro';\n---\n",
      'src/pages/index.astro', 'p'
    );
    const imports = result.edges.filter(e => e.type === 'imports');
    assert.ok(!imports.some(e => e.target === 'zod'), 'npm package not edge');
    assert.ok(imports.some(e => e.target === './Card.astro'), 'relative import is edge');
  });

  it('skips TS type-only imports', () => {
    const result = extractor.extract(
      "---\nimport type { Foo } from './types';\nimport Card from './Card.astro';\n---\n",
      'src/pages/index.astro', 'p'
    );
    const imports = result.edges.filter(e => e.type === 'imports');
    assert.ok(!imports.some(e => e.target === './types'), 'type-only import not edge');
    assert.ok(imports.some(e => e.target === './Card.astro'));
  });

  it('extracts props from interface Props', () => {
    const result = extractor.extract(
      "---\ninterface Props {\n  title: string;\n  count?: number;\n  items: Item[];\n}\nconst { title, count = 0, items } = Astro.props;\n---\n",
      'src/components/Card.astro', 'p'
    );
    const props = result.nodes.filter(n => n.type === 'prop');
    const propNames = props.map(p => p.name).sort();
    assert.deepEqual(propNames, ['count', 'items', 'title']);
    const exportEdges = result.edges.filter(e => e.type === 'exports');
    assert.ok(exportEdges.some(e => e.target === 'title'));
  });

  it('extracts props from Astro.props destructure (no interface)', () => {
    const result = extractor.extract(
      "---\nconst { title, count = 0, ...rest } = Astro.props;\n---\n<h1>{title}</h1>\n",
      'src/components/Banner.astro', 'p'
    );
    const props = result.nodes.filter(n => n.type === 'prop');
    const propNames = props.map(p => p.name).sort();
    // `...rest` is filtered out — it's a catch-all, not a named prop.
    assert.deepEqual(propNames, ['count', 'title']);
  });

  it('extracts exported bindings (getStaticPaths, prerender)', () => {
    const result = extractor.extract(
      "---\nexport const prerender = false;\nexport async function getStaticPaths() { return []; }\n---\n<h1>x</h1>\n",
      'src/pages/[slug].astro', 'p'
    );
    const exportEdges = result.edges.filter(e => e.type === 'exports');
    assert.ok(exportEdges.some(e => e.target === 'prerender'));
    assert.ok(exportEdges.some(e => e.target === 'getStaticPaths'));
    const fn = result.nodes.find(n => n.name === 'getStaticPaths');
    assert.equal(fn.type, 'function');
  });

  it('extracts component usage from template', () => {
    const result = extractor.extract(
      "---\nimport Layout from './Layout.astro';\nimport Card from './Card.astro';\n---\n<Layout>\n  <Card title=\"a\" />\n  <Card title=\"b\" client:load />\n  <div>html</div>\n</Layout>\n",
      'src/pages/index.astro', 'p'
    );
    const usage = result.edges.filter(e => e.type === 'uses_component');
    const targets = usage.map(e => e.target).sort();
    assert.deepEqual(targets, ['Card', 'Layout']);
    // <div> is lowercase — must NOT appear.
    assert.ok(!usage.some(e => e.target === 'div'));
  });

  it('extracts slot tags (default + named)', () => {
    const result = extractor.extract(
      "---\n---\n<header><slot name=\"header\" /></header>\n<main><slot /></main>\n<footer><slot name=\"footer\"></slot></footer>\n",
      'src/layouts/Layout.astro', 'p'
    );
    const slots = result.nodes.filter(n => n.type === 'slot').map(n => n.name).sort();
    assert.deepEqual(slots, ['default', 'footer', 'header']);
  });

  it('handles file without frontmatter (template only)', () => {
    const result = extractor.extract(
      "<h1>Static page</h1>\n<p>No frontmatter here.</p>\n",
      'src/pages/about.astro', 'p'
    );
    const component = result.nodes.find(n => n.type === 'component');
    assert.ok(component);
    assert.equal(component.name, 'about');
    // No imports, no props, no exports.
    assert.equal(result.edges.filter(e => e.type === 'imports').length, 0);
    assert.equal(result.edges.filter(e => e.type === 'exports').length, 0);
  });

  it('handles file with empty frontmatter', () => {
    const result = extractor.extract(
      "---\n---\n<h1>x</h1>\n",
      'src/pages/empty.astro', 'p'
    );
    assert.ok(result.nodes.find(n => n.type === 'component'));
    assert.equal(result.edges.length, 0);
  });

  it('handles malformed frontmatter (no closing fence) gracefully', () => {
    const result = extractor.extract(
      "---\nimport Layout from './Layout.astro';\n<h1>missing closing fence</h1>\n",
      'src/pages/broken.astro', 'p'
    );
    // Falls back to no-frontmatter mode — component node still emitted.
    assert.ok(result.nodes.find(n => n.type === 'component'));
  });

  it('does not duplicate same import', () => {
    const result = extractor.extract(
      "---\nimport Card from './Card.astro';\nimport Card2 from './Card.astro';\n---\n",
      'src/pages/index.astro', 'p'
    );
    const cardImports = result.edges.filter(e => e.type === 'imports' && e.target === './Card.astro');
    assert.equal(cardImports.length, 1);
  });

  describe('testPairs.isTestFile', () => {
    it('matches .test.astro and .spec.astro', () => {
      assert.equal(extractor.testPairs.isTestFile('Card.test.astro'), true);
      assert.equal(extractor.testPairs.isTestFile('Card.spec.astro'), true);
      assert.equal(extractor.testPairs.isTestFile('Card.astro'), false);
    });

    it('matches test/ and __tests__/ directories', () => {
      assert.equal(extractor.testPairs.isTestFile('test/Card.astro'), true);
      assert.equal(extractor.testPairs.isTestFile('src/__tests__/Card.astro'), true);
    });
  });

  describe('testPairs.candidateTestPaths', () => {
    it('crosses extensions to TS/JS test files', () => {
      const candidates = extractor.testPairs.candidateTestPaths('src/components/Card.astro');
      assert.ok(candidates.includes('src/components/Card.test.ts'));
      assert.ok(candidates.includes('src/components/Card.spec.ts'));
      assert.ok(candidates.includes('src/components/Card.test.js'));
    });

    it('includes __tests__ subdirectory and top-level test dirs', () => {
      const candidates = extractor.testPairs.candidateTestPaths('src/components/Card.astro');
      assert.ok(candidates.includes('src/components/__tests__/Card.test.ts'));
      assert.ok(candidates.includes('test/Card.test.ts'));
      assert.ok(candidates.includes('tests/Card.test.ts'));
    });

    it('emits flattened-parent variants', () => {
      const candidates = extractor.testPairs.candidateTestPaths('src/components/Card.astro');
      assert.ok(candidates.includes('test/components-Card.test.ts'));
    });

    it('does not emit malformed flattened-parent for root-level source', () => {
      const candidates = extractor.testPairs.candidateTestPaths('Root.astro');
      assert.ok(!candidates.some(c => c.startsWith('test/.-')), 'no .-name path');
    });
  });

  describe('testPairs.parseAnnotations', () => {
    it('captures // @tests annotations from frontmatter', () => {
      const sources = extractor.testPairs.parseAnnotations(
        "---\n// @tests src/components/Card.astro\nimport Card from './Card.astro';\n---\n"
      );
      assert.deepEqual(sources, ['src/components/Card.astro']);
    });

    it('does not capture across newlines for bare // @tests', () => {
      const sources = extractor.testPairs.parseAnnotations(
        "---\n// @tests\nimport x from './x';\n---\n"
      );
      assert.deepEqual(sources, []);
    });

    it('respects 20-line header limit', () => {
      const padding = Array(25).fill('// padding').join('\n');
      const sources = extractor.testPairs.parseAnnotations(
        `---\n${padding}\n// @tests src/late.astro\n---\n`
      );
      assert.deepEqual(sources, []);
    });
  });
});

describe('Astro extractBody', () => {
  const SOURCE = [
    '---',
    'export async function getStaticPaths() {',
    "  return [{ params: { slug: 'a' } }];",
    '}',
    '---',
    '',
    '<h1>Hello</h1>',
  ].join('\n');

  it('extracts function body from inside frontmatter', () => {
    // getStaticPaths is on file line 2 (line 1 is opening ---).
    const body = extractor.extractBody(SOURCE, { line: 2, name: 'getStaticPaths' });
    assert.ok(body, 'should return body string');
    assert.ok(body.includes('export async function getStaticPaths'));
    assert.ok(body.trimEnd().endsWith('}'));
    assert.equal(body.split('\n').length, 3);
  });

  it('returns null for node.line outside the frontmatter', () => {
    const body = extractor.extractBody(SOURCE, { line: 7, name: 'unknown' });
    assert.equal(body, null);
  });

  it('returns null when there is no frontmatter', () => {
    const body = extractor.extractBody('<h1>Hello</h1>', { line: 1, name: 'x' });
    assert.equal(body, null);
  });
});

describe('Astro labelDetectors — astro-get-static-paths', () => {
  function runAstro(filePath, nodeName = 'getStaticPaths') {
    const fixture = "export async function getStaticPaths() { return []; }";
    const node = { name: nodeName, type: 'function', line: 1, body: fixture };
    const ctx = { project: 'p', filePath, content: fixture };
    return runDetectorsForNode(extractor, node, ctx);
  }

  it('detects getStaticPaths in .astro file', () => {
    const label = runAstro('src/pages/[slug].astro').find(l => l.detectorId === 'astro-get-static-paths');
    assert.ok(label, 'should detect getStaticPaths');
    assert.equal(label.category, 'route-handler');
  });

  it('does not detect in non-.astro file', () => {
    const label = runAstro('src/lib/util.ts').find(l => l.detectorId === 'astro-get-static-paths');
    assert.ok(!label, 'should not detect outside .astro');
  });

  it('does not detect non-getStaticPaths name', () => {
    const label = runAstro('src/pages/[slug].astro', 'foo').find(l => l.detectorId === 'astro-get-static-paths');
    assert.ok(!label, 'should not detect on unrelated name');
  });
});
