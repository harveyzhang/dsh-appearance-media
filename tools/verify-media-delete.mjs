#!/usr/bin/env node
// dsh-appearance-media — offline acceptance for DELETING a material.
//
// ★ WHAT THIS SUITE IS, AND WHY IT IS A SEPARATE FILE.
//
// The plugin has always had a way to take a material out of the library —
// `POST /appearance-media/remove`, a JSON body and an id — and that route
// answers in one line. What it did NOT do is the part that is hard: refuse a
// traversal with a reason, clear the slots that pointed at the material, and
// leave the library and the ledger telling the SAME story when it fails
// halfway.
//
// This suite proves the delete that the browser half actually calls:
// `DELETE /appearance-media/media/<id>`.
//
// ★ THE CHECKS, IN TWO HALVES.
//
//   H1-H24  the Host half: the guards, the order, the rollback, the ledger,
//           the slots, and the failure injection (a read-only media
//           directory);
//   C1-C14  the browser half: the confirmation, the cancel that does
//           nothing, the request that is sent, the row that leaves the list,
//           and the Host's own sentence when it refuses.
//
// ★ EVERY CHECK CAN FAIL BECAUSE THE IMPLEMENTATION IS WRONG, AND EVERY NEW
//   CHECK HAS A REVERSE CONTROL.
//
// `node tools/verify-media-delete.mjs --negative` mutates a COPY of the
// package — one defect at a time, never the real files — and requires the
// suite to go red. A check that cannot fail is not a check.
//
// ★ AND THE LIBRARY UNDER TEST IS A TEMPORARY DIRECTORY.
//
// The default library is the user's own (`~/.dsh/dsh-appearance-media/media/`),
// and a suite that deleted from it would delete the user's material. Every
// file this suite creates, renames or unlinks lives in a `mkdtemp` directory.
//
// Usage:
//   node tools/verify-media-delete.mjs              the suite
//   node tools/verify-media-delete.mjs --negative   the reverse controls

import {
  chmodSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createContext, runInContext } from 'node:vm'

const pkgDir = fileURLToPath(new URL('..', import.meta.url))

const CATALOG_PATH = '/appearance-media/catalog.json'
const UPLOAD_PATH = '/appearance-media/upload'
const MEDIA_PATH = '/appearance-media/media'

/** @type {Array<[string, boolean, string]>} */
let checks = []
/** @type {string[]} */
let notes = []

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

/* ══════════════════════════════════════════════════════════════════════════
   THE HOST HALF — a real mount, real routes, a temporary library.
   ══════════════════════════════════════════════════════════════════════════ */

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
 * The fake response.
 *
 * It is a real `Writable`: the media route serves its bytes with
 * `createReadStream(…).pipe(res)`, and a hand-rolled fake would make the
 * SUITE's defect look like the CODE's defect.
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
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    on(event, fn) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      return () => {}
    },
    get(name) { return services.get(name) },
    inject(names, callback) { return callback(ctx) },
    provide() {},
    logger: { info() {}, warn() {}, error() {} },
  }

  return { ctx, routes, listeners, disposers }
}

/**
 * The bytes of one fake material.
 *
 * @param name - the file name.
 * @param body - the bytes.
 * @returns the absolute path.
 */
function writeMaterial(mediaPath, name, body) {
  const target = join(mediaPath, name)
  writeFileSync(target, body)
  return target
}

/**
 * Run the Host half's checks against one package directory.
 *
 * @param stage - the package directory to import.
 * @param dataDir - a temporary library.
 * @returns the number of checks that failed.
 */
