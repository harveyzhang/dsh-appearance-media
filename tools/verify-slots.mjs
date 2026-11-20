#!/usr/bin/env node
// dsh-appearance-media — offline acceptance for the slot configuration.
//
// How it runs: it copies this package to a scratch directory, imports the copy,
// mounts the REAL `apply()` with a stub Host context, and drives the routes
// the plugin actually registered. It never starts DSH and never binds a port.
//
// ★ EVERY ASSERTION HERE CAN FAIL BECAUSE THE IMPLEMENTATION IS WRONG, AND
// MOST OF THEM ARE THE SEVEN HOLES THE REVIEW FOUND:
//
//   D3-1  the write queue: two PUTs on two DIFFERENT slots must both land and
//         the revision must move by two; two PUTs on the SAME slot must not be
//         merged — the later one wins;
//   D3-2  a failed write must leave the previous file BYTE FOR BYTE intact;
//   D3-3  `Cache-Control` must be EXACTLY `no-store`;
//   D3-4  a refused `mediaId` must leave the file on disk byte for byte
//         unchanged — "the read-back is unchanged" would also pass for a
//         "write then roll back" implementation;
//   D3-5  a 405 must carry an `Allow` header;
//   D3-6  the revision must survive a restart (re-read from the disk);
//   D3-7  the answer must carry the key names the browser half reads —
//         `slots.background.mediaId`, NOT `slots.background.id`.
//
// The data directory under test is a TEMPORARY directory that DOES NOT EXIST
// YET: the first GET has to answer 200 with the defaults and create nothing.
//
// Usage: node tools/verify-slots.mjs

import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgDir = fileURLToPath(new URL('..', import.meta.url))

// The fixtures live in the project's `.sdd` directory, outside the package —
// they are test material, not shipped material.
const fixturesDir = process.env.DSHAM_FIXTURES !== undefined && process.env.DSHAM_FIXTURES !== ''
  ? process.env.DSHAM_FIXTURES
  : fileURLToPath(new URL('../../../.sdd/appearance-media/fixtures', import.meta.url))

const SLOTS_PATH = '/appearance-media/slots'
const CATALOG_PATH = '/appearance-media/catalog.json'
const MEDIA_PATH = '/appearance-media/media'
const UPLOAD_PATH = '/appearance-media/upload'
const REMOVE_PATH = '/appearance-media/remove'

/** The largest request body the route accepts, mirrored from lib/routes/slots.js. */
const BODY_LIMIT = 16 * 1024

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
 * A real `Writable`, so a handler that streams its answer is exercised the
 * same way the Host exercises it.
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
 * ★ IT RECORDS WHETHER THE HANDLER KILLED THE REQUEST STREAM.
 *
 * `req.destroy()` closes the socket BEFORE the answer is written, so a real
 * client never sees the status code — it sees "Empty reply from server"
 * (curl exits 52). The offline stub has no socket, so the suite could not see
 * that at all: the answer looked perfect (400) while the machine was broken.
 * This flag makes the difference visible.
 *
 * `destroyOnReturn: false` and `autoDestroy: false` — the stub must not
 * destroy ITSELF: `Readable` destroys itself when the body ends (that is
 * `autoDestroy`, on by default), and the flag would then be set by the stub
 * instead of by the handler.
 *
 * @param options - `method`, `url`, `headers`, `body`, `chunks`.
 * @returns the request.
 */
function makeRequest({ method = 'GET', url = '/', headers = {}, body = null, chunks = null } = {}) {
  const pieces = chunks !== null
    ? chunks
    : body === null
      ? []
      : [Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')]
  const req = Readable.from(pieces, { destroyOnReturn: false, autoDestroy: false })
  req.method = method
  req.url = url
  req.headers = headers
  req.destroyedByHandler = false
  const originalDestroy = req.destroy.bind(req)
  req.destroy = (...args) => {
    // ★ ONLY A DESTROY THAT HAPPENS BEFORE THE BODY ENDED COUNTS. A destroy
    // after 'end' is the stream cleaning up after itself.
    if (req.readableEnded !== true) req.destroyedByHandler = true
    return originalDestroy(...args)
  }
  return req
}

/**
 * The lines of one source file that are NOT comments.
 *
 * The package writes its comments as JSDoc blocks (every inner line starts
 * with `*`) and as `//` lines — so those two shapes are what has to be
 * recognised. The point of this helper is to look for a CALL, not for the
 * string: the source talks about `req.destroy()` in its comments on purpose.
 *
 * @param source - the file's text.
 * @returns the code lines, joined.
 */
function codeLines(source) {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      if (trimmed.startsWith('*')) return false
      if (trimmed.startsWith('//')) return false
      if (trimmed.startsWith('/*')) return false
      return true
    })
    .join('\n')
}

/**
 * Drive one route and wait for its response.
 *
 * @param route - the route descriptor.
 * @param options - the request options.
 * @returns a promise for `{ status, headers, body, text, res, req }`.
 */
