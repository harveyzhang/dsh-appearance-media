// dsh-appearance-media — Host half.
//
// Three contributions, and nothing else in this build:
//
//   1. a `Config` schema (ONE field, volatile) so DSH can serve this entry as
//      a settings namespace and edit it live;
//   2. seven HTTP routes — the media catalog, a health probe, the upload and
//      remove routes, the media route that serves the bytes, the slot
//      configuration, the machine's idle time and the optimize route;
//   3. six `webserver/index-inject` rows: a tiny state object, the media
//      adapters, the arbitration point, the chat background surface, the boot
//      screen and the idle screensaver.
//
// ★ THE INJECTED ROWS ARE SCRIPT TEXT, AND THE FIVE NEW ONES ARE READ FROM
//   THE FILES ON EVERY INDEX RENDER.
//
//   `src/renderers.js`, `src/controller.js`, `src/background.js`,
//   `src/boot-screen.js` and `src/screensaver.js` are plain script text: the
//   Host reads them with `readFileSync` and pushes them as inline
//   `kind:'script'` rows. They are NOT bundled into the client half, because
//   the client half loads too late: the boot screen has to be able to ask the
//   arbitration point for a surface BEFORE the shell exists.
//
//   Reading them per render (not once at module load) is what makes an edit
//   to any of them visible on the next page reload, with no host restart.
//
// ★ THE NUMBER OF ROWS IS FIXED AT MOUNT TIME.
//
//   The table is filled when the host renders the page index, and the rows
//   this file pushes are read from disk at that moment. ⇒ adding a row means
//   the host has to be restarted before the new surface is in the page; the
//   TEXT of a row that is already there is re-read on every render, so an
//   edit to an existing surface needs only a page reload.
//
// ★ THE CATALOG'S REVISION IS NOT A CONFIG FIELD.
//
// It USED to be: `catalogRevision`, a volatile number the settings form showed
// as a text box. That box was a lie — the Host increments NOTHING on a
// plugin's behalf, so a number typed into it changed nothing at all, and it
// was a second source of truth beside the ledger's own revision.
//
// The revision now comes from the LEDGER (`lib/store.js`), which increments it
// on every write, and it is read per request. The field is gone: the input
// box is gone; the locale text that described it is gone.
//
// THREE HOST FACTS this file is written against, each verified in the installed
// 0.2.2-rc.2 sources rather than remembered:
//
//   * cordis validates a plugin's config through `runtime.Config['~standard']
//     .validate(config)` (@deepseek-ai/cordis/src/fiber.ts:53). A `Config` that
//     is not a standard-schema cannot be validated at all, so the built-in
//     fallback layer below implements `~standard.validate` itself.
//   * `@deepseek-ai/dsh-settings` projects a settings form by reading
//     `schema.meta.volatile`, `schema.type` and `schema.dict`
//     (dsh-settings/src/schema.ts:37-47). A schema missing any of those three
//     shapes throws there rather than "not showing a card", so the fallback
//     nodes carry all three.
//   * `.volatile()` RETURNS A NEW NODE: `return this.extra('volatile', true)`
//     (schemastery lib/index.mjs:235). The original node is never marked, so
//     calling `.volatile()` twice on the same ORIGINAL node is harmless — but
//     calling it again on the RESULT throws ("volatile schema is already
//     wrapped"). The rule for this file: call `.volatile()` exactly once per
//     field, and never call it on its own result.
//
// The applied config carries volatile fields as live references, not values: a
// field read as `config.dataDir` yields the reference object, not the string.
// Every read goes through `readField()` (lib/paths.js), which unwraps it.

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { closeSync, openSync, readFileSync, readSync, statSync, utimesSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dataDir as resolveDataDir, mediaDir } from './lib/paths.js'
import { publicEntry, resolveById } from './lib/catalog.js'
import { buildRoutes, PLUGIN_VERSION } from './lib/routes/catalog.js'
import { buildIdleRoutes } from './lib/routes/idle.js'
import { buildMediaRoutes } from './lib/routes/media.js'
import { buildSlotsRoutes } from './lib/routes/slots.js'
import { buildUploadRoutes } from './lib/routes/upload.js'
import { MAX_OPTIMIZE_BYTES, optimizeInPlace } from './lib/remux.js'
import { ledgerRevision, updateLedger } from './lib/store.js'

/** Package name the loader mounts this row as. */
export const name = 'dsh-appearance-media'

