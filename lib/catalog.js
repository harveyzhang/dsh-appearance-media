// dsh-appearance-media — the media catalog.
//
// THREE EXPORTS, AND THEY ARE THE CONTRACT (Task 3 imports them; it must not
// write a second scan, because two scans drift, and the drift shows up as
// "the catalog lists it, the slot refuses it"):
//
//   * `listCatalog(dataDir)`   → `{ entries, skipped }`
//   * `resolveById(dataDir, id)` → one entry, or null
//   * `upsertUploaded(dataDir, entry)` → records an uploaded file in the ledger
//
// TWO RULES THAT ARE NOT OBVIOUS, AND THAT EVERYTHING ELSE HERE SERVES:
//
//   1. THE ID IS THE FILE NAME, MINUS THE EXTENSION, FOR UPLOADS.
//
//      An uploaded file is stored as `up-<sha12><ext>`, and its id is
//      `up-<sha12>`. A scan that rebuilt the id from the file name the way it
//      rebuilds a hand-placed file's id (`fs-<slug>-<mtime>`) would answer the
//      upload route with one id and the catalog with another — and the media
//      route, which resolves by id, would 404 for the id the upload route
//      just handed out.
//
//   2. THE DIRECTORY IS RE-SCANNED ON EVERY REQUEST.
//
//      There is no index, no cache of the listing, no snapshot taken at mount
//      time. A file the user drops into the media directory shows up on the
//      very next request. (This is the same lesson as Task 1's fix round 2:
//      a route that answers from a snapshot is a route that lies.)
//
// WHAT NEVER LEAVES THE HOST: `sourcePath`. The absolute path of a file on the
// user's disk is not published to the browser, and neither is the absolute path
// of a skipped file — a skipped file is reported by its base name only.

import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

import { mediaDir } from './paths.js'
import { readLedger, updateLedger } from './store.js'

/** The route prefix every media URL is built from. */
export const MEDIA_URL_PREFIX = '/appearance-media/media'

/**
 * The media types this library accepts.
 *
 * `mimes` is the list of `Content-Type` values that may accompany this
 * extension. The pairing is checked on upload: a `video/mp4` body named
 * `x.png` is a client that disagrees with itself, and it is refused (415)
 * rather than stored under whichever of the two the server believes.
 */
export const MEDIA_TYPES = {
  '.mp4': { kind: 'video', mime: 'video/mp4', mimes: ['video/mp4'] },
  '.webm': { kind: 'video', mime: 'video/webm', mimes: ['video/webm'] },
  '.ogv': { kind: 'video', mime: 'video/ogg', mimes: ['video/ogg', 'video/ogv'] },
  '.jpg': { kind: 'image', mime: 'image/jpeg', mimes: ['image/jpeg'] },
  '.jpeg': { kind: 'image', mime: 'image/jpeg', mimes: ['image/jpeg'] },
  '.png': { kind: 'image', mime: 'image/png', mimes: ['image/png'] },
}

/** The extensions whose media type is known, lower-cased with the dot. */
export const SUPPORTED_EXTENSIONS = Object.keys(MEDIA_TYPES)

/** The id of an uploaded file: the sha256 prefix, always. */
export const UPLOAD_ID_PREFIX = 'up-'

/** How many hex characters of the sha256 make up an uploaded file's id. */
export const UPLOAD_ID_DIGITS = 12

/** The pattern an uploaded file's id has. */
const UPLOAD_ID_PATTERN = new RegExp('^' + UPLOAD_ID_PREFIX + '[0-9a-f]{' + String(UPLOAD_ID_DIGITS) + '}$')

/** The pattern a hand-placed file's id has. */
const LIBRARY_ID_PATTERN = /^fs-[0-9a-z-]+-[0-9]+$/

/** Every id this library hands out is made of these characters only. */
const ID_PATTERN = /^[0-9a-z-]+$/

/**
 * The content-hash cache.
 *
 * Keyed by absolute path; the value carries the size and mtime it was
 * computed from, so a file that changed is re-hashed. This cannot hide a new
 * file (a new file has a new path) and cannot hide a changed one (a changed
 * file has a new size or mtime) — so it does not weaken rule 2 above.
 */
const hashCache = new Map()

/** How many files the hash cache keeps. */
const HASH_CACHE_LIMIT = 512