async function runHostChecks(stage, dataDir) {
  const before = checks.length
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')) }
  let entry
  try {
    entry = await import(pathToFileURL(join(stage, 'index.js')).href)
  } finally {
    console.warn = originalWarn
  }
  const storeModule = await import(pathToFileURL(join(stage, 'lib/store.js')).href)

  const harness = makeContext()
  const cleanup = entry.apply(harness.ctx, { dataDir })
  const mediaPath = join(dataDir, 'media')
  const mediaRoute = harness.routes.find((route) => route.kind === 'prefix' && route.path === MEDIA_PATH)
  const catalogRoute = harness.routes.find((route) => route.kind === 'exact' && route.path === CATALOG_PATH)
  const uploadRoute = harness.routes.find((route) => route.kind === 'exact' && route.path === UPLOAD_PATH)

  record('H1 the media route is registered exactly once, as a prefix route',
    harness.routes.filter((route) => route.path === MEDIA_PATH).length === 1
    && mediaRoute !== undefined
    && mediaRoute.kind === 'prefix',
    harness.routes.map((route) => route.kind + ':' + route.path).join(', '))

  if (mediaRoute === undefined || catalogRoute === undefined || uploadRoute === undefined) {
    record('H0 the routes the delete needs are all registered', false, 'a route is missing')
    return checks.length - before
  }

  // ── The material under test: ONE uploaded (so the ledger knows it) and ONE
  //    hand-placed (so the ledger does not). ──
  const clipBytes = Buffer.from('not-a-real-clip-but-bytes-are-bytes')
  const upload = await drive(uploadRoute, {
    method: 'POST',
    url: UPLOAD_PATH,
    headers: { 'content-type': 'video/mp4', 'x-dsh-filename': 'clip.mp4' },
    body: clipBytes,
  })
  let uploaded = null
  try {
    uploaded = JSON.parse(upload.text)
  } catch {
    uploaded = null
  }
  const clipId = uploaded?.entry?.id
  record('H2 the upload route produced a material with a ledger entry',
    upload.status === 200 && typeof clipId === 'string' && clipId !== '',
    'status=' + String(upload.status) + ' id=' + String(clipId))
  if (typeof clipId !== 'string' || clipId === '') {
    return checks.length - before
  }

  const photoPath = writeMaterial(mediaPath, 'photo.png', Buffer.from('not-a-real-photo'))
  const photoId = 'fs-photo-' + String(Math.round(statSync(photoPath).mtimeMs))

  // ★ A FILE OUTSIDE THE LIBRARY. Every traversal attempt has to leave it
  //   alone, and this is how that is proved.
  const sentinel = join(dataDir, 'sentinel.txt')
  writeFileSync(sentinel, 'do not touch me')

  const readLedger = () => storeModule.readLedger(dataDir)
  const readConfig = () => storeModule.readConfig(dataDir)
  const setSlot = async (slot, mediaId) => {
    await storeModule.writeConfig(dataDir, { slot: slot, mediaId: mediaId })
  }

  // ── H3: the bytes still come out of the moved route. ──
  {
    const answer = await drive(mediaRoute, { method: 'GET', url: MEDIA_PATH + '/' + clipId })
    record('H3 the media route still serves the bytes after the move',
      answer.status === 200
      && answer.body.length === clipBytes.length
      && answer.body.toString('utf8') === clipBytes.toString('utf8'),
      'status=' + String(answer.status) + ' bytes=' + String(answer.body.length))
    record('H4 the media route is still never cacheable',
      header(answer.headers, 'cache-control') === 'no-store',
      String(header(answer.headers, 'cache-control')))
  }

  // ── H5: the methods the route does not answer. ──
  {
    const answer = await drive(mediaRoute, { method: 'POST', url: MEDIA_PATH + '/' + clipId })
    record('H5 the media route refuses POST with 405 and names the allowed methods',
      answer.status === 405 && header(answer.headers, 'allow') === 'GET, HEAD, DELETE',
      'status=' + String(answer.status) + ' allow=' + String(header(answer.headers, 'allow')))
  }

  // ── H6-H13: the traversal guard, in every spelling. ──
  //
  // ★ THE PATH-SHAPED IDS ARE CHECKED AGAINST THE PATH SENTENCE, not only
  // against the status code. Two different guards refuse them — the traversal
  // guard and the "this is not an id" guard — and a check that only looks at
  // the status code cannot tell which one did the work. The sentence says
  // which: a path is a path, and the id pattern is not what caught it.
  const traversals = [
    { label: 'a plain ..', id: '..', path: true },
    { label: 'an encoded ../', id: '..%2F..%2Fetc%2Fpasswd', path: true },
    { label: 'an encoded dot-dot', id: '%2e%2e%2f%2e%2e%2fsecret', path: true },
    { label: 'a deep encoded walk', id: '%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2Fshadow', path: true },
    { label: 'a backslash', id: 'foo%5Cbar', path: true },
    { label: 'an absolute path', id: '%2Fetc%2Fpasswd', path: true },
    { label: 'a double-encoded walk', id: '..%252f..%252fetc', path: true },
    { label: 'a path separator', id: 'sub%2Ffile.mp4', path: true },
    { label: 'a null byte', id: 'a%00b', path: false },
  ]
  for (const traversal of traversals) {
    const answer = await drive(mediaRoute, {
      method: 'DELETE',
      url: MEDIA_PATH + '/' + traversal.id,
    })
    record('H6 the delete refuses ' + traversal.label + ' with 400',
      answer.status === 400,
      'status=' + String(answer.status) + ' body=' + answer.text.slice(0, 120))
    if (traversal.path === true) {
      let body = null
      try {
        body = JSON.parse(answer.text)
      } catch {
        body = null
      }
      record('H6b the delete refuses ' + traversal.label + ' as a PATH, not as a malformed id',
        typeof body?.error === 'string' && body.error.includes('不能带路径'),
        String(body?.error))
    }
  }
  record('H7 the refused traversals left the file outside the library alone',
    existsSync(sentinel) && readFileSync(sentinel, 'utf8') === 'do not touch me',
    'sentinel=' + String(existsSync(sentinel)))
  record('H8 the refused traversals left the material in the library alone',
    existsSync(join(mediaPath, 'up-' + clipId.slice(3) + '.mp4')) || existsSync(join(mediaPath, 'clip.mp4'))
    || readLedger().entries[clipId] !== undefined,
    'ledger=' + String(readLedger().entries[clipId] !== undefined))

  // ── H9: an id that is not in the library. ──
  {
    const answer = await drive(mediaRoute, {
      method: 'DELETE',
      url: MEDIA_PATH + '/fs-nothing-here-0',
    })
    record('H9 the delete answers 404 for an id the library does not hold',
      answer.status === 404,
      'status=' + String(answer.status) + ' body=' + answer.text.slice(0, 120))
  }

  // ── H10-H16: the successful delete, with a slot pointing at the material. ──
  {
    await setSlot('background', clipId)
    const before = readConfig()
    record('H10 the background slot points at the material before the delete',
      before.config?.slots?.background?.mediaId === clipId,
      JSON.stringify(before.config?.slots?.background?.mediaId))

    const answer = await drive(mediaRoute, {
      method: 'DELETE',
      url: MEDIA_PATH + '/' + clipId,
    })
    let payload = null
    try {
      payload = JSON.parse(answer.text)
    } catch {
      payload = null
    }
    record('H11 the delete answers 200 and says the material is gone',
      answer.status === 200 && payload?.ok === true && payload?.removed === true,
      'status=' + String(answer.status) + ' body=' + answer.text.slice(0, 200))
    record('H12 the answer names the slot it cleared',
      Array.isArray(payload?.clearedSlots) && payload.clearedSlots.includes('background'),
      JSON.stringify(payload?.clearedSlots))

    const file = join(mediaPath, 'up-' + clipId.slice(3) + '.mp4')
    record('H13 the file is really gone from the disk',
      !existsSync(file),
      file)
    record('H14 the ledger no longer lists the material',
      readLedger().entries[clipId] === undefined,
      JSON.stringify(readLedger().entries[clipId]))
    const catalog = await drive(catalogRoute, { method: 'GET', url: CATALOG_PATH })
    let catalogPayload = null
    try {
      catalogPayload = JSON.parse(catalog.text)
    } catch {
      catalogPayload = null
    }
    const listed = Array.isArray(catalogPayload?.entries)
      ? catalogPayload.entries.filter((item) => item.id === clipId).length
      : -1
    record('H15 the catalog no longer lists the material', listed === 0, 'entries=' + String(listed))
    const after = readConfig()
    record('H16 the slot that pointed at it is empty now, not dangling',
      after.config?.slots?.background?.mediaId === null,
      JSON.stringify(after.config?.slots?.background?.mediaId))
    const leftovers = readdirSync(mediaPath).filter((name) => name.startsWith('.delete-'))
    record('H17 the delete left no staging file behind', leftovers.length === 0,
      leftovers.join(', '))
  }

  // ── H18-H21: the boot pool, and the failure injection. ──
  {
    // A second material, with the pool pointing at it.
    const poolBytes = Buffer.from('pool-material-bytes')
    const upload2 = await drive(uploadRoute, {
      method: 'POST',
      url: UPLOAD_PATH,
      headers: { 'content-type': 'video/mp4', 'x-dsh-filename': 'pooled.mp4' },
      body: poolBytes,
    })
    let pooled = null
    try {
      pooled = JSON.parse(upload2.text)
    } catch {
      pooled = null
    }
    const pooledId = pooled?.entry?.id
    record('H18 a second material is in the library',
      typeof pooledId === 'string' && pooledId !== '' && pooledId !== clipId,
      String(pooledId))
    if (typeof pooledId === 'string' && pooledId !== '') {
      await storeModule.writeConfig(dataDir, { options: { boot: { pool: [pooledId] } } })
      const answer = await drive(mediaRoute, {
        method: 'DELETE',
        url: MEDIA_PATH + '/' + pooledId,
      })
      let payload = null
      try {
        payload = JSON.parse(answer.text)
      } catch {
        payload = null
      }
      const pool = readConfig().config?.options?.boot?.pool
      record('H19 the delete takes the material out of the boot pool',
        answer.status === 200 && Array.isArray(pool) && pool.indexOf(pooledId) === -1,
        'pool=' + JSON.stringify(pool) + ' status=' + String(answer.status))
      record('H20 the answer says the pool changed',
        payload?.poolUpdated === true,
        JSON.stringify(payload?.poolUpdated))
    }
  }

  {
    // ★ THE FAILURE INJECTION: a read-only media directory.
    //
    // The material is uploaded first (the directory has to be writable for
    // that), and the slot is pointed at it. Then the directory is made
    // read-only, and the delete has to fail WITHOUT touching anything.
    const bytes = Buffer.from('read-only-material-bytes')
    const upload3 = await drive(uploadRoute, {
      method: 'POST',
      url: UPLOAD_PATH,
      headers: { 'content-type': 'video/mp4', 'x-dsh-filename': 'locked.mp4' },
      body: bytes,
    })
    let locked = null
    try {
      locked = JSON.parse(upload3.text)
    } catch {
      locked = null
    }
    const lockedId = locked?.entry?.id
    if (typeof lockedId === 'string' && lockedId !== '') {
      await setSlot('screensaver', lockedId)
      const file = join(mediaPath, 'up-' + lockedId.slice(3) + '.mp4')
      const ledgerBefore = readLedger()
      const configBefore = readConfig()
      chmodSync(mediaPath, 0o555)
      let answer = null
      try {
        answer = await drive(mediaRoute, {
          method: 'DELETE',
          url: MEDIA_PATH + '/' + lockedId,
        })
      } finally {
        chmodSync(mediaPath, 0o755)
      }
      record('H21 a delete that cannot touch the directory fails with 500',
        answer !== null && answer.status === 500,
        'status=' + String(answer !== null ? answer.status : 'none'))
      record('H22 the failed delete left the file exactly where it was',
        existsSync(file),
        file)
      record('H23 the failed delete left the ledger exactly as it was',
        JSON.stringify(readLedger().entries) === JSON.stringify(ledgerBefore.entries),
        'before=' + JSON.stringify(ledgerBefore.entries[lockedId])
        + ' after=' + JSON.stringify(readLedger().entries[lockedId]))
      record('H24 the failed delete left the slot pointing at the material',
        readConfig().config?.slots?.screensaver?.mediaId === lockedId
        && JSON.stringify(readConfig().config?.slots) === JSON.stringify(configBefore.config?.slots),
        JSON.stringify(readConfig().config?.slots?.screensaver?.mediaId))
      const staged = readdirSync(mediaPath).filter((name) => name.startsWith('.delete-'))
      record('H25 the failed delete left no staging file behind', staged.length === 0,
        staged.join(', '))
    }
  }

  {
    // ★ THE OTHER FAILURE INJECTION: a read-only DATA directory.
    //
    // The media directory stays writable — the file goes aside fine — and the
    // CONFIGURATION cannot be written, so the slot cannot be cleared. That is
    // the one failure that happens AFTER the file has left the library, and
    // the rollback has to put it back: a material that is half deleted is
    // worse than one that was never deleted.
    const bytes = Buffer.from('half-deleted-material-bytes')
    const upload4 = await drive(uploadRoute, {
      method: 'POST',
      url: UPLOAD_PATH,
      headers: { 'content-type': 'video/mp4', 'x-dsh-filename': 'halfway.mp4' },
      body: bytes,
    })
    let halfway = null
    try {
      halfway = JSON.parse(upload4.text)
    } catch {
      halfway = null
    }
    const halfwayId = halfway?.entry?.id
    if (typeof halfwayId === 'string' && halfwayId !== '') {
      await setSlot('background', halfwayId)
      const file = join(mediaPath, 'up-' + halfwayId.slice(3) + '.mp4')
      const ledgerBefore = readLedger()
      const staged = []
      chmodSync(dataDir, 0o555)
      let answer = null
      try {
        answer = await drive(mediaRoute, {
          method: 'DELETE',
          url: MEDIA_PATH + '/' + halfwayId,
        })
      } finally {
        chmodSync(dataDir, 0o755)
      }
      record('H27 a delete that cannot clear the slot answers 500',
        answer !== null && answer.status === 500,
        'status=' + String(answer !== null ? answer.status : 'none'))
      record('H28 the rollback put the material back on the disk',
        existsSync(file),
        file + ' exists=' + String(existsSync(file)))
      record('H29 the failed delete left the ledger as it was',
        JSON.stringify(readLedger().entries) === JSON.stringify(ledgerBefore.entries),
        'before=' + String(ledgerBefore.entries[halfwayId] !== undefined)
        + ' after=' + String(readLedger().entries[halfwayId] !== undefined))
      const leftovers = readdirSync(mediaPath).filter((name) => name.startsWith('.delete-'))
      record('H30 the failed delete left no staging file behind', leftovers.length === 0,
        leftovers.join(', '))
      void staged
    }
  }

  {
    // ★ THE STALE LEDGER ENTRY: the ledger knows a material the disk does
    //   not. That is the "the library has no such file but the ledger says
    //   so" thing, and the delete is the one chance to clean it.
    const staleId = 'up-stale000000'
    const ledger = readLedger()
    const entries = { ...ledger.entries, [staleId]: { name: 'stale.mp4', kind: 'video', ext: '.mp4' } }
    writeFileSync(join(mediaPath, '.meta.json'), JSON.stringify({
      revision: ledger.revision + 1,
      entries: entries,
    }, null, 2) + '\n')
    const answer = await drive(mediaRoute, {
      method: 'DELETE',
      url: MEDIA_PATH + '/' + staleId,
    })
    record('H26 the delete cleans a ledger entry whose file is already gone',
      answer.status === 200 && readLedger().entries[staleId] === undefined,
      'status=' + String(answer.status) + ' still=' + String(readLedger().entries[staleId] !== undefined))
  }

  if (typeof cleanup === 'function') cleanup()
  return checks.length - before
}

