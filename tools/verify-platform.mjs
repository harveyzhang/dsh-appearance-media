// ★ The platform matrix in the documents must agree with the code.
//
// WHY THIS FILE EXISTS
// -------------------
// The plugin works on the web build, on macOS and (apart from one feature) on
// Windows. That is a fact about the CODE — it is darwin-only in exactly one
// place — and it is also a fact written down in two documents.
//
// Two facts about the same thing drift apart the moment somebody edits one of
// them. So the table is parsed out of the documents and checked against the
// code. The EXPECTATION comes from the documents, the TRUTH from the source:
// a document that says "Windows cannot do the idle probe" is right only if the
// code really is darwin-only there.
//
// ★ EVERY CHECK MUST BE ABLE TO GO RED. `node tools/verify-platform.mjs
//   --negative` breaks a copy of the tree and shows that each check notices.
//
//   node tools/verify-platform.mjs            the checks
//   node tools/verify-platform.mjs --negative the checks + their reverse controls

import { readFileSync, existsSync, mkdtempSync, cpSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/\/+$/, '')

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
 * @returns {boolean} the verdict's boolean, so a caller can chain it.
 */
function print(check) {
  checks.push(check)
  console.log((check.ok ? 'PASS  ' : 'FAIL  ') + check.label
    + (check.detail === '' ? '' : '  — ' + check.detail))
  return check.ok
}

/**
 * Read a file, or return '' when it is not there.
 *
 * @param {string} path - the file.
 * @returns {string} the text.
 */
function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * The platform matrix, parsed out of a markdown document.
 *
 * The table is recognised by its header row: the first column is the feature,
 * the three columns after it are the platforms.
 *
 * @param {string} text - the document.
 * @returns {{rows: {feature: string, cells: string[]}[], header: string[]}|null} the matrix.
 */
function parseMatrix(text) {
  const lines = text.split('\n')
  const headerIndex = lines.findIndex((line) => {
    const cells = splitRow(line)
    return cells.length === 4 && cells[0].trim() === '功能' && cells[1].trim().includes('浏览器')
  })
  if (headerIndex === -1) return null
  const header = splitRow(lines[headerIndex]).map((cell) => cell.trim())
  const rows = []
  for (let i = headerIndex + 2; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim().startsWith('#')) break
    const cells = splitRow(line)
    if (cells.length !== 4) continue
    const feature = cells[0].trim()
    if (feature === '') continue
    rows.push({ feature, cells: cells.slice(1).map((cell) => cell.trim()) })
  }
  return { rows, header }
}

/**
 * Split one markdown table row into its cells.
 *
 * @param {string} line - the row.
 * @returns {string[]} the cells.
 */
function splitRow(line) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|')) return []
  return trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
}

/**
 * Whether a cell says "yes".
 *
 * @param {string} cell - the cell.
 * @returns {boolean} whether the cell claims support.
 */
function saysYes(cell) {
  return cell.includes('✅') || cell.includes('✔')
}

/**
 * Whether a cell says "no".
 *
 * @param {string} cell - the cell.
 * @returns {boolean} whether the cell denies support.
 */
function saysNo(cell) {
  return cell.includes('❌') || cell.includes('✘')
}

/**
 * The files of the plugin's own source, minus the ones that are not code.
 *
 * @param {string} root - the repository root.
 * @returns {string[]} the paths, relative to the root.
 */
function sourceFiles(root) {
  const found = []
  const walk = (dir, prefix) => {
    for (const name of readdirOf(join(root, dir))) {
      const relative = prefix === '' ? dir + '/' + name : prefix + '/' + name
      if (name.endsWith('.js')) found.push(relative)
    }
  }
  walk('lib', '')
  walk('src', '')
  if (existsSync(join(root, 'index.js'))) found.push('index.js')
  return found
}

/**
 * The names in a directory, or [] when it cannot be read.
 *
 * @param {string} dir - the directory.
 * @returns {string[]} the names.
 */
function readdirOf(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * Change the Windows cell of the idle row in a document.
 *
 * The cell is found BY ROW, not by a regex over the whole file: the platform
 * name sits in the header, not after the cell, so a "❌ ... Windows" pattern
 * never matches and the control breaks nothing.
 *
 * @param {string} path - the document.
 * @param {boolean} windowsSaysYes - what the Windows cell should say.
 * @returns {boolean} whether a cell was changed.
 */
function setWindowsIdleCell(path, windowsSaysYes) {
  const lines = readText(path).split('\n')
  let changed = false
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes('整机闲置')) continue
    const cells = splitRow(lines[i])
    if (cells.length !== 4) continue
    cells[3] = windowsSaysYes ? '✅' : '❌'
    lines[i] = '| ' + cells.join(' | ') + ' |'
    changed = true
    break
  }
  if (changed) writeFileSync(path, lines.join('\n'))
  return changed
}

