// dsh-appearance-media — receiving an upload.
//
// THE UPLOAD IS A STREAM, NOT A BUFFER.
//
// The Host hands a route a bare node `req`/`res`
// (`dsh-host-webserver/lib/index.js:469-471`), and the one route form that
// parses a body (`{ resource }`) answers GET and HEAD only (`:599-603`). So the
// body is read from the request stream here, chunk by chunk, straight into a
// temporary file — a 96 MiB video never sits in memory, and it never sits on
// disk under its final name either.
//
// THE ORDER OF OPERATIONS:
//
//   1. the name and the type are checked BEFORE a byte is accepted, so an
//      unsupported file is refused without writing anything;
//   2. the bytes land in `<mediaDir>/.upload-<pid>-<ts>.part` while their
//      sha256 is computed;
//   3. the temporary file is RENAMED to `up-<sha12><ext>` — a rename inside
//      one directory is atomic, so a reader never sees half a file under the
//      final name;
//   4. the ledger is updated through its queue.
//
// The sha256 is not decoration: it IS the id (`up-<sha12>`), and it is the
// dedupe key. The same bytes uploaded twice are one file, and the second
// upload answers `duplicate: true`.
//
// Node built-ins only.

import { createHash } from 'node:crypto'
import { createWriteStream, mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs'
import path from 'node:path'

import { mediaDir } from './paths.js'
import { MEDIA_TYPES, idForFile, uploadId } from './catalog.js'

/** The largest upload this library accepts: 96 MiB, the same bound P06 uses. */
export const MAX_UPLOAD_BYTES = 96 * 1024 * 1024

/** The header a client may put the file name in. */
export const FILENAME_HEADER = 'x-dsh-filename'

/**
 * Remove a file, ignoring the failure.
 *
 * @param absolute - the absolute path.
 */
function removeQuietly(absolute) {
  try {
    unlinkSync(absolute)
  } catch {
    /* it is already gone */
  }
}

/**
 * Check the name a client sent.
 *
 * ★ A NAME THAT CARRIES A PATH IS REFUSED (400), NOT SANITISED. A browser's
 * `File.name` never contains a separator, so a name that does is a client
 * trying to make the server write outside the media directory. The only name
 * that ever reaches the disk is the one the SERVER builds: `up-<sha12><ext>`.
 *
 * The name arrives percent-encoded from our own browser half (a header value
 * must be latin-1, and a Chinese file name is not), so it is decoded here —
 * and the decode failure is not fatal: a name that is not encoded at all
 * (`100%.mp4`) is used as it stands.
 *
 * @param raw - the raw header or query value.
 * @returns `{ ok: true, name }` or `{ ok: false, status, error }`.
 */
export function sanitizeUploadName(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, status: 400, error: '缺少文件名：请用 X-Dsh-Filename 头或 ?name= 带上文件名。' }
  }
  let name = raw.trim()
  try {
    name = decodeURIComponent(name)
  } catch {
    // Not percent-encoded — use it as it stands.
  }
  if (name.includes('/') || name.includes('\\')) {
    return { ok: false, status: 400, error: '文件名不能包含路径分隔符。' }
  }
  if (name.includes('\0')) {
    return { ok: false, status: 400, error: '文件名不能包含空字节。' }
  }
  if (name === '.' || name === '..') {
    return { ok: false, status: 400, error: '文件名不合法。' }
  }
  if (path.basename(name) !== name) {
    return { ok: false, status: 400, error: '文件名不合法。' }
  }
  return { ok: true, name }
}

/**
 * Check the type a client sent against the type its name claims.
 *
 * ★ A MIME THAT DISAGREES WITH THE EXTENSION IS REFUSED (415). Storing the
 * bytes under whichever of the two the server believes is how a `.png` ends up
 * served as `video/mp4` — and how a browser decodes a fragment as the wrong
 * format and paints nothing.
 *
 * @param contentType - the request's `Content-Type`.
 * @param name - the file name.
 * @returns `{ ok: true, ext, kind, mime }` or `{ ok: false, status, error }`.
 */
