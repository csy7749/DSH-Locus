/** Blender tools: drive a running Blender through its bridge add-on. @module */

import { bridgeCall, clip, rethrow, textBlock } from './common.js'

const string = (/** @type {string} */ description) => ({ type: 'string', description })
const instance = { ...string('Blender instance selector: pid, or part of the .blend file name. Omit when only one Blender is running.') }

/**
 * Build the Blender tool definitions.
 * @param {object} options - resolved plugin options (`allowExecute`, `timeoutMs`, `processTimeoutMs`).
 * @returns {any[]} tool definitions.
 */
export function blenderTools(options) {
  return [
    {
      name: 'blender_status',
      description: 'Report the state of a running Blender: version, open .blend file, scene, object count, active object, selection, and mode. Use it to confirm which file a blender_execute will affect.',
      parameters: { type: 'object', properties: { instance }, additionalProperties: false, required: [] },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => {
          const v = /** @type {any} */ (value)
          const lines = [
            `Blender ${v.blenderVersion} — ${v.file || '(unsaved file)'}`,
            `scene: ${v.scene}  |  objects: ${v.objectCount}  |  mode: ${v.mode}`,
            `active: ${v.activeObject || '(none)'}`,
            `selected: ${(v.selected ?? []).join(', ') || '(none)'}`,
          ]
          return textBlock(lines.join('\n'))
        },
      },
      async execute(args, exec) {
        try {
          return await bridgeCall(options, { app: 'blender', project: args?.instance, method: 'status', signal: exec?.signal })
        } catch (error) {
          rethrow('blender_status', error)
        }
      },
    },
    {
      name: 'blender_execute',
      description:
        'Run Python in the running Blender (bpy is pre-imported along with bmesh, mathutils, math and os). The code runs on Blender\'s main thread with the current file open, so it can add objects, change materials, run operators, and export. print() output is captured; a trailing expression is returned.',
      parameters: {
        type: 'object',
        properties: {
          code: { ...string('Python statements. Use `bpy` freely; do not import bpy again.') },
          instance,
        },
        additionalProperties: false,
        required: ['code'],
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => {
          const v = /** @type {any} */ (value)
          const parts = []
          const output = (v.output ?? []).join('\n').trim()
          if (output) parts.push(output)
          if (v.result !== undefined && v.result !== null) parts.push(`=> ${v.result}`)
          if (parts.length === 0) parts.push('Executed with no output.')
          parts.push(`(${Number(v.durationMs ?? 0)} ms)`)
          return textBlock(clip(parts.join('\n'), 12_000))
        },
      },
      async execute(args, exec) {
        if (!options.allowExecute) throw new Error('blender_execute is disabled: set allowExecute: true in the dsh-locus row config and reload DSH.')
        try {
          return await bridgeCall(options, {
            app: 'blender',
            project: args?.instance,
            method: 'execute',
            args: { code: String(args?.code ?? '') },
            timeoutMs: options.processTimeoutMs,
            signal: exec?.signal,
          })
        } catch (error) {
          rethrow('blender_execute', error)
        }
      },
    },
    {
      name: 'blender_screenshot',
      description:
        'Render the current Blender scene to a PNG and return its path. Uses the scene\'s own render settings (engine, resolution, camera), so the result matches a normal F12 render.',
      parameters: {
        type: 'object',
        properties: {
          instance,
          path: { ...string('Destination PNG path. Default: <state dir>/captures/<timestamp>.png.') },
        },
        additionalProperties: false,
        required: [],
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => {
          const v = /** @type {any} */ (value)
          return textBlock(`Rendered ${v.width}x${v.height} to ${v.path}`)
        },
      },
      async execute(args, exec) {
        try {
          return await bridgeCall(options, {
            app: 'blender',
            project: args?.instance,
            method: 'screenshot',
            args: { path: args?.path },
            timeoutMs: options.processTimeoutMs,
            signal: exec?.signal,
          })
        } catch (error) {
          rethrow('blender_screenshot', error)
        }
      },
    },
  ]
}
