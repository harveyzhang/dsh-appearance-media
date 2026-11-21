// ★ Every route of this plugin must answer the Host's access check first.
//
// WHY THIS FILE EXISTS
// -------------------
// The official plugin catalog's maintainer merged this plugin's entry and
// appended a sentence to its description:
//
//   "Its HTTP routes have no DSH access check, so a web page open in the
//    user's browser could call them."
//
// That is a real hole: a route on the Host's web server answers anything that
// can reach it, and these routes upload material, rewrite the slot
// configuration and delete material.
//
// The Host owns the answer. `connection.requestRejection(request)` applies
// the Host/Origin check and the browser authentication, and answers either
// `undefined` (the request may proceed) or a status code (it must not).
//
// THIS SUITE CHECKS THE BEHAVIOUR, NOT THE TEXT: it runs the real `apply()`,
// takes the routes it registers, and drives each one with a connection that
// refuses. A route that answers anything else leaks.
//
// ★ EVERY CHECK MUST BE ABLE TO GO RED. `node tools/verify-access.mjs
//   --negative` breaks a copy of the tree and shows that each check notices.
//
//   node tools/verify-access.mjs            the checks
//   node tools/verify-access.mjs --negative the checks + their reverse controls

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
 * @returns {boolean} the verdict's boolean.
 */
function print(check) {
  checks.push(check)
  console.log((check.ok ? 'PASS  ' : 'FAIL  ') + check.label
    + (check.detail === '' ? '' : '  — ' + check.detail))
  return check.ok
}

/**
 * A response object that records what a handler did to it.
 *
 * @returns {{res: object, read: () => {status: number, body: string}}} the response and a reader.
 */
function fakeResponse() {
  let status = 0
  let body = ''
  const res = {
    headersSent: false,
    ended: false,
    writeHead(code) {
      status = code
      res.headersSent = true
      return res
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) body = String(chunk)
      res.ended = true
      return res
    },
    setHeader() {},
    getHeader() { return undefined },
  }
  return { res, read: () => ({ status, body }) }
}

/**
 * Run the plugin's `apply()` against a mock Host context and collect the
 * routes it registers.
 *
 * @param {object} connection - the connection service the mock hands over.
 * @returns {{routes: object[], ctx: object}} the registered routes and the mock context.
 */
function registerRoutes(connection) {
  const routes = []
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    connection,
    effect(fn) { return fn() },
    on() { return () => {} },
    logger() { return { info() {}, warn() {}, error() {} } },
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'dsham-access-'))
  mod.apply(ctx, { dataDir })
  return { routes, ctx, dataDir }
}

/** The plugin's own module, loaded once. */
const mod = await import(pathToFileURL(join(repoRoot, 'index.js')).href)

// ── the checks ──────────────────────────────────────────────────────────────

// ① the plugin asks for the connection service
const source = readFileSync(join(repoRoot, 'index.js'), 'utf8')
print(verdict('the plugin requires the Host connection service',
  /export const inject = \[[^\]]*'connection'/.test(source),
  /export const inject = \[[^\]]*'connection'/.test(source)
    ? "inject declares 'connection' — a Host without it refuses to load this plugin"
    : "inject does not declare 'connection' ⇒ the access check cannot be there"))

print(verdict('the connection service is REQUIRED, not optional',
  !/'connection\?'/.test(source),
  "the inject list has no soft 'connection?' entry — a Host without the service refuses to load this plugin, which is louder and safer than loading it wide open"))

// ② every registered route refuses a request the Host rejects
{
  const { routes } = registerRoutes({ requestRejection: () => 403 })
  print(verdict('the plugin registers routes at all', routes.length > 0,
    routes.length + ' routes registered'))

  const leaked = []
  for (const route of routes) {
    const { res, read } = fakeResponse()
    route.handler({ method: 'GET', url: route.path, headers: {} }, res)
    const { status } = read()
    if (status !== 403) leaked.push(route.path + ' → ' + status)
  }
  print(verdict('every registered route refuses a request the Host rejected',
    leaked.length === 0,
    leaked.length === 0
      ? routes.length + ' routes answered 403 and none of them ran its own logic'
      : 'these routes did NOT refuse: ' + leaked.join(', ')))
}

// ③ a 401 is answered as 401, and the body says so
{
  const { routes } = registerRoutes({ requestRejection: () => 401 })
  const route = routes[0]
  const { res, read } = fakeResponse()
  route.handler({ method: 'GET', url: route.path, headers: {} }, res)
  const { status, body } = read()
  print(verdict('a rejected request is answered with the Host status and a short body',
    status === 401 && body.length > 0 && body.length < 64,
    'status=' + status + ' body=' + JSON.stringify(body)))
}

