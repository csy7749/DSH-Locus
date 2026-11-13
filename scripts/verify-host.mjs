// Host-integration check: loads dsh-locus against the *real* Cordis runtime and
// the *real* @deepseek-ai/dsh-tools validators that ship inside the installed
// DeepSeek Harness, without starting the app.
//
// The plugin ships with zero dependencies on purpose, so those packages are not
// installed here: they are extracted from the host's app.asar into a temp
// directory at run time. That makes this a genuine integration check -- it
// catches a bad tool schema, a broken effect, or a Cordis behaviour change --
// instead of a mock that agrees with itself.
//
//   node scripts/verify-host.mjs [--asar <path>] [--keep] [--verbose]
//
// Exit codes: 0 = passed, or skipped when no harness install is found; 1 = failed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const verbose = argv.includes('--verbose');
const asarArg = argv.includes('--asar') ? argv[argv.indexOf('--asar') + 1] : undefined;

function findAsar() {
  const candidates = [asarArg, process.env.DSH_ASAR];

  // The running harness knows where it lives: DSH_NODE_EXECUTABLE is the shell
  // binary next to resources/, and DSH_INSTALL_DIR points inside the archive.
  const executable = process.env.DSH_NODE_EXECUTABLE;
  if (executable) candidates.push(path.join(path.dirname(executable), 'resources', 'app.asar'));
  const installDir = process.env.DSH_INSTALL_DIR;
  if (installDir) {
    const marker = installDir.split(/[\\/]app\.asar[\\/]/)[0];
    if (marker !== installDir) candidates.push(path.join(marker, 'app.asar'));
  }

  candidates.push(
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'DeepSeek Harness', 'resources', 'app.asar'),
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar',
  );

  return candidates.filter(Boolean).find((candidate) => fs.existsSync(candidate));
}

const asarPath = findAsar();
if (!asarPath) {
  console.log('SKIPPED: no DeepSeek Harness app.asar found (pass --asar <path> or set DSH_ASAR).');
  process.exit(0);
}

// app.asar layout: [4][headerSize][stringSize][jsonSize][headerJSON][file data...]
const archive = fs.readFileSync(asarPath);
const stringSize = archive.readUInt32LE(8);
const jsonSize = archive.readUInt32LE(12);
const header = JSON.parse(archive.subarray(16, 16 + jsonSize).toString('utf8'));
const dataStart = 12 + stringSize;

// The build keeps two trees; either may hold a package.
const NODE_MODULE_ROOTS = ['node_modules', 'dsh/node_modules'];
const BUILTINS = new Set(builtinModules);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-locus-host-'));
const hostModules = path.join(scratch, 'host', 'node_modules');

function lookup(asarRelative) {
  let node = header;
  for (const segment of asarRelative.split('/').filter(Boolean)) {
    node = node.files?.[segment];
    if (!node) return undefined;
  }
  return node;
}

/** Copy one package subtree out of the archive. False when the build lacks it. */
function extractPackage(specifier) {
  const destination = path.join(hostModules, specifier);
  if (fs.existsSync(path.join(destination, 'package.json'))) return true;

  const source = NODE_MODULE_ROOTS.map((root) => `${root}/${specifier}`).find((candidate) => lookup(candidate)?.files);
  if (!source) return false;

  const walk = (entry, relative) => {
    for (const [file, meta] of Object.entries(entry.files ?? {})) {
      const childRelative = `${relative}/${file}`;
      if (meta.files) {
        walk(meta, childRelative);
        continue;
      }
      const target = path.join(destination, childRelative.slice(source.length + 1));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const start = dataStart + Number(meta.offset);
      fs.writeFileSync(target, archive.subarray(start, start + Number(meta.size)));
    }
  };
  walk(lookup(source), source);
  return fs.existsSync(path.join(destination, 'package.json'));
}

/** Package root of a bare specifier: `a/b/c` and `@s/a/b` both mean `@s/a`. */
function packageRootOf(specifier) {
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/');
    return name ? `${scope}/${name}` : undefined;
  }
  return specifier.split('/')[0];
}

/**
 * Collect every bare import in a package's shipped JavaScript.
 *
 * This is read before anything is imported on purpose: Node caches a failed
 * module resolution, so a "import, catch, extract, retry" loop never recovers --
 * it keeps replaying the first failure. Extracting the graph up front avoids
 * that, and it also catches the internal aliases the manifests do not declare.
 */
