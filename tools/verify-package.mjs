#!/usr/bin/env node
// dsh-appearance-media — npm publish-package assertions.
//
// ★ WHAT THIS CHECKS, AND WHY IT IS NOT A CHECK UNTIL IT CAN GO RED.
//
// A published package that is missing one file installs BROKEN: the plugin
// boots, its routes 404, and the user finds out at runtime. The cost of a
// missing file is paid by somebody else, on somebody else's machine, with no
// error message that says "the package was assembled wrong".
//
// So this script asserts two things about the tarball `npm pack` would build:
//
//   1. every file the plugin needs AT RUNTIME is inside it;
//   2. every file that has no business being inside it is outside it.
//
// And then — the part that makes it a check rather than a decoration —
// EVERY assertion is run again against a DELIBERATELY BROKEN package, and
// the broken one MUST be reported as broken. A rule that cannot fail is not a
// rule. The negative controls work on COPIES in a temporary directory; the
// real files are never touched.
//
// ★ WHY THE FILE LIST COMES FROM `npm pack --dry-run --json`.
//
// Not from `package.json.files`. That array is a REQUEST; the tarball is the
// RESULT. npm applies its own rules on top of it (always-included files,
// .gitignore filtering, directory expansion). Asserting against the request
// would prove nothing about what actually ships.
//
// ★ A NOTE ON THE ALWAYS-INCLUDED FILES.
//
// npm puts `package.json`, `README.md` and `LICENSE` into every tarball no
// matter what the `files` array says. A control that merely drops one of
// them from `files` therefore CANNOT turn red — and a control that cannot
// turn red is a broken control, not a passing one. The controls below
// delete the file itself instead, which is the only way those three can
// actually go missing.
//
// Usage:
//   node tools/verify-package.mjs            the checks and their reverse controls
//   node tools/verify-package.mjs --list     the file list only, no assertions

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ★ The repository root, once: without the trailing slash, because
//   `new URL('..', …)` keeps one and `repoRoot + '/'` would then be a double
//   slash that nothing starts with.
const repoRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/\/+$/, '')

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACKAGE_JSON = join(ROOT, 'package.json')

/**
 * Files that MUST be in the tarball, because the plugin breaks without them.
 *
 * `src/` is not optional: the Host half reads `src/renderers.js`,
 * `src/controller.js`, `src/background.js`, `src/boot-screen.js` and
 * `src/screensaver.js` off disk with `readFileSync` and injects them into
 * the page as inline script text (see `index.js`, the RENDERERS_SOURCE_PATH
 * family). A package without `src/` boots and then serves a blank page.
 *
 * `lib/client.js` is the built browser half; `lib/` also carries the Host-side
 * modules. `locale/` carries the card's title and description. `icon.svg` is
 * what the card draws. `cordis.patch.yml` is the bundle patch the Host reads.
 */
const REQUIRED_FILES = [
  'index.js',
  'cordis.patch.yml',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'README.md',
  'icon.svg',
  'package.json',
]

/**
 * Directories that MUST be in the tarball, with at least one file each.
 *
 * A directory entry counts as "present" when at least one file path starts
 * with it — npm packs a directory's CONTENTS, not the directory itself, so
 * there is no `lib/` entry to look for.
 */
const REQUIRED_DIRS = ['src/', 'lib/', 'locale/', 'docs/']

/**
 * Paths that MUST NOT be in the tarball.
 *
 * `tools/` is the assertion suite: 700 KB of test code that no runtime needs.
 * The rest are things npm excludes by itself, and the point of asserting
 * them is that they stay excluded if the `files` array is ever widened.
 */
const FORBIDDEN_PREFIXES = ['tools/', 'node_modules/', '.git/', '.sdd/', '.catalog/']

/**
 * The manifest fields the plugin marketplace needs to find and install us.
 *
 * `keywords` is how a packument is matched against the marketplace's list;
 * `publishConfig.registry` pins the publish target so a mirror configured in
 * the user's npm config cannot redirect the release.
 */
