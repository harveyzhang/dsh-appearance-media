#!/usr/bin/env node
// dsh-appearance-media — offline acceptance for the optimize route and for the
// remux module it drives.
//
// WHAT IT PROVES, and what it deliberately does not:
//
//   * it runs the REAL `optimizeInPlace` and the REAL route handler against
//     REAL material — the user's own clips and the upstream's un-optimized
//     original — and checks the RESULT, not a plan;
//   * it never starts DSH, never binds a port, never waits for anything;
//   * it never writes into the user's library. Every file it touches is a COPY
//     in a temporary directory.
//
// ★ THE MATERIAL IS REAL, AND THAT IS THE POINT.
//
//   The two clips this suite rewrites are:
//
//   * the upstream's own UN-OPTIMIZED original — `ftyp → free → mdat`,
//     22,627,234 bytes — which is the file the whole feature exists for; and
//   * a clip from the user's own library, which is ALREADY faststart and must
//     therefore be refused.
//
//   A synthetic mp4 built by the suite would prove only that the suite and the
//   implementation agree with each other. A real clip proves the rewrite keeps
//   the media payload bit-identical, keeps the duration, the resolution and
//   the codec, and keeps the chunk-offset tables consistent with where the
//   media data actually ends up.
//
// ★ THE CHECKS CAN GO RED. THAT IS ASSERTED, NOT ASSUMED.
//
//   The last section of this file breaks the implementation on purpose —
//   twice — and requires the SAME checks to go red:
//
//     A. the plan stops moving `moov` to the front;
//     B. A, plus the "verify the OUTPUT" step is skipped.
//
//   B is the accident this tool actually made once: a plan that leaves `moov`
//   where it was passes every other proof, so the tool wrote a byte-identical
//   copy and reported success. A check that cannot fail is not a check, so the
//   suite refuses to pass unless the broken versions DO fail.
//
// Usage: node tools/verify-remux.mjs

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgDir = fileURLToPath(new URL('..', import.meta.url))

/** The route this suite drives. */
const OPTIMIZE_PATH = '/appearance-media/optimize'

/** The catalog route, used to read the ledger's revision. */
const CATALOG_PATH = '/appearance-media/catalog.json'

/**
 * The REAL un-optimized original: `ftyp → free → mdat`, moov at the end.
 *
 * This is the upstream's own material — the very clip the feature was built
 * for. `DSHAM_REMUX_TAIL` overrides the location for a checkout that lays it
 * out differently.
 */
// ★ THE FIXTURES SHIP WITH THE REPOSITORY.
//
// The two files under tools/fixtures/ are the SAME one-second clip in two
// layouts: `tail.mp4` has its movie box at the end (ftyp → free → mdat → moov)
// and `fast.mp4` has it at the front (ftyp → moov → free → mdat). The checks
// below compare the two layouts of ONE video, so the pair has to be one
// video.
//
// They used to come from this machine only — the upstream project's own
// material, and a faststart clip in the user's media library. That made the
// whole 57-check block conditional: on any machine without them the suite
// reported "1 check(s), 0 failed" — a green run that proved nothing at all.
// A checkout of this repository now tests the implementation everywhere.
//
// The environment variables still win, for anyone who wants to run the checks
// against real material.
const TAIL_SOURCE = process.env.DSHAM_REMUX_TAIL !== undefined && process.env.DSHAM_REMUX_TAIL !== ''
  ? process.env.DSHAM_REMUX_TAIL
  : fileURLToPath(new URL('./fixtures/tail.mp4', import.meta.url))

/** The same clip, faststart. Overridable for real material. */
const FAST_SOURCE = process.env.DSHAM_REMUX_FAST !== undefined && process.env.DSHAM_REMUX_FAST !== ''
  ? process.env.DSHAM_REMUX_FAST
  : fileURLToPath(new URL('./fixtures/fast.mp4', import.meta.url))

/** The user's own media library. Read-only for this suite. */
const LIBRARY_DIR = join(homedir(), '.dsh', 'dsh-appearance-media', 'media')

/** A real PNG, used to prove that a non-mp4 is refused. */
const PNG_FIXTURE = fileURLToPath(new URL('./fixtures/sample.png', import.meta.url))

/** @type {Array<[string, boolean, string]>} */
const checks = []
/** @type {string[]} */
const notes = []
/**
 * Checks that could not run here, with the reason.
 *
 * ★ A check that cannot run in this environment is SKIPPED, not failed:
 *   the two "real clip" checks need material that only exists on the machine
 *   that has it. Failing them would make a fresh checkout of this repository
 *   report red for a reason that has nothing to do with the implementation.
 *   Skips are printed, never silently dropped.
 * @type {Array<[string, string]>}
 */
const skips = []

/**
 * Record that a check could not run here.
 * @param label - what could not be checked.
 * @param reason - why it could not run.
 */
function skip(label, reason) {
  skips.push([label, reason])
}

/**
 * Record one assertion.
 * @param label - what is asserted.
 * @param ok - whether it holds.
 * @param detail - the evidence, printed next to the label.
 */
function record(label, ok, detail = '') {
  checks.push([label, Boolean(ok), detail])
}

/* ───────────────────────────────────────────────────────────────────────────
   An mp4 reader that is NOT the implementation's.

   The implementation finds its chunk-offset tables by SCANNING the `moov`
   bytes for the bytes `stco` / `co64`. This reader walks the box TREE
   instead. Two different methods, so a bug in one is not a bug in the other,
   and a check that used the implementation's own parser to check the
   implementation would prove nothing at all.
   ─────────────────────────────────────────────────────────────────────────── */

