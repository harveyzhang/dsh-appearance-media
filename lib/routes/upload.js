// dsh-appearance-media — the upload, remove and media routes.
//
//   POST /appearance-media/upload      raw bytes in, one library entry out
//   POST /appearance-media/remove      JSON `{ id }` in, the entry gone
//   GET  /appearance-media/media/<id>  the bytes of one entry
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

import { createReadStream, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'

import { mediaDir } from '../paths.js'
import { isWellFormedId, publicEntry, resolveById, upsertUploaded } from '../catalog.js'
import { updateLedger, readLedger } from '../store.js'
import { classifyUpload, commitUpload, describe, receiveUpload, sanitizeUploadName } from '../upload.js'

/** The upload route. */
export const UPLOAD_PATH = '/appearance-media/upload'

/** The remove route. */
export const REMOVE_PATH = '/appearance-media/remove'

/** The media route's base. A PREFIX, and there is no trailing slash. */
export const MEDIA_PATH = '/appearance-media/media'

/** The largest request body the remove route accepts. */
const REMOVE_BODY_LIMIT = 16 * 1024

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
 * Read one query parameter.
 *
 * @param req - the request.
 * @param name - the parameter name.
 * @returns the value, or undefined.
 */
function queryValue(req, name) {
  const url = String(req?.url ?? '')
  const mark = url.indexOf('?')
  if (mark < 0) return undefined
  for (const pair of url.slice(mark + 1).split('&')) {
    if (pair === '') continue
    const eq = pair.indexOf('=')
    const key = eq < 0 ? pair : pair.slice(0, eq)
    if (key !== name) continue
    const raw = eq < 0 ? '' : pair.slice(eq + 1)
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  return undefined
}

/**
 * Read a small request body.
 *
 * ★ THE REQUEST IS NEVER DESTROYED. `req.destroy()` closes the socket BEFORE
 * the answer is written, so the client never sees the status code — it sees
 * "Empty reply from server" (curl exits 52). The 413 is the whole point of
 * this answer, so the request is DRAINED instead: the body is dropped, the
 * stream keeps being read to its end, and the 413 is written on a healthy
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
        finish({ ok: false, status: 413, error: '请求体太大。' })
        return
      }
      finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') })
    })
    // ★ THE STREAM ENDED WITHOUT AN 'end' — the client went away, or the
    // request was destroyed. The answer must not wait for an 'end' that will
    // never come, or the response hangs forever.
    req.on('close', () => {
      if (settled || bodyEnded) return
      finish({ ok: false, status: 400, error: '请求流中断。' })
    })
  })
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
 * Build the three route descriptors.
 *
 * @param options - `readDataDir`, a reader called per request.
 * @returns the route descriptors, in registration order.
 */
export function buildUploadRoutes({ readDataDir } = {}) {
  const readDir = typeof readDataDir === 'function' ? readDataDir : () => ''

  return [
    {
      kind: 'exact',
      path: UPLOAD_PATH,
      handler: async (req, res) => {
        try {
          const method = String(req?.method ?? 'GET').toUpperCase()
          if (method !== 'POST') {
            sendJson(res, 405, { ok: false, error: '这个地址只接受 POST。' }, { Allow: 'POST' })
            return
          }
          const dataDir = readDir()

          // 1. The name.
          const raw = headerValue(req, 'x-dsh-filename') ?? queryValue(req, 'name')
          const named = sanitizeUploadName(raw)
          if (named.ok !== true) {
            sendJson(res, named.status, { ok: false, error: named.error })
            return
          }

          // 2. The type — the MIME and the extension must agree.
          const type = classifyUpload(headerValue(req, 'content-type'), named.name)
          if (type.ok !== true) {
            sendJson(res, type.status, { ok: false, error: type.error })
            return
          }

          // 3. The bytes.
          const received = await receiveUpload(req, { dataDir })
          if (received.ok !== true) {
            sendJson(res, received.status, { ok: false, error: received.error })
            return
          }

          // 4. The file, under its final name.
          const committed = await commitUpload({
            dataDir,
            tempPath: received.tempPath,
            digest: received.digest,
            ext: type.ext,
            name: named.name,
          })
          if (committed.ok !== true) {
            sendJson(res, committed.status, { ok: false, error: committed.error })
            return
          }

          // 5. The ledger.
          //
          // The entry keeps the name and the time the library FIRST saw these
          // bytes; a second upload of the same content refreshes the ledger
          // (so the revision moves) without pretending the material is new.
          //
          // ★ THE LEDGER IS THE SOURCE HERE, NOT THE DIRECTORY SCAN. The file
          // is already on disk at this point, and a scan would answer with the
          // on-disk name (`up-<sha12>.mp4`) — the name the client sent would
          // be lost, and the panel would show a name nobody chose.
          const previous = readLedger(dataDir).entries[committed.id]
          const entry = {
            id: committed.id,
            name: previous !== undefined && typeof previous.name === 'string' && previous.name !== ''
              ? previous.name
              : named.name,
            kind: type.kind,
            ext: type.ext,
            bytes: received.bytes,
            contentHash: 'sha256:' + received.digest,
            sourcePath: path.join(mediaDir(dataDir), committed.fileName),
            addedAt: previous !== undefined && Number.isFinite(previous.addedAt)
              ? Number(previous.addedAt)
              : Date.now(),
          }
          const written = await upsertUploaded(dataDir, entry)
          sendJson(res, 200, {
            ok: true,
            entry: publicEntry(written.entry),
            duplicate: committed.duplicate || written.duplicate,
          })
        } catch (error) {
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: describe(error) })
          else res.end()
        }
      },
    },
    {
      kind: 'exact',
      path: REMOVE_PATH,
      handler: async (req, res) => {
        try {
          const method = String(req?.method ?? 'GET').toUpperCase()
          if (method !== 'POST') {
            sendJson(res, 405, { ok: false, error: '这个地址只接受 POST。' }, { Allow: 'POST' })
            return
          }
          const dataDir = readDir()

          const body = await readSmallBody(req, REMOVE_BODY_LIMIT)
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
          const id = parsed?.id
          if (!isWellFormedId(id)) {
            sendJson(res, 400, { ok: false, error: '缺少合法的 id。' })
            return
          }

          const entry = resolveById(dataDir, id)
          if (entry === null) {
            sendJson(res, 404, { ok: false, error: '没有这条素材。' })
            return
          }

          try {
            unlinkSync(entry.sourcePath)
          } catch (error) {
            if (error?.code !== 'ENOENT') {
              sendJson(res, 500, { ok: false, error: '删除失败：' + describe(error) })
              return
            }
          }

          // The ledger follows: the entry is gone, and the revision says so.
          await updateLedger(dataDir, (entries) => {
            delete entries[id]
            return entries
          })

          sendJson(res, 200, { ok: true, removed: true })
        } catch (error) {
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: describe(error) })
          else res.end()
        }
      },
    },
    {
      kind: 'prefix',
      path: MEDIA_PATH,
      handler: (req, res) => {
        try {
          const method = String(req?.method ?? 'GET').toUpperCase()
          if (method !== 'GET' && method !== 'HEAD') {
            sendJson(res, 405, { ok: false, error: '这个地址只接受 GET 和 HEAD。' }, { Allow: 'GET, HEAD' })
            return
          }
          const dataDir = readDir()

          // The id is what remains after this route's own base. The decode is
          // guarded: a malformed percent-escape throws `URIError`, and letting
          // it out of the handler would answer a 500 for a bad request.
          let pathname
          try {
            pathname = decodeURIComponent(String(req?.url ?? '').split('?')[0])
          } catch {
            sendJson(res, 400, { ok: false, error: '无法解码这个地址。' })
            return
          }
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
            'Content-Type': entry.ext === '.mp4' ? 'video/mp4'
              : entry.ext === '.webm' ? 'video/webm'
                : entry.ext === '.ogv' ? 'video/ogg'
                  : entry.ext === '.jpg' || entry.ext === '.jpeg' ? 'image/jpeg'
                    : entry.ext === '.png' ? 'image/png'
                      : 'application/octet-stream',
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
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: describe(error) })
          else res.end()
        }
      },
    },
  ]
}