const REQUIRED_KEYWORDS = ['deepseek', 'harness', 'dsh', 'dsh-plugin']
const EXPECTED_REPOSITORY = 'git+https://github.com/harveyzhang/dsh-appearance-media.git'
const EXPECTED_HOMEPAGE = 'https://github.com/harveyzhang/dsh-appearance-media'
const EXPECTED_BUGS = 'https://github.com/harveyzhang/dsh-appearance-media/issues'
const EXPECTED_REGISTRY = 'https://registry.npmjs.org/'

const checks = []

/**
 * Build one assertion's verdict.
 *
 * The verdict is returned rather than printed, so the same rule can be
 * evaluated against the real package and against a broken copy.
 *
 * @param {string} label - what the assertion says.
 * @param {boolean} ok - whether it held.
 * @param {string} detail - what the evidence was.
 * @returns {{ label: string, ok: boolean, detail: string }} the verdict.
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
 * The file list `npm pack --dry-run --json` reports.
 *
 * @param {string} cwd - the package directory to inspect.
 * @returns {{ paths: string[], count: number, size: number }} the tarball contents.
 */
function packManifest(cwd) {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const parsed = JSON.parse(raw)
  const entry = Array.isArray(parsed) ? parsed[0] : parsed
  return {
    paths: entry.files.map((file) => file.path),
    count: entry.entryCount,
    size: entry.unpackedSize,
  }
}

/**
 * Every file-level rule, evaluated against one manifest.
 *
 * Split out from the runner so the SAME function can be pointed at the real
 * package and at a deliberately broken copy. That is the whole trick: the
 * broken copy must be rejected by this function, not by a second, weaker
 * implementation that happens to agree.
 *
 * @param {string[]} paths - the tarball's file paths.
 * @returns {{ label: string, ok: boolean, detail: string }[]} one verdict per rule.
 */
function checkFileRules(paths) {
  const verdicts = []
  for (const required of REQUIRED_FILES) {
    const present = paths.includes(required)
    verdicts.push(verdict(
      'the tarball carries ' + required,
      present,
      present ? '' : 'not in the package'))
  }
  for (const dir of REQUIRED_DIRS) {
    const present = paths.some((path) => path.startsWith(dir))
    verdicts.push(verdict(
      'the tarball carries ' + dir + ' (at least one file)',
      present,
      present ? '' : 'no file under ' + dir))
  }
  for (const forbidden of FORBIDDEN_PREFIXES) {
    const present = paths.filter((path) => path.startsWith(forbidden))
    verdicts.push(verdict(
      'the tarball does NOT carry ' + forbidden,
      present.length === 0,
      present.length === 0 ? '' : 'found: ' + present.join(', ')))
  }
  return verdicts
}

/**
 * Every manifest-field rule, evaluated against one package.json.
 *
 * @param {object} pkg - the parsed manifest.
 * @returns {{ label: string, ok: boolean, detail: string }[]} one verdict per rule.
 */
function checkManifestRules(pkg) {
  const verdicts = []
  const keywords = Array.isArray(pkg.keywords) ? pkg.keywords : []
  for (const keyword of REQUIRED_KEYWORDS) {
    const present = keywords.includes(keyword)
    verdicts.push(verdict(
      'the manifest declares the keyword "' + keyword + '"',
      present,
      present ? '' : 'keywords: ' + JSON.stringify(keywords)))
  }
  const repository = pkg.repository && pkg.repository.url
  verdicts.push(verdict(
    'the manifest points at the repository',
    repository === EXPECTED_REPOSITORY,
    'repository: ' + String(repository)))
  verdicts.push(verdict(
    'the manifest carries a homepage',
    pkg.homepage === EXPECTED_HOMEPAGE,
    'homepage: ' + String(pkg.homepage)))
  verdicts.push(verdict(
    'the manifest carries a bugs address',
    Boolean(pkg.bugs) && pkg.bugs.url === EXPECTED_BUGS,
    'bugs: ' + JSON.stringify(pkg.bugs)))
  const registry = pkg.publishConfig && pkg.publishConfig.registry
  verdicts.push(verdict(
    'the manifest pins the publish registry',
    registry === EXPECTED_REGISTRY,
    'publishConfig.registry: ' + String(registry)))
  verdicts.push(verdict(
    'the manifest is publishable (no "private": true)',
    pkg.private !== true,
    'private: ' + String(pkg.private)))
  const dependencies = pkg.dependencies
  verdicts.push(verdict(
    'the manifest does not bundle a second copy of schemastery',
    dependencies === undefined || dependencies['@deepseek-ai/schemastery'] === undefined,
    'dependencies: ' + JSON.stringify(dependencies)))
  return verdicts
}

