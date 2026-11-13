/** LaTeX toolchain discovery and builds; no bridge involved. @module */

import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Engine names in preference order. */
export const ENGINES = ['xelatex', 'lualatex', 'pdflatex']

/** Extra install locations searched on Windows after PATH. */
function extraDirs() {
  if (process.platform !== 'win32') return []
  const dirs = []
  const local = process.env.LOCALAPPDATA
  if (local) dirs.push(path.join(local, 'Programs', 'MiKTeX', 'miktex', 'bin', 'x64'))
  dirs.push('C:\\Program Files\\MiKTeX\\miktex\\bin\\x64')
  for (const root of ['C:\\texlive', 'C:\\Program Files\\texlive']) {
    try {
      for (const year of fs.readdirSync(root)) {
        dirs.push(path.join(root, year, 'bin', 'windows'))
      }
    } catch {}
  }
  return dirs
}

/**
 * Find an executable by name on PATH, then in well-known TeX install dirs.
 * @param {string} name - executable base name.
 * @returns {string | undefined} absolute path.
 */
export function which(name) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  const dirs = [
    ...String(process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':'),
    ...extraDirs(),
  ].filter(Boolean)
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {}
    }
  }
  return undefined
}

/**
 * Run a program without a shell and collect its output.
 * @param {string} file - executable path.
 * @param {string[]} args - argv array.
 * @param {object} [options] - `cwd`, `timeoutMs`.
 * @returns {Promise<{code: number | null, stdout: string, stderr: string, timedOut: boolean}>} outcome.
 */
function run(file, args, options = {}) {
  const { cwd, timeoutMs = 120_000 } = options
  return new Promise((resolve) => {
    execFile(file, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        code: error && typeof /** @type {any} */ (error).code === 'number' ? /** @type {any} */ (error).code : error ? null : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        timedOut: Boolean(error && /** @type {any} */ (error).killed),
      })
    })
  })
}

/**
 * Report which engines and which dvisvgm are usable.
 * @param {object} [options] - `preferred` engine name or "auto".
 * @returns {Promise<{engine?: {name: string, path: string, version?: string}, dvisvgm?: {path: string, version?: string}, all: Array<{name: string, path: string, version?: string}>}>} toolchain.
 */
export async function detectLatexToolchain({ preferred = 'auto' } = {}) {
  const all = []
  for (const name of ENGINES) {
    const found = which(name)
    if (!found) continue
    const version = await run(found, ['--version'], { timeoutMs: 15_000 })
    const match = /(\d+\.\d+(?:\.\d+)?)/.exec(version.stdout || version.stderr)
    all.push({ name, path: found, version: match ? match[1] : undefined })
  }
  const dvisvgmPath = which('dvisvgm')
  let dvisvgm
  if (dvisvgmPath) {
    const version = await run(dvisvgmPath, ['--version'], { timeoutMs: 15_000 })
    const match = /(\d+\.\d+(?:\.\d+)?)/.exec(version.stdout || version.stderr)
    dvisvgm = { path: dvisvgmPath, version: match ? match[1] : undefined }
  }
  const ordered = preferred && preferred !== 'auto' ? [...all].sort((a, b) => (a.name === preferred ? -1 : b.name === preferred ? 1 : 0)) : all
  return { engine: ordered[0], dvisvgm, all }
}

/**
 * A stable per-document output directory so repeated builds can reuse aux files.
 * @param {string} texPath - source path.
 * @returns {string} directory, not created.
 */
function defaultOutDir(texPath) {
  let stamp = ''
  try {
    const stat = fs.statSync(texPath)
    stamp = `${stat.size}-${Math.round(stat.mtimeMs)}`
  } catch {}
  const digest = crypto.createHash('sha1').update(`${path.resolve(texPath)}|${stamp}`).digest('hex').slice(0, 12)
  return path.join(os.tmpdir(), 'dsh-locus-latex', `${path.basename(texPath, '.tex') || 'document'}-${digest}`)
}

/**
 * Extract compiler diagnostics from a LaTeX log.
 * @param {string} log - log text.
 * @returns {{errors: Array<{file?: string, line?: number, message: string}>, warnings: string[], rerun: boolean}} diagnostics.
 */