/**
 * Services this half consumes.
 *
 * `webServer` is required: without it there is no route to register.
 *
 * ★ `connection` is required too, and not for plumbing: it carries the Host's
 *   access check (`requestRejection`). Without it, every route of this plugin
 *   would answer a request from ANY web page the user happens to have open —
 *   a page in another tab could upload material, rewrite the slot
 *   configuration, or delete material. The Host's check is the Host/Origin
 *   check plus browser authentication, which answers exactly the question
 *   "is this request really from this application?".
 *
 *   It is a REQUIRED service rather than an optional one on purpose: a plugin
 *   that cannot tell a legitimate request from a forged one has no business
 *   exposing a route that writes files. A Host without the service refuses to
 *   load this plugin, loudly — which is much better than loading it wide open.
 */
export const inject = ['webServer', 'connection']

/** The version this build reports, in step with package.json. */
export const VERSION = PLUGIN_VERSION

/**
 * The row this plugin contributes to the page index.
 *
 * `kind:'script'` and nothing else. A `script-src` row is an EXTERNAL script:
 * when its load fails, the host's boot-readiness marker never resolves and the
 * whole application hangs on the boot page. An inline script cannot fail to
 * load, so this plugin never contributes one.
 */
const INDEX_SCRIPT = 'globalThis.__DSH_APPEARANCE__ = { version:\'0.1.0\', state: function(){ return { version:\'0.1.0\', ready:true } } }'

/**
 * The two injected script texts, read from their own files.
 *
 * They are resolved relative to THIS module, so they travel with the package
 * wherever it is installed: `fileURLToPath(new URL('./src/renderers.js',
 * import.meta.url))` is the same trick the boot-animation plugin uses for its
 * injected screen.
 */
const RENDERERS_SOURCE_PATH = fileURLToPath(new URL('./src/renderers.js', import.meta.url))
const CONTROLLER_SOURCE_PATH = fileURLToPath(new URL('./src/controller.js', import.meta.url))
const BACKGROUND_SOURCE_PATH = fileURLToPath(new URL('./src/background.js', import.meta.url))
const BOOT_SCREEN_SOURCE_PATH = fileURLToPath(new URL('./src/boot-screen.js', import.meta.url))
const SCREENSAVER_SOURCE_PATH = fileURLToPath(new URL('./src/screensaver.js', import.meta.url))

/**
 * Read one injected script and push it into the index table.
 *
 * ★ A FILE THAT CANNOT BE READ DOES NOT SILENTLY VANISH.
 *
 * A row that is missing is a surface that is missing, and a surface that is
 * missing is a failure nobody can see. So the row is still pushed — carrying
 * the reason — and the reason names the global that was supposed to be
 * defined, so the page says what did not happen.
 *
 * @param {Array} table - the index table.
 * @param {string} path - the file to read.
 * @param {string} globalName - the global the file is supposed to define.
 */
function pushInjectedScript(table, path, globalName) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    const message = '读不到 ' + path + '：' + String(error && error.message ? error.message : error)
    try {
      console.warn('[dsh-appearance-media] ' + message)
    } catch {
      /* a console that cannot print must not stop the plugin */
    }
    table.push({
      kind: 'script',
      placement: 'head',
      text: 'globalThis.__DSH_APPEARANCE_INJECT_ERROR__ = { global: \''
        + globalName + '\', message: ' + JSON.stringify(message) + ' }',
    })
    return
  }
  table.push({ kind: 'script', placement: 'head', text })
}

/**
 * Resolve the schema library, or fall back to the built-in layer.
 *
 * `@deepseek-ai/schemastery` is a PEER dependency: the host supplies it. A
 * plugin installed without that peer (a half-linked checkout, a profile whose
 * node_modules lost the package) must still boot — the routes and the injected
 * row do not need a schema at all. What it loses is the settings card.
 *
 * The returned `Schema` is used exactly like the real one: `.object()`,
 * `.string()`, `.number()`, `.boolean()`, and the chainable `.min()`, `.max()`,
 * `.default()` and `.volatile()`.
 *
 * @returns `{ Schema, source }` where source is 'schemastery' or 'builtin'.
 */
function resolveSchemaLibrary() {
  const requireFromHere = createRequire(import.meta.url)
  try {
    const loaded = requireFromHere('@deepseek-ai/schemastery')
    // The CommonJS build exports the Schema class itself (`module.exports =
    // Schema`), so the class IS the namespace; the `.default` branch only
    // matters for an interop build that wraps it.
    if (typeof loaded?.object === 'function') return { Schema: loaded, source: 'schemastery' }
    if (typeof loaded?.default?.object === 'function') {
      return { Schema: loaded.default, source: 'schemastery' }
    }
  } catch (error) {
    /* the peer package is not resolvable from here — the built-in layer takes over */
  }
  return { Schema: createFallbackSchema(), source: 'builtin' }
}