/**
 * A copy of the package in a temporary directory.
 *
 * The copy is what the negative controls run against. Nothing in the real
 * tree is written to, so a failed control cannot leave the repository broken.
 *
 * @returns {string} the copy's directory.
 */
function brokenCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-appearance-media-pkg-'))
  cpSync(ROOT, dir, {
    recursive: true,
    filter: (source) => {
      const name = source.split('/').pop() ?? ''
      return name !== '.git' && name !== 'node_modules' && name !== '.sdd'
    },
  })
  return dir
}

/**
 * Write a manifest to a directory.
 *
 * @param {string} dir - the directory.
 * @param {object} pkg - the manifest to write.
 * @returns {void}
 */
function writeManifest(dir, pkg) {
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
}

/**
 * Run one negative control: break a copy, and require the check to notice.
 *
 * The control is the assertion. If the broken copy is reported as FINE, the
 * check is decoration and the control fails.
 *
 * @param {string} label - what was broken.
 * @param {Function} break_ - breaks the copy; receives (dir, pkg).
 * @returns {boolean} whether the broken copy was caught.
 */
function negativeControl(label, break_) {
  const dir = brokenCopy()
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    break_(dir, pkg)
    writeManifest(dir, pkg)
    const paths = packManifest(dir).paths
    const verdicts = checkFileRules(paths).concat(checkManifestRules(pkg))
    const broken = verdicts.filter((check) => check.ok === false)
    const caught = broken.length > 0
    console.log('  ┌ the broken copy was evaluated: ' + String(verdicts.length)
      + ' rule(s), ' + String(broken.length) + ' went red')
    for (const check of broken) {
      console.log('  │ RED  ' + check.label + (check.detail === '' ? '' : '  — ' + check.detail))
    }
    console.log('  └ ' + (caught ? 'the check caught it' : 'the check did NOT catch it'))
    return print(verdict(
      'REVERSE CONTROL: ' + label + ' ⇒ the checks must turn red',
      caught,
      caught ? 'the broken copy was rejected' : 'the broken copy was accepted — the check cannot fail'))
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── the report ──────────────────────────────────────────────────────────────

if (process.argv.includes('--list')) {
  const manifest = packManifest(ROOT)
  console.log(String(manifest.count) + ' files, ' + String(manifest.size) + ' bytes unpacked')
  for (const path of manifest.paths) console.log('  ' + path)
  process.exit(0)
}

console.log('dsh-appearance-media — publish-package assertions')
console.log('')

const manifest = packManifest(ROOT)
const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'))

console.log('the tarball npm would publish: ' + String(manifest.count) + ' files, '
  + String(manifest.size) + ' bytes unpacked')
console.log('')

for (const check of checkFileRules(manifest.paths)) print(check)
console.log('')
for (const check of checkManifestRules(pkg)) print(check)
console.log('')

console.log('════ reverse controls (a broken copy MUST be rejected) ════')
console.log('')

// 1. A missing runtime directory: the classic "installs broken" failure.
negativeControl(
  'src/ is dropped from the files list',
  (dir, broken) => {
    broken.files = broken.files.filter((entry) => entry !== 'src')
  })

// 2. A missing licence file. npm force-includes LICENSE, so the file itself
//    has to go — dropping it from `files` could never turn red.
negativeControl(
  'the LICENSE file is deleted',
  (dir) => {
    unlinkSync(join(dir, 'LICENSE'))
  })

// 3. The assertion suite sneaks into the package.
negativeControl(
  'tools/ is added to the files list',
  (dir, broken) => {
    broken.files = broken.files.concat('tools')
  })

// 4. The marketplace keyword is gone: the package would ship but be invisible.
negativeControl(
  'the "dsh-plugin" keyword is removed',
  (dir, broken) => {
    broken.keywords = broken.keywords.filter((keyword) => keyword !== 'dsh-plugin')
  })

// 5. The repository is gone: the package has no source for anyone to read.
negativeControl(
  'the repository field is removed',
  (dir, broken) => {
    delete broken.repository
  })

// 6. The publish registry is gone: a mirror in the user's npm config could
//    swallow the release.
negativeControl(
  'publishConfig.registry is removed',
  (dir, broken) => {
    delete broken.publishConfig
  })

// 7. The package is marked private: npm refuses to publish it at all.
negativeControl(
  'the package is marked private',
  (dir, broken) => {
    broken.private = true
  })

// 8. A second copy of the host's schema library is bundled.
negativeControl(
  'schemastery is added back to dependencies',
  (dir, broken) => {
    broken.dependencies = { '@deepseek-ai/schemastery': '3.19.0' }
  })

// 9. The homepage is gone: the package has nowhere to send a reader.
negativeControl(
  'the homepage field is removed',
  (dir, broken) => {
    delete broken.homepage
  })

/* ───────────────────────────────────────────────────────────────────────────
   The repository must be self-contained.
   ─────────────────────────────────────────────────────────────────────────── */

// Every suite resolves its material with `new URL('...', import.meta.url)`.
// A reference that climbs out of the repository resolves to a file that only
// exists on the machine that wrote it — the suite then dies with ENOENT on a
// fresh checkout, which is how the material outside the repository was found
// the second time. Anything outside is refused here, and the material that
// used to live outside now lives in tools/fixtures/.
{
  // ★ Without the trailing slash: `new URL('..', …)` keeps one, and then
  //   `repoRoot + '/'` would be a double slash that nothing starts with.
  const offenders = []
  for (const name of readdirSync(join(repoRoot, 'tools')).filter((n) => n.endsWith('.mjs'))) {
    const text = readFileSync(join(repoRoot, 'tools', name), 'utf8')
    const pattern = /new URL\(\s*'([^']+)'\s*,\s*import\.meta\.url\s*\)/g
    let match = pattern.exec(text)
    while (match !== null) {
      const reference = match[1]
      if (reference.startsWith('..')) {
        // ★ The reference is resolved against the SUITE that writes it, not
        //   against this file: every suite sits in tools/, so the depth is the
        //   same, but the file name is not.
        const resolved = fileURLToPath(new URL(reference, pathToFileURL(join(repoRoot, 'tools', name))))
        if (resolved !== repoRoot && !resolved.startsWith(repoRoot + '/')) {
          offenders.push(name + ' → ' + reference)
        }
      }
      match = pattern.exec(text)
    }
  }
  print(verdict('no suite reaches outside the repository for its material',
    offenders.length === 0,
    offenders.length === 0 ? 'checked tools/*.mjs' : offenders.join(' | ')))
}