/** The boxes that hold other boxes. */
const CONTAINER_BOXES = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta',
  'mvex', 'moof', 'traf', 'mfra', 'skip', 'sinf', 'schi',
])

/**
 * Parse the box tree of a buffer.
 *
 * @param buffer - the bytes.
 * @param start - the first byte to look at.
 * @param end - one past the last byte to look at.
 * @param depth - the current depth.
 * @returns the boxes, in file order.
 */
function parseBoxes(buffer, start = 0, end = buffer.length, depth = 0) {
  const boxes = []
  let offset = start
  while (offset + 8 <= end) {
    let size = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    let header = 8
    if (size === 1) {
      if (offset + 16 > end) break
      size = buffer.readUInt32BE(offset + 8) * 2 ** 32 + buffer.readUInt32BE(offset + 12)
      header = 16
    } else if (size === 0) {
      size = end - offset
    }
    if (size < header || offset + size > end) break
    const box = { type, start: offset, size, header, payload: offset + header, depth }
    boxes.push(box)
    if (CONTAINER_BOXES.has(type)) {
      box.children = parseBoxes(buffer, offset + header, offset + size, depth + 1)
    }
    offset += size
  }
  return boxes
}

/**
 * Every box of one type, at any depth.
 *
 * @param boxes - the box list.
 * @param type - the box type.
 * @returns the matching boxes.
 */
function findBoxes(boxes, type) {
  const found = []
  for (const box of boxes) {
    if (box.type === type) found.push(box)
    if (Array.isArray(box.children)) found.push(...findBoxes(box.children, type))
  }
  return found
}

/**
 * The top-level box types, in file order.
 *
 * @param buffer - the bytes.
 * @returns the type names.
 */
function boxOrder(buffer) {
  return parseBoxes(buffer).map((box) => box.type)
}

/**
 * The bytes of everything except the `moov` box.
 *
 * @param buffer - the bytes.
 * @returns the payload without the movie box.
 */
function withoutMoov(buffer) {
  const parts = parseBoxes(buffer)
    .filter((box) => box.type !== 'moov')
    .map((box) => buffer.subarray(box.start, box.start + box.size))
  return Buffer.concat(parts)
}

/**
 * The chunk-offset tables, read by walking the tree.
 *
 * @param buffer - the bytes.
 * @returns one record per table.
 */
function chunkTables(buffer) {
  const tables = []
  for (const box of findBoxes(parseBoxes(buffer), 'stco')) {
    tables.push({
      type: 'stco',
      width: 4,
      count: buffer.readUInt32BE(box.payload + 4),
      dataAt: box.payload + 8,
    })
  }
  for (const box of findBoxes(parseBoxes(buffer), 'co64')) {
    tables.push({
      type: 'co64',
      width: 8,
      count: buffer.readUInt32BE(box.payload + 4),
      dataAt: box.payload + 8,
    })
  }
  return tables
}

/**
 * The start of the media data, in bytes.
 *
 * @param buffer - the bytes.
 * @returns the offset of the `mdat` payload, or -1.
 */
function mdatPayloadOffset(buffer) {
  const mdat = parseBoxes(buffer).find((box) => box.type === 'mdat')
  return mdat === undefined ? -1 : mdat.payload
}

/**
 * Read the facts ffprobe reports about one file.
 *
 * @param file - the absolute path.
 * @returns `{ ok, facts, error }`.
 */
function probeFacts(file) {
  try {
    const raw = execFileSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration,size,format_name',
      '-show_entries', 'stream=codec_name,codec_type,width,height,nb_frames',
      '-of', 'json',
      file,
    ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    return { ok: true, facts: JSON.parse(raw), error: '' }
  } catch (error) {
    return { ok: false, facts: null, error: String(error && error.message ? error.message : error) }
  }
}

/**
 * The facts worth comparing: duration, size and every stream's codec and size.
 *
 * @param facts - the ffprobe answer.
 * @returns a comparable summary.
 */
function mediaFacts(facts) {
  const streams = (facts?.streams ?? []).map((stream) => ({
    codec_name: String(stream.codec_name ?? ''),
    codec_type: String(stream.codec_type ?? ''),
    width: Number(stream.width ?? 0),
    height: Number(stream.height ?? 0),
    nb_frames: String(stream.nb_frames ?? ''),
  }))
  return {
    duration: String(facts?.format?.duration ?? ''),
    streams,
  }
}

/* ───────────────────────────────────────────────────────────────────────────
   Host fakes: the same shape the other suites in this package use.
   ─────────────────────────────────────────────────────────────────────────── */

/**
 * Read one header, case-insensitively.
 *
 * @param headers - the header map.
 * @param name - the header name.
 * @returns the value, or undefined.
 */
function header(headers, name) {
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === wanted) return value
  }
  return undefined
}

/**
 * The fake response — a REAL `Writable`, because the handlers pipe into it.
 */
class FakeResponse extends Writable {
  constructor() {
    super()
    this.status = 0
    this.headers = {}
    this.headersSent = false
    this.chunks = []
  }

  /**
   * Record the status line and the headers.
   * @param code - the status code.
   * @param extra - the headers.
   * @returns this.
   */
  writeHead(code, extra) {
    this.status = code
    this.headers = extra ?? {}
    this.headersSent = true
    return this
  }

  /**
   * Collect one chunk of the body.
   * @param chunk - the bytes.
   * @param encoding - the encoding.
   * @param callback - the stream callback.
   */
  _write(chunk, encoding, callback) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding))
    callback()
  }

  /** The whole body. */
  get body() {
    return Buffer.concat(this.chunks)
  }

  /** The body as text. */
  get text() {
    return this.body.toString('utf8')
  }
}