/**
 * The built-in minimal schema layer.
 *
 * It exists so a missing peer package cannot stop the plugin from loading. It
 * is deliberately small, but it is not a toy: it carries the three shapes
 * `dsh-settings` reads (`meta`, `type`, `dict`), a `toJSON()` in the shape
 * schemastery can re-parse, and a `~standard.validate()` that cordis can call.
 *
 * Every chainable method returns a NEW node, like the real library: `.volatile()`
 * marks the copy, never the original.
 *
 * @returns a minimal stand-in for the schemastery `Schema` namespace.
 */
function createFallbackSchema() {
  /** The symbol cosmokit puts on a live config reference. */
  const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
  let nextUid = 1

  /**
   * One schema node.
   * @param type - 'object' | 'string' | 'number' | 'boolean'.
   * @param source - the node to copy, if any.
   * @returns the new node.
   */
  function createNode(type, source) {
    const self = {
      uid: nextUid++,
      type,
      meta: { ...(source?.meta ?? {}) },
      dict: source?.dict ?? {},
      list: source?.list ?? [],
      inner: source?.inner,
      sKey: source?.sKey,
      min(value) {
        const next = createNode(type, self)
        // schemastery's own key names: `meta.min` / `meta.max`
        // (schemastery/src/index.ts:470). A different key would be invisible to
        // every consumer that reads schemastery's constraints.
        next.meta.min = value
        return next
      },
      max(value) {
        const next = createNode(type, self)
        next.meta.max = value
        return next
      },
      default(value) {
        const next = createNode(type, self)
        next.meta.default = value
        return next
      },
      volatile() {
        const next = createNode(type, self)
        next.meta.volatile = true
        return next
      },
      toJSON() {
        return schemaJson(self)
      },
    }
    self['~standard'] = {
      version: 1,
      // The vendor string is 'schemastery' on purpose. The host's browser
      // bundle switches between two schema-merging implementations on exactly
      // this string, and this layer is a schemastery-compatible
      // implementation — its nodes carry the same shapes (uid / refs / dict /
      // meta / list / inner / sKey) and the same `toJSON()`, so the host
      // should take the branch it prepared for schemastery.
      vendor: 'schemastery',
      validate: (value) => validateNode(self, value),
    }
    return self
  }

  /**
   * Serialize a node tree the way schemastery does: a uid plus a map of every
   * node in the tree. `new z(json)` re-parses this shape, which is what
   * `dsh-settings` does when it projects a form.
   *
   * @param root - the node to serialize.
   * @returns `{ uid, refs }`.
   */
  function schemaJson(root) {
    const refs = {}
    const collect = (node) => {
      if (refs[node.uid] !== undefined) return
      const entry = {
        uid: node.uid,
        type: node.type,
        meta: { ...node.meta },
        dict: {},
        list: [],
        inner: undefined,
        sKey: undefined,
      }
      refs[node.uid] = entry
      for (const [key, child] of Object.entries(node.dict ?? {})) {
        collect(child)
        entry.dict[key] = child.uid
      }
      for (const child of node.list ?? []) {
        collect(child)
        entry.list.push(child.uid)
      }
      if (node.inner !== undefined && node.inner !== null) {
        collect(node.inner)
        entry.inner = node.inner.uid
      }
      return entry
    }
    collect(root)
    return { uid: root.uid, refs }
  }

  /**
   * Wrap a resolved value in a live reference, the way cosmokit does.
   * @param value - the snapshot the reference answers with.
   * @returns a frozen `{ get }` reference carrying the write symbol.
   */
  function createVolatile(value) {
    let current = value
    const reference = {
      get: () => current,
      [VOLATILE_WRITE]: (next) => {
        current = next
      },
    }
    return Object.freeze(reference)
  }

  /**
   * Resolve one value against one node.
   *
   * @param node - the schema node.
   * @param value - the raw value, possibly undefined.
   * @param path - the path of this value, for issue reporting.
   * @param issues - the issue list to append to.
   * @returns the resolved value; a live reference when the node is volatile.
   */
  function resolveValue(node, value, path, issues) {
    if (node.type === 'object') {
      if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
        issues.push({ message: 'expected an object', path })
        return undefined
      }
      const source = value === undefined || value === null ? {} : value
      const resolved = {}
      for (const [key, child] of Object.entries(node.dict ?? {})) {
        resolved[key] = resolveValue(child, source[key], [...path, key], issues)
      }
      return resolved
    }

    let current = value
    if (current === undefined) {
      if (!('default' in node.meta)) return undefined
      current = node.meta.default
    }

    const typeOk = node.type === 'string'
      ? typeof current === 'string'
      : node.type === 'boolean'
        ? typeof current === 'boolean'
        : typeof current === 'number' && Number.isFinite(current)
    if (!typeOk) {
      issues.push({ message: `expected ${node.type}`, path })
      return undefined
    }
    if (node.type === 'number') {
      if (typeof node.meta.min === 'number' && current < node.meta.min) {
        issues.push({ message: `expected a number >= ${node.meta.min}`, path })
        return undefined
      }
      if (typeof node.meta.max === 'number' && current > node.meta.max) {
        issues.push({ message: `expected a number <= ${node.meta.max}`, path })
        return undefined
      }
    }

    return node.meta.volatile === true ? createVolatile(current) : current
  }

  /**
   * Validate one value against one node, in the standard-schema shape.
   * @param node - the schema node.
   * @param value - the raw value.
   * @returns `{ value }` or `{ issues }`.
   */
  function validateNode(node, value) {
    const issues = []
    const resolved = resolveValue(node, value, [], issues)
    if (issues.length > 0) return { issues }
    return { value: resolved }
  }

  return {
    string: () => createNode('string'),
    number: () => createNode('number'),
    boolean: () => createNode('boolean'),
    object: (dict) => {
      const node = createNode('object')
      node.dict = { ...(dict ?? {}) }
      return node
    },
  }
}