/* ───────────────────────────────────────────────────────────────────────────
   The plugin ships the skill that tells an agent how to install it.
   ─────────────────────────────────────────────────────────────────────────── */

// A user who has an agent should not need a manual: the package carries a
// skill, and the Host picks skills up from an installed plugin package by
// convention (`skills/<name>/SKILL.md` — no manifest field). If the skill
// falls out of `files`, the agent loses the one thing this plugin can teach
// it to do.
{
  const skillPath = 'skills/dsh-appearance-media-install/SKILL.md'
  const skill = join(repoRoot, skillPath)
  const exists = existsSync(skill)
  print(verdict('the package carries the install skill',
    exists && readdirSync(join(repoRoot, 'skills')).length > 0,
    exists ? skillPath : 'not found: ' + skillPath))

  let front = { name: null, description: null }
  if (exists) {
    const text = readFileSync(skill, 'utf8')
    const name = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    if (name !== null) {
      front.name = /^name:\s*(.+)$/m.exec(name[1])
      front.description = /^description:\s*(.+)$/m.exec(name[1])
    }
  }
  print(verdict('the install skill declares a name and a description',
    front.name !== null && front.description !== null,
    'name=' + (front.name ? front.name[1].trim() : 'missing')
    + ' description=' + (front.description ? 'present' : 'missing')))
}

