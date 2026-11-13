/**
 * One state directory for the whole test run.
 *
 * `node --test` spawns a child process per file with piped stdio, which the DSH
 * sandbox forbids (EPERM), so the suite runs with `--test-isolation=none`:
 * every test file shares one process and therefore one dsh-locus state dir.
 * Import this module before anything that reads `DSH_LOCUS_STATE`.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

if (!process.env.DSH_LOCUS_STATE || !process.env.DSH_LOCUS_STATE.includes('dsh-locus-test-')) {
  process.env.DSH_LOCUS_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-locus-test-'))
}

export const stateDir = process.env.DSH_LOCUS_STATE