function drive(route, options = {}) {
  return new Promise((resolve) => {
    const res = new FakeResponse()
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve({ status: res.status, headers: res.headers, body: res.body, text: res.text, res, req })
    }
    res.on('finish', finish)
    res.on('close', finish)
    // A handler that never answers must not hang the suite.
    const timer = setTimeout(finish, 15000)
    if (typeof timer.unref === 'function') timer.unref()
    const req = makeRequest(options)
    let result
    try {
      result = route.handler(req, res)
    } catch (error) {
      clearTimeout(timer)
      resolve({ status: 0, headers: {}, body: Buffer.alloc(0), text: String(error), res, req })
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
  // installed `node_modules` is full of symlinks.
  stage = mkdtempSync(join(tmpdir(), 'dsh-appearance-media-slots-'))
  cpSync(pkgDir, stage, { recursive: true, dereference: true })

  // The data directory under test: a path that DOES NOT EXIST YET. The first
  // GET has to answer 200 with the defaults and create nothing.
  dataDir = join(tmpdir(), 'dsh-appearance-media-slots-data-' + String(process.pid) + '-' + String(Date.now()))

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

  const storeModule = await import(pathToFileURL(join(stage, 'lib/store.js')).href)
  const pathsModule = await import(pathToFileURL(join(stage, 'lib/paths.js')).href)

  const harness = makeContext()
  const cleanup = entry.apply(harness.ctx, { dataDir })
  const route = (kind, path) => harness.routes.find((item) => item.kind === kind && item.path === path)
  const slotsRoute = route('exact', SLOTS_PATH)
  const catalogRoute = route('exact', CATALOG_PATH)
  const mediaRoute = route('prefix', MEDIA_PATH)

  const configFile = join(dataDir, 'config.json')
  const tempFile = join(dataDir, 'config.json.tmp')

  /**
   * Read the configuration through the route.
   *
   * @returns the answer and the parsed body.
   */
  const readSlots = async () => {
    const answer = await drive(slotsRoute, { method: 'GET', url: SLOTS_PATH })
    let payload = null
    try {
      payload = JSON.parse(answer.text)
    } catch {
      payload = null
    }
    return { answer, payload }
  }

  /**
   * Change the configuration through the route.
   *
   * @param patch - the patch object.
   * @returns the answer and the parsed body.
   */
  const putSlots = async (patch) => {
    const answer = await drive(slotsRoute, {
      method: 'PUT',
      url: SLOTS_PATH,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
    let payload = null
    try {
      payload = JSON.parse(answer.text)
    } catch {
      payload = null
    }
    return { answer, payload }
  }

  /** The revision the suite expects the configuration to be at. */
  let expectedRevision = 0

  /* ---- #1 the route exists by identity -------------------------------- */

  record('#1 the slot configuration route is registered as an exact route',
    slotsRoute !== undefined
    && slotsRoute.kind === 'exact'
    && slotsRoute.path === SLOTS_PATH,
    harness.routes.map((item) => item.kind + ':' + item.path).join(', '))

  /* ---- #2 a missing data directory answers 200 and creates nothing ----- */

  {
    const { answer, payload } = await readSlots()
    record('#2 a missing data directory answers 200 with the defaults and creates nothing',
      answer.status === 200
      && payload?.ok === true
      && payload?.config?.revision === 0
      && existsSync(dataDir) === false,
      'status=' + String(answer.status) + ' body=' + answer.text.slice(0, 200)
      + ' dataDirExists=' + String(existsSync(dataDir)))
  }

  /* ---- #3 the default configuration ----------------------------------- */

  {
    const { payload } = await readSlots()
    const slots = payload?.config?.slots ?? {}
    record('#3 the default configuration is three disabled slots with no material',
      slots.background !== undefined && slots.boot !== undefined && slots.screensaver !== undefined
      && slots.background.enabled === false && slots.background.mediaId === null && slots.background.revision === 0
      && slots.boot.enabled === false && slots.boot.mediaId === null && slots.boot.revision === 0
      && slots.screensaver.enabled === false && slots.screensaver.mediaId === null && slots.screensaver.revision === 0,
      JSON.stringify(payload?.config?.slots))
  }

  /* ---- #4 the shape contract the browser half reads (D3-7) ----------- */

  {
    const { payload } = await readSlots()
    const config = payload?.config ?? {}
    const slots = config.slots ?? {}
    const options = config.options ?? {}
    const slotShape = ['background', 'boot', 'screensaver'].every((name) => {
      const slot = slots[name]
      return slot !== undefined
        && Object.prototype.hasOwnProperty.call(slot, 'enabled')
        && Object.prototype.hasOwnProperty.call(slot, 'mediaId')
        && Object.prototype.hasOwnProperty.call(slot, 'revision')
    })
    const optionShape = Object.prototype.hasOwnProperty.call(options, 'background')
      && Object.prototype.hasOwnProperty.call(options.background, 'surface')
      && Object.prototype.hasOwnProperty.call(options.background, 'muted')
      && Object.prototype.hasOwnProperty.call(options.background, 'pauseWhenHidden')
      && Object.prototype.hasOwnProperty.call(options, 'boot')
      && Object.prototype.hasOwnProperty.call(options.boot, 'muted')
      && Object.prototype.hasOwnProperty.call(options, 'screensaver')
      && Object.prototype.hasOwnProperty.call(options.screensaver, 'idleMs')
      && Object.prototype.hasOwnProperty.call(options.screensaver, 'volume')
      && Object.prototype.hasOwnProperty.call(options.screensaver, 'muted')
    record('#4 the answer carries the key names the browser half reads, and ignored is at the top level',
      payload?.ok === true
      && typeof config.revision === 'number'
      && slotShape
      && optionShape
      && Array.isArray(payload?.ignored)
      && payload?.config?.slots?.background !== undefined
      && payload?.config?.slots?.background?.id === undefined,
      'keys=' + JSON.stringify(Object.keys(payload ?? {}))
      + ' slotKeys=' + JSON.stringify(Object.keys(payload?.config?.slots?.background ?? {}))
      + ' optionKeys=' + JSON.stringify(Object.keys(payload?.config?.options ?? {})))
  }

  /* ---- #5 Cache-Control is exactly no-store (D3-3) --------------------- */

  {
    const { answer } = await readSlots()
    record('#5 the GET answer carries Cache-Control exactly no-store',
      header(answer.headers, 'cache-control') === 'no-store',
      'cache-control=' + String(header(answer.headers, 'cache-control')))
  }

  /* ---- #6 nothing published carries an absolute path ------------------- */

  {
    const { answer } = await readSlots()
    record('#6 the answer never carries an absolute path',
      !answer.text.includes(dataDir)
      && !answer.text.includes(homedir()),
      'body=' + answer.text.slice(0, 300))
  }

  /* ---- #7 one PUT moves the whole revision and that slot's revision ---- */

  {
    const before = (await readSlots()).payload?.config
    const { answer, payload } = await putSlots({ slot: 'background', enabled: true })
    expectedRevision += 1
    const after = payload?.config
    record('#7 one PUT moves the whole revision and only that slot\'s revision',
      answer.status === 200
      && before?.revision === 0
      && after?.revision === expectedRevision
      && after?.slots?.background?.revision === 1
      && after?.slots?.background?.enabled === true
      && after?.slots?.boot?.revision === 0
      && after?.slots?.screensaver?.revision === 0,
      'status=' + String(answer.status) + ' revision=' + String(after?.revision)
      + ' background=' + JSON.stringify(after?.slots?.background)
      + ' boot=' + JSON.stringify(after?.slots?.boot))
  }

  /* ---- #8 the configuration file lands at <dataDir>/config.json ------- */

  {
    const exists = existsSync(configFile)
    let parsed = null
    try {
      parsed = JSON.parse(readFileSync(configFile, 'utf8'))
    } catch {
      parsed = null
    }
    record('#8 the configuration is written to <dataDir>/config.json, and the paths module exports configPath',
      exists
      && parsed !== null
      && parsed?.revision === expectedRevision
      && typeof pathsModule.configPath === 'function'
      && pathsModule.configPath(dataDir) === configFile
      && typeof pathsModule.mediaDir === 'function',
      'file=' + configFile + ' revision=' + String(parsed?.revision)
      + ' configPath=' + String(pathsModule.configPath?.(dataDir)))
  }

  /* ---- #9 the same slot moves again, and only that slot --------------- */

  {
    const { answer, payload } = await putSlots({ slot: 'background', enabled: false })
    expectedRevision += 1
    const after = payload?.config
    record('#9 a second change to the same slot moves that slot\'s revision again',
      answer.status === 200
      && after?.revision === expectedRevision
      && after?.slots?.background?.revision === 2
      && after?.slots?.background?.enabled === false
      && after?.slots?.boot?.revision === 0
      && after?.slots?.screensaver?.revision === 0,
      'status=' + String(answer.status) + ' revision=' + String(after?.revision)
      + ' background=' + JSON.stringify(after?.slots?.background))
  }

  /* ---- #10 mediaId null is legal -------------------------------------- */

  {
    const { answer, payload } = await putSlots({ slot: 'boot', mediaId: null })
    expectedRevision += 1
    const after = payload?.config
    record('#10 mediaId null is legal: it is a clear, not a 400',
      answer.status === 200
      && after?.slots?.boot?.mediaId === null
      && after?.revision === expectedRevision
      // ★ The slot's content did not change — it was already null — so the
      // SLOT revision does not move. The whole revision does: a write
      // happened. Assertion #13 is the other half: clearing a slot that DID
      // have a material moves that slot's revision.
      && after?.slots?.boot?.revision === 0,
      'status=' + String(answer.status) + ' boot=' + JSON.stringify(after?.slots?.boot))
  }

  /* ---- #11 an unknown mediaId is refused, byte for byte (D3-4) -------- */

  {
    const before = readFileSync(configFile)
    const { answer, payload } = await putSlots({ slot: 'background', mediaId: 'up-deadbeef1234' })
    const after = readFileSync(configFile)
    const now = (await readSlots()).payload?.config
    record('#11 an unknown mediaId answers 400 and the file on disk is byte-for-byte unchanged',
      answer.status === 400
      && payload?.ok === false
      && before.equals(after)
      && now?.revision === expectedRevision
      && now?.slots?.background?.mediaId === null,
      'status=' + String(answer.status) + ' body=' + answer.text.slice(0, 200)
      + ' bytesEqual=' + String(before.equals(after))
      + ' revision=' + String(now?.revision))
  }

  /* ---- #12 a mediaId that IS in the catalog is accepted --------------- */

  let catalogId = ''
  {
    mkdirSync(join(dataDir, 'media'), { recursive: true })
    writeFileSync(join(dataDir, 'media', 'sample-faststart.mp4'), readFileSync(join(fixturesDir, 'sample-faststart.mp4')))
    const catalog = await drive(catalogRoute, { method: 'GET', url: CATALOG_PATH })
    let catalogPayload = null
    try {
      catalogPayload = JSON.parse(catalog.text)
    } catch {
      catalogPayload = null
    }
    catalogId = catalogPayload?.entries?.[0]?.id ?? ''
    const { answer, payload } = await putSlots({ slot: 'screensaver', mediaId: catalogId })
    expectedRevision += 1
    const after = payload?.config
    record('#12 a mediaId that is in the catalog is accepted',
      catalogId !== ''
      && answer.status === 200
      && after?.slots?.screensaver?.mediaId === catalogId
      && after?.slots?.screensaver?.revision === 1,
      'catalogId=' + catalogId + ' status=' + String(answer.status)
      + ' screensaver=' + JSON.stringify(after?.slots?.screensaver))
  }

  /* ---- #13 the later write wins; two writes are never merged ---------- */

  {
    const before = readFileSync(configFile)
    const first = await putSlots({ slot: 'screensaver', mediaId: null })
    expectedRevision += 1
    const second = await putSlots({ slot: 'screensaver', mediaId: catalogId })
    expectedRevision += 1
    const now = (await readSlots()).payload?.config
    record('#13 the later write wins: two writes on one slot are never merged',
      first.answer.status === 200
      && second.answer.status === 200
      && now?.slots?.screensaver?.mediaId === catalogId
      && now?.revision === expectedRevision
      && now?.slots?.screensaver?.revision === 3,
      'mediaId=' + String(now?.slots?.screensaver?.mediaId)
      + ' slotRevision=' + String(now?.slots?.screensaver?.revision)
      + ' revision=' + String(now?.revision)
      + ' bytesChanged=' + String(!before.equals(readFileSync(configFile))))
  }

  /* ---- #14 an invalid option value is refused ------------------------- */

  {
    const before = readFileSync(configFile)
    const { answer } = await putSlots({ options: { background: { surface: 1.5 } } })
    const after = readFileSync(configFile)
    record('#14 an option value out of range answers 400 and the file is unchanged',
      answer.status === 400 && before.equals(after),
      'status=' + String(answer.status) + ' bytesEqual=' + String(before.equals(after)))
  }

  /* ---- #15 an idleMs out of range is refused, both ways --------------- */

  {
    const before = readFileSync(configFile)
    const tooSmall = await putSlots({ options: { screensaver: { idleMs: 1000 } } })
    const tooBig = await putSlots({ options: { screensaver: { idleMs: 7200000 } } })
    const after = readFileSync(configFile)
    record('#15 an idleMs outside [30000, 3600000] answers 400 and the file is unchanged',
      tooSmall.answer.status === 400
      && tooBig.answer.status === 400
      && before.equals(after),
      'small=' + String(tooSmall.answer.status) + ' big=' + String(tooBig.answer.status)
      + ' bytesEqual=' + String(before.equals(after)))
  }

  /* ---- #16 only the options changed: the whole revision moves, the slot
         revisions do not (B3-2) ------------------------------------------ */

  {
    const before = (await readSlots()).payload?.config
    const { answer, payload } = await putSlots({ options: { screensaver: { idleMs: 600000 } } })
    expectedRevision += 1
    const after = payload?.config
    record('#16 changing only the options moves the whole revision and none of the slot revisions',
      answer.status === 200
      && after?.revision === expectedRevision
      && after?.revision === (before?.revision ?? -1) + 1
      && after?.slots?.background?.revision === before?.slots?.background?.revision
      && after?.slots?.boot?.revision === before?.slots?.boot?.revision
      && after?.slots?.screensaver?.revision === before?.slots?.screensaver?.revision
      && after?.options?.screensaver?.idleMs === 600000,
      'revision ' + String(before?.revision) + '→' + String(after?.revision)
      + ' slotRevisions=' + JSON.stringify({
        background: after?.slots?.background?.revision,
        boot: after?.slots?.boot?.revision,
        screensaver: after?.slots?.screensaver?.revision,
      }))
  }

  /* ---- #17 an unknown key is ignored and reported ---------------------- */

  {
    const before = (await readSlots()).payload?.config
    const { answer, payload } = await putSlots({ slot: 'boot', enabled: true, tint: 'x' })
    expectedRevision += 1
    const after = payload?.config
    record('#17 an unknown key lands in ignored, fails nothing and changes nothing else',
      answer.status === 200
      && Array.isArray(payload?.ignored)
      && payload.ignored.includes('tint')
      && after?.slots?.boot?.enabled === true
      && after?.options?.screensaver?.idleMs === before?.options?.screensaver?.idleMs
      && after?.slots?.background?.mediaId === before?.slots?.background?.mediaId,
      'ignored=' + JSON.stringify(payload?.ignored) + ' status=' + String(answer.status))
  }

  /* ---- #18 an unknown option field is ignored too --------------------- */

  {
    const { answer, payload } = await putSlots({ options: { background: { tint: 1 }, wallpaper: {} } })
    expectedRevision += 1
    record('#18 an unknown option group and an unknown option field land in ignored',
      answer.status === 200
      && Array.isArray(payload?.ignored)
      && payload.ignored.includes('options.background.tint')
      && payload.ignored.includes('options.wallpaper'),
      'ignored=' + JSON.stringify(payload?.ignored) + ' status=' + String(answer.status))
  }

  /* ---- #19 a body over 16 KiB is refused ------------------------------- */

  {
    const before = readFileSync(configFile)
    const pad = 'x'.repeat(BODY_LIMIT + 1024)
    const answer = await drive(slotsRoute, {
      method: 'PUT',
      url: SLOTS_PATH,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slot: 'boot', note: pad }),
    })
    const after = readFileSync(configFile)
    record('#19 a request body over 16 KiB answers 400 and the file is unchanged',
      answer.status === 400
      && before.equals(after)
      // ★ AND THE REQUEST STREAM WAS NOT KILLED. `req.destroy()` closes the
      // socket before the answer is written ⇒ the client sees "Empty reply
      // from server" instead of the 400. The stub had no socket, so this was
      // invisible until a real client hit it.
      && answer.req?.destroyedByHandler === false,
      'status=' + String(answer.status) + ' bytesEqual=' + String(before.equals(after))
      + ' destroyedByHandler=' + String(answer.req?.destroyedByHandler))
  }

  /* ---- #20 a body that is not JSON is refused -------------------------- */

  {
    const before = readFileSync(configFile)
    const answer = await drive(slotsRoute, {
      method: 'PUT',
      url: SLOTS_PATH,
      headers: { 'content-type': 'application/json' },
      body: 'not json at all',
    })
    const after = readFileSync(configFile)
    record('#20 a request body that is not JSON answers 400 and the file is unchanged',
      answer.status === 400 && before.equals(after),
      'status=' + String(answer.status) + ' body=' + answer.text.slice(0, 120))
  }

  /* ---- #21 a body that is not a JSON object is refused ----------------- */

  {
    const answer = await drive(slotsRoute, {
      method: 'PUT',
      url: SLOTS_PATH,
      headers: { 'content-type': 'application/json' },
      body: '[1,2,3]',
    })
    record('#21 a request body that is not a JSON object answers 400',
      answer.status === 400,
      'status=' + String(answer.status) + ' body=' + answer.text.slice(0, 120))
  }

  /* ---- #22 every other method is 405, with an Allow header (D3-5) ---- */

  {
    const methods = ['POST', 'DELETE', 'PATCH']
    const answers = []
    for (const method of methods) {
      answers.push(await drive(slotsRoute, { method, url: SLOTS_PATH, body: '{}' }))
    }
    record('#22 every method other than GET, HEAD and PUT answers 405 with an Allow header',
      answers.every((answer) => answer.status === 405)
      && answers.every((answer) => header(answer.headers, 'allow') === 'GET, HEAD, PUT'),
      answers.map((answer) => String(answer.status) + '/' + String(header(answer.headers, 'allow'))).join(' '))
  }

  /* ---- #23 an unknown slot name is refused ---------------------------- */

  {
    const before = readFileSync(configFile)
    const { answer } = await putSlots({ slot: 'wallpaper', enabled: true })
    const after = readFileSync(configFile)
    record('#23 an unknown slot name answers 400 and the file is unchanged',
      answer.status === 400 && before.equals(after),
      'status=' + String(answer.status) + ' bytesEqual=' + String(before.equals(after)))
  }

  /* ---- #24 enabled or mediaId without a slot is refused ---------------- */

  {
    const before = readFileSync(configFile)
    const noSlot = await putSlots({ enabled: true })
    const noSlotId = await putSlots({ mediaId: null })
    const after = readFileSync(configFile)
    record('#24 enabled or mediaId without a slot answers 400',
      noSlot.answer.status === 400 && noSlotId.answer.status === 400 && before.equals(after),
      'enabled=' + String(noSlot.answer.status) + ' mediaId=' + String(noSlotId.answer.status))
  }

  /* ---- #25 two concurrent PUTs on two different slots both land (D3-1) - */

  {
    const before = (await readSlots()).payload?.config
    const answers = await Promise.all([
      putSlots({ slot: 'background', mediaId: catalogId }),
      putSlots({ slot: 'screensaver', enabled: true }),
    ])
    expectedRevision += 2
    const after = (await readSlots()).payload?.config
    record('#25 two concurrent PUTs on two different slots both land, and the revision moves by two',
      answers.every((item) => item.answer.status === 200)
      && after?.revision === before?.revision + 2
      && after?.revision === expectedRevision
      && after?.slots?.background?.mediaId === catalogId
      && after?.slots?.screensaver?.enabled === true,
      'statuses=' + answers.map((item) => String(item.answer.status)).join(',')
      + ' revision ' + String(before?.revision) + '→' + String(after?.revision)
      + ' background=' + String(after?.slots?.background?.mediaId)
      + ' screensaver=' + String(after?.slots?.screensaver?.enabled))
  }

  /* ---- #26 two concurrent PUTs on the SAME slot are not merged (D3-1) -- */

  {
    const before = (await readSlots()).payload?.config
    // ★ BOTH PUTS SET THE SAME VALUE, AND THAT VALUE IS NOT THE CURRENT ONE.
    // The FIRST write changes the slot; the SECOND one finds the slot already
    // in that state and changes nothing. So the slot's revision moves by
    // exactly ONE, while the whole revision moves by TWO.
    //
    //   * a slot revision of +2 would mean the second write read a STALE
    //     snapshot and re-applied the change — the lost-update bug;
    //   * a merged result would mean the two writes were combined, which is
    //     not what read-modify-write means.
    const answers = await Promise.all([
      putSlots({ slot: 'boot', enabled: false }),
      putSlots({ slot: 'boot', enabled: false }),
    ])
    expectedRevision += 2
    const after = (await readSlots()).payload?.config
    record('#26 two concurrent PUTs on the same slot are not merged: one change, two writes',
      answers.every((item) => item.answer.status === 200)
      && after?.revision === before?.revision + 2
      && after?.slots?.boot?.enabled === false
      && after?.slots?.boot?.revision === before?.slots?.boot?.revision + 1,
      'revision ' + String(before?.revision) + '→' + String(after?.revision)
      + ' bootRevision ' + String(before?.slots?.boot?.revision) + '→' + String(after?.slots?.boot?.revision)
      + ' enabled=' + String(after?.slots?.boot?.enabled))
  }

  /* ---- #27 the revision survives a restart (D3-6) --------------------- */

  {
    const onDisk = JSON.parse(readFileSync(configFile, 'utf8'))
    const reported = (await readSlots()).payload?.config
    record('#27 the revision survives a restart: re-reading the file from the disk gives the same number',
      onDisk?.revision === reported?.revision
      && onDisk?.revision === expectedRevision
      && typeof onDisk?.revision === 'number',
      'onDisk=' + String(onDisk?.revision) + ' reported=' + String(reported?.revision))
  }

  /* ---- #28 a failed write leaves the previous file byte for byte (D3-2) - */

  {
    const before = readFileSync(configFile)
    const beforeConfig = JSON.stringify((await readSlots()).payload?.config)
    // The temporary path is occupied by a directory: the write of the
    // temporary file fails, so the previous file must survive untouched.
    mkdirSync(tempFile, { recursive: true })
    const { answer } = await putSlots({ slot: 'boot', enabled: true })
    const after = readFileSync(configFile)
    const now = (await readSlots()).payload?.config
    record('#28 a failed write leaves the previous configuration byte-for-byte intact',
      answer.status === 500
      && before.equals(after)
      && JSON.stringify(now) === beforeConfig
      && now?.revision === expectedRevision,
      'status=' + String(answer.status) + ' bytesEqual=' + String(before.equals(after))
      + ' configEqual=' + String(JSON.stringify(now) === beforeConfig)
      + ' revision=' + String(now?.revision))
  }

  /* ---- #29 a failed write does not poison the queue ------------------- */

  {
    rmdirSync(tempFile)
    const { answer, payload } = await putSlots({ slot: 'boot', enabled: false })
    expectedRevision += 1
    record('#29 a failed write does not poison the write queue: the next one lands',
      answer.status === 200
      && payload?.config?.revision === expectedRevision
      && payload?.config?.slots?.boot?.enabled === false,
      'status=' + String(answer.status) + ' revision=' + String(payload?.config?.revision))
  }

  /* ---- #30 a failed rename leaves nothing behind (D3-2) ---------------- */

  {
    const before = readFileSync(configFile)
    // The target path is an existing directory: the rename fails, and the
    // target must be untouched, with no temporary file left behind.
    unlinkSync(configFile)
    mkdirSync(configFile, { recursive: true })
    const { answer } = await putSlots({ slot: 'boot', enabled: true })
    const targetIsDirectory = existsSync(configFile) && statSync(configFile).isDirectory()
    const leftovers = readdirSync(dataDir).filter((name) => name.endsWith('.tmp'))
    rmdirSync(configFile)
    writeFileSync(configFile, before)
    record('#30 a failed rename leaves the target untouched and no temporary file behind',
      answer.status === 500
      && targetIsDirectory
      && leftovers.length === 0
      && readFileSync(configFile).equals(before),
      'status=' + String(answer.status) + ' targetIsDirectory=' + String(targetIsDirectory)
      + ' leftovers=' + JSON.stringify(leftovers) + ' restored=' + String(readFileSync(configFile).equals(before)))
  }

  /* ---- #31 the store has ONE queue, and there is no second store ------ */

  {
    const storeSource = readFileSync(join(stage, 'lib/store.js'), 'utf8')
    const pathsSource = readFileSync(join(stage, 'lib/paths.js'), 'utf8')
    record('#31 the write queue is one map in lib/store.js, and there is no second store module',
      (storeSource.match(/new Map\(\)/g) ?? []).length === 1
      && storeSource.includes('export function updateLedger')
      && storeSource.includes('export function writeConfig')
      && storeSource.includes('export function readConfig')
      && existsSync(join(stage, 'lib/config-store.js')) === false
      && (pathsSource.match(/export function configPath/g) ?? []).length === 1
      && (pathsSource.match(/export function mediaDir/g) ?? []).length === 1,
      'maps=' + String((storeSource.match(/new Map\(\)/g) ?? []).length)
      + ' configPathExports=' + String((pathsSource.match(/export function configPath/g) ?? []).length))
  }

  /* ---- #32 this Task never touches document.body (ruling 2) ---------- */

  {
    const slotsSource = readFileSync(join(stage, 'lib/routes/slots.js'), 'utf8')
    const storeSource = readFileSync(join(stage, 'lib/store.js'), 'utf8')
    record('#32 neither the slots route nor the store writes a body attribute',
      !slotsSource.includes('data-we-wallpaper')
      && !slotsSource.includes('data-dsh-am')
      && !storeSource.includes('data-we-wallpaper')
      && !storeSource.includes('data-dsh-am'),
      'slots=' + String(slotsSource.includes('data-we-wallpaper') || slotsSource.includes('data-dsh-am'))
      + ' store=' + String(storeSource.includes('data-we-wallpaper') || storeSource.includes('data-dsh-am')))
  }

  /* ---- #33 the media route's cache headers were not touched (ruling 3) - */

  {
    const answer = await drive(mediaRoute, { method: 'GET', url: MEDIA_PATH + '/' + catalogId })
    record('#33 the media route still answers Cache-Control exactly no-store',
      answer.status === 200 && header(answer.headers, 'cache-control') === 'no-store',
      'status=' + String(answer.status) + ' cache-control=' + String(header(answer.headers, 'cache-control')))
  }

  /* ---- #34 the ledger and the configuration share one module ---------- */

  {
    const ledgerBefore = storeModule.ledgerRevision(dataDir)
    await storeModule.updateLedger(dataDir, (entries) => entries)
    const ledgerAfter = storeModule.ledgerRevision(dataDir)
    const config = (await readSlots()).payload?.config
    record('#34 the ledger and the slot configuration live in the same store, and both still work',
      ledgerAfter === ledgerBefore + 1
      && typeof storeModule.readConfig === 'function'
      && typeof storeModule.writeConfig === 'function'
      && typeof storeModule.readLedger === 'function'
      && typeof storeModule.updateLedger === 'function'
      && config?.revision === expectedRevision,
      'ledger ' + String(ledgerBefore) + '→' + String(ledgerAfter)
      + ' configRevision=' + String(config?.revision))
  }

  /* ---- #35 the GET answer is read from the disk, not from a snapshot --- */

  {
    const reported = (await readSlots()).payload?.config
    const onDisk = JSON.parse(readFileSync(configFile, 'utf8'))
    record('#35 the GET answer is the file on the disk, not a snapshot taken at mount time',
      reported?.revision === onDisk?.revision
      && reported?.revision === expectedRevision
      && reported?.slots?.screensaver?.enabled === true,
      'reported=' + String(reported?.revision) + ' onDisk=' + String(onDisk?.revision))
  }

  /* ---- #36 the scratch copy carries no symbolic link ------------------- */

  {
    record('#36 the scratch copy was made with dereference, so it carries no symbolic link',
      hasSymbolicLink(stage) === false,
      'stage=' + stage)
  }

  /* ---- #37 an over-sized body is DRAINED, not destroyed (review 1) ----- */

  {
    const before = readFileSync(configFile)
    // ★ THE BODY COMES IN PIECES, AND THE LIMIT IS CROSSED IN THE SECOND
    // ONE — so the handler has to keep reading AFTER it decided the body is
    // too big. If it destroyed the request there, the socket would die before
    // the 400 was written and a real client would see "Empty reply from
    // server" (curl exit 52) instead of the 400.
    const answer = await drive(slotsRoute, {
      method: 'PUT',
      url: SLOTS_PATH,
      headers: { 'content-type': 'application/json' },
      chunks: [
        Buffer.from('{"slot":"boot","note":"', 'utf8'),
        Buffer.from('y'.repeat(BODY_LIMIT + 4096), 'utf8'),
        Buffer.from('"}', 'utf8'),
      ],
    })
    const after = readFileSync(configFile)
    record('#37 an over-sized body is drained, not destroyed: the 400 reaches the client',
      answer.status === 400
      && before.equals(after)
      && answer.req?.destroyedByHandler === false,
      'status=' + String(answer.status) + ' bytesEqual=' + String(before.equals(after))
      + ' destroyedByHandler=' + String(answer.req?.destroyedByHandler))
  }

  /* ---- #38 the remove route's 413 also drains (review 1) --------------- */

  {
    const removeRoute = route('exact', REMOVE_PATH)
    const answer = await drive(removeRoute, {
      method: 'POST',
      url: REMOVE_PATH,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'up-000000000000', note: 'z'.repeat(BODY_LIMIT + 1024) }),
    })
    record('#38 the remove route answers 413 for an over-sized body without destroying the request',
      answer.status === 413
      && answer.req?.destroyedByHandler === false,
      'status=' + String(answer.status) + ' destroyedByHandler=' + String(answer.req?.destroyedByHandler)
      + ' body=' + answer.text.slice(0, 120))
  }

  /* ---- #39 the upload route's 413 also drains (review 1) --------------- */

  {
    const uploadRoute = route('exact', UPLOAD_PATH)
    const answer = await drive(uploadRoute, {
      method: 'POST',
      url: UPLOAD_PATH,
      headers: { 'content-type': 'video/mp4', 'x-dsh-filename': 'huge.mp4' },
      body: Buffer.alloc(MAX_UPLOAD_BYTES + 1, 1),
    })
    const leftovers = existsSync(join(dataDir, 'media'))
      ? readdirSync(join(dataDir, 'media')).filter((name) => name.endsWith('.part'))
      : []
    record('#39 the upload route answers 413 for an over-sized body without destroying the request',
      answer.status === 413
      && answer.req?.destroyedByHandler === false
      && leftovers.length === 0,
      'status=' + String(answer.status) + ' destroyedByHandler=' + String(answer.req?.destroyedByHandler)
      + ' leftovers=' + JSON.stringify(leftovers))
  }

  /* ---- #40 no route calls req.destroy() (review 1) --------------------- */

  {
    const slotsSource = readFileSync(join(stage, 'lib/routes/slots.js'), 'utf8')
    const uploadRouteSource = readFileSync(join(stage, 'lib/routes/upload.js'), 'utf8')
    const uploadSource = readFileSync(join(stage, 'lib/upload.js'), 'utf8')
    record('#40 no route calls req.destroy(), so every status code can reach the client',
      !codeLines(slotsSource).includes('req.destroy(')
      && !codeLines(uploadRouteSource).includes('req.destroy(')
      && !codeLines(uploadSource).includes('req.destroy('),
      'slots=' + String(codeLines(slotsSource).includes('req.destroy('))
      + ' uploadRoute=' + String(codeLines(uploadRouteSource).includes('req.destroy('))
      + ' upload=' + String(codeLines(uploadSource).includes('req.destroy(')))
  }

  /* ---- #41 the boot options the user can tune (coordinator ruling ②) -- */

  {
    const { payload } = await readSlots()
    const options = payload?.config?.options ?? {}
    const boot = options.boot ?? {}
    record('#41 the boot options carry the fade and the hold budget, and they are tunable',
      typeof boot.fadeMs === 'number'
      && typeof boot.holdMs === 'number'
      && boot.fadeMs >= 0 && boot.fadeMs <= 5000
      && boot.holdMs >= 0 && boot.holdMs <= 60000,
      'boot=' + JSON.stringify(boot))
  }

  /* ---- #42 the enum options: the declared values are stored, the others
         are refused, and the defaults are the declared ones ------------- */

  {
    // ★ A FIELD THAT IS ACCEPTED BUT NEVER READ IS A DEAD CONTROL. The card
    // writes these four values, the surfaces read them, and this assertion
    // is what proves the middle hop: the value that goes in comes back out
    // of the configuration document, unchanged.
    const before = (await readSlots()).payload?.config
    // ★ THE PATHS ARE 'group.field' — TWO PARTS. A path like
    // 'options.boot.enterMode' split into three would put the group name
    // 'options' into the group slot and the field name 'boot' into the
    // field slot, and the write would be refused as an unknown group — a
    // test that passes for the wrong reason.
    const declared = {
      'boot.enterMode': ['tail', 'end', 'click'],
      'boot.source': ['media', 'pool'],
      'screensaver.breakStyle': ['particles', 'fall', 'glitch'],
      'screensaver.pointerStyle': ['ripples', 'attract'],
    }
    const defaults = {
      'boot.enterMode': 'tail',
      'boot.source': 'media',
      'screensaver.breakStyle': 'particles',
      'screensaver.pointerStyle': 'ripples',
    }
    const read = (config, path) => {
      let node = config
      for (const part of ['options'].concat(path.split('.'))) {
        if (node === undefined || node === null) return undefined
        node = node[part]
      }
      return node
    }
    const wrongDefaults = Object.keys(defaults).filter((path) => read(before, path) !== defaults[path])
    record('#42 the four new fields carry the declared defaults',
      wrongDefaults.length === 0,
      'wrong=' + JSON.stringify(wrongDefaults.map((path) => path + '=' + String(read(before, path)))))

    // ★ EVERY DECLARED VALUE IS STORED, NOT JUST THE FIRST ONE.
    const stored = []
    for (const path of Object.keys(declared)) {
      const [group, field] = path.split('.')
      const value = declared[path][declared[path].length - 1]
      expectedRevision += 1
      const { answer, payload } = await putSlots({ options: { [group]: { [field]: value } } })
      const got = read(payload?.config, path)
      stored.push(path + '=' + String(got))
      if (answer.status !== 200 || got !== value) break
    }
    const allStored = []
    for (const path of Object.keys(declared)) {
      const [group, field] = path.split('.')
      const value = declared[path][declared[path].length - 1]
      expectedRevision += 1
      const { answer, payload } = await putSlots({ options: { [group]: { [field]: value } } })
      allStored.push(answer.status === 200 && read(payload?.config, path) === value)
    }
    record('#43 every declared enum value is stored and comes back unchanged',
      stored.length === Object.keys(declared).length && allStored.every(Boolean),
      stored.join(' ') + ' ok=' + JSON.stringify(allStored))

    // ★ AND A VALUE THE SHAPE DOES NOT DECLARE IS REFUSED.
    const refused = []
    for (const path of Object.keys(declared)) {
      const [group, field] = path.split('.')
      const beforeBad = (await readSlots()).payload?.config
      const { answer } = await putSlots({ options: { [group]: { [field]: 'not-a-value' } } })
      // ★ READ THE CONFIG AGAIN AFTER THE REFUSAL. The refused answer carries
      // no configuration at all, so comparing against it would report a
      // change that never happened — the document is still on disk, and the
      // only way to know is to read it back.
      const afterBad = (await readSlots()).payload?.config
      const unchanged = read(afterBad, path) === read(beforeBad, path)
      refused.push(path + ':' + String(answer.status) + (unchanged ? '' : ' CHANGED!'))
      if (answer.status === 200 || !unchanged) break
    }
    record('#44 an enum value the shape does not declare is refused, and nothing changes',
      refused.length === Object.keys(declared).length
      && refused.every((line) => !line.includes('200') && !line.includes('CHANGED')),
      refused.join(' '))
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