/* ───────────────────────────────────────────────────────────────────────────
   The catalog entry the official list will accept.
   ─────────────────────────────────────────────────────────────────────────── */

// The official catalog's rules, read from its contributing.md:
//   - the entry is ONE file, data/plugins/<owner>__<repo>.yml;
//   - `icon:` must be a GitHub-hosted RASTER image (png/jpg/jpeg/webp) —
//     "SVG 与第三方图床会被拒绝";
//   - the repository must declare dsh.bundle, be at least a day old, and
//     carry the dsh-plugin topic.
// A submission that breaks one of these is turned down by their CI, so the
// rules are checked here first.
{
  const entryPath = join(repoRoot, '.catalog', 'harveyzhang__dsh-appearance-media.yml')
  const entry = existsSync(entryPath) ? readFileSync(entryPath, 'utf8') : ''
  const icon = /^icon:\s*(\S+)$/m.exec(entry)
  const iconUrl = icon ? icon[1] : ''
  print(verdict('the catalog entry declares a raster storefront tile',
    /\.(png|jpe?g|webp)$/i.test(iconUrl),
    iconUrl === '' ? 'no icon declared' : iconUrl))
  print(verdict('the catalog entry points at this repository',
    entry.indexOf('https://github.com/harveyzhang/dsh-appearance-media') >= 0,
    'url: ' + (/^url:\s*(\S+)$/m.exec(entry) || [null, 'missing'])[1]))
  const tile = join(repoRoot, 'icon-180.png')
  print(verdict('the storefront tile is in the repository',
    existsSync(tile), existsSync(tile) ? 'icon-180.png' : 'not found: icon-180.png'))
}

/* ───────────────────────────────────────────────────────────────────────────
   The release gate exists and can run.
   ─────────────────────────────────────────────────────────────────────────── */

// "Done" for this project is one command: `node tools/verify-release.mjs`.
// If that file is missing, broken, or no longer knows what to run, the word
// "done" means nothing — so the gate itself is asserted here.
//
// ★ WHY `--list` AND NOT A REAL RUN.
//
//   The gate runs THIS suite as a subprocess. A suite that ran the gate for
//   real would re-enter this very suite, and the two would call each other
//   until the machine ran out of patience. `--list` prints the plan and
//   exits: it proves the file parses, that it starts, and that it still
//   knows every suite — without running a single check twice.
//
// ★ The suite list is read from `tools/`, not hard-coded here, so a new
//   suite that the gate does not know about turns this red.