export function classifyUpload(contentType, name) {
  const raw = typeof contentType === 'string' ? contentType.split(';')[0].trim().toLowerCase() : ''
  if (raw === '') {
    return { ok: false, status: 415, error: '缺少 Content-Type：这个地址只接受原始字节体。' }
  }
  if (raw === 'application/json' || raw === 'application/x-www-form-urlencoded' || raw === 'multipart/form-data') {
    return { ok: false, status: 415, error: '这个地址只接受原始字节体，不接受表单或 JSON。' }
  }
  const ext = path.extname(name).toLowerCase()
  const type = MEDIA_TYPES[ext]
  if (type === undefined) {
    return { ok: false, status: 415, error: '不支持的文件类型：' + (ext === '' ? '（没有扩展名）' : ext) }
  }
  if (!type.mimes.includes(raw)) {
    return {
      ok: false,
      status: 415,
      error: 'Content-Type（' + raw + '）与扩展名（' + ext + '）对不上。',
    }
  }
  return { ok: true, ext, kind: type.kind, mime: type.mime }
}

/**
 * Read a request body into a temporary file, hashing it on the way.
 *
 * @param req - the node request.
 * @param options - `dataDir` and `limit`.
 * @returns a promise for `{ ok: true, tempPath, bytes, digest }` or
 *   `{ ok: false, status, error }`.
 */
export function receiveUpload(req, { dataDir, limit = MAX_UPLOAD_BYTES }) {
  const dir = mediaDir(dataDir)
  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    return Promise.resolve({ ok: false, status: 500, error: '无法创建素材目录：' + describe(error) })
  }

  const tempPath = path.join(
    dir,
    '.upload-' + String(process.pid) + '-' + String(Date.now()) + '-' + String(Math.floor(Math.random() * 1e6)) + '.part',
  )

  return new Promise((resolve) => {
    const hash = createHash('sha256')
    let sink = null
    let received = 0
    /** Whether the body already went over the limit (the request is then drained). */
    let over = false
    /** Whether the body reached its end (an 'end' without one is an abort). */
    let bodyEnded = false
    let settled = false

    /**
     * Finish with one answer.
     *
     * ★ A REFUSED UPLOAD WAITS FOR THE SINK TO CLOSE BEFORE IT REMOVES THE
     * TEMPORARY FILE. `createWriteStream` opens its file asynchronously, so a
     * removal issued before the open completes removes nothing — and the
     * stream then creates the very file that was supposed to be gone. The
     * answer is therefore only handed back once the file is really gone.
     *
     * @param result - the result to hand back.
     */
    const finish = (result) => {
      if (settled) return
      settled = true
      if (result.ok === true) {
        resolve(result)
        return
      }
      const cleanup = () => {
        removeQuietly(tempPath)
        resolve(result)
      }
      if (sink === null) {
        cleanup()
        return
      }
      sink.once('close', cleanup)
      try {
        sink.destroy()
      } catch {
        cleanup()
      }
    }

    try {
      sink = createWriteStream(tempPath)
    } catch (error) {
      finish({ ok: false, status: 500, error: '无法写入素材目录：' + describe(error) })
      return
    }

    sink.on('error', (error) => {
      finish({ ok: false, status: 500, error: '写文件失败：' + describe(error) })
    })

    req.on('error', () => {
      finish({ ok: false, status: 400, error: '请求流中断。' })
    })
    req.on('aborted', () => {
      finish({ ok: false, status: 400, error: '上传被中断。' })
    })

    req.on('data', (chunk) => {
      if (settled) return
      // ★ Already over the limit: keep reading, keep nothing.
      if (over) return
      received += chunk.length
      if (received > limit) {
        // ★ OVER THE LIMIT: STOP WRITING, BUT KEEP READING.
        //
        // The request is NOT destroyed. `req.destroy()` closes the socket
        // BEFORE the answer is written, so the client never sees the status
        // code — it sees "Empty reply from server" (curl exits 52). The 413 is
        // the whole point of this answer, so the request is DRAINED instead:
        // the body is dropped, the stream keeps being read to its end, and the
        // 413 is written on a healthy connection.
        //
        // The sink is NOT destroyed here either: `finish()` waits for its
        // 'close' before it removes the temporary file, and destroying it
        // twice would leave the promise waiting for an event that already
        // happened.
        over = true
        try {
          // A previous write may have paused the request, and a paused
          // request never reaches 'end' — so make sure it keeps flowing.
          req.resume()
        } catch {
          /* the request is already gone */
        }
        return
      }
      hash.update(chunk)
      if (sink !== null && !sink.write(chunk)) {
        req.pause()
        sink.once('drain', () => {
          if (!settled) req.resume()
        })
      }
    })

    req.on('end', () => {
      bodyEnded = true
      if (settled) return
      if (over) {
        finish({ ok: false, status: 413, error: '文件太大（上限 ' + String(Math.round(limit / 1024 / 1024)) + ' MiB）。' })
        return
      }
      if (received === 0) {
        finish({ ok: false, status: 400, error: '空文件。' })
        return
      }
      const digest = hash.digest('hex')
      sink.end(() => {
        finish({ ok: true, tempPath, bytes: received, digest })
      })
    })

    // ★ THE STREAM ENDED WITHOUT AN 'end' — the client went away, or the
    // request was destroyed. The answer must not wait for an 'end' that will
    // never come, or the upload hangs forever.
    req.on('close', () => {
      if (settled || bodyEnded) return
      finish({ ok: false, status: 400, error: '请求流中断。' })
    })
  })
}

