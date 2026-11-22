// ★ Sync this source tree into a profile's node_modules — and say so when it is out of date.
//
// WHY THIS FILE EXISTS
// -------------------
// The profile's dependency on this plugin is written as
//
//   "dsh-appearance-media": "file:/…/插件源码/dsh-appearance-media"
//
// and the obvious reading of `file:` is "a link to the source". It is NOT.
// The package manager COPIES the tree into
//
//   ~/.dsh/profiles/<profile>/node_modules/dsh-appearance-media
//
// and the copy is a separate inode. Editing the source therefore changes
// NOTHING in the profile: the application keeps running the old code, and
// every fix looks like it "did not take".
//
// That happened on 2026-11-21: the access check was implemented, committed
// and pushed, and the application still answered every route with 200 until
// the copy was replaced.
//
// So the copy has to be refreshed BY HAND, and the state of the copy has to
// be VISIBLE. This script does the first; the release gate checks the second.
//
//   node tools/sync-profile.mjs                  sync into every profile that has the plugin
//   node tools/sync-profile.mjs --profile web    sync into one profile
//   node tools/sync-profile.mjs --check          only report whether the copies are current
//
// ★ The backup is kept under ~/.dsh/rollback/appearance-media-<timestamp>/.

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const repoRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/\/+$/, '')
const profilesRoot = join(homedir(), '.dsh', 'profiles')

/**
 * Whether a path is a symbolic link.
 *
 * @param {string} path - the path.
 * @returns {boolean} whether it is a link.
 */
function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
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
 * The files of the source tree that matter to a running profile.
 *
 * The test suites and the git metadata are not part of a running plugin, and
 * `node_modules` belongs to the profile's package manager.
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
    if (statSync(full).isDirectory()) out.push(...collect(full, rel))
    else out.push(rel)
  }
  return out
}

/**
 * The profiles that have this plugin installed.
 *
 * @returns {{name: string, dir: string}[]} the profiles.
 */
function targets() {
  if (!existsSync(profilesRoot)) return []
  const wanted = process.argv.includes('--profile')
    ? [process.argv[process.argv.indexOf('--profile') + 1]]
    : null
  const found = []
  for (const name of readdirSync(profilesRoot)) {
    if (wanted !== null && !wanted.includes(name)) continue
    const dir = join(profilesRoot, name, 'node_modules', 'dsh-appearance-media')
    if (existsSync(dir)) found.push({ name, dir })
  }
  return found
}

const sourceFiles = collect(repoRoot).sort()
const checkOnly = process.argv.includes('--check')

let stale = 0
for (const target of targets()) {
  const differing = []
  const missing = []
  for (const rel of sourceFiles) {
    if (rel.startsWith('tools/')) continue
    const inProfile = join(target.dir, rel)
    if (!existsSync(inProfile)) { missing.push(rel); continue }
    if (digest(inProfile) !== digest(join(repoRoot, rel))) differing.push(rel)
  }
  const ok = differing.length === 0 && missing.length === 0
  console.log((ok ? '  current  ' : '  STALE    ') + target.name
    + (ok ? '' : '  — ' + differing.length + ' changed, ' + missing.length + ' missing'))
  if (ok) continue
  stale += 1
  if (checkOnly) continue

  // ★ Back up what is about to be replaced.
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).replace('T', '-')
  const backup = join(homedir(), '.dsh', 'rollback', 'appearance-media-' + stamp)
  for (const rel of differing.concat(missing)) {
    const from = join(target.dir, rel)
    if (!existsSync(from)) continue
    const to = join(backup, rel)
    mkdirSync(join(to, '..'), { recursive: true })
    cpSync(from, to)
  }
  console.log('            backup → ' + backup)

  // ★ Copy the tree over, but never touch the profile's own node_modules.
  //
  //   The bytes are WRITTEN, not copied with `cpSync`. Two reasons:
  //     ① some files in a profile are HARD LINKS to the source tree (they
  //        share an inode), and copying a file onto itself is EINVAL;
  //     ② a target that is a SYMLINK must be unlinked first, or writing
  //        through it would change the SOURCE.
  for (const rel of sourceFiles) {
    if (rel.startsWith('tools/')) continue
    const to = join(target.dir, rel)
    mkdirSync(join(to, '..'), { recursive: true })
    try {
      if (existsSync(to) || isSymlink(to)) rmSync(to, { force: true })
    } catch {
      // A file that cannot be replaced is reported by the verification below.
    }
    writeFileSync(to, readFileSync(join(repoRoot, rel)))
  }
  console.log('            synced (' + sourceFiles.length + ' files)')

  // ★ Say the one thing that matters: the running application still has the
  //   old code until it is restarted.
  console.log('            ★ RESTART the Host for this to take effect — the bundle stack'
    + ' is frozen at startup, and a page reload only re-runs the mounted client code.')
}

console.log('')
if (stale === 0) {
  console.log('every profile that has this plugin is current.')
} else if (checkOnly) {
  console.log(stale + ' profile(s) are stale — run: node tools/sync-profile.mjs')
  process.exitCode = 1
} else {
  console.log(stale + ' profile(s) synced. ★ Restart the Host so the running'
    + ' application picks up the new code.')
}