/**
 * The content hash of one file.
 *
 * @param absolute - the absolute path of the file.
 * @param info - its stat result.
 * @returns `sha256:<64 hex>`.
 */
function hashOf(absolute, info) {
  const cached = hashCache.get(absolute)
  if (cached !== undefined && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
    return cached.hash
  }
  const hash = createHash('sha256')
  // Read in chunks: a 96 MiB video must not be pulled into memory whole.
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  const fd = openSync(absolute, 'r')
  try {
    let read = readSync(fd, buffer, 0, buffer.length, null)
    while (read > 0) {
      hash.update(buffer.subarray(0, read))
      read = readSync(fd, buffer, 0, buffer.length, null)
    }
  } finally {
    closeSync(fd)
  }
  const value = 'sha256:' + hash.digest('hex')
  if (hashCache.size >= HASH_CACHE_LIMIT) {
    const oldest = hashCache.keys().next()
    if (oldest.done !== true) hashCache.delete(oldest.value)
  }
  hashCache.set(absolute, { size: info.size, mtimeMs: info.mtimeMs, hash: value })
  return value
}

/**
 * The id of an uploaded file.
 *
 * @param digest - the sha256 hex digest of the content.
 * @returns `up-<12 hex>`.
 */
export function uploadId(digest) {
  return UPLOAD_ID_PREFIX + String(digest).slice(0, UPLOAD_ID_DIGITS)
}

/**
 * The id of a hand-placed file.
 *
 * The slug is the base name without its extension, reduced to `[0-9a-z-]`;
 * the mtime is in milliseconds. Both are needed: the slug alone would collide
 * on every copy of the same file name, and the mtime alone would not be
 * readable.
 *
 * @param name - the file's base name.
 * @param mtimeMs - the file's modification time in milliseconds.
 * @returns `fs-<slug>-<mtimeMs>`.
 */