function scanDependencies(directory) {
  const found = new Set();
  const entries = fs.readdirSync(directory, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(?:js|mjs|cjs)$/.test(entry.name)) continue;
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    if (!file.startsWith(directory)) continue;
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // Static imports, re-exports, side-effect imports, dynamic imports and requires.
    for (const match of source.matchAll(/(?:^|[\s;}])(?:import|export)\s[^'"()]*?from\s*['"]([^'"]+)['"]|(?:^|[^\w$.])import\s*\(\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:') || specifier.startsWith('data:') || specifier.startsWith('#')) continue;
      if (BUILTINS.has(specifier)) continue;
      const root = packageRootOf(specifier);
      if (root) found.add(root);
    }
  }
  return found;
}

/** Extract a package and, breadth-first, everything it can reach. */
function extractClosure(specifier) {
  const queue = [specifier];
  const seen = new Set();
  const extracted = [];
  while (queue.length > 0) {
    const next = queue.shift();
    if (seen.has(next)) continue;
    seen.add(next);
    if (!extractPackage(next)) {
      if (next === specifier) return undefined;
      continue;
    }
    extracted.push(next);
    const directory = path.join(hostModules, next);

    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
      for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const dependency of Object.keys(manifest[field] ?? {})) {
          if (!dependency.startsWith('@deepseek-ai/') && field === 'peerDependencies') continue;
          queue.push(dependency);
        }
      }
    } catch {}

    for (const dependency of scanDependencies(directory)) queue.push(dependency);
  }
  return extracted;
}

/** Import an already-extracted package by its real entry point. */
function importHostPackage(specifier, entry = 'lib/index.js') {
  const target = path.join(hostModules, specifier, entry);
  if (!fs.existsSync(target)) throw new Error(`${specifier}: ${entry} is missing from the extracted package`);
  return import(pathToFileURL(target).href);
}

const checks = [];

