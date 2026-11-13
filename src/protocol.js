/** Line-delimited JSON client for the app bridges. @module */

import net from 'node:net'

/** Client-side failure carrying a protocol-shaped code and optional detail. */
export class LocusError extends Error {
  /**
   * @param {string} code - protocol error code, or a Node error code.
   * @param {string} message - human-readable explanation.
   * @param {unknown} [detail] - structured detail from the bridge.
   */
  constructor(code, message, detail) {
    super(message)
    this.name = 'LocusError'
    this.code = code
    this.detail = detail
  }
}

/**
 * Incremental newline splitter for a byte stream. Bounded so a hostile or
 * broken peer cannot grow the plugin's memory without limit.
 */
class LineReader {
  /** @param {number} [maxLineBytes] - longest accepted line. */
  constructor(maxLineBytes = 16 * 1024 * 1024) {
    this.max = maxLineBytes
    this.buffer = ''
    this.broken = false
  }

  /**
   * Feed one chunk; returns every complete line it completed.
   * @param {Buffer} chunk - socket bytes.
   * @returns {string[]} complete lines, without the trailing newline.
   */
  push(chunk) {
    if (this.broken) return []
    this.buffer += chunk.toString('utf8')
    const lines = []
    let index = this.buffer.indexOf('\n')
    while (index !== -1) {
      lines.push(this.buffer.slice(0, index).replace(/\r$/, ''))
      this.buffer = this.buffer.slice(index + 1)
      index = this.buffer.indexOf('\n')
    }
    if (this.buffer.length > this.max) this.broken = true
    return lines
  }
}

/**
 * Open one connection, authenticate, run exactly one method, then close.
 * One call per connection keeps instance restarts and stale tokens harmless.
 * @param {object} instance - advertised instance record.
 * @param {string} method - method name after `hello`.
 * @param {unknown} args - method arguments; `{}` when absent.
 * @param {object} [options] - `timeoutMs`, `signal`, `host`.
 * @returns {Promise<any>} the bridge's `result` value.
 */
export function callBridge(instance, method, args, options = {}) {
  const { timeoutMs = 30_000, signal, host = '127.0.0.1' } = options
  if (!instance || typeof instance.port !== 'number' || typeof instance.token !== 'string') {
    throw new LocusError('BAD_REQUEST', 'Invalid instance record: port and token are required.')
  }

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: instance.port })
    const reader = new LineReader()
    /** @type {NodeJS.Timeout | undefined} */
    let timer
    let settled = false

    const finish = (error, value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      socket.destroy()
      if (error) reject(error)
      else resolve(value)
    }

    const onAbort = () => finish(new LocusError('ABORTED', 'The tool call was cancelled.'))

    const send = (message) => {
      if (settled) return
      socket.write(`${JSON.stringify(message)}\n`)
    }

    const handleLine = (line) => {
      if (line.trim() === '') return
      let message
      try {
        message = JSON.parse(line)
      } catch {
        finish(new LocusError('BAD_REQUEST', 'The bridge sent a line that is not JSON.'))
        return
      }
      if (message.id === 'hello') {
        if (message.ok !== true) {
          const error = message.error ?? {}
          finish(new LocusError(error.code ?? 'AUTH_REQUIRED', error.message ?? 'The bridge rejected the connection token.'))
          return
        }
        send({ id: 'call', method, args: args ?? {} })
        return
      }
      if (message.id === 'call') {
        if (message.ok === true) finish(undefined, message.result)
        else {
          const error = message.error ?? {}
          finish(new LocusError(error.code ?? 'EXECUTION_ERROR', error.message ?? 'The bridge reported a failure.', error.detail))
        }
      }
    }

    timer = setTimeout(() => {
      finish(new LocusError('TIMEOUT', `No response from ${instance.app ?? 'the bridge'} within ${timeoutMs} ms.`))
    }, timeoutMs)
    timer.unref?.()

    signal?.addEventListener?.('abort', onAbort, { once: true })

    socket.setNoDelay(true)
    socket.on('connect', () => {
      send({ id: 'hello', method: 'hello', args: { token: instance.token } })
    })
    socket.on('data', (chunk) => {
      for (const line of reader.push(chunk)) handleLine(line)
      if (reader.broken) finish(new LocusError('BAD_REQUEST', 'The bridge sent an over-long line.'))
    })
    socket.on('error', (cause) => {
      finish(new LocusError(/** @type {any} */ (cause).code ?? 'CONNECTION_FAILED', `Cannot reach the bridge on port ${instance.port}: ${cause.message}`))
    })
    socket.on('close', () => {
      finish(new LocusError('CONNECTION_CLOSED', 'The bridge closed the connection before answering.'))
    })
  })
}
