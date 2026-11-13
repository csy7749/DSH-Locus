/** LaTeX tools: compile .tex to PDF/SVG and report the toolchain. @module */

import path from 'node:path'
import { buildLatex, detectLatexToolchain } from '../latex.js'
import { clip, sessionCwd, textBlock } from './common.js'

/**
 * Build the LaTeX tool definitions.
 * @param {object} options - resolved plugin options (`latexEngine`, `svgPreview`, `processTimeoutMs`).
 * @returns {any[]} tool definitions.
 */
export function latexTools(options) {
  return [
    {
      name: 'latex_build',
      description:
        'Compile a .tex document and return the PDF path, extracted errors and warnings. Runs in the document directory so relative figures and includes resolve, writes output to a stable temporary directory, reruns once when the log requests it, and converts the first page to SVG when dvisvgm is installed.',
      parameters: {
        type: 'object',
        properties: {
          texPath: { type: 'string', description: 'Path to the .tex file; relative paths resolve against the session workspace.' },
          engine: { type: 'string', enum: ['auto', 'xelatex', 'lualatex', 'pdflatex'], description: 'Compiler. Default auto: the configured engine, else xelatex, lualatex, pdflatex in that order.' },
          svg: { type: 'boolean', description: 'Also convert page 1 to SVG. Default follows the plugin setting.' },
          outDir: { type: 'string', description: 'Output directory. Default: a stable directory under the system temp dir, reused across builds of the same file.' },
        },
        additionalProperties: false,
        required: ['texPath'],
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => {
          const v = /** @type {any} */ (value)
          const lines = []
          lines.push(`${v.ok ? 'Build succeeded' : 'Build failed'} with ${v.engine}${v.engineVersion ? ` ${v.engineVersion}` : ''} in ${v.durationMs} ms (${v.passes.length} pass${v.passes.length === 1 ? '' : 'es'}).`)
          if (v.pdfPath) lines.push(`PDF: ${v.pdfPath}`)
          if (v.svgPath) lines.push(`SVG: ${v.svgPath}`)
          if (v.logPath) lines.push(`Log: ${v.logPath}`)
          if (v.errors?.length) {
            lines.push('', 'Errors:')
            for (const error of v.errors.slice(0, 20)) {
              lines.push(`  ${error.file ?? '(source)'}${error.line ? `:${error.line}` : ''}: ${error.message}`)
            }
          }
          if (v.warnings?.length) {
            lines.push('', `Warnings (${v.warnings.length}):`)
            for (const warning of v.warnings.slice(0, 8)) lines.push(`  ${warning}`)
          }
          if (v.svgError) lines.push('', `SVG conversion failed: ${clip(v.svgError, 600)}`)
          if (v.logTail) lines.push('', 'Log tail:', v.logTail)
          return textBlock(clip(lines.join('\n'), 12_000))
        },
      },
      async execute(args, exec) {
        const svg = args?.svg === undefined ? options.svgPreview : Boolean(args.svg)
        const engine = args?.engine && args.engine !== 'auto' ? args.engine : options.latexEngine
        const requested = String(args?.texPath ?? '')
        const texPath = path.isAbsolute(requested) ? requested : path.resolve(sessionCwd(exec), requested)
        return buildLatex({ texPath, engine, svg, outDir: args?.outDir, timeoutMs: options.processTimeoutMs })
      },
    },
    {
      name: 'latex_status',
      description:
        'Report which LaTeX engines and dvisvgm are installed and where, plus their versions. Use it before latex_build when a build fails with a missing-engine error.',
      parameters: { type: 'object', properties: {}, additionalProperties: false, required: [] },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => {
          const v = /** @type {any} */ (value)
          const lines = []
          if ((v.engines ?? []).length === 0) lines.push('No LaTeX engine found on PATH (xelatex, lualatex, pdflatex).')
          for (const engine of v.engines ?? []) lines.push(`${engine.name} ${engine.version ?? ''} — ${engine.path}`)
          lines.push(v.dvisvgm ? `dvisvgm ${v.dvisvgm.version ?? ''} — ${v.dvisvgm.path}` : 'dvisvgm not found: SVG previews unavailable.')
          return textBlock(lines.join('\n'))
        },
      },
      async execute() {
        const toolchain = await detectLatexToolchain({ preferred: options.latexEngine })
        return { engines: toolchain.all, dvisvgm: toolchain.dvisvgm }
      },
    },
  ]
}