const { Schema, source: SCHEMA_SOURCE } = resolveSchemaLibrary()

/**
 * Whether the resolved schema library can mark a field live-editable.
 *
 * `.volatile()` is what makes `dsh-settings` project a field into the form the
 * settings page renders. The kernel's copy has it; an older copy linked beside
 * a workspace checkout does not, and calling it there would throw while this
 * module is being evaluated — taking the routes and the injected row down with
 * the settings card.
 *
 * The built-in layer implements `.volatile()` itself, so the probe is about the
 * real library only.
 */
const LIVE_CAPABLE = SCHEMA_SOURCE === 'builtin' || typeof Schema.boolean().volatile === 'function'

/**
 * Mark one Config field live-editable.
 *
 * `.volatile()` is called EXACTLY ONCE here, on a freshly built node. Its
 * result is never passed back through this function: calling `.volatile()` on
 * a result throws ("volatile schema is already wrapped").
 *
 * @param schema - the field schema.
 * @returns the field schema, volatile when the library supports it.
 */
function live(schema) {
  return LIVE_CAPABLE ? schema.volatile() : schema
}

if (SCHEMA_SOURCE === 'builtin') {
  console.warn(
    '[dsh-appearance-media] schemastery 不可解析，Config 降级为内置兼容层；'
    + '宿主环境下会自动使用真实 schemastery。',
  )
} else if (!LIVE_CAPABLE) {
  console.warn(
    '[dsh-appearance-media] 解析到的 @deepseek-ai/schemastery 没有 .volatile()，'
    + 'Config 降级为非 volatile 字段：DSH 不会把这个条目当作设置命名空间伺服。',
  )
}

/**
 * This entry's Host configuration schema.
 *
 * ONE field, volatile, and it is about WHERE THINGS LIVE:
 *
 *   - `dataDir` — the directory the media library lives in. An empty string
 *     means "the default", which `lib/paths.js` resolves to
 *     `~/.dsh/dsh-appearance-media`. An absolute path overrides it.
 *
 * ★ THERE IS NO `catalogRevision` FIELD ANY MORE.
 *
 * It was a volatile number the settings form showed as a text box, and the box
 * was a lie: the Host increments NOTHING on a plugin's behalf, so a number
 * typed into it changed nothing at all — and it stood beside the ledger's own
 * revision as a second source of truth. The revision now comes from the ledger
 * (`lib/store.js`), which increments it on every write.
 *
 * The namespace is not named here: it is the entry id the profile patch mounts
 * this row under, `- insert: id: appearance-media`, and the browser half
 * spells that same string in its `configForms` gate.
 */
export const Config = Schema.object({
  dataDir: live(Schema.string().default('')),
})

// ───────────────────────────────────────────────────────────────────────────
// The optimize route.
//
//   POST /appearance-media/optimize   JSON `{ "mediaId": "…" }` in, the
//                                      rewritten material out.
//
// ★ IT LIVES HERE, IN `index.js`, AND NOT IN `lib/routes/`.
//
//   The package's own split is "index.js owns the registration, `lib/routes/`
//   owns WHAT a route answers" — but this route's handler was written while
//   the write scope for this change was limited to four files, and
//   `lib/routes/optimize.js` was not one of them. So the handler sits here,
//   with the registration, until the scope allows it to move. The split is
//   worth restoring; a route that cannot be moved out of the entry file
//   without breaking the entry file is a route that will not be.
//
// ★ IT ONLY TOUCHES FILES INSIDE THE MEDIA DIRECTORY.
//
//   The `mediaId` is checked for a traversal BEFORE anything is resolved: a
//   `..`, a path separator or an absolute path is a 400, never a lookup. The
//   catalog's own `resolveById` refuses those as well — an id that does not
//   match the library's id pattern resolves to nothing — but the route says
//   so itself, because a refusal that names its reason is worth more than one
//   that reads like "no such material".
//
// ★ THE REWRITE IS ATOMIC, AND THE ORIGINAL IS NEVER MOVED ASIDE.
//
//   The rewritten clip is staged inside the media directory and verified
//   there (same length, `moov` really in front of `mdat`), and only then is
//   it renamed OVER the original — one `rename(2)`. A reader sees the old clip
//   or the new one and never neither, and a failure at any step leaves the
//   original exactly where it was, byte for byte.