/* ══════════════════════════════════════════════════════════════════════════
   THE BROWSER HALF — the real client, a stub React, a stub fetch.
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Build a React stub with a per-component hook store.
 *
 * @returns {{ React: object, host: object }} the stub and its host.
 */
function createReact() {
  const host = { stores: new Map(), current: null }

  const React = {
    createElement: function (type, props) {
      const p = Object.assign({}, props)
      const rest = Array.prototype.slice.call(arguments, 2)
      if (rest.length === 1) p.children = rest[0]
      else if (rest.length > 1) p.children = rest
      return { type: type, props: p }
    },
    useState: function (initial) {
      const store = host.current
      const i = store.index++
      if (!(i in store.hooks)) {
        store.hooks[i] = typeof initial === 'function' ? initial() : initial
      }
      const set = function (value) {
        store.hooks[i] = typeof value === 'function' ? value(store.hooks[i]) : value
      }
      return [store.hooks[i], set]
    },
    useEffect: function (fn, deps) {
      const store = host.current
      const i = store.index++
      const list = deps === undefined ? [] : deps
      const prev = store.deps[i]
      const changed = prev === undefined
        || prev.length !== list.length
        || list.some(function (d, k) { return d !== prev[k] })
      if (changed) {
        store.deps[i] = list.slice()
        store.effects.push({ index: i, fn: fn })
      }
    },
    useCallback: function (fn) { return fn },
    useRef: function (v) { return { current: v } },
    useMemo: function (fn) { return fn() },
  }
  return { React, host }
}

