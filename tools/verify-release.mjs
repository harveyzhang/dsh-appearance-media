#!/usr/bin/env node
// dsh-appearance-media — the release gate.
//
// ★ WHAT THIS FILE IS FOR.
//
// "Run the suite once on somebody else's machine" used to be something that
// happened in one person's head, once, by hand. This file turns it into a
// command anybody can run after every change.
//
// The repository has two accident-shaped holes, and both of them look GREEN
// on a machine that happens to own the piece that is missing:
//
//   A. `verify-remux.mjs` wrapped its 57 core checks in
//      `if (existsSync(fixture) && fast !== null)`, and the two fixtures
//      lived on ONE machine (upstream material + the user's own library).
//      On any other machine — including a fresh clone of this repository —
//      the suite reported "1 check(s), 0 failed": all green, nothing
//      verified.
//   B. Two suites reached for material OUTSIDE the repository (`.sdd/`), so
//      a fresh clone died with ENOENT before a single check ran.
//
// The gate therefore has two modes:
//
//   default — the twelve assertion suites as SUBPROCESSES (this file does
//             NOT re-implement their rules), then a REAL `npm pack`, then a
//             REAL install of that tarball into a temporary directory, then
//             a check that the installed plugin imports and exports `apply`.
//   --full  — everything above, PLUS "stranger acceptance": the repository
//             is cloned with git into a temporary directory and the twelve
//             suites are run again INSIDE THE COPY. A suite that reaches
//             outside the repository fails there — which is the whole point.
//
// ★ THE RULE THAT SHAPES EVERY LINE HERE: a check that cannot go red is
//   not a check. Every assertion below has a way to fail; the ways to fail
//   are exercised before this file counts as done (see the delivery report).
//
// ★ THE OTHER RULE: concurrent edits. A red light whose cause is somebody
//   else's edit is not a bug in the code — it is a fact about the working
//   tree. The gate snapshots every git-tracked file (mtime + sha256) before
//   it starts and again when it finishes, and it says out loud which files
//   changed underneath it.
//
// ★ WHAT THIS FILE DELIBERATELY DOES NOT DO.
//
//   It does not repeat the rules of the suites it runs. `verify-package.mjs`
//   owns "the tarball carries this and not that"; `verify-remux.mjs` owns
//   "the remux keeps the payload"; this file owns the things nobody else
//   owns: does the whole suite still run, does the package install from a
//   tarball, does the installed plugin import, and did the working tree move
//   while we were looking at it.
//
// Usage:
//   node tools/verify-release.mjs             the fast gate (target: < 2 min)
//   node tools/verify-release.mjs --full      plus stranger acceptance
//   node tools/verify-release.mjs --list      what it would do, and nothing else
//   node tools/verify-release.mjs --keep-temp   keep the temporary directory

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/* ───────────────────────────────────────────────────────────────────────────
   Constants. Module level ON PURPOSE.
   ─────────────────────────────────────────────────────────────────────────── */

/**
 * The repository root, without a trailing slash.
 *
 * ★ Module level, never inside a block: a constant declared inside a block is
 *   invisible to the code that runs later, and "repoRoot is not defined" has
 *   been earned twice in this repository.
 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/+$/, '')

/** The directory the assertion suites live in. */
const TOOLS_DIR = join(REPO_ROOT, 'tools')

/** The published package's name. */
const PACKAGE_NAME = 'dsh-appearance-media'

/** This file's own name — it is a gate, not a suite, and must not run itself. */
const GATE_FILENAME = 'verify-release.mjs'

/**
 * The assertion suites the gate drives.
 *
 * Hard-coded on purpose: the gate also ASSERTS that this list still matches
 * the files in `tools/`, so a new suite cannot slip in un-gated.
 */
const SUITE_NAMES = [
  'background',
  'boot-screen',
  'catalog',
  'client-ui',
  'docs',
  'handover',
  'media-delete',
  'package',
  'remux',
  'renderers',
  'routes',
  'screensaver',
  'slots',
]

/**
 * Per-suite wall clock cap.
 *
 * ★ 240 seconds, because this project has a suite that once ran for 16
 *   minutes. A hung suite must not hang the gate.
 */
const SUITE_TIMEOUT_SECONDS = 240
const SUITE_TIMEOUT_MS = SUITE_TIMEOUT_SECONDS * 1000

