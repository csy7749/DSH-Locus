/** A protocol-compatible stand-in for a Unity or Blender bridge. @module */

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { instancesDir } from '../../src/paths.js'

/**
 * Start a fake bridge that speaks the dsh-locus envelope.
 * @param {object} [options] - `app`, `handlers`, `token`, `record`.
 * @returns {Promise<{port: number, token: string, calls: Array<{method: string, args: any}>, close: () => Promise<void>}>} fake bridge.
 */
export async function startFakeBridge({ app = 'unity', handlers = {}, token = 'test-token-0123456789', record = {} } = {}) {
  const calls = []
  const server = net.createServer((socket) => {
    let buffer = ''
    let authenticated = false
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        if (line.trim() === '') continue
        const request = JSON.parse(line)
        if (request.method === 'hello') {
          if (request.args?.token !== token) {
            socket.write(`${JSON.stringify({ id: request.id, ok: false, error: { code: 'AUTH_REQUIRED', message: 'bad token' } })}\n`)
            socket.destroy()
            return
          }
          authenticated = true
          socket.write(`${JSON.stringify({ id: request.id, ok: true, result: { app } })}\n`)
          continue
        }
        if (!authenticated) {
          socket.write(`${JSON.stringify({ id: request.id, ok: false, error: { code: 'AUTH_REQUIRED', message: 'hello first' } })}\n`)
          socket.destroy()
          return
        }
        calls.push({ method: request.method, args: request.args })
        const handler = handlers[request.method]
        if (!handler) {
          socket.write(`${JSON.stringify({ id: request.id, ok: false, error: { code: 'UNKNOWN_METHOD', message: `no handler for ${request.method}` } })}\n`)
          continue
        }
        Promise.resolve()
          .then(() => handler(request.args ?? {}))
          .then((result) => {
            socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`)
          })
          .catch((error) => {
            socket.write(`${JSON.stringify({ id: request.id, ok: false, error: { code: error.code ?? 'EXECUTION_ERROR', message: error.message } })}\n`)
          })
      }
    })
    socket.on('error', () => {})
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const file = path.join(instancesDir(), `${app}-test-${process.pid}.json`)
  fs.mkdirSync(instancesDir(), { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify({
      app,
      key: `testkey-${app}`,
      pid: process.pid,
      port,
      token,
      projectPath: record.projectPath ?? path.resolve('test-project'),
      projectName: record.projectName ?? 'TestProject',
      version: record.version ?? '2021.3.18f1',
      startedAt: Date.now(),
      ...record,
    }),
  )

  return {
    port,
    token,
    calls,
    async close() {
      try {
        fs.rmSync(file, { force: true })
      } catch {}
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
