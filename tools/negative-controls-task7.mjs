#!/usr/bin/env node
// dsh-appearance-media — the IN-PLACE negative controls for Task 7.
//
// ★ WHAT THIS DOES, AND WHY IT EXISTS.
//
// The offline suite already runs twelve negative controls against COPIES of
// the source. This script runs the most important ones against the REAL
// files: the file is mutated, the suite is run, and the file is restored from
// a byte-for-byte backup. ⇒ it proves that the assertions are attached to the
// files that actually ship, and not to a copy that happened to be in memory.
//
// ★ THE RESTORE IS BY BYTES, AND THE SHA256 IS CHECKED TWICE.
//
// A control that left the tree broken would be worse than no control at all.
//
// Usage: node tools/negative-controls-task7.mjs

import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SAVER = join(ROOT, 'src', 'screensaver.js')
const PROBE = join(ROOT, 'lib', 'probe.js')
const SUITE = join(ROOT, 'tools', 'verify-screensaver.mjs')

/**
 * The sha256 of one file.
 * @param path - the file.
 * @returns the digest.
 */
function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Run the suite and return its failing lines.
 * @returns the failing labels.
 */
function runSuite() {
  try {
    const out = execFileSync(process.execPath, [SUITE], { encoding: 'utf8', cwd: ROOT })
    return { code: 0, failures: out.split('\n').filter((line) => line.startsWith('FAIL ')), out }
  } catch (error) {
    const out = String(error.stdout ?? '')
    return { code: error.status ?? 1, failures: out.split('\n').filter((line) => line.startsWith('FAIL ')), out }
  }
}

/** The scratch directory the backups live in. */
const scratch = join(tmpdir(), 'dsh-appearance-media-negative-controls')
mkdirSync(scratch, { recursive: true })

/** The mutations. */
const controls = [
  {
    label: 'the hidden grace period (5000 → 0)',
    file: SAVER,
    from: 'var HIDDEN_GRACE_MS = 5000',
    to: 'var HIDDEN_GRACE_MS = 0',
  },
  {
    label: 'the three-state discipline (only `ok` counts)',
    file: SAVER,
    from: "if (r.idleStatus === 'ok') {",
    to: "if (r.idleStatus !== 'unavailable') {",
  },
  {
    label: 'the dismissal latch (the dismissal does not hold)',
    file: SAVER,
    from: 'dismissedUntilActive = true\n    activitySinceDismiss = false',
    to: 'dismissedUntilActive = false\n    activitySinceDismiss = false',
  },
  {
    label: 'the yielding (displace → release)',
    file: SAVER,
    from: '      try {\n        controller.displace(SLOT)\n        return',
    to: '      try {\n        controller.release(SLOT)\n        return',
  },
  {
    label: 'the materialApplied gate (the stage-is-empty rule)',
    file: SAVER,
    from: '    if (materialApplied === true && stage !== SLOT\n      && (layerElement !== null || mediaElement !== null)) {',
    to: '    if (stage !== SLOT\n      && (layerElement !== null || mediaElement !== null)) {',
  },
  {
    label: 'the release order (the observer is not disconnected)',
    file: SAVER,
    from: "      if (full === true) {\n        if (observer !== null) {",
    to: "      if (false) {\n        if (observer !== null) {",
  },
  {
    label: 'the probe (a failure flattened into idleMs: 0)',
    file: PROBE,
    from: "if (currentPlatform !== 'darwin') return failure(STATUS_UNAVAILABLE, 'not-darwin')",
    to: "if (currentPlatform !== 'darwin') return { ok: false, idleMs: 0, status: STATUS_UNAVAILABLE, reason: 'not-darwin' }",
  },
]

const originals = new Map()
for (const control of controls) {
  if (!originals.has(control.file)) {
    const backup = join(scratch, control.file.replace(/[^a-zA-Z0-9]/g, '_'))
    copyFileSync(control.file, backup)
    originals.set(control.file, { backup, sha: digest(control.file) })
  }
}

let failed = 0
console.log('════ 真·原地负向对照（改真的源文件 → 断言必须变红 → 按 sha256 还原）════')
for (const control of controls) {
  const original = originals.get(control.file)
  const text = readFileSync(control.file, 'utf8')
  const index = text.indexOf(control.from)
  if (index === -1) {
    console.log('FAIL  the anchor for "' + control.label + '" is not in the source any more')
    failed += 1
    continue
  }
  writeFileSync(control.file, text.slice(0, index) + control.to + text.slice(index + control.from.length), 'utf8')
  const answer = runSuite()
  const restored = copyFileSync(original.backup, control.file)
  void restored
  const sha = digest(control.file)
  const same = sha === original.sha
  if (!same) failed += 1
  const turnedRed = answer.failures.length > 0
  if (!turnedRed) failed += 1
  console.log(
    (turnedRed && same ? 'PASS  ' : 'FAIL  ')
    + control.label
    + '  — red=' + String(answer.failures.length)
    + ' restored=' + String(same),
  )
  for (const line of answer.failures.slice(0, 3)) console.log('        ' + line)
}

rmSync(scratch, { recursive: true, force: true })
console.log('════ ' + String(controls.length) + ' control(s), ' + String(failed) + ' problem(s) ════')
process.exit(failed === 0 ? 0 : 1)
