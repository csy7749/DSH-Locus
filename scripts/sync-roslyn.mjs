#!/usr/bin/env node
/**
 * Copy the Roslyn script assemblies into unity-package/Editor/Roslyn.
 *
 * They are not committed to this repository, so a clean checkout has to stage
 * them once before the Unity package compiles.
 *
 * Preferred source: the Roslyn build that ships inside the Unity editor itself
 * (`<Editor>/Data/MonoBleedingEdge/lib/mono/msbuild/Current/bin/Roslyn`). That
 * set is internally consistent AND has the same assembly identities the editor
 * already loads. Use --from to select the matching Unity installation explicitly
 * when several editor versions are installed. Do not mix dependency versions.
 *
 * Usage:
 *   node scripts/sync-roslyn.mjs [--from <dir>] [--check] [--clean]
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const targetDir = path.join(repoRoot, 'unity-package', 'Editor', 'Roslyn')

/** Assemblies the editor assembly references, in dependency order. */
const REQUIRED = [
  'Microsoft.CodeAnalysis.dll',
  'Microsoft.CodeAnalysis.CSharp.dll',
  'Microsoft.CodeAnalysis.Scripting.dll',
  'Microsoft.CodeAnalysis.CSharp.Scripting.dll',
  'System.Collections.Immutable.dll',
  'System.Reflection.Metadata.dll',
  'System.Memory.dll',
  'System.Runtime.CompilerServices.Unsafe.dll',
]

/** Localized satellite assemblies; optional, copied when present. */
const OPTIONAL_PATTERN = /\.resources\.dll$/i

/**
 * Roslyn folders inside Unity installations, best candidate first.
 * @returns {string[]} directories that may hold a complete set.
 */
function unityRoslynDirs() {
  /** @type {string[]} */
  const roots = []
  const hubFiles = []
  if (process.env.APPDATA) hubFiles.push(path.join(process.env.APPDATA, 'UnityHub', 'editors-v2.json'))
  for (const file of hubFiles) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      for (const entry of parsed?.data ?? []) {
        for (const location of entry?.location ?? []) {
          roots.push(path.dirname(location))
        }
      }
    } catch {}
  }
  for (const root of ['C:\\Program Files\\Unity\\Hub\\Editor', 'D:\\Program Files\\Unity\\Hub\\Editor', '/Applications/Unity/Hub/Editor']) {
    try {
      for (const version of fs.readdirSync(root)) roots.push(path.join(root, version, 'Editor'))
    } catch {}
  }
  if (process.env.DSH_LOCUS_UNITY_EDITOR) roots.unshift(process.env.DSH_LOCUS_UNITY_EDITOR)
  // Newest editor first, so the newest Roslyn wins.
  roots.sort().reverse()
  return roots.map((root) => path.join(root, 'Data', 'MonoBleedingEdge', 'lib', 'mono', 'msbuild', 'Current', 'bin', 'Roslyn'))
}

const argv = process.argv.slice(2)
const flag = (/** @type {string} */ name) => argv.includes(`--${name}`)
const value = (/** @type {string} */ name) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}

const explicit = value('from') ?? process.env.DSH_LOCUS_ROSLYN

const candidates = [
  explicit,
  ...unityRoslynDirs(),
].filter(Boolean)

/** @param {string | undefined} dir - candidate source directory. */
function hasAll(dir) {
  if (!dir || !fs.existsSync(dir)) return false
  return REQUIRED.every((name) => fs.existsSync(path.join(dir, name)))
}

const source = candidates.find((dir) => hasAll(/** @type {string} */ (dir)))

if (flag('clean')) {
  fs.rmSync(targetDir, { recursive: true, force: true })
  console.log(`Removed ${path.relative(repoRoot, targetDir)}`)
  process.exit(0)
}

if (!source) {
  console.error('Could not find a complete set of Unity Roslyn assemblies. Tried:')
  for (const candidate of candidates) console.error(`  ${candidate}`)
  console.error('')
  console.error('Use the Roslyn folder from the Unity editor used by your project:')
  console.error('  <Editor>/Data/MonoBleedingEdge/lib/mono/msbuild/Current/bin/Roslyn')
  console.error('All dependencies must come from a compatible set; do not mix NuGet versions.')
  console.error('')
  console.error('Then rerun: node scripts/sync-roslyn.mjs --from <that folder>')
  process.exit(1)
}

