#!/usr/bin/env node
// dsh-appearance-media — offline acceptance for the Host half.
//
// What it proves, and what it deliberately does not:
//
//   * it mounts the REAL `apply()` from a scratch COPY of this package, with a
//     stub Host context, and drives the routes the plugin actually registered;
//   * it never starts DSH, never binds a port, never waits for anything.
//
// Why a copy rather than the package itself: the copy is what `import()` sees,
// so a scratch tree can never be mistaken for the installed package. The copy
// is made with `dereference: true` — installed, `node_modules` entries are
// symlinks, and a copy that preserves them points back at the real tree.
//
// A note on what this suite exercises: the scratch copy lives in the system
// temp directory, where the peer schema package does not resolve. So the
// offline run exercises the BUILT-IN fallback schema layer. The real
// schemastery is exercised by the live run, in a profile that has it.
//
// Usage: node tools/verify-routes.mjs

import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgDir = fileURLToPath(new URL('..', import.meta.url))

const CATALOG_PATH = '/appearance-media/catalog.json'
const HEALTH_PATH = '/appearance-media/health'

/** @type {Array<[string, boolean, string]>} */
const checks = []
/** @type {string[]} */
const notes = []

/**
 * Record one assertion.
 * @param label - what is asserted.
 * @param ok - whether it holds.
 * @param detail - the evidence, printed next to the label.
 */
function record(label, ok, detail = '') {
  checks.push([label, Boolean(ok), detail])
}

/**
 * Read one header case-insensitively.
 * @param headers - the header map the handler wrote.
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
 * Drive one route handler with a fake request and a fake response.
 *
 * The fake response is enough for the handlers under test: they only call
 * `writeHead` and `end`.
 *
 * @param route - the route descriptor.
 * @param method - the request method.
 * @returns `{ status, headers, body }`.
 */
function call(route, method = 'GET') {
  const req = { method, url: route.path, headers: {} }
  let status = 0
  let headers = {}
  let body = ''
  const res = {
    headersSent: false,
    ended: false,
    writeHead(code, extra) {
      status = code
      headers = extra ?? {}
      res.headersSent = true
      return res
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) {
        body = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      }
      res.ended = true
      return res
    },
    setHeader() {},
    getHeader() { return undefined },
  }
  route.handler(req, res)
  return { status, headers, body }
}