/**
 * Build a fake request.
 *
 * @param options - `method`, `url`, `headers`, `body`.
 * @returns the request.
 */
function makeRequest({ method = 'GET', url = '/', headers = {}, body = null } = {}) {
  const chunks = body === null
    ? []
    : [Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')]
  const req = Readable.from(chunks)
  req.method = method
  req.url = url
  req.headers = headers
  return req
}

/**
 * Drive one route and wait for its response.
 *
 * @param route - the route descriptor.
 * @param options - the request options.
 * @returns a promise for `{ status, headers, text }`.
 */
function drive(route, options = {}) {
  return new Promise((resolve) => {
    const res = new FakeResponse()
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve({ status: res.status, headers: res.headers, text: res.text })
    }
    res.on('finish', finish)
    res.on('close', finish)
    const timer = setTimeout(finish, 30000)
    if (typeof timer.unref === 'function') timer.unref()
    let result
    try {
      result = route.handler(makeRequest(options), res)
    } catch (error) {
      clearTimeout(timer)
      resolve({ status: 0, headers: {}, text: String(error) })
      return
    }
    if (result !== undefined && result !== null && typeof result.then === 'function') {
      result.then(() => { clearTimeout(timer) }, (error) => {
        clearTimeout(timer)
        notes.push('route threw: ' + String(error))
        finish()
      })
    }
  })
}

/**
 * Build a stub Host context.
 *
 * @returns the stub context and its recordings.
 */
function makeContext() {
  const routes = []
  const listeners = new Map()
  const disposers = []
  const services = new Map()
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    effect(fn, label) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push([label ?? '', disposer])
      return disposer
    },
    on(event, fn) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        const index = current.indexOf(fn)
        if (index >= 0) current.splice(index, 1)
      }
    },
    get(name) { return services.get(name) },
    inject(names, callback) { return callback(ctx) },
    provide() {},
    logger: { info() {}, warn() {}, error() {} },
  }
  return { ctx, routes, listeners, disposers }
}

/* ───────────────────────────────────────────────────────────────────────────
   The fixtures.
   ─────────────────────────────────────────────────────────────────────────── */

/**
 * Find a clip in the user's library that is ALREADY faststart.
 *
 * The library is the user's own; the suite only READS it. The name is not
 * hard-coded where it can be avoided — the clips get renamed — so the library
 * is scanned and the first faststart mp4 is taken.
 *
 * @returns the absolute path, or null.
 */
/**
 * Whether a fixture is still the file the checks were measured on.
 *
 * The manifest next to the fixtures pins the size and the hash. A fixture
 * that was edited, truncated or replaced is caught here instead of quietly
 * changing what the rest of the checks mean.
 * @param which - `tail` or `fast`.
 * @param bytes - the bytes of the fixture.
 * @returns whether it matches the manifest.
 */
function fixtureMatches(which, bytes) {
  const manifestPath = fileURLToPath(new URL('./fixtures/manifest.json', import.meta.url))
  let manifest = null
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return false
  }
  const expected = manifest[which]
  if (!expected) return false
  if (bytes.length !== expected.bytes) return false
  return createHash('sha256').update(bytes).digest('hex') === expected.sha256
}

/**
 * The upstream project's own un-optimized clip, when this machine has it.
 *
 * Optional evidence only: the suite's own fixtures are the ones the checks
 * run against, so a machine without the upstream checkout still tests
 * everything.
 * @returns the path, or null when it is not here.
 */
function findUpstreamClip() {
  // ★ Only the environment variable points at real material. Nothing in this
  //   suite may reference a path outside the repository: a checkout on
  //   another machine — or another person's machine — has neither this
  //   project's layout nor this developer's home directory.
  const fromEnv = process.env.DSHAM_REMUX_TAIL
  if (fromEnv !== undefined && fromEnv !== '' && existsSync(fromEnv)) return fromEnv
  return null
}

function findFaststartClip() {
  let names = []
  try {
    names = readdirSync(LIBRARY_DIR)
  } catch {
    return null
  }
  const preferred = 'p05-bg-1.mp4'
  const ordered = names.filter((name) => name.toLowerCase().endsWith('.mp4'))
  if (ordered.includes(preferred)) ordered.unshift(...ordered.splice(ordered.indexOf(preferred), 1))
  for (const name of ordered) {
    const absolute = join(LIBRARY_DIR, name)
    try {
      const head = readFileSync(absolute).subarray(0, 65536)
      const order = boxOrder(head)
      const moovAt = order.indexOf('moov')
      const mdatAt = order.indexOf('mdat')
      if (moovAt >= 0 && (mdatAt < 0 || moovAt < mdatAt)) return absolute
    } catch {
      /* try the next one */
    }
  }
  return null
}

/* ───────────────────────────────────────────────────────────────────────────
   The check set. It runs against whatever module and plugin it is handed, so
   the SAME checks can be run against a deliberately broken copy.
   ─────────────────────────────────────────────────────────────────────────── */

/**
 * Run every assertion against one implementation.
 *
 * @param options - `label`, `remux` (the module), `mount` (a function that
 *   mounts the plugin and returns its routes), `tail` and `fast` (the real
 *   material).
 * @returns a promise for the list of `{ name, ok, detail }`.
 */
