/** Helpers shared by the dsh-locus tool definitions. @module */

import { LocusError, callBridge } from '../protocol.js'
import { resolveInstance } from '../instances.js'

/** A single text content block. @param {string} text - model-facing text. @returns {any[]} blocks. */
export function textBlock(text) {
  return [{ type: 'text', text }]
}

/**
 * Clip a long string for the model-facing rendering.
 * @param {string} text - source text.
 * @param {number} [max] - maximum characters.
 * @returns {string} text with an explicit omission marker.
 */
export function clip(text, max = 4000) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n… [${value.length - max} more characters omitted]`
}

/**
 * Best-effort session working directory, used to resolve relative paths and to
 * pick the matching Unity project when several editors are open.
 *
 * The session's directory lives on its durable header (`exec.agent.session.header.cwd`),
 * not on the session object itself; reading the wrong field silently resolved
 * every relative path against the host process directory instead of the workspace.
 * The extra candidates keep this working if the host shape shifts.
 *
 * @param {any} exec - tool execution context.
 * @returns {string} directory.
 */
export function sessionCwd(exec) {
  const session = exec?.agent?.session
  const candidates = [session?.header?.cwd, session?.cwd, exec?.agent?.cwd, exec?.cwd]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
  }
  return process.cwd()
}

/**
 * Resolve the target instance and run one bridge method.
 * @param {object} options - plugin options.
 * @param {object} request - `app`, `project`, `method`, `args`, `timeoutMs`, `signal`.
 * @returns {Promise<any>} the bridge result.
 */
export async function bridgeCall(options, request) {
  const instance = resolveInstance({ app: request.app, project: request.project, cwd: request.cwd })
  return callBridge(instance, request.method, request.args ?? {}, {
    timeoutMs: request.timeoutMs ?? options.timeoutMs,
    signal: request.signal,
  })
}

/**
 * Re-throw an unexpected error with a stable, readable prefix so the model can
 * tell plugin failures apart from its own mistakes.
 * @param {string} what - short action name.
 * @param {unknown} error - thrown value.
 * @returns {never} always throws.
 */
export function rethrow(what, error) {
  if (error instanceof LocusError) throw error
  if (error instanceof Error) throw new Error(`${what} failed: ${error.message}`)
  throw new Error(`${what} failed: ${String(error)}`)
}

/**
 * Render a bridge result as compact two-space-indented JSON when it has no
 * dedicated renderer.
 * @param {unknown} value - canonical result.
 * @returns {any[]} content blocks.
 */
export function renderJson(value) {
  return textBlock(clip(JSON.stringify(value, null, 2)))
}

/**
 * Strip everything JSON cannot carry.
 *
 * The host refuses a tool result unless it survives a JSON round trip, and
 * `undefined` is the usual culprit: bridge payloads and build reports legitimately
 * omit fields, and `{ version: undefined }` silently becomes `{}` once serialised.
 * Object keys whose value is undefined are dropped; undefined array slots become
 * null so positions stay stable.
 *
 * @param {unknown} value - any tool result.
 * @param {WeakSet<object>} [seen] - cycle guard.
 * @returns {any} a value that round-trips through JSON unchanged.
 */
export function toLosslessJson(value, seen = new WeakSet()) {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') return Number.isFinite(value) ? value : null
  if (type === 'bigint') return value.toString()
  if (type !== 'object') return undefined // undefined, function, symbol
  if (value instanceof Date) return value.toISOString()
  if (ArrayBuffer.isView(value)) return Array.from(/** @type {any} */ (value))
  if (seen.has(value)) return null
  seen.add(value)

  if (Array.isArray(value)) {
    return value.map((entry) => {
      const cleaned = toLosslessJson(entry, seen)
      return cleaned === undefined ? null : cleaned
    })
  }

  const result = {}
  for (const [key, entry] of Object.entries(value)) {
    const cleaned = toLosslessJson(entry, seen)
    if (cleaned !== undefined) result[key] = cleaned
  }
  return result
}