/**
 * Build a stub Host context.
 *
 * It records the routes the plugin registers, the events it subscribes to, and
 * the disposers it hands out, so the teardown can be CHECKED rather than
 * assumed.
 *
 * @param options - `failOnRegister` makes the Nth `register` call throw, the
 *   way the host throws on a duplicate route.
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

let stage = null
let dataDir = null
let exitCode = 0

try {
  stage = mkdtempSync(join(tmpdir(), 'dsh-appearance-media-verify-'))
  cpSync(pkgDir, stage, { recursive: true, dereference: true })

  // The scratch copy cannot resolve the peer schema package, so importing it
  // takes the built-in fallback path and warns about it. The warning is
  // captured rather than left to scroll past.
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

  // The route module, imported directly so the READER form can be exercised.
  const catalogModule = await import(pathToFileURL(join(stage, 'lib/routes/catalog.js')).href)

  /* ---- the plugin never writes the profile patch --------------------- */

  // The Host's configuration editor owns that file. A plugin that so much as
  // NAMES it is one rewrite away from writing it.
  const patchNamed = []
  for (const file of [
    'index.js',
    'lib/paths.js',
    'lib/store.js',
    'lib/catalog.js',
    'lib/upload.js',
    'lib/routes/catalog.js',
    'lib/routes/upload.js',
  ]) {
    let text = ''
    try {
      text = readFileSync(join(stage, file), 'utf8')
    } catch (error) {
      text = ''
    }
    if (text.includes('cordis.patch.yml')) patchNamed.push(file)
  }
  record('the plugin never names the profile patch file', patchNamed.length === 0,
    patchNamed.join(', '))

  /* ---- the built client artifact ------------------------------------- */

  // The built artifact, not the source: the artifact is what the host serves.
  //
  // The plugin must occupy exactly TWO slots. The third one — the Official
  // group's card slot — is the one that produced TWO cards for this plugin on
  // the Plugins page: the host already renders a card for an ordinary
  // installed bundle, so registering there as well was a duplicate.
  let artifact = ''
  try {
    artifact = readFileSync(join(stage, 'lib', 'client.js'), 'utf8')
  } catch (error) {
    artifact = ''
  }
  record('the built client artifact exists', artifact !== '',
    artifact === '' ? 'lib/client.js is missing — run node build-client.mjs' : 'found')
  // ★ THIS ASSERTION WAS INVERTED ON 2026-11-19, AND THE REASON IS THE USER'S
  // OWN COMPLAINT: the card sat in the Settings page's left-hand list while the
  // boot-animation card sat in the Plugins page, with the bundle's icon and its
  // description. `plugins.item` is the slot that produces THAT card, so the
  // client now registers it.
  //
  // ★ THE OPPOSITE IS STILL FORBIDDEN: a SECOND registration of the same id in
  // the same list slot throws inside the slot ledger and leaves a card that is
  // visible and dead, so the registration must appear exactly once.
  record('the client registers the Plugins page card slot',
    artifact !== '' && artifact.includes('plugins.item'), 'plugins.item')
  record('the Plugins page card slot is registered exactly once',
    artifact !== '' && (artifact.match(/plugins\.item/g) || []).length === 1,
    'exactly one plugins.item')
  record('the client registers the settings section',
    artifact !== '' && artifact.includes('settings.section'), 'settings.section')
  record('the client registers the bundle configuration',
    artifact !== '' && artifact.includes('plugins.bundle.config'), 'plugins.bundle.config')
  record('the client registers the media library section',
    artifact !== '' && artifact.includes('plugins.detail.section'), 'plugins.detail.section')

  /* ---- the Config schema ------------------------------------------- */

  record('the module exports a Config', entry.Config !== undefined && entry.Config !== null,
    typeof entry.Config)
  const Config = entry.Config
  if (Config !== undefined && Config !== null) {
    const standard = Config['~standard']
    record('the Config carries a ~standard validator', standard !== undefined && standard !== null
      && typeof standard.validate === 'function', typeof standard?.validate)
    let validated = null
    try {
      validated = standard?.validate?.({})
    } catch (error) {
      validated = { error: String(error) }
    }
    record('the Config validates an empty document', validated !== null && validated.error === undefined
      && validated.issues === undefined,
      validated?.error ?? (validated?.issues === undefined ? 'no issues' : JSON.stringify(validated.issues)))
    record('the Config is an object schema', Config.type === 'object', String(Config.type))
    record('the Config carries a meta shape', typeof Config.meta === 'object' && Config.meta !== null,
      JSON.stringify(Config.meta?.volatile))
    const dict = Config.dict
    record('the Config carries a dict shape', typeof dict === 'object' && dict !== null,
      Object.keys(dict ?? {}).join(', '))
    for (const field of ['dataDir']) {
      const node = dict?.[field]
      record('the field ' + field + ' is declared', node !== undefined && node !== null, typeof node)
      record('the field ' + field + ' is volatile', node?.meta?.volatile === true,
        JSON.stringify(node?.meta?.volatile))
      record('the field ' + field + ' carries a type', typeof node?.type === 'string', String(node?.type))
      record('the field ' + field + ' carries a dict shape', typeof node?.dict === 'object'
        && node?.dict !== null, Object.keys(node?.dict ?? {}).join(', '))
    }

    // ★ `catalogRevision` IS GONE, AND THAT IS THE POINT.
    //
    // It was a text box that could not do anything: the Host increments
    // nothing on a plugin's behalf, so a number typed into it changed nothing
    // — and it stood beside the ledger's revision as a second source of
    // truth. These four assertions replace the four the field used to have;
    // they are the same shape, pointed the other way.
    const removed = dict?.catalogRevision
    record('the field catalogRevision is not declared', removed === undefined, typeof removed)
    record('the Config declares exactly the dataDir field',
      Object.keys(dict ?? {}).length === 1 && dict?.dataDir !== undefined,
      Object.keys(dict ?? {}).join(', '))
    let stray = null
    try {
      stray = standard?.validate?.({ catalogRevision: 5 })
    } catch (error) {
      stray = { error: String(error) }
    }
    record('the Config ignores a stray catalogRevision value',
      stray !== null && stray.error === undefined && stray.issues === undefined,
      stray?.error ?? (stray?.issues === undefined ? 'no issues' : JSON.stringify(stray.issues)))
    let schemaText = ''
    try {
      schemaText = JSON.stringify(Config.toJSON?.() ?? {})
    } catch (error) {
      schemaText = ''
    }
    record('the schema tree carries no catalogRevision key',
      !schemaText.includes('catalogRevision'),
      schemaText.includes('catalogRevision') ? 'found' : 'absent')
  }

  /* ---- mount the real handlers -------------------------------------- */

  // ★ THE LIBRARY UNDER TEST IS A TEMPORARY DIRECTORY. The catalog's
  // revision comes from the ledger now, and the default directory is the
  // user's real library — a suite that read (or wrote) it would answer
  // whatever that library happens to hold.
  dataDir = mkdtempSync(join(tmpdir(), 'dsh-appearance-media-routes-'))
  const harness = makeContext()
  const cleanup = entry.apply(harness.ctx, { dataDir })

  // ★ BY IDENTITY, NEVER BY COUNT. The plugin registers more routes now — the
  // upload, the remove and the media ones — and a count assertion turns red
  // every time a route is added, which is exactly the wrong reason for a
  // suite to go red. What matters is that the two read-only routes this suite
  // drives are there, and that they are the two it means.
  const readOnly = harness.routes.filter((route) => route.kind === 'exact'
    && (route.path === CATALOG_PATH || route.path === HEALTH_PATH))
  record('the catalog and the health probe are registered by identity',
    harness.routes.some((route) => route.kind === 'exact' && route.path === CATALOG_PATH)
    && harness.routes.some((route) => route.kind === 'exact' && route.path === HEALTH_PATH)
    && readOnly.length === 2,
    harness.routes.map((route) => route.kind + ':' + route.path).join(', '))
  const paths = harness.routes.map((route) => route.path)
  record('the catalog route is registered', paths.includes(CATALOG_PATH), CATALOG_PATH)
  record('the health route is registered', paths.includes(HEALTH_PATH), HEALTH_PATH)
  record('the catalog and the health probe are exact routes',
    readOnly.length === 2 && readOnly.every((route) => route.kind === 'exact'),
    readOnly.map((route) => route.kind).join(', '))

  const catalogRoute = harness.routes.find((route) => route.path === CATALOG_PATH)
  const healthRoute = harness.routes.find((route) => route.path === HEALTH_PATH)

  if (catalogRoute !== undefined) {
    const answer = call(catalogRoute, 'GET')
    record('the catalog answers 200 to GET', answer.status === 200, String(answer.status))
    record('the catalog is JSON',
      String(header(answer.headers, 'content-type') ?? '').includes('application/json'),
      String(header(answer.headers, 'content-type')))
    record('the catalog is not stored',
      header(answer.headers, 'cache-control') === 'no-store',
      String(header(answer.headers, 'cache-control')))
    let payload = null
    try {
      payload = JSON.parse(answer.body)
    } catch (error) {
      payload = null
    }
    record('the catalog body is JSON', payload !== null, answer.body)
    record('the catalog reports ok', payload?.ok === true, JSON.stringify(payload?.ok))
    record('the catalog revision is 0', payload?.revision === 0, JSON.stringify(payload?.revision))
    record('the catalog entries is an array', Array.isArray(payload?.entries),
      JSON.stringify(payload?.entries))
    const head = call(catalogRoute, 'HEAD')
    record('the catalog answers 200 to HEAD', head.status === 200, String(head.status))
  }

  if (healthRoute !== undefined) {
    const answer = call(healthRoute, 'GET')
    record('the health probe answers 200 to GET', answer.status === 200, String(answer.status))
    record('the health probe is JSON',
      String(header(answer.headers, 'content-type') ?? '').includes('application/json'),
      String(header(answer.headers, 'content-type')))
    record('the health probe is not stored',
      header(answer.headers, 'cache-control') === 'no-store',
      String(header(answer.headers, 'cache-control')))
    let payload = null
    try {
      payload = JSON.parse(answer.body)
    } catch (error) {
      payload = null
    }
    record('the health probe reports ok', payload?.ok === true, JSON.stringify(payload?.ok))
    record('the health probe reports the version', payload?.version === '0.1.0',
      JSON.stringify(payload?.version))
    record('the health probe reports an absolute data directory',
      typeof payload?.dataDir === 'string' && isAbsolute(payload.dataDir),
      String(payload?.dataDir))
  }

  // ★ ONLY THE TWO READ-ONLY ROUTES. The upload and the remove routes are
  // POST routes; asking them to refuse POST with a 405 would be asking for the
  // opposite of what they are for.
  for (const route of readOnly) {
    const answer = call(route, 'POST')
    record('the route ' + route.path + ' refuses POST with 405', answer.status === 405,
      String(answer.status))
    record('the route ' + route.path + ' names the allowed methods',
      header(answer.headers, 'allow') === 'GET, HEAD', String(header(answer.headers, 'allow')))
  }

  /* ---- the catalog revision follows the ledger ------------------------ */

  // ★ THE REVISION IS THE LEDGER'S, NOT A CONFIG FIELD'S. A config key that
  // says 7 must move nothing: the field is gone, and the ledger — which this
  // directory does not have yet — is the only source of truth.
  const revisionHarness = makeContext()
  const revisionCleanup = entry.apply(revisionHarness.ctx, {
    dataDir,
    catalogRevision: 7,
  })
  const revisionCatalog = revisionHarness.routes.find((route) => route.path === CATALOG_PATH)
  let revisionPayload = null
  try {
    revisionPayload = revisionCatalog === undefined ? null : JSON.parse(call(revisionCatalog, 'GET').body)
  } catch (error) {
    revisionPayload = null
  }
  record('the catalog ignores a configured catalogRevision', revisionPayload?.revision === 0,
    String(revisionPayload?.revision))
  if (typeof revisionCleanup === 'function') revisionCleanup()

  /* ---- the index injection ------------------------------------------ */

  const injectListeners = harness.listeners.get('webserver/index-inject') ?? []
  record('the index-inject event is subscribed', injectListeners.length === 1,
    String(injectListeners.length))
  if (injectListeners.length === 1) {
    const table = []
    injectListeners[0](table)
    // ★ THE ROWS ARE IDENTIFIED BY WHAT THEY PUBLISH, NEVER BY HOW MANY
    // THERE ARE.
    //
    // A count is a promise that the next task breaks: the surfaces push their
    // own rows in Tasks 5, 6 and 7, and a "exactly three rows" assertion
    // would have to be rewritten every time. An identity assertion says what
    // this build contributes, and says nothing about anybody else's rows.
    //
    // Three rows belong to this build:
    //   1. the appearance state object;
    //   2. the media adapters  (`__DSH_APPEARANCE_RENDERERS__`);
    //   3. the arbitration point (`__DSH_APPEARANCE_CONTROLLER__`).
    const ours = [
      {
        name: 'the appearance state',
        row: table.find((row) => String(row?.text ?? '').includes('globalThis.__DSH_APPEARANCE__ =')
          && !String(row?.text ?? '').includes('__DSH_APPEARANCE_RENDERERS__')
          && !String(row?.text ?? '').includes('__DSH_APPEARANCE_CONTROLLER__')),
      },
      {
        name: 'the media adapters',
        row: table.find((row) => String(row?.text ?? '').includes('globalThis.__DSH_APPEARANCE_RENDERERS__')),
      },
      {
        name: 'the arbitration point',
        row: table.find((row) => String(row?.text ?? '').includes('globalThis.__DSH_APPEARANCE_CONTROLLER__')),
      },
    ]
    const missing = ours.filter((entry) => entry.row === undefined).map((entry) => entry.name)
    const wrongKind = ours.filter((entry) => entry.row !== undefined
      && (entry.row.kind !== 'script' || entry.row.placement !== 'head'))
      .map((entry) => entry.name)
    record('this build pushes its three rows, identified by what they publish',
      missing.length === 0 && wrongKind.length === 0,
      'rows=' + String(table.length) + ' missing=' + JSON.stringify(missing)
      + ' wrongKind=' + JSON.stringify(wrongKind))
    record('the row is an inline script', table[0]?.kind === 'script', String(table[0]?.kind))
    record('the row publishes the appearance state',
      String(table[0]?.text ?? '').includes('__DSH_APPEARANCE__'), String(table[0]?.text))
    record('the row is not an external script', table[0]?.kind !== 'script-src',
      String(table[0]?.kind))
  }

  /* ---- teardown ----------------------------------------------------- */

  if (typeof cleanup === 'function') {
    cleanup()
    record('the cleanup function is returned by apply', true, 'callable')
    record('the routes are unregistered after the cleanup', harness.routes.length === 0,
      harness.routes.length + ' route(s) left')
  } else {
    record('the cleanup function is returned by apply', false, typeof cleanup)
    record('the routes are unregistered after the cleanup', false, 'no cleanup to call')
  }

  /* ---- a volatile field is read live ---------------------------------- */

  // The routes must read their values when a request arrives, NOT when they
  // were built. A volatile field that changes while the host runs has to be
  // visible on the very next request — that is what `.volatile()` buys, and a
  // snapshot taken at apply time silently breaks it.
  //
  // The holder below is the mutable stand-in for the volatile reference.
  const holder = { dataDir: '/tmp/a', revision: 0 }
  const liveRoutes = catalogModule.buildRoutes({
    readDataDir: () => holder.dataDir,
    readRevision: () => holder.revision,
    version: '0.1.0',
  })
  const liveHealth = liveRoutes.find((route) => route.path === HEALTH_PATH)
  const liveCatalog = liveRoutes.find((route) => route.path === CATALOG_PATH)

  if (liveHealth !== undefined) {
    const before = JSON.parse(call(liveHealth, 'GET').body)
    record('a reader-backed route answers the reader\'s value', before.dataDir === '/tmp/a',
      String(before.dataDir))
    // Change the value WITHOUT rebuilding the routes.
    holder.dataDir = '/tmp/b'
    const after = JSON.parse(call(liveHealth, 'GET').body)
    record('the route reads the value again on the next request', after.dataDir === '/tmp/b',
      String(after.dataDir))
  }

  if (liveCatalog !== undefined) {
    const before = JSON.parse(call(liveCatalog, 'GET').body)
    record('a reader-backed catalog starts at the reader\'s revision', before.revision === 0,
      JSON.stringify(before.revision))
    holder.revision = 7
    const after = JSON.parse(call(liveCatalog, 'GET').body)
    record('the catalog reads the revision again on the next request', after.revision === 7,
      JSON.stringify(after.revision))
  }

  // The plain-value form must keep working: a caller that passes a value gets
  // a constant answer, not a broken route.
  const fixedRoutes = catalogModule.buildRoutes({ dataDir: '/tmp/fixed', revision: 3 })
  const fixedHealth = fixedRoutes.find((route) => route.path === HEALTH_PATH)
  const fixedCatalog = fixedRoutes.find((route) => route.path === CATALOG_PATH)
  if (fixedHealth !== undefined) {
    const answer = JSON.parse(call(fixedHealth, 'GET').body)
    record('a plain value still answers as a constant', answer.dataDir === '/tmp/fixed',
      String(answer.dataDir))
  }
  if (fixedCatalog !== undefined) {
    const answer = JSON.parse(call(fixedCatalog, 'GET').body)
    record('a plain revision still answers as a constant', answer.revision === 3,
      JSON.stringify(answer.revision))
  }

  /* ---- the failure path --------------------------------------------- */

  // A route registration can throw — the host throws on a duplicate
  // (kind, path). When it does, the plugin must NOT leave the routes it had
  // already registered behind: a zombie route answers 200 forever and the
  // next mount of the same plugin dies on the duplicate check.
  const failingHarness = makeContext({ failOnRegister: 2 })
  let applyThrew = false
  let applyError = ''
  try {
    entry.apply(failingHarness.ctx, { dataDir })
  } catch (error) {
    applyThrew = true
    applyError = String(error && error.message ? error.message : error)
  }
  record('a failing route registration is reported by apply', applyThrew, applyError)
  record('a failed apply leaves no registered route behind', failingHarness.routes.length === 0,
    failingHarness.routes.length + ' route(s) left')

  /* ---- the volatile config shape ------------------------------------ */

  const volatileHarness = makeContext()
  const volatileCleanup = entry.apply(volatileHarness.ctx, {
    dataDir: { get: () => '/tmp/dsh-appearance-media-volatile-fixture' },
    catalogRevision: { get: () => 0 },
  })
  const volatileHealth = volatileHarness.routes.find((route) => route.path === HEALTH_PATH)
  let volatilePayload = null
  try {
    volatilePayload = volatileHealth === undefined
      ? null
      : JSON.parse(call(volatileHealth, 'GET').body)
  } catch (error) {
    volatilePayload = null
  }
  record('a volatile config reference is read through get()',
    volatilePayload?.dataDir === '/tmp/dsh-appearance-media-volatile-fixture',
    String(volatilePayload?.dataDir))
  if (typeof volatileCleanup === 'function') volatileCleanup()
  record('the volatile run unregisters its routes too', volatileHarness.routes.length === 0,
    volatileHarness.routes.length + ' route(s) left')
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