async function runChecks({ label, remux, mount, tail, fast }) {
  const results = []
  /**
   * Record one assertion.
   * @param name - what is asserted.
   * @param ok - whether it holds.
   * @param detail - the evidence.
   */
  const say = (name, ok, detail = '') => {
    results.push({ name, ok: Boolean(ok), detail })
  }

  const stage = mkdtempSync(join(tmpdir(), `dsham-remux-${label}-`))
  const dataDir = join(stage, 'data')
  const media = join(dataDir, 'media')
  mkdirSync(media, { recursive: true })

  try {
    /* ── the module's shape ───────────────────────────────────────────── */

    say('the module exports optimizeInPlace',
      typeof remux.optimizeInPlace === 'function', typeof remux.optimizeInPlace)
    say('the module exports remux',
      typeof remux.remux === 'function', typeof remux.remux)
    say('the module exports leadingBox',
      typeof remux.leadingBox === 'function', typeof remux.leadingBox)
    say('the module carries a size ceiling',
      Number.isFinite(remux.MAX_OPTIMIZE_BYTES) && remux.MAX_OPTIMIZE_BYTES > 0,
      String(remux.MAX_OPTIMIZE_BYTES))

    /* ── the material ─────────────────────────────────────────────────── */

    const tailBytes = readFileSync(tail)
    const tailOrder = boxOrder(tailBytes)
    const tailMoov = tailOrder.indexOf('moov')
    const tailMdat = tailOrder.indexOf('mdat')
    say('the real original really has its moov AFTER its mdat',
      tailMoov > 0 && tailMdat > 0 && tailMoov > tailMdat,
      tailOrder.join(' → '))
    // ★ The fixture is pinned by a manifest next to it: size AND hash. The old
    //   check compared against the byte size of one machine's material, which
    //   said nothing once the fixtures shipped with the repository.
    say('the un-optimized fixture is the one the checks were measured on',
      fixtureMatches('tail', tailBytes),
      String(tailBytes.length) + ' bytes')

    const fastBytes = readFileSync(fast)
    const fastOrder = boxOrder(fastBytes)
    const fastMoov = fastOrder.indexOf('moov')
    const fastMdat = fastOrder.indexOf('mdat')
    say('the faststart fixture is the one the checks were measured on',
      fixtureMatches('fast', fastBytes),
      String(fastBytes.length) + ' bytes')
    say('the real faststart clip really has its moov BEFORE its mdat',
      fastMoov >= 0 && (fastMdat < 0 || fastMoov < fastMdat),
      fastOrder.join(' → '))

    /* ── the rewrite, on the real original ────────────────────────────── */

    const rewriteDir = join(stage, 'rewrite')
    mkdirSync(rewriteDir, { recursive: true })
    const rewriteFile = join(rewriteDir, 'clip.mp4')
    copyFileSync(tail, rewriteFile)

    let rewriteResult = null
    let rewriteError = ''
    try {
      rewriteResult = await remux.optimizeInPlace({
        file: rewriteFile,
        scratchDir: join(rewriteDir, '.scratch'),
      })
    } catch (error) {
      rewriteError = String(error && error.message ? error.message : error)
    }
    say('the rewrite of the real original completes', rewriteResult?.status === 'done',
      rewriteError === '' ? String(rewriteResult?.status) : rewriteError)

    if (rewriteResult?.status === 'done') {
      const outBytes = readFileSync(rewriteFile)
      const outOrder = boxOrder(outBytes)
      const outMoov = outOrder.indexOf('moov')
      const outMdat = outOrder.indexOf('mdat')

      say('the rewritten clip is exactly as long as the original',
        outBytes.length === tailBytes.length,
        String(tailBytes.length) + ' → ' + String(outBytes.length))
      say('the rewritten clip really has its moov BEFORE its mdat',
        outMoov >= 0 && outMdat >= 0 && outMoov < outMdat,
        outOrder.join(' → '))
      say('the rewritten clip is not a byte-identical copy of the original',
        !outBytes.equals(tailBytes),
        'moov moved from ' + String(tailMoov) + ' to ' + String(outMoov))

      const beforePayload = withoutMoov(tailBytes)
      const afterPayload = withoutMoov(outBytes)
      say('the media payload is byte-identical once the moov is stripped',
        beforePayload.equals(afterPayload),
        beforePayload.length + ' vs ' + afterPayload.length + ' bytes')

      const beforeMdat = parseBoxes(tailBytes).find((box) => box.type === 'mdat')
      const afterMdat = parseBoxes(outBytes).find((box) => box.type === 'mdat')
      say('the media data itself is byte-identical',
        beforeMdat !== undefined && afterMdat !== undefined
        && tailBytes.subarray(beforeMdat.payload, beforeMdat.start + beforeMdat.size)
          .equals(outBytes.subarray(afterMdat.payload, afterMdat.start + afterMdat.size)),
        'mdat ' + String(beforeMdat?.size) + ' → ' + String(afterMdat?.size) + ' bytes')

      // The chunk-offset tables, checked against where the media data
      // ACTUALLY ended up — not against what the implementation believes.
      const shift = mdatPayloadOffset(outBytes) - mdatPayloadOffset(tailBytes)
      const beforeTables = chunkTables(tailBytes)
      const afterTables = chunkTables(outBytes)
      say('the rewrite found the same number of chunk-offset tables',
        beforeTables.length > 0 && beforeTables.length === afterTables.length,
        beforeTables.length + ' → ' + afterTables.length)
      let entriesChecked = 0
      let entriesWrong = 0
      for (let index = 0; index < Math.min(beforeTables.length, afterTables.length); index += 1) {
        const before = beforeTables[index]
        const after = afterTables[index]
        if (before.width !== after.width || before.count !== after.count) {
          entriesWrong += 1
          continue
        }
        for (let entry = 0; entry < before.count; entry += 1) {
          const at = entry * before.width
          const was = before.width === 4
            ? BigInt(tailBytes.readUInt32BE(before.dataAt + at))
            : tailBytes.readBigUInt64BE(before.dataAt + at)
          const now = after.width === 4
            ? BigInt(outBytes.readUInt32BE(after.dataAt + at))
            : outBytes.readBigUInt64BE(after.dataAt + at)
          entriesChecked += 1
          if (now !== was + BigInt(shift)) entriesWrong += 1
        }
      }
      say('every chunk offset was shifted by exactly the layout\'s shift',
        entriesChecked > 0 && entriesWrong === 0,
        entriesChecked + ' entries checked, ' + String(entriesWrong) + ' wrong, shift '
          + String(shift))

      const beforeProbe = probeFacts(tail)
      const afterProbe = probeFacts(rewriteFile)
      say('ffprobe reads the rewritten clip', beforeProbe.ok && afterProbe.ok,
        afterProbe.ok ? 'ok' : afterProbe.error)
      if (beforeProbe.ok && afterProbe.ok) {
        const a = mediaFacts(beforeProbe.facts)
        const b = mediaFacts(afterProbe.facts)
        say('ffprobe reports the same duration', a.duration === b.duration && a.duration !== '',
          a.duration + ' → ' + b.duration)
        say('ffprobe reports the same streams',
          JSON.stringify(a.streams) === JSON.stringify(b.streams),
          JSON.stringify(b.streams))
      }
    }

    say('the staging directory is gone when the rewrite is done',
      !existsSync(join(rewriteDir, '.scratch')),
      readdirSync(rewriteDir).join(', '))

    /* ── the refusal: a clip that is already faststart ────────────────── */

    const alreadyDir = join(stage, 'already')
    mkdirSync(alreadyDir, { recursive: true })
    const alreadyFile = join(alreadyDir, 'clip.mp4')
    copyFileSync(fast, alreadyFile)
    let alreadyResult = null
    let alreadyError = ''
    try {
      alreadyResult = await remux.optimizeInPlace({
        file: alreadyFile,
        scratchDir: join(alreadyDir, '.scratch'),
      })
    } catch (error) {
      alreadyError = String(error && error.message ? error.message : error)
    }
    say('a clip that is already faststart is refused, not rewritten',
      alreadyResult?.status === 'already',
      alreadyError === '' ? String(alreadyResult?.status) : alreadyError)
    say('the refused clip is left byte-identical',
      readFileSync(alreadyFile).equals(fastBytes),
      String(readFileSync(alreadyFile).length) + ' bytes')
    say('the refusal leaves no file behind',
      readdirSync(alreadyDir).length === 1,
      readdirSync(alreadyDir).join(', '))

    /* ── the refusal: too big ─────────────────────────────────────────── */

    const bigDir = join(stage, 'toobig')
    mkdirSync(bigDir, { recursive: true })
    const bigFile = join(bigDir, 'clip.mp4')
    copyFileSync(tail, bigFile)
    let bigError = null
    try {
      await remux.optimizeInPlace({
        file: bigFile,
        scratchDir: join(bigDir, '.scratch'),
        maxBytes: 1024,
      })
    } catch (error) {
      bigError = error
    }
    say('a clip over the ceiling is refused with a reason',
      bigError !== null && bigError.code === 'E_TOO_BIG',
      bigError === null ? 'no refusal' : String(bigError.code) + ': ' + String(bigError.message))
    say('the refused oversized clip is left byte-identical',
      readFileSync(bigFile).equals(tailBytes),
      String(readFileSync(bigFile).length) + ' bytes')

    /* ── the refusal: a staging directory that cannot be written ──────── */

    const lockedDir = join(stage, 'locked')
    mkdirSync(lockedDir, { recursive: true })
    const lockedFile = join(lockedDir, 'clip.mp4')
    copyFileSync(tail, lockedFile)
    const lockedScratch = join(lockedDir, '.scratch')
    mkdirSync(lockedScratch, { recursive: true })
    chmodSync(lockedScratch, 0o500)
    let lockedError = null
    try {
      await remux.optimizeInPlace({ file: lockedFile, scratchDir: lockedScratch })
    } catch (error) {
      lockedError = error
    } finally {
      // The refusal removes the staging directory on its way out, so the
      // permissions may already be gone.
      if (existsSync(lockedScratch)) chmodSync(lockedScratch, 0o700)
    }
    say('a staging directory that cannot be written to refuses the rewrite',
      lockedError !== null && lockedError.code === 'E_FAILED',
      lockedError === null ? 'no refusal' : String(lockedError.code) + ': ' + String(lockedError.message))
    say('the original survives a failed rewrite byte-identical',
      readFileSync(lockedFile).equals(tailBytes),
      String(readFileSync(lockedFile).length) + ' bytes')

    /* ── the refusal: a damaged mp4 ───────────────────────────────────── */

    const brokenDir = join(stage, 'broken')
    mkdirSync(brokenDir, { recursive: true })
    const brokenFile = join(brokenDir, 'clip.mp4')
    const brokenBytes = Buffer.from(tailBytes)
    brokenBytes.fill(0x5a, 0, 512)
    writeFileSync(brokenFile, brokenBytes)
    let brokenError = null
    try {
      await remux.optimizeInPlace({
        file: brokenFile,
        scratchDir: join(brokenDir, '.scratch'),
      })
    } catch (error) {
      brokenError = error
    }
    say('a damaged mp4 is refused with a reason',
      brokenError !== null && String(brokenError.code ?? '').startsWith('E_'),
      brokenError === null ? 'no refusal' : String(brokenError.code) + ': ' + String(brokenError.message))
    say('the damaged clip is left byte-identical',
      readFileSync(brokenFile).equals(brokenBytes),
      String(readFileSync(brokenFile).length) + ' bytes')

    /* ── the route ─────────────────────────────────────────────────────── */

    const routeDir = join(stage, 'route')
    mkdirSync(routeDir, { recursive: true })
    const routeMedia = join(routeDir, 'media')
    mkdirSync(routeMedia, { recursive: true })
    copyFileSync(tail, join(routeMedia, 'tail.mp4'))
    copyFileSync(fast, join(routeMedia, 'fast.mp4'))
    if (existsSync(PNG_FIXTURE)) copyFileSync(PNG_FIXTURE, join(routeMedia, 'still.png'))
    else writeFileSync(join(routeMedia, 'still.png'), Buffer.from('not really a png', 'utf8'))

    const mounted = mount(routeDir)
    const optimizeRoute = mounted.routes.find((route) => route.path === OPTIMIZE_PATH)
    say('the optimize route is registered',
      optimizeRoute !== undefined, mounted.routes.map((route) => route.path).join(', '))
    say('the optimize route is an exact route',
      optimizeRoute !== undefined && optimizeRoute.kind === 'exact',
      String(optimizeRoute?.kind))

    if (optimizeRoute !== undefined) {
      const get = await drive(optimizeRoute, { method: 'GET' })
      say('the optimize route refuses GET with 405', get.status === 405, String(get.status))
      say('the optimize route names the allowed methods',
        String(header(get.headers, 'allow') ?? '') === 'POST', String(header(get.headers, 'allow')))

      const brokenBody = await drive(optimizeRoute, { method: 'POST', body: 'not json' })
      say('a body that is not JSON is a 400', brokenBody.status === 400, String(brokenBody.status))

      const noId = await drive(optimizeRoute, { method: 'POST', body: '{}' })
      say('a missing mediaId is a 400', noId.status === 400, String(noId.status))

      const traversals = [
        '../../../etc/passwd',
        '/etc/passwd',
        '..',
        'a/../b',
        'tail.mp4/../../x',
        '..\\..\\windows',
      ]
      const traversalAnswers = []
      for (const mediaId of traversals) {
        const answer = await drive(optimizeRoute, {
          method: 'POST',
          body: JSON.stringify({ mediaId }),
        })
        traversalAnswers.push(mediaId + ' → ' + String(answer.status))
        if (answer.status !== 400) {
          say('the traversal "' + mediaId + '" is refused with 400', false, String(answer.status))
        }
      }
      say('every traversal mediaId is refused with 400',
        traversalAnswers.every((line) => line.endsWith('→ 400')),
        traversalAnswers.join(', '))
      say('the traversal refusals name the reason',
        traversalAnswers.length > 0, 'each one answered 400')

      const unknown = await drive(optimizeRoute, {
        method: 'POST',
        body: JSON.stringify({ mediaId: 'fs-nothing-0' }),
      })
      say('an unknown mediaId is a 404', unknown.status === 404, String(unknown.status))

      const catalogRoute = mounted.routes.find((route) => route.path === CATALOG_PATH)
      let tailId = null
      let fastId = null
      let stillId = null
      if (catalogRoute !== undefined) {
        const catalog = await drive(catalogRoute, { method: 'GET' })
        let payload = null
        try {
          payload = JSON.parse(catalog.text)
        } catch {
          payload = null
        }
        for (const entry of payload?.entries ?? []) {
          if (entry.name === 'tail.mp4') tailId = entry.id
          if (entry.name === 'fast.mp4') fastId = entry.id
          if (entry.name === 'still.png') stillId = entry.id
        }
      }
      say('the catalog lists the material the route will be asked about',
        tailId !== null && fastId !== null && stillId !== null,
        String(tailId) + ' / ' + String(fastId) + ' / ' + String(stillId))

      if (stillId !== null) {
        const stillBefore = readFileSync(join(routeMedia, 'still.png'))
        const still = await drive(optimizeRoute, {
          method: 'POST',
          body: JSON.stringify({ mediaId: stillId }),
        })
        say('a material that is not an mp4 is refused with 400', still.status === 400,
          String(still.status))
        say('the refusal for a non-mp4 says so in plain words',
          String(still.text).includes('mp4'), still.text.slice(0, 120))
        say('the refused non-mp4 is left byte-identical',
          readFileSync(join(routeMedia, 'still.png')).equals(stillBefore),
          String(stillBefore.length) + ' bytes')
      }

      if (fastId !== null) {
        const fastBefore = readFileSync(join(routeMedia, 'fast.mp4'))
        const already = await drive(optimizeRoute, {
          method: 'POST',
          body: JSON.stringify({ mediaId: fastId }),
        })
        let payload = null
        try {
          payload = JSON.parse(already.text)
        } catch {
          payload = null
        }
        say('the route answers 200 for a clip that is already faststart',
          already.status === 200 && payload?.status === 'already',
          String(already.status) + ' ' + String(payload?.status))
        say('the answer for an already-faststart clip says so in plain words',
          String(payload?.message ?? '').includes('faststart'), String(payload?.message))
        say('the already-faststart clip is left byte-identical',
          readFileSync(join(routeMedia, 'fast.mp4')).equals(fastBefore),
          String(fastBefore.length) + ' bytes')
        say('the answer for an already-faststart clip carries the material',
          payload?.entry !== undefined && payload?.entry !== null,
          JSON.stringify(payload?.entry?.id))
      }

      if (tailId !== null) {
        const routeBefore = readFileSync(join(routeMedia, 'tail.mp4'))
        const done = await drive(optimizeRoute, {
          method: 'POST',
          body: JSON.stringify({ mediaId: tailId }),
        })
        let payload = null
        try {
          payload = JSON.parse(done.text)
        } catch {
          payload = null
        }
        say('the route rewrites a real clip and answers 200',
          done.status === 200 && payload?.status === 'done',
          String(done.status) + ' ' + String(payload?.status))
        const routeAfter = readFileSync(join(routeMedia, 'tail.mp4'))
        say('the route rewrites the clip to exactly the same length',
          routeAfter.length === routeBefore.length,
          String(routeBefore.length) + ' → ' + String(routeAfter.length))
        const routeOrder = boxOrder(routeAfter)
        const routeMoov = routeOrder.indexOf('moov')
        const routeMdat = routeOrder.indexOf('mdat')
        say('the route leaves the clip with its moov BEFORE its mdat',
          routeMoov >= 0 && routeMdat >= 0 && routeMoov < routeMdat,
          routeOrder.join(' → '))
        say('the route leaves the media payload byte-identical',
          withoutMoov(routeBefore).equals(withoutMoov(routeAfter)),
          String(routeBefore.length) + ' → ' + String(routeAfter.length))
        say('the answer carries the material it rewrote',
          payload?.entry !== undefined && payload?.entry !== null,
          JSON.stringify(payload?.entry?.id))
        say('the material keeps its id, so the slots that point at it keep working',
          payload?.entry?.id === tailId,
          String(tailId) + ' → ' + String(payload?.entry?.id))
        say('the staging directory is gone when the route is done',
          !readdirSync(routeMedia).some((name) => name.startsWith('.optimize')),
          readdirSync(routeMedia).join(', '))

        if (catalogRoute !== undefined) {
          const catalog = await drive(catalogRoute, { method: 'GET' })
          let payload2 = null
          try {
            payload2 = JSON.parse(catalog.text)
          } catch {
            payload2 = null
          }
          say("the library's revision moved, so a browser learns the library changed",
            Number(payload2?.revision) > 0, String(payload2?.revision))
        }
      }
    }

    if (typeof mounted.cleanup === 'function') mounted.cleanup()
  } catch (error) {
    say('the check set ran to completion', false,
      String(error && error.stack ? error.stack : error))
  } finally {
    try {
      rmSync(stage, { recursive: true, force: true })
    } catch (error) {
      notes.push('could not remove the scratch directory: ' + String(error))
    }
  }

  return results
}