// ── the checks ──────────────────────────────────────────────────────────────

const readme = readText(join(repoRoot, 'README.md'))
const detail = readText(join(repoRoot, 'docs', 'DETAIL.md'))

const readmeMatrix = parseMatrix(readme)
const detailMatrix = parseMatrix(detail)

print(verdict('the README states the platform matrix', readmeMatrix !== null,
  readmeMatrix === null ? 'no matrix with a 功能/浏览器/… header was found in README.md'
    : readmeMatrix.rows.length + ' rows, header: ' + readmeMatrix.header.join(' | ')))

print(verdict('the plugin detail page states the same matrix', detailMatrix !== null,
  detailMatrix === null ? 'no matrix was found in docs/DETAIL.md'
    : detailMatrix.rows.length + ' rows'))

if (readmeMatrix !== null && detailMatrix !== null) {
  print(verdict('both documents list the same features',
    readmeMatrix.rows.length === detailMatrix.rows.length
      && readmeMatrix.rows.every((row, index) => row.feature === detailMatrix.rows[index].feature),
    'README: ' + readmeMatrix.rows.map((row) => row.feature).join(' / ')
      + ' ‖ DETAIL: ' + detailMatrix.rows.map((row) => row.feature).join(' / ')))

  const same = readmeMatrix.rows.every((row, index) => {
    const other = detailMatrix.rows[index]
    return other !== undefined && row.cells.every((cell, i) => cell === other.cells[i])
  })
  print(verdict('both documents give the same answer in every cell', same,
    same ? readmeMatrix.rows.length + ' rows agree' : 'the two tables disagree in at least one cell'))

  // ── the code ──────────────────────────────────────────────────────────────
  //
  // The claim that is checkable: the idle probe is the ONLY platform-specific
  // piece of this plugin, and it is darwin-only. Everything else in the matrix
  // follows from that: no platform branch means no platform limit.
  const probeText = readText(join(repoRoot, 'lib', 'probe.js'))
  const probeIsDarwinOnly = /currentPlatform\s*!==\s*'darwin'/.test(probeText)
  print(verdict('the idle probe refuses every platform but macOS', probeIsDarwinOnly,
    probeIsDarwinOnly
      ? "lib/probe.js checks currentPlatform !== 'darwin'"
      : "lib/probe.js has no darwin-only guard — the platform matrix may be wrong"))

  const platformTouched = sourceFiles(repoRoot).filter((path) => {
    if (path === 'lib/probe.js') return false
    const text = readText(join(repoRoot, path))
    return /process\.platform|platform\s*!==\s*'|platform\s*===\s*'/.test(text)
  })
  print(verdict('the idle probe is the only platform-specific piece',
    platformTouched.length === 0,
    platformTouched.length === 0
      ? 'no other source file branches on the platform'
      : 'these files branch on the platform too: ' + platformTouched.join(', ')))

  // ── the matrix against the code ──────────────────────────────────────────
  const idleRow = readmeMatrix.rows.find((row) => row.feature.includes('整机闲置'))
  if (idleRow === undefined) {
    print(verdict('the matrix has a row for the whole-machine idle trigger', false,
      'no row whose feature mentions 整机闲置'))
  } else {
    const windowsCell = idleRow.cells[2]
    print(verdict('the matrix says Windows cannot do the idle trigger, and the code agrees',
      saysNo(windowsCell) && probeIsDarwinOnly,
      'the Windows cell says ' + (saysNo(windowsCell) ? 'no' : 'yes')
        + '; the code is ' + (probeIsDarwinOnly ? 'darwin-only' : 'NOT darwin-only')))
  }

  const focusRow = readmeMatrix.rows.find((row) => row.feature.includes('失焦'))
  print(verdict('the matrix keeps the focus trigger available everywhere',
    focusRow !== undefined && focusRow.cells.every((cell) => saysYes(cell)),
    focusRow === undefined ? 'no row whose feature mentions 失焦'
      : 'cells: ' + focusRow.cells.join(' / ')))

  const settingsRow = readmeMatrix.rows.find((row) => row.feature.includes('设置页'))
  print(verdict('the matrix says the settings page entry is a desktop-only thing',
    settingsRow !== undefined && saysNo(settingsRow.cells[0]) && saysYes(settingsRow.cells[1]),
    settingsRow === undefined ? 'no row whose feature mentions 设置页'
      : 'web: ' + settingsRow.cells[0] + ' ‖ macOS: ' + settingsRow.cells[1]))

  // The documents name the mechanism. If the mechanism changes, the sentence
  // that explains the one platform limit has to change with it.
  print(verdict('the documents explain the one platform limit by name',
    /ioreg/.test(readme) && /ioreg/.test(detail),
    'README mentions ioreg: ' + /ioreg/.test(readme) + ' ‖ DETAIL mentions ioreg: ' + /ioreg/.test(detail)))
}