/** The optimize route. */
const OPTIMIZE_PATH = '/appearance-media/optimize'

/** The largest request body the optimize route accepts. */
const OPTIMIZE_BODY_LIMIT = 4 * 1024

/**
 * Answer one JSON response.
 *
 * `no-store`, like every other route in this package: the answer describes
 * what the library holds right now, and a cached answer is an answer that
 * lies.
 *
 * @param res - outgoing response.
 * @param status - HTTP status.
 * @param value - the JSON value.
 * @param extraHeaders - additional response headers.
 */
function sendJson(res, status, value, extraHeaders) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.byteLength),
    'Cache-Control': 'no-store',
    ...(extraHeaders ?? {}),
  })
  res.end(body)
}

/**
 * Read one small request body.
 *
 * ★ THE REQUEST IS NEVER DESTROYED. `req.destroy()` closes the socket BEFORE
 * the answer is written, so the client never sees the status code — it sees
 * "Empty reply from server". The body is DRAINED instead: it is dropped, the
 * stream keeps being read to its end, and the answer is written on a healthy
 * connection.
 *
 * @param req - the request.
 * @param limit - the largest body accepted.
 * @returns a promise for `{ ok: true, text }` or `{ ok: false, status, error }`.
 */
function readSmallBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let over = false
    let bodyEnded = false
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    req.on('error', () => finish({ ok: false, status: 400, error: '请求流中断。' }))
    req.on('data', (chunk) => {
      if (settled) return
      if (over) return
      size += chunk.length
      if (size > limit) {
        over = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      bodyEnded = true
      if (settled) return
      if (over) {
        finish({ ok: false, status: 413, error: '请求体太大。' })
        return
      }
      finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') })
    })
    req.on('close', () => {
      if (settled || bodyEnded) return
      finish({ ok: false, status: 400, error: '请求流中断。' })
    })
  })
}

/**
 * The sha256 of one file, read in chunks.
 *
 * The catalog's own hash cache is keyed by the file's size and mtime, and
 * this route deliberately keeps the mtime (see below), so that cache would
 * answer with the hash of the bytes from BEFORE the rewrite. The ledger is
 * therefore written with a hash computed here.
 *
 * @param absolute - the absolute path of the file.
 * @returns `sha256:<64 hex>`.
 */
function hashFile(absolute) {
  const hash = createHash('sha256')
  const fd = openSync(absolute, 'r')
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let read = readSync(fd, buffer, 0, buffer.length, null)
    while (read > 0) {
      hash.update(buffer.subarray(0, read))
      read = readSync(fd, buffer, 0, buffer.length, null)
    }
  } finally {
    closeSync(fd)
  }
  return 'sha256:' + hash.digest('hex')
}

/**
 * Turn a refusal into a sentence a person can act on.
 *
 * The upstream messages are already Chinese and already say what happened;
 * this only puts the headline in front of them, so the reason is readable
 * without reading the detail.
 *
 * @param code - the refusal's code.
 * @param error - the error.
 * @returns a short Chinese sentence.
 */
function describeOptimizeFailure(code, error) {
  const detail = String(error && error.message ? error.message : error)
  if (code === 'E_TOO_BIG') return '体积超过上限，没有动这条素材。' + detail
  if (code === 'E_UNSUPPORTED') return '这条素材没法优化，没有动它。' + detail
  return '优化失败，原文件保持原样。' + detail
}

/**
 * Build the optimize route.
 *
 * @param options - `readDataDir`, a reader called per request.
 * @returns the route descriptor.
 */