export function libraryId(name, mtimeMs) {
  const base = path.basename(name, path.extname(name))
  const slug = base
    .toLowerCase()
    .replace(/[^0-9a-z-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
  return 'fs-' + (slug === '' ? 'media' : slug) + '-' + String(Math.round(mtimeMs))
}

/**
 * The id of a file, whatever it is.
 *
 * @param name - the file's base name.
 * @param mtimeMs - the file's modification time in milliseconds.
 * @returns the id.
 */
export function idForFile(name, mtimeMs) {
  // ★ THE CAPTURE, NOT THE WHOLE MATCH: the pattern ends with the extension's
  // dot, and an id may only hold `[0-9a-z-]` — a dot in the id would make the
  // media route refuse to serve the very file the catalog lists.
  const match = /^up-([0-9a-f]{12})\./.exec(name)
  if (match !== null) return 'up-' + match[1]
  return libraryId(name, mtimeMs)
}

/**
 * The reason a file was skipped.
 *
 * @param name - the file's base name.
 * @returns a short Chinese sentence.
 */
function skippedReason(name) {
  const ext = path.extname(name).toLowerCase()
  if (ext === '.scene' || ext === '.web' || ext === '.html' || ext === '.htm') {
    return 'Scene/Web 未启用'
  }
  return '不支持的扩展名'
}

/**
 * Scan the media directory.
 *
 * @param dataDir - an absolute data directory.
 * @returns `{ entries, skipped }`.
 */
export function listCatalog(dataDir) {
  const dir = mediaDir(dataDir)
  let names
  try {
    names = readdirSync(dir, { withFileTypes: true })
  } catch {
    // A missing media directory is an EMPTY library, not an error: the answer
    // is 200 with no entries, never 500.
    return { entries: [], skipped: [] }
  }

  const ledger = readLedger(dataDir)
  const entries = []
  const skipped = []
  const taken = new Set()

  // Sorted, so the same directory always produces the same order — and so two
  // files that would claim the same id have a fixed winner.
  const files = names
    .filter((item) => item.isFile())
    .map((item) => item.name)
    .sort()

  for (const name of files) {
    // Dot files are the ledger and the write temporaries; `.part` files are
    // uploads still in flight. None of them is library content.
    if (name.startsWith('.')) continue
    if (name.endsWith('.part')) continue

    const ext = path.extname(name).toLowerCase()
    const type = MEDIA_TYPES[ext]
    if (type === undefined) {
      skipped.push({ name, reason: skippedReason(name) })
      continue
    }

    const absolute = path.join(dir, name)
    let info
    try {
      info = statSync(absolute)
    } catch {
      skipped.push({ name, reason: '文件不可读' })
      continue
    }

    const id = idForFile(name, info.mtimeMs)
    if (taken.has(id)) {
      skipped.push({ name, reason: '与另一条素材的 id 冲突' })
      continue
    }
    taken.add(id)

    const known = ledger.entries[id]
    const uploaded = known !== undefined && known !== null && known.source === 'upload'
    entries.push({
      id,
      name: typeof known?.name === 'string' && known.name !== '' ? known.name : name,
      kind: type.kind,
      ext,
      bytes: info.size,
      contentHash: typeof known?.contentHash === 'string' && known.contentHash !== ''
        ? known.contentHash
        : hashOf(absolute, info),
      source: uploaded ? 'upload' : 'library',
      // ★ Host-side only. Never published.
      sourcePath: absolute,
      license: uploaded ? 'user' : 'unknown',
      addedAt: Number.isFinite(known?.addedAt) ? Number(known.addedAt) : Math.round(info.mtimeMs),
      mediaUrl: MEDIA_URL_PREFIX + '/' + id,
    })
  }

  return { entries, skipped }
}

/**
 * The public shape of one entry: the entry without the host-side path.
 *
 * @param entry - one internal entry.
 * @returns the entry as the browser sees it.
 */
export function publicEntry(entry) {
  const { sourcePath, ...rest } = entry
  return rest
}

/**
 * Resolve one id to one entry.
 *
 * The id is looked up among the entries the directory scan produces, so the id
 * a URL carries and the id the catalog lists are the same string by
 * construction. The resolved path is then checked to be inside the media
 * directory: an id that walks out of it (a path traversal written into a URL)
 * resolves to nothing.
 *
 * @param dataDir - an absolute data directory.
 * @param id - the id.
 * @returns the entry, or null.
 */
export function resolveById(dataDir, id) {
  if (typeof id !== 'string' || id === '') return null
  if (!ID_PATTERN.test(id)) return null
  const { entries } = listCatalog(dataDir)
  const found = entries.find((entry) => entry.id === id)
  if (found === undefined) return null
  const dir = mediaDir(dataDir)
  if (found.sourcePath !== dir && !found.sourcePath.startsWith(dir + path.sep)) return null
  return found
}

/**
 * Record an uploaded file in the ledger.
 *
 * The write goes through the ledger's queue, so two uploads of the same content
 * produce ONE entry and ONE revision bump, not two.
 *
 * @param dataDir - an absolute data directory.
 * @param entry - the entry to record.
 * @returns a promise for `{ entry, duplicate, revision }`.
 */
export function upsertUploaded(dataDir, entry) {
  let existed = false
  return updateLedger(dataDir, (entries) => {
    existed = entries[entry.id] !== undefined
    entries[entry.id] = {
      name: entry.name,
      kind: entry.kind,
      ext: entry.ext,
      bytes: entry.bytes,
      contentHash: entry.contentHash,
      source: 'upload',
      sourcePath: entry.sourcePath,
      addedAt: entry.addedAt,
    }
    return entries
  }).then((ledger) => ({
    entry: {
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      ext: entry.ext,
      bytes: entry.bytes,
      contentHash: entry.contentHash,
      source: 'upload',
      sourcePath: entry.sourcePath,
      license: 'user',
      addedAt: entry.addedAt,
      mediaUrl: MEDIA_URL_PREFIX + '/' + entry.id,
    },
    duplicate: existed,
    revision: ledger.revision,
  }))
}

/**
 * Whether an id has the shape this library hands out.
 *
 * @param id - the id.
 * @returns true when the id is well formed.
 */
export function isWellFormedId(id) {
  return typeof id === 'string' && id !== '' && ID_PATTERN.test(id)
}

/**
 * Whether an id is an uploaded file's id.
 *
 * @param id - the id.
 * @returns true for `up-<12 hex>`.
 */
export function isUploadId(id) {
  return typeof id === 'string' && UPLOAD_ID_PATTERN.test(id)
}

/**
 * Whether an id is a hand-placed file's id.
 *
 * @param id - the id.
 * @returns true for `fs-<slug>-<mtime>`.
 */
export function isLibraryId(id) {
  return typeof id === 'string' && LIBRARY_ID_PATTERN.test(id)
}