// ── the reverse controls ────────────────────────────────────────────────────

/**
 * Break a copy of the tree and show that the checks notice.
 *
 * @returns {Promise<void>} nothing.
 */
async function runNegativeControls() {
  const controls = [
    {
      label: 'the documents claim the idle probe works on Windows',
      breakIt: (dir) => {
        setWindowsIdleCell(join(dir, 'README.md'), true)
      },
    },
    {
      label: 'the code stops being darwin-only',
      breakIt: (dir) => {
        const path = join(dir, 'lib', 'probe.js')
        writeFileSync(path, readText(path).replace("currentPlatform !== 'darwin'", "currentPlatform !== 'nothing'"))
      },
    },
    {
      label: 'another piece of code starts branching on the platform',
      breakIt: (dir) => {
        const path = join(dir, 'lib', 'catalog.js')
        writeFileSync(path, readText(path) + '\nif (process.platform === "win32") { /* nothing */ }\n')
      },
    },
    {
      label: 'the two documents disagree',
      breakIt: (dir) => {
        setWindowsIdleCell(join(dir, 'docs', 'DETAIL.md'), true)
      },
    },
    {
      label: 'the matrix is deleted',
      breakIt: (dir) => {
        const path = join(dir, 'README.md')
        writeFileSync(path, readText(path).replace(/\| 功能 \| 浏览器[^\n]*\n/, ''))
      },
    },
  ]

  console.log('')
  console.log('reverse controls — each one breaks a copy and shows the check going red:')
  let caught = 0
  for (const control of controls) {
    const dir = mkdtempSync(join(tmpdir(), 'dsham-platform-'))
    try {
      cpSync(repoRoot, dir, { recursive: true, dereference: true })
      control.breakIt(dir)
      const red = checkTree(dir)
      const ok = red > 0
      if (ok) caught += 1
      console.log((ok ? '  caught  ' : '  MISSED  ') + control.label
        + (ok ? '  (' + red + ' check(s) went red)' : '  (nothing noticed)'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  console.log('')
  console.log('controls caught: ' + caught + ' / ' + controls.length
    + (caught === controls.length ? '' : '  ★ SOME CONTROL WAS MISSED'))
  if (caught !== controls.length) process.exitCode = 1
}

/**
 * Run the checks against another tree, quietly.
 *
 * @param {string} root - the tree.
 * @returns {number} how many checks went red.
 */
function checkTree(root) {
  const saved = readText
  let red = 0
  try {
    // Re-run the same checks with the root swapped. The checks above read
    // through repoRoot; this helper is the standalone version.
    const readmeText = readText(join(root, 'README.md'))
    const detailText = readText(join(root, 'docs', 'DETAIL.md'))
    const m = parseMatrix(readmeText)
    const d = parseMatrix(detailText)
    if (m === null || d === null) red += 1
    else {
      if (m.rows.length !== d.rows.length) red += 1
      if (!m.rows.every((row, index) => d.rows[index] !== undefined && row.feature === d.rows[index].feature)) red += 1
      if (!m.rows.every((row, index) => d.rows[index] !== undefined && row.cells.every((cell, i) => cell === d.rows[index].cells[i]))) red += 1
      const idle = m.rows.find((row) => row.feature.includes('整机闲置'))
      const probeText = readText(join(root, 'lib', 'probe.js'))
      const darwinOnly = /currentPlatform\s*!==\s*'darwin'/.test(probeText)
      if (idle === undefined || !(saysNo(idle.cells[2]) && darwinOnly)) red += 1
      const focus = m.rows.find((row) => row.feature.includes('失焦'))
      if (focus === undefined || !focus.cells.every((cell) => saysYes(cell))) red += 1
      const settings = m.rows.find((row) => row.feature.includes('设置页'))
      if (settings === undefined || !(saysNo(settings.cells[0]) && saysYes(settings.cells[1]))) red += 1
      if (!/ioreg/.test(readmeText) || !/ioreg/.test(detailText)) red += 1
      const touched = sourceFiles(root).filter((path) => {
        if (path === 'lib/probe.js') return false
        const text = readText(join(root, path))
        return /process\.platform|platform\s*!==\s*'|platform\s*===\s*'/.test(text)
      })
      if (touched.length > 0) red += 1
    }
  } finally {
    void saved
  }
  return red
}

const wantsNegative = process.argv.includes('--negative')
if (wantsNegative) {
  await runNegativeControls()
}

console.log('')
const failed = checks.filter((check) => check.ok === false)
console.log(checks.length + ' check(s), ' + failed.length + ' failed')
if (failed.length > 0) {
  console.log('')
  for (const check of failed) console.log('failed: ' + check.label + '  — ' + check.detail)
  process.exitCode = 1
}