{
  const gatePath = join(repoRoot, 'tools', 'verify-release.mjs')
  const gateExists = existsSync(gatePath)
  print(verdict('the release gate exists',
    gateExists,
    gateExists ? 'tools/verify-release.mjs' : 'not found: tools/verify-release.mjs'))

  /**
   * Run node and capture the result without throwing.
   *
   * @param {string[]} args - the arguments.
   * @returns {{ status: number, stdout: string, stderr: string }} the result.
   */
  const runNode = (args) => {
    try {
      const stdout = execFileSync(process.execPath, args, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60000,
      })
      return { status: 0, stdout, stderr: '' }
    } catch (error) {
      return {
        status: typeof error.status === 'number' ? error.status : 1,
        stdout: error.stdout === undefined ? '' : String(error.stdout),
        stderr: error.stderr === undefined ? String(error.message) : String(error.stderr),
      }
    }
  }

  let parses = false
  let parseDetail = ''
  if (gateExists) {
    const syntax = runNode(['--check', gatePath])
    parses = syntax.status === 0
    parseDetail = parses
      ? 'node --check 通过'
      : 'node --check 退出码 ' + String(syntax.status) + '：\n' + (syntax.stderr + syntax.stdout).trim()
  }
  print(verdict('the release gate parses as JavaScript',
    parses,
    gateExists ? parseDetail : '闸门文件不在，没法检查'))

  let answers = false
  let answerDetail = ''
  let knownSuites = []
  if (gateExists && parses) {
    const listing = runNode([gatePath, '--list'])
    answers = listing.status === 0
    const suites = readdirSync(join(repoRoot, 'tools'))
      .filter((name) => name.startsWith('verify-') && name.endsWith('.mjs') && name !== 'verify-release.mjs')
      .sort()
    knownSuites = suites.filter((name) => !listing.stdout.includes(name))
    answers = answers && knownSuites.length === 0
    answerDetail = answers
      ? 'node tools/verify-release.mjs --list 正常退出，并且列出了 tools/ 里的每一套断言'
      : listing.status !== 0
        ? '--list 退出码 ' + String(listing.status) + '：\n' + (listing.stdout + listing.stderr).trim()
        : '闸门不知道这几套断言：' + knownSuites.join(', ')
  }
  print(verdict('the release gate runs and knows every assertion suite',
    answers,
    gateExists ? answerDetail : '闸门文件不在，没法检查'))
}

/* ───────────────────────────────────────────────────────────────────────────
   The documentation checker.

   The documents make claims about the world — "published to npm", "listed in
   the marketplace", "this path exists". This repository has a checker that
   turns those claims into assertions and asks the world. It has to exist AND
   it has to REPORT something: a checker that runs and asserts nothing looks
   green, and a green that says nothing is worse than no checker at all.
   ─────────────────────────────────────────────────────────────────────────── */

if (process.env.DSH_SKIP_DOCS_CHECKER === '1') {
  // The caller is the documentation checker itself: it runs this file, so
  // running it again would be a loop. Skipped, not passed.
  console.log('SKIP  the documentation checker was not run — the caller is the documentation checker (no loop)')
} else {
  const docsChecker = join(repoRoot, 'tools', 'verify-docs.mjs')
  const docsCheckerExists = existsSync(docsChecker)
  let docsStatus = 1
  let docsAssertions = 0
  let docsDetail = 'not found: tools/verify-docs.mjs'
  if (docsCheckerExists) {
    let stdout = ''
    try {
      stdout = execFileSync(process.execPath, [docsChecker], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 600000,
      })
      docsStatus = 0
    } catch (error) {
      stdout = error.stdout === undefined ? '' : String(error.stdout)
      docsStatus = typeof error.status === 'number' ? error.status : 1
    }
    const summary = /(\d+)\s+check\(s\)/.exec(stdout)
    docsAssertions = summary === null ? 0 : Number(summary[1])
    // Exit 1 means the checker found a document that disagrees with the
    // world. That is a FINDING, not a broken checker: what matters here is
    // that it ran and that it asserted something.
    docsDetail = 'exit ' + String(docsStatus) + ', ' + String(docsAssertions) + ' assertion(s) reported'
  }
  print(verdict('the documentation checker exists and reports its assertions',
    docsCheckerExists && docsAssertions > 0,
    docsDetail))
}

console.log('')
const failed = checks.filter((check) => check.ok === false)
console.log(String(checks.length) + ' check(s), ' + String(failed.length) + ' failed')
if (failed.length > 0) {
  console.log('')
  for (const check of failed) console.log('failed: ' + check.label + (check.detail === '' ? '' : '  — ' + check.detail))
  process.exit(1)
}