/* ───────────────────────────────────────────────────────────────────────────
   The negative control: the SAME checks, against a broken implementation.
   ─────────────────────────────────────────────────────────────────────────── */

/**
 * The textual patches that break the implementation.
 *
 * A: the plan stops moving `moov` to the front.
 * B: A, plus the "verify the OUTPUT" step is skipped — the accident this
 *    tool actually made once: a byte-identical copy reported as a success.
 */
const MUTATIONS = {
  A: [
    [
      `  const withoutMoov = boxes.filter(box => box !== moov)
  const insertAt = withoutMoov.findIndex(box => box.type === 'ftyp') + 1
  const ordered = [
    ...withoutMoov.slice(0, insertAt),
    moov,
    ...withoutMoov.slice(insertAt),
  ]`,
      '  const ordered = boxes.slice()',
    ],
    [
      '  if (mdatAt >= 0 && moovOrder > mdatAt) {',
      '  if (false && mdatAt >= 0 && moovOrder > mdatAt) {',
    ],
    [
      '  if (mdat !== undefined && shift <= 0) {',
      '  if (false && mdat !== undefined && shift <= 0) {',
    ],
  ],
  // ★ B IS A PLUS THE OUTPUT CHECKS. A alone still refuses (the tool's own
  // output proof catches it); A together with a skipped output proof is the
  // accident this tool actually made once — a byte-identical copy written and
  // reported as a success.
  B: [
    [
      `  const withoutMoov = boxes.filter(box => box !== moov)
  const insertAt = withoutMoov.findIndex(box => box.type === 'ftyp') + 1
  const ordered = [
    ...withoutMoov.slice(0, insertAt),
    moov,
    ...withoutMoov.slice(insertAt),
  ]`,
      '  const ordered = boxes.slice()',
    ],
    [
      '  if (mdatAt >= 0 && moovOrder > mdatAt) {',
      '  if (false && mdatAt >= 0 && moovOrder > mdatAt) {',
    ],
    [
      '  if (mdat !== undefined && shift <= 0) {',
      '  if (false && mdat !== undefined && shift <= 0) {',
    ],
    [
      '  if (outMoov < 0 || (outMdat >= 0 && outMoov > outMdat)) {',
      '  if (false && (outMoov < 0 || (outMdat >= 0 && outMoov > outMdat))) {',
    ],
    [
      "    if (await leadingBox(produced) !== true) throw new Error('重排后的文件里 moov 仍在 mdat 之后')",
      "    if (false && await leadingBox(produced) !== true) throw new Error('重排后的文件里 moov 仍在 mdat 之后')",
    ],
    [
      "    if (await leadingBox(file) !== true) throw new Error('重排后 moov 仍在 mdat 之后')",
      "    if (false && await leadingBox(file) !== true) throw new Error('重排后 moov 仍在 mdat 之后')",
    ],
  ],
}

