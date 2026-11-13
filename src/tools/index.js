/** Tool definitions mounted by the dsh-locus bundle. @module */

import { blenderTools } from './blender.js'
import { latexTools } from './latex.js'
import { unityTools } from './unity.js'

/**
 * Build every tool this bundle registers.
 * @param {object} options - resolved plugin options.
 * @returns {any[]} tool definitions.
 */
export function createTools(options) {
  return [...unityTools(options), ...blenderTools(options), ...latexTools(options)]
}