if (flag('check')) {
  const ready = hasAll(targetDir)
  console.log(ready ? `Roslyn assemblies are staged in ${path.relative(repoRoot, targetDir)}` : 'Roslyn assemblies are not staged yet')
  process.exit(ready ? 0 : 1)
}

fs.mkdirSync(targetDir, { recursive: true })
const staged = new Set()
for (const name of fs.readdirSync(source)) {
  const isNeeded = REQUIRED.includes(name) || OPTIONAL_PATTERN.test(name)
  if (!isNeeded) continue
  fs.copyFileSync(path.join(source, name), path.join(targetDir, name))
  staged.add(name)
}

// Drop anything a previous run staged from a different Roslyn build: satellite
// assemblies from another version next to these are a mismatch waiting to
// fail, and the .meta files from the source checkout carry foreign GUIDs.
for (const name of fs.readdirSync(targetDir)) {
  if (name.endsWith('.meta')) continue
  if (!staged.has(name)) fs.rmSync(path.join(targetDir, name), { force: true })
}

/**
 * Deterministic Unity GUID for a staged DLL. Unity mints a random one on import,
 * but the generated GUID then depends on import order, which makes the package
 * diff churn between machines; deriving it from the file name keeps it stable.
 * @param {string} name - file name.
 */
function guidFor(name) {
  return createHash('sha1').update(`dsh-locus/roslyn/${name}`).digest('hex').slice(0, 32)
}

/**
 * .meta for a Roslyn assembly: Editor only, references not validated.
 *
 * Two problems this solves, both seen on the first real Unity import:
 *
 * 1. The default import marks a DLL for every platform, so a project that
 *    already ships System.Runtime.CompilerServices.Unsafe.dll (or System.Memory)
 *    for players fails with "Multiple precompiled assemblies with the same name".
 *    Roslyn is only ever loaded from editor code, so Editor-only removes that.
 *
 * 2. Unity validates a managed plugin's references against the assemblies in the
 *    project and refuses to load it on a version mismatch:
 *    "Microsoft.CodeAnalysis references strong named System.Runtime.CompilerServices.Unsafe
 *     Assembly references: 4.0.6.0 Found in project: 4.0.4.1."
 *    Mono binds that fine at runtime (verified), and forcing every host project to
 *    disable "Assembly Version Validation" or replace its own Unsafe copy is far
 *    more invasive than skipping the check for these four DLLs.
 * @param {string} name - file name.
 */
function metaFor(name) {
  return `fileFormatVersion: 2
guid: ${guidFor(name)}
PluginImporter:
  externalObjects: {}
  serializedVersion: 2
  iconMap: {}
  executionOrder: {}
  defineConstraints: []
  isPreloaded: 0
  isOverridable: 0
  isExplicitlyReferenced: 1
  validateReferences: 0
  platformData:
  - first:
      Any: 
    second:
      enabled: 0
      settings: {}
  - first:
      Editor: Editor
    second:
      enabled: 1
      settings:
        DefaultValueInitialized: true
  - first:
      Windows Store Apps: WindowsStoreApps
    second:
      enabled: 0
      settings:
        CPU: AnyCPU
  userData: 
  assetBundleName: 
  assetBundleVariant: 
`
}

let metas = 0
for (const name of fs.readdirSync(targetDir)) {
  if (!name.endsWith('.dll')) continue
  fs.writeFileSync(path.join(targetDir, `${name}.meta`), metaFor(name), 'utf8')
  metas += 1
}

// A .meta whose DLL is gone is dead weight and makes Unity warn about a missing
// asset; drop those too.
for (const name of fs.readdirSync(targetDir)) {
  if (!name.endsWith('.dll.meta')) continue
  const dll = name.slice(0, -'.meta'.length)
  if (!staged.has(dll)) fs.rmSync(path.join(targetDir, name), { force: true })
}

console.log(`Copied ${staged.size} assemblies from ${source}`)
console.log(`  -> ${path.relative(repoRoot, targetDir)}`)
console.log(`Wrote ${metas} Editor-only .meta files (player builds never load these).`)
console.log('Open the Unity project and let it import; the package compiles once the DLLs are staged.')