function buildOptimizeRoute({ readDataDir } = {}) {
  const readDir = typeof readDataDir === 'function' ? readDataDir : () => ''
  return {
    kind: 'exact',
    path: OPTIMIZE_PATH,
    handler: async (req, res) => {
      try {
        const method = String(req?.method ?? 'GET').toUpperCase()
        if (method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '这个地址只接受 POST。' }, { Allow: 'POST' })
          return
        }
        const dataDir = readDir()

        // 1. The body.
        const body = await readSmallBody(req, OPTIMIZE_BODY_LIMIT)
        if (body.ok !== true) {
          sendJson(res, body.status, { ok: false, error: body.error })
          return
        }
        let parsed = null
        try {
          parsed = JSON.parse(body.text)
        } catch {
          sendJson(res, 400, { ok: false, error: '请求体不是 JSON。' })
          return
        }
        const mediaId = parsed?.mediaId

        // 2. ★ THE TRAVERSAL GUARD, BEFORE ANY LOOKUP.
        if (typeof mediaId !== 'string' || mediaId.trim() === '') {
          sendJson(res, 400, { ok: false, error: '缺少 mediaId。' })
          return
        }
        if (mediaId.includes('..') || mediaId.includes('/') || mediaId.includes('\\')
          || path.isAbsolute(mediaId)) {
          sendJson(res, 400, { ok: false, error: 'mediaId 只能是素材库里的编号，不能带路径。' })
          return
        }

        // 3. The material, through the CATALOG's own resolver — the same
        // function the catalog route and the slot route use, so "the catalog
        // lists it" and "the optimize route accepts it" are one question.
        const entry = resolveById(dataDir, mediaId)
        if (entry === null) {
          sendJson(res, 404, { ok: false, error: '素材库里没有这条素材。' })
          return
        }
        if (entry.ext !== '.mp4') {
          sendJson(res, 400, { ok: false, error: '只有 mp4 能优化，' + entry.name + ' 不是 mp4。' })
          return
        }

        // 4. ★ AND THE FILE MUST BE INSIDE THE MEDIA DIRECTORY. `resolveById`
        // checks that already; this checks it again, because this is the one
        // place where a wrong answer would rewrite a file outside the library.
        const dir = mediaDir(dataDir)
        if (!entry.sourcePath.startsWith(dir + path.sep)) {
          sendJson(res, 400, { ok: false, error: '这条素材不在素材库里。' })
          return
        }

        // 5. The rewrite.
        //
        // The staging directory lives INSIDE the media directory, so the
        // rename that swaps the rewritten clip in is a rename on the same
        // filesystem — which is what makes it atomic.
        const before = statSync(entry.sourcePath)
        const scratchDir = path.join(dir, `.optimize-${String(process.pid)}-${String(Date.now())}`)
        let result = null
        try {
          result = await optimizeInPlace({
            file: entry.sourcePath,
            scratchDir,
            maxBytes: MAX_OPTIMIZE_BYTES,
          })
        } catch (error) {
          const code = typeof error?.code === 'string' ? error.code : 'E_FAILED'
          const status = code === 'E_TOO_BIG' ? 413 : (code === 'E_UNSUPPORTED' ? 400 : 500)
          sendJson(res, status, { ok: false, code, error: describeOptimizeFailure(code, error) })
          return
        }

        // 6. Already faststart: nothing was written, and the answer says so.
        if (result.status === 'already') {
          const current = resolveById(dataDir, mediaId)
          sendJson(res, 200, {
            ok: true,
            status: 'already',
            message: '已经是 faststart 了，不用优化。',
            entry: current === null ? null : publicEntry(current),
          })
          return
        }

        // 7. ★ THE FILE'S OWN TIMESTAMP IS PUT BACK.
        //
        // A hand-placed file's id is `fs-<slug>-<mtime>`: a rewritten file
        // with a new mtime gets a NEW id, and every slot that points at the
        // old one stops playing it. The optimization moves WHERE the index
        // sits, not WHAT the clip is, so the timestamp stays where it was.
        //
        // The seconds are passed as numbers so the sub-millisecond part
        // survives: the id is built from `Math.round(mtimeMs)`, and a rounded
        // timestamp would move the id by one.
        try {
          utimesSync(entry.sourcePath, before.atimeMs / 1000, before.mtimeMs / 1000)
        } catch (error) {
          // A timestamp that could not be restored is not a failed rewrite.
          console.warn('[dsh-appearance-media] 优化后没能还原文件时间戳：' + String(error))
        }

        // 8. The ledger follows: the bytes changed, so the size and the hash
        // it records must change with them. Otherwise the catalog keeps
        // answering with the hash of the bytes that are no longer there.
        const sizeAfter = statSync(entry.sourcePath).size
        try {
          const digest = hashFile(entry.sourcePath)
          await updateLedger(dataDir, (entries) => {
            const known = entries[mediaId] ?? {}
            entries[mediaId] = {
              ...known,
              name: typeof known.name === 'string' && known.name !== '' ? known.name : entry.name,
              kind: entry.kind,
              ext: entry.ext,
              bytes: sizeAfter,
              contentHash: digest,
              source: known.source === 'upload' ? 'upload' : 'library',
              sourcePath: entry.sourcePath,
              addedAt: Number.isFinite(known.addedAt) ? known.addedAt : Math.round(before.mtimeMs),
            }
          })
        } catch (error) {
          // The rewrite itself succeeded; a ledger that could not be written
          // is reported in the log, not turned into a failed optimization.
          console.warn('[dsh-appearance-media] 优化后没能更新账本：' + String(error))
        }

        const current = resolveById(dataDir, mediaId)
        sendJson(res, 200, {
          ok: true,
          status: 'done',
          message: '已把 moov 挪到前面：浏览器不用下完整个文件就能出第一帧。',
          bytes: sizeAfter,
          entry: current === null ? null : publicEntry(current),
        })
      } catch (error) {
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal' })
        else res.end()
      }
    },
  }
}