export function parseLatexLog(log) {
  const errors = []
  const warnings = []
  const lines = log.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const located = /^(?:\.\/)?([^:]+\.(?:tex|sty|cls)):(\d+):\s*(.+)$/.exec(line.trim())
    if (located) {
      errors.push({ file: located[1], line: Number(located[2]), message: located[3].trim() })
      continue
    }
    const bang = /^!\s*(.+)$/.exec(line.trim())
    if (bang) {
      // The following `l.NNN` line names the source line when the log has no file-line form.
      let sourceLine
      for (let ahead = index + 1; ahead < Math.min(index + 8, lines.length); ahead += 1) {
        const at = /^l\.(\d+)\s/.exec(lines[ahead].trim())
        if (at) {
          sourceLine = Number(at[1])
          break
        }
      }
      errors.push({ line: sourceLine, message: bang[1].trim() })
      continue
    }
    if (/^(?:LaTeX|Package .*|Class .*) Warning:/.test(line.trim())) warnings.push(line.trim())
  }
  const rerun = /Rerun to get|Please rerun|Label\(s\) may have changed|There were undefined references/.test(log)
  return { errors: errors.slice(0, 40), warnings: [...new Set(warnings)].slice(0, 20), rerun }
}

/**
 * Compile a .tex document to PDF and optionally SVG.
 * @param {object} request - `texPath`, `engine`, `svg`, `outDir`, `timeoutMs`, `saveLog`.
 * @returns {Promise<object>} build report.
 */
export async function buildLatex({ texPath, engine = 'auto', svg = false, outDir, timeoutMs = 120_000, progress }) {
  const started = Date.now()
  const source = path.resolve(String(texPath ?? ''))
  if (!fs.existsSync(source)) throw new Error(`LaTeX source not found: ${source}`)
  const toolchain = await detectLatexToolchain({ preferred: engine })
  if (!toolchain.engine) {
    throw new Error('No LaTeX engine found (looked for xelatex, lualatex, pdflatex on PATH). Install MiKTeX or TeX Live, or put the engine on PATH.')
  }
  const chosen = toolchain.engine
  const target = outDir ? path.resolve(outDir) : defaultOutDir(source)
  fs.mkdirSync(target, { recursive: true })
  const base = path.basename(source, path.extname(source))
  const pdfPath = path.join(target, `${base}.pdf`)
  const logPath = path.join(target, `${base}.log`)

  const args = ['-interaction=nonstopmode', '-halt-on-error', '-file-line-error', `-output-directory=${target}`, path.basename(source)]
  const cwd = path.dirname(source)
  const passes = []
  let logText = ''
  let rerun = false
  for (let pass = 1; pass <= 2; pass += 1) {
    progress?.(`LaTeX pass ${pass}/${2} with ${chosen.name}`)
    const outcome = await run(chosen.path, args, { cwd, timeoutMs })
    passes.push({ pass, code: outcome.code, timedOut: outcome.timedOut })
    try {
      logText = fs.readFileSync(logPath, 'utf8')
    } catch {
      logText = `${outcome.stdout}\n${outcome.stderr}`
    }
    const parsed = parseLatexLog(logText)
    rerun = parsed.rerun
    if (outcome.timedOut || outcome.code !== 0 || !parsed.rerun) break
  }

  const diagnostics = parseLatexLog(logText)
  const built = fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 0
  let svgPath
  let svgError
  if (svg && toolchain.dvisvgm && built) {
    progress?.('Converting PDF to SVG with dvisvgm')
    svgPath = path.join(target, `${base}.svg`)
    const outcome = await run(toolchain.dvisvgm.path, ['--pdf', '--optimize', '--page=1', '-o', svgPath, pdfPath], { cwd, timeoutMs })
    if (outcome.code !== 0 || !fs.existsSync(svgPath)) {
      svgError = (outcome.stderr || outcome.stdout || 'dvisvgm failed').trim().slice(-800)
      svgPath = undefined
    }
  }

  return {
    ok: built && diagnostics.errors.length === 0,
    engine: chosen.name,
    engineVersion: chosen.version,
    pdfPath: built ? pdfPath : undefined,
    svgPath,
    outDir: target,
    logPath: fs.existsSync(logPath) ? logPath : undefined,
    errors: diagnostics.errors,
    warnings: diagnostics.warnings,
    passes,
    rerunNeeded: rerun,
    svgError,
    durationMs: Date.now() - started,
    logTail: built ? undefined : logText.split(/\r?\n/).slice(-40).join('\n').slice(-4000),
  }
}
