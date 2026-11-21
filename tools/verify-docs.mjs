#!/usr/bin/env node
// dsh-appearance-media — documentation-facts assertions.
//
// ★ WHAT THIS IS.
//
// A README is a promise. This file turns the promises the documents make into
// executable assertions: every statement of FACT a document states about the
// world is parsed out of the document, and then the world is asked whether it
// agrees. The three incidents that produced this file were all the same
// failure — a sentence was written down and NOTHING checked whether it was
// true:
//
//   1. The README used to imply that publishing to npm puts the plugin in the
//      plugin marketplace. False: the marketplace reads a FIXED index file
//      (awesome-dsh-plugin.com/plugins.json), generated from the official list
//      repository. It never searches npm.
//   2. The install skill used to say the package "is published to npm". False:
//      the registry answers 404, so an agent that believed the skill got a 404
//      instead of a plugin.
//   3. The catalog entry pointed its `icon:` at icon.svg. The official catalog
//      rejects SVG: the storefront tile has to be a raster image.
//
// ★ WHY THE EXPECTATION COMES FROM THE DOCUMENT.
//
// The expected value is never hardcoded here. If the README says "this plugin
// has NOT been published to npm yet", the checker expects the npm registry to
// answer 404. If the README is later rewritten to say "published", the checker
// starts expecting a version number instead. A checker with hardcoded facts
// goes stale the moment the documentation changes; this one follows it.
//
// ★ NETWORK FAILURES ARE SKIPS, NOT FAILURES.
//
// The network flakens. A link that cannot be reached is reported as SKIP with
// the reason, never as a red. `--offline` skips every network assertion and
// says which ones it skipped.
//
// ★ EVERY ASSERTION MUST BE ABLE TO GO RED.
//
// `--negative` runs the rules again against a DELIBERATELY BROKEN COPY of the
// documents in a temporary directory. The broken copy MUST be reported as
// broken. A rule that cannot fail is not a rule. The copies are throwaway:
// the real files are never touched.
//
// Usage:
//   node tools/verify-docs.mjs              the assertions
//   node tools/verify-docs.mjs --negative   the assertions + their reverse controls
//   node tools/verify-docs.mjs --offline    skip every network assertion
//   node tools/verify-docs.mjs --docs-root=DIR   check a copy of the tree in DIR

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/* ─────────────────────────────────────────────────────────────────────────────
   Roots and constants. All of them live at MODULE level on purpose: a constant
   declared inside a block is not visible to the functions that need it, and
   this repository has been bitten by exactly that before.
   ───────────────────────────────────────────────────────────────────────────── */

// The plugin repository: <workspace>/DSH插件开发/插件源码/dsh-appearance-media
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/+$/, '')

// The workspace: <workspace>/DSH插件开发/插件源码/dsh-appearance-media/tools
//   '..'      → the plugin repository
//   '../..'   → 插件源码
//   '../../..' → DSH插件开发
//   '../../../..' → the workspace root
//
// ★ The workspace root is computed with dirname() instead of with a second
// URL reference that climbs out of the repository. The packaging checker
// refuses a suite that reaches outside the repository with such a reference —
// that rule is about MATERIAL, and this file needs the workspace only to
// resolve the `DSH插件开发/…` paths the documents quote. Walking the tree by
// hand keeps that rule intact and keeps this checker inside it.
const WORKSPACE_ROOT = dirname(dirname(dirname(REPO_ROOT)))

/** The documents that are checked, and where they live inside the repository. */
const DOC_FILES = {
  readme: 'README.md',
  detail: 'docs/DETAIL.md',
  skill: 'skills/dsh-appearance-media-install/SKILL.md',
  notices: 'THIRD_PARTY_NOTICES.md',
  catalog: '.catalog/harveyzhang__dsh-appearance-media.yml',
}

/**
 * ★ THE PATH RULE — what counts as "a path into this repository".
 *
 * A token in a document is treated as a repository path candidate when ALL of
 * the following hold. The rule is deliberately strict: a wrong guess produces
 * a red that is not about the documentation, and a document check that cries
 * wolf is worse than no document check at all.
 *
 *   (1) the token contains no whitespace and none of  < > * ? … ~ : $ % \ " '
 *       (placeholders, globs, home paths, URLs and shell variables are not
 *        paths into this repository);
 *   (2) the token is not part of a URL (URLs are removed from the text before
 *       the scan);
 *   (3) the token's first segment is one of
 *         - a top-level directory of THIS repository:
 *           src lib tools skills docs assets locale .catalog
 *         - a top-level directory of the WORKSPACE: DSH插件开发
 *       (a single-segment token has no first segment, so it is only accepted
 *        when it names a file at the repository root — see (5));
 *   (4) every segment contains at least one alphanumeric character and ends
 *       with one, so "tools/verify-" (a glob cut in half) is not a path;
 *   (5) a single-segment token must carry a known file extension
 *       (md mjs js json yml yaml py sh svg png jpg jpeg webp gif mp4 webm ogv
 *       mov txt) or be one of the extensionless root files (LICENSE);
 *   (6) the token is not a SUFFIX of a slash-prefixed path elsewhere in the
 *       same document, which is how route names ("/appearance-media/
 *       catalog.json" ⇒ "catalog.json") are kept from being mistaken for
 *       repository files;
 *   (7) the token is not in PATH_EXEMPT — a short, explicit list of paths the
 *       documents attribute to ANOTHER project.
 */
const PATH_REPO_ROOTS = new Set(['src', 'lib', 'tools', 'skills', 'docs', 'assets', 'locale', '.catalog'])
const PATH_WORKSPACE_ROOTS = new Set(['DSH插件开发'])
const PATH_KNOWN_EXTENSIONS = new Set([
  'md', 'mjs', 'js', 'json', 'yml', 'yaml', 'py', 'sh',
  'svg', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm', 'ogv', 'mov', 'txt',
])
const PATH_EXTENSIONLESS_ROOT_FILES = new Set(['LICENSE'])

/**
 * Paths the documents mention that belong to ANOTHER repository and must not
 * be looked for here. Each entry names its owner.
 */
const PATH_EXEMPT = new Map([
  ['assets/videos', "dsh-boot-animation's media directory (THIRD_PARTY_NOTICES.md)"],
  ['assets/screensaver', "dsh-boot-animation's media directory (THIRD_PARTY_NOTICES.md)"],
  ['src/remux.js', "dsh-boot-animation's file — this package's port lives in lib/remux.js"],
])

/** A single-segment token: NAME.EXT, ASCII only, extension from the known list. */
const PATH_SINGLE_RE = /(?<![\w\u4e00-\u9fff])[A-Za-z0-9._-]*[A-Za-z0-9_]\.(?:md|mjs|js|json|yml|yaml|py|sh|svg|png|jpe?g|webp|gif|mp4|webm|ogv|mov|txt)\b/g

/** A multi-segment token: SEG/SEG/... */
const PATH_MULTI_RE = /(?<![\w\u4e00-\u9fff-])[A-Za-z0-9._\u4e00-\u9fff-]+(?:\/[A-Za-z0-9._\u4e00-\u9fff-]+)+/g

/** A slash-prefixed path, used to recognise route names. */
const PATH_SLASHED_RE = /\/[A-Za-z0-9._\u4e00-\u9fff-]+(?:\/[A-Za-z0-9._\u4e00-\u9fff-]+)*/g

/** A URL. */
const URL_RE = /https?:\/\/[^\s)<>"'`]+/g

/** Fenced code block. */
const FENCE_RE = /```([A-Za-z0-9_+-]*)\r?\n([\s\S]*?)```/g

/**
 * ★ THE STATE-CLAIM RULES.
 *
 * A "state claim" is a sentence about the present state of the world. These
 * are the sentences that expire. Each rule pairs a PATTERN with the state the
 * document asserts, and the checker then asks the world whether that state is
 * the one that holds.
 */
const NPM_NEGATIVE_RE = /(还没发到\s*npm|尚未发布|没发到\s*npm|还没发|没发\s*npm|registry 上查不到|查不到这个包|npm registry 上查不到|用包名会\s*404)/
const NPM_POSITIVE_RE = /(已发布到\s*npm|已经发布到\s*npm|已发到\s*npm|published to npm|npm 上有)/

const CATALOG_NEGATIVE_RE = /(市场里还没有|还没有被收录|还没被收录|还没有收录|还没收录|没有被收录|尚未收录|搜不到|点不了安装)/
const CATALOG_POSITIVE_RE = /(已收录|已经被收录|已被收录|已经收录)/

/**
 * A line that mentions a state in the CONDITIONAL or the FUTURE is not a claim
 * about the present ("将来发到 npm 之后，换成包名即可" says nothing about
 * today). Such lines are ignored.
 */
