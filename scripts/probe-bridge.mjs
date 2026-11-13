#!/usr/bin/env node
/**
 * Talk to a live Unity or Blender bridge without going through DeepSeek Harness.
 *
 * The tools are thin wrappers over the same protocol, so this is the fastest way
 * to tell "the plugin is fine and the editor is the problem" from "the bridge is
 * broken": it uses the production client code (`src/protocol.js`,
 * `src/instances.js`) but no host at all.
 *
 * Usage:
 *   node scripts/probe-bridge.mjs                       # list live bridges
 *   node scripts/probe-bridge.mjs status                # call a method
 *   node scripts/probe-bridge.mjs --app blender status
 *   node scripts/probe-bridge.mjs --project hlsjapp asset_search '{"query":"Player"}'
 */

import { callBridge } from '../src/protocol.js'
import { listInstances, resolveInstance } from '../src/instances.js'

const argv = process.argv.slice(2)
/** @type {string|undefined} */
let app
/** @type {string|undefined} */
let project
const rest = []
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (arg === '--app') app = argv[++index]
  else if (arg === '--project') project = argv[++index]
  else rest.push(arg)
}

const instances = listInstances()
console.log(`instances: ${instances.length}`)
for (const instance of instances) {
  console.log(`  ${instance.app} key=${instance.key} pid=${instance.pid} port=${instance.port} project=${instance.projectName ?? '?'} path=${instance.projectPath ?? '?'}`)
}

const method = rest[0]

if (!method) {
  if (instances.length === 0) {
    console.log('\nNo live bridge. Is the Unity editor (or Blender) running with the add-on loaded?')
    process.exitCode = 1
  }
  process.exit(0)
}

let args = {}
if (rest[1] !== undefined) {
  try {
    args = JSON.parse(rest[1])
  } catch (error) {
    console.error(`arguments must be JSON: ${error.message}`)
    process.exit(1)
  }
}

const instance = resolveInstance({ app, project })
const started = Date.now()
const result = await callBridge(instance, method, args, { timeoutMs: 120000 })
console.log(`\n${method} on ${instance.app} (${instance.projectName ?? instance.key}) in ${Date.now() - started} ms`)
console.log(JSON.stringify(result, null, 2))
