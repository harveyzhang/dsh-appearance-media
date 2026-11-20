// dsh-appearance-media — the media route.
//
//   GET    /appearance-media/media/<id>   the bytes of one material
//   HEAD   /appearance-media/media/<id>   the same, without the body
//   DELETE /appearance-media/media/<id>   the material, gone
//
// ★ THE MEDIA ROUTE IS A PREFIX ROUTE, AND ITS PATH HAS NO TRAILING SLASH.
//
//   { kind: 'prefix', path: '/appearance-media/media' }
//
// The Host has exactly two route tables (`dsh-host-webserver/lib/index.js:376`)
// and matches a prefix with
//
//   if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
//
// (`:580-590`). Three ways to get this wrong, all of them silent:
//
//   * `exact` with the literal id — never matches, because the id is not known
//     at registration time;
//   * a prefix WITH a trailing slash — the test becomes
//     `startsWith('/appearance-media/media//')`, which no id satisfies;
//   * a prefix with the id baked into the path — one route per file, and the
//     Host's route table grows with the library.
//
// ★ AND THE PREFIX TABLE HOLDS ONE ROUTE PER PATH.
//
//   `register()` throws on a duplicate `(kind, path)`
//   (`dsh-host-webserver/lib/index.js:376`), so the bytes and the delete CANNOT
//   be two routes: they are one handler that answers three methods. That is
//   why this file exists — the bytes moved here from `upload.js` so that the
//   delete has a home, and the bytes answer exactly what they answered
//   before.
//
// ★ A PREFIX ROUTE IS HANDED THE WHOLE REQUEST URL, prefix included. The id is
// what remains after the route's own base — reading it as if the base were
// already stripped yields the whole path, which is in nobody's library.
//
// ★ THE MEDIA BYTES ARE NEVER CACHEABLE. `Cache-Control: no-store`, on the
// 200 and on the 206 alike, and no 304 ever.
//
//   The reason is the REPLACEMENT, not the format. A background is a `<video>`
//   element, and replacing the element ABORTS the request that is in flight;
//   whatever arrived is a TRUNCATED body. Any directive that lets the browser
//   keep it turns that into a poisoned cache entry: the next reload decodes a
//   fragment, and a clip whose `moov` sits at the end has no index in a
//   fragment — so it paints nothing, and only a hard refresh recovers.
//
//   (P05 `AGENTS.md:249`: "anything cacheable stores a truncated body… ETag /
//   no-cache does not fix this". P06 can use `no-cache` + `ETag` on a whole
//   file because its background is ONE FIXED FILE that never changes
//   mid-flight — ours is replaced.)
//
//   An `ETag` is still sent: it is the server's own integrity label, and it
//   lets a client notice that the bytes behind a URL changed. It is NOT a
//   caching permission, and this route never answers 304 — answering 304 is
//   exactly what would let a browser trust a fragment.
//
// ★ AND THE DELETE IS THE HOST'S OWN WORK, NOT THE BROWSER'S.
//
//   The browser cannot unlink a file in the media directory, so it asks the
//   Host. The Host refuses an id that carries a path, refuses one that is not
//   in the library, takes the file out of the library, clears the slots that
//   pointed at it, drops it out of the ledger — and only then unlinks the
//   bytes. The whole order lives in `lib/catalog.js` (`deleteMaterial`); this
//   file is the HTTP shell around it.

import { createReadStream, statSync } from 'node:fs'

import { MEDIA_TYPES, deleteMaterial, isWellFormedId, resolveById } from '../catalog.js'

/** The media route's base. A PREFIX, and there is no trailing slash. */
export const MEDIA_PATH = '/appearance-media/media'

/** The methods this route answers, in the order they are announced. */
export const MEDIA_ALLOW = 'GET, HEAD, DELETE'

/**
 * Answer one JSON response.
 *
 * @param res - outgoing response.
 * @param status - HTTP status.
 * @param value - the JSON value.
 * @param extraHeaders - additional headers.
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
 * Read one header, case-insensitively.
 *
 * @param req - the request.
 * @param name - the header name.
 * @returns the value, or undefined.
 */
function headerValue(req, name) {
  const headers = req?.headers
  if (headers === undefined || headers === null) return undefined
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) {
      return Array.isArray(value) ? value[0] : value
    }
  }
  return undefined
}

/**
 * Parse one Range header.
 *
 * ★ A RANGE THAT CANNOT BE SATISFIED, AND A RANGE THAT CANNOT BE PARSED, ARE
 * BOTH 416. An unparsable Range is answered 416 rather than ignored: a client
 * that sends `bytes=abc` wants a range, and answering the whole file instead
 * is how a player ends up with a byte offset it did not ask for.
 *
 * @param header - the `Range` header, or undefined.
 * @param size - the file's size in bytes.
 * @returns `undefined` for no range, `{ start, end }` for a range, or
 *   `{ unsatisfiable: true }`.
 */
export function parseRange(header, size) {
  if (typeof header !== 'string') return undefined
  const trimmed = header.trim()
  if (trimmed === '') return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(trimmed)
  if (match === null) return { unsatisfiable: true }
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return { unsatisfiable: true }
  if (rawStart === '') {
    const length = Number(rawEnd)
    if (!Number.isFinite(length) || length <= 0) return { unsatisfiable: true }
    return { start: Math.max(size - length, 0), end: size - 1 }
  }
  const start = Number(rawStart)
  if (!Number.isFinite(start) || start >= size) return { unsatisfiable: true }
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  if (!Number.isFinite(end) || end < start) return { unsatisfiable: true }
  return { start, end }
}