/** How much child output to keep. */
const MAX_BUFFER = 64 * 1024 * 1024

/** How many lines of a failing suite's output to quote. */
const OUTPUT_QUOTE_LINES = 40

/**
 * The minimum number of checks a suite must report.
 *
 * ★ NOT 1. The `verify-remux` accident produced exactly "1 check(s), 0
 *   failed" — the shape a suite takes when its material is missing and
 *   everything real gets skipped. A suite that reports one or zero checks is
 *   treated as a dead suite, not as a passing suite.
 */
const MIN_CHECKS_PER_SUITE = 2

/* ───────────────────────────────────────────────────────────────────────────
   The report framework.
   ─────────────────────────────────────────────────────────────────────────── */

/** @type {{ label: string, ok: boolean, detail: string }[]} */
const checks = []

/**
 * Build one assertion's verdict.
 *
 * @param {string} label - what the assertion says.
 * @param {boolean} ok - whether it held.
 * @param {string} detail - the evidence.
 * @returns {{ label: string, ok: boolean, detail: string }} the verdict.
 */
function verdict(label, ok, detail = '') {
  return { label, ok: Boolean(ok), detail }
}

/**
 * Print one verdict and remember it.
 *
 * @param {{ label: string, ok: boolean, detail: string }} check - the verdict.
 * @returns {boolean} the verdict's boolean.
 */
function print(check) {
  checks.push(check)
  const lines = String(check.detail).split('\n')
  const head = lines[0] ?? ''
  console.log((check.ok ? 'PASS  ' : 'FAIL  ') + check.label + (head === '' ? '' : '  — ' + head))
  for (const line of lines.slice(1)) console.log('      ' + line)
  return check.ok
}

/**
 * Print a note: something true and worth saying that is not a pass or a fail.
 *
 * @param {string} text - the note.
 * @returns {void}
 */
function note(text) {
  console.log('NOTE  ' + text)
}

/**
 * Print a step header.
 *
 * @param {number} index - the step's number.
 * @param {number} total - how many steps this run has.
 * @param {string} title - the step's title.
 * @returns {void}
 */
function step(index, total, title) {
  console.log('')
  console.log('── 步骤 ' + String(index) + '/' + String(total) + ' · ' + title + ' ' + '─'.repeat(Math.max(0, 48 - title.length)))
}

/**
 * The last lines of some output.
 *
 * @param {string} text - the output.
 * @param {number} lines - how many lines to keep.
 * @returns {string} the tail.
 */
function tail(text, lines = OUTPUT_QUOTE_LINES) {
  const all = String(text).split('\n').filter((line) => line !== '')
  if (all.length === 0) return '(空)'
  return all.slice(Math.max(0, all.length - lines)).join('\n')
}

/* ───────────────────────────────────────────────────────────────────────────
   Small helpers around child processes and git.
   ─────────────────────────────────────────────────────────────────────────── */

/**
 * Run a command and capture everything.
 *
 * @param {string} command - the executable.
 * @param {string[]} args - its arguments.
 * @param {string} cwd - the working directory.
 * @param {number} [timeoutMs] - an optional wall clock cap.
 * @returns {{ status: number | null, signal: string | null, stdout: string, stderr: string }} the result.
 */