const FUTURE_MARKER_RE = /(将来|等它|之后才|就能|就会|一旦|才能|什么时候|假如|如果发布|发布之后)/

/** Extensions that count as "material" for the plugin's own media vocabulary. */
const MEDIA_VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogv', 'mov', 'm4v', 'mkv', 'avi'])
const MEDIA_AUDIO_EXTENSIONS = new Set(['wav', 'mp3', 'aac', 'flac', 'ogg', 'm4a'])

/** The trademark sentence, character for character. This one must be exact. */
const TRADEMARK_SENTENCE = 'DeepSeek Harness、DSH 与 Cordis 是各自所有者的商标。本插件是独立项目，与它们无关，也没有得到它们的背书。'

/** The section heading that tells the reader how to add more material. */
const HOWTO_HEADING_RE = /^#{2,6}\s*怎么加更多素材\s*$/

/* ─────────────────────────────────────────────────────────────────────────────
   Verdict plumbing. The repository's other checkers use verdict() + print();
   this file uses the same API, with one addition: an optional stable id, so a
   reverse control can point at exactly the assertion it broke.
   ───────────────────────────────────────────────────────────────────────────── */

const checks = []
const skips = []

/** While the reverse controls run, the skips are counted but not printed. */
let quietSkips = false

/**
 * Build one assertion's verdict.
 *
 * @param {string} label - what the assertion says.
 * @param {boolean} ok - whether it held.
 * @param {string} detail - what the evidence was.
 * @param {string} [id] - a stable identifier, used by the reverse controls.
 * @returns {{ label: string, ok: boolean, detail: string, id: string }} the verdict.
 */
function verdict(label, ok, detail, id) {
  return { label, ok, detail: detail === undefined ? '' : detail, id: id === undefined ? label : id }
}

/**
 * Print one verdict.
 *
 * @param {{ label: string, ok: boolean, detail: string, id: string }} check - the verdict.
 * @returns {boolean} the verdict's boolean.
 */
function print(check) {
  checks.push(check)
  console.log((check.ok ? 'PASS  ' : 'FAIL  ') + check.label
    + (check.detail === '' ? '' : '  — ' + check.detail))
  return check.ok
}

/**
 * Record a skip: something that COULD NOT be asserted (the network is down, the
 * command is not safe to run). A skip is never a failure and never a pass.
 *
 * @param {string} label - what was not asserted.
 * @param {string} reason - why.
 * @returns {void}
 */
function skip(label, reason) {
  skips.push({ label, reason })
  if (!quietSkips) console.log('SKIP  ' + label + '  — ' + reason)
}

/* ─────────────────────────────────────────────────────────────────────────────
   Small helpers.
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Format an instant as UTC+8 wall-clock time. The documents quote UTC+8
 * explicitly, and the host runs in a different zone, so every comparison is
 * done in a fixed +08:00 offset rather than the machine's local time.
 *
 * @param {number|Date} when - the instant.
 * @returns {string} 'YYYY-MM-DD HH:MM:SS' in UTC+8.
 */
function utc8(when) {
  const ms = when instanceof Date ? when.getTime() : when
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * Every fenced code block in a document.
 *
 * @param {string} text - the document.
 * @returns {{ lang: string, body: string }[]} the blocks.
 */
function codeBlocks(text) {
  const blocks = []
  FENCE_RE.lastIndex = 0
  let match = FENCE_RE.exec(text)
  while (match !== null) {
    blocks.push({ lang: match[1].toLowerCase(), body: match[2] })
    match = FENCE_RE.exec(text)
  }
  return blocks
}

/**
 * Split a code block into commands.
 *
 * A new command starts at a line that begins with a command word. A line
 * inside an open quote (the `node -e '…'` blocks) and the body of a `for`
 * loop belong to the command above them.
 *
 * @param {string} body - a code block.
 * @returns {string[]} the commands.
 */
function commandsOf(body) {
  const result = []
  let current = []
  let quote = null
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (line === '') {
      if (current.length > 0) { result.push(current.join(' ')); current = [] }
      quote = null
      continue
    }
    const startsNew = quote === null
      && /^(node|python3?|npm|pnpm|dsh|curl|wget|mkdir|cp|rm|ls|cd|for|git|sh|bash|pip3?)\b/.test(line)
      && !(current.length > 0 && /\bfor\b/.test(current[0]))
      && !(current.length > 0 && /(\\|\|\||&&|\|)\s*$/.test(current[current.length - 1]))
    if (startsNew && current.length > 0) { result.push(current.join(' ')); current = [] }
    current.push(line)
    for (const ch of line) {
      if (quote === null) { if (ch === "'" || ch === '"') quote = ch }
      else if (ch === quote) quote = null
    }
  }
  if (current.length > 0) result.push(current.join(' '))
  return result
}

/**
 * Split a shell command line into argv, honouring single and double quotes.
 *
 * @param {string} line - the command line.
 * @returns {string[]} the argv.
 */
function tokenize(line) {
  const out = []
  let current = ''
  let quote = null
  let started = false
  for (const ch of line) {
    if (quote !== null) {
      if (ch === quote) { quote = null; continue }
      current += ch
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; continue }
    if (/\s/.test(ch)) {
      if (started) { out.push(current); current = ''; started = false }
      continue
    }
    current += ch
    started = true
  }
  if (started) out.push(current)
  return out
}

/**
 * A marker that says "the file this token names belongs to ANOTHER project".
 * It is only honoured for single-segment tokens: a multi-segment token that
 * starts with one of this repository's own roots is always ours.
 */
const FOREIGN_PROJECT_MARKER_RE = /(原项目|上游|upstream|官方|official)/i

/**
 * Extensions that make a single-segment token an EXAMPLE file name rather than
 * a repository file ("clip.mp4" in a curl example, "屏保3.mp4" in a sentence).
 */
const EXAMPLE_FILE_EXTENSIONS = new Set([
  'mp4', 'webm', 'ogv', 'mov', 'm4v', 'mkv', 'avi',
  'jpg', 'jpeg', 'png', 'webp', 'gif',
  'mp3', 'wav', 'aac', 'flac', 'm4a', 'ogg',
])

/**
 * Every URL in a document.
 *
 * @param {string} text - the document.
 * @returns {string[]} the URLs, without trailing punctuation.
 */
function urlsOf(text) {
  const found = new Set()
  const withoutCode = text.replace(/```[\s\S]*?```/g, ' ')
  URL_RE.lastIndex = 0
  let match = URL_RE.exec(withoutCode)
  while (match !== null) {
    const url = match[0].replace(/[.,;:)\]]+$/, '')
    found.add(url)
    match = URL_RE.exec(withoutCode)
  }
  return [...found]
}

/**
 * Whether a path segment is a segment at all: it has to carry an alphanumeric
 * character and end with one, so "tools/verify-" (a glob cut in half) is not
 * a path.
 *
 * @param {string} segment - the segment.
 * @returns {boolean} whether it qualifies.
 */
function isSegment(segment) {
  if (segment.length === 0) return false
  if (!/[A-Za-z0-9_\u4e00-\u9fff]/.test(segment)) return false
  if (!/[A-Za-z0-9_\u4e00-\u9fff]$/.test(segment)) return false
  return true
}

/**
 * The repository path candidates in a document, with the rule from the top of
 * this file applied.
 *
 * @param {string} text - the document.
 * @param {string} docKey - which document this is, for the report.
 * @returns {{ path: string, scope: string, doc: string, line: number }[]} the candidates.
 */