/**
 * Wrap a route handler with the Host's access check.
 *
 * ★ WHY THIS EXISTS
 *
 * A route on the Host's web server is reachable by anything that can make an
 * HTTP request to it. The Host's own pages are served from the same server,
 * so a page in the user's OTHER browser tab — or a page the user merely
 * visited — could call these routes: upload material, rewrite the slot
 * configuration, delete material.
 *
 * The Host owns the answer to "is this request really from this application?".
 * Its `connection.requestRejection(request)` applies the Host/Origin check and
 * browser authentication, and answers either:
 *
 *   - `undefined` — the request may proceed, or
 *   - a status code (401 / 403) — it must not.
 *
 * This wrapper asks that question before ANY of the plugin's own logic runs,
 * so a rejected request never reaches a handler that writes a file.
 *
 * @param {Function} handler - the route's own handler.
 * @param {object} connection - the Host's connection service.
 * @returns {Function} the guarded handler.
 */
export function guardHandler(handler, connection) {
  return function guarded(req, res) {
    const rejection = connection?.requestRejection?.(req)
    if (rejection !== undefined) {
      res.writeHead(rejection)
      res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    handler(req, res)
  }
}

/**
 * Mount the routes and the index injection.
 *
 * Every registration goes through `ctx.effect`, so the fiber owns it and
 * disposes it on unload — and the returned cleanup disposes the same handles
 * once more, idempotently, for a caller that tears the plugin down by hand.
 *
 * @param ctx - the Host plugin context.
 * @param config - the applied config; volatile fields arrive as live references.
 * @returns the cleanup function.
 */export function apply(ctx, config) {
  const server = ctx.webServer
  const dataDirectory = resolveDataDir(config)
  // The ledger's revision, AT STARTUP. It is a snapshot for the log line
  // below; the routes read it live (see the readers there).
  const revision = ledgerRevision(dataDirectory)

  /** Every disposer this plugin owns. */
  const disposers = []
  /** Whether the cleanup already ran. */
  let cleaned = false

  /**
   * Unregister everything this plugin registered.
   *
   * Idempotent, and callable from the failure path: a half-registered plugin
   * that leaves a route behind answers 200 forever, and the NEXT mount of the
   * same plugin dies on the host's duplicate-route check
   * (`webserver: duplicate exact route "…"`). Rolling back before the throw is
   * the only reliable defence against that; the fiber's own disposal is an
   * implicit backstop this code does not depend on.
   */
  const disposeAll = () => {
    if (cleaned) return
    cleaned = true
    for (const dispose of disposers) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        /* already unregistered */
      }
    }
  }

  try {
    // Every route this plugin owns: the catalog and the health probe, then
    // the upload, remove and media routes.
    const routes = [
      ...buildRoutes({
        // READERS, not snapshots. A volatile field that changes while the host
        // runs must be visible on the very next request, without a restart:
        // `resolveDataDir` reads `config.dataDir` through `readField` every time
        // it is called, and the volatile reference the loader commits into is the
        // SAME object the plugin holds.
        readDataDir: () => resolveDataDir(config),
        // ★ THE LEDGER'S REVISION, read per request. This is the whole point
        // of Task 2: the catalog's revision is the ledger's, and the ledger
        // moves whenever the library does. There is no config field behind it
        // any more — the Host increments nothing.
        readRevision: () => ledgerRevision(resolveDataDir(config)),
        version: VERSION,
      }),
      ...buildUploadRoutes({
        readDataDir: () => resolveDataDir(config),
      }),
      // ★ THE MEDIA ROUTE: the bytes of one material (GET, HEAD) and the
      // material itself (DELETE). It is ONE route because the Host's prefix
      // table holds one route per path — and the delete is the Host's work:
      // the browser cannot unlink a file in the media directory, and the Host
      // is the only side that knows which slots point at the material.
      ...buildMediaRoutes({
        readDataDir: () => resolveDataDir(config),
      }),
      // The slot configuration: which material each of the three slots plays,
      // whether it is on, and its options. Its own reader, for the same reason
      // the other two have one — a volatile `dataDir` edit has to be visible on
      // the very next request.
      ...buildSlotsRoutes({
        readDataDir: () => resolveDataDir(config),
      }),
      // ★ THE OPTIMIZE ROUTE. It rewrites a clip's index table so the
      // browser does not have to download the whole file before the first
      // frame — and it only ever touches files inside the media directory.
      buildOptimizeRoute({
        readDataDir: () => resolveDataDir(config),
      }),
      // ★ THE MACHINE'S IDLE TIME. The screensaver's trigger is half an
      // operating-system fact ("has anybody touched this computer at all"),
      // and a renderer cannot see it — only the Host half can. The route is
      // GET-only, and it answers `{ ok, idleMs, status, reason }` with three
      // DISTINCT states: a failed probe is never flattened into `idleMs: 0`.
      ...buildIdleRoutes({}),
    ]

    for (const route of routes) {
      // ★ EVERY route goes through the Host's access check. The guard is
      //   applied HERE, at the one place where a route is registered, so a
      //   route added later cannot forget it.
      const guarded = { ...route, handler: guardHandler(route.handler, ctx.connection) }
      disposers.push(ctx.effect(() => server.register(guarded), `appearance-media: ${route.path}`))
    }

    disposers.push(ctx.effect(
      () => ctx.on('webserver/index-inject', (table) => {
        if (!Array.isArray(table)) return
        // ★ SIX ROWS, IN THIS ORDER, AND THE ORDER IS THE CONTRACT.
        //
        //   1. the state object (this build's own, from Task 1);
        //   2. the media adapters — they define the factory the controller
        //      calls, so they have to be there first;
        //   3. the arbitration point — it calls the factory;
        //   4. the chat background surface (Task 5) — it asks the arbitration
        //      point to play, so it has to come after it;
        //   5. the boot screen (Task 6) — same contract: it asks the
        //      arbitration point to play, and it has to come after it;
        //   6. the idle screensaver (Task 7) — same contract again.
        //
        // ★ AND THE NUMBER OF ROWS IS FIXED WHEN THE HOST RENDERS THE INDEX.
        // The table is filled once per render and the rows are read from disk
        // at that moment ⇒ the sixth row is in the page after the host has
        // been restarted. A change to the TEXT of a row that is already there
        // needs only a page reload.
        table.push({ kind: 'script', placement: 'head', text: INDEX_SCRIPT })
        pushInjectedScript(table, RENDERERS_SOURCE_PATH, '__DSH_APPEARANCE_RENDERERS__')
        pushInjectedScript(table, CONTROLLER_SOURCE_PATH, '__DSH_APPEARANCE_CONTROLLER__')
        pushInjectedScript(table, BACKGROUND_SOURCE_PATH, '__DSH_APPEARANCE_BACKGROUND__')
        pushInjectedScript(table, BOOT_SCREEN_SOURCE_PATH, '__DSH_APPEARANCE_BOOT__')
        pushInjectedScript(table, SCREENSAVER_SOURCE_PATH, '__DSH_APPEARANCE_SCREENSAVER__')
      }),
      'appearance-media: index injection',
    ))
  } catch (error) {
    disposeAll()
    throw error
  }

  // The load record.
  //
  // This is the value AT STARTUP. It is a one-time record of what the plugin
  // mounted with; the routes do NOT answer from it — they read the config
  // live on every request (see the readers above), so a volatile edit is
  // visible immediately.
  //
  // TWO channels, because the Host's log exporter is configured at
  // `levels: { default: 2 }` — warnings and errors only. A cordis logger at
  // INFO level is therefore filtered out by the host, and a plugin whose only
  // record is an INFO line looks exactly like a plugin that never activated.
  //
  // `console.log` goes to the host process's stdout. The CLI prints it; a
  // desktop host shows no console to the user, so whether it reaches a person
  // there depends on that host's own diagnostics. The cordis logger is kept
  // for a host that is configured to show INFO.
  const record = `appearance-media ${VERSION}: 已挂载 ${dataDirectory}（catalog revision ${String(revision)}）`
  const log = typeof ctx.logger === 'function' ? ctx.logger('appearance-media') : undefined
  log?.info?.(record)
  try {
    console.log(`[dsh-appearance-media] ${record}`)
  } catch {
    /* a console that cannot print must not stop the plugin */
  }

  return disposeAll
}