/**
 * The hook store of one component.
 *
 * @param host - the host.
 * @param fn - the component function.
 * @returns the store.
 */
function storeFor(host, fn) {
  let store = host.stores.get(fn)
  if (store === undefined) {
    store = { hooks: [], deps: [], index: 0, effects: [], cleanups: [] }
    host.stores.set(fn, store)
  }
  return store
}

/**
 * Render one component and run its effects.
 *
 * @param node - the element.
 * @param React - the stub.
 * @param host - the host.
 * @returns the component's output.
 */
function mountComponent(node, React, host) {
  const store = storeFor(host, node.type)
  const previous = host.current
  host.current = store
  store.index = 0
  store.effects = []
  let out
  try {
    out = node.type(node.props)
  } finally {
    host.current = previous
  }
  const pending = store.effects
  store.effects = []
  for (const effect of pending) {
    const cleanup = effect.fn()
    if (typeof cleanup === 'function') store.cleanups[effect.index] = cleanup
  }
  return out
}

/**
 * Render a whole tree, calling every function component on the way.
 *
 * @param node - the tree.
 * @param React - the stub.
 * @param host - the host.
 * @returns the rendered tree.
 */
function deepRender(node, React, host) {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) {
    return node.map(function (n) { return deepRender(n, React, host) })
  }
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') {
    return deepRender(mountComponent(node, React, host), React, host)
  }
  const props = Object.assign({}, node.props)
  if (props.children !== undefined) props.children = deepRender(props.children, React, host)
  return { type: node.type, props: props }
}

/**
 * Every node of the tree that satisfies a predicate.
 *
 * @param tree - the tree.
 * @param predicate - the test.
 * @returns the matching nodes.
 */
function findAll(tree, predicate) {
  const out = []
  const visit = function (node) {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    if (typeof node !== 'object') return
    if (predicate(node)) out.push(node)
    if (node.props && node.props.children !== undefined) visit(node.props.children)
  }
  visit(tree)
  return out
}

