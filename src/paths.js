/** Filesystem locations shared by every dsh-locus bridge. @module */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Per-user state directory. App bridges (Unity, Blender) compute this path
 * themselves in their own language, so the rules must stay identical to
 * docs/PROTOCOL.md — do not "improve" one side alone.
 * @returns {string} absolute directory, not created.
 */
export function stateDir() {
  if (process.env.DSH_LOCUS_STATE) return path.resolve(process.env.DSH_LOCUS_STATE)
  const home = os.homedir()
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'dsh-locus')
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'dsh-locus')
  }
  return path.join(process.env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'dsh-locus')
}

/** @returns {string} directory holding one JSON file per running app instance. */
export function instancesDir() {
  return path.join(stateDir(), 'instances')
}

/** @returns {string} default directory for Blender screenshots and LaTeX output. */
export function capturesDir() {
  return path.join(stateDir(), 'captures')
}

/**
 * Create a directory when missing.
 * @param {string} dir - absolute path.
 * @returns {string} the same path.
 */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Write a file through a temporary sibling and a rename, so a reader never
 * sees a half-written JSON document.
 * @param {string} file - destination path.
 * @param {string} body - complete contents.
 */
export function writeAtomic(file, body) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, body)
  fs.renameSync(tmp, file)
}
