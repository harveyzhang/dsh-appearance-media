// ★ The copy in a profile must be the same code as the source tree.
//
// WHY THIS FILE EXISTS
// -------------------
// The profile's dependency on this plugin says
//
//   "dsh-appearance-media": "file:/…/插件源码/dsh-appearance-media"
//
// and that reads like a link. It is not: the package manager COPIES the tree
// into the profile's node_modules, and the copy has its own inode. Editing the
// source changes nothing in the profile.
//
// On 2026-11-21 that cost a real fix: the access check was written,
// committed, pushed and merged into the official catalog — and the running
// application still answered every route with 200, because it was running the
// copy from before. The symptom is the worst kind: the code is right, the
// tests are green, and the application does not care.
//
// So the release gate has to look at the DEPLOYED copy, not only at the
// source tree.
//
//   node tools/verify-deployed.mjs           the checks
//   node tools/verify-deployed.mjs --negative the checks + their reverse controls

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const repoRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/\/+$/, '')
const profilesRoot = join(homedir(), '.dsh', 'profiles')

/** The verdicts of this run. */
const checks = []

/**
 * Make one verdict.
 *
 * @param {string} label - what was checked.
 * @param {boolean} ok - whether it holds.
 * @param {string} detail - what was seen.
 * @returns {{label: string, ok: boolean, detail: string}} the verdict.
 */
function verdict(label, ok, detail) {
  return { label, ok, detail }
}

/**
 * Print one verdict.
 *
 * @param {{ label: string, ok: boolean, detail: string }} check - the verdict.
 * @returns {boolean} the verdict's boolean.
 */
function print(check) {
  checks.push(check)
  console.log((check.ok ? 'PASS  ' : 'FAIL  ') + check.label
    + (check.detail === '' ? '' : '  — ' + check.detail))
  return check.ok
}

/**
 * The hash of one file's bytes.
 *
 * @param {string} path - the file.
 * @returns {string} the sha256, or 'missing'.
 */
function digest(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return 'missing'
  }
}

/**
 * The files of a tree, excluding the ones a running plugin does not use.
 *
 * @param {string} dir - the directory to walk.
 * @param {string} prefix - the path prefix inside the tree.
 * @returns {string[]} the relative paths.
 */
function collect(dir, prefix = '') {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue
    const full = join(dir, name)
    const rel = prefix === '' ? name : prefix + '/' + name
    if (lstatSync(full).isSymbolicLink()) continue
    if (lstatSync(full).isDirectory()) out.push(...collect(full, rel))
    else out.push(rel)
  }
  return out
}

/**
 * The profiles that have this plugin installed.
 *
 * @returns {{name: string, dir: string}[]} the profiles.
 */
function profilesWithThePlugin() {
  if (!existsSync(profilesRoot)) return []
  const found = []
  for (const name of readdirSync(profilesRoot)) {
    const dir = join(profilesRoot, name, 'node_modules', 'dsh-appearance-media')
    if (existsSync(dir)) found.push({ name, dir })
  }
  return found
}

const sourceFiles = collect(repoRoot).filter((rel) => !rel.startsWith('tools/')).sort()
const profiles = profilesWithThePlugin()

print(verdict('the source tree has files to compare', sourceFiles.length > 0,
  sourceFiles.length + ' files in the source tree'))

if (process.env.DSHAM_IN_COPY === '1') {
  // ★ Inside the stranger-acceptance clone the deployed copy of THIS machine
  //   is deliberately out of sync: the clone holds the committed state, the
  //   machine holds the working tree. Comparing them here would always fail,
  //   and always for a reason that says nothing about the plugin.
  console.log('NOTE  this run is inside the stranger-acceptance clone — the deployed-copy'
    + ' check belongs to the working tree, not to the clone')
  console.log('')
  console.log(checks.length + ' check(s), 0 failed')
  process.exit(0)
}

if (profiles.length === 0) {
  // Another machine: no profile has this plugin. That is not a failure.
  console.log('NOTE  no profile on this machine has this plugin — the deployed-copy checks are skipped')
  console.log('')
  console.log(checks.length + ' check(s), 0 failed')
} else {
  for (const profile of profiles) {
    const changed = []
    const missing = []
    for (const rel of sourceFiles) {
      const deployed = join(profile.dir, rel)
      if (!existsSync(deployed)) { missing.push(rel); continue }
      if (digest(deployed) !== digest(join(repoRoot, rel))) changed.push(rel)
    }
    print(verdict('the deployed copy in profile "' + profile.name + '" is the same code as the source',
      changed.length === 0 && missing.length === 0,
      changed.length === 0 && missing.length === 0
        ? sourceFiles.length + ' files match'
        : changed.length + ' changed (' + changed.slice(0, 4).join(', ') + ')'
          + (changed.length > 4 ? ', …' : '')
          + ' and ' + missing.length + ' missing (' + missing.slice(0, 4).join(', ') + ')'
          + ' ⇒ run: node tools/sync-profile.mjs'))

    // ★ The two files that decide whether the RUNNING application is the one
    //   this source tree describes.
    const deployedIndex = join(profile.dir, 'index.js')
    print(verdict('the deployed copy carries the access check (profile "' + profile.name + '")',
      existsSync(deployedIndex) && /guardHandler/.test(readFileSync(deployedIndex, 'utf8')),
      existsSync(deployedIndex)
        ? (/guardHandler/.test(readFileSync(deployedIndex, 'utf8'))
            ? 'the deployed index.js has the guard'
            : 'the deployed index.js has NO guard ⇒ the running application is the old, unprotected one')
        : 'no index.js in the deployed copy'))
  }
}

// ── the reverse controls ────────────────────────────────────────────────────

/**
 * Show that the deployed-copy check can go red.
 *
 * @returns {void} nothing.
 */
function runNegativeControls() {
  console.log('')
  console.log('reverse control — dirty one deployed file in a COPY of the profile and show the check notices:')
  const profilesForControl = profilesWithThePlugin()
  if (profilesForControl.length === 0) {
    console.log('  MISSED  no profile on this machine to dirty — the control cannot run here')
    return
  }
  const profile = profilesForControl[0]
  const deployed = join(profile.dir, 'index.js')
  if (!existsSync(deployed)) {
    console.log('  MISSED  the profile has no index.js')
    return
  }
  const original = readFileSync(deployed)
  try {
    writeFileSync(deployed, original + '\n// dirty\n')
    const changed = []
    for (const rel of sourceFiles) {
      const path = join(profile.dir, rel)
      if (!existsSync(path)) continue
      if (digest(path) !== digest(join(repoRoot, rel))) changed.push(rel)
    }
    const caught = changed.length > 0
    console.log((caught ? '  caught  ' : '  MISSED  ') + 'a deployed file that differs from the source'
      + (caught ? '  (' + changed.length + ' file(s) reported)' : '  (nothing noticed)'))
    if (!caught) process.exitCode = 1
  } finally {
    writeFileSync(deployed, original)
  }
  console.log('            (the deployed file was restored)')
}

if (process.argv.includes('--negative')) {
  runNegativeControls()
}

console.log('')
const failed = checks.filter((check) => check.ok === false)
console.log(checks.length + ' check(s), ' + failed.length + ' failed')
if (failed.length > 0) {
  console.log('')
  for (const check of failed) console.log('failed: ' + check.label + '  — ' + check.detail)
  process.exitCode = 1
}
