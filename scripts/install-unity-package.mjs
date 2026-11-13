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
      // Prefer an Editor-enabled copy: that is the one Unity will clash with.
      const previous = found.get(name)
      if (!previous || (!importedByEditor(previous) && importedByEditor(full))) found.set(name, full)
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
 * platform in use, so a copy that is switched off in the Editor is no clash at
 * all (and we do need to ship ours in that case). The .meta carries that as a
 * platformData entry for Editor; older/other exporters also write an
 * `Exclude Editor: 1` setting. A missing .meta means "let Unity decide", which
 * we treat as a real clash.
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
  const blocks = text.split(/^\s*-\s+first:/m)
  // When Any Platform is enabled, Editor.enabled can be zero while the DLL
  // still applies to the Editor. Exclude Editor above is the explicit opt-out.
  const any = blocks.find((block) => /(?:Any:\s*\r?\n|['"]{2}:\s*Any)/.test(block))
  if (any && /enabled:\s*1/.test(any)) return true
  const entry = blocks.find((block) => /Editor:\s*Editor/.test(block))
  if (!entry) return true
  const enabled = /enabled:\s*(\d)/.exec(entry)
  return enabled ? enabled[1] !== '0' : true
}

const provided = existingAssemblies()

/** @type {{copied: number, skipped: Array<{name: string, existing: string}>, planned: string[]}} */
const report = { copied: 0, skipped: [], planned: [] }
/** @type {Set<string>} */
const skippedNames = new Set()
let dryRun = false

/** @param {string} source @param {string} target */
function copyTree(source, target) {
  if (!dryRun) fs.mkdirSync(target, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    if (entry.isDirectory()) {
      copyTree(from, to)
      continue
    }
    const isDll = entry.name.toLowerCase().endsWith('.dll') && !entry.name.endsWith('.resources.dll')
    if (isDll) {
      const name = path.basename(entry.name, '.dll')
      const existing = provided.get(name)
      if (existing && importedByEditor(existing)) {
        report.skipped.push({ name, existing: path.relative(projectRoot, existing) })
        skippedNames.add(name)
        continue
      }
    }
    // Do not leave a .meta behind for an assembly we decided not to ship.
    if (entry.name.endsWith('.dll.meta')) {
      const name = path.basename(entry.name, '.dll.meta')
      if (skippedNames.has(name)) continue
    }
    if (dryRun) {
      report.planned.push(path.relative(projectRoot, to))
      continue
    }
    fs.copyFileSync(from, to)
    report.copied += 1
  }
}

if (checkOnly) {
  const staged = fs.existsSync(path.join(packageDir, 'Editor', 'Roslyn'))
    && fs.readdirSync(path.join(packageDir, 'Editor', 'Roslyn')).some((name) => name.endsWith('.dll'))
  if (!staged) {
    console.error('Roslyn is not staged yet: run node scripts/sync-roslyn.mjs')
    process.exit(1)
  }
  dryRun = true
  copyTree(packageDir, destination)
  console.log(`Project: ${projectRoot} (Unity ${unityVersion})`)
  console.log(`Would install ${report.planned.length} files into Packages/${PACKAGE_NAME}.`)
  for (const entry of report.skipped) {
    console.log(`  keeps the project's ${entry.name}.dll (${entry.existing}) instead of shipping ours`)
  }
  process.exit(0)
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
