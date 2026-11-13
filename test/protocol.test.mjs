import './helpers/state.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'


const { callBridge, LocusError } = await import('../src/protocol.js')
const { startFakeBridge } = await import('./helpers/fake-bridge.mjs')

test('authenticates with the instance token and returns the result', async () => {
  const bridge = await startFakeBridge({ handlers: { status: () => ({ projectName: 'Demo' }) } })
  try {
    const record = { app: 'unity', port: bridge.port, token: bridge.token }
    const result = await callBridge(record, 'status', {})
    assert.deepEqual(result, { projectName: 'Demo' })
    assert.deepEqual(bridge.calls, [{ method: 'status', args: {} }])
  } finally {
    await bridge.close()
  }
})

test('rejects a stale token with AUTH_REQUIRED', async () => {
  const bridge = await startFakeBridge()
  try {
    await assert.rejects(
      () => callBridge({ app: 'unity', port: bridge.port, token: 'wrong' }, 'status', {}),
      (error) => error instanceof LocusError && error.code === 'AUTH_REQUIRED',
    )
  } finally {
    await bridge.close()
  }
})

test('surfaces an unknown method as UNKNOWN_METHOD', async () => {
  const bridge = await startFakeBridge()
  try {
    await assert.rejects(
      () => callBridge({ app: 'unity', port: bridge.port, token: bridge.token }, 'nope', {}),
      (error) => error.code === 'UNKNOWN_METHOD',
    )
  } finally {
    await bridge.close()
  }
})

test('times out instead of hanging when a bridge never answers', async () => {
  const bridge = await startFakeBridge({ handlers: { status: () => new Promise(() => {}) } })
  try {
    const started = Date.now()
    await assert.rejects(
      () => callBridge({ app: 'unity', port: bridge.port, token: bridge.token }, 'status', {}, { timeoutMs: 150 }),
      (error) => error.code === 'TIMEOUT',
    )
    assert.ok(Date.now() - started < 5_000, 'timeout fired promptly')
  } finally {
    await bridge.close()
  }
})

test('reports a closed port as a connection failure', async () => {
  await assert.rejects(
    () => callBridge({ app: 'unity', port: 1, token: 'x' }, 'status', {}, { timeoutMs: 1_000 }),
    (error) => error instanceof LocusError,
  )
})

test('honours an abort signal', async () => {
  const bridge = await startFakeBridge({ handlers: { status: () => new Promise(() => {}) } })
  const controller = new AbortController()
  try {
    const pending = callBridge({ app: 'unity', port: bridge.port, token: bridge.token }, 'status', {}, {
      timeoutMs: 10_000,
      signal: controller.signal,
    })
    controller.abort()
    await assert.rejects(pending, (error) => error.code === 'ABORTED')
  } finally {
    await bridge.close()
  }
})
