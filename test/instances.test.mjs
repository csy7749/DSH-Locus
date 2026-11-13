import './helpers/state.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'


const { instanceKey, listInstances, findUnityProjectRoot, normalizeProjectPath, resolveInstance } = await import('../src/instances.js')
const { instancesDir } = await import('../src/paths.js')
const { LocusError } = await import('../src/protocol.js')

/**
 * Publish one instance record the way a real bridge would.
 * @param {object} record - instance fields.
 * @returns {string} file path.
 */
function publish(record) {
  fs.mkdirSync(instancesDir(), { recursive: true })
  const file = path.join(instancesDir(), `${record.app}-${record.key}.json`)
  fs.writeFileSync(file, JSON.stringify(record))
  return file
}

/** Remove every advertised instance. */
function clear() {
  fs.rmSync(instancesDir(), { recursive: true, force: true })
}

test('normalizes Windows paths the same way the bridges do', () => {
  assert.equal(normalizeProjectPath('\\\\?\\D:\\Projects\\Demo\\'), 'd:\\projects\\demo')
  assert.equal(normalizeProjectPath('D:/Projects/Demo'), 'd:\\projects\\demo')
  assert.equal(normalizeProjectPath('  D:\\Projects\\Demo  '), 'd:\\projects\\demo')
  assert.equal(normalizeProjectPath(''), '')
  assert.equal(normalizeProjectPath(null), '')
})

test('derives a stable 16-character instance key', () => {
  const key = instanceKey('D:\\Projects\\Demo')
  assert.match(key, /^[0-9a-f]{16}$/)
  assert.equal(key, instanceKey('d:/projects/demo/'))
  assert.notEqual(key, instanceKey('D:\\Projects\\Other'))
})

test('lists live instances and drops records whose pid is gone', () => {
  clear()
  const live = publish({
    app: 'unity',
    key: 'aaaaaaaaaaaaaaaa',
    pid: process.pid,
    port: 1234,
    token: 't',
    projectPath: 'D:\\Projects\\Live',
    projectName: 'Live',
    startedAt: 20,
  })
  const dead = publish({
    app: 'unity',
    key: 'bbbbbbbbbbbbbbbb',
    pid: 999_999,
    port: 1235,
    token: 't',
    projectPath: 'D:\\Projects\\Dead',
    projectName: 'Dead',
    startedAt: 30,
  })
  const found = listInstances()
  assert.equal(found.length, 1)
  assert.equal(found[0].projectName, 'Live')
  assert.ok(fs.existsSync(live))
  assert.equal(fs.existsSync(dead), false, 'stale instance file is cleaned up')
  clear()
})

test('finds the enclosing Unity project root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-locus-project-'))
  fs.mkdirSync(path.join(root, 'ProjectSettings'), { recursive: true })
  fs.writeFileSync(path.join(root, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 2021.3.18f1\n')
  const deep = path.join(root, 'Assets', 'Scripts', 'Game')
  fs.mkdirSync(deep, { recursive: true })
  assert.equal(path.resolve(findUnityProjectRoot(deep)), path.resolve(root))
  assert.equal(findUnityProjectRoot(os.tmpdir()), undefined)
})

test('reports a helpful error when nothing is running', () => {
  clear()
  assert.throws(
    () => resolveInstance({ app: 'unity' }),
    (error) => error instanceof LocusError && error.code === 'NOT_READY' && /Unity editor is running/.test(error.message),
  )
  assert.throws(
    () => resolveInstance({ app: 'blender' }),
    (error) => error instanceof LocusError && /Blender instance is running/.test(error.message),
  )
})

test('selects the only live instance and rejects ambiguity', () => {
  clear()
  publish({ app: 'unity', key: 'k1', pid: process.pid, port: 1, token: 't', projectPath: 'D:\\A', projectName: 'A', startedAt: 1 })
  assert.equal(resolveInstance({ app: 'unity' }).projectName, 'A')

  publish({ app: 'unity', key: 'k2', pid: process.pid, port: 2, token: 't', projectPath: 'D:\\B', projectName: 'B', startedAt: 2 })
  assert.throws(
    () => resolveInstance({ app: 'unity' }),
    (error) => error instanceof LocusError && error.code === 'BAD_REQUEST' && /several/i.test(error.message),
  )
  assert.equal(resolveInstance({ app: 'unity', project: 'A' }).projectName, 'A')
  assert.equal(resolveInstance({ app: 'unity', project: 'k2' }).projectName, 'B')
  assert.throws(() => resolveInstance({ app: 'unity', project: 'missing' }), /No running Unity editor matches/)
  clear()
})

test('prefers a Unity project that contains the session workspace', () => {
  clear()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-locus-workspace-'))
  fs.mkdirSync(path.join(root, 'ProjectSettings'), { recursive: true })
  fs.writeFileSync(path.join(root, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 2021.3.18f1\n')
  const workspace = path.join(root, 'Assets')
  fs.mkdirSync(workspace, { recursive: true })

  publish({ app: 'unity', key: 'k1', pid: process.pid, port: 1, token: 't', projectPath: 'D:\\Elsewhere', projectName: 'Elsewhere', startedAt: 2 })
  publish({ app: 'unity', key: 'k2', pid: process.pid, port: 2, token: 't', projectPath: root, projectName: path.basename(root), startedAt: 1 })

  assert.equal(path.resolve(resolveInstance({ app: 'unity', cwd: workspace }).projectPath), path.resolve(root))
  clear()
})