function pathCandidates(text, docKey) {
  const found = new Map()
  const lines = text.split('\n')

  // Suffixes of slash-prefixed paths (route names) and of multi-segment paths
  // are never standalone repository files. This is collected over the WHOLE
  // document: a route may be named on one line and its bare file name on
  // another.
  const notAFileName = new Set()

  for (const line of lines) {
    const scanned = line.replace(URL_RE, ' ')
    PATH_SLASHED_RE.lastIndex = 0
    let slashed = PATH_SLASHED_RE.exec(scanned)
    while (slashed !== null) {
      const parts = slashed[0].split('/').filter((part) => part !== '')
      for (let part = 0; part < parts.length; part += 1) {
        notAFileName.add(parts.slice(part).join('/'))
      }
      slashed = PATH_SLASHED_RE.exec(scanned)
    }
    PATH_MULTI_RE.lastIndex = 0
    let multi = PATH_MULTI_RE.exec(scanned)
    while (multi !== null) {
      const parts = multi[0].split('/')
      for (let part = 1; part < parts.length; part += 1) {
        notAFileName.add(parts.slice(part).join('/'))
      }
      multi = PATH_MULTI_RE.exec(scanned)
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const scanned = lines[index].replace(URL_RE, ' ')

    PATH_MULTI_RE.lastIndex = 0
    let multi = PATH_MULTI_RE.exec(scanned)
    while (multi !== null) {
      const raw = multi[0]
      const parts = raw.split('/')
      if (parts.every((segment) => isSegment(segment)) && !PATH_EXEMPT.has(raw)) {
        const head = parts[0]
        if (PATH_REPO_ROOTS.has(head)) {
          if (!found.has(raw)) found.set(raw, { path: raw, scope: 'repo', doc: docKey, line: index + 1 })
        } else if (PATH_WORKSPACE_ROOTS.has(head)) {
          if (!found.has(raw)) found.set(raw, { path: raw, scope: 'workspace', doc: docKey, line: index + 1 })
        }
      }
      multi = PATH_MULTI_RE.exec(scanned)
    }

    PATH_SINGLE_RE.lastIndex = 0
    let single = PATH_SINGLE_RE.exec(scanned)
    while (single !== null) {
      const raw = single[0]
      if (!found.has(raw) && !notAFileName.has(raw) && !PATH_EXEMPT.has(raw)) {
        const dot = raw.lastIndexOf('.')
        const extension = dot > 0 ? raw.slice(dot + 1).toLowerCase() : ''
        const isExtensionlessRootFile = PATH_EXTENSIONLESS_ROOT_FILES.has(raw)
        const isKnownExtension = PATH_KNOWN_EXTENSIONS.has(extension)
        const isExampleName = EXAMPLE_FILE_EXTENSIONS.has(extension)
        const belongsToAnotherProject = FOREIGN_PROJECT_MARKER_RE.test(lines[index])
        if ((isKnownExtension && !isExampleName) || isExtensionlessRootFile) {
          if (!belongsToAnotherProject) {
            found.set(raw, { path: raw, scope: 'repo', doc: docKey, line: index + 1 })
          }
        }
      }
      single = PATH_SINGLE_RE.exec(scanned)
    }
  }

  return [...found.values()]
}

/* ─────────────────────────────────────────────────────────────────────────────
   The network probe. curl is used because it distinguishes "the server said
   404" from "the connection died", and that distinction is the whole point:
   a 404 is an answer, a dead socket is not.
   ───────────────────────────────────────────────────────────────────────────── */

const netCache = new Map()

/**
 * Ask a URL for its status code.
 *
 * @param {string} url - the URL.
 * @param {{ timeoutMs?: number, offline?: boolean }} [options] - probe options.
 * @returns {{ ok: boolean, status: number, reason: string }} the answer.
 */
function probe(url, options) {
  const settings = options === undefined ? {} : options
  const timeoutMs = settings.timeoutMs === undefined ? 25000 : settings.timeoutMs
  if (settings.offline === true) return { ok: false, status: 0, reason: 'offline mode' }
  const key = url + '|' + String(timeoutMs)
  if (netCache.has(key)) return netCache.get(key)
  const run = spawnSync('curl', [
    '-sSL',
    '--max-time', String(Math.ceil(timeoutMs / 1000)),
    '--retry', '2',
    '--retry-delay', '1',
    '--retry-all-errors',
    '-r', '0-4096',
    '-o', '/dev/null',
    '-w', '%{http_code}',
    url,
  ], { encoding: 'utf8', timeout: timeoutMs + 5000 })
  const raw = (run.stdout === null || run.stdout === undefined) ? '' : run.stdout.trim()
  const status = Number.parseInt(raw, 10)
  let answer
  if (run.error !== undefined && run.error !== null) {
    answer = { ok: false, status: 0, reason: String(run.error.message) }
  } else if (!Number.isFinite(status) || status === 0) {
    answer = { ok: false, status: 0, reason: 'no HTTP answer (' + (run.stderr || '').trim() + ')' }
  } else {
    answer = { ok: true, status, reason: '' }
  }
  netCache.set(key, answer)
  return answer
}

/* ─────────────────────────────────────────────────────────────────────────────
   The context: which tree is being checked, and which documents are in it.
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Build a checking context.
 *
 * @param {{ repoRoot: string, workspaceRoot: string, offline: boolean, gitRoot?: string }} options - the context.
 * @returns {object} the context.
 */
function makeContext(options) {
  const docs = {}
  const missing = []
  for (const [key, relativePath] of Object.entries(DOC_FILES)) {
    const full = join(options.repoRoot, relativePath)
    if (existsSync(full)) docs[key] = readFileSync(full, 'utf8')
    else { docs[key] = ''; missing.push(relativePath) }
  }
  return {
    repoRoot: options.repoRoot,
    workspaceRoot: options.workspaceRoot,
    offline: options.offline,
    // The git history is a fact about the REPOSITORY, not about a copy of it:
    // a reverse control copies the working tree without .git, and the commit
    // dates it checks are the ones of the repository the copy came from.
    gitRoot: options.gitRoot === undefined ? options.repoRoot : options.gitRoot,
    docs,
    missingDocs: missing,
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   Section A — the paths the documents name must exist.
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Assert that every repository path the documents name really exists.
 *
 * @param {object} ctx - the checking context.
 * @returns {object[]} the verdicts.
 */
function checkPaths(ctx) {
  const verdicts = []
  const seen = new Set()
  for (const [key, text] of Object.entries(ctx.docs)) {
    if (text === '') continue
    for (const candidate of pathCandidates(text, key)) {
      if (seen.has(candidate.path)) continue
      seen.add(candidate.path)
      const base = candidate.scope === 'workspace' ? ctx.workspaceRoot : ctx.repoRoot
      const full = join(base, candidate.path)
      const exists = existsSync(full)
      verdicts.push(verdict(
        'the documents name a path that exists: ' + candidate.path,
        exists,
        exists ? '' : 'not found: ' + full + ' (named in ' + DOC_FILES[candidate.doc] + ':' + String(candidate.line) + ')',
        'path:' + candidate.path))
    }
  }
  return verdicts
}

/* ─────────────────────────────────────────────────────────────────────────────
   Section B — the state the documents claim must be the state of the world.
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * The package name, read from the manifest.
 *
 * @param {object} ctx - the checking context.
 * @returns {string} the package name.
 */
function packageName(ctx) {
  const manifestPath = join(ctx.repoRoot, 'package.json')
  if (!existsSync(manifestPath)) return 'dsh-appearance-media'
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    return typeof manifest.name === 'string' ? manifest.name : 'dsh-appearance-media'
  } catch {
    return 'dsh-appearance-media'
  }
}

/**
 * The official list repository the documents name, e.g.
 * "awesome-dsh-plugin/awesome-dsh-plugin".
 *
 * @param {object} ctx - the checking context.
 * @returns {string} the repository, or '' when the documents no longer name one.
 */
function listRepository(ctx) {
  const readme = ctx.docs.readme
  const matches = [...readme.matchAll(/\[`?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)`?\]\(https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\)/g)]
  for (const match of matches) {
    const repo = match[2]
    if (match[1] === repo && /awesome|catalog|market|list/i.test(repo)) return repo
  }
  return ''
}

/**
 * The npm state claims in the documents.
 *
 * @param {object} ctx - the checking context.
 * @returns {{ kind: string, doc: string, line: number, text: string }[]} the claims.
 */
function npmClaims(ctx) {
  const claims = []
  for (const [key, text] of Object.entries(ctx.docs)) {
    if (text === '') continue
    text.split('\n').forEach((raw, index) => {
      const line = raw.trim()
      if (line === '') return
      if (FUTURE_MARKER_RE.test(line)) return
      // ★ Both kinds are collected from one line: a line that says "listed"
      //   and "not listed" at once is a contradiction, and it must not be
      //   masked by whichever pattern happens to be tested first.
      if (NPM_NEGATIVE_RE.test(line)) claims.push({ kind: 'absent', doc: key, line: index + 1, text: line })
      if (NPM_POSITIVE_RE.test(line)) claims.push({ kind: 'present', doc: key, line: index + 1, text: line })
    })
  }
  return claims
}

/**
 * The marketplace-listing claims in the documents.
 *
 * @param {object} ctx - the checking context.
 * @returns {{ kind: string, doc: string, line: number, text: string }[]} the claims.
 */
function catalogClaims(ctx) {
  const claims = []
  for (const [key, text] of Object.entries(ctx.docs)) {
    if (text === '') continue
    text.split('\n').forEach((raw, index) => {
      const line = raw.trim()
      if (line === '') return
      if (FUTURE_MARKER_RE.test(line)) return
      if (CATALOG_NEGATIVE_RE.test(line)) claims.push({ kind: 'absent', doc: key, line: index + 1, text: line })
      if (CATALOG_POSITIVE_RE.test(line)) claims.push({ kind: 'present', doc: key, line: index + 1, text: line })
    })
  }
  return claims
}

/**
 * Assert the state the documents claim about the world.
 *
 * @param {object} ctx - the checking context.
 * @returns {Promise<object[]>} the verdicts.
 */
async function checkState(ctx) {
  const verdicts = []

  // ── the npm registry ──────────────────────────────────────────────────────
  const claims = npmClaims(ctx)
  const kinds = new Set(claims.map((claim) => claim.kind))
  const pkg = packageName(ctx)
  const registryUrl = 'https://registry.npmjs.org/' + pkg

  if (claims.length === 0) {
    verdicts.push(verdict('the documents make no claim about the npm registry', false,
      'no npm state claim found — nothing to check against the registry', 'state:npm-claim-missing'))
  } else if (kinds.size > 1) {
    verdicts.push(verdict('the documents agree on whether the package is published', false,
      'the documents claim both "published" and "not published"', 'state:npm-contradiction'))
  } else {
    const expected = kinds.has('present') ? 'present' : 'absent'
    const answer = probe(registryUrl, { offline: ctx.offline })
    if (!answer.ok) {
      skip('the npm registry did not answer for ' + pkg, answer.reason)
    } else {
      const isPresent = answer.status === 200
      const ok = (expected === 'present') === isPresent
      verdicts.push(verdict(
        'the npm registry agrees with what the documents say about "' + pkg + '"',
        ok,
        'documents say "' + expected + '", registry says HTTP ' + answer.status
          + ' (' + claims.length + ' claim(s), e.g. ' + DOC_FILES[claims[0].doc] + ':' + String(claims[0].line) + ')',
        'state:npm'))
    }
  }

  // ── the official list ─────────────────────────────────────────────────────
  const catalog = catalogClaims(ctx)
  const catalogKinds = new Set(catalog.map((claim) => claim.kind))
  const repo = listRepository(ctx)
  if (repo === '') {
    verdicts.push(verdict('the documents still name the official plugin list repository', false,
      'no repository matching /awesome|catalog|market|list/ is linked from README.md', 'state:list-repo-missing'))
  } else if (catalog.length === 0) {
    verdicts.push(verdict('the documents make no claim about the plugin marketplace', false,
      'no marketplace state claim found — nothing to check against the official list', 'state:catalog-claim-missing'))
  } else if (catalogKinds.size > 1) {
    verdicts.push(verdict('the documents agree on whether the plugin is listed in the marketplace', false,
      'the documents claim both "listed" and "not listed"', 'state:catalog-contradiction'))
  } else {
    const expected = catalogKinds.has('present') ? 'listed' : 'not-listed'
    const entryName = /^name:\s*(\S+)$/m.exec(ctx.docs.catalog)
    const ownerRepo = entryName === null ? '' : entryName[1]
    const fileName = ownerRepo.replace('/', '__') + '.yml'
    const branches = ['main', 'master']
    let found = false
    let answered = false
    let reason = ''
    for (const branch of branches) {
      const url = 'https://raw.githubusercontent.com/' + repo + '/' + branch + '/data/plugins/' + fileName
      const answer = probe(url, { offline: ctx.offline })
      if (!answer.ok) { reason = answer.reason; continue }
      answered = true
      if (answer.status === 200) { found = true; break }
      if (answer.status !== 404) reason = 'HTTP ' + answer.status
    }
    if (!answered) {
      // No branch answered at all: the list is unreachable, which is a SKIP,
      // never a verdict about whether the plugin is listed.
      skip('the official list did not answer for ' + fileName, reason)
    } else {
      const ok = (expected === 'listed') === found
      verdicts.push(verdict(
        'the official list agrees with what the documents say about "' + ownerRepo + '"',
        ok,
        'documents say "' + expected + '", the list says ' + (found ? 'the entry EXISTS' : 'the entry is ABSENT (404)')
          + ' (' + catalog.length + ' claim(s), e.g. ' + DOC_FILES[catalog[0].doc] + ':' + String(catalog[0].line) + ')',
        'state:catalog'))
    }
  }

  // ── the catalog entry itself ──────────────────────────────────────────────
  const catalogText = ctx.docs.catalog
  const iconMatch = /^icon:\s*(\S+)$/m.exec(catalogText)
  const iconUrl = iconMatch === null ? '' : iconMatch[1]
  const raster = /\.(png|jpe?g|webp)$/i.test(iconUrl)
  verdicts.push(verdict('the catalog entry declares a raster storefront tile', raster,
    iconUrl === '' ? 'no icon declared' : iconUrl, 'state:icon-raster'))

  if (iconUrl !== '') {
    const answer = probe(iconUrl, { offline: ctx.offline })
    if (!answer.ok) {
      skip('the storefront tile could not be fetched', answer.reason + ' (' + iconUrl + ')')
    } else {
      verdicts.push(verdict('the storefront tile can actually be downloaded',
        answer.status === 200 || answer.status === 206,
        'HTTP ' + answer.status + ' for ' + iconUrl, 'state:icon-reachable'))
    }
  }

  const urlMatch = /^url:\s*(\S+)$/m.exec(catalogText)
  const entryUrl = urlMatch === null ? '' : urlMatch[1]
  const manifestPath = join(ctx.repoRoot, 'package.json')
  let homepage = ''
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      homepage = manifest.homepage === undefined ? '' : String(manifest.homepage)
    } catch { homepage = '' }
  }
  const pointsHere = homepage !== '' && entryUrl === homepage
  verdicts.push(verdict('the catalog entry points at this repository', pointsHere,
    'catalog url: ' + (entryUrl === '' ? 'missing' : entryUrl) + ' / manifest homepage: ' + (homepage === '' ? 'missing' : homepage),
    'state:catalog-url'))

  // ── assets/ ───────────────────────────────────────────────────────────────
  const assetsDir = join(ctx.repoRoot, 'assets')
  const assetFiles = existsSync(assetsDir)
    ? readdirSync(assetsDir).filter((name) => statSync(join(assetsDir, name)).isFile())
    : []
  const mediaFiles = assetFiles.filter((name) => {
    const dot = name.lastIndexOf('.')
    if (dot <= 0) return false
    const extension = name.slice(dot + 1).toLowerCase()
    return MEDIA_VIDEO_EXTENSIONS.has(extension) || MEDIA_AUDIO_EXTENSIONS.has(extension)
  })
  verdicts.push(verdict('assets/ carries no material (no video, no audio)', mediaFiles.length === 0,
    mediaFiles.length === 0 ? 'assets/: ' + (assetFiles.length === 0 ? 'empty' : assetFiles.join(', ')) : mediaFiles.join(', '),
    'state:assets-no-media'))

  // The documents' own claim about assets/: the expectation comes from the
  // wording, not from this file.
  const assetClaim = assetClaimOf(ctx)
  if (assetClaim.kind === 'none') {
    skip('the documents make no claim about the contents of assets/', 'nothing to check')
  } else {
    const expected = assetClaim.kind === 'empty' ? [] : assetClaim.files
    const actual = assetFiles.slice().sort()
    const wanted = expected.slice().sort()
    const same = actual.length === wanted.length && actual.every((name, index) => name === wanted[index])
    verdicts.push(verdict(
      'the documents describe assets/ the way it actually is',
      same,
      'documents say assets/ holds [' + wanted.join(', ') + '], the repository holds [' + actual.join(', ') + ']'
        + (assetClaim.where === '' ? '' : ' (' + assetClaim.where + ')'),
      'state:assets-claim'))
  }

  // ── the one-day rule of the official list ────────────────────────────────
  const age = checkRepositoryAge(ctx)
  if (age.verdicts.length > 0) verdicts.push(...age.verdicts)

  return verdicts
}

