#!/usr/bin/env node
// spec-check — cross-check specs and plans in one or more folders for collisions,
// AND extract chunk assignments for Sonnet handoffs from a plan markdown file.

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const os = require('os');

const SPEC_CHECK_LIB = path.join(__dirname, '..', 'lib', 'spec-check');

const { walkSpecDir } = require(path.join(SPEC_CHECK_LIB, 'walker.js'));
const { parseFrontmatter } = require(path.join(SPEC_CHECK_LIB, 'frontmatter-parser.js'));
const { renderTemplate } = require(path.join(SPEC_CHECK_LIB, 'schema.js'));
const { detectAll } = require(path.join(SPEC_CHECK_LIB, 'collision-detector.js'));
const { renderReport } = require(path.join(SPEC_CHECK_LIB, 'report-formatter.js'));
const { listChunks, assembleAssignment, computeDispatchPayloads } = require(path.join(SPEC_CHECK_LIB, 'chunk-extractor.js'));
const { loadConfig } = require(path.join(__dirname, '..', 'lib', 'config.js'));

// Parse argv into a structured options object.
function parseArgs(argv) {
  const opts = {
    dirs: [],
    template: null,
    strict: false,
    listChunks: null,       // plan path
    chunkRange: null,       // { plan, n }
    chunkContent: null,     // { plan, n }
    dispatch: null,         // plan path
    preamble: null,         // true | false | null (null = defer to config)
    commandLogPath: undefined, // string | '' | undefined (undefined = defer to config, '' = disable)
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') { opts.dirs.push(argv[++i]); }
    else if (a === '--template') { opts.template = argv[++i]; }
    else if (a === '--strict') { opts.strict = true; }
    else if (a === '--list-chunks') { opts.listChunks = argv[++i]; }
    else if (a === '--chunk-range') { opts.chunkRange = { plan: argv[++i], n: parseInt(argv[++i], 10) }; }
    else if (a === '--chunk-content') { opts.chunkContent = { plan: argv[++i], n: parseInt(argv[++i], 10) }; }
    else if (a === '--dispatch') { opts.dispatch = argv[++i]; }
    else if (a === '--preamble') {
      if (opts.preamble === false) throw new Error('conflicting preamble flags');
      opts.preamble = true;
    }
    else if (a === '--no-preamble') {
      if (opts.preamble === true) throw new Error('conflicting preamble flags');
      opts.preamble = false;
    }
    else if (a.startsWith('--command-log=')) {
      opts.commandLogPath = a.slice('--command-log='.length);
    }
    else if (a === '--command-log') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error('--command-log requires a path or use --command-log= to disable');
      }
      i++;
      opts.commandLogPath = next;
    }
    else if (a === '--help' || a === '-h') { opts.help = true; }
    else { throw new Error(`unknown argument: ${a}`); }
  }
  return opts;
}

function printHelp() {
  console.log(`
spec-check — cross-check spec/plan markdown docs and extract chunk assignments

Usage:
  spec-check.js --dir <path> [--dir <path>...]   Scan folders for collisions
  spec-check.js --template spec                    Print spec frontmatter template
  spec-check.js --template plan                    Print plan frontmatter template
  spec-check.js --dir <path> --strict              Exit non-zero if headerless docs exist
  spec-check.js --list-chunks <plan>               List chunks in a plan with line ranges
  spec-check.js --chunk-range <plan> <n>           Print "L<start>-L<end>" for chunk n
  spec-check.js --chunk-content <plan> <n>         Print chunk assignment for chunk n
  spec-check.js --dispatch <plan>                  Write every chunk's assignment to <plan-dir>/chunks/

By default, --chunk-content and --dispatch emit the full assignment: standing-
rules preamble + plan header + observations + chunk body, and --dispatch
appends read instructions to ~/claude/command-log.txt. To override defaults
globally, set spec_check in ~/.claude/greymatter/config.json:

  {
    "spec_check": {
      "preamble": false,
      "command_log_path": ""
    }
  }

Or override per-invocation:
  --preamble                        Force preamble ON (overrides config)
  --no-preamble                     Force preamble OFF (overrides config)
  --command-log <path>              Force dispatch to append to <path>
  --command-log=                    Force dispatch NOT to write any command log
`);
}

// Read the sibling observations file for a plan, or empty string if missing.
function readObservationsSync(planPath) {
  const dir = path.dirname(planPath);
  const stem = path.basename(planPath, '.md');
  const obsPath = path.join(dir, `${stem}.observations.md`);
  try { return fsSync.readFileSync(obsPath, 'utf8'); }
  catch { return ''; }
}