/**
 * The `Content-Type` of one material.
 *
 * ★ OUT OF THE LIBRARY'S OWN TABLE. A hand-written list of extensions is a
 * second set of rules, and two sets of rules drift: the day the library
 * learns a new extension, a copied list serves it as
 * `application/octet-stream` and the browser refuses to play it.
 *
 * @param ext - the material's extension, with the dot.
 * @returns the media type.
 */
function contentTypeOf(ext) {
  const type = MEDIA_TYPES[ext]
  if (type === undefined || typeof type.mime !== 'string') return 'application/octet-stream'
  return type.mime
}

/**
 * Build the media route.
 *
 * @param options - `readDataDir`, a reader called per request.
 * @returns the route descriptor.
 */
export function buildMediaRoutes({ readDataDir } = {}) {
  const readDir = typeof readDataDir === 'function' ? readDataDir : () => ''

  return [
    {
      kind: 'prefix',
      path: MEDIA_PATH,
      handler: async (req, res) => {
        try {
          const method = String(req?.method ?? 'GET').toUpperCase()

          // The path, decoded once. The decode is guarded: a malformed
          // percent-escape throws `URIError`, and letting it out of the
          // handler would answer a 500 for a bad request.
          let pathname
          try {
            pathname = decodeURIComponent(String(req?.url ?? '').split('?')[0])
          } catch {
            sendJson(res, 400, { ok: false, error: '无法解码这个地址。' })
            return
          }

          // ★ THE DELETE, FIRST. It is the only method with a side effect, and
          // it must not be reachable through the bytes branch by accident.
          if (method === 'DELETE') {
            const dataDir = readDir()
            if (!pathname.startsWith(MEDIA_PATH + '/')) {
              sendJson(res, 400, { ok: false, error: '缺少 mediaId。' })
              return
            }
            const id = pathname.slice(MEDIA_PATH.length + 1)

            // ★ THE ID IS CHECKED BEFORE ANY LOOKUP, INSIDE `deleteMaterial`.
            //   A `..`, a path separator or an absolute path is a 400 there,
            //   and a path that walked out of the media directory is a 400 as
            //   well — the file is never looked up by a path the client
            //   wrote.
            const result = await deleteMaterial(dataDir, id)
            if (result.ok !== true) {
              sendJson(res, result.status ?? 500, { ok: false, error: result.error ?? '删除失败。' })
              return
            }
            sendJson(res, 200, {
              ok: true,
              removed: true,
              id: result.id,
              // The slots that pointed at the material and are empty now.
              clearedSlots: Array.isArray(result.clearedSlots) ? result.clearedSlots : [],
              // Whether the boot pool held the material and no longer does.
              poolUpdated: result.poolUpdated === true,
            })
            return
          }

          if (method !== 'GET' && method !== 'HEAD') {
            sendJson(res, 405, { ok: false, error: '这个地址只接受 GET、HEAD 和 DELETE。' }, { Allow: MEDIA_ALLOW })
            return
          }
          const dataDir = readDir()

          if (!pathname.startsWith(MEDIA_PATH + '/')) {
            sendJson(res, 404, { ok: false, error: '没有这条素材。' })
            return
          }
          const id = pathname.slice(MEDIA_PATH.length + 1)
          if (!isWellFormedId(id)) {
            sendJson(res, 404, { ok: false, error: '没有这条素材。' })
            return
          }

          const entry = resolveById(dataDir, id)
          if (entry === null) {
            sendJson(res, 404, { ok: false, error: '没有这条素材。' })
            return
          }

          let info
          try {
            info = statSync(entry.sourcePath)
          } catch {
            sendJson(res, 404, { ok: false, error: '没有这条素材。' })
            return
          }

          const range = parseRange(headerValue(req, 'range'), info.size)
          if (range?.unsatisfiable === true) {
            res.writeHead(416, {
              'Content-Type': 'application/json; charset=utf-8',
              'Content-Range': 'bytes */' + String(info.size),
              'Cache-Control': 'no-store',
            })
            res.end(JSON.stringify({ ok: false, error: '这个 Range 满足不了。' }))
            return
          }

          const from = range === undefined ? 0 : range.start
          const to = range === undefined ? info.size - 1 : range.end
          const digest = String(entry.contentHash ?? '').replace(/^sha256:/, '').slice(0, 12)

          res.writeHead(range === undefined ? 200 : 206, {
            'Content-Type': contentTypeOf(entry.ext),
            'Accept-Ranges': 'bytes',
            // ★ Never cacheable. The 200 and the 206 alike.
            'Cache-Control': 'no-store',
            // The server's own integrity label — not a caching permission.
            'ETag': '"' + digest + '-' + String(info.size) + '"',
            'Content-Length': String(to - from + 1),
            ...(range === undefined ? {} : {
              'Content-Range': 'bytes ' + String(from) + '-' + String(to) + '/' + String(info.size),
            }),
          })

          if (method === 'HEAD') {
            res.end()
            return
          }

          // Streamed, never read whole: a player issues many overlapping range
          // requests, and holding the file in memory for each of them is how a
          // library turns into a memory leak.
          const stream = createReadStream(entry.sourcePath, { start: from, end: to })
          stream.on('error', () => {
            try {
              res.destroy()
            } catch {
              /* the response is already gone */
            }
          })
          res.on('close', () => {
            stream.destroy()
          })
          stream.pipe(res)
        } catch (error) {
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal' })
          else res.end()
        }
      },
    },
  ]
}
