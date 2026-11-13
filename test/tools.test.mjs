import './helpers/state.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'


const { createTools } = await import('../src/tools/index.js')
const { instancesDir } = await import('../src/paths.js')
const { startFakeBridge } = await import('./helpers/fake-bridge.mjs')

const options = {
  allowExecute: true,
  timeoutMs: 5_000,
  processTimeoutMs: 10_000,
  latexEngine: 'auto',
  svgPreview: false,
}

/**
 * @param {string} name - tool name.
 * @returns {any} definition.
 */
function tool(name) {
  const found = createTools(options).find((definition) => definition.name === name)
  assert.ok(found, `tool ${name} is registered`)
  return found
}

/** Remove every advertised instance so each test starts clean. */
function clearInstances() {
  fs.rmSync(instancesDir(), { recursive: true, force: true })
}

/** Fake `exec` argument, shaped like the host's ToolRunContext. */
const exec = { agent: { session: { header: { cwd: os.tmpdir() } } } }

test('every definition satisfies the DSH tool contract', () => {
  for (const definition of createTools(options)) {
    assert.equal(typeof definition.name, 'string')
    assert.equal(typeof definition.description, 'string')
    assert.equal(definition.parameters.type, 'object')
    assert.equal(definition.output.schema.type, 'object')
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(typeof definition.execute, 'function')
    assert.ok(!/[^a-z0-9_]/.test(definition.name), `${definition.name} is a legal tool name`)
  }
})

