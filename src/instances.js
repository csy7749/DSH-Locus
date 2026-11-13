/** Discovery of running Unity editors and Blender instances. @module */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { instancesDir } from './paths.js'
import { LocusError } from './protocol.js'

/**
 * Canonical form used on both sides to derive an instance key.
 * @param {string} value - a project path.
 * @returns {string} normalized path.
 */
export function normalizeProjectPath(value) {
  let text = String(value ?? '').trim()
  if (text.startsWith('\\\\?\\')) text = text.slice(4)
  text = text.replace(/\//g, '\\')
  text = text.replace(/[\\]+$/, '')
  return text.toLowerCase()
}

/**
 * First 16 hex characters of the SHA-256 of the normalized path.
 * @param {string} projectPath - absolute Unity project directory.
 * @returns {string} instance key.
 */
export function instanceKey(projectPath) {
  return crypto.createHash('sha256').update(normalizeProjectPath(projectPath)).digest('hex').slice(0, 16)
}

/**
 * Whether a process id is still running. Signal 0 only probes.
 * @param {number} pid - candidate process id.
 * @returns {boolean} true when the process exists.
 */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return /** @type {any} */ (error)?.code === 'EPERM'
  }
}

/**
 * Read every advertised instance, dropping files whose process is gone.
 * @param {object} [options] - `app` filter.
 * @returns {Array<Record<string, any>>} live instances, newest first.
 */
export function listInstances({ app } = {}) {
  const dir = instancesDir()
  let names
  try {
    names = fs.readdirSync(dir)
  } catch (error) {
    if (/** @type {any} */ (error)?.code === 'ENOENT') return []
    throw error
  }
  const found = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = path.join(dir, name)
    let record
    try {
      record = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    if (!record || typeof record.port !== 'number' || typeof record.token !== 'string') continue
    if (!isAlive(record.pid)) {
      try {
        fs.rmSync(file, { force: true })
      } catch {}
      continue
    }
    if (app && record.app !== app) continue
    found.push({ ...record, file })
  }
  return found.sort((a, b) => Number(b.startedAt ?? 0) - Number(a.startedAt ?? 0))
}

/**
 * Walk up from a directory looking for a Unity project root.
 * @param {string} [start] - starting directory, usually the session workspace.
 * @returns {string | undefined} absolute project root.
 */
export function findUnityProjectRoot(start = process.cwd()) {
  let current = path.resolve(start)
  for (let depth = 0; depth < 16; depth += 1) {
    if (fs.existsSync(path.join(current, 'ProjectSettings', 'ProjectVersion.txt'))) return current
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

/**
 * @param {Record<string, any>} instance - candidate instance.
 * @returns {string} one-line human description.
 */
function describe(instance) {
  const name = instance.projectName || instance.projectPath || instance.key
  return `${name}${instance.version ? ` (${instance.app} ${instance.version})` : ''}`
}

/**
 * Resolve the instance a tool call should use.
 *
 * Selection order: an explicit `project`/`instance` argument, then a Unity
 * project containing the session workspace, then the only live instance.
 * @param {object} options - `app`, `project` (path, name, key, or pid), `cwd`.
 * @returns {Record<string, any>} the chosen instance.
 */
export function resolveInstance({ app, project, cwd } = {}) {
  const live = listInstances({ app })
  const appName = app === 'blender' ? 'Blender' : 'Unity editor'

  if (live.length === 0) {
    throw new LocusError(
      'NOT_READY',
      app === 'blender'
        ? 'No Blender instance is running with the dsh-locus add-on enabled. Install blender-addon/dsh_locus_bridge.py as a Blender add-on and enable "dsh-locus bridge" in Preferences > Add-ons.'
        : 'No Unity editor is running the dsh-locus bridge. Install unity-package/ as a local package in the project (Window > Package Manager > Add package from disk) and keep the editor open.',
    )
  }

  if (project) {
    const needle = String(project).trim()
    const normalized = normalizeProjectPath(needle)
    const matches = live.filter((instance) => {
      if (String(instance.pid) === needle) return true
      if (instance.key === needle) return true
      if (instance.projectPath && normalizeProjectPath(instance.projectPath) === normalized) return true
      if (instance.projectName && String(instance.projectName).toLowerCase() === needle.toLowerCase()) return true
      return instance.projectPath ? normalizeProjectPath(instance.projectPath).includes(normalized) : false
    })
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) {
      throw new LocusError('BAD_REQUEST', `The project selector "${needle}" matches several ${appName} instances: ${matches.map(describe).join(', ')}. Pass a full project path.`)
    }
    throw new LocusError('NOT_READY', `No running ${appName} matches "${needle}". Live instances: ${live.map(describe).join(', ')}.`)
  }

  if (app !== 'blender') {
    const root = cwd ? findUnityProjectRoot(cwd) : undefined
    if (root) {
      const normalized = normalizeProjectPath(root)
      const matching = live.find((instance) => instance.projectPath && normalizeProjectPath(instance.projectPath) === normalized)
      if (matching) return matching
    }
  }

  if (live.length === 1) return live[0]
  throw new LocusError(
    'BAD_REQUEST',
    `Several ${appName} instances are running: ${live.map(describe).join(', ')}. Pass the \`project\` argument (full path or project name) to choose one.`,
  )
}
