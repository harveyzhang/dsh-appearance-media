#!/usr/bin/env node
// dsh-appearance-media — offline acceptance for the media library.
//
// TWENTY-SEVEN ASSERTIONS, and every one of them can fail because the
// implementation is wrong. They are the assertions Task 1's suite does not
// have: Task 1 proved the SKELETON (two routes, a config, an injected row);
// this suite proves the LIBRARY (a catalog that is not empty, an upload that
// lands, bytes that come back, a revision that moves).
//
// THE ONES THAT MATTER MOST, and what each of them catches:
//
//   #6  the id the upload route answers with must be the id the catalog lists,
//       and `GET /media/<that id>` must serve the same number of bytes — this
//       is the check that fails when the id is rebuilt from the file name the
//       wrong way (`fs-…` for an uploaded file), which is invisible to every
//       other assertion;
//   #16 the media route's `Cache-Control` must be EXACTLY `no-store`, on the
//       200 and on the 206 — a `no-cache` there is how a truncated body gets
//       cached;
//   #24 the catalog's revision must be the LEDGER's, and it must move with
//       every import — the controller downstream compares it to decide "did
//       the library change", and a revision that never moves is dead code;
//   #25 a configured `catalogRevision` must NOT move it any more — the field
//       is gone, and a stale config key must not bring it back.
//   #26 the SHAPE check itself must be able to fail — it is fed the exact
//       broken source the browser review found (a reader that is RETURNED but
//       never CALLED) and must report it; a check that cannot fail is not a
//       check;
//   #27 neither `src/client.js` nor the built `lib/client.js` may contain
//       such a shape — this is the assertion that would have caught the panel
//       that sat on "0 entries" forever while every curl assertion stayed
//       green.
//
// How it runs: it copies this package to a scratch directory, imports the copy,
// mounts the REAL `apply()` with a stub Host context, and drives the routes
// the plugin actually registered. It never starts DSH and never binds a port.
//
// The media library under test is a TEMPORARY directory (assertion #22): the
// default directory is the user's real library, and a suite that wrote into it
// would be a suite that fails on any machine where the plugin was ever used.
//
// Usage: node tools/verify-catalog.mjs