test('results survive a JSON round trip', async () => {
  // The host rejects a result that JSON cannot carry verbatim, and it checks that
  // after the fact: a `{ version: undefined }` field becomes an invalid tool
  // result rather than a silently missing key. Both shapes below omit fields.
  clearInstances()
  for (const name of ['latex_status', 'locus_instances']) {
    const value = await tool(name).execute({}, exec)
    assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${name} returns lossless JSON`)
  }

  const { toLosslessJson } = await import('../src/tools/common.js')
  assert.deepEqual(toLosslessJson({ a: 1, b: undefined, c: [1, undefined, 2] }), { a: 1, c: [1, null, 2] })
  assert.deepEqual(toLosslessJson({ n: Number.NaN, i: Infinity, big: 10n, when: new Date('2026-01-02T03:04:05Z') }), {
    n: null,
    i: null,
    big: '10',
    when: '2026-01-02T03:04:05.000Z',
  })
  const cyclic = { name: 'loop' }
  cyclic.self = cyclic
  assert.deepEqual(toLosslessJson(cyclic), { name: 'loop', self: null })
})

test('status renders the editor state reported by the bridge', async () => {
  clearInstances()
  const bridge = await startFakeBridge({
    handlers: {
      status: () => ({
        projectName: 'DemoGame',
        projectPath: 'D:\\Projects\\DemoGame',
        unityVersion: '2021.3.18f1',
        activeScenePath: 'Assets/Scenes/Main.unity',
        isPlaying: false,
        isPaused: false,
        isCompiling: false,
        buildTarget: 'StandaloneWindows64',
        editorPid: 4242,
        timeSinceStartup: 12.5,
        capabilities: ['status', 'execute'],
      }),
    },
  })
  try {
    const value = await tool('unity_status').execute({}, exec)
    assert.equal(value.projectName, 'DemoGame')
    const blocks = tool('unity_status').output.render({}, value)
    assert.match(blocks[0].text, /DemoGame — Unity 2021\.3\.18f1/)
    assert.match(blocks[0].text, /capabilities: status, execute/)
  } finally {
    await bridge.close()
  }
})

test('execute refuses to run when allowExecute is off', async () => {
  const guarded = createTools({ ...options, allowExecute: false }).find((definition) => definition.name === 'unity_execute')
  await assert.rejects(() => guarded.execute({ code: '1' }, exec), /allowExecute/)
})

test('execute forwards code and mode, and renders a compile failure', async () => {
  clearInstances()
  const bridge = await startFakeBridge({
    handlers: {
      execute: (args) => ({ compiled: false, output: [], errors: [{ message: 'CS0103', id: 'CS0103', line: 1, column: 1 }], durationMs: 3, echoed: args.code }),
    },
  })
  try {
    const value = await tool('unity_execute').execute({ code: 'Debug.Log(1);', mode: 'editor' }, exec)
    assert.equal(bridge.calls[0].args.code, 'Debug.Log(1);')
    assert.equal(bridge.calls[0].args.mode, 'editor')
    const blocks = tool('unity_execute').output.render({}, value)
    assert.match(blocks[0].text, /Compilation failed:/)
    assert.match(blocks[0].text, /script\(1,1\): CS0103/)
  } finally {
    await bridge.close()
  }
})

test('console passes the filter through and renders entries', async () => {
  clearInstances()
  const bridge = await startFakeBridge({
    handlers: {
      console: (args) => ({
        entries: [{ level: 'error', message: `boom (${args.level}/${args.limit})` }],
        total: 7,
        dropped: 2,
      }),
    },
  })
  try {
    const value = await tool('unity_console').execute({ limit: 10, level: 'error' }, exec)
    assert.deepEqual(bridge.calls[0].args, { limit: 10, level: 'error' })
    const text = tool('unity_console').output.render({}, value)[0].text
    assert.match(text, /1 of 7 entries \(2 older dropped\)/)
    assert.match(text, /\[error\] boom \(error\/10\)/)
  } finally {
    await bridge.close()
  }
})

test('asset search and read forward their arguments', async () => {
  clearInstances()
  const bridge = await startFakeBridge({
    handlers: {
      asset_search: () => ({ results: [{ path: 'Assets/Prefabs/Boss.prefab', type: 'GameObject' }], truncated: false }),
      read_asset: () => ({ path: 'Assets/A.txt', size: 3, bytesRead: 3, truncated: false, isText: true, text: 'abc' }),
    },
  })
  try {
    const search = await tool('unity_asset_search').execute({ query: 'Boss', type: 'prefab', limit: 5 }, exec)
    assert.deepEqual(bridge.calls[0].args, { query: 'Boss', type: 'prefab', limit: 5 })
    assert.match(tool('unity_asset_search').output.render({}, search)[0].text, /Assets\/Prefabs\/Boss\.prefab {2}\[GameObject\]/)

    const read = await tool('unity_asset_read').execute({ path: 'Assets/A.txt' }, exec)
    assert.equal(bridge.calls[1].args.maxBytes, 16384)
    assert.match(tool('unity_asset_read').output.render({}, read)[0].text, /Assets\/A\.txt\nabc/)
  } finally {
    await bridge.close()
  }
})

test('play mode and recompile reach the bridge', async () => {
  clearInstances()
  const bridge = await startFakeBridge({
    handlers: {
      playmode: () => ({ isPlaying: true, isPaused: false }),
      recompile: () => ({ requested: true }),
    },
  })
  try {
    const play = await tool('unity_playmode').execute({ action: 'play' }, exec)
    assert.equal(play.isPlaying, true)
    assert.equal(bridge.calls[0].args.action, 'play')
    await tool('unity_recompile').execute({}, exec)
    assert.equal(bridge.calls[1].method, 'recompile')
  } finally {
    await bridge.close()
  }
})

test('blender tools talk to the blender bridge', async () => {
  clearInstances()
  const bridge = await startFakeBridge({
    app: 'blender',
    record: { projectPath: null, projectName: 'Unsaved', version: '4.2.0' },
    handlers: {
      status: () => ({
        blenderVersion: '4.2.0',
        file: '',
        scene: 'Scene',
        objectCount: 3,
        mode: 'OBJECT',
        activeObject: 'Cube',
        selected: ['Cube'],
      }),
      execute: () => ({ compiled: true, output: ['hi'], result: '2', durationMs: 5 }),
      screenshot: (args) => ({ path: args.path ?? '/tmp/x.png', width: 960, height: 540 }),
    },
  })
  try {
    const status = await tool('blender_status').execute({}, exec)
    assert.match(tool('blender_status').output.render({}, status)[0].text, /Blender 4\.2\.0 — \(unsaved file\)/)

    const executed = await tool('blender_execute').execute({ code: 'print("hi")' }, exec)
    assert.match(tool('blender_execute').output.render({}, executed)[0].text, /hi\n=> 2\n\(5 ms\)/)

    const shot = await tool('blender_screenshot').execute({ path: '/tmp/shot.png' }, exec)
    assert.match(tool('blender_screenshot').output.render({}, shot)[0].text, /Rendered 960x540 to \/tmp\/shot\.png/)
  } finally {
    await bridge.close()
  }
})

test('latex_status reports the local toolchain', async () => {
  const value = await tool('latex_status').execute({}, exec)
  assert.ok(Array.isArray(value.engines))
  const text = tool('latex_status').output.render({}, value)[0].text
  assert.ok(text.length > 0)
})

test('relative paths resolve against the session workspace', async () => {
  // Regression: the session directory is on the session header, not on the
  // session object. Reading the wrong field resolved relative paths against the
  // host process directory and reported a misleading "source not found".
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-locus-ws-'))
  const expected = path.join(workspace, 'paper', 'main.tex')
  await assert.rejects(
    tool('latex_build').execute({ texPath: 'paper/main.tex' }, { agent: { session: { header: { cwd: workspace } } } }),
    (error) => {
      assert.ok(String(error.message).includes(expected), `resolved inside the workspace, got: ${error.message}`)
      return true
    },
  )

  const { sessionCwd } = await import('../src/tools/common.js')
  assert.equal(sessionCwd({ agent: { session: { header: { cwd: workspace } } } }), workspace)
  assert.equal(sessionCwd({ agent: { session: { cwd: workspace } } }), workspace)
  assert.equal(sessionCwd({}), process.cwd())
})

test('locus_instances lists live bridges plus the LaTeX toolchain', async () => {
  clearInstances()
  const unity = await startFakeBridge({
    handlers: { status: () => ({}) },
    record: { projectName: 'UniProj', projectPath: 'D:\\UniProj', version: '2021.3.18f1' },
  })
  const blender = await startFakeBridge({
    app: 'blender',
    handlers: { status: () => ({}) },
    record: { projectName: 'Scene1', projectPath: 'D:\\Scene1.blend', version: '4.2.0' },
  })
  try {
    const value = await tool('locus_instances').execute({}, exec)
    assert.deepEqual(
      value.instances.map((instance) => instance.app).sort(),
      ['blender', 'unity'],
    )
    const text = tool('locus_instances').output.render({}, value)[0].text
    assert.match(text, /unity: UniProj — pid \d+, 2021\.3\.18f1/)
    assert.match(text, /blender: Scene1 — pid \d+, 4\.2\.0/)
  } finally {
    await unity.close()
    await blender.close()
  }
})