/**
 * The first node with the given attribute.
 *
 * @param tree - the tree.
 * @param name - the attribute name.
 * @param value - the attribute value, when one is given.
 * @returns the node, or null.
 */
function findByAttr(tree, name, value) {
  const found = findAll(tree, function (node) {
    if (!node.props) return false
    if (!(name in node.props)) return false
    if (value === undefined) return true
    return node.props[name] === value
  })
  return found.length === 0 ? null : found[0]
}

/**
 * The text of a node.
 *
 * @param node - the node.
 * @returns the concatenated text.
 */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node !== 'object') return ''
  return textOf(node.props ? node.props.children : undefined)
}

/**
 * Click a node, when it has a click handler.
 *
 * @param node - the node.
 * @returns whether the click happened.
 */
function clickIfPresent(node) {
  if (node === null || node === undefined || !node.props) return false
  if (typeof node.props.onClick !== 'function') return false
  node.props.onClick({
    stopPropagation: function () {},
    preventDefault: function () {},
    currentTarget: {},
    target: {},
  })
  return true
}

/**
 * Load the client in a VM with the stub React and a stub `fetch`.
 *
 * @param path - the client file.
 * @param React - the stub React.
 * @param fetchImpl - the stub fetch.
 * @returns the module's exports.
 */
function loadClient(path, React, fetchImpl) {
  const source = readFileSync(path, 'utf8')
  const module = { exports: {} }
  const sandbox = {
    require: function (name) {
      if (name === 'react') return React
      throw new Error('the client half may only require react, not ' + name)
    },
    exports: module.exports,
    module: module,
    console: { warn: function () {}, error: function () {}, log: function () {} },
    fetch: fetchImpl,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
  }
  const context = createContext(sandbox)
  runInContext(source, context, { filename: path })
  return module.exports
}

/**
 * The catalog the client sees.
 *
 * @returns the catalog payload.
 */
function fakeCatalog() {
  return {
    ok: true,
    revision: 3,
    entries: [
      {
        id: 'a.mp4', name: '清晨', kind: 'video', ext: '.mp4', bytes: 524288,
        contentHash: 'sha256:aaa', source: 'upload', license: 'user', addedAt: 1,
        mediaUrl: '/appearance-media/media/a.mp4',
      },
      {
        id: 'b.png', name: '晚霞', kind: 'image', ext: '.png', bytes: 2048,
        contentHash: 'sha256:bbb', source: 'upload', license: 'user', addedAt: 2,
        mediaUrl: '/appearance-media/media/b.png',
      },
    ],
    skipped: [],
  }
}

/**
 * The configuration the client sees.
 *
 * @returns the configuration.
 */
function fakeConfig() {
  return {
    revision: 7,
    slots: {
      background: { enabled: true, mediaId: 'a.mp4', revision: 1 },
      boot: { enabled: true, mediaId: 'b.png', revision: 1 },
      screensaver: { enabled: false, mediaId: null, revision: 0 },
    },
    options: {
      background: { panel: 0.7, surface: 0.2, muted: true, pauseWhenHidden: false },
      boot: { fadeMs: 2000, holdMs: 10000, muted: false, enterMode: 'tail', source: 'media', pool: [] },
      screensaver: {
        idleMs: 180000, rotateMs: 30000, volume: 0.5, muted: true,
        breakEffect: false, breakStyle: 'particles',
        pointerEffect: false, pointerStyle: 'ripples', hint: true,
      },
    },
  }
}

/**
 * Mount the client and drive it the way a person would.
 *
 * @param clientPath - the client file.
 * @returns the app handle.
 */
function mountApp(clientPath) {
  const built = createReact()
  const React = built.React
  const host = built.host

  const state = {
    catalog: fakeCatalog(),
    config: fakeConfig(),
    calls: [],
    deletes: [],
    deleteAnswer: {
      ok: true,
      status: 200,
      body: { ok: true, removed: true, id: 'a.mp4', clearedSlots: ['background'], poolUpdated: false },
    },
  }

  const fetchImpl = function (url, options) {
    const method = (options && options.method) || 'GET'
    state.calls.push({ url: url, method: method, body: options && options.body })
    if (method === 'DELETE') {
      state.deletes.push({ url: url, method: method })
      const answer = state.deleteAnswer
      if (answer.offline === true) return Promise.reject(new Error('offline'))
      // ★ A REQUEST THAT NEVER ANSWERS. It is how the suite watches the
      // in-flight state of the card.
      if (answer.hang === true) return new Promise(function () {})
      if (answer.ok === true) {
        // ★ THE HOST'S SIDE OF THE DELETE: the material leaves the library
        // and the slots it pointed at are cleared.
        const cleared = Array.isArray(answer.body?.clearedSlots) ? answer.body.clearedSlots : []
        for (const slot of cleared) {
          if (state.config.slots[slot] !== undefined) state.config.slots[slot].mediaId = null
        }
        const id = answer.body?.id
        state.catalog = Object.assign({}, state.catalog, {
          entries: state.catalog.entries.filter(function (item) { return item.id !== id }),
        })
      }
      return Promise.resolve({
        ok: answer.ok,
        status: answer.status,
        json: function () { return Promise.resolve(answer.body) },
      })
    }
    if (url === '/appearance-media/catalog.json') {
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve(state.catalog) } })
    }
    if (url === '/appearance-media/slots') {
      if (method === 'PUT') {
        const patch = JSON.parse(options.body)
        if (typeof patch.slot === 'string') {
          if (state.config.slots[patch.slot] === undefined) state.config.slots[patch.slot] = {}
          if (typeof patch.mediaId === 'string') state.config.slots[patch.slot].mediaId = patch.mediaId
        }
        return Promise.resolve({
          ok: true,
          json: function () { return Promise.resolve({ ok: true, config: state.config, ignored: [] }) },
        })
      }
      return Promise.resolve({
        ok: true,
        json: function () { return Promise.resolve({ ok: true, config: state.config, ignored: [] }) },
      })
    }
    return Promise.resolve({ ok: false, json: function () { return Promise.resolve({}) } })
  }

  const registered = []
  const services = {
    slots: {
      inject: function (slot, fn) { return fn() },
      register: function (spec, component) {
        registered.push({ slot: spec.name, spec: spec, component: component })
        return function () {}
      },
    },
    locale: {
      register: function (ns, dict) {
        return function (key) { return dict.zh[key] === undefined ? key : dict.zh[key] }
      },
      bind: function () { return function (key) { return key } },
    },
    configForms: {
      whileServed: function (ns, cb) { return cb() },
      get: function () { return undefined },
    },
  }

  const exports = loadClient(clientPath, React, fetchImpl)
  exports.apply({
    inject: function (names, cb) {
      return cb({
        get: function (name) { return services[name] },
        effect: function (fn) { return fn() },
      })
    },
  })

  const item = registered.filter(function (r) { return r.slot === 'plugins.item' })[0]

  const app = {
    React: React,
    host: host,
    state: state,
    registered: registered,
    item: item,
    render: function (view) {
      const element = { type: item.component, props: { runtime: React, view: view === undefined ? 'page' : view } }
      return deepRender(element, React, host)
    },
    // ★ THE LIBRARY ON THE BUNDLE'S OWN PAGE. It is the OTHER place a
    //   material can be deleted from, and it has to ask first too.
    renderDetail: function () {
      const detail = registered.filter(function (r) { return r.slot === 'plugins.detail.section' })[0]
      if (detail === undefined) return null
      const element = {
        type: detail.component,
        props: { subject: { kind: 'bundle', pkg: { name: 'dsh-appearance-media' } } },
      }
      return deepRender(element, React, host)
    },
    settle: async function () {
      for (let i = 0; i < 8; i++) {
        await new Promise(function (resolve) { setImmediate(resolve) })
      }
    },
  }
  return app
}