function run(command, args, cwd, timeoutMs) {
  const options = { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER }
  if (timeoutMs !== undefined) {
    options.timeout = timeoutMs
    options.killSignal = 'SIGKILL'
  }
  const result = spawnSync(command, args, options)
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/**
 * Run git and capture its output.
 *
 * @param {string[]} args - git's arguments.
 * @param {string} cwd - the working directory.
 * @returns {{ status: number | null, stdout: string, stderr: string }} the result.
 */
function git(args, cwd) {
  const result = run('git', args, cwd)
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/**
 * The sha256 of a file's bytes.
 *
 * @param {string} path - the file.
 * @returns {string} the hex digest, or '' when the file cannot be read.
 */
function sha256File(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return ''
  }
}

/**
 * Every file git tracks, relative to the repository root.
 *
 * @param {string} cwd - the repository root.
 * @returns {string[]} the tracked paths.
 */
function trackedFiles(cwd) {
  const result = git(['ls-files', '-z'], cwd)
  if (result.status !== 0) return []
  return result.stdout.split('\0').filter((entry) => entry !== '')
}

/**
 * Snapshot every tracked file: mtime, size and content hash.
 *
 * ★ The snapshot is taken BEFORE the run and AGAIN AFTER it. A file whose
 *   content hash changed while the gate was running was edited underneath
 *   the gate; a file whose mtime moved but whose hash did not was merely
 *   touched. The report says which of the two happened, because the two mean
 *   different things to whoever reads the red light.
 *
 * @param {string} cwd - the repository root.
 * @returns {Map<string, { missing: boolean, mtimeMs: number, size: number, sha256: string }>} the snapshot.
 */
function snapshotTrackedFiles(cwd) {
  const snapshot = new Map()
  for (const relativePath of trackedFiles(cwd)) {
    const absolute = join(cwd, relativePath)
    let stats = null
    try {
      stats = statSync(absolute)
    } catch {
      stats = null
    }
    if (stats === null) {
      snapshot.set(relativePath, { missing: true, mtimeMs: 0, size: 0, sha256: '' })
      continue
    }
    snapshot.set(relativePath, {
      missing: false,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      sha256: sha256File(absolute),
    })
  }
  return snapshot
}

/**
 * Compare two snapshots and describe what moved.
 *
 * @param {Map<string, { missing: boolean, mtimeMs: number, size: number, sha256: string }>} before - the first snapshot.
 * @param {Map<string, { missing: boolean, mtimeMs: number, size: number, sha256: string }>} after - the second snapshot.
 * @returns {{ path: string, kind: string }[]} one entry per changed file.
 */
function diffSnapshots(before, after) {
  const changes = []
  for (const [path, was] of before) {
    const now = after.get(path)
    if (now === undefined) {
      changes.push({ path, kind: '不再被 git 跟踪（测试期间有人动了索引）' })
      continue
    }
    if (now.missing && !was.missing) {
      changes.push({ path, kind: '文件不见了' })
      continue
    }
    if (was.missing && !now.missing) {
      changes.push({ path, kind: '文件回来了' })
      continue
    }
    if (now.sha256 !== was.sha256) {
      changes.push({ path, kind: '内容变了（sha256 不同）' })
      continue
    }
    if (now.mtimeMs !== was.mtimeMs) {
      changes.push({ path, kind: '内容没变，但 mtime 变了' })
    }
  }
  for (const [path] of after) {
    if (!before.has(path)) changes.push({ path, kind: '新增的被跟踪文件' })
  }
  return changes
}

/**
 * The suite files present in `tools/`, minus this gate.
 *
 * @returns {string[]} the suite base names, without the `verify-` prefix.
 */
function suitesOnDisk() {
  return readdirSync(TOOLS_DIR)
    .filter((name) => name.startsWith('verify-') && name.endsWith('.mjs') && name !== GATE_FILENAME)
    .map((name) => name.slice('verify-'.length, -'.mjs'.length))
    .sort()
}

/* ───────────────────────────────────────────────────────────────────────────
   Running one assertion suite.
   ─────────────────────────────────────────────────────────────────────────── */

/**
 * Whether a `timeout` command is usable on this machine.
 *
 * macOS ships a BSD `timeout` (no `--version`), Linux ships GNU's. The
 * probe is behavioural: run `timeout 1 true` and look at the exit code.
 */
const TIMEOUT_COMMAND = (() => {
  const probe = run('timeout', ['1', 'true'], REPO_ROOT)
  return probe.status === 0 ? 'timeout' : null
})()

/**
 * Run one assertion suite in a subprocess.
 *
 * ★ The 240-second cap is applied by `timeout` when the machine has it, and
 *   by Node's own spawn timeout when it does not. Either way the cap holds.
 *
 * @param {string} root - the repository the suite runs in.
 * @param {string} name - the suite's base name.
 * @returns {{ name: string, status: number | null, signal: string | null, timedOut: boolean, durationMs: number, checks: number | null, failed: number | null, stdout: string, stderr: string }} the outcome.
 */
function runSuite(root, name) {
  const script = join(root, 'tools', 'verify-' + name + '.mjs')
  const started = Date.now()
  let result
  if (TIMEOUT_COMMAND !== null) {
    result = run(TIMEOUT_COMMAND, ['-k', '10', String(SUITE_TIMEOUT_SECONDS), process.execPath, script], root)
  } else {
    result = run(process.execPath, [script], root, SUITE_TIMEOUT_MS)
  }
  const durationMs = Date.now() - started
  const timedOut = result.status === 124 || result.signal === 'SIGTERM' || result.signal === 'SIGKILL'
  const summary = /(\d+)\s+check\(s\),\s*(\d+)\s+failed/.exec(result.stdout)
  return {
    name,
    status: result.status,
    signal: result.signal,
    timedOut,
    durationMs,
    checks: summary === null ? null : Number(summary[1]),
    failed: summary === null ? null : Number(summary[2]),
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

/**
 * Report one suite's outcome as a verdict.
 *
 * @param {{ name: string, status: number | null, signal: string | null, timedOut: boolean, durationMs: number, checks: number | null, failed: number | null, stdout: string, stderr: string }} result - the outcome.
 * @returns {{ label: string, ok: boolean, detail: string }} the verdict.
 */
function suiteVerdict(result) {
  const label = 'verify-' + result.name
  const seconds = (result.durationMs / 1000).toFixed(1)
  if (result.timedOut) {
    return verdict(
      label + ' 在 ' + String(SUITE_TIMEOUT_SECONDS) + 's 内没有结束',
      false,
      '超时（timeout ' + String(SUITE_TIMEOUT_SECONDS) + '）\n最后输出：\n' + tail(result.stdout + '\n' + result.stderr))
  }
  if (result.checks === null) {
    return verdict(
      label + ' 报告了检查条数',
      false,
      '输出里找不到 "N check(s), M failed" 这一行 ⇒ 这套断言没有报告它做了什么\n最后输出：\n' + tail(result.stdout + '\n' + result.stderr))
  }
  if (result.checks < MIN_CHECKS_PER_SUITE) {
    return verdict(
      label + ' 真的跑起来了',
      false,
      '只报告了 ' + String(result.checks) + ' 条检查（至少要 ' + String(MIN_CHECKS_PER_SUITE)
      + ' 条）⇒ 这套断言在多半是"什么都没验"的那种假绿')
  }
  if (result.failed > 0 || result.status !== 0) {
    return verdict(
      label + ' 全绿',
      false,
      String(result.checks) + ' 条检查，' + String(result.failed) + ' 条失败，退出码 ' + String(result.status)
      + '，耗时 ' + seconds + 's\n最后输出：\n' + tail(result.stdout + '\n' + result.stderr))
  }
  return verdict(
    label + ' 全绿',
    true,
    String(result.checks) + ' 条检查，0 条失败，耗时 ' + seconds + 's')
}

/**
 * Run every suite in a repository root and report them.
 *
 * @param {string} root - the repository root.
 * @param {string} title - what this run is (used in the step header).
 * @returns {{ total: number, failed: number }} the totals.
 */
function runAllSuites(root, title) {
  let total = 0
  let failed = 0
  for (const name of SUITE_NAMES) {
    const result = runSuite(root, name)
    const check = suiteVerdict(result)
    print(check)
    if (result.checks !== null) total += result.checks
    if (!check.ok) failed += 1
  }
  print(verdict(
    title + '：' + String(SUITE_NAMES.length) + ' 套断言一共跑了 ' + String(total) + ' 条检查',
    total > 0,
    total > 0 ? '共 ' + String(failed) + ' 套没过' : '一条检查都没跑 ⇒ 这次绿灯是空的'))
  return { total, failed }
}

/* ───────────────────────────────────────────────────────────────────────────
   Packing and installing.
   ─────────────────────────────────────────────────────────────────────────── */

/**
 * Pack the package into a directory.
 *
 * ★ A REAL pack, not `npm pack --dry-run`: the gate installs the tarball it
 *   gets, so the tarball has to exist.
 *
 * @param {string} root - the repository root.
 * @param {string} destination - the directory the tarball goes into.
 * @returns {{ ok: boolean, tarball: string, filename: string, entryCount: number, unpackedSize: number, error: string }} the outcome.
 */
function packPackage(root, destination) {
  const result = run('npm', ['pack', '--pack-destination', destination, '--json'], root)
  if (result.status !== 0) {
    return {
      ok: false,
      tarball: '',
      filename: '',
      entryCount: 0,
      unpackedSize: 0,
      error: 'npm pack 退出码 ' + String(result.status) + '\n' + tail(result.stdout + '\n' + result.stderr),
    }
  }
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch (error) {
    return {
      ok: false,
      tarball: '',
      filename: '',
      entryCount: 0,
      unpackedSize: 0,
      error: 'npm pack --json 的输出不是 JSON：\n' + tail(result.stdout + '\n' + result.stderr),
    }
  }
  const entry = Array.isArray(parsed) ? parsed[0] : parsed
  return {
    ok: true,
    tarball: join(destination, entry.filename),
    filename: entry.filename,
    entryCount: entry.entryCount,
    unpackedSize: entry.unpackedSize,
    error: '',
  }
}

/**
 * Install a tarball into a fresh directory.
 *
 * ★ `--legacy-peer-deps` on purpose. `@deepseek-ai/schemastery` is a PEER
 *   dependency: the host supplies it. Letting npm install it here would
 *   (a) need the network, and (b) put a copy in the tree that the host would
 *   never have provided — the exact duplicate this gate exists to catch.
 *
 * @param {string} tarball - the tarball's absolute path.
 * @param {string} installDir - a fresh directory.
 * @returns {{ ok: boolean, error: string }} the outcome.
 */
function installTarball(tarball, installDir) {
  const init = run('npm', ['init', '-y'], installDir)
  if (init.status !== 0) {
    return { ok: false, error: 'npm init -y 退出码 ' + String(init.status) + '\n' + tail(init.stdout + '\n' + init.stderr) }
  }
  const install = run('npm', ['install', tarball, '--legacy-peer-deps', '--no-audit', '--no-fund', '--ignore-scripts'], installDir)
  if (install.status !== 0) {
    return { ok: false, error: 'npm install 退出码 ' + String(install.status) + '\n' + tail(install.stdout + '\n' + install.stderr) }
  }
  return { ok: true, error: '' }
}

/**
 * Find directories named `@deepseek-ai/schemastery` under a root.
 *
 * @param {string} root - the directory to scan.
 * @param {number} [depth] - how deep to go.
 * @returns {string[]} the absolute paths that were found.
 */
function findSchemastery(root, depth = 6) {
  const found = []
  if (depth < 0) return found
  let entries = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const absolute = join(root, entry.name)
    if (entry.name === 'schemastery' && root.endsWith('@deepseek-ai')) {
      found.push(absolute)
      continue
    }
    found.push(...findSchemastery(absolute, depth - 1))
  }
  return found
}

/* ───────────────────────────────────────────────────────────────────────────
   The gate itself.
   ─────────────────────────────────────────────────────────────────────────── */

/**
 * Print what this gate would do, and exit without doing any of it.
 *
 * ★ `--list` exists so that another suite can prove the gate is runnable
 *   WITHOUT running it: the gate runs the suites, so a suite that ran the
 *   gate for real would re-enter itself, forever.
 *
 * @param {boolean} full - whether `--full` was asked for.
 * @returns {void}
 */
function printPlan(full) {
  console.log('════ dsh-appearance-media · 发布闸门 ════')
  console.log('闸门文件：tools/' + GATE_FILENAME)
  console.log('仓库：' + REPO_ROOT)
  console.log('模式：' + (full ? '--full（快检 + 陌生人验收）' : '默认（快检）'))
  console.log('每套断言的超时上限：' + String(SUITE_TIMEOUT_SECONDS) + 's')
  console.log('')
  console.log('步骤（默认模式）：')
  console.log('  1. 前置检查：这是一个 git 仓库、HEAD、闸门覆盖了每一套断言、工作区是否干净（只报告，不判红）')
  console.log('  2. ' + String(SUITE_NAMES.length) + ' 套断言作为子进程跑（每套 timeout ' + String(SUITE_TIMEOUT_SECONDS) + 's）')
  console.log('  3. npm pack 到临时目录，拿到真正的 tarball')
  console.log('  4. 把 tarball 装进临时目录：查嵌套的 @deepseek-ai/schemastery，再 import() 看有没有 apply')
  console.log('  5. 并发编辑检测：跑前/跑后各快照一次被跟踪文件的 mtime + sha256')
  console.log('--full 追加：')
  console.log('  6. git clone 到临时目录 → 在副本里再跑一遍全套 → 副本也做一次并发编辑检测')
  console.log('')
  console.log('会跑的断言套件（' + String(SUITE_NAMES.length) + '）：')
  for (const name of SUITE_NAMES) console.log('  tools/verify-' + name + '.mjs')
}

/**
 * Run the gate.
 *
 * @returns {number} the process exit code.
 */
function main() {
  const full = process.argv.includes('--full')
  const keepTemp = process.argv.includes('--keep-temp')
  const totalSteps = full ? 6 : 5
  const gateStarted = Date.now()

  if (process.argv.includes('--list')) {
    printPlan(full)
    return 0
  }

  console.log('════ dsh-appearance-media · 发布闸门 ════')
  console.log('模式：' + (full ? '--full（快检 + 陌生人验收）' : '默认（快检）'))
  console.log('仓库：' + REPO_ROOT)
  console.log('每套断言的超时上限：' + String(SUITE_TIMEOUT_SECONDS) + 's'
    + (TIMEOUT_COMMAND !== null ? '（用系统 timeout 命令）' : '（用 Node 自带的 spawn 超时）'))

  const temporary = mkdtempSync(join(tmpdir(), 'dsh-appearance-media-release-'))
  let exitCode = 0

  try {
    /* ── 步骤 1 · 前置检查 ─────────────────────────────────────────────── */
    step(1, totalSteps, '前置检查')

    // ★ The concurrent-edit snapshot is taken HERE, before anything runs.
    //   It is compared in step 5. A file that changed in between was edited
    //   underneath the gate.
    const repoSnapshot = snapshotTrackedFiles(REPO_ROOT)

    const toplevel = git(['rev-parse', '--show-toplevel'], REPO_ROOT)
    print(verdict(
      '这是一个 git 仓库',
      toplevel.status === 0 && toplevel.stdout.trim() === REPO_ROOT,
      toplevel.status === 0 ? toplevel.stdout.trim() : 'git rev-parse 失败：' + tail(toplevel.stderr)))

    const head = git(['rev-parse', 'HEAD'], REPO_ROOT)
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], REPO_ROOT)
    print(verdict(
      'HEAD 可以读出来',
      head.status === 0,
      head.status === 0 ? head.stdout.trim().slice(0, 7) + '（' + branch.stdout.trim() + '）' : tail(head.stderr)))

    const onDisk = suitesOnDisk()
    const missing = SUITE_NAMES.filter((name) => !onDisk.includes(name))
    const extra = onDisk.filter((name) => !SUITE_NAMES.includes(name))
    print(verdict(
      '闸门覆盖了仓库里的每一套断言（' + String(SUITE_NAMES.length) + ' 套）',
      missing.length === 0 && extra.length === 0,
      missing.length === 0 && extra.length === 0
        ? 'tools/ 里正好是这 ' + String(SUITE_NAMES.length) + ' 套'
        : '仓库里少了：' + (missing.join(', ') || '无') + '｜仓库里多出（没纳入闸门）：' + (extra.join(', ') || '无')))

    // The working tree's state is REPORTED, never fatal: a dirty tree is a
    // fact, and the stranger acceptance tests the committed state anyway.
    const status = git(['status', '--porcelain'], REPO_ROOT)
    const dirtyLines = status.stdout.split('\n').filter((line) => line.trim() !== '')
    const untracked = dirtyLines.filter((line) => line.startsWith('??'))
    const modified = dirtyLines.filter((line) => !line.startsWith('??'))
    if (dirtyLines.length === 0) {
      note('工作区干净 ⇒ 陌生人验收测的就是当前状态')
    } else {
      note('有 ' + String(dirtyLines.length) + ' 个文件未提交（改了 ' + String(modified.length)
        + ' 个，新增 ' + String(untracked.length) + ' 个）⇒ 陌生人验收测的是旧状态（--full 测的是 HEAD）')
      for (const line of dirtyLines.slice(0, 20)) console.log('      ' + line)
      if (dirtyLines.length > 20) console.log('      …还有 ' + String(dirtyLines.length - 20) + ' 行')
    }

    /* ── 步骤 2 · 跑断言套件 ───────────────────────────────────────────── */
    step(2, totalSteps, '12 套断言（每套 timeout ' + String(SUITE_TIMEOUT_SECONDS) + 's，串行）')
    const suiteRun = runAllSuites(REPO_ROOT, '断言套件')

    /* ── 步骤 3 · 打包 ─────────────────────────────────────────────────── */
    step(3, totalSteps, '打包（npm pack → 临时目录）')
    const packDir = join(temporary, 'pack')
    mkdirSync(packDir, { recursive: true })
    const packed = packPackage(REPO_ROOT, packDir)
    print(verdict(
      'npm pack 成功，tarball 落在临时目录里',
      packed.ok && existsSync(packed.tarball),
      packed.ok
        ? packed.filename + '（' + String(packed.entryCount) + ' 个文件，' + String(packed.unpackedSize) + ' 字节）'
        : packed.error))

    /* ── 步骤 4 · 安装并导入 ───────────────────────────────────────────── */
    step(4, totalSteps, '装进临时目录并导入')
    const installDir = join(temporary, 'install')
    mkdirSync(installDir, { recursive: true })
    const pluginDir = join(installDir, 'node_modules', PACKAGE_NAME)

    let installed = false
    if (packed.ok) {
      const install = installTarball(packed.tarball, installDir)
      installed = install.ok
      print(verdict(
        'npm install <tarball> 成功',
        install.ok,
        install.ok ? '装在 ' + installDir : install.error))
    } else {
      print(verdict('npm install <tarball> 成功', false, '没打成 tarball，这一步没法做'))
    }

    print(verdict(
      '插件目录装出来了',
      installed && existsSync(join(pluginDir, 'index.js')),
      installed ? pluginDir : '没装出来'))

    // ★ The nested copy. A peer dependency must not arrive as a second
    //   runtime: the host provides one, and two copies means two different
    //   schema runtimes in the same process.
    const nested = installed ? findSchemastery(pluginDir) : []
    print(verdict(
      '插件目录下没有嵌套的 @deepseek-ai/schemastery',
      installed && nested.length === 0,
      installed
        ? (nested.length === 0 ? '扫了 ' + pluginDir + '：没有' : nested.join('\n'))
        : '没装出来'))

    const hoisted = installed ? findSchemastery(join(installDir, 'node_modules'), 3).filter((path) => !path.startsWith(pluginDir)) : []
    print(verdict(
      '安装树里没有多出来的 @deepseek-ai/schemastery',
      installed && hoisted.length === 0,
      installed
        ? (hoisted.length === 0 ? 'peer 依赖由宿主提供，安装时不该拉一份回来' : hoisted.join('\n'))
        : '没装出来'))

    let installedManifest = null
    try {
      installedManifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
    } catch {
      installedManifest = null
    }
    const runtimeDeps = installedManifest && installedManifest.dependencies ? installedManifest.dependencies : {}
    print(verdict(
      '装完的 manifest 没有把 schemastery 写进 dependencies',
      installed && runtimeDeps['@deepseek-ai/schemastery'] === undefined,
      installed
        ? 'dependencies: ' + JSON.stringify(runtimeDeps)
        : '没装出来'))

    let importOk = false
    let importDetail = ''
    if (installed) {
      const probe = [
        'const module_ = await import(' + JSON.stringify(pathToFileURL(join(pluginDir, 'index.js')).href) + ')',
        'const names = Object.keys(module_)',
        'console.log("GATE_JSON:" + JSON.stringify({ names, hasApply: typeof module_.apply === "function" }))',
      ].join('\n')
      const imported = run(process.execPath, ['--input-type=module', '-e', probe], installDir)
      const marker = imported.stdout.split('\n').find((line) => line.startsWith('GATE_JSON:'))
      let payload = null
      try {
        payload = marker === undefined ? null : JSON.parse(marker.slice('GATE_JSON:'.length))
      } catch {
        payload = null
      }
      importOk = imported.status === 0 && payload !== null && payload.hasApply === true
      importDetail = importOk
        ? '导出：' + (payload.names ?? []).join(', ') + '（有 apply）'
        : '退出码 ' + String(imported.status) + '，输出：\n' + tail(imported.stdout + '\n' + imported.stderr)
    } else {
      importDetail = '没装出来，这一步没法做'
    }
    print(verdict('import(\'<解包后的>/index.js\') 成功，导出里有 apply', importOk, importDetail))

    /* ── 步骤 5 · 并发编辑检测 ─────────────────────────────────────────── */
    step(5, totalSteps, '并发编辑检测（仓库）')
    const repoAfter = snapshotTrackedFiles(REPO_ROOT)
    const repoChanges = diffSnapshots(repoSnapshot, repoAfter)
    print(verdict(
      '测试期间没有被跟踪的文件被改动',
      repoChanges.length === 0,
      repoChanges.length === 0
        ? '快照了 ' + String(repoSnapshot.size) + ' 个被跟踪的文件（mtime + sha256），跑完再比一次：没有变化'
        : repoChanges.map((change) => change.path + '（' + change.kind + '）').join('\n')
          + '\n⇒ 红灯可能是别人的并发编辑；本次结果不反映当前工作区状态。'))

    /* ── 步骤 6 · 陌生人验收（--full）──────────────────────────────────── */
    if (full) {
      step(6, totalSteps, '陌生人验收（git clone 到临时目录，再跑一遍全套）')
      const cloneDir = join(temporary, 'clone')
      const cloned = git(['clone', '--depth', '1', REPO_ROOT, cloneDir], temporary)
      print(verdict(
        '把仓库克隆到了临时目录',
        cloned.status === 0 && existsSync(join(cloneDir, '.git')),
        cloned.status === 0
          ? cloneDir + (cloned.stderr.includes('--depth is ignored') ? '（git 对本地克隆忽略了 --depth，不影响内容）' : '')
          : 'git clone 退出码 ' + String(cloned.status) + '\n' + tail(cloned.stderr)))

      const cloneHead = git(['rev-parse', 'HEAD'], cloneDir)
      const sameHead = cloneHead.status === 0 && cloneHead.stdout.trim() === head.stdout.trim()
      print(verdict(
        '副本测的是同一个提交（已提交的状态）',
        sameHead,
        sameHead
          ? cloneHead.stdout.trim().slice(0, 7) + ' = 仓库的 HEAD'
          : '副本 HEAD: ' + cloneHead.stdout.trim() + '，仓库 HEAD: ' + head.stdout.trim()))

      const cloneSnapshot = snapshotTrackedFiles(cloneDir)
      const cloneRun = runAllSuites(cloneDir, '副本里的断言套件')

      const cloneAfter = snapshotTrackedFiles(cloneDir)
      const cloneChanges = diffSnapshots(cloneSnapshot, cloneAfter)
      print(verdict(
        '副本里测试期间没有被跟踪的文件被改动',
        cloneChanges.length === 0,
        cloneChanges.length === 0
          ? '快照了 ' + String(cloneSnapshot.size) + ' 个被跟踪的文件：没有变化'
          : cloneChanges.map((change) => change.path + '（' + change.kind + '）').join('\n')))

      print(verdict(
        '陌生人验收全绿',
        suiteRun.failed === 0 && cloneRun.failed === 0 && repoChanges.length === 0 && cloneChanges.length === 0,
        '仓库里 ' + String(SUITE_NAMES.length) + ' 套过了 ' + String(SUITE_NAMES.length - suiteRun.failed)
        + ' 套，副本里过了 ' + String(SUITE_NAMES.length - cloneRun.failed) + ' 套'))
    }

    /* ── 汇总 ──────────────────────────────────────────────────────────── */
    const failedChecks = checks.filter((check) => check.ok === false)
    const duration = ((Date.now() - gateStarted) / 1000).toFixed(1)

    console.log('')
    console.log('════ 汇总 ════')
    console.log('检查项：' + String(checks.length) + ' 条，其中 ' + String(failedChecks.length) + ' 条失败')
    console.log('断言套件跑过的检查：' + String(suiteRun.total) + ' 条（' + String(SUITE_NAMES.length) + ' 套）')
    console.log('耗时：' + duration + 's（' + (full ? '--full' : '默认模式') + '）')
    if (failedChecks.length > 0) {
      console.log('')
      console.log('失败明细：')
      for (const check of failedChecks) {
        console.log('  ✗ ' + check.label)
        for (const line of String(check.detail).split('\n')) {
          if (line !== '') console.log('      ' + line)
        }
      }
      exitCode = 1
    }
    console.log('')
    console.log(String(checks.length) + ' check(s), ' + String(failedChecks.length) + ' failed')
  } finally {
    if (keepTemp) {
      note('临时目录保留在：' + temporary)
    } else {
      rmSync(temporary, { recursive: true, force: true })
    }
  }

  return exitCode
}

process.exitCode = main()
