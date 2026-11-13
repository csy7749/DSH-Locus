#!/usr/bin/env node
/**
 * Copy the Unity package into a project and report assembly conflicts.
 *
 * Unity refuses to import two precompiled assemblies with the same name on the
 * same platform ("Multiple precompiled assemblies with the same name ..."). Real
 * projects routinely ship their own System.Runtime.CompilerServices.Unsafe.dll
 * or System.Memory.dll for players, so shipping the Roslyn support assemblies
 * unconditionally breaks the import.
 *
 * This script therefore copies the package and, for every DLL whose name is
 * already present elsewhere in the project, keeps the project's copy and skips
 * ours. The asmdef references assemblies by name, so it still compiles.
 *
 * Usage:
 *   node scripts/install-unity-package.mjs --project <Unity project>
 *   node scripts/install-unity-package.mjs --project <dir> --check
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const packageDir = path.join(repoRoot, 'unity-package')
const PACKAGE_NAME = 'com.dsh.locus'

const argv = process.argv.slice(2)
const value = (/** @type {string} */ name) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}
const checkOnly = argv.includes('--check')

const project = value('project') ?? process.env.DSH_LOCUS_UNITY_PROJECT
if (!project) {
  console.error('Pass --project <Unity project directory> (the one containing Assets/ and ProjectSettings/).')
  process.exit(1)
}
const projectRoot = path.resolve(project)
const versionFile = path.join(projectRoot, 'ProjectSettings', 'ProjectVersion.txt')
if (!fs.existsSync(versionFile)) {
  console.error(`Not a Unity project (no ProjectSettings/ProjectVersion.txt): ${projectRoot}`)
  process.exit(1)
}

const unityVersion = /m_EditorVersion:\s*(\S+)/.exec(fs.readFileSync(versionFile, 'utf8'))?.[1] ?? 'unknown'
const destination = path.join(projectRoot, 'Packages', PACKAGE_NAME)

/** Every DLL the project already provides, excluding our own package folder. */
function existingAssemblies() {
  /** @type {Map<string, string>} */
  const found = new Map()
  const walk = (/** @type {string} */ dir, /** @type {number} */ depth) => {
    if (depth > 8) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        // Library/Temp/Logs hold imported copies and would match ourselves.
        if (['Library', 'Temp', 'Logs', 'obj', '.git', 'node_modules'].includes(entry.name)) continue
        if (full === destination) continue
        walk(full, depth + 1)
        continue
      }
      if (!entry.name.toLowerCase().endsWith('.dll')) continue
      const name = path.basename(entry.name, path.extname(entry.name))
      if (!found.has(name)) found.set(name, full)
    }
  }
  for (const dir of ['Assets', 'Packages']) {
    const full = path.join(projectRoot, dir)
    if (fs.existsSync(full)) walk(full, 0)
  }
  return found
}

/**
 * Unity only reports a name clash for assemblies it actually imports for the
 * current platform, so a copy that is switched off in the Editor is no clash at
 * all (and we do need to ship ours in that case). The .meta spells that out as
 * `Exclude Editor: 1`; a missing .meta means "let Unity decide", which we treat
 * as a real clash.
 * @param {string} dllPath - path of the existing assembly.
 */
function importedByEditor(dllPath) {
  const meta = `${dllPath}.meta`
  let text
  try {
    text = fs.readFileSync(meta, 'utf8')
  } catch {
    return true
  }
  if (/Exclude Editor:\s*1/.test(text)) return false
  return true
}

const provided = existingAssemblies()

/** @type {{copied: number, skipped: Array<{name: string, existing: string}>}} */
const report = { copied: 0, skipped: [] }

/** @param {string} source @param {string} target */
function copyTree(source, target) {
  fs.mkdirSync(target, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    if (entry.isDirectory()) {
      copyTree(from, to)
      continue
    }
    if (entry.name.toLowerCase().endsWith('.dll') && !entry.name.endsWith('.resources.dll')) {
      const name = path.basename(entry.name, '.dll')
      const existing = provided.get(name)
      if (existing && importedByEditor(existing)) {
        report.skipped.push({ name, existing: path.relative(projectRoot, existing) })
        continue
      }
    }
    fs.copyFileSync(from, to)
    report.copied += 1
  }
}

if (checkOnly) {
  const staged = fs.existsSync(path.join(packageDir, 'Editor', 'Roslyn'))
    && fs.readdirSync(path.join(packageDir, 'Editor', 'Roslyn')).some((name) => name.endsWith('.dll'))
  console.log(staged ? 'The Unity package is ready to install.' : 'Roslyn is not staged yet: run node scripts/sync-roslyn.mjs')
  console.log(`Project: ${projectRoot} (Unity ${unityVersion})`)
  if (report.skipped.length > 0) {
    for (const entry of report.skipped) console.log(`  conflict: ${entry.name} already at ${entry.existing}`)
  }
  process.exit(staged ? 0 : 1)
}

fs.rmSync(destination, { recursive: true, force: true })
copyTree(packageDir, destination)

console.log(`Installed ${PACKAGE_NAME} into ${destination}`)
console.log(`  ${report.copied} files copied (Unity ${unityVersion})`)
for (const entry of report.skipped) {
  console.log(`  kept the project's ${entry.name}.dll (${entry.existing}) instead of shipping ours`)
}
if (report.skipped.length > 0) {
  console.log('  -> those names resolve from the project, which is what Unity expects;')
  console.log('     if the editor then reports a missing type, align the version with the project copy.')
}
console.log('Focus the Unity window so it imports the package; the bridge starts after compilation.')
