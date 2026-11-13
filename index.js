/** dsh-locus: Unity, Blender and LaTeX tools for DeepSeek Harness. @module */

import { createTools } from './src/tools/index.js'

/**
 * Normalize the patch row's `config` into the options the tools consume.
 * Values are validated here rather than through `Config` so the bundle keeps
 * zero runtime imports from the harness packages.
 * Exported for tests; the Cordis entry point is `apply`.
 * @param {unknown} raw - the row's config object.
 * @returns {object} resolved options.
 */
export function resolveOptions(raw) {
  const input = raw && typeof raw === 'object' ? /** @type {Record<string, any>} */ (raw) : {}
  const positive = (value, fallback) => (Number.isFinite(value) && value > 0 ? Number(value) : fallback)
  const engine = ['auto', 'xelatex', 'lualatex', 'pdflatex'].includes(input.latexEngine) ? input.latexEngine : 'auto'
  return {
    // Code execution stays on unless the row turns it off; any falsy value
    // (`false`, `0`, `''`, `null`) counts as off so a typo cannot silently
    // leave arbitrary C#/Python execution enabled.
    allowExecute: input.allowExecute === undefined ? true : Boolean(input.allowExecute),
    timeoutMs: positive(input.timeoutMs, 30_000),
    processTimeoutMs: positive(input.processTimeoutMs, 120_000),
    latexEngine: engine,
    svgPreview: input.svgPreview === undefined ? true : Boolean(input.svgPreview),
  }
}

/**
 * Mount the tool set. Every registration is owned by this plugin's context and
 * removed with it.
 * @param {any} ctx - Cordis plugin context.
 * @param {unknown} config - the row's config from cordis.patch.yml.
 */
export function apply(ctx, config) {
  const options = resolveOptions(config)
  ctx.inject(['tools'], (sctx) => {
    sctx.effect(() => {
      const disposers = createTools(options).map((tool) => sctx.tools.register(tool))
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'dsh-locus: unity, blender and latex tools')
  })
}