// Main orchestration.
async function main(argv) {
  let opts;
  try { opts = parseArgs(argv); }
  catch (err) { console.error(err.message); printHelp(); return 3; }

  if (opts.help) { printHelp(); return 0; }

  if (opts.template) {
    try { console.log(renderTemplate(opts.template)); return 0; }
    catch (err) { console.error(err.message); return 3; }
  }

  // Chunk-extractor surfaces — operate on a single plan file, not a folder.
  if (opts.listChunks) {
    try {
      const contents = await fs.readFile(path.resolve(opts.listChunks), 'utf8');
      const chunks = listChunks(contents);
      if (chunks.length === 0) { console.log('(no chunks found)'); return 0; }
      for (const c of chunks) {
        console.log(`Chunk ${c.number}: ${c.name}  [L${c.startLine}-L${c.endLine}, ${c.lineCount} lines]`);
      }
      return 0;
    } catch (err) { console.error(`spec-check: ${err.message}`); return 3; }
  }

  if (opts.chunkRange) {
    try {
      const contents = await fs.readFile(path.resolve(opts.chunkRange.plan), 'utf8');
      const chunks = listChunks(contents);
      const target = chunks.find(c => c.number === opts.chunkRange.n);
      if (!target) { console.error(`spec-check: chunk ${opts.chunkRange.n} not found`); return 3; }
      console.log(`L${target.startLine}-L${target.endLine}`);
      return 0;
    } catch (err) { console.error(`spec-check: ${err.message}`); return 3; }
  }

  if (opts.chunkContent) {
    try {
      const planPath = path.resolve(opts.chunkContent.plan);
      const contents = await fs.readFile(planPath, 'utf8');
      const observations = readObservationsSync(planPath);
      const config = loadConfig();
      const specCheckConfig = config.spec_check || {};
      const preamble = opts.preamble !== null
        ? opts.preamble
        : ('preamble' in specCheckConfig ? Boolean(specCheckConfig.preamble) : true);
      const out = assembleAssignment({
        planPath,
        planContents: contents,
        chunkNumber: opts.chunkContent.n,
        observations,
        preamble,
      });
      console.log(out);
      return 0;
    } catch (err) { console.error(`spec-check: ${err.message}`); return 3; }
  }

  if (opts.dispatch) {
    try {
      const planPath = path.resolve(opts.dispatch);
      const contents = await fs.readFile(planPath, 'utf8');
      const observations = readObservationsSync(planPath);
      const config = loadConfig();
      const specCheckConfig = config.spec_check || {};
      const preamble = opts.preamble !== null
        ? opts.preamble
        : ('preamble' in specCheckConfig ? Boolean(specCheckConfig.preamble) : true);
      let commandLogPath;
      if (opts.commandLogPath !== undefined) {
        commandLogPath = opts.commandLogPath === '' ? null : opts.commandLogPath;
      } else if (specCheckConfig.command_log_path === '') {
        commandLogPath = null;
      } else if (specCheckConfig.command_log_path) {
        commandLogPath = specCheckConfig.command_log_path;
      } else {
        commandLogPath = path.join(os.homedir(), 'claude', 'command-log.txt');
      }

      const payloads = computeDispatchPayloads({ planPath, planContents: contents, observations, preamble });
      if (payloads.length === 0) {
        console.error(`spec-check: no chunks found in ${planPath}`);
        return 3;
      }
      const chunksDir = path.dirname(payloads[0].filePath);
      fsSync.mkdirSync(chunksDir, { recursive: true });

      for (const p of payloads) {
        fsSync.writeFileSync(p.filePath, p.content, 'utf8');
      }

      console.log(`Wrote ${payloads.length} chunk${payloads.length === 1 ? '' : 's'} to ${chunksDir}/`);
      for (const p of payloads) {
        console.log(`  Chunk ${p.chunkNumber}: ${p.fileName}${p.chunkName ? ` — ${p.chunkName}` : ''}`);
      }

      if (commandLogPath) {
        fsSync.mkdirSync(path.dirname(commandLogPath), { recursive: true });
        const logLines = payloads.map(p => p.readInstruction).join('\n') + '\n';
        fsSync.appendFileSync(commandLogPath, logLines, 'utf8');
        console.log(`Appended ${payloads.length} read instruction${payloads.length === 1 ? '' : 's'} to ${commandLogPath}`);
      }
      return 0;
    } catch (err) { console.error(`spec-check: ${err.message}`); return 3; }
  }

  if (opts.dirs.length === 0) {
    console.error('spec-check: must pass --dir, --template, --list-chunks, --chunk-range, --chunk-content, or --dispatch');
    printHelp();
    return 3;
  }

  const allFiles = [];
  for (const dir of opts.dirs) {
    try {
      const files = await walkSpecDir(path.resolve(dir));
      allFiles.push(...files);
    } catch (err) {
      console.error(`spec-check: ${err.message}`);
      return 3;
    }
  }

  const docs = [];
  const headerless = [];
  for (const filePath of allFiles) {
    const contents = await fs.readFile(filePath, 'utf8');
    const lineCount = contents.split('\n').length;
    const id = path.basename(filePath, '.md');
    const r = parseFrontmatter(contents, filePath);
    if (r.ok) {
      docs.push({ id, filePath, lineCount, data: r.data });
    } else if (r.errors[0].code === 'HEADERLESS') {
      headerless.push({ id, filePath, lineCount });
    } else {
      console.error(`spec-check: ${filePath} has errors:`);
      for (const e of r.errors) console.error(`  - [${e.code}] ${e.message}`);
    }
  }

  const collisions = detectAll(docs);
  const report = renderReport({
    docs, collisions, headerless,
    meta: { folderCount: opts.dirs.length, docCount: allFiles.length },
  });
  console.log(report);

  const hasHard =
    collisions.fileCollisions.some(c => c.severity === 'hard') ||
    collisions.schemaCollisions.length > 0 ||
    collisions.doubleEmits.length > 0;
  if (hasHard) return 1;
  if (opts.strict && headerless.length > 0) return 2;
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => process.exit(code)).catch(err => {
    console.error('spec-check: unexpected error:', err);
    process.exit(3);
  });
}

module.exports = { main, parseArgs };
