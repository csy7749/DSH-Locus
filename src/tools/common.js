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
 * Best-effort session working directory, used to pick the matching Unity
 * project when several editors are open. Falls back to the host process cwd.
 * @param {any} exec - tool execution context.
 * @returns {string} directory.
 */
export function sessionCwd(exec) {
  const candidate = exec?.agent?.session?.cwd ?? exec?.agent?.cwd
  return typeof candidate === 'string' && candidate.trim() !== '' ? candidate : process.cwd()
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
