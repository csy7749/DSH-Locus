/** Unity editor tools: drive the open project over the bridge. @module */

import { bridgeCall, clip, rethrow, sessionCwd, textBlock } from './common.js'

const string = (/** @type {string} */ description) => ({ type: 'string', description })
const project = { ...string('Unity project selector: full path, project name, or instance key. Omit when only one editor is open.'), title: 'Project' }

/** The empty object schema reused by tools without parameters. */
const noArgs = { type: 'object', properties: {}, additionalProperties: false, required: [] }

/**
 * @typedef {object} UnityToolOptions - plugin options.
 * @property {boolean} allowExecute - whether arbitrary C# may run.
 * @property {number} timeoutMs - default bridge deadline.
 * @property {number} processTimeoutMs - deadline for long editor operations.
 */

/**
 * Build every Unity tool definition.
 * @param {UnityToolOptions} options - resolved plugin options.
 * @returns {any[]} tool definitions for `ctx.tools.register`.
 */
export function unityTools(options) {
  /** @param {any} exec - execution context. */
  const cwdOf = (exec) => sessionCwd(exec)

  return [
    {
      name: 'unity_status',
      description:
        'Report the state of a running Unity editor: version, project, active scene, play mode, whether scripts are compiling, and which dsh-locus capabilities are available. Start here when a Unity step looks stuck.',
      parameters: { type: 'object', properties: { project }, additionalProperties: false, required: [] },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => {
          const v = /** @type {any} */ (value)
          const lines = [
            `${v.projectName || v.projectPath} — Unity ${v.unityVersion}`,
            `scene: ${v.activeScenePath || '(unsaved)'}`,
            `play mode: ${v.isPlaying ? (v.isPaused ? 'paused' : 'playing') : 'edit mode'}${v.isCompiling ? ', compiling' : ''}`,
            `build target: ${v.buildTarget}  |  pid: ${v.editorPid}  |  up ${Number(v.timeSinceStartup ?? 0).toFixed(1)}s`,
            `capabilities: ${(v.capabilities ?? []).join(', ')}`,
          ]
          return textBlock(lines.join('\n'))
        },
      },
      async execute(args, exec) {
        try {
          return await bridgeCall(options, { app: 'unity', project: args?.project, method: 'status', cwd: cwdOf(exec), signal: exec?.signal })
        } catch (error) {
          rethrow('unity_status', error)
        }
      },
    },
    {
      name: 'unity_execute',
      description:
        'Run C# code inside the open Unity editor with Roslyn script semantics (no class wrapper; a trailing expression becomes the result). Use it to inspect or modify the active scene, instantiate prefabs, edit assets, or call Editor APIs. Console output is captured; compile errors come back without throwing. Requires Unity to be idle, not compiling.',
      parameters: {
        type: 'object',
        properties: {
          code: { ...string('C# statements or a single expression. Imports already include System, System.Linq, System.IO, UnityEngine and UnityEditor.'), title: 'Code' },
          project,
          mode: { type: 'string', enum: ['editor', 'play'], description: 'Reject the call unless the editor is in play mode ("play"). Default "editor".' },
        },
        additionalProperties: false,
        required: ['code'],
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => {
          const v = /** @type {any} */ (value)
          const parts = []
          if (v.compiled === false) {
            parts.push('Compilation failed:')
            for (const e of v.errors ?? []) parts.push(`  ${e.file ?? 'script'}(${e.line ?? 0},${e.column ?? 0}): ${e.message}`)
            return textBlock(parts.join('\n'))
          }
          const output = (v.output ?? []).join('\n').trim()
          if (output) parts.push(output)
          if (v.result !== undefined && v.result !== null) parts.push(`=> ${typeof v.result === 'string' ? v.result : JSON.stringify(v.result)}`)
          if (parts.length === 0) parts.push('Executed with no output.')
          parts.push(`(${Number(v.durationMs ?? 0)} ms)`)
          return textBlock(clip(parts.join('\n'), 12_000))
        },
      },
      async execute(args, exec) {
        if (!options.allowExecute) throw new Error('unity_execute is disabled: set allowExecute: true in the dsh-locus row config and reload DSH.')
        try {
          return await bridgeCall(options, {
            app: 'unity',
            project: args?.project,
            method: 'execute',
            args: { code: String(args?.code ?? ''), mode: args?.mode === 'play' ? 'play' : 'editor' },
            cwd: cwdOf(exec),
            timeoutMs: options.processTimeoutMs,
            signal: exec?.signal,
          })
        } catch (error) {
          rethrow('unity_execute', error)
        }
      },
    },
    {
      name: 'unity_console',
      description:
        'Read the most recent Unity console entries (Debug.Log, warnings, errors, and compilation messages). Newest entries are last. Use it after unity_execute or a recompile to see what the editor reported.',
      parameters: {
        type: 'object',
        properties: {
          project,
          limit: { type: 'integer', description: 'How many entries to return, 1-200. Default 50.' },
          level: { type: 'string', enum: ['all', 'log', 'warning', 'error'], description: 'Minimum severity. Default all.' },
        },
        additionalProperties: false,
        required: [],
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => {
          const v = /** @type {any} */ (value)
          const entries = v.entries ?? []
          if (entries.length === 0) return textBlock('The Unity console is empty for this filter.')
          const lines = entries.map((e) => `[${e.level}] ${e.message}${e.stack ? `\n${clip(e.stack, 600)}` : ''}`)
          const header = `${entries.length} of ${v.total ?? entries.length} entries${v.dropped ? ` (${v.dropped} older dropped)` : ''}:`
          return textBlock(clip(`${header}\n${lines.join('\n---\n')}`, 12_000))
        },
      },
      async execute(args, exec) {
        try {
          return await bridgeCall(options, {
            app: 'unity',
            project: args?.project,
            method: 'console',
            args: { limit: Number(args?.limit ?? 50), level: args?.level ?? 'all' },
            cwd: cwdOf(exec),
            signal: exec?.signal,
          })
        } catch (error) {
          rethrow('unity_console', error)
        }
      },
    },
    {
      name: 'unity_playmode',
      description:
        'Enter, pause, or stop Unity play mode. Use "play" to test gameplay and "stop" to return to edit mode; a stop discards play-mode changes to the scene.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['play', 'pause', 'stop'], description: 'Play-mode transition.' },
          project,
        },
        additionalProperties: false,
        required: ['action'],
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => {
          const v = /** @type {any} */ (value)
          return textBlock(`play mode: ${v.isPlaying ? (v.isPaused ? 'paused' : 'playing') : 'edit mode'}`)
        },
      },
      async execute(args, exec) {
        try {
          return await bridgeCall(options, {
            app: 'unity',
            project: args?.project,
            method: 'playmode',
            args: { action: args?.action },
            cwd: cwdOf(exec),
            timeoutMs: options.processTimeoutMs,
            signal: exec?.signal,
          })
        } catch (error) {
          rethrow('unity_playmode', error)
        }
      },
    },
    {
      name: 'unity_asset_search',
      description:
        'Search the project asset database by name, type, and optional folder. Returns asset paths that unity_asset_read or unity_execute can then use. This finds assets, not code symbols.',
      parameters: {
        type: 'object',
        properties: {
          query: { ...string('Substring matched by AssetDatabase.FindAssets, for example "Player" or "t:Prefab Boss".'), title: 'Query' },
          project,
          folder: { ...string('Restrict the search to this project folder, for example "Assets/Prefabs".') },
          type: { type: 'string', enum: ['all', 'script', 'prefab', 'scene', 'material', 'animation', 'texture', 'model', 'audio'], description: 'Asset kind filter. Default all.' },
          limit: { type: 'integer', description: 'Maximum results, 1-200. Default 20.' },
        },
        additionalProperties: false,
        required: ['query'],
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => {
          const v = /** @type {any} */ (value)
          const results = v.results ?? []
          if (results.length === 0) return textBlock('No matching assets.')
          const lines = results.map((r) => `${r.path}  [${r.type}]`)
          return textBlock(clip(`${results.length}${v.truncated ? '+' : ''} assets:\n${lines.join('\n')}`))
        },
      },
      async execute(args, exec) {
        try {
          return await bridgeCall(options, {
            app: 'unity',
            project: args?.project,
            method: 'asset_search',
            args: {
              query: String(args?.query ?? ''),
              folder: args?.folder,
              type: args?.type ?? 'all',
              limit: Number(args?.limit ?? 20),
            },
            cwd: cwdOf(exec),
            signal: exec?.signal,
          })
        } catch (error) {
          rethrow('unity_asset_search', error)
        }
      },
    },
    {
      name: 'unity_asset_read',
      description:
        'Read a project file as text (unity_execute can read files directly too, but this needs no code and no compile step). Text assets such as .unity, .prefab, .asset, .mat, .cs and .json are returned as text; binary assets come back as base64 only when asked for.',
      parameters: {
        type: 'object',
        properties: {
          path: { ...string('Project-relative or absolute path, for example "Assets/Scenes/Main.unity".'), title: 'Path' },
          project,
          maxBytes: { type: 'integer', description: 'Read limit, 1024-262144. Default 16384.' },
        },
        additionalProperties: false,
        required: ['path'],
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => {
          const v = /** @type {any} */ (value)
          if (!v.isText) return textBlock(`${v.path} — ${v.size} bytes of binary data (base64 omitted from the display).`)
          const note = v.truncated ? `\n… [truncated at ${v.bytesRead} of ${v.size} bytes]` : ''
          return textBlock(clip(`${v.path}\n${v.text ?? ''}${note}`, 12_000))
        },
      },
      async execute(args, exec) {
        try {
          return await bridgeCall(options, {
            app: 'unity',
            project: args?.project,
            method: 'read_asset',
            args: { path: String(args?.path ?? ''), maxBytes: Number(args?.maxBytes ?? 16384) },
            cwd: cwdOf(exec),
            signal: exec?.signal,
          })
        } catch (error) {
          rethrow('unity_asset_read', error)
        }
      },
    },
    {
      name: 'unity_menu',
      description:
        'Run a Unity editor menu item by path, for example "Assets/Reimport All", "File/Save Project", or "GameObject/Create Empty". Returns whether Unity executed the item. Menu items that open modal dialogs block the editor and should be avoided.',
      parameters: {
        type: 'object',
        properties: {
          path: { ...string('Menu path exactly as shown in the Unity main menu, using "/" between levels.'), title: 'Menu path' },
          project,
        },
        additionalProperties: false,
        required: ['path'],
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => textBlock(/** @type {any} */ (value).executed ? 'Menu item executed.' : 'Unity could not find that menu item.'),
      },
      async execute(args, exec) {
        try {
          return await bridgeCall(options, {
            app: 'unity',
            project: args?.project,
            method: 'menu',
            args: { path: String(args?.path ?? '') },
            cwd: cwdOf(exec),
            timeoutMs: options.processTimeoutMs,
            signal: exec?.signal,
          })
        } catch (error) {
          rethrow('unity_menu', error)
        }
      },
    },
    {
      name: 'unity_recompile',
      description:
        'Ask Unity to recompile scripts and reimport assets, then return immediately. Poll unity_status for isCompiling to know when it settles; unity_console shows compilation errors.',
      parameters: { type: 'object', properties: { project }, additionalProperties: false, required: [] },
      output: {
        schema: { type: 'object' },
        render: () => textBlock('Recompilation requested. Poll unity_status until isCompiling is false.'),
      },
      async execute(args, exec) {
        try {
          return await bridgeCall(options, { app: 'unity', project: args?.project, method: 'recompile', cwd: cwdOf(exec), signal: exec?.signal })
        } catch (error) {
          rethrow('unity_recompile', error)
        }
      },
    },
    {
      name: 'locus_instances',
      description:
        'List the Unity editors and Blender instances currently advertising the dsh-locus bridge, plus which LaTeX engines are installed. Use it when a Unity or Blender tool reports that no instance is available or that several match.',
      parameters: noArgs,
      output: {
        schema: { type: 'object' },
        render: (_args, value) => {
          const v = /** @type {any} */ (value)
          const lines = []
          for (const instance of v.instances ?? []) {
            lines.push(`${instance.app}: ${instance.projectName || instance.projectPath || instance.key} — pid ${instance.pid}${instance.version ? `, ${instance.version}` : ''}`)
          }
          if ((v.instances ?? []).length === 0) lines.push('No Unity editor or Blender instance is connected.')
          const latex = v.latex ?? {}
          lines.push(latex.engine ? `LaTeX: ${latex.engine} (${latex.path})${latex.dvisvgm ? ', dvisvgm available' : ', no dvisvgm'}` : 'LaTeX: no engine found on PATH.')
          return textBlock(lines.join('\n'))
        },
      },
      async execute(_args, exec) {
        const { listInstances } = await import('../instances.js')
        const { detectLatexToolchain } = await import('../latex.js')
        try {
          const instances = [...listInstances({ app: 'unity' }), ...listInstances({ app: 'blender' })].map((instance) => ({
            app: instance.app,
            key: instance.key,
            pid: instance.pid,
            projectPath: instance.projectPath,
            projectName: instance.projectName,
            version: instance.version,
          }))
          const latex = await detectLatexToolchain({ preferred: options.latexEngine })
          return {
            instances,
            latex: latex.engine ? { engine: latex.engine.name, path: latex.engine.path, dvisvgm: Boolean(latex.dvisvgm) } : {},
          }
        } catch (error) {
          rethrow('locus_instances', error)
        }
      },
    },
  ]
}