/**
 * What the documents say about the contents of assets/.
 *
 * @param {object} ctx - the checking context.
 * @returns {{ kind: string, files: string[], where: string }} the claim.
 */
function assetClaimOf(ctx) {
  for (const [key, text] of Object.entries(ctx.docs)) {
    if (text === '') continue
    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (!line.includes('`assets/`')) continue
      if (/(目录是空的|是空的|is empty)/.test(line)) {
        return { kind: 'empty', files: [], where: DOC_FILES[key] + ':' + String(index + 1) }
      }
      const only = /(只有|only)\s*([A-Za-z0-9._-]+)/.exec(line)
      if (only !== null && only.index !== undefined) {
        return { kind: 'only', files: [only[2]], where: DOC_FILES[key] + ':' + String(index + 1) }
      }
    }
  }
  return { kind: 'none', files: [], where: '' }
}

/**
 * The one-day rule the official list enforces, checked against the documents'
 * own statement about it.
 *
 * @param {object} ctx - the checking context.
 * @returns {{ verdicts: object[] }} the verdicts.
 */
function checkRepositoryAge(ctx) {
  const verdicts = []
  const readme = ctx.docs.readme
  const row = readme.split('\n').find((line) => line.includes('仓库建满 1 天'))
  if (row === undefined) {
    verdicts.push(verdict('the documents state the one-day rule of the official list', false,
      'no "仓库建满 1 天" row in README.md', 'state:age-claim-missing'))
    return { verdicts }
  }
  const dates = [...row.matchAll(/(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?/g)]
  if (dates.length < 2) {
    verdicts.push(verdict('the documents state when the one-day rule is passed', false,
      'the row does not carry two timestamps: ' + row.trim(), 'state:age-claim-unreadable'))
    return { verdicts }
  }
  const creation = dates[0][1]
  const gate = dates[1][1] + ' ' + dates[1][2]

  const git = spawnSync('git', ['log', '--reverse', '--format=%aI'], {
    cwd: ctx.gitRoot, encoding: 'utf8', timeout: 20000,
  })
  if (git.status !== 0 || git.stdout.trim() === '') {
    skip('the repository age could not be read from git', (git.stderr || '').trim())
    return { verdicts }
  }
  const firstCommit = git.stdout.trim().split('\n')[0]
  const firstUtc8 = utc8(new Date(firstCommit))
  const firstDay = firstUtc8.slice(0, 10)
  verdicts.push(verdict('the stated repository creation date matches the first commit (UTC+8)',
    creation === firstDay,
    'documents say ' + creation + ', first commit is ' + firstUtc8 + ' (UTC+8)', 'state:age-creation'))

  const creationMs = Date.parse(creation + 'T00:00:00Z')
  const gateMs = Date.parse(gate.replace(' ', 'T') + ':00+08:00')
  const firstMs = Date.parse(firstCommit)
  const gateIsSane = Number.isFinite(gateMs) && gateMs >= firstMs + 24 * 3600 * 1000
  verdicts.push(verdict('the stated gate is at least a day after the repository was created',
    gateIsSane,
    'gate ' + gate + ' (UTC+8), first commit ' + firstUtc8 + ' (UTC+8)', 'state:age-gate'))

  const stillPending = Date.now() < gateMs
  const wording = /要到|之后才过|才过/.test(row)
  verdicts.push(verdict('the statement that the one-day rule is still pending is still true',
    wording ? stillPending : true,
    'now ' + utc8(Date.now()) + ' (UTC+8), gate ' + gate + ' (UTC+8) — '
      + (wording ? (stillPending ? 'still pending' : 'THE GATE HAS PASSED, the wording is stale') : 'no future wording'),
    'state:age-pending'))
  return { verdicts }
}

/* ─────────────────────────────────────────────────────────────────────────────
   Section C — the commands the documents give must really run.
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * ★ THE SAFETY RULES.
 *
 * A command in a document is only executed when it cannot touch the user's
 * machine, the user's media library or the working tree. Everything else is
 * reported as "not verified", with the reason — a check that quietly does
 * nothing is worse than one that says so.
 */
const UNSAFE_COMMAND_RULES = [
  { re: /\bnpm\s+(publish|login|add|install|i|unpublish)\b/, reason: 'it touches the npm registry' },
  { re: /\bpnpm\s+(add|install|remove|update)\b/, reason: 'it installs packages' },
  { re: /\bpip3?\s+install\b/, reason: 'it installs packages' },
  { re: /\b(dsh|dsh-plugin)\s+plugin\b[^\n]*\badd\b/, reason: 'it installs a plugin into a profile' },
  { re: /plugin_manager\s*\(/, reason: 'it installs through the host' },
  { re: /\brm\s+-[a-zA-Z]*r/, reason: 'it deletes files' },
  { re: /\b(mkdir|cp|mv|chmod|chown|touch|tee)\b/, reason: 'it writes files' },
  { re: /(~\/\.dsh|\$HOME\/\.dsh|\/\.dsh\/|\/Users\/)/, reason: "it touches the user's DSH tree" },
  { re: /--apply\b/, reason: 'it imports material for real' },
  { re: /--(library|sources-log)\b/, reason: 'it points the importer at a real library or log' },
  { re: /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/, reason: 'it pipes a download into a shell' },
  { re: /\b(kill|pkill|killall|reboot|shutdown|osascript|defaults\s+write)\b/, reason: 'it touches the host' },
  { re: /negative-controls-task7\.mjs/, reason: 'it rewrites the source files in the working tree' },
  { re: /\bbuild-client\.mjs\b/, reason: 'it writes lib/client.js in the working tree (handled on a copy)' },
]

/** A command that cannot be run as written, because it has placeholders in it. */
const UNRUNNABLE_COMMAND_RE = /<[^>]*>|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\.\.\./

/**
 * The words that start a command. An inline code span is only treated as a
 * command when it starts with one of these — otherwise "`dsh-appearance-media`"
 * and "`skills/…/SKILL.md`" would be mistaken for things to run.
 */
const COMMAND_HEADS = new Set([
  'node', 'python3', 'python', 'npm', 'pnpm', 'dsh', 'curl', 'wget',
  'mkdir', 'cp', 'rm', 'ls', 'cd', 'for', 'git', 'sh', 'bash', 'pip3', 'pip',
])

/**
 * The commands the documents give: the ones in fenced blocks and the ones
 * written inline between backticks.
 *
 * @param {object} ctx - the checking context.
 * @returns {{ id: string, text: string, doc: string, argv: string[] }[]} the commands.
 */
function documentedCommands(ctx) {
  const commands = []
  const seen = new Set()
  const add = (text, key) => {
    const trimmed = text.trim()
    if (trimmed === '' || seen.has(trimmed)) return
    const argv = tokenize(trimmed)
    if (argv.length === 0) return
    if (!COMMAND_HEADS.has(argv[0])) return
    seen.add(trimmed)
    commands.push({ id: 'cmd:' + trimmed, text: trimmed, doc: key, argv })
  }
  for (const key of ['readme', 'skill', 'detail']) {
    const text = ctx.docs[key]
    if (text === '') continue
    for (const block of codeBlocks(text)) {
      if (!['bash', 'sh', 'shell', 'console', ''].includes(block.lang)) continue
      for (const command of commandsOf(block.body)) add(command, key)
    }
    // Inline commands: "`npm view dsh-appearance-media version`".
    const inline = /`([^`\n]+)`/g
    let match = inline.exec(text)
    while (match !== null) { add(match[1], key); match = inline.exec(text) }
  }
  return commands
}

/**
 * The material import tool the documents point at.
 *
 * @param {object} ctx - the checking context.
 * @returns {string} the path, relative to the workspace, or ''.
 */
function importToolPath(ctx) {
  for (const [key, text] of Object.entries(ctx.docs)) {
    if (text === '') continue
    for (const candidate of pathCandidates(text, key)) {
      if (candidate.scope === 'workspace' && /import-media-sources\.py$/.test(candidate.path)) {
        return candidate.path
      }
    }
  }
  return ''
}

/**
 * Assert that the commands the documents give can really run.
 *
 * @param {object} ctx - the checking context.
 * @returns {object[]} the verdicts.
 */
function checkCommands(ctx) {
  const verdicts = []
  const commands = documentedCommands(ctx)
  if (commands.length === 0) {
    verdicts.push(verdict('the documents contain runnable commands', false,
      'no shell command was found in README.md, SKILL.md or docs/DETAIL.md', 'cmd:none'))
    return verdicts
  }

  const npmExpectation = npmClaims(ctx).some((claim) => claim.kind === 'absent') ? 'absent' : 'present'

  for (const command of commands) {
    if (ctx.onlyCommands !== undefined && !ctx.onlyCommands.some((needle) => command.text.indexOf(needle) !== -1)) continue
    const argv = command.argv
    if (argv.length === 0) continue

    // The loop over the suites is expanded into the individual suite commands
    // that the same document lists; running the loop itself would only run
    // them twice.
    if (argv[0] === 'for' || /verify-\*\.mjs/.test(command.text) && /for /.test(command.text)) {
      skip('the "run every suite" loop', 'each suite it would run is executed on its own below')
      continue
    }

    // `npm view <pkg> version` — the document's own probe. What it must do
    // depends on what the document claims about the registry.
    const npmView = /^npm\s+view\s+(\S+)/.exec(command.text)
    if (npmView !== null) {
      if (ctx.offline) {
        skip('not checked: ' + command.text, 'it asks the registry, and this run is offline')
        continue
      }
      const run = spawnSync('npm', ['view', npmView[1], 'version'], {
        cwd: ctx.workspaceRoot, encoding: 'utf8', timeout: 60000,
      })
      const published = run.status === 0
      const ok = (npmExpectation === 'present') === published
      verdicts.push(verdict(
        'the documented registry probe agrees with the documents: ' + command.text,
        ok,
        'exit ' + String(run.status) + ' — the documents say the package is "' + npmExpectation + '", '
          + 'npm view says ' + (published ? 'published' : 'not published'),
        'cmd:' + command.id))
      continue
    }

    const reasons = UNSAFE_COMMAND_RULES
      .filter((rule) => rule.re.test(command.text))
      .map((rule) => rule.reason)
    if (UNRUNNABLE_COMMAND_RE.test(command.text)) reasons.push('it has placeholders in it')
    if (reasons.length > 0) {
      skip('not verified: ' + command.text, reasons.join('; '))
      continue
    }

    const cwd = /\bDSH插件开发\//.test(command.text) ? ctx.workspaceRoot : ctx.repoRoot
    const run = spawnSync(argv[0], argv.slice(1), {
      cwd,
      encoding: 'utf8',
      timeout: 180000,
      env: { ...process.env, DSH_SKIP_DOCS_CHECKER: '1' },
    })
    const output = ((run.stdout || '') + (run.stderr || '')).trim()
    const ok = run.status === 0
    verdicts.push(verdict(
      'the documented command runs: ' + command.text,
      ok,
      ok ? (output === '' ? 'exit 0' : 'exit 0 — ' + output.split('\n').slice(0, 2).join(' | ').slice(0, 200))
        : 'exit ' + String(run.status) + ' — ' + output.split('\n').slice(0, 3).join(' | ').slice(0, 300),
      'cmd:' + command.id))
  }

  // ── the import tool the documents point at must answer for itself ────────
  // The path comes out of the documents; the probes are the ones that change
  // nothing: `--help` prints the usage, `we --dry-run` reports without
  // touching the library.
  const importer = importToolPath(ctx)
  if (importer === '') {
    verdicts.push(verdict('the documents point at the material import tool', false,
      'no import-media-sources.py among the paths the documents name', 'cmd:importer'))
  } else {
    const full = join(ctx.workspaceRoot, importer)
    for (const probeArgs of [['--help'], ['we', '--dry-run']]) {
      const run = spawnSync('python3', [importer, ...probeArgs], {
        cwd: ctx.workspaceRoot, encoding: 'utf8', timeout: 60000,
      })
      const output = ((run.stdout || '') + (run.stderr || '')).trim()
      // The importer answers "nothing found" with exit code 2 on purpose — a
      // machine without Wallpaper Engine is not a crash. What must not happen
      // is a traceback or an unexplained exit.
      const answered = run.status === 0
        || (run.status === 2 && /没找到|没有找到|nothing/i.test(output))
      verdicts.push(verdict(
        'the documented import tool answers: python3 ' + importer + ' ' + probeArgs.join(' '),
        answered,
        answered
          ? 'exit ' + String(run.status) + ' — ' + output.split('\n').slice(0, 2).join(' | ').slice(0, 200)
          : 'exit ' + String(run.status) + ' — ' + output.split('\n').slice(0, 3).join(' | ').slice(0, 300),
        'cmd:importer-' + probeArgs.join('-')))
    }
  }

  // ── every suite the documents list must exist ─────────────────────────────
  const listed = []
  for (const command of commands) {
    const match = /tools\/(verify-[A-Za-z0-9-]+\.mjs)/.exec(command.text)
    if (match !== null && !listed.includes(match[1])) listed.push(match[1])
  }
  for (const name of listed) {
    const exists = existsSync(join(ctx.repoRoot, 'tools', name))
    verdicts.push(verdict('the documented suite exists: tools/' + name, exists,
      exists ? '' : 'not found: tools/' + name, 'suite-exists:' + name))
  }

  // ── the build product must match its source ───────────────────────────────
  verdicts.push(buildVerdict(ctx))

  return verdicts
}

/**
 * The committed browser bundle must be what `node build-client.mjs` produces.
 *
 * The build writes lib/client.js, so it is run on a COPY of the repository and
 * the two hashes are compared. The real file is never touched.
 *
 * @param {object} ctx - the checking context.
 * @returns {object} the verdict.
 */
function buildVerdict(ctx) {
  const source = join(ctx.repoRoot, 'src', 'client.js')
  const committed = join(ctx.repoRoot, 'lib', 'client.js')
  if (!existsSync(source) || !existsSync(committed)) {
    return verdict('lib/client.js is the build product of src/client.js', false,
      'src/client.js or lib/client.js is missing', 'state:build-drift')
  }
  const dir = mkdtempSync(join(tmpdir(), 'dsh-appearance-media-build-'))
  try {
    cpSync(ctx.repoRoot, dir, {
      recursive: true,
      filter: (sourcePath) => {
        const name = sourcePath.split('/').pop() ?? ''
        return name !== '.git' && name !== 'node_modules'
      },
    })
    const run = spawnSync(process.execPath, ['build-client.mjs'], {
      cwd: dir, encoding: 'utf8', timeout: 60000,
    })
    if (run.status !== 0) {
      return verdict('lib/client.js is the build product of src/client.js', false,
        'the build failed on the copy: ' + ((run.stderr || '') + (run.stdout || '')).trim().slice(0, 300),
        'state:build-drift')
    }
    const built = readFileSync(join(dir, 'lib', 'client.js'), 'utf8')
    const shipped = readFileSync(committed, 'utf8')
    const same = built === shipped
    return verdict('lib/client.js is the build product of src/client.js', same,
      same ? 'the committed artifact is byte-identical to a fresh build'
        : 'the committed artifact differs from a fresh build — the browser half on disk is stale',
      'state:build-drift')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   Section D — the external links must be reachable.
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Assert that the links in the documents are alive.
 *
 * @param {object} ctx - the checking context.
 * @returns {object[]} the verdicts.
 */
function checkLinks(ctx) {
  const verdicts = []
  const urls = new Set()
  for (const key of ['readme', 'notices', 'detail', 'skill']) {
    const text = ctx.docs[key]
    if (text === '') continue
    for (const url of urlsOf(text)) {
      if (url.includes('<') || url.includes('>')) continue
      urls.add(url)
    }
  }
  if (urls.size === 0) {
    verdicts.push(verdict('the documents contain links to check', false,
      'no URL was found in README.md, THIRD_PARTY_NOTICES.md, docs/DETAIL.md or SKILL.md', 'link:none'))
    return verdicts
  }
  for (const url of [...urls].sort()) {
    const answer = probe(url, { offline: ctx.offline })
    if (!answer.ok) {
      skip('link not checked: ' + url, answer.reason)
      continue
    }
    const ok = answer.status >= 200 && answer.status < 400
    verdicts.push(verdict('the link is alive: ' + url, ok,
      ok ? 'HTTP ' + answer.status : 'HTTP ' + answer.status, 'link:' + url))
  }
  return verdicts
}

/* ─────────────────────────────────────────────────────────────────────────────
   Section E — the documents must still SAY the things they are supposed to say.
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * The suite commands the README's own "跑断言" section prints, in order.
 *
 * Only the FIRST code block of that section counts: the README prints the
 * suites there, and mentions the packaging checker separately afterwards.
 *
 * @param {object} ctx - the checking context.
 * @returns {string[]} the suite file names.
 */
function listedSuiteCommands(ctx) {
  const readme = ctx.docs.readme
  const heading = readme.indexOf('跑断言')
  if (heading === -1) return []
  const rest = readme.slice(heading)
  const nextHeading = rest.indexOf('\n###')
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading)
  const names = []
  for (const block of codeBlocks(section)) {
    for (const command of commandsOf(block.body)) {
      const match = /tools\/(verify-[A-Za-z0-9-]+\.mjs)/.exec(command)
      if (match !== null && !names.includes(match[1])) names.push(match[1])
    }
    break
  }
  return names
}

/**
 * Assert that the documents still contain the parts that must not go missing.
 *
 * Without these, deleting a section would silence every other assertion
 * instead of turning one red.
 *
 * @param {object} ctx - the checking context.
 * @returns {object[]} the verdicts.
 */
function checkRequired(ctx) {
  const verdicts = []
  const readme = ctx.docs.readme

  // ── the three installation routes ─────────────────────────────────────────
  const headings = readme.split('\n')
    .map((line) => /^#{2,6}\s*路径\s*([ABC])\s*[：:]\s*(.*)$/.exec(line))
    .filter((match) => match !== null)
  for (const letter of ['A', 'B', 'C']) {
    const heading = headings.find((match) => match[1] === letter)
    verdicts.push(verdict('the README documents installation route ' + letter, heading !== undefined,
      heading === undefined ? 'no heading "路径 ' + letter + '" in README.md' : '### 路径 ' + letter + '：' + heading[2],
      'required:route-' + letter))
  }
  const routeText = headings.map((match) => match[2]).join(' | ')
  const anchors = [
    { re: /agent/i, id: 'required:route-agent' },
    { re: /市场/, id: 'required:route-market' },
    { re: /手动/, id: 'required:route-manual' },
  ]
  for (const anchor of anchors) {
    verdicts.push(verdict('the installation routes name "' + anchor.re.source + '"', anchor.re.test(routeText),
      'the route headings say: ' + routeText, anchor.id))
  }

  // ── the trademark sentence, character for character ───────────────────────
  verdicts.push(verdict('the README carries the trademark sentence verbatim', readme.includes(TRADEMARK_SENTENCE),
    readme.includes(TRADEMARK_SENTENCE) ? '' : 'the exact sentence is missing from README.md', 'required:trademark'))
  verdicts.push(verdict('the plugin detail page carries the trademark sentence verbatim',
    ctx.docs.detail.includes(TRADEMARK_SENTENCE),
    ctx.docs.detail.includes(TRADEMARK_SENTENCE) ? '' : 'the exact sentence is missing from docs/DETAIL.md',
    'required:trademark-detail'))

  // ── "how to add more material" ───────────────────────────────────────────
  const readmeHas = readme.split('\n').some((line) => HOWTO_HEADING_RE.test(line))
  const detailHas = ctx.docs.detail.split('\n').some((line) => HOWTO_HEADING_RE.test(line))
  verdicts.push(verdict('the README has a "怎么加更多素材" section', readmeHas,
    readmeHas ? '' : 'the heading is missing from README.md', 'required:howto'))
  verdicts.push(verdict('the plugin detail page has a "怎么加更多素材" section', detailHas,
    detailHas ? '' : 'the heading is missing from docs/DETAIL.md', 'required:howto-detail'))

  // ── every suite in the repository is mentioned by the README ─────────────
  const toolsDir = join(ctx.repoRoot, 'tools')
  const suites = existsSync(toolsDir)
    ? readdirSync(toolsDir).filter((name) => /^verify-.*\.mjs$/.test(name)).sort()
    : []
  for (const name of suites) {
    const mentioned = readme.includes(name)
    verdicts.push(verdict('the README mentions the suite ' + name, mentioned,
      mentioned ? '' : 'tools/' + name + ' exists but README.md never mentions it', 'required:suite-' + name))
  }

  // ── the count the README claims ───────────────────────────────────────────
  // The count has to agree with the list the README itself prints, and every
  // suite in the repository has to be named somewhere in the README.
  const countClaim = /仓库里有\s*\*\*(\d+)\s*套\*\*/.exec(readme)
  const listedSuites = listedSuiteCommands(ctx)
  if (countClaim === null) {
    verdicts.push(verdict('the README states how many offline suites the repository has', false,
      'no "N 套" count found in README.md', 'required:suite-count'))
  } else {
    const claimed = Number.parseInt(countClaim[1], 10)
    verdicts.push(verdict('the number of offline suites the README claims is the number it lists',
      claimed === listedSuites.length,
      'README says ' + claimed + ' and lists ' + listedSuites.length + ' command(s) in the "跑断言" section'
        + (claimed === listedSuites.length ? '' : ' — the two disagree'),
      'required:suite-count'))
  }
  const undocumented = suites.filter((name) => !readme.includes(name))
  verdicts.push(verdict('every suite in tools/ is mentioned in the README',
    undocumented.length === 0,
    undocumented.length === 0
      ? suites.length + ' suite(s), all mentioned'
      : 'not mentioned: ' + undocumented.join(', ') + ' (' + suites.length + ' suite(s) in tools/)',
    'required:suite-documented'))

  // ── the documents themselves ──────────────────────────────────────────────
  for (const [key, relativePath] of Object.entries(DOC_FILES)) {
    verdicts.push(verdict('the document exists: ' + relativePath, ctx.missingDocs.indexOf(relativePath) === -1,
      ctx.missingDocs.indexOf(relativePath) === -1 ? '' : 'not found', 'required:doc-' + key))
  }

  return verdicts
}

/* ─────────────────────────────────────────────────────────────────────────────
   The runner.
   ───────────────────────────────────────────────────────────────────────────── */

const SECTIONS = [
  { name: 'paths', run: (ctx) => checkPaths(ctx) },
  { name: 'state', run: (ctx) => checkState(ctx) },
  { name: 'commands', run: (ctx) => checkCommands(ctx) },
  { name: 'links', run: (ctx) => checkLinks(ctx) },
  { name: 'required', run: (ctx) => checkRequired(ctx) },
]

/**
 * Run every section and print the verdicts.
 *
 * @param {object} ctx - the checking context.
 * @param {boolean} [quiet] - do not print, only collect.
 * @returns {Promise<object[]>} the verdicts.
 */
async function runAll(ctx, quiet) {
  const verdicts = []
  for (const section of SECTIONS) {
    const produced = await section.run(ctx)
    if (quiet === true) {
      verdicts.push(...produced)
      continue
    }
    console.log('── ' + section.name + ' ──')
    for (const check of produced) print(check)
    console.log('')
    verdicts.push(...produced)
  }
  return verdicts
}

/* ─────────────────────────────────────────────────────────────────────────────
   The reverse controls. Each one breaks a COPY and demands that the very
   same rule turns red.
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * A copy of the repository in a temporary directory.
 *
 * @returns {string} the copy's path.
 */
function copyOfRepository() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-appearance-media-docs-'))
  cpSync(REPO_ROOT, dir, {
    recursive: true,
    filter: (sourcePath) => {
      const name = sourcePath.split('/').pop() ?? ''
      return name !== '.git' && name !== 'node_modules'
    },
  })
  return dir
}

/**
 * Replace a string in a file of the copy.
 *
 * @param {string} dir - the copy.
 * @param {string} relativePath - the file inside the copy.
 * @param {string} from - the text to replace.
 * @param {string} to - the replacement.
 * @returns {void}
 */
function editInCopy(dir, relativePath, from, to) {
  const full = join(dir, relativePath)
  const text = readFileSync(full, 'utf8')
  if (text.indexOf(from) === -1) {
    throw new Error('the reverse control could not find "' + from + '" in ' + relativePath)
  }
  writeFileSync(full, text.split(from).join(to))
}

/**
 * The reverse controls.
 *
 * Each control names the section it breaks, what it breaks, and how many red
 * verdicts that section had before the break. After the break the same
 * section, run by the same code, must report MORE red verdicts.
 */
const CONTROLS = [
  {
    label: 'the documents point at a repository path that does not exist',
    section: 'paths',
    break: (dir) => editInCopy(dir, 'README.md',
      'skills/dsh-appearance-media-install/SKILL.md',
      'skills/dsh-appearance-media-install/SKILL-gone.md'),
  },
  {
    label: 'the documents claim the package IS published to npm',
    section: 'state',
    break: (dir) => editInCopy(dir, 'README.md', '还没发到 npm', '已发布到 npm'),
  },
  {
    label: 'the documents claim the plugin IS listed in the marketplace',
    section: 'state',
    break: (dir) => editInCopy(dir, 'README.md', '还没有被收录进官方精选列表', '已经被收录进官方精选列表'),
  },
  {
    label: 'the catalog entry points its icon at an SVG',
    section: 'state',
    break: (dir) => editInCopy(dir, '.catalog/harveyzhang__dsh-appearance-media.yml',
      '/icon-180.png', '/icon.svg'),
  },
  {
    label: 'the catalog entry points its icon at a file that is not there',
    section: 'state',
    break: (dir) => editInCopy(dir, '.catalog/harveyzhang__dsh-appearance-media.yml',
      '/icon-180.png', '/assets/icon-missing.png'),
  },
  {
    label: 'the catalog entry points at another repository',
    section: 'state',
    break: (dir) => editInCopy(dir, '.catalog/harveyzhang__dsh-appearance-media.yml',
      'url: https://github.com/harveyzhang/dsh-appearance-media', 'url: https://github.com/somebody/else'),
  },
  {
    label: 'assets/ holds a video',
    section: 'state',
    break: (dir) => writeFileSync(join(dir, 'assets', 'demo-clip.mp4'), 'not really a video'),
  },
  {
    label: 'the documents describe assets/ wrongly',
    section: 'state',
    // The baseline of this control is a tree in which the documents are RIGHT
    // (assets/ really is empty), so that the break is what turns the verdict
    // red. Without the preparation the verdict is red to begin with, and a
    // rule that is red all the time proves nothing.
    prepare: (dir) => unlinkSync(join(dir, 'assets', 'icon-180.png')),
    break: (dir) => {
      editInCopy(dir, 'README.md', '`assets/` 目录是空的', '`assets/` 里只有 icon-180.png')
      writeFileSync(join(dir, 'assets', 'stray.png'), 'a stray file')
    },
  },
  {
    label: 'the documented command points at a script that is not there',
    section: 'commands',
    only: 'import-media-sources',
    break: (dir) => editInCopy(dir, 'README.md',
      'DSH插件开发/方案与工具/import-media-sources.py',
      'DSH插件开发/方案与工具/import-media-sources-missing.py'),
  },
  {
    label: 'the browser bundle is stale (src/client.js moved on, lib/client.js did not)',
    section: 'commands',
    break: (dir) => {
      const source = join(dir, 'src', 'client.js')
      writeFileSync(source, readFileSync(source, 'utf8') + '\n// drift introduced by the reverse control\n')
    },
  },
  {
    label: 'a suite the README lists is gone',
    section: 'commands',
    break: (dir) => unlinkSync(join(dir, 'tools', 'verify-slots.mjs')),
  },
  {
    label: 'the README loses installation route C',
    section: 'required',
    break: (dir) => {
      const full = join(dir, 'README.md')
      const kept = readFileSync(full, 'utf8').split('\n')
        .filter((line) => !/^#{2,6}\s*路径\s*C/.test(line))
      writeFileSync(full, kept.join('\n'))
    },
  },
  {
    label: 'the trademark sentence is altered',
    section: 'required',
    break: (dir) => editInCopy(dir, 'README.md', '也没有得到它们的背书。', '也没有得到它们的背书！'),
  },
  {
    label: 'the README loses the "怎么加更多素材" section',
    section: 'required',
    break: (dir) => {
      const full = join(dir, 'README.md')
      const kept = readFileSync(full, 'utf8').split('\n')
        .filter((line) => !HOWTO_HEADING_RE.test(line))
      writeFileSync(full, kept.join('\n'))
    },
  },
  {
    label: 'a new suite is added and nobody documented it',
    section: 'required',
    break: (dir) => writeFileSync(join(dir, 'tools', 'verify-brand-new.mjs'),
      '// a suite nobody documented\nconsole.log("0 check(s), 0 failed")\n'),
  },
  {
    label: 'the documents are gone entirely (the checker would check nothing)',
    section: 'selfcheck',
    break: (dir) => {
      for (const relativePath of Object.values(DOC_FILES)) {
        const full = join(dir, relativePath)
        if (existsSync(full)) rmSync(full, { force: true })
      }
    },
  },
]

/**
 * Run the reverse controls.
 *
 * @param {object} ctx - the context of the real tree.
 * @returns {Promise<object[]>} the verdicts of the controls themselves.
 */
async function runNegativeControls(ctx) {
  const verdicts = []
  console.log('════ reverse controls (a broken copy MUST be rejected) ════')
  console.log('')
  const skipMark = skips.length
  quietSkips = true
  try {
    for (const control of CONTROLS) {
      const dir = copyOfRepository()
      try {
        // ★ The preparation runs first: a control needs a baseline in which
        //   the rule is GREEN, otherwise "still red" proves nothing.
        if (control.prepare !== undefined) control.prepare(dir)
        const preparedCtx = makeContext({
          repoRoot: dir,
          workspaceRoot: ctx.workspaceRoot,
          offline: ctx.offline,
          gitRoot: ctx.gitRoot,
        })
        const before = await sectionVerdicts(control.section, preparedCtx, control.only)
        // ★ The break comes after the baseline: the context reads the
        //   documents into memory, so a context built before the break would
        //   still hold the unbroken text.
        control.break(dir)
        const brokenCtx = makeContext({
          repoRoot: dir,
          workspaceRoot: ctx.workspaceRoot,
          offline: ctx.offline,
          gitRoot: ctx.gitRoot,
        })
        const after = await sectionVerdicts(control.section, brokenCtx, control.only)
        const beforeRed = before.filter((check) => !check.ok).length
        const afterRed = after.filter((check) => !check.ok).length
        const newRed = after.filter((check) => !check.ok)
        const caught = afterRed > beforeRed
        console.log('  ┌ broke: ' + control.label)
        console.log('  │ before: ' + String(before.length) + ' verdict(s), ' + String(beforeRed) + ' red')
        console.log('  │ after:  ' + String(after.length) + ' verdict(s), ' + String(afterRed) + ' red')
        for (const check of newRed.slice(0, 4)) {
          console.log('  │ RED  ' + check.label + (check.detail === '' ? '' : '  — ' + check.detail))
        }
        console.log('  └ ' + (caught ? 'the check caught it' : 'THE CHECK DID NOT CATCH IT — the rule cannot fail'))
        verdicts.push(verdict('REVERSE CONTROL: ' + control.label + ' ⇒ the checks must turn red',
          caught,
          caught ? 'the broken copy was rejected (' + String(afterRed - beforeRed) + ' verdict(s) went red)'
            : 'the broken copy was accepted — this rule cannot fail',
          'control:' + control.label))
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  } finally {
    quietSkips = false
    skips.length = skipMark
  }
  return verdicts
}

/**
 * The verdicts of one section, for one context.
 *
 * @param {string} name - the section name, or 'selfcheck'.
 * @param {object} ctx - the context.
 * @param {string} [only] - for the commands section: only this command.
 * @returns {Promise<object[]>} the verdicts.
 */
async function sectionVerdicts(name, ctx, only) {
  if (name === 'selfcheck') {
    const produced = []
    for (const section of SECTIONS) {
      const scoped = only === undefined ? ctx : { ...ctx, onlyCommands: [only] }
      const verdicts = await section.run(scoped)
      produced.push(verdict('the section "' + section.name + '" asserted something', verdicts.length > 0,
        verdicts.length + ' verdict(s)', 'selfcheck:' + section.name))
    }
    return produced
  }
  const section = SECTIONS.find((entry) => entry.name === name)
  if (section === undefined) return []
  const scoped = only === undefined ? ctx : { ...ctx, onlyCommands: [only] }
  return section.run(scoped)
}

/* ─────────────────────────────────────────────────────────────────────────────
   Main.
   ───────────────────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2)
const offline = argv.includes('--offline')
const negative = argv.includes('--negative')
const docsRootArgument = argv.find((argument) => argument.startsWith('--docs-root='))
const repoRoot = docsRootArgument === undefined ? REPO_ROOT : docsRootArgument.slice('--docs-root='.length)

const context = makeContext({
  repoRoot,
  workspaceRoot: WORKSPACE_ROOT,
  offline,
})

console.log('dsh-appearance-media — documentation-facts assertions')
console.log('repository: ' + repoRoot)
console.log('workspace: ' + WORKSPACE_ROOT)
if (offline) console.log('★ offline mode: every network assertion is skipped')
console.log('')

// The checker itself is checked first: pointed at the wrong tree, it would
// silently assert nothing, and "0 check(s)" is the failure mode that hides
// everywhere.
{
  const manifest = join(repoRoot, 'package.json')
  const rightTree = existsSync(manifest) && existsSync(join(repoRoot, 'README.md'))
    && existsSync(join(repoRoot, 'tools', 'verify-package.mjs'))
  print(verdict('the checker is pointed at the plugin repository', rightTree,
    rightTree ? repoRoot : 'not the plugin repository: ' + repoRoot, 'self:root'))
  if (!rightTree) {
    console.log('')
    console.log('0 check(s), 1 failed — the checker is pointed at the wrong tree')
    process.exit(1)
  }
}

const verdicts = await runAll(context, false)

console.log('── self check ──')
print(verdict('every section asserted something', SECTIONS.every((section) => true),
  SECTIONS.length + ' sections', 'self:sections'))
print(verdict('the checker asserted more than zero facts', verdicts.length + checks.length > 0,
  String(verdicts.length + checks.length) + ' assertion(s) so far', 'self:count'))
console.log('')

if (negative) {
  const controlVerdicts = await runNegativeControls(context)
  console.log('')
  console.log('── reverse controls ──')
  for (const check of controlVerdicts) print(check)
  console.log('')
}

const failed = checks.filter((check) => check.ok === false)
console.log(String(checks.length) + ' check(s), ' + String(failed.length) + ' failed, '
  + String(skips.length) + ' skipped')
if (failed.length > 0) {
  console.log('')
  console.log('failed:')
  for (const check of failed) {
    console.log('  ✗ ' + check.label + (check.detail === '' ? '' : '  — ' + check.detail))
  }
}
if (skips.length > 0) {
  console.log('')
  console.log('skipped (not asserted — a skip is never a pass and never a failure):')
  for (const entry of skips) console.log('  - ' + entry.label + '  — ' + entry.reason)
}
process.exit(failed.length > 0 ? 1 : 0)
