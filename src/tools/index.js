/** Tool definitions mounted by the dsh-locus bundle. @module */

import { blenderTools } from './blender.js'
import { latexTools } from './latex.js'
import { unityTools } from './unity.js'
import { toLosslessJson } from './common.js'

/**
 * Build every tool this bundle registers.
 *
 * Every result passes through `toLosslessJson` here rather than in each tool:
 * the host rejects a result that does not survive a JSON round trip, and the
 * bridges legitimately omit fields (`undefined`), which would otherwise be
 * silently dropped on the host side and reported as an invalid result.
 *
 * @param {object} options - resolved plugin options.
 * @returns {any[]} tool definitions.
 */
export function createTools(options) {
  const tools = [...unityTools(options), ...blenderTools(options), ...latexTools(options)]
  return tools.map((tool) => ({
    ...tool,
    async execute(args, exec) {
      return toLosslessJson(await tool.execute(args, exec))
    },
  }))
}