try {
  console.log(`host: ${asarPath}`);
  console.log(`scratch: ${scratch}`);

  process.env.DSH_LOCUS_STATE = path.join(scratch, 'state');

  // ---- 1. The plugin mounts on the real Cordis ------------------------------
  const cordisClosure = extractClosure('@deepseek-ai/cordis');
  if (!cordisClosure) throw new Error(`@deepseek-ai/cordis is not inside ${asarPath}`);
  if (verbose) console.log(`cordis closure: ${cordisClosure.length} packages`);

  const { Context } = await importHostPackage('@deepseek-ai/cordis');
  const plugin = await import(pathToFileURL(path.resolve('index.js')).href);

  const registered = new Map();
  const root = new Context();
  root.plugin({
    name: 'test-tools-service',
    apply(ctx) {
      ctx.reflect.provide('tools', {
        register(definition) {
          if (registered.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`);
          registered.set(definition.name, definition);
          return () => registered.delete(definition.name);
        },
      });
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  if (!root.tools) throw new Error('the fake tools service was not provided');

  const fiber = root.plugin({ name: 'dsh-locus', apply: plugin.apply }, {});
  await new Promise((resolve) => setTimeout(resolve, 150));

  const names = [...registered.keys()].sort();
  if (names.length !== 14) throw new Error(`expected 14 tools, got ${names.length}: ${names.join(', ')}`);
  checks.push(`Cordis: plugin mounted, ${names.length} tools registered`);

  if (typeof fiber?.dispose !== 'function') throw new Error('Cordis did not hand back a disposer');
  await fiber.dispose();
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (registered.size !== 0) throw new Error('disposing the plugin left tools registered');
  checks.push('Cordis: fiber disposal unregistered every tool');

  // ---- 2. The schemas pass the host's own validators -----------------------
  const toolsClosure = extractClosure('@deepseek-ai/dsh-tools');
  if (!toolsClosure) throw new Error(`@deepseek-ai/dsh-tools is not inside ${asarPath}`);
  if (verbose) console.log(`dsh-tools closure: ${toolsClosure.length} packages`);

  const dshTools = await importHostPackage('@deepseek-ai/dsh-tools');
  const { createTools } = await import(pathToFileURL(path.resolve('src/tools/index.js')).href);
  const tools = createTools({
    allowExecute: true,
    timeoutMs: 30000,
    processTimeoutMs: 120000,
    latexEngine: 'auto',
    svgPreview: true,
  });

  const samples = {
    unity_status: { project: 'MyGame' },
    unity_execute: { code: 'return 1;', mode: 'editor' },
    unity_console: { limit: 20, level: 'error' },
    unity_playmode: { action: 'play' },
    unity_asset_search: { query: 't:Prefab Boss', type: 'prefab', limit: 10 },
    unity_asset_read: { path: 'Assets/Game.cs', maxBytes: 4096 },
    unity_menu: { path: 'File/Save' },
    unity_recompile: {},
    blender_status: {},
    blender_execute: { code: 'print(1)' },
    blender_screenshot: { path: 'C:/tmp/shot.png' },
    latex_build: { texPath: 'paper/main.tex', engine: 'xelatex', svg: true },
    latex_status: {},
    locus_instances: {},
  };

  const validate = (tool, value) => dshTools.validateJsonSchemaValue(tool.parameters, value, '');

  for (const tool of tools) {
    dshTools.assertSupportedJsonSchema(tool.parameters); // throws when the host rejects it
    dshTools.assertObjectJsonSchema(tool.parameters);
    dshTools.assertSupportedJsonSchema(tool.output.schema);
    dshTools.projectToolSchema(tool); // throws when parameters are not lossless JSON
    if (typeof tool.output.render !== 'function') throw new Error(`${tool.name}: output.render is not a function`);

    const required = tool.parameters.required ?? [];
    const empty = validate(tool, {});
    if (required.length === 0) {
      if (empty.length > 0) throw new Error(`${tool.name}: an empty call must validate, got ${JSON.stringify(empty)}`);
    } else if (empty.length === 0) {
      throw new Error(`${tool.name}: an empty call must be rejected (${required.join(', ')})`);
    }

    if (!Object.hasOwn(samples, tool.name)) throw new Error(`verify-host: add a sample call for ${tool.name}`);
    const problems = validate(tool, samples[tool.name]);
    if (problems.length > 0) throw new Error(`${tool.name}: a realistic call was rejected: ${JSON.stringify(problems)}`);
  }
  checks.push(`dsh-tools: ${tools.length} parameter and result schemas accepted by the host`);

  const rejected = [
    ['unity_console', { limit: 'many' }],
    ['unity_playmode', { action: 'rewind' }],
    ['latex_build', { engine: 'latex3' }],
    ['unity_execute', { code: 42 }],
  ];
  for (const [name, value] of rejected) {
    const tool = tools.find((entry) => entry.name === name);
    if (!tool) throw new Error(`missing tool ${name}`);
    if (validate(tool, value).length === 0) throw new Error(`${name} should have rejected ${JSON.stringify(value)}`);
  }
  checks.push('dsh-tools: invalid arguments are still rejected (the checks above are not vacuous)');

  // ---- 3. Real results survive the host's own lossless materializer --------
  // The executor calls snapshotJsonValue() on every tool body result and turns
  // `undefined` into `tool "X" returned invalid output: value is not lossless
  // JSON`. Comparing against that exact function is what catches a result with
  // undefined fields, which JSON would otherwise silently drop.
  extractClosure('@deepseek-ai/dsh-util-values');
  const { snapshotJsonValue } = await importHostPackage('@deepseek-ai/dsh-util-values');

  const offline = [
    ['latex_status', {}],
    ['locus_instances', {}],
  ];
  for (const [name, args] of offline) {
    const tool = tools.find((entry) => entry.name === name);
    if (!tool) throw new Error(`missing tool ${name}`);
    const value = await tool.execute(args, {});
    const snapshot = snapshotJsonValue(value);
    if (snapshot === undefined) {
      throw new Error(`${name}: the host would reject this result as "value is not lossless JSON" (${JSON.stringify(value)?.slice(0, 200)})`);
    }
    if (JSON.stringify(snapshot) !== JSON.stringify(value)) {
      throw new Error(`${name}: the host would rewrite the result, so a field is not JSON data`);
    }
  }
  checks.push(`dsh-util-values: ${offline.length} real tool results pass snapshotJsonValue unchanged`);

  console.log('\nPASS');
  for (const line of checks) console.log(`  - ${line}`);
} catch (error) {
  console.error('\nFAIL:', error?.stack ?? error);
  process.exitCode = 1;
} finally {
  if (keep) console.log(`\nkept: ${scratch}`);
  else {
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {}
  }
}