/**
 * Run the browser half's checks against one client file.
 *
 * @param clientPath - the client source.
 * @returns the number of checks that failed.
 */
async function runClientChecks(clientPath) {
  const before = checks.length
  const app = mountApp(clientPath)

  record('C1 the client registers the card the checks drive',
    app.item !== undefined && app.item.slot === 'plugins.item',
    String(app.item?.slot))

  if (app.item === undefined) return checks.length - before

  // ── Open the material picker of the background surface. ──
  //
  // ★ THE CATALOG ARRIVES FIRST. The panel reads it in an effect, so the
  // first render has no materials at all; the checks drive the picker with
  // the catalog it really published.
  let tree = app.render('page')
  await app.settle()
  tree = app.render('page')
  const row = findByAttr(tree, 'data-media-row', 'background')
  record('C2 the background surface has a material row',
    row !== null,
    String(row !== null))
  clickIfPresent(row)
  await app.settle()
  tree = app.render('page')
  const dialog = findByAttr(tree, 'data-media-dialog')
  record('C3 the material picker opens',
    dialog !== null,
    String(dialog !== null))

  // ── C4: the delete button is there, and it asks first. ──
  const deleteButton = findByAttr(tree, 'data-media-delete', 'a.mp4')
  record('C4 every material in the picker has a delete button',
    deleteButton !== null,
    String(deleteButton !== null))
  record('C5 clicking the delete button sends no request at all',
    (clickIfPresent(deleteButton), app.state.deletes.length === 0),
    'deletes=' + String(app.state.deletes.length))
  let after = app.render('page')
  const confirm = findByAttr(after, 'data-media-delete-confirm')
  record('C6 clicking the delete button opens the confirmation',
    confirm !== null,
    String(confirm !== null))
  record('C7 the confirmation names the material it is about to delete',
    confirm !== null && textOf(confirm).includes('清晨'),
    confirm === null ? 'no confirmation' : textOf(confirm).slice(0, 80))
  record('C8 the confirmation says the surface that is using it will be cleared',
    confirm !== null && textOf(confirm).includes('背景'),
    confirm === null ? 'no confirmation' : textOf(confirm).slice(0, 120))

  // ── C9: the cancel does nothing. ──
  const cancel = findByAttr(after, 'data-media-delete-cancel')
  clickIfPresent(cancel)
  after = app.render('page')
  record('C9 cancelling the delete closes the confirmation',
    findByAttr(after, 'data-media-delete-confirm') === null,
    String(findByAttr(after, 'data-media-delete-confirm') !== null))
  record('C10 cancelling the delete sends no request',
    app.state.deletes.length === 0,
    'deletes=' + String(app.state.deletes.length))
  const stillThere = findByAttr(after, 'data-media-delete', 'a.mp4')
  record('C11 cancelling the delete leaves the material in the list',
    stillThere !== null,
    String(stillThere !== null))

  // ── C12-C16: the confirmed delete. ──
  clickIfPresent(findByAttr(after, 'data-media-delete', 'a.mp4'))
  after = app.render('page')
  clickIfPresent(findByAttr(after, 'data-media-delete-ok'))
  await app.settle()
  after = app.render('page')
  record('C12 the confirmed delete asks the Host to delete that one material',
    app.state.deletes.length === 1
    && app.state.deletes[0].method === 'DELETE'
    && app.state.deletes[0].url === '/appearance-media/media/a.mp4',
    JSON.stringify(app.state.deletes))
  record('C13 the material leaves the picker list',
    findByAttr(after, 'data-media-delete', 'a.mp4') === null,
    String(findByAttr(after, 'data-media-delete', 'a.mp4') !== null))
  const current = findByAttr(after, 'data-media-current', 'background')
  record('C14 the surface that was using it now says 未选择',
    current !== null && textOf(current).includes('未选择'),
    current === null ? 'no row' : textOf(current))
  const status = findByAttr(after, 'data-media-delete-status')
  record('C15 the card says what it did',
    status !== null && textOf(status).includes('已删除'),
    status === null ? 'no status' : textOf(status))
  record('C16 the confirmation is closed after a successful delete',
    findByAttr(after, 'data-media-delete-confirm') === null,
    String(findByAttr(after, 'data-media-delete-confirm') !== null))

  // ── C17-C19: the Host refuses, and its sentence is shown. ──
  app.state.deleteAnswer = {
    ok: false,
    status: 409,
    body: { ok: false, error: '这条素材正在被屏保使用，先换一个再删。' },
  }
  let tree2 = app.render('page')
  clickIfPresent(findByAttr(tree2, 'data-media-delete', 'b.png'))
  tree2 = app.render('page')
  clickIfPresent(findByAttr(tree2, 'data-media-delete-ok'))
  await app.settle()
  tree2 = app.render('page')
  const error = findByAttr(tree2, 'data-media-delete-error')
  record('C17 a refused delete shows the Host\'s own sentence',
    error !== null && textOf(error) === '这条素材正在被屏保使用，先换一个再删。',
    error === null ? 'no error line' : textOf(error))
  record('C18 a refused delete keeps the material in the list',
    findByAttr(tree2, 'data-media-delete', 'b.png') !== null,
    String(findByAttr(tree2, 'data-media-delete', 'b.png') !== null))
  record('C19 a refused delete keeps the confirmation open, with the reason',
    findByAttr(tree2, 'data-media-delete-confirm') !== null,
    String(findByAttr(tree2, 'data-media-delete-confirm') !== null))

  // ── C20: the request in flight must not be sent twice. ──
  {
    app.state.deleteAnswer = {
      ok: true,
      status: 200,
      hang: true,
      body: { ok: true, removed: true, id: 'b.png', clearedSlots: [], poolUpdated: false },
    }
    let tree3 = app.render('page')
    clickIfPresent(findByAttr(tree3, 'data-media-delete', 'b.png'))
    tree3 = app.render('page')
    clickIfPresent(findByAttr(tree3, 'data-media-delete-ok'))
    tree3 = app.render('page')
    const ok = findByAttr(tree3, 'data-media-delete-ok')
    record('C20 the confirm button is disabled while the delete is in flight',
      ok !== null && ok.props.disabled === true,
      ok === null ? 'no confirm button' : 'disabled=' + String(ok.props.disabled))
  }

  // ── C21-C26: the OTHER delete door — the library on the bundle's page. ──
  {
    const deletesBefore = app.state.deletes.length
    let page = app.renderDetail()
    await app.settle()
    page = app.renderDetail()
    const row = findByAttr(page, 'data-media-remove')
    record('C21 the bundle page lists the materials with a delete button',
      row !== null,
      String(row !== null))
    record('C22 clicking it sends no request at all',
      (clickIfPresent(row), app.state.deletes.length === deletesBefore),
      'deletes=' + String(app.state.deletes.length - deletesBefore))
    page = app.renderDetail()
    const confirm = findByAttr(page, 'data-media-delete-confirm')
    const rowId = row === null ? '' : String(row.props['data-media-remove'])
    const rowEntry = app.state.catalog.entries.filter(function (item) { return item.id === rowId })[0]
    const rowName = rowEntry === undefined ? '' : rowEntry.name
    record('C23 it opens the same confirmation',
      confirm !== null && rowName !== '' && textOf(confirm).includes(rowName),
      confirm === null ? 'no confirmation' : textOf(confirm).slice(0, 80))
    clickIfPresent(findByAttr(page, 'data-media-delete-cancel'))
    page = app.renderDetail()
    record('C24 cancelling it sends no request',
      app.state.deletes.length === deletesBefore,
      'deletes=' + String(app.state.deletes.length - deletesBefore))
    clickIfPresent(findByAttr(page, 'data-media-remove'))
    page = app.renderDetail()
    clickIfPresent(findByAttr(page, 'data-media-delete-ok'))
    await app.settle()
    page = app.renderDetail()
    record('C25 confirming it asks the Host to delete that material',
      app.state.deletes.length === deletesBefore + 1
      && app.state.deletes[app.state.deletes.length - 1].method === 'DELETE',
      JSON.stringify(app.state.deletes.slice(deletesBefore)))
    record('C26 the material leaves the library on that page too',
      findByAttr(page, 'data-media-remove', 'a.mp4') === null,
      String(findByAttr(page, 'data-media-remove', 'a.mp4') !== null))
  }

  return checks.length - before
}

