// dsh-appearance-media — the slot configuration route.
//
//   GET /appearance-media/slots   the configuration, read now
//   PUT /appearance-media/slots   change it
//
// ★ THE ANSWER IS "WHAT IS TRUE NOW", AND IT IS NEVER CACHEABLE.
//
//   `Cache-Control: no-store`, exactly. The same reason the media bytes are
//   never cacheable (see `lib/routes/upload.js`): a stale answer is an answer
//   that lies about the running page. A browser that keeps the answer to
//   "which material is playing" keeps it exactly across the moment the user
//   changed it — and "immediately effective" dies while every offline
//   assertion stays green.
//
// ★ ONE ROUTE, TWO METHODS. Everything else is 405, with an `Allow` header
//   that says what is allowed.
//
// THE RESPONSE SHAPE, and it never varies:
//
//   { "ok": true, "config": { "revision": 3, "slots": {…}, "options": {…} },
//     "ignored": [ "options.background.tint" ] }
//
//   * `config` is the whole configuration;
//   * `ignored` is at the TOP level and is ALWAYS there — an empty array when
//     there is nothing to report. A client that has to branch on the shape is
//     a client that will branch wrong.
//
// ★ THE MEDIA ID IS CHECKED AGAINST THE CATALOG, HERE, NOT IN THE STORE.
//
//   The store cannot import the catalog: the catalog imports the store. So
//   this route resolves the id through `resolveById(dataDir, id)` — THE SAME
//   function the catalog route uses — and answers 400 when the material is
//   not in the library. A second scan would be a second set of rules, and two
//   sets of rules drift: "the catalog lists it, the slot refuses it".
//
// ★ A MISSING DATA DIRECTORY IS NOT AN ERROR. The first GET on a fresh
//   profile answers 200 with three disabled slots; nothing is created.

import { resolveById } from '../catalog.js'
import { ConfigError, readConfig, writeConfig } from '../store.js'

/** The slot configuration route. */
export const SLOTS_PATH = '/appearance-media/slots'

/** The methods this route answers, in the order they are announced. */
export const SLOTS_ALLOW = 'GET, HEAD, PUT'

/** The largest request body this route accepts. */
const BODY_LIMIT = 16 * 1024

/**
 * Answer one JSON response.
 *
 * @param res - outgoing response.
 * @param status - HTTP status.
 * @param value - the JSON value.
 * @param extraHeaders - additional response headers, e.g. `Allow` on a 405.
 */
function sendJson(res, status, value, extraHeaders) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.byteLength),
    // ★ EXACTLY `no-store`. Not `no-cache`, not `must-revalidate`.
    'Cache-Control': 'no-store',
    ...(extraHeaders ?? {}),
  })
  res.end(body)
}

/**
 * Describe an error for the client.
 *
 * @param error - the error.
 * @returns a short sentence.
 */
function describe(error) {
  if (error instanceof ConfigError) return error.message
  return 'internal'
}

/**
 * Whether a value is a plain object.
 *
 * @param value - the value.
 * @returns true for an object that is not an array and not null.
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Read a small request body.
 *
 * ★ A BODY THAT IS TOO BIG IS A 400 HERE, NOT A 413. The client sent a
 * configuration patch; a patch this big is not a configuration, and the
 * answer that helps the client is "your request is malformed", not "your
 * request is large".
 *
 * ★ AND THE REQUEST IS NEVER DESTROYED. `req.destroy()` closes the socket
 * BEFORE the answer is written, so the client never sees the status code —
 * it sees "Empty reply from server" (curl exits 52). The status code is the
 * whole point of this answer, so the request is DRAINED instead: the body is
 * dropped, the stream keeps being read to its end, and the 400 is written on
 * a healthy connection.
 *
 * @param req - incoming request.
 * @param limit - the largest body accepted.
 * @returns a promise for `{ ok: true, text }` or `{ ok: false, error }`.
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
    req.on('error', () => finish({ ok: false, error: '请求流中断。' }))
    req.on('data', (chunk) => {
      if (settled) return
      // ★ Already over the limit: keep reading, keep nothing.
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
        finish({ ok: false, error: '请求体太大（上限 ' + String(limit) + ' 字节）。' })
        return
      }
      finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') })
    })
    // ★ THE STREAM ENDED WITHOUT AN 'end' — the client went away, or the
    // request was destroyed. The answer must not wait for an 'end' that will
    // never come, or the response hangs forever.
    req.on('close', () => {
      if (settled || bodyEnded) return
      finish({ ok: false, error: '请求流中断。' })
    })
  })
}

/**
 * Build the slot configuration route.
 *
 * The descriptor is plain data: `index.js` owns the registration and the
 * cleanup, and this module owns WHAT the route answers.
 *
 * @param options - `readDataDir`, a reader called per request.
 * @returns the route descriptors, in registration order.
 */
export function buildSlotsRoutes({ readDataDir } = {}) {
  const readDir = typeof readDataDir === 'function' ? readDataDir : () => ''

  return [
    {
      kind: 'exact',
      path: SLOTS_PATH,
      handler: async (req, res) => {
        try {
          const method = String(req?.method ?? 'GET').toUpperCase()

          if (method === 'GET' || method === 'HEAD') {
            const dataDir = readDir()
            const { config, ignored } = readConfig(dataDir)
            sendJson(res, 200, { ok: true, config, ignored })
            return
          }

          if (method !== 'PUT') {
            sendJson(res, 405, { ok: false, error: '这个地址只接受 GET、HEAD 和 PUT。' }, { Allow: SLOTS_ALLOW })
            return
          }

          const dataDir = readDir()

          const body = await readSmallBody(req, BODY_LIMIT)
          if (body.ok !== true) {
            sendJson(res, 400, { ok: false, error: body.error })
            return
          }

          let patch
          try {
            patch = JSON.parse(body.text)
          } catch {
            sendJson(res, 400, { ok: false, error: '请求体不是 JSON。' })
            return
          }
          if (!isPlainObject(patch)) {
            sendJson(res, 400, { ok: false, error: '请求体必须是一个 JSON 对象。' })
            return
          }

          // ★ THE CATALOG DECIDES IF A MEDIA ID EXISTS. `resolveById` is the
          // catalog's own function — the same one the catalog route uses — so
          // "the catalog lists it" and "the slot accepts it" are the same
          // question asked the same way.
          if (typeof patch.mediaId === 'string' && patch.mediaId !== '') {
            if (resolveById(dataDir, patch.mediaId) === null) {
              sendJson(res, 400, { ok: false, error: '素材库里没有这条素材：' + patch.mediaId })
              return
            }
          }

          let written
          try {
            written = await writeConfig(dataDir, patch)
          } catch (error) {
            if (error instanceof ConfigError) {
              sendJson(res, error.status ?? 400, { ok: false, error: error.message })
              return
            }
            throw error
          }

          sendJson(res, 200, { ok: true, config: written.config, ignored: written.ignored })
        } catch (error) {
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: describe(error) })
          else res.end()
        }
      },
    },
  ]
}