import { createHash } from 'node:crypto'
import { cpSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgDir = fileURLToPath(new URL('..', import.meta.url))

const fixturesDir = process.env.DSHAM_FIXTURES !== undefined && process.env.DSHAM_FIXTURES !== ''
  ? process.env.DSHAM_FIXTURES
  : fileURLToPath(new URL('./fixtures', import.meta.url))

const CATALOG_PATH = '/appearance-media/catalog.json'
const HEALTH_PATH = '/appearance-media/health'
const UPLOAD_PATH = '/appearance-media/upload'
const REMOVE_PATH = '/appearance-media/remove'
const MEDIA_PATH = '/appearance-media/media'

/** The upload limit, mirrored from lib/upload.js. */
const MAX_UPLOAD_BYTES = 96 * 1024 * 1024

/** @type {Array<[string, boolean, string]>} */
const checks = []
/** @type {string[]} */
const notes = []

/**
 * Record one assertion.
 *
 * @param label - what is asserted.
 * @param ok - whether it holds.
 * @param detail - the evidence, printed next to the label.
 */
function record(label, ok, detail = '') {
  checks.push([label, Boolean(ok), detail])
}

/**
 * Find call sites of a reader FACTORY whose result is never invoked.
 *
 * The shape bug the browser review found: `readCatalog(...)` returns the
 * function that performs the read, so `return readCatalog(setCatalog,
 * setError)` hands the caller a function instead of reading anything — the
 * panel then sits on "0 entries" forever while every HTTP assertion stays
 * green. A shape like that is invisible to a curl-based suite, so it needs a
 * source-level check.
 *
 * A call site is considered INVOKED when either
 *   (a) the call is immediately invoked — `readCatalog(...)()`; or
 *   (b) the call is assigned to an identifier that is called later —
 *       `const read = readCatalog(...); read()`.
 * The definition itself (`function readCatalog(`) is not a call site.
 *
 * @param source - the JavaScript source to scan.
 * @param name - the factory's name.
 * @returns a list of human-readable problems; empty means every call is invoked.
 */
function findUninvokedReaderCalls(source, name) {
  const problems = []
  const pattern = new RegExp('\\b' + name + '\\s*\\(', 'g')
  let match
  while ((match = pattern.exec(source)) !== null) {
    const at = match.index
    const before = source.slice(0, at)
    if (/function\s+$/.test(before)) continue // the definition itself

    // find the matching closing parenthesis of this call
    let depth = 0
    let close = -1
    for (let i = at + match[0].length - 1; i < source.length; i++) {
      const ch = source[i]
      if (ch === '(') depth++
      else if (ch === ')') {
        depth--
        if (depth === 0) { close = i; break }
      }
    }
    if (close < 0) {
      problems.push('unbalanced call at offset ' + String(at))
      continue
    }

    const after = source.slice(close + 1)
    if (/^\s*\(/.test(after)) continue // (a) invoked immediately

    const line = before.slice(before.lastIndexOf('\n') + 1)
    const assigned = line.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/)
    if (assigned) {
      const identifier = assigned[1]
      const calledLater = new RegExp('\\b' + identifier + '\\s*\\(').test(after)
      if (calledLater) continue // (b) assigned and called later
      problems.push('`' + name + '` is assigned to `' + identifier + '`, but `' + identifier + '` is never called')
      continue
    }
    problems.push('`' + name + '` is called, but its result is never invoked')
  }
  return problems
}

/**
 * Read one header case-insensitively.
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
 * The fake response.
 *
 * ★ IT IS A REAL `Writable`, NOT AN OBJECT WITH TWO METHODS. The media route
 * serves its bytes with `createReadStream(…).pipe(res)`, so the response has
 * to be a real stream: a hand-rolled fake would make the SUITE's defect look
 * like the CODE's defect.
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
   *
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
   *
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
 * @returns a promise for `{ status, headers, body, text, res }`.
 */
function drive(route, options = {}) {
  return new Promise((resolve) => {
    const res = new FakeResponse()
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve({ status: res.status, headers: res.headers, body: res.body, text: res.text, res })
    }
    res.on('finish', finish)
    res.on('close', finish)
    // A handler that never answers must not hang the suite.
    const timer = setTimeout(finish, 15000)
    if (typeof timer.unref === 'function') timer.unref()
    let result
    try {
      result = route.handler(makeRequest(options), res)
    } catch (error) {
      clearTimeout(timer)
      resolve({ status: 0, headers: {}, body: Buffer.alloc(0), text: String(error), res })
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
 * @param options - `failOnRegister` makes the Nth `register` call throw.
 * @returns the stub context and its recordings.
 */
function makeContext(options = {}) {
  const routes = []
  const listeners = new Map()
  const disposers = []
  const services = new Map()
  const failOnRegister = options.failOnRegister
  let registerCount = 0

  const ctx = {
    webServer: {
      register(route) {
        registerCount += 1
        if (failOnRegister !== undefined && registerCount === failOnRegister) {
          throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
        }
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

/**
 * Whether a path holds a symbolic link, anywhere below it.
 *
 * @param root - the directory to walk.
 * @returns true when a link is found.
 */
function hasSymbolicLink(root) {
  for (const name of readdirSync(root)) {
    const absolute = join(root, name)
    const info = lstatSync(absolute)
    if (info.isSymbolicLink()) return true
    if (info.isDirectory() && hasSymbolicLink(absolute)) return true
  }
  return false
}

let stage = null
let dataDir = null
let exitCode = 0

try {
  // The scratch copy: what `import()` sees. `dereference: true`, because an
  // installed `node_modules` is full of symlinks and a copy that keeps them
  // points back at the real tree.
  stage = mkdtempSync(join(tmpdir(), 'dsh-appearance-media-catalog-'))
  cpSync(pkgDir, stage, { recursive: true, dereference: true })

  // The library under test: a TEMPORARY directory, never the user's own.
  dataDir = mkdtempSync(join(tmpdir(), 'dsh-appearance-media-data-'))

  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')) }
  let entry
  try {
    entry = await import(pathToFileURL(join(stage, 'index.js')).href)
  } finally {
    console.warn = originalWarn
  }
  for (const warning of warnings) notes.push('import warning: ' + warning)

  const catalogModule = await import(pathToFileURL(join(stage, 'lib/catalog.js')).href)
  const storeModule = await import(pathToFileURL(join(stage, 'lib/store.js')).href)

  const harness = makeContext()
  const cleanup = entry.apply(harness.ctx, { dataDir })
  const route = (kind, path) => harness.routes.find((item) => item.kind === kind && item.path === path)
  const catalogRoute = route('exact', CATALOG_PATH)
  const uploadRoute = route('exact', UPLOAD_PATH)
  const removeRoute = route('exact', REMOVE_PATH)
  const mediaRoute = route('prefix', MEDIA_PATH)

  const mediaPath = join(dataDir, 'media')

  /**
   * Read the catalog.
   *
   * @returns the parsed body.
   */
  const readCatalog = async () => {
    const answer = await drive(catalogRoute, { method: 'GET', url: CATALOG_PATH })
    let payload = null
    try {
      payload = JSON.parse(answer.text)
    } catch {
      payload = null
    }
    return { answer, payload }
  }

  /**
   * Upload one file.
   *
   * @param options - `filename`, `contentType`, `body`.
   * @returns the answer.
   */
  const upload = async ({ filename, contentType, body }) => drive(uploadRoute, {
    method: 'POST',
    url: UPLOAD_PATH,
    headers: {
      'content-type': contentType,
      'x-dsh-filename': filename,
    },
    body,
  })

  const mp4 = readFileSync(join(fixturesDir, 'sample-faststart.mp4'))
  const webm = readFileSync(join(fixturesDir, 'sample.webm'))
  const png = readFileSync(join(fixturesDir, 'sample.png'))
  const psd = readFileSync(join(fixturesDir, 'unsupported.psd'))

  /* ---- #1 the media directory does not exist ------------------------- */

  {
    const { answer, payload } = await readCatalog()
    record('#1 a missing media directory answers 200 with no entries and no skips',
      answer.status === 200
      && payload !== null
      && Array.isArray(payload.entries) && payload.entries.length === 0
      && Array.isArray(payload.skipped) && payload.skipped.length === 0,
      'status=' + String(answer.status) + ' body=' + answer.text)
  }

  /* ---- #2 the media directory exists and is empty --------------------- */

  mkdirSync(mediaPath, { recursive: true })
  {
    const { answer, payload } = await readCatalog()
    record('#2 an empty media directory answers 200 with no entries and no skips',
      answer.status === 200
      && payload !== null
      && Array.isArray(payload.entries) && payload.entries.length === 0
      && Array.isArray(payload.skipped) && payload.skipped.length === 0,
      'status=' + String(answer.status) + ' body=' + answer.text)
  }

  /* ---- #3 a hand-placed .mp4 becomes one entry ----------------------- */

  writeFileSync(join(mediaPath, 'sample-faststart.mp4'), mp4)
  {
    const { payload } = await readCatalog()
    const entry0 = payload?.entries?.[0]
    record('#3 a hand-placed .mp4 is one entry with kind, license, hash and mediaUrl',
      payload?.entries?.length === 1
      && entry0?.kind === 'video'
      && entry0?.license === 'unknown'
      && typeof entry0?.contentHash === 'string' && entry0.contentHash.startsWith('sha256:')
      && entry0?.mediaUrl === MEDIA_PATH + '/' + entry0?.id
      && entry0?.source === 'library',
      JSON.stringify(payload?.entries?.[0]))
  }

  /* ---- #4 a hand-placed .psd is skipped, with a reason ---------------- */

  writeFileSync(join(mediaPath, 'unsupported.psd'), psd)
  {
    const { payload } = await readCatalog()
    const skipped = payload?.skipped?.[0]
    record('#4 a hand-placed .psd is skipped with a reason and no absolute path',
      payload?.skipped?.length === 1
      && typeof skipped?.reason === 'string' && skipped.reason !== ''
      && typeof skipped?.name === 'string' && !skipped.name.includes('/')
      && !String(skipped?.reason ?? '').includes(dataDir),
      JSON.stringify(payload?.skipped))
  }

  /* ---- #5 the routes exist by identity -------------------------------- */

  record('#5 the catalog is an exact route and the media route is a prefix without a trailing slash',
    catalogRoute !== undefined
    && mediaRoute !== undefined
    && mediaRoute.path === MEDIA_PATH
    && !mediaRoute.path.endsWith('/')
    && uploadRoute !== undefined
    && removeRoute !== undefined,
    harness.routes.map((item) => item.kind + ':' + item.path).join(', '))

  /* ---- #6 the uploaded id is the catalog's id, and its bytes come back - */

  let uploadedId = ''
  {
    const answer = await upload({ filename: 'sample-faststart.mp4', contentType: 'video/mp4', body: mp4 })
    let payload = null
    try {
      payload = JSON.parse(answer.text)
    } catch {
      payload = null
    }
    uploadedId = payload?.entry?.id ?? ''
    const catalog = await readCatalog()
    const listed = (catalog.payload?.entries ?? []).find((item) => item.id === uploadedId)
    const media = await drive(mediaRoute, { method: 'GET', url: MEDIA_PATH + '/' + uploadedId })
    record('#6 the uploaded id is in the catalog and its bytes are served back',
      answer.status === 200
      && payload?.ok === true
      && typeof uploadedId === 'string' && uploadedId !== ''
      // ★ The name the CLIENT sent is the name the library keeps — not the
      // on-disk file name. A scan-based lookup would answer `up-<sha12>.mp4`
      // and the user would never see the name they chose.
      && payload?.entry?.name === 'sample-faststart.mp4'
      && listed !== undefined
      && media.status === 200
      && media.body.length === mp4.length,
      'upload=' + answer.text + ' id=' + uploadedId
      + ' listed=' + String(listed !== undefined)
      + ' media=' + String(media.status) + '/' + String(media.body.length) + 'B')
  }

  /* ---- #7 the same content twice is one entry ------------------------- */

  {
    const before = (await readCatalog()).payload?.entries?.length ?? -1
    const answer = await upload({ filename: 'sample-faststart.mp4', contentType: 'video/mp4', body: mp4 })
    let payload = null
    try {
      payload = JSON.parse(answer.text)
    } catch {
      payload = null
    }
    const after = (await readCatalog()).payload?.entries?.length ?? -1
    record('#7 uploading the same content again answers duplicate and does not grow the catalog',
      answer.status === 200
      && payload?.duplicate === true
      && payload?.entry?.id === uploadedId
      && after === before,
      'status=' + String(answer.status) + ' duplicate=' + String(payload?.duplicate)
      + ' entries ' + String(before) + '→' + String(after))
  }

  /* ---- #8 a scanned entry serves its bytes too ------------------------ */

  {
    const catalog = await readCatalog()
    const scanned = (catalog.payload?.entries ?? []).find((item) => item.source === 'library')
    const media = await drive(mediaRoute, { method: 'GET', url: MEDIA_PATH + '/' + (scanned?.id ?? '') })
    record('#8 a scanned (fs-) entry serves its bytes',
      scanned !== undefined
      && typeof scanned.id === 'string' && scanned.id.startsWith('fs-')
      && media.status === 200
      && media.body.length === mp4.length,
      'id=' + String(scanned?.id) + ' status=' + String(media.status)
      + ' bytes=' + String(media.body.length))
  }

  /* ---- #9 an unknown id is 404 ---------------------------------------- */

  {
    const media = await drive(mediaRoute, { method: 'GET', url: MEDIA_PATH + '/up-000000000000' })
    record('#9 an unknown id answers 404', media.status === 404, 'status=' + String(media.status))
  }

  /* ---- #10 a path-escaping id is 404, and no sourcePath escapes ------- */

  {
    const media = await drive(mediaRoute, { method: 'GET', url: MEDIA_PATH + '/fs-..%2F..%2F..%2Fetc%2Fpasswd-0' })
    const internal = catalogModule.listCatalog(dataDir)
    const outside = internal.entries.filter((item) => !item.sourcePath.startsWith(mediaPath + '/'))
    record('#10 a path-escaping id answers 404 and every sourcePath stays inside the media directory',
      media.status === 404
      && internal.entries.length > 0
      && outside.length === 0,
      'status=' + String(media.status) + ' outside=' + String(outside.length))
  }

  /* ---- #11 a file name with a path separator is refused ---------------- */

  {
    const answer = await upload({ filename: 'a/b.mp4', contentType: 'video/mp4', body: mp4 })
    const names = readdirSync(mediaPath)
    const withSeparator = names.filter((name) => name.includes('/') || name.includes('\\'))
    const entries = catalogModule.listCatalog(dataDir).entries
    const badName = entries.filter((item) => item.name.includes('/') || item.name.includes('\\'))
    record('#11 a file name with a path separator is refused and nothing lands with one',
      answer.status === 400
      && withSeparator.length === 0
      && badName.length === 0
      && !readdirSync(mediaPath).includes('a'),
      'status=' + String(answer.status) + ' names=' + names.join(','))
  }

  /* ---- #12 a MIME that disagrees with the extension is 415 ------------- */

  {
    const answer = await upload({ filename: 'x.png', contentType: 'video/mp4', body: png })
    record('#12 a MIME that disagrees with the extension answers 415',
      answer.status === 415, 'status=' + String(answer.status) + ' body=' + answer.text)
  }

  /* ---- #13 an unsupported MIME is 415 --------------------------------- */

  {
    const answer = await upload({ filename: 'x.gif', contentType: 'image/gif', body: psd })
    record('#13 an unsupported MIME answers 415',
      answer.status === 415, 'status=' + String(answer.status) + ' body=' + answer.text)
  }

  /* ---- #14 an over-sized upload is 413 and leaves nothing behind ------ */

  {
    const answer = await upload({
      filename: 'huge.mp4',
      contentType: 'video/mp4',
      body: Buffer.alloc(MAX_UPLOAD_BYTES + 1, 1),
    })
    const leftovers = readdirSync(mediaPath).filter((name) => name.endsWith('.part'))
    record('#14 an over-sized upload answers 413 and leaves no .part file',
      answer.status === 413 && leftovers.length === 0,
      'status=' + String(answer.status) + ' leftovers=' + leftovers.join(','))
  }

  /* ---- #15 an empty body is 400 --------------------------------------- */

  {
    const answer = await upload({ filename: 'empty.mp4', contentType: 'video/mp4', body: Buffer.alloc(0) })
    record('#15 an empty upload answers 400',
      answer.status === 400, 'status=' + String(answer.status) + ' body=' + answer.text)
  }

  /* ---- #16 the media bytes are never cacheable ------------------------ */

  {
    const full = await drive(mediaRoute, { method: 'GET', url: MEDIA_PATH + '/' + uploadedId })
    const part = await drive(mediaRoute, {
      method: 'GET',
      url: MEDIA_PATH + '/' + uploadedId,
      headers: { range: 'bytes=0-99' },
    })
    record('#16 the media route answers Cache-Control: no-store exactly, on the 200 and on the 206',
      header(full.headers, 'cache-control') === 'no-store'
      && header(part.headers, 'cache-control') === 'no-store'
      && part.status === 206,
      '200=' + String(header(full.headers, 'cache-control'))
      + ' 206=' + String(header(part.headers, 'cache-control')))
  }

  /* ---- #17 a Range request is answered with 206 ------------------------ */

  {
    const size = statSync(join(mediaPath, uploadedId + '.mp4')).size
    const part = await drive(mediaRoute, {
      method: 'GET',
      url: MEDIA_PATH + '/' + uploadedId,
      headers: { range: 'bytes=0-99' },
    })
    record('#17 a Range request answers 206 with the right Content-Range and Accept-Ranges',
      part.status === 206
      && header(part.headers, 'content-range') === 'bytes 0-99/' + String(size)
      && header(part.headers, 'accept-ranges') === 'bytes'
      && part.body.length === 100,
      'status=' + String(part.status) + ' range=' + String(header(part.headers, 'content-range'))
      + ' bytes=' + String(part.body.length))
  }

  /* ---- #18 an unsatisfiable and an unparsable Range are both 416 ------ */

  {
    const size = statSync(join(mediaPath, uploadedId + '.mp4')).size
    const tooFar = await drive(mediaRoute, {
      method: 'GET',
      url: MEDIA_PATH + '/' + uploadedId,
      headers: { range: 'bytes=999999999-' },
    })
    const broken = await drive(mediaRoute, {
      method: 'GET',
      url: MEDIA_PATH + '/' + uploadedId,
      headers: { range: 'bytes=abc' },
    })
    record('#18 an unsatisfiable Range and an unparsable Range both answer 416',
      tooFar.status === 416
      && broken.status === 416
      && header(tooFar.headers, 'content-range') === 'bytes */' + String(size),
      'tooFar=' + String(tooFar.status) + ' broken=' + String(broken.status)
      + ' content-range=' + String(header(tooFar.headers, 'content-range')))
  }

  /* ---- #19 two concurrent uploads of one content leave one file ------ */

  {
    const before = readdirSync(mediaPath).filter((name) => name.startsWith('up-')).length
    const answers = await Promise.all([
      upload({ filename: 'a.webm', contentType: 'video/webm', body: webm }),
      upload({ filename: 'b.webm', contentType: 'video/webm', body: webm }),
    ])
    const after = readdirSync(mediaPath).filter((name) => name.startsWith('up-'))
    const ledger = storeModule.readLedger(dataDir)
    const webmHash = 'sha256:' + createHash('sha256').update(webm).digest('hex')
    const webmEntries = Object.keys(ledger.entries).filter((id) => ledger.entries[id].contentHash === webmHash)
    record('#19 two concurrent uploads of the same content leave one file and one ledger entry',
      answers.every((answer) => answer.status === 200)
      && after.length === before + 1
      && webmEntries.length === 1
      && answers.some((answer) => answer.text.includes('"duplicate":true')),
      'files ' + String(before) + '→' + String(after.length)
      + ' ledgerEntries=' + String(webmEntries.length)
      + ' statuses=' + answers.map((answer) => String(answer.status)).join(','))
  }

  /* ---- #20 nothing published carries an absolute path ------------------ */

  {
    const { answer } = await readCatalog()
    record('#20 neither the entries nor the skipped list carries an absolute path',
      !answer.text.includes(dataDir)
      && !answer.text.includes(homedir())
      && !answer.text.includes('"sourcePath"'),
      'body=' + answer.text.slice(0, 400))
  }

  /* ---- #21 the fake response is a real Writable ----------------------- */

  {
    const answer = await drive(mediaRoute, { method: 'GET', url: MEDIA_PATH + '/' + uploadedId })
    record('#21 the media route is driven through a real Writable response',
      answer.res instanceof Writable
      && answer.status === 200
      && answer.body.length === mp4.length,
      'instanceof Writable=' + String(answer.res instanceof Writable)
      + ' bytes=' + String(answer.body.length))
  }

  /* ---- #22 the library under test is a temporary directory ------------- */

  {
    record('#22 the media directory under test is a temporary directory, not the default one',
      dataDir.startsWith(tmpdir())
      && dataDir !== join(homedir(), '.dsh', 'dsh-appearance-media'),
      'dataDir=' + dataDir)
  }

  /* ---- #23 the scratch copy carries no symbolic link ------------------- */

  {
    record('#23 the scratch copy was made with dereference, so it carries no symbolic link',
      hasSymbolicLink(stage) === false,
      'stage=' + stage)
  }

  /* ---- #24 the revision is the ledger's, and it moves ------------------ */

  {
    const ledgerBefore = storeModule.ledgerRevision(dataDir)
    const reportedBefore = (await readCatalog()).payload?.revision
    const first = await upload({ filename: 'one.webm', contentType: 'video/webm', body: webm })
    const ledgerAfterFirst = storeModule.ledgerRevision(dataDir)
    const reportedAfterFirst = (await readCatalog()).payload?.revision
    const second = await upload({ filename: 'two.png', contentType: 'image/png', body: png })
    const ledgerAfterSecond = storeModule.ledgerRevision(dataDir)
    const reportedAfterSecond = (await readCatalog()).payload?.revision
    record('#24 the catalog\'s revision is the ledger\'s, and every import moves it',
      reportedBefore === ledgerBefore
      && first.status === 200
      && ledgerAfterFirst === ledgerBefore + 1
      && reportedAfterFirst === ledgerAfterFirst
      && second.status === 200
      && ledgerAfterSecond === ledgerAfterFirst + 1
      && reportedAfterSecond === ledgerAfterSecond,
      'ledger ' + String(ledgerBefore) + '→' + String(ledgerAfterFirst) + '→' + String(ledgerAfterSecond)
      + ' reported ' + String(reportedBefore) + '→' + String(reportedAfterFirst) + '→' + String(reportedAfterSecond))
  }

  /* ---- #25 a configured catalogRevision moves nothing ------------------ */

  {
    const ledgerRevision = storeModule.ledgerRevision(dataDir)
    const other = makeContext()
    const otherCleanup = entry.apply(other.ctx, { dataDir, catalogRevision: 99 })
    const otherCatalog = other.routes.find((item) => item.kind === 'exact' && item.path === CATALOG_PATH)
    const answer = await drive(otherCatalog, { method: 'GET', url: CATALOG_PATH })
    let payload = null
    try {
      payload = JSON.parse(answer.text)
    } catch {
      payload = null
    }
    if (typeof otherCleanup === 'function') otherCleanup()
    record('#25 a configured catalogRevision does not move the catalog\'s revision any more',
      payload?.revision === ledgerRevision && payload?.revision !== 99,
      'ledger=' + String(ledgerRevision) + ' reported=' + String(payload?.revision))
  }

  /* ---- #26 the shape check can actually fail --------------------------- */

  {
    // The EXACT shape the browser review found: the reader is RETURNED but
    // never CALLED. The panel then believes it read the catalog while
    // nothing was ever fetched — every curl assertion stayed green.
    const brokenSource = [
      'function readCatalog(setter, setError) { return function () { return 1 } }',
      'const reload = React.useCallback(function () { return readCatalog(setCatalog, setError) }, [])',
    ].join('\n')
    const fixedSource = [
      'function readCatalog(setter, setError) { return function () { return 1 } }',
      'const reload = React.useCallback(function () { return readCatalog(setCatalog, setError)() }, [])',
    ].join('\n')
    const brokenProblems = findUninvokedReaderCalls(brokenSource, 'readCatalog')
    const fixedProblems = findUninvokedReaderCalls(fixedSource, 'readCatalog')
    record('#26 the reader-shape check can fail: it flags the broken shape and clears the fixed one',
      brokenProblems.length === 1 && fixedProblems.length === 0,
      'broken=' + JSON.stringify(brokenProblems) + ' fixed=' + JSON.stringify(fixedProblems))
  }

  /* ---- #27 no uninvoked reader call in the sources or the product ------- */

  {
    const targets = [
      join(pkgDir, 'src', 'client.js'),
      join(pkgDir, 'lib', 'client.js'),
    ]
    const found = []
    let readable = 0
    for (const file of targets) {
      let text = ''
      try {
        text = readFileSync(file, 'utf8')
      } catch (error) {
        found.push(file + ': unreadable (' + String(error) + ')')
        continue
      }
      readable++
      const problems = findUninvokedReaderCalls(text, 'readCatalog')
      for (const problem of problems) found.push(file + ': ' + problem)
    }
    record('#27 neither the source nor the built product returns a reader without calling it',
      readable === targets.length && found.length === 0,
      found.length === 0 ? 'checked ' + String(readable) + ' file(s)' : found.join(' | '))
  }

  if (typeof cleanup === 'function') cleanup()
} catch (error) {
  record('the suite ran to completion', false, String(error && error.stack ? error.stack : error))
} finally {
  for (const dir of [stage, dataDir]) {
    if (dir === null) continue
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      notes.push('could not remove ' + dir + ': ' + String(error))
    }
  }
}

/* ---- report ---------------------------------------------------------- */

for (const [label, ok, detail] of checks) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail === '' ? '' : '  — ' + detail))
}
for (const note of notes) console.log('NOTE  ' + note)

const failed = checks.filter(([, ok]) => !ok)
console.log('')
console.log(checks.length + ' check(s), ' + failed.length + ' failed')
if (failed.length > 0) {
  exitCode = 1
  for (const [label, , detail] of failed) console.log('failed: ' + label + (detail === '' ? '' : '  — ' + detail))
}
process.exit(exitCode)
