// dsh-appearance-media — the upload and remove routes.
//
//   POST /appearance-media/upload      raw bytes in, one library entry out
//   POST /appearance-media/remove      JSON `{ id }` in, the entry gone
//
// ★ THE MEDIA ROUTE LIVES IN `lib/routes/media.js`, AND IT IS NOT HERE ANY
//   MORE.
//
//   It used to be: `GET /appearance-media/media/<id>` — the bytes of one
//   entry — sat in this file. It moved because the Host's prefix table holds
//   ONE route per path (`register()` throws on a duplicate `(kind, path)`,
//   `dsh-host-webserver/lib/index.js:376`), so the bytes and the delete
//   could not be two routes: they are one handler that answers `GET`, `HEAD`
//   and `DELETE`. The bytes answer exactly what they answered before.
//
// ★ AND THE REMOVE ROUTE IS NOT THE DELETE ROUTE.
//
//   `POST /appearance-media/remove` takes a JSON body and is older; the
//   canonical delete is `DELETE /appearance-media/media/<id>`, and it is the
//   one the browser half uses. The difference is not cosmetic: the delete
//   clears the slots that pointed at the material and unlinks the bytes only
//   after the ledger is written, and the remove route does neither.

import { statSync, unlinkSync } from 'node:fs'
import path from 'node:path'

import { mediaDir } from '../paths.js'
import { isWellFormedId, publicEntry, resolveById, upsertUploaded } from '../catalog.js'
import { updateLedger, readLedger } from '../store.js'
import { classifyUpload, commitUpload, describe, receiveUpload, sanitizeUploadName } from '../upload.js'

/** The upload route. */
export const UPLOAD_PATH = '/appearance-media/upload'

/** The remove route. */
export const REMOVE_PATH = '/appearance-media/remove'

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
 * Build the two route descriptors.
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
        // ★ RETIRED. This route used to unlink the file FIRST and rewrite the
        //   ledger afterwards, with no guard on the id and no thought for the
        //   slots that pointed at it: a crash between the two left the library
        //   saying a file was gone while it was still there, and deleting a
        //   material that a surface was using left that surface pointing at
        //   nothing. `DELETE /appearance-media/media/<id>` does the same job
        //   with the steps in the safe order (stage the file aside, clear the
        //   slots, rewrite the ledger, unlink last, roll back on any failure).
        //   This address answers 410 and points there.
        sendJson(res, 410, {
          ok: false,
          error: '这个地址已经不用了，请改用 DELETE /appearance-media/media/<素材 id>。',
          replacement: 'DELETE /appearance-media/media/<id>',
        })
      }
    },
  ]
}
