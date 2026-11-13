#!/usr/bin/env node
/**
 * Copy the Roslyn script assemblies into unity-package/Editor/Roslyn.
 *
 * The DLLs are Microsoft's MIT-licensed Roslyn 3.8 build (the versions that
 * Unity 2021/2022 can load). They are not committed to this repository, so a
 * clean checkout has to stage them once before the Unity package compiles.
 *
 * Usage:
 *   node scripts/sync-roslyn.mjs [--from <dir>] [--check] [--clean]
 *
 * Sources, in order:
 *   1. --from <dir>
 *   2. $DSH_LOCUS_ROSLYN
 *   3. D:\AI\Locus\third_party\roslyn-3.8.0\assemblies (a Locus checkout)
 *   4. ../Locus/third_party/roslyn-3.8.0/assemblies next to this repository
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const targetDir = path.join(repoRoot, 'unity-package', 'Editor', 'Roslyn')

/** Assemblies the editor assembly references; order matters only for logging. */
const REQUIRED = [
  'Microsoft.CodeAnalysis.dll',
  'Microsoft.CodeAnalysis.CSharp.dll',
  'Microsoft.CodeAnalysis.Scripting.dll',
  'Microsoft.CodeAnalysis.CSharp.Scripting.dll',
  'System.Collections.Immutable.dll',
  'System.Reflection.Metadata.dll',
  'System.Runtime.CompilerServices.Unsafe.dll',
]

/** Localized satellite assemblies; optional, copied when present. */
const OPTIONAL_PATTERN = /\.resources\.dll$/i

const argv = process.argv.slice(2)
const flag = (/** @type {string} */ name) => argv.includes(`--${name}`)
const value = (/** @type {string} */ name) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}

const explicit = value('from') ?? process.env.DSH_LOCUS_ROSLYN

const candidates = [
  explicit,
  'D:\\AI\\Locus\\third_party\\roslyn-3.8.0\\assemblies',
  path.resolve(repoRoot, '..', 'Locus', 'third_party', 'roslyn-3.8.0', 'assemblies'),
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
  console.error('Could not find the Roslyn 3.8 assemblies. Tried:')
  for (const candidate of candidates) console.error(`  ${candidate}`)
  console.error('')
  console.error('Download Microsoft.CodeAnalysis.CSharp.Scripting 3.8.0 from nuget.org and extract')
  console.error('lib/netstandard2.0/*.dll from each of these packages into one folder:')
  console.error('  Microsoft.CodeAnalysis.Common, Microsoft.CodeAnalysis.CSharp,')
  console.error('  Microsoft.CodeAnalysis.Scripting, Microsoft.CodeAnalysis.CSharp.Scripting,')
  console.error('  System.Collections.Immutable, System.Reflection.Metadata,')
  console.error('  System.Runtime.CompilerServices.Unsafe')
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
let copied = 0
for (const name of fs.readdirSync(source)) {
  const isNeeded = REQUIRED.includes(name) || OPTIONAL_PATTERN.test(name)
  if (!isNeeded) continue
  fs.copyFileSync(path.join(source, name), path.join(targetDir, name))
  copied += 1
}

// The .meta files from the source checkout carry GUIDs that point at another
// project; Unity should mint fresh ones for this package.
for (const name of fs.readdirSync(targetDir)) {
  if (name.endsWith('.meta')) fs.rmSync(path.join(targetDir, name), { force: true })
}

console.log(`Copied ${copied} assemblies from ${source}`)
console.log(`  -> ${path.relative(repoRoot, targetDir)}`)
console.log('Open the Unity project and let it import; the package compiles once the DLLs are staged.')
