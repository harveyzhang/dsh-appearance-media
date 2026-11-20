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
import { closeSync, openSync, readSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'

import { mediaDir } from './paths.js'
import { readLedger, updateLedger, readConfig, writeConfig, SLOT_NAMES } from './store.js'

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
  // ★ WEBP: smaller than jpeg for the same picture, and every browser that can
  //   run this app can decode it. It is what the wallpaper sources ship, so
  //   without it their materials are silently ignored by the directory scan.
  '.webp': { kind: 'image', mime: 'image/webp', mimes: ['image/webp'] },
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

/* ══════════════════════════════════════════════════════════════════════════
   DELETING A MATERIAL
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Turn a filesystem failure into a sentence a person can act on.
 *
 * The messages are Chinese because they are shown to the user as they are —
 * the client prints the host's sentence verbatim.
 *
 * @param error - the failure.
 * @returns a short sentence.
 */
function describeFsError(error) {
  const code = typeof error?.code === 'string' ? error.code : ''
  if (code === 'EACCES' || code === 'EPERM') return '没有权限改这个目录。'
  if (code === 'EISDIR') return '这个路径是一个目录。'
  if (code === 'EBUSY') return '这个文件正被别的程序占着。'
  if (code === 'ENOENT') return '这个文件已经不在了。'
  return String(error && error.message ? error.message : error)
}

/**
 * Put a staged file back where it was.
 *
 * @param staged - the staged path.
 * @param original - where the file came from.
 * @returns whether the file is back.
 */
function restoreStagedFile(staged, original) {
  try {
    renameSync(staged, original)
    return true
  } catch (error) {
    console.warn('[dsh-appearance-media] 没能把素材放回原处：' + describeFsError(error))
    return false
  }
}

/**
 * Put the configuration back the way it was.
 *
 * Every step is independent: one that fails is reported and the next one is
 * still tried, because a rollback that stops at the first failure leaves more
 * behind than it repairs.
 *
 * @param dataDir - an absolute data directory.
 * @param restore - the steps to undo, in reverse order.
 */
async function rollbackConfig(dataDir, restore) {
  for (const step of restore.slice().reverse()) {
    try {
      if (step.kind === 'slot') {
        await writeConfig(dataDir, { slot: step.name, mediaId: step.mediaId })
      } else if (step.kind === 'pool') {
        await writeConfig(dataDir, { options: { boot: { pool: step.value } } })
      }
    } catch (error) {
      console.warn('[dsh-appearance-media] 回滚失败：' + describeFsError(error))
    }
  }
}

/**
 * Delete one material from the library.
 *
 * ★ THE ORDER IS THE CONTRACT, AND IT IS NOT "UNLINK, THEN UPDATE".
 *
 *   1. the id is checked BEFORE anything is looked up — a `..`, a path
 *      separator or an absolute path is a refusal, never a lookup;
 *   2. the FILE is taken out of the library FIRST, by RENAMING it aside
 *      inside the media directory. A rename is atomic and REVERSIBLE, so
 *      every step after it can be undone;
 *   3. the slots that point at the material are cleared, and the material is
 *      taken out of the boot pool;
 *   4. the ledger entry goes;
 *   5. and only then are the bytes actually unlinked.
 *
 * ★ WHY THE BYTES GO LAST. Unlinking is the one step that cannot be undone —
 * the bytes are gone. If the ledger write failed after an unlink, the
 * library and the ledger would disagree, and one of them would be lying. A
 * rename keeps every step before the last one reversible.
 *
 * ★ AND A FAILURE ROLLS EVERYTHING BACK. A read-only media directory fails at
 * step 2, before the ledger or the configuration were touched at all: the
 * file is still there, the ledger still lists it, the slot still points at
 * it. Nothing is half-deleted.
 *
 * ★ A SLOT THAT POINTS AT THE MATERIAL IS CLEARED, NOT REFUSED. The material
 * is the user's to delete, and a surface that has nothing to play is a
 * surface that says 「未选择」 — which is true, and better than a slot that
 * points at a file that no longer exists. The cleared slots are named in the
 * answer so the client can say which ones moved.
 *
 * @param dataDir - an absolute data directory.
 * @param id - the material's id.
 * @returns a promise for
 *   `{ ok, status, error?, id?, removed?, clearedSlots?, poolUpdated? }`.
 */
export async function deleteMaterial(dataDir, id) {
  // ── 1. THE ID, BEFORE ANY LOOKUP. ──
  if (typeof id !== 'string' || id.trim() === '') {
    return { ok: false, status: 400, error: '缺少 mediaId。' }
  }
  if (id.includes('..') || id.includes('/') || id.includes('\\') || path.isAbsolute(id)) {
    return { ok: false, status: 400, error: 'mediaId 只能是素材库里的编号，不能带路径。' }
  }
  if (!isWellFormedId(id)) {
    return { ok: false, status: 400, error: 'mediaId 只能是素材库里的编号。' }
  }

  const dir = mediaDir(dataDir)

  // ── 2. THE MATERIAL. ──
  const entry = resolveById(dataDir, id)
  const known = readLedger(dataDir).entries[id]
  const inLedger = known !== undefined && known !== null

  // ★ THE ID IS NOT IN THE LIBRARY AT ALL. Not on the disk and not in the
  // ledger: there is nothing to delete, and the answer says so.
  if (entry === null && !inLedger) {
    return { ok: false, status: 404, error: '素材库里没有这条素材。' }
  }
  // ★ AND THE FILE MUST BE INSIDE THE MEDIA DIRECTORY. `resolveById` checks
  // that already; this checks it again, because this is the one place where
  // a wrong answer would delete a file outside the library.
  if (entry !== null && !entry.sourcePath.startsWith(dir + path.sep)) {
    return { ok: false, status: 400, error: '这条素材不在素材库里。' }
  }

  // ── 3. WHAT POINTS AT IT. ──
  const config = readConfig(dataDir)
  const slots = config?.config?.slots ?? {}
  const referencing = []
  for (const name of SLOT_NAMES) {
    const slot = slots[name]
    if (slot !== undefined && slot !== null && slot.mediaId === id) referencing.push(name)
  }
  const pool = config?.config?.options?.boot?.pool
  const inPool = Array.isArray(pool) && pool.indexOf(id) !== -1

  // ── 4. THE FILE GOES ASIDE FIRST. ──
  //
  // The staged name starts with a dot, so the directory scan skips it: from
  // this moment on the material is out of the library, and it is still whole
  // on the disk.
  let staged = null
  if (entry !== null) {
    staged = path.join(
      dir,
      '.delete-' + String(process.pid) + '-' + String(Date.now()) + '-' + path.basename(entry.sourcePath),
    )
    try {
      renameSync(entry.sourcePath, staged)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        // The file went away between the scan and now. There is nothing to
        // stage, and the ledger still has to be cleaned.
        staged = null
      } else {
        // ★ NOTHING WAS TOUCHED. The ledger, the configuration and the file
        // are exactly as they were.
        return { ok: false, status: 500, error: '删除失败，素材没有动：' + describeFsError(error) }
      }
    }
  }

  // ── 5. THE SLOTS THAT POINTED AT IT, AND THE POOL THAT HELD IT. ──
  const restore = []
  try {
    for (const name of referencing) {
      await writeConfig(dataDir, { slot: name, mediaId: null })
      restore.push({ kind: 'slot', name: name, mediaId: id })
    }
    if (inPool) {
      await writeConfig(dataDir, { options: { boot: { pool: pool.filter((other) => other !== id) } } })
      restore.push({ kind: 'pool', value: pool.slice() })
    }
  } catch (error) {
    if (staged !== null) restoreStagedFile(staged, entry.sourcePath)
    await rollbackConfig(dataDir, restore)
    return { ok: false, status: 500, error: '删除失败，素材没有动：' + describeFsError(error) }
  }

  // ── 6. THE LEDGER. ──
  //
  // The entry goes with the file. A ledger that still lists a material the
  // directory does not hold is the "the library has no such file but the
  // ledger says so" thing the scan would trip over on the next request.
  try {
    await updateLedger(dataDir, (entries) => {
      delete entries[id]
      return entries
    })
  } catch (error) {
    if (staged !== null) restoreStagedFile(staged, entry.sourcePath)
    await rollbackConfig(dataDir, restore)
    return { ok: false, status: 500, error: '删除失败，素材没有动：' + describeFsError(error) }
  }

  // ── 7. THE BYTES, AT LAST. ──
  if (staged !== null) {
    try {
      unlinkSync(staged)
    } catch (error) {
      // The material is gone from the library — the catalog, the ledger and
      // the slots all agree — but the bytes are still on the disk under a
      // name the scan skips. That is worth a line in the log and not worth a
      // failed delete: the user asked for the material to be gone, and it is.
      console.warn('[dsh-appearance-media] 删掉的素材没能从磁盘上清掉：' + describeFsError(error))
    }
  }

  return {
    ok: true,
    status: 200,
    id: id,
    removed: true,
    // The slots that pointed at the material and are now empty.
    clearedSlots: referencing,
    // Whether the boot pool held the material and no longer does.
    poolUpdated: inPool,
  }
}