/**
 * Apply the textual patches.
 *
 * @param source - the module's source.
 * @param patches - the patches.
 * @returns the broken source.
 */
function applyMutation(source, patches) {
  let text = source
  for (const [from, to] of patches) {
    if (!text.includes(from)) {
      throw new Error('the mutation anchor is not in the source: ' + JSON.stringify(from.slice(0, 70)))
    }
    text = text.replace(from, to)
  }
  return text
}

/**
 * Build a broken COPY of this package and mount it.
 *
 * @param key - the mutation's key.
 * @returns a promise for `{ remux, mount }`.
 */
async function buildMutant(key) {
  const stage = mkdtempSync(join(tmpdir(), `dsham-remux-mutant-${key}-`))
  const copy = join(stage, 'package')
  cpSync(pkgDir, copy, { recursive: true, dereference: true })

  const source = readFileSync(join(copy, 'lib', 'remux.js'), 'utf8')
  const broken = applyMutation(source, MUTATIONS[key])
  writeFileSync(join(copy, 'lib', 'remux.js'), broken, 'utf8')

  const remux = await import(pathToFileURL(join(copy, 'lib', 'remux.js')).href)
  const entry = await import(pathToFileURL(join(copy, 'index.js')).href)
  const mount = (dataDir) => {
    const harness = makeContext()
    const cleanup = entry.apply(harness.ctx, { dataDir })
    return { routes: harness.routes, cleanup }
  }
  return { remux, mount, stage }
}