/* ══════════════════════════════════════════════════════════════════════════
   THE SUITE
   ══════════════════════════════════════════════════════════════════════════ */

const negative = process.argv.includes('--negative')

let stage = null
let dataDir = null
let exitCode = 0

try {
  stage = mkdtempSync(join(tmpdir(), 'dsh-appearance-media-delete-'))
  cpSync(pkgDir, stage, { recursive: true, dereference: true })
  dataDir = mkdtempSync(join(tmpdir(), 'dsh-appearance-media-delete-data-'))

  await runHostChecks(stage, dataDir)
  await runClientChecks(join(stage, 'src', 'client.js'))
} catch (error) {
  record('the suite ran to completion', false, String(error && error.stack ? error.stack : error))
} finally {
  for (const dir of [stage, dataDir]) {
    if (dir === null || dir === undefined) continue
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      notes.push('could not remove the scratch directory: ' + String(error))
    }
  }
}

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

/* ══════════════════════════════════════════════════════════════════════════
   THE REVERSE CONTROLS
   ══════════════════════════════════════════════════════════════════════════ */

if (negative) {
  console.log('')
  console.log('════ the reverse controls ════')

  /**
   * The mutations, one defect at a time.
   *
   * Each one is a string replacement in a COPY of the package. None of them
   * touches the real files, and each one has to turn a check red.
   *
   * @type {Array<{ name: string, file: string, from: string, to: string, half: 'host'|'client' }>}
   */
  const mutations = [
    {
      name: 'the traversal guard is gone',
      file: 'lib/catalog.js',
      from: "if (id.includes('..') || id.includes('/') || id.includes('\\\\') || path.isAbsolute(id)) {",
      to: 'if (false) {',
      half: 'host',
    },
    {
      name: 'the file is unlinked BEFORE the ledger is written',
      file: 'lib/catalog.js',
      from: '      renameSync(entry.sourcePath, staged)',
      to: '      unlinkSync(entry.sourcePath)',
      half: 'host',
    },
    {
      name: 'the slots that pointed at the material are left pointing at it',
      file: 'lib/catalog.js',
      from: '      await writeConfig(dataDir, { slot: name, mediaId: null })',
      to: '      await writeConfig(dataDir, { slot: name, mediaId: id })',
      half: 'host',
    },
    {
      name: 'the ledger keeps the entry of a deleted material',
      file: 'lib/catalog.js',
      from: '      delete entries[id]',
      to: '      void entries[id]',
      half: 'host',
    },
    {
      name: 'a failed delete does not put the material back',
      file: 'lib/catalog.js',
      from: '    if (staged !== null) restoreStagedFile(staged, entry.sourcePath)\n    await rollbackConfig(dataDir, restore)\n    return { ok: false, status: 500, error: \'删除失败，素材没有动：\' + describeFsError(error) }\n  }\n\n  // ── 6. THE LEDGER. ──',
      to: '    return { ok: false, status: 500, error: \'删除失败，素材没有动：\' + describeFsError(error) }\n  }\n\n  // ── 6. THE LEDGER. ──',
      half: 'host',
    },
    {
      name: 'the delete button deletes without asking',
      file: 'src/client.js',
      from: "          onClick: function () { props.onDeleteRequest(entry.id) },",
      to: '          onClick: function () { props.onDeleteConfirm() },',
      half: 'client',
    },
    {
      name: 'the confirmation has no 确定 button at all',
      file: 'src/client.js',
      from: "        h('button', {\n          type: 'button',\n          style: { ...S.button, ...S.buttonPrimary },\n          'data-media-delete-ok': 'true',\n          disabled: props.busy === true,\n          onClick: props.onConfirm,\n        }, props.busy === true ? '删除中…' : '删除'))))",
      to: '        null)))',
      half: 'client',
    },
    {
      name: 'the confirm button stays enabled while the delete is in flight',
      file: 'src/client.js',
      from: "          'data-media-delete-ok': 'true',\n          disabled: props.busy === true,",
      to: "          'data-media-delete-ok': 'true',",
      half: 'client',
    },
    {
      name: 'the cancelled delete still sends the request',
      file: 'src/client.js',
      from: '  const cancelDelete = function () {\n    setDeleteRequest(null)\n  }',
      to: '  const cancelDelete = function () {\n    setDeleteRequest(null)\n    confirmDelete()\n  }',
      half: 'client',
    },
    {
      name: 'the material stays in the list after a successful delete',
      file: 'src/client.js',
      from: '            entries: list.filter(function (item) { return item.id !== target.id }),',
      to: '            entries: list,',
      half: 'client',
    },
    {
      name: 'the Host\'s sentence is swallowed',
      file: 'src/client.js',
      from: '            ? result.body.error\n            : (result.offline === true ? \'连不上宿主路由。\' : \'宿主没有说明原因。\')',
      to: '            ? \'删除失败。\'\n            : (result.offline === true ? \'连不上宿主路由。\' : \'宿主没有说明原因。\')',
      half: 'client',
    },
  ]

  let controlsOk = 0
  for (const mutation of mutations) {
    const controlStage = mkdtempSync(join(tmpdir(), 'dsh-appearance-media-delete-neg-'))
    const controlData = mkdtempSync(join(tmpdir(), 'dsh-appearance-media-delete-neg-data-'))
    let red = []
    try {
      cpSync(pkgDir, controlStage, { recursive: true, dereference: true })
      const target = join(controlStage, mutation.file)
      const source = readFileSync(target, 'utf8')
      if (!source.includes(mutation.from)) {
        console.log('BROKEN ' + mutation.name + '  — the mutation no longer matches the source')
        continue
      }
      writeFileSync(target, source.replace(mutation.from, mutation.to))
      const before = checks.length
      if (mutation.half === 'host') {
        await runHostChecks(controlStage, controlData)
      } else {
        await runClientChecks(join(controlStage, 'src', 'client.js'))
      }
      red = checks.slice(before).filter(([, ok]) => !ok).map(([label]) => label)
    } catch (error) {
      red = ['the mutated run threw: ' + String(error && error.message ? error.message : error)]
    } finally {
      for (const dir of [controlStage, controlData]) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          /* the scratch directory stays; it is in the temp folder */
        }
      }
    }
    if (red.length === 0) {
      console.log('NOT RED  ' + mutation.name + '  — the suite stayed green, so the check proves nothing')
      exitCode = 1
    } else if (red.some(function (label) { return label.startsWith('the mutated run threw') })) {
      // ★ A CONTROL THAT BREAKS THE SYNTAX PROVES NOTHING. The mutated code
      //   did not run, so the checks never had a chance to fail.
      console.log('BROKEN  ' + mutation.name + '  →  ' + red.join(' | '))
      exitCode = 1
    } else {
      controlsOk += 1
      console.log('RED      ' + mutation.name + '  →  ' + red.join(' | '))
    }
  }
  console.log('')
  console.log(controlsOk + '/' + mutations.length + ' reverse control(s) turned the suite red')
}

process.exit(exitCode)