// ④ a request the Host admits still reaches the route
{
  const { routes } = registerRoutes({ requestRejection: () => undefined })
  const route = routes[0]
  const { res, read } = fakeResponse()
  route.handler({ method: 'GET', url: route.path, headers: {} }, res)
  const { status } = read()
  print(verdict('a request the Host admits still reaches the route',
    status !== 403 && status !== 401,
    'the route answered ' + status + ' — the guard does not block legitimate traffic'))
}

// ⑤ the guard is applied where the routes are registered, not inside one handler
print(verdict('the guard is applied at registration, so a new route cannot forget it',
  /server\.register\(guarded\)/.test(source) || /server\.register\(\{[^}]*handler: guardHandler/.test(source),
  /server\.register\(guarded\)/.test(source)
    ? 'every route is wrapped before it is registered'
    : 'the registration does not go through the guard'))

// ⑥ the rejection is asked BEFORE the route's own logic
{
  let ownLogicRan = false
  const guarded = mod.guardHandler(() => { ownLogicRan = true }, { requestRejection: () => 403 })
  const { res, read } = fakeResponse()
  guarded({ method: 'GET', url: '/appearance-media/health', headers: {} }, res)
  const { status } = read()
  print(verdict('the route\'s own logic never runs for a rejected request',
    status === 403 && ownLogicRan === false,
    'status=' + status + ' ownLogicRan=' + ownLogicRan))
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
      label: 'the routes stop asking the Host for a verdict',
      breakIt: (dir) => {
        const path = join(dir, 'index.js')
        const text = readFileSync(path, 'utf8')
        writeFileSync(path, text.replace(
          'const guarded = { ...route, handler: guardHandler(route.handler, ctx.connection) }',
          'const guarded = { ...route, handler: route.handler }'))
      },
    },
    {
      label: 'the plugin stops requiring the connection service',
      breakIt: (dir) => {
        const path = join(dir, 'index.js')
        const text = readFileSync(path, 'utf8')
        writeFileSync(path, text.replace("export const inject = ['webServer', 'connection']", "export const inject = ['webServer']"))
      },
    },
    {
      label: 'the guard lets the request through anyway',
      breakIt: (dir) => {
        const path = join(dir, 'index.js')
        const text = readFileSync(path, 'utf8')
        writeFileSync(path, text.replace(
          '    const rejection = connection?.requestRejection?.(req)',
          '    const rejection = undefined'))
      },
    },
  ]

  console.log('')
  console.log('reverse controls — each one breaks a copy and shows the check going red:')
  let caught = 0
  for (const control of controls) {
    const dir = mkdtempSync(join(tmpdir(), 'dsham-access-neg-'))
    try {
      cpSync(repoRoot, dir, { recursive: true, dereference: true })
      control.breakIt(dir)
      // ★ AWAIT. Without it `red` is a Promise, and `Promise > 0` is false —
      //   every control would report "nothing noticed" while the copy was
      //   in fact broken. That is the worst shape of bug: the safety net that
      //   lies about the safety net.
      const red = await checkCopy(dir)
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
 * Run the behavioural part of the checks against another tree.
 *
 * @param {string} dir - the tree.
 * @returns {Promise<number>} how many checks went red.
 */
async function checkCopy(dir) {
  const copyMod = await import(pathToFileURL(join(dir, 'index.js')).href)
  let red = 0
  const routes = []
  const ctx = {
    webServer: { register(route) { routes.push(route); return () => {} } },
    connection: { requestRejection: () => 403 },
    effect(fn) { return fn() },
    on() { return () => {} },
    logger() { return { info() {}, warn() {}, error() {} } },
  }
  copyMod.apply(ctx, { dataDir: mkdtempSync(join(tmpdir(), 'dsham-access-copy-')) })
  const leaked = routes.filter((route) => {
    const { res, read } = fakeResponse()
    route.handler({ method: 'GET', url: route.path, headers: {} }, res)
    return read().status !== 403
  })
  if (routes.length === 0) red += 1
  if (leaked.length > 0) red += 1
  const src = readFileSync(join(dir, 'index.js'), 'utf8')
  if (!/export const inject = \[[^\]]*'connection'/.test(src)) red += 1
  if (!/server\.register\(guarded\)|server\.register\(\{[^}]*handler: guardHandler/.test(src)) red += 1
  return red
}

if (process.argv.includes('--negative')) {
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
