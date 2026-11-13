import './helpers/state.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'


const { buildLatex, detectLatexToolchain, parseLatexLog, which } = await import('../src/latex.js')

test('parses file:line: message diagnostics', () => {
  const log = [
    'This is XeTeX, Version 3.141592653',
    './main.tex:12: Undefined control sequence.',
    'l.12 \\foo',
    'The control sequence at the end of the top line',
  ].join('\n')
  const parsed = parseLatexLog(log)
  assert.equal(parsed.errors.length, 1)
  assert.deepEqual(parsed.errors[0], { file: 'main.tex', line: 12, message: 'Undefined control sequence.' })
})

test('parses classic bang diagnostics and recovers the source line', () => {
  const log = ['! Missing $ inserted.', '<inserted text>', '                $', 'l.34 Some text'].join('\n')
  const parsed = parseLatexLog(log)
  assert.equal(parsed.errors.length, 1)
  assert.equal(parsed.errors[0].line, 34)
  assert.equal(parsed.errors[0].message, 'Missing $ inserted.')
})

test('collects warnings without duplicates and detects rerun requests', () => {
  const log = [
    "Package hyperref Warning: Token not allowed in a PDF string.",
    "Package hyperref Warning: Token not allowed in a PDF string.",
    'LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.',
  ].join('\n')
  const parsed = parseLatexLog(log)
  assert.equal(parsed.warnings.length, 2, 'the package warning is de-duplicated, the LaTeX warning is kept')
  assert.equal(parsed.rerun, true)
  assert.equal(parsed.errors.length, 0)
})

test('reports an empty diagnostics set for a clean log', () => {
  const parsed = parseLatexLog('This is pdfTeX\nOutput written on main.pdf (1 page).')
  assert.deepEqual(parsed, { errors: [], warnings: [], rerun: false })
})

test('does not find a binary that cannot exist', () => {
  assert.equal(which('dsh-locus-definitely-not-installed'), undefined)
})

test('toolchain detection always returns the documented shape', async () => {
  const toolchain = await detectLatexToolchain({ preferred: 'xelatex' })
  assert.ok(Array.isArray(toolchain.all))
  if (toolchain.all.length === 0) assert.equal(toolchain.engine, undefined)
  else assert.ok(toolchain.all.some((engine) => engine.name === toolchain.engine.name))
})

test('refuses to build a missing source file', async () => {
  await assert.rejects(() => buildLatex({ texPath: path.join(os.tmpdir(), 'dsh-locus-missing.tex') }), /not found/)
})

test('fails clearly when no LaTeX engine is installed', async (t) => {
  const toolchain = await detectLatexToolchain()
  if (toolchain.engine) {
    t.skip('a LaTeX engine is installed on this machine')
    return
  }
  const source = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-locus-tex-')), 'main.tex')
  fs.writeFileSync(source, '\\documentclass{article}\\begin{document}hi\\end{document}\n')
  await assert.rejects(() => buildLatex({ texPath: source }), /No LaTeX engine found/)
})
