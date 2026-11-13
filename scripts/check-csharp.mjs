#!/usr/bin/env node
/**
 * Compile the Unity editor scripts without a Unity install.
 *
 * The scripts only reference a small slice of Unity's API plus Roslyn 3.8, so we
 * compile them against hand-written stubs (test/csharp/UnityStubs.cs) with the
 * C# compiler that ships inside the .NET SDK. This catches syntax errors,
 * typos and internal inconsistencies on a machine that has no Unity editor.
 * It cannot prove the real Unity API signatures match — open the package in a
 * Unity project for that.
 *
 * Usage:
 *   node scripts/check-csharp.mjs [--keep]
 *
 * Requires: dotnet SDK (for csc) and the Roslyn assemblies (scripts/sync-roslyn.mjs).
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const editorDir = path.join(repoRoot, 'unity-package', 'Editor')
const roslynDir = path.join(editorDir, 'Roslyn')
const stubs = path.join(repoRoot, 'test', 'csharp', 'UnityStubs.cs')

/** Locate the C# compiler that ships with the .NET SDK. */
function findCompiler() {
  const roots = []
  if (process.env.DOTNET_ROOT) roots.push(process.env.DOTNET_ROOT)
  if (process.platform === 'win32') {
    if (process.env.ProgramFiles) roots.push(path.join(process.env.ProgramFiles, 'dotnet'))
    roots.push('C:\\Program Files\\dotnet')
  } else {
    roots.push('/usr/share/dotnet', '/usr/local/share/dotnet', path.join(os.homedir(), '.dotnet'))
  }
  for (const root of roots) {
    const sdkDir = path.join(root, 'sdk')
    let versions
    try {
      versions = fs.readdirSync(sdkDir).sort().reverse()
    } catch {
      continue
    }
    for (const version of versions) {
      const candidate = path.join(sdkDir, version, 'Roslyn', 'bincore', 'csc.dll')
      if (fs.existsSync(candidate)) return { dotnet: path.join(root, process.platform === 'win32' ? 'dotnet.exe' : 'dotnet'), compiler: candidate, refRoot: root }
    }
  }
  return undefined
}

/** Reference assemblies the stubs and our code compile against. */
function findReferenceAssemblies(dotnetRoot) {
  const packs = path.join(dotnetRoot, 'packs', 'Microsoft.NETCore.App.Ref')
  let versions
  try {
    versions = fs.readdirSync(packs).sort().reverse()
  } catch {
    return undefined
  }
  for (const version of versions) {
    for (const target of ['net10.0', 'net9.0', 'net8.0', 'net7.0', 'net6.0']) {
      const dir = path.join(packs, version, 'ref', target)
      if (fs.existsSync(path.join(dir, 'System.Runtime.dll'))) return dir
    }
  }
  return undefined
}

const roslynNames = [
  'Microsoft.CodeAnalysis.dll',
  'Microsoft.CodeAnalysis.CSharp.dll',
  'Microsoft.CodeAnalysis.Scripting.dll',
  'Microsoft.CodeAnalysis.CSharp.Scripting.dll',
  'System.Collections.Immutable.dll',
  'System.Reflection.Metadata.dll',
  'System.Runtime.CompilerServices.Unsafe.dll',
]

const toolchain = findCompiler()
if (!toolchain) {
  console.error('Could not find csc.dll inside a .NET SDK. Install the .NET SDK or skip this check.')
  process.exit(1)
}

const referenceDir = findReferenceAssemblies(toolchain.refRoot)
if (!referenceDir) {
  console.error('Could not find the .NET reference assemblies (packs/Microsoft.NETCore.App.Ref).')
  process.exit(1)
}

const missingRoslyn = roslynNames.filter((name) => !fs.existsSync(path.join(roslynDir, name)))
if (missingRoslyn.length > 0) {
  console.error('The Roslyn assemblies are not staged yet. Run first:')
  console.error('  node scripts/sync-roslyn.mjs')
  console.error(`Missing: ${missingRoslyn.join(', ')}`)
  process.exit(1)
}

const sources = [
  ...fs.readdirSync(editorDir).filter((name) => name.endsWith('.cs')).map((name) => path.join(editorDir, name)),
  stubs,
]

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-locus-csharp-'))
const outDll = path.join(outDir, 'DshLocus.Editor.dll')
const logPath = path.join(outDir, 'csc.log')

const args = [
  toolchain.compiler,
  '-nologo',
  '-target:library',
  '-langversion:9',
  '-nullable:disable',
  // CS1701: the .NET SDK reference pack and the shipped Roslyn 3.8 assemblies
  // carry different System.Collections.Immutable versions. Unity loads the
  // DLLs from unity-package/Editor/Roslyn, so the mismatch is an artifact of
  // compiling against the SDK's reference pack.
  '-nowarn:CS0067,CS0649,CS0169,CS1701,CS8632',
  `-out:${outDll}`,
]

for (const name of fs.readdirSync(referenceDir)) {
  if (name.endsWith('.dll')) args.push(`-r:${path.join(referenceDir, name)}`)
}
for (const name of roslynNames) args.push(`-r:${path.join(roslynDir, name)}`)
args.push(...sources)

// Send the compiler output to a file instead of a pipe: the DSH sandbox blocks
// piped child stdio (spawn EPERM), and a plain file descriptor always works.
const logFd = fs.openSync(logPath, 'w')
let status = 0
try {
  status = spawnSync(toolchain.dotnet, args, { stdio: ['ignore', logFd, logFd] }).status ?? 1
} finally {
  fs.closeSync(logFd)
}
const output = fs.readFileSync(logPath, 'utf8').trim()

if (status === 0) {
  if (output) console.log(output)
  console.log(`Compiled ${sources.length - 1} editor scripts against the Unity stubs.`)
  console.log(`  ${path.relative(repoRoot, outDll)}`)
  if (!process.argv.includes('--keep')) fs.rmSync(outDir, { recursive: true, force: true })
} else {
  console.error('C# compilation failed:')
  console.error(output || `csc exited with ${status}`)
  console.error(`  full log: ${logPath}`)
  process.exitCode = 1
}
