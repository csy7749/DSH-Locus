#!/usr/bin/env node
/**
 * Compile the Unity editor scripts.
 *
 * Two modes:
 *   (default) against hand-written stubs + the .NET SDK reference pack, which
 *             works on a machine with no Unity install but cannot prove the real
 *             Unity API signatures match.
 *   --unity   against a real Unity editor installation (its Mono 4.8 BCL plus
 *             UnityEngine/UnityEditor assemblies), which is the check that
 *             matters before the package is dropped into a project.
 *
 * Usage:
 *   node scripts/check-csharp.mjs [--unity [<Editor/Data dir>]] [--keep]
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

/**
 * Locate a Unity editor's `Editor/Data` directory: an explicit `--unity` path,
 * else whatever Unity Hub has installed.
 * @param {string|undefined} explicitPath
 */
function findUnityData(explicitPath) {
  /** @param {string} candidate */
  const asData = (candidate) => {
    const data = path.join(candidate, 'Data')
    return fs.existsSync(path.join(data, 'Managed', 'UnityEngine')) ? data : undefined
  }
  if (explicitPath) {
    for (const candidate of [explicitPath, path.dirname(explicitPath)]) {
      const data = asData(candidate)
      if (data) return data
    }
    return undefined
  }
  const hubFiles = []
  if (process.env.APPDATA) hubFiles.push(path.join(process.env.APPDATA, 'UnityHub', 'editors-v2.json'))
  for (const file of hubFiles) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      for (const entry of parsed?.data ?? []) {
        for (const location of entry?.location ?? []) {
          const data = asData(path.dirname(location))
          if (data) return data
        }
      }
    } catch {}
  }
  for (const root of ['C:\\Program Files\\Unity\\Hub\\Editor', 'D:\\Program Files\\Unity\\Hub\\Editor', '/Applications/Unity/Hub/Editor']) {
    let versions
    try {
      versions = fs.readdirSync(root).sort().reverse()
    } catch {
      continue
    }
    for (const version of versions) {
      const data = asData(path.join(root, version, 'Editor'))
      if (data) return data
    }
  }
  return undefined
}

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
  'System.Memory.dll',
  'System.Runtime.CompilerServices.Unsafe.dll',
]

const toolchain = findCompiler()
if (!toolchain) {
  console.error('Could not find csc.dll inside a .NET SDK. Install the .NET SDK or skip this check.')
  process.exit(1)
}

const missingRoslyn = roslynNames.filter((name) => !fs.existsSync(path.join(roslynDir, name)))
if (missingRoslyn.length > 0) {
  console.error('The Roslyn assemblies are not staged yet. Run first:')
  console.error('  node scripts/sync-roslyn.mjs')
  console.error(`Missing: ${missingRoslyn.join(', ')}`)
  process.exit(1)
}

const sources = fs.readdirSync(editorDir).filter((name) => name.endsWith('.cs')).map((name) => path.join(editorDir, name))

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-locus-csharp-'))
const outDll = path.join(outDir, 'DshLocus.Editor.dll')
const logPath = path.join(outDir, 'csc.log')

const unityIndex = process.argv.indexOf('--unity')
const unityData = unityIndex === -1 ? undefined : findUnityData(process.argv[unityIndex + 1]?.startsWith('--') ? undefined : process.argv[unityIndex + 1])

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

if (unityData) {
  // Compile against the editor's own Mono 4.8 profile and its Unity assemblies.
  // This is what Unity itself does, so a passing build here means the package
  // will import cleanly instead of showing "'X' does not contain a definition".
  const monoApi = ['4.8-api', 'unityjit-win32', 'unity']
    .map((name) => path.join(unityData, 'MonoBleedingEdge', 'lib', 'mono', name))
    .find((dir) => fs.existsSync(path.join(dir, 'mscorlib.dll')))
  if (!monoApi) {
    console.error(`Could not find a Mono API profile under ${unityData}\\MonoBleedingEdge\\lib\\mono.`)
    process.exit(1)
  }
  args.push('-nostdlib+')
  for (const name of fs.readdirSync(monoApi)) {
    if (name.endsWith('.dll')) args.push(`-r:${path.join(monoApi, name)}`)
  }
  // Facades carry netstandard/System.Runtime facades that netstandard2.0
  // assemblies (our shipped Roslyn 3.8) are compiled against.
  const facades = path.join(monoApi, 'Facades')
  if (fs.existsSync(facades)) {
    for (const name of fs.readdirSync(facades)) {
      if (name.endsWith('.dll')) args.push(`-r:${path.join(facades, name)}`)
    }
  }
  const engineDir = path.join(unityData, 'Managed', 'UnityEngine')
  const engineDlls = fs.readdirSync(engineDir).filter((name) => name.endsWith('.dll'))
  for (const name of engineDlls) args.push(`-r:${path.join(engineDir, name)}`)
  // UnityEditor.dll is a facade over the UnityEditor.*Module assemblies that
  // already live in Managed/UnityEngine; referencing both makes every editor
  // attribute ambiguous (CS0433). Only fall back to the facade on old layouts.
  const editorAssembly = path.join(unityData, 'Managed', 'UnityEditor.dll')
  if (!engineDlls.some((name) => name.startsWith('UnityEditor.')) && fs.existsSync(editorAssembly)) {
    args.push(`-r:${editorAssembly}`)
  }
  args.push('-define:UNITY_EDITOR;UNITY_2021_3_OR_NEWER;UNITY_STANDALONE_WIN')
} else {
  if (unityIndex !== -1) {
    console.error('Could not find a Unity editor installation. Pass --unity <Editor/Data dir> or omit --unity to use the stubs.')
    process.exit(1)
  }
  const referenceDir = findReferenceAssemblies(toolchain.refRoot)
  if (!referenceDir) {
    console.error('Could not find the .NET reference assemblies (packs/Microsoft.NETCore.App.Ref).')
    process.exit(1)
  }
  for (const name of fs.readdirSync(referenceDir)) {
    if (name.endsWith('.dll')) args.push(`-r:${path.join(referenceDir, name)}`)
  }
  sources.push(stubs)
}

for (const name of roslynNames) args.push(`-r:${path.join(roslynDir, name)}`)
args.push(...sources)

// A real Unity install contributes roughly 300 reference assemblies, which
// overruns the Windows command-line limit, so the arguments go through a
// response file instead.
const responseFile = path.join(outDir, 'csc.rsp')
fs.writeFileSync(responseFile, args.slice(1).map((arg) => `"${arg}"`).join('\n'), 'utf8')

// Send the compiler output to a file instead of a pipe: the DSH sandbox blocks
// piped child stdio (spawn EPERM), and a plain file descriptor always works.
const logFd = fs.openSync(logPath, 'w')
let status = 0
try {
  status = spawnSync(toolchain.dotnet, [args[0], `@${responseFile}`], { stdio: ['ignore', logFd, logFd] }).status ?? 1
} finally {
  fs.closeSync(logFd)
}
const output = fs.readFileSync(logPath, 'utf8').trim()

if (status === 0) {
  if (output) console.log(output)
  console.log(`Compiled ${sources.length - (unityData ? 0 : 1)} editor scripts against ${unityData ? `Unity at ${unityData}` : 'the Unity stubs'}.`)
  console.log(`  ${path.relative(repoRoot, outDll)}`)
  if (!process.argv.includes('--keep')) fs.rmSync(outDir, { recursive: true, force: true })
} else {
  console.error('C# compilation failed:')
  console.error(output || `csc exited with ${status}`)
  console.error(`  full log: ${logPath}`)
  process.exitCode = 1
}
