import './helpers/state.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'


const { callBridge, LocusError } = await import('../src/protocol.js')
const { instancesDir } = await import('../src/paths.js')

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * Start the Blender add-on against the stub bpy module.
 * @returns {Promise<{child: import('node:child_process').ChildProcess, record: any}>} running host.
 */
async function startAddon() {
  // The DSH sandbox forbids piped stdio for child processes, so the host writes
  // nothing back; readiness is observed through the instance file instead.
  // Clear leftovers from a previous (hard-killed) host first: a killed process
  // cannot remove its own instance file, and the add-on only prunes dead pids.
  if (fs.existsSync(instancesDir())) {
    for (const name of fs.readdirSync(instancesDir())) {
      if (name.startsWith('blender-')) fs.rmSync(path.join(instancesDir(), name), { force: true })
    }
  }

  const child = spawn(process.env.PYTHON ?? 'python', [path.join(here, 'helpers', 'blender_host.py')], {
    env: { ...process.env },
    stdio: 'ignore',
  })

  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const file = path.join(instancesDir(), `blender-${child.pid}.json`)
    if (fs.existsSync(file)) {
      const record = JSON.parse(fs.readFileSync(file, 'utf8'))
      return { child, record, file }
    }
    if (child.exitCode !== null) throw new Error(`blender host exited with ${child.exitCode} before publishing an instance file`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  child.kill()
  throw new Error('blender host did not publish an instance file within 20 s')
}

/**
 * Stop the host and wait for it to exit.
 * @param {import('node:child_process').ChildProcess} child - process.
 * @returns {Promise<void>} resolved when gone.
 */
function stop(child) {
  return new Promise((resolve) => {
    child.once('exit', () => resolve())
    child.kill()
    setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, 3_000).unref()
  })
}

test('blender add-on speaks the dsh-locus protocol', async (t) => {
  const { child, record } = await startAddon()
  try {
    assert.equal(record.app, 'blender')
    assert.equal(typeof record.port, 'number')
    assert.equal(typeof record.token, 'string')
    assert.equal(record.pid, child.pid)

    const status = await callBridge(record, 'status', {})
    assert.equal(status.app, 'blender')
    assert.equal(status.blenderVersion, '4.2.0')
    assert.equal(status.objectCount, 1)
    assert.equal(status.activeObject, 'Camera')
    assert.deepEqual(status.capabilities, ['status', 'execute', 'screenshot'])

    const executed = await callBridge(record, 'execute', { code: 'print("hello")\n40 + 2' })
    assert.deepEqual(executed.output, ['hello'])
    assert.equal(executed.result, '42')
    assert.equal(executed.compiled, true)
    assert.equal(typeof executed.durationMs, 'number')

    // bpy is preloaded, so user code can touch the scene without importing it.
    const touched = await callBridge(record, 'execute', { code: 'bpy.data.objects.add("Sphere")\nlen(bpy.data.objects)' })
    assert.equal(touched.result, '2')

    const failed = await callBridge(record, 'execute', { code: 'raise ValueError("nope")' }).then(
      () => assert.fail('a raising script must fail'),
      (error) => error,
    )
    assert.equal(failed.code, 'EXECUTION_ERROR')
    assert.match(failed.message, /ValueError: nope/)

    const syntax = await callBridge(record, 'execute', { code: 'def (' }).then(
      () => assert.fail('a syntax error must fail'),
      (error) => error,
    )
    assert.equal(syntax.code, 'EXECUTION_ERROR')
    assert.match(syntax.message, /SyntaxError/)

    const shotPath = path.join(os.tmpdir(), `dsh-locus-blender-shot-${Date.now()}.png`)
    const shot = await callBridge(record, 'screenshot', { path: shotPath })
    assert.equal(shot.path, shotPath)
    assert.equal(shot.width, 960)
    assert.equal(shot.height, 540)
    assert.ok(fs.existsSync(shotPath), 'a PNG was written')
    assert.ok(fs.statSync(shotPath).size > 0)
    fs.rmSync(shotPath, { force: true })

    await assert.rejects(
      () => callBridge({ ...record, token: 'wrong' }, 'status', {}),
      (error) => error instanceof LocusError && error.code === 'AUTH_REQUIRED',
    )

    await assert.rejects(
      () => callBridge(record, 'nope', {}),
      (error) => error.code === 'UNKNOWN_METHOD',
    )
  } finally {
    await stop(child)
  }
})

test('register publishes an instance file and unregister removes it', async () => {
  const resultPath = path.join(os.tmpdir(), `dsh-locus-lifecycle-${Date.now()}.json`)
  const child = spawn(process.env.PYTHON ?? 'python', [path.join(here, 'helpers', 'blender_lifecycle.py'), resultPath], {
    env: { ...process.env },
    stdio: 'ignore',
  })
  try {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline && !fs.existsSync(resultPath)) {
      if (child.exitCode !== null) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.ok(fs.existsSync(resultPath), 'the lifecycle helper wrote a result file')
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
    assert.equal(result.error, undefined, result.error)
    assert.equal(result.ok, true)
    assert.equal(result.runningAfterRegister, true)
    assert.equal(result.existsAfterRegister, true)
    assert.equal(result.timerRegistered, true, 'the main-thread pump is registered as a bpy timer')
    assert.equal(result.record.app, 'blender')
    assert.equal(result.record.pid, child.pid)
    assert.equal(typeof result.record.port, 'number')
    assert.equal(result.existsAfterUnregister, false, 'instance file removed on unregister')
    assert.equal(result.timerAfterUnregister, false, 'timer unregistered on unregister')
  } finally {
    child.kill()
    fs.rmSync(resultPath, { force: true })
  }
})