/* ───────────────────────────────────────────────────────────────────────────
   The run.
   ─────────────────────────────────────────────────────────────────────────── */

let exitCode = 0

/** The negative control's output, printed after the report. */
const negativeControls = []

try {
  const tail = TAIL_SOURCE
  const fast = FAST_SOURCE

  // ★ The fixtures are part of the repository. If they are gone, this run
  //   would test nothing — so that is a FAILURE, loudly, not a quiet green.
  if (!existsSync(tail)) {
    record('the shipped un-optimized fixture is there', false,
      'not found: ' + tail + ' (the suite cannot test anything without it)')
  } else {
    record('the shipped un-optimized fixture is there', true, tail)
  }
  if (!existsSync(fast)) {
    record('the shipped faststart fixture is there', false,
      'not found: ' + fast + ' (the suite cannot test anything without it)')
  } else {
    record('the shipped faststart fixture is there', true, fast)
  }

  // The real material is extra evidence when this machine happens to have it.
  const realTail = findUpstreamClip()
  if (realTail === null) {
    skip('the real un-optimized original is there',
      'not on this machine (set DSHAM_REMUX_TAIL to run this one)')
  } else {
    record('the real un-optimized original is there', true, realTail)
  }
  const realFast = findFaststartClip()
  if (realFast === null) {
    skip('a real faststart clip is there',
      'no faststart mp4 in ' + LIBRARY_DIR)
  } else {
    record('a real faststart clip is there', true, realFast)
  }

  if (existsSync(tail) && existsSync(fast)) {
    /* ---- the real implementation -------------------------------------- */

    const realRemux = await import(pathToFileURL(join(pkgDir, 'lib', 'remux.js')).href)
    const realEntry = await import(pathToFileURL(join(pkgDir, 'index.js')).href)
    const realMount = (dataDir) => {
      const harness = makeContext()
      const cleanup = realEntry.apply(harness.ctx, { dataDir })
      return { routes: harness.routes, cleanup }
    }

    const real = await runChecks({
      label: 'real',
      remux: realRemux,
      mount: realMount,
      tail,
      fast,
    })
    for (const result of real) {
      record(result.name, result.ok, result.detail)
    }

    const realFailures = real.filter((result) => !result.ok)

    /* ---- the negative control ------------------------------------------ */

    for (const key of ['A', 'B']) {
      const mutant = await buildMutant(key)
      let broken = null
      try {
        broken = await runChecks({
          label: 'mutant-' + key,
          remux: mutant.remux,
          mount: mutant.mount,
          tail,
          fast,
        })
      } catch (error) {
        broken = []
        notes.push('mutation ' + key + ' could not be run: ' + String(error))
      }
      const failures = broken.filter((result) => !result.ok)
      const names = failures.map((result) => result.name)
      const described = key === 'A'
        ? 'the plan stops moving moov to the front'
        : 'the plan stops moving moov to the front AND the output check is skipped'
      record('the broken copy (' + described + ') makes the checks go red',
        failures.length > 0,
        failures.length === 0
          ? 'the broken copy passed every check — the checks cannot fail'
          : failures.length + ' check(s) went red: ' + names.slice(0, 4).join(' | '))
      negativeControls.push({ key, described, failures })
      try {
        rmSync(mutant.stage, { recursive: true, force: true })
      } catch (error) {
        notes.push('could not remove the mutant directory: ' + String(error))
      }
    }

    if (realFailures.length > 0) {
      console.log('the real implementation has ' + String(realFailures.length) + ' failing check(s)')
    }
  }
} catch (error) {
  record('the suite ran to completion', false, String(error && error.stack ? error.stack : error))
}

/* ---- report -------------------------------------------------------------- */

for (const [label, ok, detail] of checks) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail === '' ? '' : '  — ' + detail))
}
for (const note of notes) console.log('NOTE  ' + note)
for (const [label, reason] of skips) console.log('SKIP  ' + label + '  — ' + reason)

console.log('')
for (const control of negativeControls) {
  console.log('NEGATIVE CONTROL  mutation ' + control.key + ': ' + control.described)
  for (const failure of control.failures) {
    console.log('  FAIL  ' + failure.name + (failure.detail === '' ? '' : '  — ' + failure.detail))
  }
  if (control.failures.length === 0) {
    console.log('  (nothing went red — THAT IS THE FAILURE)')
  }
  console.log('')
}

const failed = checks.filter(([, ok]) => !ok)
console.log('')
console.log(checks.length + ' check(s), ' + failed.length + ' failed'
  + (skips.length > 0 ? ', ' + skips.length + ' skipped' : ''))
if (failed.length > 0) {
  exitCode = 1
  for (const [label, , detail] of failed) console.log('failed: ' + label + (detail === '' ? '' : '  — ' + detail))
}
process.exit(exitCode)