/**
 * The file in the media directory that carries this id, if there is one.
 *
 * @param dataDir - an absolute data directory.
 * @param id - the id.
 * @returns the file name, or null.
 */
export function findFileById(dataDir, id) {
  const dir = mediaDir(dataDir)
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  const match = names
    .filter((name) => !name.startsWith('.') && !name.endsWith('.part'))
    .find((name) => idForFile(name, 0) === id)
  return match === undefined ? null : match
}

/**
 * Move a received upload into the library under its final name.
 *
 * ★ THE FILE IS RENAMED, NOT COPIED: a rename inside one directory is atomic,
 * so the library never holds a partially written file under its final name.
 *
 * ★ THE SAME CONTENT IS ONE FILE. When a file with this id already exists, the
 * temporary file is dropped and the existing entry is returned with
 * `duplicate: true` — including when it exists under a different extension
 * (the bytes are the same; the extension is a label).
 *
 * @param options - `dataDir`, `tempPath`, `digest`, `ext`, `name`.
 * @returns a promise for `{ ok: true, fileName, id, duplicate }` or
 *   `{ ok: false, status, error }`.
 */
export function commitUpload({ dataDir, tempPath, digest, ext, name }) {
  const id = uploadId(digest)
  const existing = findFileById(dataDir, id)
  if (existing !== null) {
    removeQuietly(tempPath)
    return Promise.resolve({ ok: true, fileName: existing, id, duplicate: true })
  }
  const dir = mediaDir(dataDir)
  const target = path.join(dir, id + ext)
  try {
    mkdirSync(dir, { recursive: true })
    renameSync(tempPath, target)
  } catch (error) {
    removeQuietly(tempPath)
    return Promise.resolve({ ok: false, status: 500, error: '保存失败：' + describe(error) })
  }
  return Promise.resolve({ ok: true, fileName: id + ext, id, duplicate: false })
}

/**
 * A short description of an error.
 *
 * @param error - the error.
 * @returns a string.
 */
export function describe(error) {
  if (error === undefined || error === null) return 'unknown error'
  if (typeof error === 'string') return error
  return error.message === undefined ? String(error) : String(error.message)
}
